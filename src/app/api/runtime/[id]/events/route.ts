import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { ensureSchema } from "@/lib/db";
import { listRuntimeEventLogs } from "@/lib/runtime/runtimeEventLog";
import { requireOwnedServerlessDeployment } from "../shared";

function parseLimit(raw: string | null) {
  if (!raw) return 80;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return 80;
  return Math.max(1, Math.min(200, Math.trunc(parsed)));
}

export async function GET(
  request: Request,
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

  const limit = parseLimit(new URL(request.url).searchParams.get("limit"));
  const rows = await listRuntimeEventLogs({
    deploymentId: id,
    limit,
  });

  return NextResponse.json({
    ok: true,
    items: rows.map((row) => ({
      id: row.id,
      source: row.source,
      eventType: row.event_type,
      status: row.status,
      sessionId: row.session_id,
      error: row.error,
      payload: row.payload ?? {},
      result: row.result ?? null,
      replayOfEventId: row.replay_of_event_id,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      replayable:
        row.source === "telegram_webhook" &&
        (row.status === "failed" || row.status === "replay_failed"),
    })),
  });
}

