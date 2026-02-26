import "dotenv/config";
import { ensureSchema, pool } from "@/lib/db";
import { destroyUserRuntime } from "@/lib/provisioner/runtimeProvider";

type ReadyDeployment = {
  id: string;
  user_id: string;
  runtime_id: string | null;
  deploy_provider: string | null;
  created_at: string;
};

function readTrimmedEnv(name: string) {
  const raw = process.env[name];
  if (!raw) return "";
  return raw.trim().replace(/^"(.*)"$/, "$1").replace(/\\n/g, "").trim();
}

function readIntEnv(name: string, fallback: number) {
  const raw = readTrimmedEnv(name);
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.floor(parsed);
}

function readBoolEnv(name: string, fallback = false) {
  const raw = readTrimmedEnv(name).toLowerCase();
  if (!raw) return fallback;
  if (["1", "true", "yes", "on"].includes(raw)) return true;
  if (["0", "false", "no", "off"].includes(raw)) return false;
  return fallback;
}

async function appendEvent(deploymentId: string, status: string, message: string) {
  await pool.query(
    `INSERT INTO deployment_events (deployment_id, status, message)
     VALUES ($1, $2, $3)`,
    [deploymentId, status, message],
  );
}

async function main() {
  const ttlMinutes = readIntEnv("DEPLOY_AUTO_STOP_READY_AFTER_MINUTES", 0);
  const sweepLimit = readIntEnv("DEPLOY_COST_GUARD_SWEEP_LIMIT", 25);
  const dryRun = readBoolEnv("DEPLOY_COST_GUARD_DRY_RUN", false);

  if (ttlMinutes <= 0) {
    console.log(
      "DEPLOY_AUTO_STOP_READY_AFTER_MINUTES is not set (>0), skipping cost guard sweep.",
    );
    return;
  }

  await ensureSchema();

  const candidates = await pool.query<ReadyDeployment>(
    `SELECT id, user_id, runtime_id, deploy_provider, created_at
     FROM deployments
     WHERE status = 'ready'
       AND created_at < NOW() - ($1::double precision * INTERVAL '1 minute')
     ORDER BY created_at ASC
     LIMIT $2`,
    [ttlMinutes, sweepLimit],
  );

  if (candidates.rows.length === 0) {
    console.log(`No ready deployments older than ${ttlMinutes} minutes.`);
    return;
  }

  console.log(
    `${dryRun ? "[dry-run] " : ""}Found ${candidates.rows.length} ready deployment(s) older than ${ttlMinutes} minutes.`,
  );

  const stopMessage = `Auto-stopped by cost guard after ${ttlMinutes} minutes (runtime age limit).`;

  for (const row of candidates.rows) {
    console.log(
      `${dryRun ? "[dry-run] " : ""}Stopping deployment ${row.id} provider=${row.deploy_provider ?? "unknown"} runtime=${row.runtime_id ?? "none"}`,
    );

    if (dryRun) continue;

    try {
      if (row.runtime_id) {
        await destroyUserRuntime({
          runtimeId: row.runtime_id,
          deployProvider: row.deploy_provider,
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await appendEvent(row.id, "failed", `Cost guard destroy failed: ${message}`);
      console.error(`Destroy failed for ${row.id}: ${message}`);
      continue;
    }

    await pool.query(
      `UPDATE deployments
       SET status = 'failed',
           error = $2,
           updated_at = NOW()
       WHERE id = $1`,
      [row.id, stopMessage],
    );
    await appendEvent(row.id, "failed", stopMessage);
  }
}

void main()
  .catch((error) => {
    console.error("Cost guard sweep failed:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    try {
      await pool.end();
    } catch {
      // Ignore pool shutdown errors during script exit.
    }
  });
