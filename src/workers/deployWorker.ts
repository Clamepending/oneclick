import "dotenv/config";
import { Queue, Worker } from "bullmq";
import { randomUUID } from "crypto";
import net from "node:net";
import { ensureSchema, pool } from "@/lib/db";
import { selectHost } from "@/lib/provisioner/hostScheduler";
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

async function waitForRuntimeReady(readyUrl: string) {
  const startupTimeoutMs = Number(process.env.OPENCLAW_STARTUP_TIMEOUT_MS ?? "120000");
  const pollIntervalMs = 3000;
  const url = new URL(readyUrl);
  const host = url.hostname;
  const port = Number(url.port || (url.protocol === "https:" ? "443" : "80"));
  const deadline = Date.now() + startupTimeoutMs;

  while (Date.now() < deadline) {
    try {
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
      return;
    } catch {
      // Runtime may still be booting; keep polling until timeout.
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }

  throw new Error(`Runtime failed port check at ${readyUrl} within ${startupTimeoutMs}ms`);
}

export async function processDeploymentJob(job: DeploymentJob) {
  await ensureSchema();
  await appendEvent(job.deploymentId, "starting", "Scheduling runtime host");

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

  const host = await selectHost(activeByHost);
  await pool.query(
    `UPDATE deployments SET host_name = $1, status = 'starting', updated_at = NOW() WHERE id = $2`,
    [host.name, job.deploymentId],
  );
  await appendEvent(job.deploymentId, "starting", `Assigned host ${host.name}`);

  const deploymentBot = await pool.query<{ bot_name: string | null }>(
    `SELECT bot_name
     FROM deployments
     WHERE id = $1
     LIMIT 1`,
    [job.deploymentId],
  );
  const onboarding = await pool.query<{ bot_name: string | null }>(
    `SELECT bot_name
     FROM onboarding_sessions
     WHERE user_id = $1
     LIMIT 1`,
    [job.userId],
  );
  const runtimeSlugSource =
    deploymentBot.rows[0]?.bot_name?.trim() || onboarding.rows[0]?.bot_name?.trim() || null;
  if (runtimeSlugSource) {
    await appendEvent(job.deploymentId, "starting", `Using runtime subdomain slug "${runtimeSlugSource}"`);
  }

  const runtime = await launchUserContainer({
    deploymentId: job.deploymentId,
    userId: job.userId,
    runtimeSlugSource,
    host,
  });
  await appendEvent(job.deploymentId, "starting", "Waiting for runtime health check");
  await waitForRuntimeReady(runtime.readyUrl);

  await pool.query(
    `UPDATE deployments
     SET status = 'ready',
         ready_url = $1,
         runtime_id = $2,
         deploy_provider = $3,
         updated_at = NOW()
     WHERE id = $4`,
    [runtime.readyUrl, runtime.runtimeId, runtime.deployProvider, job.deploymentId],
  );
  await appendEvent(job.deploymentId, "ready", "Runtime is ready");
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
