import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { ensureSchema, pool } from "@/lib/db";

async function checkRuntimeHealth(readyUrl: string) {
  try {
    const healthPath = process.env.OPENCLAW_HEALTH_PATH ?? "/health";
    const url = new URL(healthPath, readyUrl);
    const response = await fetch(url.toString(), {
      cache: "no-store",
      signal: AbortSignal.timeout(3000),
    });
    return {
      ok: response.ok,
      status: response.status,
    };
  } catch {
    return {
      ok: false,
      status: null,
    };
  }
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

  const result = await pool.query<{
    id: string;
    status: string;
    host_name: string | null;
    runtime_id: string | null;
    deploy_provider: string | null;
    ready_url: string | null;
    error: string | null;
    created_at: string;
    updated_at: string;
  }>(
    `SELECT id, status, host_name, runtime_id, deploy_provider, ready_url, error, created_at, updated_at
     FROM deployments
     WHERE id = $1 AND user_id = $2`,
    [id, session.user.email],
  );

  const item = result.rows[0];
  if (!item) {
    return NextResponse.json({ ok: false, error: "Not found" }, { status: 404 });
  }

  const health =
    item.status === "ready" && item.ready_url
      ? await checkRuntimeHealth(item.ready_url)
      : null;

  return NextResponse.json({
    id: item.id,
    status: item.status,
    hostName: item.host_name,
    runtimeId: item.runtime_id,
    deployProvider: item.deploy_provider,
    readyUrl: item.ready_url,
    error: item.error,
    createdAt: item.created_at,
    updatedAt: item.updated_at,
    health,
  });
}
