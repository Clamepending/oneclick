import { pool } from "@/lib/db";

type OttoAuthAccountRow = {
  deployment_id: string;
  bot_id: string;
  username: string;
  private_key: string;
  callback_url: string;
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

function resolvePublicBaseUrl() {
  const candidates = [
    readTrimmedEnv("APP_BASE_URL"),
    readTrimmedEnv("AUTH_URL"),
    readTrimmedEnv("VERCEL_PROJECT_PRODUCTION_URL"),
    readTrimmedEnv("VERCEL_URL"),
    "https://www.oneclickagent.net",
  ];
  for (const candidate of candidates) {
    const resolved = normalizeBaseUrl(candidate);
    if (resolved) return resolved;
  }
  return "https://www.oneclickagent.net";
}

function normalizeBotToken(input: string) {
  const normalized = input.toLowerCase().replace(/[^a-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "");
  if (normalized) return normalized.slice(0, 36);
  return "oneclick_bot";
}

function buildOttoAuthUsername(input: {
  deploymentId: string;
  botName?: string | null;
  botId: string;
}) {
  const base = normalizeBotToken(input.botName?.trim() || input.botId);
  const suffix = input.deploymentId.replace(/[^a-z0-9]/gi, "").toLowerCase().slice(0, 10) || "deploy";
  return `${base}_${suffix}`.slice(0, 48);
}

export function resolveServerlessBotId(input: {
  deploymentId: string;
  runtimeBotId?: string | null;
}) {
  const explicit = (input.runtimeBotId ?? "").trim();
  if (explicit) return explicit.slice(0, 120);
  return `lambda:${input.deploymentId}`.slice(0, 120);
}

function buildOttoAuthCallbackUrl(deploymentId: string) {
  const base = resolvePublicBaseUrl();
  return `${base}/api/runtime/${encodeURIComponent(deploymentId)}/hooks/ottoauth`;
}

async function callOttoAuthCreateAccount(input: {
  username: string;
  callbackUrl: string;
}) {
  const response = await fetch("https://ottoauth.vercel.app/api/agents/create", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      username: input.username,
      callback_url: input.callbackUrl,
    }),
    signal: AbortSignal.timeout(20_000),
  });
  const body = (await response.json().catch(() => null)) as
    | {
        username?: unknown;
        privateKey?: unknown;
        callbackUrl?: unknown;
        error?: unknown;
        message?: unknown;
      }
    | null;
  if (!response.ok) {
    const reason =
      String(body?.error ?? "").trim() ||
      String(body?.message ?? "").trim() ||
      `OttoAuth account creation failed (${response.status})`;
    throw new Error(reason);
  }

  const username = String(body?.username ?? "").trim();
  const privateKey = String(body?.privateKey ?? "").trim();
  const callbackUrl = String(body?.callbackUrl ?? input.callbackUrl).trim();
  if (!username || !privateKey) {
    throw new Error("OttoAuth account creation returned an invalid payload.");
  }
  return {
    username,
    privateKey,
    callbackUrl,
  };
}

async function findOttoAuthAccount(input: { deploymentId: string; botId: string }) {
  const existing = await pool.query<OttoAuthAccountRow>(
    `SELECT deployment_id, bot_id, username, private_key, callback_url
     FROM runtime_ottoauth_accounts
     WHERE deployment_id = $1
       AND bot_id = $2
     LIMIT 1`,
    [input.deploymentId, input.botId],
  );
  const row = existing.rows[0];
  if (!row) return null;
  return {
    deploymentId: row.deployment_id,
    botId: row.bot_id,
    username: row.username,
    privateKey: row.private_key,
    callbackUrl: row.callback_url,
  };
}

export async function ensureOttoAuthAccountForBot(input: {
  deploymentId: string;
  botId: string;
  botName?: string | null;
}) {
  const existing = await findOttoAuthAccount({ deploymentId: input.deploymentId, botId: input.botId });
  if (existing) return existing;

  const callbackUrl = buildOttoAuthCallbackUrl(input.deploymentId);
  const username = buildOttoAuthUsername({
    deploymentId: input.deploymentId,
    botName: input.botName,
    botId: input.botId,
  });
  const created = await callOttoAuthCreateAccount({
    username,
    callbackUrl,
  });

  await pool.query(
    `INSERT INTO runtime_ottoauth_accounts (deployment_id, bot_id, username, private_key, callback_url, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, NOW(), NOW())
     ON CONFLICT (deployment_id, bot_id)
     DO UPDATE
       SET username = EXCLUDED.username,
           private_key = EXCLUDED.private_key,
           callback_url = EXCLUDED.callback_url,
           updated_at = NOW()`,
    [input.deploymentId, input.botId, created.username, created.privateKey, created.callbackUrl],
  );

  return {
    deploymentId: input.deploymentId,
    botId: input.botId,
    username: created.username,
    privateKey: created.privateKey,
    callbackUrl: created.callbackUrl,
  };
}
