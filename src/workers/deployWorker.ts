import "dotenv/config";
import { Queue, Worker } from "bullmq";
import { randomUUID } from "crypto";
import { ensureSchema, pool } from "@/lib/db";
import { selectHost } from "@/lib/provisioner/hostScheduler";
import { launchUserContainer } from "@/lib/provisioner/runtimeProvider";

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

export async function processDeploymentJob(job: DeploymentJob) {
  await ensureSchema();
  await appendEvent(job.deploymentId, "starting", "Scheduling runtime host");

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

  const runtime = await launchUserContainer({
    deploymentId: job.deploymentId,
    userId: job.userId,
    hostName: host.name,
  });

  await pool.query(
    `UPDATE deployments
     SET status = 'ready', ready_url = $1, updated_at = NOW()
     WHERE id = $2`,
    [runtime.readyUrl, job.deploymentId],
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
