import {
  DescribeServicesCommand,
  DescribeTaskDefinitionCommand,
  DescribeTasksCommand,
  ECSClient,
  ListTasksCommand,
  RunTaskCommand,
} from "@aws-sdk/client-ecs";
import { DescribeNetworkInterfacesCommand, EC2Client } from "@aws-sdk/client-ec2";
import net from "node:net";
import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { ensureSchema, pool } from "@/lib/db";
import { enqueueDeploymentJob, markDeploymentFailed, newDeploymentId } from "@/workers/deployWorker";

const payloadSchema = z
  .object({
    openaiApiKey: z.string().trim().min(1).max(300).optional(),
    anthropicApiKey: z.string().trim().min(1).max(300).optional(),
    openrouterApiKey: z.string().trim().min(1).max(300).optional(),
    telegramBotToken: z.string().trim().min(1).max(300).optional(),
    redeploy: z.boolean().optional(),
  })
  .refine(
    (value) =>
      Boolean(
        value.openaiApiKey ||
          value.anthropicApiKey ||
          value.openrouterApiKey ||
          value.telegramBotToken ||
          value.redeploy,
      ),
    { message: "At least one setting is required" },
  );

type QueueModeInfo = {
  usable: boolean;
  endpoint: string;
  reason: "ok" | "missing_sqs_queue_url" | "missing_aws_region";
};

function readTrimmedEnv(name: string) {
  const raw = process.env[name];
  if (!raw) return "";
  return raw.trim().replace(/^"(.*)"$/, "$1").replace(/\\n/g, "").trim();
}

function parseEcsRuntimeId(runtimeId: string | null) {
  if (!runtimeId || !runtimeId.startsWith("ecs:")) return null;
  const body = runtimeId.slice(4);
  const [cluster, serviceName] = body.split("|");
  if (!cluster || !serviceName) return null;
  return { cluster, serviceName };
}

async function probeTcpPort(host: string, port: number) {
  await new Promise<void>((resolve, reject) => {
    const socket = net.createConnection({ host, port, timeout: 2000 }, () => {
      socket.end();
      resolve();
    });
    socket.on("timeout", () => {
      socket.destroy();
      reject(new Error("timeout"));
    });
    socket.on("error", (error) => {
      socket.destroy();
      reject(error);
    });
  });
}

async function resolveEcsPublicUrl(runtimeId: string) {
  const parsed = parseEcsRuntimeId(runtimeId);
  if (!parsed) return null;
  const region = readTrimmedEnv("AWS_REGION");
  if (!region) return null;

  const credentials =
    readTrimmedEnv("AWS_ACCESS_KEY_ID") && readTrimmedEnv("AWS_SECRET_ACCESS_KEY")
      ? {
          accessKeyId: readTrimmedEnv("AWS_ACCESS_KEY_ID"),
          secretAccessKey: readTrimmedEnv("AWS_SECRET_ACCESS_KEY"),
        }
      : undefined;

  const ecs = new ECSClient({ region, credentials });
  const ec2 = new EC2Client({ region, credentials });

  const tasks = await ecs.send(
    new ListTasksCommand({
      cluster: parsed.cluster,
      serviceName: parsed.serviceName,
      desiredStatus: "RUNNING",
      maxResults: 5,
    }),
  );
  if (!tasks.taskArns?.length) return null;

  const described = await ecs.send(
    new DescribeTasksCommand({
      cluster: parsed.cluster,
      tasks: tasks.taskArns,
    }),
  );

  const networkInterfaceIds = (described.tasks ?? [])
    .flatMap((task) => task.attachments ?? [])
    .filter((attachment) => attachment.type === "ElasticNetworkInterface")
    .flatMap((attachment) => attachment.details ?? [])
    .filter((detail) => detail.name === "networkInterfaceId" && Boolean(detail.value))
    .map((detail) => detail.value as string);
  if (networkInterfaceIds.length === 0) return null;

  const interfaces = await ec2.send(
    new DescribeNetworkInterfacesCommand({
      NetworkInterfaceIds: Array.from(new Set(networkInterfaceIds)),
    }),
  );

  const port = Number(readTrimmedEnv("OPENCLAW_CONTAINER_PORT") || "18789");
  const publicIps = Array.from(
    new Set(
      (interfaces.NetworkInterfaces ?? [])
        .map((eni) => eni.Association?.PublicIp?.trim())
        .filter((ip): ip is string => Boolean(ip)),
    ),
  );
  for (const publicIp of publicIps) {
    try {
      await probeTcpPort(publicIp, port);
      return `http://${publicIp}:${port}`;
    } catch {
      // Try another running task IP while ECS is rolling.
    }
  }
  return null;
}

