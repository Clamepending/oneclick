import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { ensureSchema, pool } from "@/lib/db";
import { probeRuntimeHttp } from "@/lib/runtimeHealth";
import { requireOwnedServerlessDeployment } from "../shared";

type DeploymentRow = {
  status: string;
  deploy_provider: string | null;
  runtime_id: string | null;
  ready_url: string | null;
  updated_at: string;
  telegram_bot_token: string | null;
};

type RuntimeEventCountsRow = {
  total_24h: string;
  failed_24h: string;
  latest_event_at: string | null;
};

type FailedRuntimeEventRow = {
  id: number;
  status: string;
  source: string;
  error: string | null;
  created_at: string;
};

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  const userId = session?.user?.email?.trim();
  if (!userId) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await context.params;
  await ensureSchema();

  const access = await requireOwnedServerlessDeployment({ deploymentId: id, userId });
  if (!access.ok) {
    return NextResponse.json({ ok: false, error: access.error }, { status: access.status });
  }

  const deployment = await pool.query<DeploymentRow>(
    `SELECT status,
            deploy_provider,
            runtime_id,
            ready_url,
            updated_at,
            telegram_bot_token
     FROM deployments
     WHERE id = $1
     LIMIT 1`,
    [id],
  );
  const row = deployment.rows[0];
  if (!row) {
    return NextResponse.json({ ok: false, error: "Deployment not found." }, { status: 404 });
  }

  const dbProbe = await pool.query<{ ok: number }>("SELECT 1 AS ok");
  const dbOk = Number(dbProbe.rows[0]?.ok ?? 0) === 1;

  const readyUrl = row.ready_url?.trim() || "";
  const runtimeProbe =
    readyUrl && (row.status ?? "").trim().toLowerCase() === "ready"
      ? await probeRuntimeHttp(readyUrl, 3000)
      : null;

  const counts = await pool.query<RuntimeEventCountsRow>(
    `SELECT COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '24 hours')::text AS total_24h,
            COUNT(*) FILTER (
              WHERE created_at >= NOW() - INTERVAL '24 hours'
                AND status IN ('failed', 'replay_failed')
            )::text AS failed_24h,
            MAX(created_at)::text AS latest_event_at
     FROM runtime_event_logs
     WHERE deployment_id = $1`,
    [id],
  );

  const lastFailed = await pool.query<FailedRuntimeEventRow>(
    `SELECT id, status, source, error, created_at
     FROM runtime_event_logs
     WHERE deployment_id = $1
       AND status IN ('failed', 'replay_failed')
     ORDER BY id DESC
     LIMIT 1`,
    [id],
  );

  const stats = counts.rows[0];
  const failedEvent = lastFailed.rows[0] ?? null;

  return NextResponse.json({
    ok: true,
    deploymentId: id,
    status: row.status,
    provider: row.deploy_provider,
    runtimeId: row.runtime_id,
    readyUrl: row.ready_url,
    updatedAt: row.updated_at,
    db: {
      ok: dbOk,
    },
    runtime: {
      probe:
        runtimeProbe === null
          ? null
          : {
              ok: runtimeProbe.ok,
              status: runtimeProbe.status,
            },
    },
    telegram: {
      configured: Boolean(row.telegram_bot_token?.trim()),
    },
    events: {
      total24h: Number(stats?.total_24h ?? "0"),
      failed24h: Number(stats?.failed_24h ?? "0"),
      latestEventAt: stats?.latest_event_at ?? null,
      lastFailed: failedEvent
        ? {
            id: failedEvent.id,
            status: failedEvent.status,
            source: failedEvent.source,
            error: failedEvent.error,
            createdAt: failedEvent.created_at,
          }
        : null,
    },
  });
}

