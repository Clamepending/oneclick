import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { ensureSchema, pool } from "@/lib/db";
import { destroyDedicatedVm } from "@/lib/provisioner/dedicatedVm";
import { destroyUserRuntime } from "@/lib/provisioner/runtimeProvider";
import { probeRuntimeHttp } from "@/lib/runtimeHealth";
import { deactivateExpiredFreeTrialsForUser } from "@/lib/trialEnforcement";

async function checkRuntimeHealth(readyUrl: string) {
  const result = await probeRuntimeHttp(readyUrl, 3000);
  return { ok: result.ok, status: result.status };
}

function isStaleInProgressDeployment(item: { status: string; updated_at: string }) {
  if (item.status !== "queued" && item.status !== "starting") return false;
  const updatedAtMs = Date.parse(item.updated_at);
  if (!Number.isFinite(updatedAtMs)) return false;
  const staleAfterMs = Number(process.env.DEPLOY_STALE_STARTING_TIMEOUT_MS ?? "900000");
  return Date.now() - updatedAtMs > staleAfterMs;
}

function isIgnorableRuntimeDestroyError(error: unknown) {
  if (!(error instanceof Error)) return false;
  const message = error.message.toLowerCase();
  return (
    message.includes("not found") ||
    message.includes("404") ||
    message.includes("does not exist") ||
    message.includes("serviceinactive") ||
    message.includes("servicenotfound")
  );
}

function parseDedicatedVmId(hostName: string | null | undefined) {
  const normalized = (hostName ?? "").trim();
  if (!normalized) return null;
  const match = normalized.match(/^(?:lightsail-vm|do-vm)-(\d+)$/);
  return match?.[1] ?? null;
}

async function cleanupDeploymentRuntime(input: {
  runtime_id: string | null;
  deploy_provider: string | null;
  ready_url: string | null;
  host_name?: string | null;
}) {
  if (input.runtime_id) {
    await destroyUserRuntime({
      runtimeId: input.runtime_id,
      deployProvider: input.deploy_provider,
      readyUrl: input.ready_url,
    });
    return;
  }
  const vmId = parseDedicatedVmId(input.host_name);
  if (!vmId) return;
  await destroyDedicatedVm(vmId);
}

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  if (!session?.user?.email) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await context.params;
  await ensureSchema();
  await deactivateExpiredFreeTrialsForUser(session.user.email);

  const result = await pool.query<{
    id: string;
    bot_name: string | null;
    status: string;
    host_name: string | null;
    runtime_id: string | null;
    deploy_provider: string | null;
    openai_api_key: string | null;
    anthropic_api_key: string | null;
    openrouter_api_key: string | null;
    telegram_bot_token: string | null;
    plan_tier: string | null;
    deployment_flavor: string | null;
    trial_started_at: string | null;
    trial_expires_at: string | null;
    deactivated_at: string | null;
    deactivation_reason: string | null;
    monthly_price_cents: number | null;
    ready_url: string | null;
    error: string | null;
    created_at: string;
    updated_at: string;
  }>(
    `SELECT id, bot_name, status, host_name, runtime_id, deploy_provider,
            openai_api_key, anthropic_api_key, openrouter_api_key, telegram_bot_token,
            plan_tier, deployment_flavor, trial_started_at, trial_expires_at, deactivated_at, deactivation_reason, monthly_price_cents,
            ready_url, error, created_at, updated_at
     FROM deployments
     WHERE id = $1 AND user_id = $2`,
    [id, session.user.email],
  );

  const item = result.rows[0];
  if (!item) {
    return NextResponse.json({ ok: false, error: "Not found" }, { status: 404 });
  }

  if (isStaleInProgressDeployment(item)) {
    try {
      await cleanupDeploymentRuntime({
        runtime_id: item.runtime_id,
        deploy_provider: item.deploy_provider,
        ready_url: item.ready_url,
        host_name: item.host_name,
      });
    } catch (error) {
      if (!isIgnorableRuntimeDestroyError(error)) {
        const details = error instanceof Error ? error.message : String(error);
        await pool.query(
          `INSERT INTO deployment_events (deployment_id, status, message)
           VALUES ($1, 'failed', $2)`,
          [item.id, `Stale deployment cleanup warning: ${details}`],
        );
      }
    }
    const staleMessage = "Deployment timed out while in progress. Please redeploy.";
    await pool.query(
      `UPDATE deployments
       SET status = 'failed',
           error = $1,
           updated_at = NOW()
       WHERE id = $2`,
      [staleMessage, item.id],
    );
    await pool.query(
      `INSERT INTO deployment_events (deployment_id, status, message)
       VALUES ($1, 'failed', $2)`,
      [item.id, staleMessage],
    );
    item.status = "failed";
    item.error = staleMessage;
    item.updated_at = new Date().toISOString();
  }

  const health =
    item.status === "ready" && item.ready_url
      ? await checkRuntimeHealth(item.ready_url)
      : null;

  return NextResponse.json({
    id: item.id,
    botName: item.bot_name,
    status: item.status,
    hostName: item.host_name,
    runtimeId: item.runtime_id,
    deployProvider: item.deploy_provider,
    planTier: item.plan_tier,
    deploymentFlavor: item.deployment_flavor,
    trialStartedAt: item.trial_started_at,
    trialExpiresAt: item.trial_expires_at,
    deactivatedAt: item.deactivated_at,
    deactivationReason: item.deactivation_reason,
    monthlyPriceCents: item.monthly_price_cents,
    settings: {
      hasOpenaiApiKey: Boolean(item.openai_api_key?.trim()),
      hasAnthropicApiKey: Boolean(item.anthropic_api_key?.trim()),
      hasOpenrouterApiKey: Boolean(item.openrouter_api_key?.trim()),
      hasTelegramBotToken: Boolean(item.telegram_bot_token?.trim()),
    },
    readyUrl: item.ready_url,
    error: item.error,
    createdAt: item.created_at,
    updatedAt: item.updated_at,
    health,
  });
}