function mergeResolvedRuntimeUrl(resolvedBaseUrl: string, storedReadyUrl: string | null) {
  try {
    const resolved = new URL(resolvedBaseUrl);
    if (!storedReadyUrl?.trim()) {
      return resolved.toString();
    }
    const stored = new URL(storedReadyUrl);
    resolved.pathname = stored.pathname || "/";
    resolved.search = stored.search;
    resolved.hash = stored.hash;
    return resolved.toString();
  } catch {
    return resolvedBaseUrl;
  }
}

async function resolveRuntimeGatewayUrl(input: {
  deploymentId: string;
  deployProvider: string | null;
  runtimeId: string | null;
  readyUrl: string | null;
}) {
  const raw = input.readyUrl?.trim();
  const directReadyUrl = (() => {
    if (!raw) return null;
    try {
      const url = new URL(raw);
      if (url.pathname === `/runtime/${input.deploymentId}`) {
        return null;
      }
      return url.toString();
    } catch {
      return null;
    }
  })();
  if (directReadyUrl) {
    return directReadyUrl;
  }

  const provider = (input.deployProvider ?? "").trim();
  if (provider === "ecs" && input.runtimeId) {
    const resolved = await resolveEcsPublicUrl(input.runtimeId);
    if (!resolved) return null;
    return mergeResolvedRuntimeUrl(resolved, input.readyUrl);
  }
  return null;
}

