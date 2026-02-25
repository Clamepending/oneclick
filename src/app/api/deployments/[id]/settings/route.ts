import { DescribeTasksCommand, ECSClient, ListTasksCommand } from "@aws-sdk/client-ecs";
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

  const publicIp = interfaces.NetworkInterfaces?.find((eni) => eni.Association?.PublicIp)?.Association?.PublicIp;
  if (!publicIp) return null;

  const port = Number(readTrimmedEnv("OPENCLAW_CONTAINER_PORT") || "18789");
  try {
    await probeTcpPort(publicIp, port);
  } catch {
    return null;
  }
  return `http://${publicIp}:${port}`;
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
  const provider = (input.deployProvider ?? "").trim();
  if (provider === "ecs" && input.runtimeId) {
    const resolved = await resolveEcsPublicUrl(input.runtimeId);
    if (!resolved) return null;
    return mergeResolvedRuntimeUrl(resolved, input.readyUrl);
  }
  const raw = input.readyUrl?.trim();
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
    return { attempted: true, applied: false as const, reason: "runtime_unreachable" };
  }

  const token = new URL(gatewayUrl).searchParams.get("token");
  if (!token) {
    return { attempted: true, applied: false as const, reason: "missing_gateway_token" };
  }

  if (typeof WebSocket === "undefined") {
    return { attempted: true, applied: false as const, reason: "websocket_unavailable" };
  }

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

  try {
    await openPromise;
    await rpc("connect", {
      minProtocol: 3,
      maxProtocol: 3,
      client: {
        id: "oneclick",
        version: "1",
        platform: "server",
        mode: "operator",
      },
      role: "operator",
      scopes: ["operator.read", "operator.write"],
      caps: [],
      commands: [],
      permissions: {},
      auth: { token },
      locale: "en-US",
      userAgent: "oneclick-settings",
    });

    const currentConfig = (await rpc("config.get", {})) as { hash?: string } | null;
    const baseHash = currentConfig?.hash;
    if (!baseHash) {
      return { attempted: true, applied: false as const, reason: "config_hash_missing" };
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
    return { attempted: true, applied: false as const, reason: message };
  } finally {
    try {
      ws.close();
    } catch {
      // no-op
    }
  }
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

  const { id } = await context.params;
  const parsed = payloadSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ ok: false, error: "Invalid settings payload" }, { status: 400 });
  }

  await ensureSchema();
  const owned = await pool.query<{
    id: string;
    status: string;
    bot_name: string | null;
    model_provider: string | null;
    openai_api_key: string | null;
    anthropic_api_key: string | null;
    openrouter_api_key: string | null;
    telegram_bot_token: string | null;
    deploy_provider: string | null;
    runtime_id: string | null;
    ready_url: string | null;
  }>(
    `SELECT id, status, bot_name, model_provider, openai_api_key, anthropic_api_key, openrouter_api_key, telegram_bot_token,
            deploy_provider, runtime_id, ready_url
     FROM deployments
     WHERE id = $1 AND user_id = $2
     LIMIT 1`,
    [id, session.user.email],
  );
  const current = owned.rows[0];
  if (!current) {
    return NextResponse.json({ ok: false, error: "Not found" }, { status: 404 });
  }

  const { openaiApiKey, anthropicApiKey, openrouterApiKey, telegramBotToken, redeploy } = parsed.data;
  const updated = await pool.query<{
    bot_name: string | null;
    model_provider: string | null;
    openai_api_key: string | null;
    anthropic_api_key: string | null;
    openrouter_api_key: string | null;
    telegram_bot_token: string | null;
  }>(
    `UPDATE deployments
     SET openai_api_key = COALESCE($1, openai_api_key),
         anthropic_api_key = COALESCE($2, anthropic_api_key),
         openrouter_api_key = COALESCE($3, openrouter_api_key),
         telegram_bot_token = COALESCE($4, telegram_bot_token),
         updated_at = NOW()
     WHERE id = $5 AND user_id = $6
     RETURNING bot_name, model_provider, openai_api_key, anthropic_api_key, openrouter_api_key, telegram_bot_token`,
    [
      openaiApiKey ?? null,
      anthropicApiKey ?? null,
      openrouterApiKey ?? null,
      telegramBotToken ?? null,
      id,
      session.user.email,
    ],
  );

  let liveApply:
    | { attempted: boolean; applied: boolean; reason?: string }
    | undefined;
  if (telegramBotToken?.trim()) {
    liveApply = await tryHotApplyTelegramToken({
      deploymentId: id,
      deployProvider: current.deploy_provider,
      runtimeId: current.runtime_id,
      readyUrl: current.ready_url,
      telegramBotToken: telegramBotToken.trim(),
    });
  }

  if (!redeploy) {
    return NextResponse.json({ ok: true, liveApply });
  }

  if (current.status === "queued" || current.status === "starting") {
    return NextResponse.json(
      { ok: false, error: "Cannot redeploy while this deployment is still in progress." },
      { status: 409 },
    );
  }

  const active = await pool.query<{ count: string }>(
    `SELECT COUNT(*)::text as count
     FROM deployments
     WHERE user_id = $1
       AND id <> $2
       AND status IN ('queued', 'starting')`,
    [session.user.email, id],
  );
  const maxActive = Number(process.env.DEPLOY_MAX_ACTIVE_PER_USER ?? "1");
  if (Number(active.rows[0]?.count ?? "0") >= maxActive) {
    return NextResponse.json(
      { ok: false, error: "You already have an active deployment in progress." },
      { status: 409 },
    );
  }

  const nextDeploymentId = newDeploymentId();
  const source = updated.rows[0] ?? current;
  let redeployModelProvider = source.model_provider;
  if (!redeployModelProvider) {
    const onboarding = await pool.query<{ model_provider: string | null }>(
      `SELECT model_provider
       FROM onboarding_sessions
       WHERE user_id = $1
       LIMIT 1`,
      [session.user.email],
    );
    redeployModelProvider = onboarding.rows[0]?.model_provider?.trim() || null;
  }
  await pool.query(
    `INSERT INTO deployments (
       id, user_id, bot_name, status, model_provider, openai_api_key, anthropic_api_key, openrouter_api_key, telegram_bot_token
     )
     VALUES ($1, $2, $3, 'queued', $4, $5, $6, $7, $8)`,
    [
      nextDeploymentId,
      session.user.email,
      source.bot_name,
      redeployModelProvider,
      source.openai_api_key,
      source.anthropic_api_key,
      source.openrouter_api_key,
      source.telegram_bot_token,
    ],
  );

  await pool.query(
    `INSERT INTO deployment_events (deployment_id, status, message)
     VALUES ($1, 'queued', 'Deployment accepted and queued (redeploy from settings)')`,
    [nextDeploymentId],
  );

  const queueInfo = getQueueModeInfo();
  await pool.query(
    `INSERT INTO deployment_events (deployment_id, status, message)
     VALUES ($1, 'queued', $2)`,
    [
      nextDeploymentId,
      `Queue routing: runtime=vercel queueProvider=sqs queueUsable=${queueInfo.usable ? "yes" : "no"} endpoint=${summarizeQueueEndpoint(queueInfo.endpoint)} reason=${queueInfo.reason}`,
    ],
  );

  if (!queueInfo.usable) {
    const message = queueUnavailableMessage(queueInfo);
    await markDeploymentFailed(nextDeploymentId, new Error(message));
    return NextResponse.json({ ok: false, error: message }, { status: 503 });
  }

  try {
    await pool.query(
      `INSERT INTO deployment_events (deployment_id, status, message)
       VALUES ($1, 'queued', 'Queue available; enqueueing deployment job for AWS consumer')`,
      [nextDeploymentId],
    );
    await enqueueDeploymentJob({ deploymentId: nextDeploymentId, userId: session.user.email });
    await pool.query(
      `INSERT INTO deployment_events (deployment_id, status, message)
       VALUES ($1, 'queued', 'Deployment job enqueued successfully; waiting for AWS consumer pickup')`,
      [nextDeploymentId],
    );
  } catch (error) {
    await markDeploymentFailed(nextDeploymentId, error);
    const message = error instanceof Error ? error.message : "Failed to enqueue deployment";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }

  return NextResponse.json({ ok: true, redeployed: true, deploymentId: nextDeploymentId, liveApply });
}
