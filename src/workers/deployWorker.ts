import "dotenv/config";
import { Queue, Worker } from "bullmq";
import { randomUUID } from "crypto";
import net from "node:net";
import { Client } from "ssh2";
import { SendMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
import { DescribeNetworkInterfacesCommand, EC2Client } from "@aws-sdk/client-ec2";
import {
  DescribeServicesCommand,
  DescribeTasksCommand,
  ECSClient,
  ListTasksCommand,
  type ECSClientConfig,
} from "@aws-sdk/client-ecs";
import { ensureSchema, pool } from "@/lib/db";
import { isOttoAuthEcsFlavor, normalizeDeploymentFlavor, type DeploymentFlavor } from "@/lib/plans";
import { createDedicatedSshHost, destroyDedicatedVm } from "@/lib/provisioner/dedicatedVm";
import type { Host } from "@/lib/provisioner/hostScheduler";
import { getRuntimePort } from "@/lib/provisioner/openclawBundle";
import { destroyUserRuntime, launchUserContainer } from "@/lib/provisioner/runtimeProvider";
import { probeRuntimeHttp } from "@/lib/runtimeHealth";
import { buildVideoMemoryUrl } from "@/lib/runtime/videoMemoryUrl";

type DeploymentJob = {
  deploymentId: string;
  userId: string;
};

const queueName = "deployment-jobs";

type DeploymentStrategy = {
  provider: "mock" | "ssh" | "ecs";
  strategy: "legacy_default" | "ecs_ottoauth" | "ecs_ottoauth_canary" | "ecs_microservices";
  ecsServicePrefixOverride: string | null;
};

function getQueueConnection() {
  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) {
    throw new Error("REDIS_URL is required for queue operations.");
  }
  return { url: redisUrl };
}

function useAdvisoryLocks() {
  const value = (process.env.DEPLOY_USE_ADVISORY_LOCKS ?? "true").trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes" || value === "on";
}

export async function enqueueDeploymentJob(job: DeploymentJob) {
  const sqsQueueUrl = readTrimmedEnv("SQS_DEPLOYMENT_QUEUE_URL");
  const awsRegion = readTrimmedEnv("AWS_REGION");
  if (sqsQueueUrl && awsRegion) {
    const sqs = new SQSClient(buildAwsConfigWithTrimmedCreds(awsRegion));
    const isFifo = sqsQueueUrl.toLowerCase().endsWith(".fifo");
    await sqs.send(
      new SendMessageCommand({
        QueueUrl: sqsQueueUrl,
        MessageBody: JSON.stringify(job),
        ...(isFifo ? { MessageGroupId: "deployments", MessageDeduplicationId: job.deploymentId } : {}),
      }),
    );
    return;
  }
  const queue = new Queue<DeploymentJob>(queueName, { connection: getQueueConnection() });
  await queue.add("deploy", job, {
    jobId: job.deploymentId,
    removeOnComplete: true,
    removeOnFail: 200,
  });
}

async function appendEvent(deploymentId: string, status: string, message: string) {
  await pool.query(
    `INSERT INTO deployment_events (deployment_id, status, message) VALUES ($1, $2, $3)`,
    [deploymentId, status, message],
  );
}

function parseSshRuntimeId(runtimeId: string) {
  if (!runtimeId.startsWith("ssh:")) return null;
  const body = runtimeId.slice(4);
  const split = body.split("|");
  if (split.length < 2) return null;
  return { sshTarget: split[0], containerName: split[1], vmId: split[2]?.trim() || null };
}

function parseEcsRuntimeId(runtimeId: string) {
  if (!runtimeId.startsWith("ecs:")) return null;
  const body = runtimeId.slice(4);
  const split = body.split("|");
  if (split.length !== 2) return null;
  return { cluster: split[0], serviceName: split[1] };
}

function readTrimmedEnv(name: string) {
  const raw = process.env[name];
  if (!raw) return "";
  return raw.trim().replace(/^"(.*)"$/, "$1").replace(/\\n/g, "").trim();
}

function resolveDeploymentStrategy(
  defaultProvider: "mock" | "ssh" | "ecs",
  deploymentFlavor: DeploymentFlavor,
): DeploymentStrategy {
  if (deploymentFlavor === "simple_agent_microservices_ecs") {
    return {
      provider: "ecs",
      strategy: "ecs_microservices",
      ecsServicePrefixOverride: null,
    };
  }
  if (isOttoAuthEcsFlavor(deploymentFlavor)) {
    if (deploymentFlavor === "simple_agent_ottoauth_ecs_canary") {
      const defaultServicePrefix = readTrimmedEnv("ECS_SERVICE_PREFIX") || "oneclick-agent";
      const canaryServicePrefix = readTrimmedEnv("ECS_CANARY_SERVICE_PREFIX") || `${defaultServicePrefix}-canary`;
      return {
        provider: "ecs",
        strategy: "ecs_ottoauth_canary",
        ecsServicePrefixOverride: canaryServicePrefix,
      };
    }
    return {
      provider: "ecs",
      strategy: "ecs_ottoauth",
      ecsServicePrefixOverride: null,
    };
  }
  return {
    provider: defaultProvider,
    strategy: "legacy_default",
    ecsServicePrefixOverride: null,
  };
}