function toWsUrl(httpUrl: string) {
  const url = new URL(httpUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url;
}

type RpcResponseMessage = {
  type?: string;
  id?: string | number;
  ok?: boolean;
  payload?: unknown;
  error?: { code?: string; message?: string } | string | null;
};

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

async function tryHotApplyTelegramTokenViaEcsConfigTask(input: {
  runtimeId: string | null;
  telegramBotToken: string;
}) {
  const parsed = parseEcsRuntimeId(input.runtimeId);
  if (!parsed) {
    return { attempted: false as const, applied: false as const, reason: "invalid_ecs_runtime_id" };
  }

  const region = readTrimmedEnv("AWS_REGION");
  if (!region) {
    return { attempted: true as const, applied: false as const, reason: "missing_aws_region" };
  }

  const credentials =
    readTrimmedEnv("AWS_ACCESS_KEY_ID") && readTrimmedEnv("AWS_SECRET_ACCESS_KEY")
      ? {
          accessKeyId: readTrimmedEnv("AWS_ACCESS_KEY_ID"),
          secretAccessKey: readTrimmedEnv("AWS_SECRET_ACCESS_KEY"),
        }
      : undefined;

  const ecs = new ECSClient({ region, credentials });
  const containerName = readTrimmedEnv("ECS_CONTAINER_NAME") || "openclaw";

  const serviceResponse = await ecs.send(
    new DescribeServicesCommand({
      cluster: parsed.cluster,
      services: [parsed.serviceName],
    }),
  );
  const service = serviceResponse.services?.[0];
  if (!service?.taskDefinition) {
    return { attempted: true as const, applied: false as const, reason: "ecs_service_not_found" };
  }

  const awsvpc = service.networkConfiguration?.awsvpcConfiguration;
  if (!awsvpc?.subnets?.length) {
    return { attempted: true as const, applied: false as const, reason: "ecs_network_config_missing" };
  }

  const taskDef = await ecs.send(
    new DescribeTaskDefinitionCommand({
      taskDefinition: service.taskDefinition,
    }),
  );

  const mainContainerExists = (taskDef.taskDefinition?.containerDefinitions ?? []).some(
    (definition) => definition.name === containerName,
  );
  if (!mainContainerExists) {
    return {
      attempted: true as const,
      applied: false as const,
      reason: `ecs_container_not_found:${containerName}`,
    };
  }

  const runConfigSet = async (path: string, value: string) => {
    const run = await ecs.send(
      new RunTaskCommand({
        cluster: parsed.cluster,
        taskDefinition: service.taskDefinition,
        launchType: (service.launchType ?? "FARGATE") as "FARGATE" | "EC2" | "EXTERNAL",
        platformVersion: service.platformVersion || undefined,
        count: 1,
        networkConfiguration: {
          awsvpcConfiguration: {
            subnets: awsvpc.subnets,
            securityGroups: awsvpc.securityGroups,
            assignPublicIp: awsvpc.assignPublicIp,
          },
        },
        overrides: {
          containerOverrides: [
            {
              name: containerName,
              command: ["config", "set", path, value],
            },
          ],
        },
      }),
    );

    const taskArn = run.tasks?.[0]?.taskArn;
    if (!taskArn) {
      const failure = run.failures?.[0];
      throw new Error(failure?.reason || "ECS helper task did not start");
    }

    const startedAt = Date.now();
    while (Date.now() - startedAt < 45_000) {
      const described = await ecs.send(
        new DescribeTasksCommand({
          cluster: parsed.cluster,
          tasks: [taskArn],
        }),
      );
      const task = described.tasks?.[0];
      if (!task) {
        throw new Error("ECS helper task disappeared");
      }

      if (task.lastStatus === "STOPPED") {
        const mainContainer = task.containers?.find((container) => container.name === containerName);
        const exitCode = mainContainer?.exitCode;
        if (exitCode === 0) {
          return;
        }
        const reason =
          mainContainer?.reason ||
          task.stoppedReason ||
          `ECS helper task failed (exit ${exitCode ?? "unknown"})`;
        throw new Error(reason);
      }

      await sleep(1000);
    }

    throw new Error("ECS helper task timed out");
  };

  try {
    await runConfigSet("channels.telegram.enabled", "true");
    await runConfigSet("channels.telegram.botToken", input.telegramBotToken);
    return { attempted: true as const, applied: true as const };
  } catch (error) {
    const message = error instanceof Error ? error.message : "ECS config helper failed";
    return { attempted: true as const, applied: false as const, reason: `ecs-helper: ${message}` };
  }
}

async function tryHotApplyTelegramToken(input: {
  deploymentId: string;
  deployProvider: string | null;
  runtimeId: string | null;
  readyUrl: string | null;
  telegramBotToken: string;
}) {
  const gatewayUrl = await resolveRuntimeGatewayUrl({
    deploymentId: input.deploymentId,
    deployProvider: input.deployProvider,
    runtimeId: input.runtimeId,
    readyUrl: input.readyUrl,
  });
  if (!gatewayUrl) {
    const ecsFallback =
      (input.deployProvider ?? "").trim() === "ecs"
        ? await tryHotApplyTelegramTokenViaEcsConfigTask({
            runtimeId: input.runtimeId,
            telegramBotToken: input.telegramBotToken,
          })
        : null;
    if (ecsFallback?.applied) {
      return ecsFallback;
    }
    return { attempted: true, applied: false as const, reason: ecsFallback?.reason ?? "runtime_unreachable" };
  }

  const token = new URL(gatewayUrl).searchParams.get("token");
  if (!token) {
    const ecsFallback =
      (input.deployProvider ?? "").trim() === "ecs"
        ? await tryHotApplyTelegramTokenViaEcsConfigTask({
            runtimeId: input.runtimeId,
            telegramBotToken: input.telegramBotToken,
          })
        : null;
    if (ecsFallback?.applied) {
      return ecsFallback;
    }
    return { attempted: true, applied: false as const, reason: ecsFallback?.reason ?? "missing_gateway_token" };
  }

  if (typeof WebSocket === "undefined") {
    const ecsFallback =
      (input.deployProvider ?? "").trim() === "ecs"
        ? await tryHotApplyTelegramTokenViaEcsConfigTask({
            runtimeId: input.runtimeId,
            telegramBotToken: input.telegramBotToken,
          })
        : null;
    if (ecsFallback?.applied) {
      return ecsFallback;
    }
    return { attempted: true, applied: false as const, reason: ecsFallback?.reason ?? "websocket_unavailable" };
  }

  const profiles = [
    { clientId: "control-ui", mode: "control-ui", userAgent: "openclaw-control-ui/1.0.0" },
    { clientId: "web", mode: "web", userAgent: "openclaw-web/1.0.0" },
    { clientId: "dashboard", mode: "dashboard", userAgent: "openclaw-dashboard/1.0.0" },
    { clientId: "cli", mode: "cli", userAgent: "openclaw-cli/1.0.0" },
  ];
  const authVariants: Array<{ token?: string; password?: string; label: string }> = [
    { token, label: "token" },
    { password: token, label: "password" },
    { token, password: token, label: "token+password" },
  ];

  let lastReason = "Live apply failed";

  for (const profile of profiles) {
    for (const authVariant of authVariants) {
    const ws = new WebSocket(toWsUrl(gatewayUrl));
    const pending = new Map<
      string,
      {
        resolve: (value: RpcResponseMessage) => void;
        reject: (reason?: unknown) => void;
      }
    >();
    let seq = 0;

    const cleanup = () => {
      for (const item of pending.values()) {
        item.reject(new Error("WebSocket closed"));
      }
      pending.clear();
    };

    ws.addEventListener("message", (event) => {
      try {
        const message = JSON.parse(String(event.data)) as RpcResponseMessage;
        const id = message.id;
        if (id === undefined || id === null) return;
        const key = String(id);
        const waiter = pending.get(key);
        if (!waiter) return;
        pending.delete(key);
        waiter.resolve(message);
      } catch {
        // Ignore non-JSON frames.
      }
    });

    const openPromise = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("WebSocket connect timeout")), 5000);
      ws.addEventListener("open", () => {
        clearTimeout(timeout);
        resolve();
      }, { once: true });
      ws.addEventListener("error", () => {
        clearTimeout(timeout);
        reject(new Error("WebSocket connection failed"));
      }, { once: true });
    });

    ws.addEventListener("close", () => {
      cleanup();
    });

    const rpc = async (method: string, params: unknown) => {
      const id = `oneclick-${++seq}`;
      const responsePromise = new Promise<RpcResponseMessage>((resolve, reject) => {
        const timeout = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`RPC timeout: ${method}`));
        }, 7000);
        pending.set(id, {
          resolve: (value) => {
            clearTimeout(timeout);
            resolve(value);
          },
          reject: (reason) => {
            clearTimeout(timeout);
            reject(reason);
          },
        });
      });

      ws.send(JSON.stringify({ type: "req", id, method, params }));
      const response = await responsePromise;
      const ok = response.ok !== false;
      if (!ok) {
        const errorMessage =
          typeof response.error === "string"
            ? response.error
            : response.error?.message || `RPC failed: ${method}`;
        throw new Error(errorMessage);
      }
      return response.payload;
    };

    const { label: authLabel, ...authPayload } = authVariant;

    try {
      await openPromise;
      await rpc("connect", {
        minProtocol: 3,
        maxProtocol: 3,
        client: {
          id: profile.clientId,
          version: "1.0.0",
          platform: "linux",
          mode: profile.mode,
        },
        role: "operator",
        scopes: ["operator.admin", "operator.write", "operator.read"],
        caps: [],
        commands: [],
        permissions: {},
        auth: authPayload,
        locale: "en-US",
        userAgent: profile.userAgent,
      });

      const currentConfig = (await rpc("config.get", {})) as { hash?: string } | null;
      const baseHash = currentConfig?.hash;
      if (!baseHash) {
        lastReason = "config_hash_missing";
        continue;
      }

      await rpc("config.patch", {
        baseHash,
        idempotencyKey: `oneclick-telegram-${Date.now()}`,
        raw: JSON.stringify({
          channels: {
            telegram: {
              enabled: true,
              botToken: input.telegramBotToken,
            },
          },
        }),
      });

      return { attempted: true, applied: true as const };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Live apply failed";
      lastReason = `${profile.clientId}/${profile.mode}/${authLabel}: ${message}`;
    } finally {
      try {
        ws.close();
      } catch {
        // no-op
      }
    }
    }
  }

  if ((input.deployProvider ?? "").trim() === "ecs") {
    const looksLikeScopeBlock = lastReason.includes("missing scope:");
    const looksLikeAuthRoleBlock = lastReason.includes("operator.read");
    if (looksLikeScopeBlock || looksLikeAuthRoleBlock) {
      const ecsFallback = await tryHotApplyTelegramTokenViaEcsConfigTask({
        runtimeId: input.runtimeId,
        telegramBotToken: input.telegramBotToken,
      });
      if (ecsFallback.applied) {
        return ecsFallback;
      }
      return {
        attempted: true,
        applied: false as const,
        reason: `${lastReason}; ${ecsFallback.reason ?? "ecs helper failed"}`,
      };
    }
  }

  return { attempted: true, applied: false as const, reason: lastReason };
}

