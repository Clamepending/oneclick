import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { ensureSchema, pool } from "@/lib/db";
import { applyMemoryRateLimit } from "@/lib/security/rateLimit";
import {
  enqueueDeploymentJob,
  markDeploymentFailed,
  newDeploymentId,
  processDeploymentJob,
} from "@/workers/deployWorker";

function getClientIp(request: Request) {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0].trim();
  return "unknown";
}

export async function POST(request: Request) {
  const session = await auth();
  if (!session?.user?.email) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  const ip = getClientIp(request);
  const ipLimit = applyMemoryRateLimit(
    `deploy:ip:${ip}`,
    Number(process.env.DEPLOY_RATE_LIMIT_PER_MIN ?? "5"),
    60_000,
  );
  if (!ipLimit.allowed) {
    return NextResponse.json({ ok: false, error: "Too many requests" }, { status: 429 });
  }

  await ensureSchema();
  const active = await pool.query<{ count: string }>(
    `SELECT COUNT(*)::text as count
     FROM deployments
     WHERE user_id = $1 AND status IN ('queued', 'starting')`,
    [session.user.email],
  );

  const maxActive = Number(process.env.DEPLOY_MAX_ACTIVE_PER_USER ?? "1");
  if (Number(active.rows[0]?.count ?? "0") >= maxActive) {
    return NextResponse.json(
      { ok: false, error: "You already have an active deployment in progress." },
      { status: 409 },
    );
  }

  const deploymentId = newDeploymentId();
  await pool.query(
    `INSERT INTO deployments (id, user_id, status)
     VALUES ($1, $2, 'queued')`,
    [deploymentId, session.user.email],
  );

  await pool.query(
    `INSERT INTO deployment_events (deployment_id, status, message)
     VALUES ($1, 'queued', 'Deployment accepted and queued')`,
    [deploymentId],
  );

  try {
    // Vercel-safe default: if REDIS_URL is absent, process in-process.
    // This keeps one-click flow functional without a separate always-on worker.
    if (!process.env.REDIS_URL) {
      await processDeploymentJob({ deploymentId, userId: session.user.email });
      return NextResponse.json({ id: deploymentId, status: "ready" }, { status: 200 });
    }

    await enqueueDeploymentJob({ deploymentId, userId: session.user.email });
  } catch (error) {
    const message = await markDeploymentFailed(deploymentId, error);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }

  return NextResponse.json({ id: deploymentId, status: "queued" }, { status: 202 });
}