export async function DELETE(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  if (!session?.user?.email) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await context.params;
  await ensureSchema();
  await deactivateExpiredFreeTrialsForUser(session.user.email);

  const result = await pool.query<{
    id: string;
    status: string;
    host_name: string | null;
    runtime_id: string | null;
    deploy_provider: string | null;
    ready_url: string | null;
    updated_at: string;
  }>(
    `SELECT id, status, host_name, runtime_id, deploy_provider, ready_url, updated_at
     FROM deployments
     WHERE id = $1 AND user_id = $2`,
    [id, session.user.email],
  );

  const deployment = result.rows[0];
  if (!deployment) {
    return NextResponse.json({ ok: false, error: "Not found" }, { status: 404 });
  }

  if (isStaleInProgressDeployment(deployment)) {
    try {
      await cleanupDeploymentRuntime({
        runtime_id: deployment.runtime_id,
        deploy_provider: deployment.deploy_provider,
        ready_url: deployment.ready_url,
        host_name: deployment.host_name,
      });
    } catch (error) {
      if (!isIgnorableRuntimeDestroyError(error)) {
        const details = error instanceof Error ? error.message : String(error);
        await pool.query(
          `INSERT INTO deployment_events (deployment_id, status, message)
           VALUES ($1, 'failed', $2)`,
          [deployment.id, `Stale deployment cleanup warning: ${details}`],
        );
      }
    }
    const staleMessage = "Deployment timed out while in progress. Please redeploy.";
    await pool.query(
      `UPDATE deployments
       SET status = 'failed',
           error = $1,
           updated_at = NOW()
       WHERE id = $2`,
      [staleMessage, deployment.id],
    );
    await pool.query(
      `INSERT INTO deployment_events (deployment_id, status, message)
       VALUES ($1, 'failed', $2)`,
      [deployment.id, staleMessage],
    );
    deployment.status = "failed";
  }

  try {
    try {
      await cleanupDeploymentRuntime({
        runtime_id: deployment.runtime_id,
        deploy_provider: deployment.deploy_provider,
        ready_url: deployment.ready_url,
        host_name: deployment.host_name,
      });
    } catch (error) {
      if (!isIgnorableRuntimeDestroyError(error)) {
        throw error;
      }
    }

    await pool.query(`DELETE FROM deployment_events WHERE deployment_id = $1`, [id]);
    await pool.query(`DELETE FROM deployments WHERE id = $1 AND user_id = $2`, [id, session.user.email]);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to delete deployment";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