function getQueueModeInfo(): QueueModeInfo {
  const region = readTrimmedEnv("AWS_REGION");
  const queueUrl = readTrimmedEnv("SQS_DEPLOYMENT_QUEUE_URL");
  if (!region) return { usable: false, endpoint: "", reason: "missing_aws_region" };
  if (!queueUrl) return { usable: false, endpoint: "", reason: "missing_sqs_queue_url" };
  return { usable: true, endpoint: queueUrl, reason: "ok" };
}

function summarizeQueueEndpoint(raw: string) {
  if (!raw) return "none";
  try {
    const url = new URL(raw);
    return `${url.protocol}//${url.hostname}${url.port ? `:${url.port}` : ""}`;
  } catch {
    return raw.slice(0, 40);
  }
}

function queueUnavailableMessage(queueInfo: QueueModeInfo) {
  if (queueInfo.reason === "missing_aws_region") {
    return "Deployment queue unavailable: AWS_REGION is not configured for SQS queueing.";
  }
  if (queueInfo.reason === "missing_sqs_queue_url") {
    return "Deployment queue unavailable: SQS_DEPLOYMENT_QUEUE_URL is not configured.";
  }
  return "Deployment queue unavailable. Please try again shortly.";
}

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  if (!session?.user?.email) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }
  await request.text().catch(() => "");
  await context.params;
  return NextResponse.json(
    {
      ok: false,
      error:
        "Runtime key editing is disabled. Model API keys and Telegram bot token must be set during setup. Start a new deployment to use different keys.",
    },
    { status: 410 },
  );
}
