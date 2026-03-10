import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { ensureSchema, pool } from "@/lib/db";
import { createRuntimeEventLog } from "@/lib/runtime/runtimeEventLog";
import { ensureRuntimeSession } from "../shared";
import { runRuntimeTurn, RuntimeRouterError } from "@/lib/runtime/runtimeRouter";
import { resolveRuntimeMetadataFromRow } from "@/lib/runtime/runtimeMetadata";

const payloadSchema = z.object({
  message: z.string().trim().min(1).max(8000),
  sessionId: z.string().trim().min(1).max(120).optional(),
  turnId: z.string().trim().min(1).max(120).optional(),
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
  deployment_flavor: string | null;
  runtime_kind: string | null;
  runtime_version: string | null;
  runtime_contract_version: string | null;
  runtime_release_channel: string | null;
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
            subsidy_proxy_token,
            deployment_flavor,
            runtime_kind,
            runtime_version,
            runtime_contract_version,
            runtime_release_channel
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

  const runtimeMetadata = resolveRuntimeMetadataFromRow({
    deployment_flavor: row.deployment_flavor,
    runtime_kind: row.runtime_kind,
    runtime_version: row.runtime_version,
    runtime_contract_version: row.runtime_contract_version,
    runtime_release_channel: row.runtime_release_channel,
  });

  const sessionResolution = await ensureRuntimeSession({
    deploymentId: id,
    preferredSessionId: parsedBody.data.sessionId,
  });
  if (!sessionResolution.found || !sessionResolution.session) {
    return NextResponse.json({ ok: false, error: "Session not found" }, { status: 404 });
  }
  const turnId =
    parsedBody.data.turnId?.trim() ||
    `turn_${Date.now()}_${sessionResolution.session.id}`;

  try {
    const result = await runRuntimeTurn({
      deploymentId: id,
      sessionId: sessionResolution.session.id,
      userMessage: parsedBody.data.message,
      requestOrigin: new URL(request.url).origin,
      runtimeMetadata,
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
      onToolTrace: async (entry) => {
        try {
          await createRuntimeEventLog({
            deploymentId: id,
            source: "runtime_chat",
            eventType: "tool_call_progress",
            status: "processed",
            sessionId: sessionResolution.session.id,
            payload: {
              sessionId: sessionResolution.session.id,
              turnId,
              toolTrace: [entry],
            },
          });
        } catch {}
      },
    });
    await createRuntimeEventLog({
      deploymentId: id,
      source: "runtime_chat",
      eventType: "chat_message",
      status: "processed",
      sessionId: sessionResolution.session.id,
      payload: {
        sessionId: sessionResolution.session.id,
        turnId,
        message: parsedBody.data.message,
      },
      result: {
        userMessageId: result.userMessage.id,
        assistantMessageId: result.assistantMessage.id,
      },
    });
    return NextResponse.json({ ok: true, turnId, ...result });
  } catch (error) {
    const message =
      error instanceof RuntimeRouterError
        ? error.message
        : error instanceof Error
          ? error.message
          : "Model call failed.";
    await createRuntimeEventLog({
      deploymentId: id,
      source: "runtime_chat",
      eventType: "chat_message",
      status: "failed",
      sessionId: sessionResolution.session.id,
      error: message,
      payload: {
        sessionId: sessionResolution.session.id,
        turnId,
        message: parsedBody.data.message,
      },
    });
    if (error instanceof RuntimeRouterError) {
      return NextResponse.json(
        { ok: false, error: error.message, code: error.code },
        { status: error.statusCode },
      );
    }
    return NextResponse.json({ ok: false, error: message }, { status: 502 });
  }
}
