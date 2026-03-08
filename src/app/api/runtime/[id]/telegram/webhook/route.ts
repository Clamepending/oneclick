import { NextResponse } from "next/server";
import { ensureSchema, pool } from "@/lib/db";
import {
  sendTelegramTypingAction,
  sendTelegramTextMessage,
  verifyServerlessTelegramSecret,
} from "@/lib/telegram/serverlessWebhook";
import { ensureRuntimeSessionById } from "../../shared";
import { runRuntimeTurn, RuntimeRouterError } from "@/lib/runtime/runtimeRouter";
import { resolveRuntimeMetadataFromRow } from "@/lib/runtime/runtimeMetadata";

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

type TelegramUpdate = {
  update_id?: number;
  message?: {
    message_id?: number;
    text?: string;
    caption?: string;
    from?: { is_bot?: boolean };
    chat?: { id?: number | string };
  };
};

function parseTelegramChatId(raw: unknown) {
  if (typeof raw === "number" && Number.isFinite(raw)) return Math.trunc(raw);
  if (typeof raw === "string" && raw.trim()) {
    const parsed = Number(raw.trim());
    if (Number.isFinite(parsed)) return Math.trunc(parsed);
  }
  return null;
}

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  await ensureSchema();

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
    return NextResponse.json({ ok: true, ignored: "deployment_not_found" });
  }
  if ((row.deploy_provider ?? "").trim().toLowerCase() !== "lambda") {
    return NextResponse.json({ ok: true, ignored: "not_serverless" });
  }
  if ((row.status ?? "").trim().toLowerCase() !== "ready") {
    return NextResponse.json({ ok: true, ignored: "deployment_not_ready" });
  }
  const botToken = row.telegram_bot_token?.trim() || "";
  if (!botToken) {
    return NextResponse.json({ ok: true, ignored: "missing_telegram_token" });
  }

  const runtimeMetadata = resolveRuntimeMetadataFromRow({
    deployment_flavor: row.deployment_flavor,
    runtime_kind: row.runtime_kind,
    runtime_version: row.runtime_version,
    runtime_contract_version: row.runtime_contract_version,
    runtime_release_channel: row.runtime_release_channel,
  });

  const receivedSecret = request.headers.get("x-telegram-bot-api-secret-token");
  if (
    !verifyServerlessTelegramSecret({
      deploymentId: id,
      botToken,
      receivedSecret,
    })
  ) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const payload = (await request.json().catch(() => null)) as TelegramUpdate | null;
  const message = payload?.message;
  if (!message || message.from?.is_bot) {
    return NextResponse.json({ ok: true, ignored: "no_message" });
  }

  const chatId = parseTelegramChatId(message.chat?.id);
  if (chatId === null) {
    return NextResponse.json({ ok: true, ignored: "missing_chat_id" });
  }

  const userText = String(message.text ?? message.caption ?? "").trim();
  if (!userText) {
    return NextResponse.json({ ok: true, ignored: "empty_text" });
  }

  const sessionId = `telegram:${chatId}`;
  await Promise.all([
    ensureRuntimeSessionById({
      deploymentId: id,
      sessionId,
      name: `Telegram ${chatId}`,
    }),
    sendTelegramTypingAction({
      botToken,
      chatId,
    }).catch(() => null),
  ]);

  try {
    const result = await runRuntimeTurn({
      deploymentId: id,
      sessionId,
      userMessage: userText,
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
    });

    await sendTelegramTextMessage({
      botToken,
      chatId,
      text: result.assistantMessage.content,
      replyToMessageId: typeof message.message_id === "number" ? message.message_id : null,
    });

    return NextResponse.json({
      ok: true,
      processed: true,
      updateId: payload?.update_id ?? null,
      sessionId,
      userMessageId: result.userMessage.id,
      assistantMessageId: result.assistantMessage.id,
    });
  } catch (error) {
    const reason =
      error instanceof RuntimeRouterError
        ? `${error.code}: ${error.message}`
        : error instanceof Error
          ? error.message
          : "runtime_failed";
    try {
      await sendTelegramTextMessage({
        botToken,
        chatId,
        text: `OneClick runtime error: ${reason}`,
        replyToMessageId: typeof message.message_id === "number" ? message.message_id : null,
      });
    } catch {
      // Ignore secondary Telegram send failures; webhook still needs a deterministic response.
    }
    return NextResponse.json({
      ok: true,
      processed: false,
      updateId: payload?.update_id ?? null,
      sessionId,
      error: reason,
    });
  }
}
