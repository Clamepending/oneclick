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

  const result = await pool.query<{
    id: string;
    status: string;
    ready_url: string | null;
    error: string | null;
  }>(
    `SELECT id, status, ready_url, error
     FROM deployments
     WHERE id = $1 AND user_id = $2`,
    [id, session.user.email],
  );

  const item = result.rows[0];
  if (!item) {
    return NextResponse.json({ ok: false, error: "Not found" }, { status: 404 });
  }

  return NextResponse.json({
    id: item.id,
    status: item.status,
    readyUrl: item.ready_url,
    error: item.error,
  });
}
