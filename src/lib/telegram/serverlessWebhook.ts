import crypto from "crypto";

type TelegramApiResult<T> = {
  ok: boolean;
  result?: T;
  description?: string;
};

function readTrimmedEnv(name: string) {
  const raw = process.env[name];
  if (!raw) return "";
  return raw.trim().replace(/^"(.*)"$/, "$1").replace(/\\n/g, "").trim();
}

function normalizeBaseUrl(raw: string) {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  const withProtocol = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const parsed = new URL(withProtocol);
    parsed.pathname = "/";
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString().replace(/\/$/, "");
  } catch {
    return "";
  }
}

function resolvePublicBaseUrl(baseUrlOverride?: string | null) {
  const candidates = [
    baseUrlOverride ?? "",
    readTrimmedEnv("APP_BASE_URL"),
    readTrimmedEnv("AUTH_URL"),
    readTrimmedEnv("VERCEL_PROJECT_PRODUCTION_URL"),
    readTrimmedEnv("VERCEL_URL"),
  ];
  for (const candidate of candidates) {
    const resolved = normalizeBaseUrl(candidate);
    if (resolved) return resolved;
  }
  return "";
}

export function buildServerlessTelegramWebhookUrl(input: {
  deploymentId: string;
  baseUrlOverride?: string | null;
}) {
  const base = resolvePublicBaseUrl(input.baseUrlOverride);
  if (!base) return "";
  return `${base}/api/runtime/${encodeURIComponent(input.deploymentId)}/telegram/webhook`;
}

export function buildServerlessTelegramSecret(input: {
  deploymentId: string;
  botToken: string;
}) {
  return crypto
    .createHash("sha256")
    .update(`${input.deploymentId}:${input.botToken}`)
    .digest("hex")
    .slice(0, 64);
}

export function verifyServerlessTelegramSecret(input: {
  deploymentId: string;
  botToken: string;
  receivedSecret: string | null | undefined;
}) {
  const expected = buildServerlessTelegramSecret({
    deploymentId: input.deploymentId,
    botToken: input.botToken,
  });
  const received = String(input.receivedSecret ?? "").trim();
  if (!received || !expected) return false;
  if (received.length !== expected.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(received), Buffer.from(expected));
  } catch {
    return false;
  }
}

async function telegramApiPost<T>(input: {
  botToken: string;
  method: string;
  body: Record<string, unknown>;
}) {
  const response = await fetch(`https://api.telegram.org/bot${input.botToken}/${input.method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input.body),
    signal: AbortSignal.timeout(15_000),
  });
  const parsed = (await response.json().catch(() => null)) as TelegramApiResult<T> | null;
  if (!response.ok || !parsed?.ok) {
    const message = parsed?.description || `Telegram ${input.method} failed (${response.status})`;
    throw new Error(message);
  }
  return parsed.result as T;
}

export async function setServerlessTelegramWebhook(input: {
  deploymentId: string;
  botToken: string;
  baseUrlOverride?: string | null;
}) {
  const url = buildServerlessTelegramWebhookUrl({
    deploymentId: input.deploymentId,
    baseUrlOverride: input.baseUrlOverride,
  });
  if (!url) {
    return {
      ok: false as const,
      reason: "missing_public_base_url",
    };
  }
  const secretToken = buildServerlessTelegramSecret({
    deploymentId: input.deploymentId,
    botToken: input.botToken,
  });
  await telegramApiPost({
    botToken: input.botToken,
    method: "setWebhook",
    body: {
      url,
      secret_token: secretToken,
      allowed_updates: ["message"],
      drop_pending_updates: false,
    },
  });
  return {
    ok: true as const,
    webhookUrl: url,
    secretToken,
  };
}

export async function sendTelegramTextMessage(input: {
  botToken: string;
  chatId: number;
  text: string;
  replyToMessageId?: number | null;
}) {
  return await telegramApiPost({
    botToken: input.botToken,
    method: "sendMessage",
    body: {
      chat_id: input.chatId,
      text: input.text,
      ...(input.replyToMessageId ? { reply_to_message_id: input.replyToMessageId } : {}),
    },
  });
}
