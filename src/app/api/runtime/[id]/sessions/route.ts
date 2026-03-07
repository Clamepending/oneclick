import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { ensureSchema } from "@/lib/db";
import {
  createRuntimeSession,
  ensureRuntimeSession,
  listRuntimeSessions,
  requireOwnedServerlessDeployment,
} from "../shared";

const createSessionSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
});

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

  // Always provide at least one session in the UI.
  const ensured = await ensureRuntimeSession({ deploymentId: id });
  if (!ensured.found || !ensured.session) {
    return NextResponse.json({ ok: false, error: "Failed to resolve session" }, { status: 500 });
  }

  const sessions = await listRuntimeSessions(id);
  const activeSessionId = sessions[0]?.id ?? ensured.session.id;

  return NextResponse.json({
    ok: true,
    activeSessionId,
    sessions,
  });
}

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  const userId = session?.user?.email?.trim();
  if (!userId) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  const parsed = createSessionSchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ ok: false, error: "Invalid session payload" }, { status: 400 });
  }

  const { id } = await context.params;
  await ensureSchema();

  const access = await requireOwnedServerlessDeployment({ deploymentId: id, userId });
  if (!access.ok) {
    return NextResponse.json({ ok: false, error: access.error }, { status: access.status });
  }

  const created = await createRuntimeSession({
    deploymentId: id,
    name: parsed.data.name,
  });

  return NextResponse.json({
    ok: true,
    session: {
      id: created.id,
      name: created.name,
      createdAt: created.created_at,
      updatedAt: created.updated_at,
      messageCount: 0,
      lastMessageAt: null,
    },
  });
}
