import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { ensureSchema, pool } from "@/lib/db";
import { estimateServerlessContextUsage } from "@/lib/runtime/serverlessChatEngine";
import { getRuntimeSessionById, requireOwnedServerlessDeployment } from "../../shared";

const payloadSchema = z.object({
  sessionId: z.string().trim().min(1).max(120),
  draftMessage: z.string().max(8000).optional(),
  model: z.string().trim().max(120).optional(),
});

type DeploymentModelRow = {
  default_model: string | null;
};

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  const userId = session?.user?.email?.trim();
  if (!userId) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  const parsedBody = payloadSchema.safeParse(await request.json().catch(() => null));
  if (!parsedBody.success) {
    return NextResponse.json({ ok: false, error: "Invalid payload" }, { status: 400 });
  }

  const { id } = await context.params;
  await ensureSchema();

  const access = await requireOwnedServerlessDeployment({ deploymentId: id, userId });
  if (!access.ok) {
    return NextResponse.json({ ok: false, error: access.error }, { status: access.status });
  }

  const runtimeSession = await getRuntimeSessionById({
    deploymentId: id,
    sessionId: parsedBody.data.sessionId,
  });
  if (!runtimeSession) {
    return NextResponse.json({ ok: false, error: "Session not found" }, { status: 404 });
  }

  const deployment = await pool.query<DeploymentModelRow>(
    `SELECT default_model
     FROM deployments
     WHERE id = $1
       AND user_id = $2
     LIMIT 1`,
    [id, userId],
  );
  const selectedModel =
    parsedBody.data.model?.trim() ||
    deployment.rows[0]?.default_model?.trim() ||
    "gpt-4o-mini";

  try {
    const usage = await estimateServerlessContextUsage({
      deploymentId: id,
      sessionId: runtimeSession.id,
      selectedModel,
      draftMessage: parsedBody.data.draftMessage ?? "",
    });
    return NextResponse.json({
      ok: true,
      sessionId: runtimeSession.id,
      ...usage,
    });
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "Failed to calculate context usage.";
    return NextResponse.json({ ok: false, error: message }, { status: 502 });
  }
}
