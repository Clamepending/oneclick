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
import { normalizeDeploymentFlavor, normalizePlanTier, type DeploymentFlavor, type PlanTier } from "@/lib/plans";
import { selectHost } from "@/lib/provisioner/hostScheduler";
import { createDedicatedSshHost, destroyDedicatedVm } from "@/lib/provisioner/dedicatedVm";
import { destroyUserRuntime, launchUserContainer } from "@/lib/provisioner/runtimeProvider";

type DeploymentJob = {
  deploymentId: string;
  userId: string;
};

const queueName = "deployment-jobs";

function getQueueConnection() {
  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) {
    throw new Error("REDIS_URL is required for queue operations.");
  }
  return { url: redisUrl };
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

function resolveProviderForDeployment(defaultProvider: string, deploymentFlavor: DeploymentFlavor) {
  if (deploymentFlavor === "lightsail") {
    return readTrimmedEnv("DEPLOY_PROVIDER_LIGHTSAIL") || "ssh";
  }
  return defaultProvider;
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
}) {
  const defaultStartupTimeoutMs = Number(readTrimmedEnv("OPENCLAW_STARTUP_TIMEOUT_MS") || "120000");
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
    const port = Number(readTrimmedEnv("OPENCLAW_CONTAINER_PORT") || "18789");
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

export async function processDeploymentJob(job: DeploymentJob) {
  await ensureSchema();
  const lock = await pool.query<{ locked: boolean }>(
    `SELECT pg_try_advisory_lock(hashtext($1)) AS locked`,
    [job.deploymentId],
  );
  if (!lock.rows[0]?.locked) {
    await appendEvent(job.deploymentId, "starting", "Skipping duplicate in-flight deployment job");
    return;
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
  await appendEvent(job.deploymentId, "starting", "Scheduling runtime host");
  const defaultProvider = readTrimmedEnv("DEPLOY_PROVIDER") || "mock";

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
  const selectedDeploymentFlavor = normalizeDeploymentFlavor(
    providerSelectionRow.rows[0]?.deployment_flavor,
  ) as DeploymentFlavor;
  const provider = resolveProviderForDeployment(defaultProvider, selectedDeploymentFlavor);
  const providerRequiresHost = provider === "ssh" || provider === "mock";

  if (selectedDeploymentFlavor === "lightsail") {
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
  }

  // Enforce one runtime per user by destroying previous ready runtimes.
  const previousDeployments = await pool.query<{
    id: string;
    runtime_id: string | null;
    deploy_provider: string | null;
  }>(
    `SELECT id, runtime_id, deploy_provider
     FROM deployments
     WHERE user_id = $1
       AND id <> $2
       AND status = 'ready'
       AND runtime_id IS NOT NULL`,
    [job.userId, job.deploymentId],
  );

  for (const previous of previousDeployments.rows) {
    if (!previous.runtime_id) continue;
    await destroyUserRuntime({
      runtimeId: previous.runtime_id,
      deployProvider: previous.deploy_provider,
    });

    await pool.query(
      `UPDATE deployments
       SET status = 'failed',
           error = 'Replaced by newer deployment',
           updated_at = NOW()
       WHERE id = $1`,
      [previous.id],
    );
    await appendEvent(previous.id, "failed", "Replaced by newer deployment");
  }

  let host: Awaited<ReturnType<typeof selectHost>> | undefined;
  let dedicatedVmId: string | null = null;
  if (providerRequiresHost) {
    if (selectedDeploymentFlavor === "lightsail") {
      await appendEvent(job.deploymentId, "starting", "Provisioning dedicated VM host");
      host = await createDedicatedSshHost({ deploymentId: job.deploymentId, userId: job.userId });
      dedicatedVmId = host.vmId?.trim() || null;
    } else {
      const activeByHost = new Map<string, number>();
      const activeRows = await pool.query<{ host_name: string; active_count: string }>(
        `SELECT host_name, COUNT(*)::text as active_count
         FROM deployments
         WHERE status IN ('queued', 'starting') AND host_name IS NOT NULL
         GROUP BY host_name`,
      );
      for (const row of activeRows.rows) {
        activeByHost.set(row.host_name, Number(row.active_count));
      }
      host = await selectHost(activeByHost);
    }
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
    await appendEvent(job.deploymentId, "starting", `Using provider ${provider}`);
  }

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
  const planTier = normalizePlanTier(deploymentRow.rows[0]?.plan_tier) as PlanTier;
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

  let runtime: Awaited<ReturnType<typeof launchUserContainer>> | null = null;
  try {
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
      planTier,
      deploymentFlavor,
      providerOverride: provider as "mock" | "ssh" | "ecs",
    });
    await pool.query(
      `UPDATE deployments
       SET ready_url = $1,
           runtime_id = $2,
           deploy_provider = $3,
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
    });
  } catch (error) {
    if (runtime) {
      await destroyUserRuntime({
        runtimeId: runtime.runtimeId,
        deployProvider: runtime.deployProvider,
      }).catch(() => {});
    } else if (dedicatedVmId) {
      await destroyDedicatedVm(dedicatedVmId).catch(() => {});
    }
    throw error;
  }

  await pool.query(
    `UPDATE deployments
     SET status = 'ready',
         updated_at = NOW()
     WHERE id = $1`,
    [job.deploymentId],
  );
  await appendEvent(job.deploymentId, "ready", "Runtime is ready");
  if (deploymentFlavor === "advanced") {
    await appendEvent(job.deploymentId, "ready", "Advanced mode bootstrap queued: agent will receive OttoAuth setup prompt.");
  }
  if (selectedOpenAiKey || selectedAnthropicKey || selectedOpenRouterKey) {
    await appendEvent(job.deploymentId, "ready", "Configured runtime API credentials from deployment settings.");
  }
  } finally {
    await pool.query(`SELECT pg_advisory_unlock(hashtext($1))`, [job.deploymentId]).catch(() => {});
  }
}

export async function markDeploymentFailed(deploymentId: string, error: unknown) {
  const message = error instanceof Error ? error.message : "Unexpected deployment failure";
  await pool.query(
    `UPDATE deployments SET status = 'failed', error = $1, updated_at = NOW() WHERE id = $2`,
    [message, deploymentId],
  );
  await appendEvent(deploymentId, "failed", message);
  return message;
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
