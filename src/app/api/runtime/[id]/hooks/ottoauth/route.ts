import { NextResponse } from "next/server";
import { ensureSchema, pool } from "@/lib/db";
import { ensureRuntimeSessionById, touchRuntimeSession } from "../../shared";

type DeploymentRow = {
  id: string;
  deploy_provider: string | null;
};

type OttoAuthHookPayload = {
  source?: unknown;
  message?: unknown;
  event_id?: unknown;
  type?: unknown;
  data?: unknown;
};

function safeText(value: unknown) {
  return String(value ?? "").trim();
}

function formatPayload(payload: OttoAuthHookPayload) {
  const source = safeText(payload.source) || "ottoauth";
  const message = safeText(payload.message) || safeText(payload.type) || "OttoAuth callback received.";
  const dataText = (() => {
    if (payload.data === undefined) return "";
    try {
      return JSON.stringify(payload.data);
    } catch {
      return safeText(payload.data);
    }
  })();
  return `Outward inbox notification from ${source}: ${message}${dataText ? `\n\n${dataText}` : ""}`;
}

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  await ensureSchema();

  const deployment = await pool.query<DeploymentRow>(
    `SELECT id, deploy_provider
     FROM deployments
     WHERE id = $1
     LIMIT 1`,
    [id],
  );
  const row = deployment.rows[0];
  if (!row) {
    return NextResponse.json({ ok: true, ignored: "deployment_not_found" });
  }
  if ((row.deploy_provider ?? "").trim().toLowerCase() !== "lambda") {
    return NextResponse.json({ ok: true, ignored: "not_serverless" });
  }

  const payload = (await request.json().catch(() => null)) as OttoAuthHookPayload | null;
  const eventId = safeText(payload?.event_id);
  const sessionId = eventId ? `hook:outward:ottoauth:${eventId}` : `hook:outward:ottoauth:${Date.now().toString(36)}`;
  const session = await ensureRuntimeSessionById({
    deploymentId: id,
    sessionId,
    name: "OttoAuth Hook",
  });
  if (!session) {
    return NextResponse.json({ ok: false, error: "Failed to create callback session." }, { status: 500 });
  }

  const content = formatPayload(payload ?? {});
  const inserted = await pool.query<{ id: number }>(
    `INSERT INTO runtime_chat_messages (deployment_id, session_id, role, content)
     VALUES ($1, $2, 'assistant', $3)
     RETURNING id`,
    [id, session.id, content],
  );
  await touchRuntimeSession({
    deploymentId: id,
    sessionId: session.id,
  });

  return NextResponse.json({
    ok: true,
    sessionId: session.id,
    messageId: inserted.rows[0]?.id ?? null,
  });
}
