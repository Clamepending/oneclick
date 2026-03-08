import { config as loadEnv } from "dotenv";

loadEnv({ path: ".env", quiet: true });
loadEnv({ path: ".env.local", override: true, quiet: true });

type DeploymentRow = {
  id: string;
  status: string;
  deploy_provider: string | null;
  telegram_bot_token: string | null;
  runtime_bot_id: string | null;
  bot_name: string | null;
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

type RuntimeEventRow = {
  id: number;
  source: string;
  event_type: string;
  status: string;
  session_id: string | null;
  error: string | null;
  payload: Record<string, unknown> | null;
  created_at: string;
};

let shutdownPool: { end: () => Promise<unknown> } | null = null;

function readTrimmedEnv(name: string) {
  const raw = process.env[name];
  if (!raw) return "";
  return raw.trim().replace(/^"(.*)"$/, "$1").trim();
}

function readBoolEnv(name: string, fallback = false) {
  const value = readTrimmedEnv(name).toLowerCase();
  if (!value) return fallback;
  if (["1", "true", "yes", "on"].includes(value)) return true;
  if (["0", "false", "no", "off"].includes(value)) return false;
  return fallback;
}

function requireEnv(name: string) {
  const value = readTrimmedEnv(name);
  if (!value) throw new Error(`Missing env: ${name}`);
  return value;
}

function parseNumberEnv(name: string, fallback: number) {
  const raw = readTrimmedEnv(name);
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.trunc(parsed);
}

function normalizeBaseUrl(value: string) {
  const withProtocol = /^https?:\/\//i.test(value) ? value : `https://${value}`;
  const parsed = new URL(withProtocol);
  parsed.pathname = "/";
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString().replace(/\/$/, "");
}

async function sleep(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForRuntimeEvent(input: {
  pool: { query: <T = unknown>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }> };
  deploymentId: string;
  source: string;
  updateId: number;
  timeoutMs: number;
}) {
  const started = Date.now();
  while (Date.now() - started <= input.timeoutMs) {
    const found = await input.pool.query<RuntimeEventRow>(
      `SELECT id, source, event_type, status, session_id, error, payload, created_at
       FROM runtime_event_logs
       WHERE deployment_id = $1
         AND source = $2
         AND event_type = 'telegram_message'
         AND payload ->> 'updateId' = $3
       ORDER BY id DESC
       LIMIT 1`,
      [input.deploymentId, input.source, String(input.updateId)],
    );
    if (found.rows[0]) return found.rows[0];
    await sleep(800);
  }
  return null;
}

async function main() {
  const { ensureSchema, pool } = await import("@/lib/db");
  shutdownPool = pool as { end: () => Promise<unknown> };
  const { buildServerlessTelegramSecret } = await import("@/lib/telegram/serverlessWebhook");
  const { resolveRuntimeMetadataFromRow } = await import("@/lib/runtime/runtimeMetadata");
  const { executeServerlessTelegramTurn } = await import("@/lib/runtime/serverlessTelegramHandler");
  const { createRuntimeEventLog } = await import("@/lib/runtime/runtimeEventLog");

  await ensureSchema();

  const deploymentId = requireEnv("ONECLICK_TELEGRAM_SMOKE_DEPLOYMENT_ID");
  const baseUrlRaw =
    readTrimmedEnv("ONECLICK_TELEGRAM_SMOKE_BASE_URL") ||
    readTrimmedEnv("APP_BASE_URL") ||
    readTrimmedEnv("AUTH_URL");
  if (!baseUrlRaw) {
    throw new Error("Missing base URL env. Set ONECLICK_TELEGRAM_SMOKE_BASE_URL or APP_BASE_URL.");
  }
  const baseUrl = normalizeBaseUrl(baseUrlRaw);
  const chatId = parseNumberEnv("ONECLICK_TELEGRAM_SMOKE_CHAT_ID", Number.NaN);
  if (!Number.isFinite(chatId)) {
    throw new Error("ONECLICK_TELEGRAM_SMOKE_CHAT_ID must be set to a numeric Telegram chat id.");
  }

  const requireProcessed = readBoolEnv("ONECLICK_TELEGRAM_SMOKE_REQUIRE_PROCESSED", false);
  const updateId = Date.now();
  const messageId = Math.trunc(Math.random() * 1_000_000) + 1;
  const smokeText = `smoke:${updateId}`;
  const sessionId = `telegram:${chatId}`;

  const deployment = await pool.query<DeploymentRow>(
    `SELECT id,
            status,
            deploy_provider,
            telegram_bot_token,
            runtime_bot_id,
            bot_name,
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
    [deploymentId],
  );
  const row = deployment.rows[0];
  if (!row) throw new Error(`Deployment not found: ${deploymentId}`);
  if ((row.deploy_provider ?? "").trim().toLowerCase() !== "lambda") {
    throw new Error(`Deployment ${deploymentId} is not serverless (deploy_provider=${row.deploy_provider ?? "unknown"}).`);
  }
  if ((row.status ?? "").trim().toLowerCase() !== "ready") {
    throw new Error(`Deployment ${deploymentId} is not ready (status=${row.status}).`);
  }
  const botToken = row.telegram_bot_token?.trim() || "";
  if (!botToken) {
    throw new Error(`Deployment ${deploymentId} has no telegram_bot_token.`);
  }

  const secret = buildServerlessTelegramSecret({
    deploymentId,
    botToken,
  });
  const webhookUrl = `${baseUrl}/api/runtime/${encodeURIComponent(deploymentId)}/telegram/webhook`;

  console.log(`Telegram webhook smoke target: ${webhookUrl}`);
  const webhookResponse = await fetch(webhookUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-telegram-bot-api-secret-token": secret,
    },
    body: JSON.stringify({
      update_id: updateId,
      message: {
        message_id: messageId,
        text: smokeText,
        from: {
          id: chatId,
          is_bot: false,
          first_name: "Smoke",
        },
        chat: {
          id: chatId,
          type: "private",
        },
      },
    }),
    signal: AbortSignal.timeout(20_000),
  });

  const webhookBody = (await webhookResponse.json().catch(() => null)) as Record<string, unknown> | null;
  if (!webhookResponse.ok) {
    throw new Error(`Webhook call failed (${webhookResponse.status}): ${JSON.stringify(webhookBody ?? {})}`);
  }
  console.log(`Webhook response: ${JSON.stringify(webhookBody ?? {})}`);

  const runtimeEvent = await waitForRuntimeEvent({
    pool,
    deploymentId,
    source: "telegram_webhook",
    updateId,
    timeoutMs: 20_000,
  });
  if (!runtimeEvent) {
    throw new Error("No runtime_event_logs row found for webhook event.");
  }
  console.log(`Webhook runtime event: id=${runtimeEvent.id} status=${runtimeEvent.status} session=${runtimeEvent.session_id ?? "n/a"}`);

  const sessionRow = await pool.query<{ id: string }>(
    `SELECT id
     FROM runtime_chat_sessions
     WHERE deployment_id = $1
       AND id = $2
     LIMIT 1`,
    [deploymentId, sessionId],
  );
  if (!sessionRow.rows[0]) {
    throw new Error(`Missing runtime_chat_sessions row for ${sessionId}.`);
  }

  const messageCount = await pool.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count
     FROM runtime_chat_messages
     WHERE deployment_id = $1
       AND session_id = $2`,
    [deploymentId, sessionId],
  );
  const count = Number(messageCount.rows[0]?.count ?? "0");
  if (count < 1) {
    throw new Error(`Expected at least one runtime_chat_message for ${sessionId}; found ${count}.`);
  }
  console.log(`Session visibility check passed (${sessionId}, messages=${count}).`);

  if (requireProcessed && runtimeEvent.status !== "processed") {
    throw new Error(`Expected processed webhook event but got status=${runtimeEvent.status} error=${runtimeEvent.error ?? "none"}`);
  }

  // Replay logic parity check: execute the same helper used by replay endpoint,
  // then persist a runtime_replay event log.
  const runtimeMetadata = resolveRuntimeMetadataFromRow({
    deployment_flavor: row.deployment_flavor,
    runtime_kind: row.runtime_kind,
    runtime_version: row.runtime_version,
    runtime_contract_version: row.runtime_contract_version,
    runtime_release_channel: row.runtime_release_channel,
  });
  const replay = await executeServerlessTelegramTurn({
    deploymentId,
    botToken,
    chatId,
    messageId,
    userText: `${smokeText}:replay`,
    runtimeMetadata,
    requestOrigin: baseUrl,
    sendTyping: false,
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
    deploymentId,
    source: "runtime_replay",
    eventType: "telegram_message_replay",
    status: replay.processed ? "processed" : "replay_failed",
    sessionId: replay.sessionId,
    error: replay.error,
    payload: {
      replayOfEventId: runtimeEvent.id,
      chatId,
      messageId,
      text: `${smokeText}:replay`,
    },
    result: {
      processed: replay.processed,
      userMessageId: replay.userMessageId,
      assistantMessageId: replay.assistantMessageId,
    },
    replayOfEventId: runtimeEvent.id,
  });

  if (!replayLog) {
    throw new Error("Replay log insert failed.");
  }
  console.log(`Replay execution: processed=${replay.processed} log_id=${replayLog.id}`);

  if (requireProcessed && !replay.processed) {
    throw new Error(`Expected replay to process successfully but failed: ${replay.error ?? "unknown"}`);
  }

  console.log("Serverless Telegram smoke passed.");
}

main()
  .catch((error) => {
    if (error instanceof Error) {
      console.error("Serverless Telegram smoke failed:", error.stack || error.message || error.name);
    } else {
      console.error("Serverless Telegram smoke failed:", String(error));
    }
    process.exitCode = 1;
  })
  .finally(async () => {
    try {
      if (shutdownPool) {
        await shutdownPool.end();
      }
    } catch {
      // Ignore pool shutdown errors.
    }
  });
