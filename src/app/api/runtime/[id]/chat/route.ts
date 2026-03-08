import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { ensureSchema, pool } from "@/lib/db";
import { runServerlessChatTurn } from "@/lib/runtime/serverlessChatEngine";
import { ensureRuntimeSession } from "../shared";

const payloadSchema = z.object({
  message: z.string().trim().min(1).max(8000),
  sessionId: z.string().trim().min(1).max(120).optional(),
});

type DeploymentRow = {
  id: string;
  bot_name: string | null;
  status: string;
  deploy_provider: string | null;
  runtime_bot_id: string | null;
  model_provider: string | null;
  default_model: string | null;
  openai_api_key: string | null;
  anthropic_api_key: string | null;
  openrouter_api_key: string | null;
  subsidy_proxy_token: string | null;
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

  const deployment = await pool.query<DeploymentRow>(
    `SELECT id,
            bot_name,
            status,
            deploy_provider,
            runtime_bot_id,
            model_provider,
            default_model,
            openai_api_key,
            anthropic_api_key,
            openrouter_api_key,
            subsidy_proxy_token
     FROM deployments
     WHERE id = $1
       AND user_id = $2
     LIMIT 1`,
    [id, userId],
  );
  const row = deployment.rows[0];
  if (!row) {
    return NextResponse.json({ ok: false, error: "Deployment not found" }, { status: 404 });
  }
  if ((row.deploy_provider ?? "").trim().toLowerCase() !== "lambda") {
    return NextResponse.json({ ok: false, error: "Runtime is not serverless." }, { status: 400 });
  }
  if ((row.status ?? "").trim().toLowerCase() !== "ready") {
    return NextResponse.json({ ok: false, error: "Deployment is not ready yet." }, { status: 409 });
  }

  const sessionResolution = await ensureRuntimeSession({
    deploymentId: id,
    preferredSessionId: parsedBody.data.sessionId,
  });
  if (!sessionResolution.found || !sessionResolution.session) {
    return NextResponse.json({ ok: false, error: "Session not found" }, { status: 404 });
  }

  try {
    const result = await runServerlessChatTurn({
      deploymentId: id,
      sessionId: sessionResolution.session.id,
      userMessage: parsedBody.data.message,
      requestOrigin: new URL(request.url).origin,
      modelConfig: {
        bot_name: row.bot_name,
        runtime_bot_id: row.runtime_bot_id,
        model_provider: row.model_provider,
        default_model: row.default_model,
        openai_api_key: row.openai_api_key,
        anthropic_api_key: row.anthropic_api_key,
        openrouter_api_key: row.openrouter_api_key,
        subsidy_proxy_token: row.subsidy_proxy_token,
      },
    });
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Model call failed.";
    return NextResponse.json({ ok: false, error: message }, { status: 502 });
  }
}
