import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { ensureSchema, pool } from "@/lib/db";
import {
  ensureRuntimeSession,
  ensureSessionHasStarterMessage,
  requireOwnedServerlessDeployment,
  touchRuntimeSession,
} from "../shared";

type MessageRow = {
  id: number;
  role: string;
  content: string;
  created_at: string;
};

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

  const requestedSessionId = new URL(request.url).searchParams.get("sessionId");
  const resolved = await ensureRuntimeSession({
    deploymentId: id,
    preferredSessionId: requestedSessionId,
  });
  if (!resolved.found || !resolved.session) {
    return NextResponse.json({ ok: false, error: "Session not found" }, { status: 404 });
  }
  const sessionId = resolved.session.id;
  await ensureSessionHasStarterMessage({ deploymentId: id, sessionId });

  const messages = await pool.query<MessageRow>(
    `SELECT id, role, content, created_at
     FROM runtime_chat_messages
     WHERE deployment_id = $1
       AND session_id = $2
     ORDER BY id ASC
     LIMIT 300`,
    [id, sessionId],
  );

  return NextResponse.json({
    ok: true,
    sessionId,
    messages: messages.rows
      .filter((item) => item.role === "user" || item.role === "assistant")
      .map((item) => ({
        id: item.id,
        role: item.role,
        content: item.content,
        createdAt: item.created_at,
      })),
  });
}

export async function DELETE(
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

  const requestedSessionId = new URL(request.url).searchParams.get("sessionId");
  const resolved = await ensureRuntimeSession({
    deploymentId: id,
    preferredSessionId: requestedSessionId,
  });
  if (!resolved.found || !resolved.session) {
    return NextResponse.json({ ok: false, error: "Session not found" }, { status: 404 });
  }
  const sessionId = resolved.session.id;

  const deleted = await pool.query<{ id: number }>(
    `DELETE FROM runtime_chat_messages
     WHERE deployment_id = $1
       AND session_id = $2
     RETURNING id`,
    [id, sessionId],
  );
  await touchRuntimeSession({ deploymentId: id, sessionId });

  return NextResponse.json({
    ok: true,
    sessionId,
    deletedCount: deleted.rowCount ?? 0,
  });
}
