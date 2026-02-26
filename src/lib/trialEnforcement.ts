import { pool } from "@/lib/db";
import { destroyUserRuntime } from "@/lib/provisioner/runtimeProvider";
import { isFreeTrialExpired } from "@/lib/plans";

const FREE_TRIAL_EXPIRED_MESSAGE =
  "Free trial expired after 30 days. Upgrade to the $20/month paid tier to reactivate.";

type ExpiredDeploymentRow = {
  id: string;
  runtime_id: string | null;
  deploy_provider: string | null;
  trial_expires_at: string | null;
};

export async function deactivateExpiredFreeTrialsForUser(userId: string) {
  const result = await pool.query<ExpiredDeploymentRow>(
    `SELECT id, runtime_id, deploy_provider, trial_expires_at
     FROM deployments
     WHERE user_id = $1
       AND plan_tier = 'free'
       AND status IN ('ready', 'failed')
       AND deactivated_at IS NULL
       AND trial_expires_at IS NOT NULL`,
    [userId],
  );

  for (const row of result.rows) {
    if (!isFreeTrialExpired(row.trial_expires_at)) continue;
    if (row.runtime_id) {
      try {
        await destroyUserRuntime({
          runtimeId: row.runtime_id,
          deployProvider: row.deploy_provider,
        });
      } catch {
        // Keep deactivation idempotent even if the runtime no longer exists.
      }
    }
    await pool.query(
      `UPDATE deployments
       SET status = 'deactivated',
           error = $2,
           deactivated_at = NOW(),
           deactivation_reason = 'trial_expired',
           updated_at = NOW()
       WHERE id = $1`,
      [row.id, FREE_TRIAL_EXPIRED_MESSAGE],
    );
    await pool.query(
      `INSERT INTO deployment_events (deployment_id, status, message)
       VALUES ($1, 'failed', $2)`,
      [row.id, FREE_TRIAL_EXPIRED_MESSAGE],
    );
  }
}

export function freeTrialExpiredMessage() {
  return FREE_TRIAL_EXPIRED_MESSAGE;
}
