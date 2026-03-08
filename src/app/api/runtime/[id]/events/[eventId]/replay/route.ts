import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { ensureSchema, pool } from "@/lib/db";
import {
  createRuntimeEventLog,
  getRuntimeEventLogById,
} from "@/lib/runtime/runtimeEventLog";
import { executeServerlessTelegramTurn } from "@/lib/runtime/serverlessTelegramHandler";
import { resolveRuntimeMetadataFromRow } from "@/lib/runtime/runtimeMetadata";
import { requireOwnedServerlessDeployment } from "../../../shared";

type DeploymentRow = {
  id: string;
  bot_name: string | null;
  status: string;
  deploy_provider: string | null;
  telegram_bot_token: string | null;
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

function parseEventId(raw: string) {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 1) return null;
  return Math.trunc(parsed);
}

function parseChatId(raw: unknown) {
  if (typeof raw === "number" && Number.isFinite(raw)) return Math.trunc(raw);
  if (typeof raw === "string" && raw.trim()) {
    const parsed = Number(raw.trim());
    if (Number.isFinite(parsed)) return Math.trunc(parsed);
  }
  return null;
}

function parseMessageId(raw: unknown) {
  if (typeof raw === "number" && Number.isFinite(raw)) return Math.trunc(raw);
  if (typeof raw === "string" && raw.trim()) {
    const parsed = Number(raw.trim());
    if (Number.isFinite(parsed)) return Math.trunc(parsed);
  }
  return null;
}

function readPayloadObject(raw: unknown) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  return raw as Record<string, unknown>;
}

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string; eventId: string }> },
) {
  const session = await auth();
  const userId = session?.user?.email?.trim();
  if (!userId) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  const { id, eventId: rawEventId } = await context.params;
  const eventId = parseEventId(rawEventId);
  if (!eventId) {
    return NextResponse.json({ ok: false, error: "Invalid event id." }, { status: 400 });
  }

  await ensureSchema();
  const access = await requireOwnedServerlessDeployment({ deploymentId: id, userId });
  if (!access.ok) {
    return NextResponse.json({ ok: false, error: access.error }, { status: access.status });
  }

  const original = await getRuntimeEventLogById({
    deploymentId: id,
    eventId,
  });
  if (!original) {
    return NextResponse.json({ ok: false, error: "Event not found." }, { status: 404 });
  }
  if (
    original.source !== "telegram_webhook" ||
    (original.status !== "failed" && original.status !== "replay_failed")
  ) {
    return NextResponse.json(
      { ok: false, error: "Only failed Telegram webhook events can be replayed." },
      { status: 409 },
    );
  }

  const payload = readPayloadObject(original.payload);
  const chatId = parseChatId(payload.chatId);
  const userText = String(payload.text ?? "").trim();
  const messageId = parseMessageId(payload.messageId);
  if (chatId === null || !userText) {
    return NextResponse.json(
      { ok: false, error: "Replay payload is incomplete (chat/text missing)." },
      { status: 409 },
    );
  }

  const deployment = await pool.query<DeploymentRow>(
    `SELECT id,
            bot_name,
            status,
            deploy_provider,
            telegram_bot_token,
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
     LIMIT 1`,
    [id],
  );
  const row = deployment.rows[0];
  if (!row) {
    return NextResponse.json({ ok: false, error: "Deployment not found." }, { status: 404 });
  }
  if ((row.deploy_provider ?? "").trim().toLowerCase() !== "lambda") {
    return NextResponse.json({ ok: false, error: "Runtime is not serverless." }, { status: 409 });
  }
  if ((row.status ?? "").trim().toLowerCase() !== "ready") {
    return NextResponse.json({ ok: false, error: "Deployment is not ready." }, { status: 409 });
  }
  const botToken = row.telegram_bot_token?.trim() || "";
  if (!botToken) {
    return NextResponse.json({ ok: false, error: "Telegram token is not configured." }, { status: 409 });
  }

  const runtimeMetadata = resolveRuntimeMetadataFromRow({
    deployment_flavor: row.deployment_flavor,
    runtime_kind: row.runtime_kind,
    runtime_version: row.runtime_version,
    runtime_contract_version: row.runtime_contract_version,
    runtime_release_channel: row.runtime_release_channel,
  });

  const replayResult = await executeServerlessTelegramTurn({
    deploymentId: id,
    botToken,
    chatId,
    messageId,
    userText,
    runtimeMetadata,
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

  const replayLog = await createRuntimeEventLog({
    deploymentId: id,
    source: "runtime_replay",
    eventType: "telegram_message_replay",
    status: replayResult.processed ? "processed" : "replay_failed",
    sessionId: replayResult.sessionId,
    error: replayResult.error,
    payload: {
      replayOfEventId: original.id,
      chatId,
      messageId,
      text: userText,
    },
    result: {
      processed: replayResult.processed,
      userMessageId: replayResult.userMessageId,
      assistantMessageId: replayResult.assistantMessageId,
    },
    replayOfEventId: original.id,
  });

  return NextResponse.json({
    ok: replayResult.processed,
    replayed: replayResult.processed,
    eventId: replayLog?.id ?? null,
    originalEventId: original.id,
    sessionId: replayResult.sessionId,
    error: replayResult.error,
    userMessageId: replayResult.userMessageId,
    assistantMessageId: replayResult.assistantMessageId,
  });
}