function resolveDefaultProvider(): "mock" | "ssh" | "ecs" {
  const configured = readTrimmedEnv("DEPLOY_PROVIDER").toLowerCase();
  if (configured === "mock" || configured === "ssh" || configured === "ecs") {
    return configured;
  }
  // Production-safe fallback: prefer ECS when DEPLOY_PROVIDER is missing/invalid.
  return "ecs";
}

function buildAwsConfigWithTrimmedCreds(region: string): ECSClientConfig {
  const accessKeyId = readTrimmedEnv("AWS_ACCESS_KEY_ID");
  const secretAccessKey = readTrimmedEnv("AWS_SECRET_ACCESS_KEY");
  const sessionToken = readTrimmedEnv("AWS_SESSION_TOKEN");
  if (!accessKeyId || !secretAccessKey) {
    return { region };
  }
  return {
    region,
    credentials: {
      accessKeyId,
      secretAccessKey,
      sessionToken: sessionToken || undefined,
    },
  };
}

function parseUserAndHost(sshTarget: string) {
  const [user, host] = sshTarget.includes("@") ? sshTarget.split("@") : ["root", sshTarget];
  return { user, host };
}

async function probeTcpPort(host: string, port: number) {
  await new Promise<void>((resolve, reject) => {
    const socket = net.createConnection({ host, port, timeout: 3000 }, () => {
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

async function probeSshLocalPort(sshTarget: string, port: number) {
  const privateKeyRaw = process.env.DEPLOY_SSH_PRIVATE_KEY?.trim();
  if (!privateKeyRaw) {
    throw new Error("DEPLOY_SSH_PRIVATE_KEY is required for SSH runtime health checks.");
  }
  const privateKey = privateKeyRaw.replace(/\\n/g, "\n");
  const timeoutMs = Number(process.env.OPENCLAW_SSH_TIMEOUT_MS ?? "120000");
  const { user, host } = parseUserAndHost(sshTarget);
  const command = `bash -lc 'timeout 3 bash -c \"</dev/tcp/127.0.0.1/${port}\"'`;

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const conn = new Client();
    const timer = setTimeout(() => {
      finish(new Error(`SSH probe timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      conn.end();
      if (error) reject(error);
      else resolve();
    };

    conn
      .on("ready", () => {
        conn.exec(command, (execErr, stream) => {
          if (execErr) {
            finish(execErr);
            return;
          }
          let stderr = "";
          stream.stderr.on("data", (data: Buffer) => {
            stderr += data.toString("utf8");
          });
          stream.on("close", (code: number | null) => {
            if (code === 0) finish();
            else finish(new Error(stderr || `SSH probe failed with exit code ${code ?? "unknown"}`));
          });
        });
      })
      .on("error", (error) => finish(error))
      .connect({
        host,
        username: user,
        privateKey,
        readyTimeout: timeoutMs,
      });
  });
}

async function probeSshContainerRunning(sshTarget: string, containerName: string) {
  const privateKeyRaw = process.env.DEPLOY_SSH_PRIVATE_KEY?.trim();
  if (!privateKeyRaw) {
    throw new Error("DEPLOY_SSH_PRIVATE_KEY is required for SSH runtime health checks.");
  }
  const privateKey = privateKeyRaw.replace(/\\n/g, "\n");
  const timeoutMs = Number(process.env.OPENCLAW_SSH_TIMEOUT_MS ?? "120000");
  const { user, host } = parseUserAndHost(sshTarget);
  const safeContainer = containerName.replace(/"/g, '\\"');
  const command = `docker inspect -f '{{.State.Running}}' \"${safeContainer}\" 2>/dev/null || true`;

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const conn = new Client();
    const timer = setTimeout(() => {
      finish(new Error(`SSH container probe timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      conn.end();
      if (error) reject(error);
      else resolve();
    };

    conn
      .on("ready", () => {
        conn.exec(command, (execErr, stream) => {
          if (execErr) {
            finish(execErr);
            return;
          }
          let stdout = "";
          let stderr = "";
          stream.on("data", (data: Buffer) => {
            stdout += data.toString("utf8");
          });
          stream.stderr.on("data", (data: Buffer) => {
            stderr += data.toString("utf8");
          });
          stream.on("close", () => {
            const running = stdout.trim().toLowerCase() === "true";
            if (running) finish();
            else finish(new Error(stderr || "SSH container probe: container is not running"));
          });
        });
      })
      .on("error", (error) => finish(error))
      .connect({
        host,
        username: user,
        privateKey,
        readyTimeout: timeoutMs,
      });
  });
}

function buildOttoAgentMcpContainerName(containerName: string) {
  return `${containerName}-ottoagent-mcp`.slice(0, 63);
}

async function readSshContainerEnv(sshTarget: string, containerName: string) {
  const privateKeyRaw = process.env.DEPLOY_SSH_PRIVATE_KEY?.trim();
  if (!privateKeyRaw) {
    throw new Error("DEPLOY_SSH_PRIVATE_KEY is required for SSH runtime health checks.");
  }
  const privateKey = privateKeyRaw.replace(/\\n/g, "\n");
  const timeoutMs = Number(process.env.OPENCLAW_SSH_TIMEOUT_MS ?? "120000");
  const { user, host } = parseUserAndHost(sshTarget);
  const safeContainer = containerName.replace(/"/g, '\\"');
  const command = `docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' \"${safeContainer}\" 2>/dev/null || true`;

  return await new Promise<string[]>((resolve, reject) => {
    let settled = false;
    const conn = new Client();
    const timer = setTimeout(() => {
      finish(new Error(`SSH env probe timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    const finish = (error?: Error, lines?: string[]) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      conn.end();
      if (error) reject(error);
      else resolve(lines ?? []);
    };

    conn
      .on("ready", () => {
        conn.exec(command, (execErr, stream) => {
          if (execErr) {
            finish(execErr);
            return;
          }
          let stdout = "";
          let stderr = "";
          stream.on("data", (data: Buffer) => {
            stdout += data.toString("utf8");
          });
          stream.stderr.on("data", (data: Buffer) => {
            stderr += data.toString("utf8");
          });
          stream.on("close", () => {
            if (stderr.trim()) {
              finish(new Error(stderr.trim()));
              return;
            }
            finish(
              undefined,
              stdout
                .split("\n")
                .map((line) => line.trim())
                .filter(Boolean),
            );
          });
        });
      })
      .on("error", (error) => finish(error))
      .connect({
        host,
        username: user,
        privateKey,
        readyTimeout: timeoutMs,
      });
  });
}

async function assertFlavorRuntimeConformance(input: {
  deploymentFlavor: DeploymentFlavor;
  runtimeId: string;
  deployProvider: string | null;
}) {
  if (input.deploymentFlavor !== "ottoagent_free") return;

  const provider = (input.deployProvider ?? "").trim();
  if (provider === "ecs") {
    // OttoAgent ECS flavor validation is handled by runtime health checks + deployment strategy routing.
    return;
  }

  if (provider !== "ssh") {
    throw new Error(
      `OttoAgent deployment requires SSH provider runtime validation, but deploy provider is "${input.deployProvider ?? "unknown"}".`,
    );
  }

  const parsed = parseSshRuntimeId(input.runtimeId);
  if (!parsed) {
    throw new Error("OttoAgent deployment runtime id is not a valid SSH runtime id.");
  }

  await probeSshContainerRunning(parsed.sshTarget, parsed.containerName);
  const mcpContainerName = buildOttoAgentMcpContainerName(parsed.containerName);
  await probeSshContainerRunning(parsed.sshTarget, mcpContainerName);
  const envLines = await readSshContainerEnv(parsed.sshTarget, parsed.containerName);
  const mcpServersLine = envLines.find((line) => line.startsWith("SIMPLEAGENT_MCP_SERVERS_JSON="));
  if (!mcpServersLine) {
    throw new Error(
      "OttoAgent runtime missing SIMPLEAGENT_MCP_SERVERS_JSON on main container; queue worker is likely outdated.",
    );
  }
  const mcpConfig = mcpServersLine.slice("SIMPLEAGENT_MCP_SERVERS_JSON=".length);
  if (!mcpConfig.includes("ottoagent") && !mcpConfig.includes("ottoauth")) {
    throw new Error(
      "OttoAgent runtime MCP config does not include ottoauth/ottoagent server entry; refusing to mark deployment ready.",
    );
  }
}

async function resolveEcsPublicIp(ecsClient: ECSClient, ec2Client: EC2Client, input: { cluster: string; serviceName: string }) {
  const tasks = await ecsClient.send(
    new ListTasksCommand({
      cluster: input.cluster,
      serviceName: input.serviceName,
      desiredStatus: "RUNNING",
      maxResults: 5,
    }),
  );
  if (!tasks.taskArns?.length) return null;

  const described = await ecsClient.send(
    new DescribeTasksCommand({
      cluster: input.cluster,
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

  const interfaces = await ec2Client.send(
    new DescribeNetworkInterfacesCommand({
      NetworkInterfaceIds: Array.from(new Set(networkInterfaceIds)),
    }),
  );

  return interfaces.NetworkInterfaces?.find((eni) => eni.Association?.PublicIp)?.Association?.PublicIp ?? null;
}

async function waitForRuntimeReady(input: {
  readyUrl: string | null;
  deployProvider: string | null;
  runtimeId: string;
  deploymentFlavor: DeploymentFlavor;
}) {
  const defaultStartupTimeoutMs = Number(readTrimmedEnv("OPENCLAW_STARTUP_TIMEOUT_MS") || "600000");
  const pollIntervalMs = 3000;
  const parsedEcsRuntime = input.deployProvider === "ecs" ? parseEcsRuntimeId(input.runtimeId) : null;
  if (parsedEcsRuntime) {
    const ecsStartupTimeoutMs = Number(
      readTrimmedEnv("ECS_STARTUP_TIMEOUT_MS") || readTrimmedEnv("OPENCLAW_STARTUP_TIMEOUT_MS") || "300000",
    );
    const region = readTrimmedEnv("AWS_REGION");
    if (!region) {
      throw new Error("AWS_REGION is required for ECS runtime health checks.");
    }
    const ecsClient = new ECSClient(buildAwsConfigWithTrimmedCreds(region));
    const ec2Client = new EC2Client(buildAwsConfigWithTrimmedCreds(region));
    const port = getRuntimePort(input.deploymentFlavor);
    const deadline = Date.now() + ecsStartupTimeoutMs;
    let lastServiceStatus = "unknown";
    let lastEventMessage = "";
    let lastProbeError = "";
    while (Date.now() < deadline) {
      const result = await ecsClient.send(
        new DescribeServicesCommand({
          cluster: parsedEcsRuntime.cluster,
          services: [parsedEcsRuntime.serviceName],
        }),
      );
      const service = result.services?.[0];
      if (service?.status) lastServiceStatus = service.status;
      const latestEvent = service?.events?.[0]?.message?.trim();
      if (latestEvent) lastEventMessage = latestEvent;
      if (service && service.status === "ACTIVE" && (service.runningCount ?? 0) > 0) {
        try {
          const publicIp = await resolveEcsPublicIp(ecsClient, ec2Client, parsedEcsRuntime);
          if (publicIp) {
            await probeTcpPort(publicIp, port);
            return;
          }
          lastProbeError = "No public IP yet";
        } catch (error) {
          lastProbeError = error instanceof Error ? error.message : String(error);
        }
      }
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }
    const details = [
      `status=${lastServiceStatus}`,
      lastEventMessage ? `lastEvent=${lastEventMessage}` : "",
      lastProbeError ? `lastProbeError=${lastProbeError}` : "",
    ].filter(Boolean).join(" | ");
    throw new Error(
      `ECS service ${parsedEcsRuntime.serviceName} did not become reachable on port ${port} within ${ecsStartupTimeoutMs}ms${details ? ` (${details})` : ""}`,
    );
  }

  if (!input.readyUrl) {
    throw new Error("readyUrl is required for non-ECS runtime health checks.");
  }

  const url = new URL(input.readyUrl);
  const host = url.hostname;
  const port = Number(url.port || (url.protocol === "https:" ? "443" : "80"));
  const parsedSshRuntime = input.deployProvider === "ssh" ? parseSshRuntimeId(input.runtimeId) : null;
  const deadline = Date.now() + defaultStartupTimeoutMs;

  while (Date.now() < deadline) {
    try {
      if (parsedSshRuntime) {
        await probeSshContainerRunning(parsedSshRuntime.sshTarget, parsedSshRuntime.containerName);
        const httpProbe = await probeRuntimeHttp(input.readyUrl, 4000);
        if (httpProbe.ok) return;
        await probeSshLocalPort(parsedSshRuntime.sshTarget, port);
      } else {
        await probeTcpPort(host, port);
      }
      return;
    } catch {
      // Runtime may still be booting; keep polling until timeout.
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }

  throw new Error(`Runtime failed port check at ${input.readyUrl} within ${defaultStartupTimeoutMs}ms`);
}

async function waitForVideoMemoryReady(input: { videoMemoryUrl: string }) {
  const startupTimeoutMs = Number(readTrimmedEnv("VIDEOMEMORY_STARTUP_TIMEOUT_MS") || "180000");
  const pollIntervalMs = Number(readTrimmedEnv("VIDEOMEMORY_STARTUP_POLL_INTERVAL_MS") || "3000");
  const deadline = Date.now() + startupTimeoutMs;

  while (Date.now() < deadline) {
    const probe = await probeRuntimeHttp(input.videoMemoryUrl, 4000);
    if (probe.ok) return;
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }

  throw new Error(`VideoMemory sidecar failed health check at ${input.videoMemoryUrl} within ${startupTimeoutMs}ms`);
}

function normalizeMicroservicesUserId(value: string) {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._@-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  return (normalized || "user").slice(0, 80);
}

function normalizeMicroservicesBotId(value: string) {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  return (normalized || "bot").slice(0, 64);
}

function resolveRuntimeBaseUrl(readyUrl: string) {
  const parsed = new URL(readyUrl);
  parsed.pathname = "/";
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString();
}

async function readResponseBody(response: Response) {
  const text = await response.text().catch(() => "");
  if (!text) return null;
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return { raw: text.slice(0, 400) };
  }
}

async function requestRuntimeJson(input: {
  baseUrl: string;
  path: string;
  method?: "GET" | "POST";
  body?: Record<string, unknown>;
}) {
  const url = new URL(input.path, input.baseUrl).toString();
  const response = await fetch(url, {
    method: input.method ?? "GET",
    headers: input.body ? { "content-type": "application/json" } : undefined,
    body: input.body ? JSON.stringify(input.body) : undefined,
    signal: AbortSignal.timeout(15_000),
  });
  const parsedBody = await readResponseBody(response);
  if (!response.ok) {
    const details = typeof parsedBody === "object" && parsedBody !== null
      ? (parsedBody as { detail?: string; error?: string; raw?: string })
      : {};
    throw new Error(
      `${input.method ?? "GET"} ${input.path} failed (${response.status}): ${details.detail || details.error || details.raw || "request failed"}`,
    );
  }
  return parsedBody ?? {};
}

async function bootstrapSimpleAgentMicroservicesRuntime(input: {
  deploymentId: string;
  userId: string;
  botName: string | null;
  readyUrl: string | null;
  runtimeId: string;
  telegramBotToken?: string | null;
  openaiApiKey?: string | null;
  anthropicApiKey?: string | null;
}) {
  const runtimeBaseUrl = await (async () => {
    const rawReadyUrl = input.readyUrl?.trim() || "";
    const readyUrlFallbackBase = (() => {
      if (!rawReadyUrl) return "";
      try {
        const parsed = new URL(rawReadyUrl);
        if (parsed.pathname.startsWith("/runtime/")) return "";
        return resolveRuntimeBaseUrl(rawReadyUrl);
      } catch {
        return "";
      }
    })();

    const parsedRuntime = parseEcsRuntimeId(input.runtimeId);
    if (!parsedRuntime) {
      if (readyUrlFallbackBase) return readyUrlFallbackBase;
      throw new Error("Microservices bootstrap requires an ECS runtime id.");
    }
    const region = readTrimmedEnv("AWS_REGION");
    if (!region) {
      if (readyUrlFallbackBase) return readyUrlFallbackBase;
      throw new Error("AWS_REGION is required to resolve runtime task IP for bootstrap.");
    }
    const ecsClient = new ECSClient(buildAwsConfigWithTrimmedCreds(region));
    const ec2Client = new EC2Client(buildAwsConfigWithTrimmedCreds(region));
    const publicIp = await resolveEcsPublicIp(ecsClient, ec2Client, parsedRuntime);
    if (publicIp) {
      const port = getRuntimePort("simple_agent_microservices_ecs");
      return `http://${publicIp}:${port}/`;
    }
    if (readyUrlFallbackBase) return readyUrlFallbackBase;
    throw new Error("Could not resolve ECS task public IP for microservices bootstrap.");
  })();
  const runtimeUserId = normalizeMicroservicesUserId(input.userId);
  const botBaseName = input.botName?.trim() || `bot-${input.deploymentId.slice(0, 8)}`;
  const runtimeBotId = normalizeMicroservicesBotId(botBaseName);

  await requestRuntimeJson({
    baseUrl: runtimeBaseUrl,
    path: "/api/users",
    method: "POST",
    body: {
      user_id: runtimeUserId,
      display_name: runtimeUserId,
    },
  });

  const createBotBody = await requestRuntimeJson({
    baseUrl: runtimeBaseUrl,
    path: `/api/users/${encodeURIComponent(runtimeUserId)}/bots`,
    method: "POST",
    body: {
      bot_id: runtimeBotId,
      name: input.botName?.trim() || runtimeBotId,
    },
  });
  let botSecret = String((createBotBody as { bot_secret?: unknown }).bot_secret ?? "").trim();
  const createdBotId = normalizeMicroservicesBotId(
    String(
      ((createBotBody as { bot?: { bot_id?: unknown } }).bot ?? {}).bot_id ?? runtimeBotId,
    ),
  );
  if (!createdBotId) {
    throw new Error("Runtime bootstrap did not return a valid bot_id.");
  }

  if (!botSecret) {
    const resetBody = await requestRuntimeJson({
      baseUrl: runtimeBaseUrl,
      path: `/api/bots/${encodeURIComponent(createdBotId)}/reset-secret`,
      method: "POST",
      body: {},
    });
    botSecret = String((resetBody as { bot_secret?: unknown }).bot_secret ?? "").trim();
  }
  if (!botSecret) {
    throw new Error("Runtime bootstrap did not return a bot secret.");
  }

  const configPayload: Record<string, string> = {};
  if (input.telegramBotToken?.trim()) {
    configPayload.telegram_bot_token = input.telegramBotToken.trim();
  }
  if (input.openaiApiKey?.trim()) {
    configPayload.openai_api_key = input.openaiApiKey.trim();
  }
  if (input.anthropicApiKey?.trim()) {
    configPayload.anthropic_api_key = input.anthropicApiKey.trim();
  }
  if (Object.keys(configPayload).length > 0) {
    await requestRuntimeJson({
      baseUrl: runtimeBaseUrl,
      path: `/api/bots/${encodeURIComponent(createdBotId)}/config`,
      method: "POST",
      body: configPayload,
    });
  }

  const autoConnectUrl = new URL(runtimeBaseUrl);
  autoConnectUrl.searchParams.set("user_id", runtimeUserId);
  autoConnectUrl.searchParams.set("bot_id", createdBotId);
  autoConnectUrl.searchParams.set("bot_secret", botSecret);
  autoConnectUrl.searchParams.set("autoconnect", "1");

  return {
    runtimeUserId,
    runtimeBotId: createdBotId,
    runtimeBotSecret: botSecret,
    autoConnectUrl: autoConnectUrl.toString(),
  };
}

export async function processDeploymentJob(job: DeploymentJob) {
  await ensureSchema();
  let advisoryLockAcquired = false;
  if (useAdvisoryLocks()) {
    const lock = await pool.query<{ locked: boolean }>(
      `SELECT pg_try_advisory_lock(hashtext($1)) AS locked`,
      [job.deploymentId],
    );
    advisoryLockAcquired = Boolean(lock.rows[0]?.locked);
    if (!advisoryLockAcquired) {
      await appendEvent(job.deploymentId, "starting", "Skipping duplicate in-flight deployment job");
      return;
    }
  }
  try {
  const existing = await pool.query<{ status: string }>(
    `SELECT status FROM deployments WHERE id = $1 LIMIT 1`,
    [job.deploymentId],
  );
  const existingStatus = (existing.rows[0]?.status || "").trim().toLowerCase();
  if (existingStatus === "ready") {
    await appendEvent(job.deploymentId, "ready", "Skipping retry because deployment is already ready");
    return;
  }
  if (existingStatus === "failed") {
    await appendEvent(job.deploymentId, "failed", "Skipping retry because deployment is already failed");
    return;
  }
  if (existingStatus && existingStatus !== "queued" && existingStatus !== "starting") {
    await appendEvent(
      job.deploymentId,
      "starting",
      `Skipping retry because deployment is in status "${existingStatus}"`,
    );
    return;
  }
  await appendEvent(job.deploymentId, "starting", "Scheduling runtime host");
  const defaultProvider = resolveDefaultProvider();

  const providerSelectionRow = await pool.query<{
    plan_tier: string | null;
    deployment_flavor: string | null;
  }>(
    `SELECT plan_tier, deployment_flavor
     FROM deployments
     WHERE id = $1
     LIMIT 1`,
    [job.deploymentId],
  );
  const selectedDeploymentFlavor = normalizeDeploymentFlavor(providerSelectionRow.rows[0]?.deployment_flavor);
  const deploymentStrategy = resolveDeploymentStrategy(defaultProvider, selectedDeploymentFlavor);
  const provider = deploymentStrategy.provider;
  if (provider === "ecs" && selectedDeploymentFlavor === "simple_agent_videomemory_free") {
    throw new Error(
      "simple_agent_videomemory_free is not supported on ECS yet. Choose Simple Agent, OttoAgent, or Deploy OpenClaw.",
    );
  }
  const providerRequiresHost = provider === "ssh" || provider === "mock";

  const currentHostRow = await pool.query<{ host_name: string | null; status: string }>(
    `SELECT host_name, status FROM deployments WHERE id = $1 LIMIT 1`,
    [job.deploymentId],
  );
  const currentHostName = currentHostRow.rows[0]?.host_name?.trim() || "";
  const vmMatch = currentHostName.match(/^(?:lightsail-vm|do-vm)-(\d+)$/);
  if (vmMatch) {
    const currentStatus = (currentHostRow.rows[0]?.status || "").trim().toLowerCase();
    if (currentStatus !== "ready") {
      await appendEvent(job.deploymentId, "starting", `Cleaning previous VM ${currentHostName} before retry`);
      await destroyDedicatedVm(vmMatch[1]).catch(() => {});
    }
  }

  // Enforce one runtime per user by destroying previous runtimes that may still be active.
  const previousDeployments = await pool.query<{
    id: string;
    runtime_id: string | null;
    deploy_provider: string | null;
    ready_url: string | null;
  }>(
    `SELECT id, runtime_id, deploy_provider, ready_url
     FROM deployments
     WHERE user_id = $1
       AND id <> $2
       AND status IN ('ready', 'starting')
       AND runtime_id IS NOT NULL`,
    [job.userId, job.deploymentId],
  );

  for (const previous of previousDeployments.rows) {
    if (!previous.runtime_id) continue;
    let replacementReason = "Replaced by newer deployment";
    try {
      await destroyUserRuntime({
        runtimeId: previous.runtime_id,
        deployProvider: previous.deploy_provider,
        readyUrl: previous.ready_url,
      });
    } catch (error) {
      const cleanupError = resolveErrorMessage(error).slice(0, 300);
      replacementReason = `Replaced by newer deployment (cleanup warning: ${cleanupError})`;
      await appendEvent(
        job.deploymentId,
        "starting",
        `Previous runtime cleanup warning for ${previous.id}: ${cleanupError}. Continuing with new deployment.`,
      );
    }

    await pool.query(
      `UPDATE deployments
       SET status = 'failed',
           error = $2,
           updated_at = NOW()
       WHERE id = $1`,
      [previous.id, replacementReason],
    );
    await appendEvent(previous.id, "failed", replacementReason);
  }

  let host: Host | undefined;
  let dedicatedVmId: string | null = null;
  if (providerRequiresHost) {
    await appendEvent(job.deploymentId, "starting", "Provisioning dedicated VM host");
    host = await createDedicatedSshHost({ deploymentId: job.deploymentId, userId: job.userId });
    dedicatedVmId = host.vmId?.trim() || null;
    await pool.query(
      `UPDATE deployments SET host_name = $1, status = 'starting', error = NULL, updated_at = NOW() WHERE id = $2`,
      [host.name, job.deploymentId],
    );
    await appendEvent(job.deploymentId, "starting", `Assigned host ${host.name}`);
  } else {
    await pool.query(
      `UPDATE deployments SET host_name = $1, status = 'starting', error = NULL, updated_at = NOW() WHERE id = $2`,
      [provider, job.deploymentId],
    );
    const strategySuffix =
      deploymentStrategy.strategy === "legacy_default" ? "" : ` (strategy=${deploymentStrategy.strategy})`;
    await appendEvent(job.deploymentId, "starting", `Using provider ${provider}${strategySuffix}`);
  }

  let runtime: Awaited<ReturnType<typeof launchUserContainer>> | null = null;
  try {
  const deploymentRow = await pool.query<{
    bot_name: string | null;
    openai_api_key: string | null;
    anthropic_api_key: string | null;
    openrouter_api_key: string | null;
    telegram_bot_token: string | null;
    plan_tier: string | null;
    deployment_flavor: string | null;
  }>(
    `SELECT bot_name, openai_api_key, anthropic_api_key, openrouter_api_key, telegram_bot_token, plan_tier, deployment_flavor
     FROM deployments
     WHERE id = $1
     LIMIT 1`,
    [job.deploymentId],
  );
  const deploymentFlavor = normalizeDeploymentFlavor(deploymentRow.rows[0]?.deployment_flavor) as DeploymentFlavor;
  const onboarding = await pool.query<{
    bot_name: string | null;
    channel: string | null;
    telegram_bot_token: string | null;
    model_provider: string | null;
    model_api_key: string | null;
  }>(
    `SELECT bot_name, channel, telegram_bot_token, model_provider, model_api_key
     FROM onboarding_sessions
     WHERE user_id = $1
     LIMIT 1`,
    [job.userId],
  );
  const runtimeSlugSource =
    deploymentRow.rows[0]?.bot_name?.trim() || onboarding.rows[0]?.bot_name?.trim() || null;
  const selectedChannel = onboarding.rows[0]?.channel?.trim() || "none";
  const onboardingModelProvider = onboarding.rows[0]?.model_provider?.trim() || "";
  const onboardingModelApiKey = onboarding.rows[0]?.model_api_key?.trim() || "";
  const deploymentOpenAiKey = deploymentRow.rows[0]?.openai_api_key?.trim() || null;
  const deploymentAnthropicKey = deploymentRow.rows[0]?.anthropic_api_key?.trim() || null;
  const deploymentOpenRouterKey = deploymentRow.rows[0]?.openrouter_api_key?.trim() || null;
  const selectedOpenAiKey =
    deploymentOpenAiKey || (onboardingModelProvider === "openai" ? onboardingModelApiKey : null);
  const selectedAnthropicKey =
    deploymentAnthropicKey || (onboardingModelProvider === "anthropic" ? onboardingModelApiKey : null);
  const selectedOpenRouterKey = deploymentOpenRouterKey;
  const useSubsidyProxy = !selectedOpenAiKey && !selectedAnthropicKey && !selectedOpenRouterKey;
  const subsidyProxyToken = useSubsidyProxy ? randomUUID().replace(/-/g, "") : null;
  const onboardingTelegramBotToken = onboarding.rows[0]?.telegram_bot_token?.trim() || null;
  const deploymentTelegramBotToken = deploymentRow.rows[0]?.telegram_bot_token?.trim() || null;
  const telegramBotToken =
    deploymentTelegramBotToken ||
    onboardingTelegramBotToken ||
    process.env.OPENCLAW_TELEGRAM_BOT_TOKEN?.trim() ||
    null;
  const appBaseUrl = process.env.APP_BASE_URL?.trim() || "http://localhost:3000";
  const subsidyProxyBaseUrl = subsidyProxyToken
    ? `${appBaseUrl}/api/subsidy/openai/${job.deploymentId}/v1`
    : null;
  if (runtimeSlugSource) {
    await appendEvent(job.deploymentId, "starting", `Using runtime subdomain slug "${runtimeSlugSource}"`);
  }
  if (selectedChannel === "telegram") {
    await appendEvent(
      job.deploymentId,
      "starting",
      "Linking Telegram channel: provisioning bot token and runtime channel config",
    );
    if (!telegramBotToken) {
      throw new Error(
        "Telegram was selected, but no Telegram bot token is configured. Paste one during onboarding or set OPENCLAW_TELEGRAM_BOT_TOKEN on the server.",
      );
    }
  }

  if (useSubsidyProxy && subsidyProxyToken) {
    await appendEvent(job.deploymentId, "starting", "Using server-side subsidy proxy (50 requests/minute cap)");
  }
  await pool.query(
    `UPDATE deployments
     SET subsidy_proxy_token = $1,
         updated_at = NOW()
     WHERE id = $2`,
    [subsidyProxyToken, job.deploymentId],
  );

  runtime = await launchUserContainer({
    deploymentId: job.deploymentId,
    userId: job.userId,
    runtimeSlugSource,
    host,
    telegramBotToken: selectedChannel === "telegram" || Boolean(deploymentTelegramBotToken) ? telegramBotToken : null,
    openaiApiKey: selectedOpenAiKey,
    anthropicApiKey: selectedAnthropicKey,
    openrouterApiKey: selectedOpenRouterKey,
    subsidyProxyToken,
    subsidyProxyBaseUrl,
    deploymentFlavor,
    providerOverride: provider,
    ecsServicePrefixOverride: deploymentStrategy.ecsServicePrefixOverride,
  });
  await pool.query(
    `UPDATE deployments
     SET ready_url = $1,
         runtime_id = $2,
         deploy_provider = $3,
         runtime_user_id = NULL,
         runtime_bot_id = NULL,
         runtime_bot_secret = NULL,
         video_memory_ready_at = NULL,
         updated_at = NOW()
     WHERE id = $4`,
    [runtime.readyUrl, runtime.runtimeId, runtime.deployProvider, job.deploymentId],
  );
  await appendEvent(job.deploymentId, "starting", "Runtime launched; persisted runtime metadata");
  await appendEvent(job.deploymentId, "starting", "Waiting for runtime health check");
  await waitForRuntimeReady({
    readyUrl: runtime.readyUrl,
    deployProvider: runtime.deployProvider,
    runtimeId: runtime.runtimeId,
    deploymentFlavor,
  });
  if (deploymentFlavor === "simple_agent_microservices_ecs") {
    await appendEvent(job.deploymentId, "starting", "Bootstrapping runtime user/bot for one-click auto-connect");
    const bootstrap = await bootstrapSimpleAgentMicroservicesRuntime({
      deploymentId: job.deploymentId,
      userId: job.userId,
      botName: runtimeSlugSource,
      readyUrl: runtime.readyUrl,
      runtimeId: runtime.runtimeId,
      telegramBotToken,
      openaiApiKey: selectedOpenAiKey,
      anthropicApiKey: selectedAnthropicKey,
    });
    await pool.query(
      `UPDATE deployments
       SET runtime_user_id = $1,
           runtime_bot_id = $2,
           runtime_bot_secret = $3,
           ready_url = $4,
           updated_at = NOW()
       WHERE id = $5`,
      [
        bootstrap.runtimeUserId,
        bootstrap.runtimeBotId,
        bootstrap.runtimeBotSecret,
        bootstrap.autoConnectUrl,
        job.deploymentId,
      ],
    );
    runtime = {
      ...runtime,
      readyUrl: bootstrap.autoConnectUrl,
    };
    await appendEvent(
      job.deploymentId,
      "starting",
      `Runtime bootstrap complete (user=${bootstrap.runtimeUserId} bot=${bootstrap.runtimeBotId})`,
    );
  }
  if (deploymentFlavor === "ottoagent_free") {
    await appendEvent(job.deploymentId, "starting", "Validating OttoAgent MCP runtime wiring");
    await assertFlavorRuntimeConformance({
      deploymentFlavor,
      runtimeId: runtime.runtimeId,
      deployProvider: runtime.deployProvider,
    });
    await appendEvent(job.deploymentId, "starting", "OttoAgent MCP runtime validation passed");
  }
  if (deploymentFlavor === "simple_agent_videomemory_free") {
    const videoMemoryUrl = buildVideoMemoryUrl({
      deploymentId: job.deploymentId,
      deploymentFlavor,
      runtimeId: runtime.runtimeId,
      status: "ready",
    });
    if (!videoMemoryUrl) {
      throw new Error("Failed to resolve VideoMemory URL for simple_agent_videomemory_free deployment.");
    }
    await appendEvent(job.deploymentId, "starting", "Waiting for VideoMemory sidecar health check");
    await waitForVideoMemoryReady({ videoMemoryUrl });
    await pool.query(
      `UPDATE deployments
       SET video_memory_ready_at = NOW(),
           updated_at = NOW()
       WHERE id = $1`,
      [job.deploymentId],
    );
    await appendEvent(job.deploymentId, "starting", "VideoMemory sidecar health check passed");
  }

  await pool.query(
    `UPDATE deployments
     SET status = 'ready',
         updated_at = NOW()
     WHERE id = $1`,
    [job.deploymentId],
  );
  await appendEvent(job.deploymentId, "ready", "Runtime is ready");
  if (selectedOpenAiKey || selectedAnthropicKey || selectedOpenRouterKey) {
    await appendEvent(job.deploymentId, "ready", "Configured runtime API credentials from deployment settings.");
  }
  } catch (error) {
    if (runtime) {
      await destroyUserRuntime({
        runtimeId: runtime.runtimeId,
        deployProvider: runtime.deployProvider,
        readyUrl: runtime.readyUrl,
      }).catch(() => {});
    } else if (dedicatedVmId) {
      await destroyDedicatedVm(dedicatedVmId).catch(() => {});
    }
    throw error;
  }
  } finally {
    if (advisoryLockAcquired) {
      await pool.query(`SELECT pg_advisory_unlock(hashtext($1))`, [job.deploymentId]).catch(() => {});
    }
  }
}

export async function markDeploymentFailed(deploymentId: string, error: unknown) {
  const message = resolveErrorMessage(error);
  const updated = await pool.query<{ status: string }>(
    `UPDATE deployments
     SET status = 'failed',
         error = $1,
         updated_at = NOW()
     WHERE id = $2
       AND status <> 'ready'
     RETURNING status`,
    [message, deploymentId],
  );
  if (updated.rowCount === 0) {
    const current = await pool.query<{ status: string }>(
      `SELECT status FROM deployments WHERE id = $1 LIMIT 1`,
      [deploymentId],
    );
    const currentStatus = (current.rows[0]?.status || "").trim().toLowerCase();
    if (currentStatus === "ready") {
      await appendEvent(deploymentId, "ready", `Ignored stale failure after deployment reached ready: ${message}`);
      return message;
    }
  }
  await appendEvent(deploymentId, "failed", message);
  return message;
}

function resolveErrorMessage(error: unknown) {
  if (error instanceof Error) {
    const message = error.message?.trim();
    if (message && message.toLowerCase() !== "unknown") return message;
    if (error.name?.trim()) {
      return message ? `${error.name}: ${message}` : error.name;
    }
    return message || "Unexpected deployment failure";
  }
  if (error && typeof error === "object") {
    const name = String((error as { name?: unknown }).name ?? "").trim();
    const type = String((error as { __type?: unknown }).__type ?? "").trim();
    const message = String((error as { message?: unknown }).message ?? "").trim();
    if (message && message.toLowerCase() !== "unknown") {
      return name ? `${name}: ${message}` : message;
    }
    if (name && message) {
      return `${name}: ${message}`;
    }
    if (name) return name;
    if (type) return type;
    try {
      return JSON.stringify(error);
    } catch {
      return "Unexpected deployment failure";
    }
  }
  if (typeof error === "string" && error.trim()) return error.trim();
  return "Unexpected deployment failure";
}

export function startDeploymentWorker() {
  const worker = new Worker<DeploymentJob>(
    queueName,
    async (bullJob) => {
      try {
        await processDeploymentJob(bullJob.data);
      } catch (error) {
        await markDeploymentFailed(bullJob.data.deploymentId, error);
        throw error;
      }
    },
    { connection: getQueueConnection() },
  );

  worker.on("error", (error) => {
    console.error("Deployment worker error:", error);
  });

  return worker;
}

if (process.argv.includes("--run")) {
  startDeploymentWorker();
  // Keep process running.
  setInterval(() => {}, 60_000);
}

export function newDeploymentId() {
  return randomUUID();
}
