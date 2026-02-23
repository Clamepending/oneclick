import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { ensureSchema, pool } from "@/lib/db";

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

  const ownsDeployment = await pool.query<{ id: string }>(
    `SELECT id FROM deployments WHERE id = $1 AND user_id = $2`,
    [id, session.user.email],
  );
  if (!ownsDeployment.rows[0]) {
    return NextResponse.json({ ok: false, error: "Not found" }, { status: 404 });
  }

  const events = await pool.query<{
    status: string;
    message: string;
    created_at: string;
  }>(
    `SELECT status, message, created_at
     FROM deployment_events
     WHERE deployment_id = $1
     ORDER BY created_at ASC`,
    [id],
  );

  return NextResponse.json({
    items: events.rows.map((event) => ({
      status: event.status,
      message: event.message,
      ts: event.created_at,
    })),
  });
}
