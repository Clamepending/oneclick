import { pool } from "@/lib/db";

const AUTOFILL_MARKER = "<!-- oneclick:autofill -->";

const STARTER_CALIBRATION_MESSAGE = [
  "Before we start, I want to calibrate like OpenClaw so your memory files are set correctly.",
  "",
  "Please reply with these fields:",
  "- Name: what should I call you?",
  "- Who you are: role/background in 1-3 lines.",
  "- Goal: what you are building right now.",
  "- Interaction style: how you want me to communicate (tone, brevity, structure).",
  "- Constraints: non-negotiables I must respect.",
  "- Heartbeat: preferred check-in cadence (for example daily, every 12h, weekly).",
  "",
  "I will use your reply to populate USER.md, SOUL.md, STYLE.md, and HEARTBEAT.md.",
].join("\n");

export const DEFAULT_RUNTIME_MEMORY_DOC_KEYS = ["SOUL.md", "USER.md", "STYLE.md", "HEARTBEAT.md", "NOTES.md"] as const;
type RuntimeMemoryDefaultDocKey = (typeof DEFAULT_RUNTIME_MEMORY_DOC_KEYS)[number];

type DeploymentAccessRow = {
  id: string;
  deploy_provider: string | null;
};

type RuntimeSessionRow = {
  id: string;
  name: string;
  created_at: string;
  updated_at: string;
};

type RuntimeSessionWithStatsRow = RuntimeSessionRow & {
  message_count: string;
  last_message_at: string | null;
};

type RuntimeMemoryDocRow = {
  doc_key: string;
  content: string;
};

type RuntimeMemoryDocWithPrefsRow = RuntimeMemoryDocRow & {
  self_update_enabled: boolean;
};

export type RuntimeSessionSummary = {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  lastMessageAt: string | null;
};

function readTrimmedEnv(name: string) {
  const raw = process.env[name];
  if (!raw) return "";
  return raw.trim().replace(/^("|')(.*)("|')$/, "$2").replace(/\\n/g, "").trim();
}

function defaultHeartbeatMarkdown() {
  const configured = readTrimmedEnv("SIMPLE_AGENT_MICROSERVICES_DEFAULT_HEARTBEAT_CONTENT");
  if (configured) return configured;
  return [
    "# Daily Heartbeat",
    "",
    "- Review the last 24h conversation summary.",
    "- Check pending follow-ups and high-priority tasks.",
    "- If action is needed, post a short update with concrete next steps.",
    "- If no action is needed, reply with `noop`.",
  ].join("\n");
}

function buildDefaultMemoryDocs() {
  const heartbeatDefault = defaultHeartbeatMarkdown();
  return {
    "SOUL.md": [
      AUTOFILL_MARKER,
      "# SOUL",
      "",
      "You are my pragmatic AI operator.",
      "",
      "## Pending Calibration",
      "Fill this from the first calibration response.",
    ].join("\n"),
    "USER.md": [
      AUTOFILL_MARKER,
      "# USER",
      "",
      "Not calibrated yet.",
      "",
      "## Pending Calibration",
      "Fill this from the first calibration response.",
    ].join("\n"),
    "STYLE.md": [
      AUTOFILL_MARKER,
      "# STYLE",
      "",
      "Not calibrated yet.",
      "",
      "## Pending Calibration",
      "Fill this from the first calibration response.",
    ].join("\n"),
    "HEARTBEAT.md": [
      AUTOFILL_MARKER,
      heartbeatDefault,
    ].join("\n\n"),
    "NOTES.md": [
      AUTOFILL_MARKER,
      "# NOTES",
      "",
      "Reserved for evolving runtime notes and decisions.",
    ].join("\n"),
  } as const;
}

function isAutofillContent(content: string | null | undefined) {
  const normalized = (content ?? "").trim();
  return !normalized || normalized.includes(AUTOFILL_MARKER);
}

function extractFirstLabeledLine(input: string, labels: string[]) {
  const lines = input.split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    const lower = line.toLowerCase();
    for (const label of labels) {
      if (!lower.startsWith(label)) continue;
      const split = line.split(/[:\-]/, 2);
      if (split.length < 2) continue;
      const value = split[1]?.trim();
      if (value) return value;
    }
  }
  return "";
}

function trimBlock(input: string, maxChars: number) {
  const normalized = input.trim();
  if (!normalized) return "";
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, maxChars)}\n...[truncated]`;
}

async function upsertRuntimeMemoryDoc(input: {
  deploymentId: string;
  docKey: string;
  content: string;
}) {
  await pool.query(
    `INSERT INTO runtime_memory_docs (deployment_id, doc_key, content, created_at, updated_at)
     VALUES ($1, $2, $3, NOW(), NOW())
     ON CONFLICT (deployment_id, doc_key)
     DO UPDATE
       SET content = EXCLUDED.content,
           updated_at = NOW()`,
    [input.deploymentId, input.docKey, input.content],
  );
}

async function ensureDefaultRuntimeMemoryDocPrefs(deploymentId: string) {
  for (const docKey of DEFAULT_RUNTIME_MEMORY_DOC_KEYS) {
    await pool.query(
      `INSERT INTO runtime_memory_doc_prefs (deployment_id, doc_key, self_update_enabled, created_at, updated_at)
       VALUES ($1, $2, TRUE, NOW(), NOW())
       ON CONFLICT (deployment_id, doc_key)
       DO NOTHING`,
      [deploymentId, docKey],
    );
  }
}

export async function setRuntimeMemoryDocSelfUpdatePreference(input: {
  deploymentId: string;
  docKey: string;
  selfUpdateEnabled: boolean;
}) {
  await pool.query(
    `INSERT INTO runtime_memory_doc_prefs (deployment_id, doc_key, self_update_enabled, created_at, updated_at)
     VALUES ($1, $2, $3, NOW(), NOW())
     ON CONFLICT (deployment_id, doc_key)
     DO UPDATE
       SET self_update_enabled = EXCLUDED.self_update_enabled,
           updated_at = NOW()`,
    [input.deploymentId, input.docKey, input.selfUpdateEnabled],
  );
}

function isRuntimeMemoryDocSelfUpdateEnabled(
  byKey: Map<string, boolean>,
  docKey: RuntimeMemoryDefaultDocKey,
) {
  const value = byKey.get(docKey);
  return value !== false;
}

export async function ensureDefaultRuntimeMemoryDocs(deploymentId: string) {
  const docs = buildDefaultMemoryDocs();
  for (const [docKey, content] of Object.entries(docs)) {
    await pool.query(
      `INSERT INTO runtime_memory_docs (deployment_id, doc_key, content, created_at, updated_at)
       VALUES ($1, $2, $3, NOW(), NOW())
       ON CONFLICT (deployment_id, doc_key)
       DO NOTHING`,
      [deploymentId, docKey, content],
    );
  }
  await ensureDefaultRuntimeMemoryDocPrefs(deploymentId);
}

async function needsCalibrationPrompt(deploymentId: string) {
  await ensureDefaultRuntimeMemoryDocs(deploymentId);
  const result = await pool.query<RuntimeMemoryDocRow>(
    `SELECT doc_key, content
     FROM runtime_memory_docs
     WHERE deployment_id = $1
       AND doc_key = 'USER.md'
     LIMIT 1`,
    [deploymentId],
  );
  const userDoc = result.rows[0]?.content ?? "";
  return isAutofillContent(userDoc);
}

export function createRuntimeSessionId() {
  return `sess_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

export async function requireOwnedServerlessDeployment(input: {
  deploymentId: string;
  userId: string;
}) {
  const deployment = await pool.query<DeploymentAccessRow>(
    `SELECT id, deploy_provider
     FROM deployments
     WHERE id = $1
       AND user_id = $2
     LIMIT 1`,
    [input.deploymentId, input.userId],
  );
  const row = deployment.rows[0];
  if (!row) {
    return { ok: false as const, status: 404, error: "Deployment not found" };
  }
  if ((row.deploy_provider ?? "").trim().toLowerCase() !== "lambda") {
    return { ok: false as const, status: 400, error: "Runtime is not serverless." };
  }
  return { ok: true as const, deployment: row };
}

export async function getRuntimeSessionById(input: { deploymentId: string; sessionId: string }) {
  const result = await pool.query<RuntimeSessionRow>(
    `SELECT id, name, created_at, updated_at
     FROM runtime_chat_sessions
     WHERE deployment_id = $1
       AND id = $2
     LIMIT 1`,
    [input.deploymentId, input.sessionId],
  );
  return result.rows[0] ?? null;
}

export async function getLatestRuntimeSession(deploymentId: string) {
  const result = await pool.query<RuntimeSessionRow>(
    `SELECT id, name, created_at, updated_at
     FROM runtime_chat_sessions
     WHERE deployment_id = $1
     ORDER BY updated_at DESC, created_at DESC
     LIMIT 1`,
    [deploymentId],
  );
  return result.rows[0] ?? null;
}

async function getRuntimeSessionCount(deploymentId: string) {
  const count = await pool.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count
     FROM runtime_chat_sessions
     WHERE deployment_id = $1`,
    [deploymentId],
  );
  return Number(count.rows[0]?.count ?? "0");
}

function normalizeSessionName(value: string | null | undefined, fallback: string) {
  const trimmed = (value ?? "").trim();
  if (!trimmed) return fallback;
  return trimmed.slice(0, 80);
}

export async function createRuntimeSession(input: { deploymentId: string; name?: string | null }) {
  await ensureDefaultRuntimeMemoryDocs(input.deploymentId);
  const existingCount = await getRuntimeSessionCount(input.deploymentId);
  const fallbackName = `Session ${existingCount + 1}`;
  const name = normalizeSessionName(input.name, fallbackName);
  const sessionId = createRuntimeSessionId();
  const created = await pool.query<RuntimeSessionRow>(
    `INSERT INTO runtime_chat_sessions (id, deployment_id, name, created_at, updated_at)
     VALUES ($1, $2, $3, NOW(), NOW())
     RETURNING id, name, created_at, updated_at`,
    [sessionId, input.deploymentId, name],
  );
  return created.rows[0];
}

export async function ensureRuntimeSessionById(input: {
  deploymentId: string;
  sessionId: string;
  name?: string | null;
}) {
  const normalizedSessionId = input.sessionId.trim();
  if (!normalizedSessionId) return null;

  const existing = await getRuntimeSessionById({
    deploymentId: input.deploymentId,
    sessionId: normalizedSessionId,
  });
  if (existing) return existing;

  await ensureDefaultRuntimeMemoryDocs(input.deploymentId);
  const fallbackName = normalizeSessionName(input.name, "Session");
  const created = await pool.query<RuntimeSessionRow>(
    `INSERT INTO runtime_chat_sessions (id, deployment_id, name, created_at, updated_at)
     VALUES ($1, $2, $3, NOW(), NOW())
     ON CONFLICT (deployment_id, id)
     DO UPDATE
       SET updated_at = NOW()
     RETURNING id, name, created_at, updated_at`,
    [normalizedSessionId, input.deploymentId, fallbackName],
  );
  return created.rows[0] ?? null;
}

export async function ensureRuntimeSession(input: { deploymentId: string; preferredSessionId?: string | null }) {
  const preferredId = (input.preferredSessionId ?? "").trim();
  if (preferredId) {
    const preferred = await getRuntimeSessionById({
      deploymentId: input.deploymentId,
      sessionId: preferredId,
    });
    if (preferred) return { session: preferred, found: true as const };
    return { session: null, found: false as const };
  }

  const latest = await getLatestRuntimeSession(input.deploymentId);
  if (latest) return { session: latest, found: true as const };

  const created = await createRuntimeSession({ deploymentId: input.deploymentId });
  return { session: created, found: true as const };
}

export async function ensureSessionHasStarterMessage(input: {
  deploymentId: string;
  sessionId: string;
}) {
  const shouldPrompt = await needsCalibrationPrompt(input.deploymentId);
  if (!shouldPrompt) return;

  await pool.query(
    `WITH existing AS (
       SELECT 1
       FROM runtime_chat_messages
       WHERE deployment_id = $1
         AND session_id = $2
       LIMIT 1
     )
     INSERT INTO runtime_chat_messages (deployment_id, session_id, role, content)
     SELECT $1, $2, 'assistant', $3
     WHERE NOT EXISTS (SELECT 1 FROM existing)`,
    [input.deploymentId, input.sessionId, STARTER_CALIBRATION_MESSAGE],
  );
}

export async function applyCalibrationFromFirstUserMessage(input: {
  deploymentId: string;
  userMessage: string;
}) {
  await ensureDefaultRuntimeMemoryDocs(input.deploymentId);

  const docs = await pool.query<RuntimeMemoryDocWithPrefsRow>(
    `SELECT docs.doc_key,
            docs.content,
            COALESCE(prefs.self_update_enabled, TRUE) AS self_update_enabled
     FROM runtime_memory_docs docs
     LEFT JOIN runtime_memory_doc_prefs prefs
       ON prefs.deployment_id = docs.deployment_id
      AND prefs.doc_key = docs.doc_key
     WHERE docs.deployment_id = $1
       AND docs.doc_key = ANY($2::text[])`,
    [input.deploymentId, DEFAULT_RUNTIME_MEMORY_DOC_KEYS],
  );
  const byKey = new Map<string, string>();
  const selfUpdateByKey = new Map<string, boolean>();
  for (const row of docs.rows) byKey.set(row.doc_key, row.content);
  for (const row of docs.rows) selfUpdateByKey.set(row.doc_key, row.self_update_enabled);

  const rawResponse = trimBlock(input.userMessage, 8_000);
  const extractedName = extractFirstLabeledLine(rawResponse, ["name", "call me", "who are you", "who you are"]);
  const extractedIdentity = extractFirstLabeledLine(rawResponse, ["who you are", "identity", "about me", "role", "background"]);
  const extractedGoal = extractFirstLabeledLine(rawResponse, ["goal", "goals", "building", "project"]);
  const extractedStyle = extractFirstLabeledLine(rawResponse, ["interaction style", "style", "how to interact", "communication", "tone"]);
  const extractedConstraints = extractFirstLabeledLine(rawResponse, ["constraints", "non-negotiables", "rules", "boundaries"]);
  const extractedHeartbeat = extractFirstLabeledLine(rawResponse, ["heartbeat", "check-in cadence", "cadence", "checkin"]);

  const now = new Date().toISOString();

  if (isRuntimeMemoryDocSelfUpdateEnabled(selfUpdateByKey, "USER.md") && isAutofillContent(byKey.get("USER.md"))) {
    const userDoc = [
      "# USER",
      "",
      `## Name\n${trimBlock(extractedName || "Not specified", 120)}`,
      "",
      `## Who I Am\n${trimBlock(extractedIdentity || rawResponse || "Not specified", 2000)}`,
      "",
      `## Current Goal\n${trimBlock(extractedGoal || "Not specified", 1000)}`,
      "",
      `## Interaction Preferences\n${trimBlock(extractedStyle || "Not specified", 1000)}`,
      "",
      `## Constraints\n${trimBlock(extractedConstraints || "Not specified", 1000)}`,
      "",
      `## Calibration Source (${now})\n${rawResponse}`,
    ].join("\n");
    await upsertRuntimeMemoryDoc({
      deploymentId: input.deploymentId,
      docKey: "USER.md",
      content: userDoc,
    });
  }

  if (isRuntimeMemoryDocSelfUpdateEnabled(selfUpdateByKey, "SOUL.md") && isAutofillContent(byKey.get("SOUL.md"))) {
    const soulDoc = [
      "# SOUL",
      "",
      "You are my pragmatic AI operator.",
      "",
      "## Interaction Contract",
      `- Address me as: ${trimBlock(extractedName || "the user", 120)}`,
      `- Communication style: ${trimBlock(extractedStyle || "concise, direct, structured", 300)}`,
      `- Constraints to respect: ${trimBlock(extractedConstraints || "none provided yet", 400)}`,
      "- If requirements are ambiguous, ask direct clarification questions before acting.",
      "- Keep USER.md and HEARTBEAT.md synchronized when user preferences change.",
    ].join("\n");
    await upsertRuntimeMemoryDoc({
      deploymentId: input.deploymentId,
      docKey: "SOUL.md",
      content: soulDoc,
    });
  }

  if (isRuntimeMemoryDocSelfUpdateEnabled(selfUpdateByKey, "STYLE.md") && isAutofillContent(byKey.get("STYLE.md"))) {
    const styleDoc = [
      "# STYLE",
      "",
      "## Response Style",
      `${trimBlock(extractedStyle || "Use concise, direct responses with clear next steps.", 800)}`,
      "",
      "## Defaults",
      "- Prefer plain English.",
      "- Be explicit about assumptions.",
      "- Keep outputs actionable.",
    ].join("\n");
    await upsertRuntimeMemoryDoc({
      deploymentId: input.deploymentId,
      docKey: "STYLE.md",
      content: styleDoc,
    });
  }

  if (
    extractedHeartbeat &&
    isRuntimeMemoryDocSelfUpdateEnabled(selfUpdateByKey, "HEARTBEAT.md") &&
    isAutofillContent(byKey.get("HEARTBEAT.md"))
  ) {
    const heartbeatDoc = [
      "# HEARTBEAT",
      "",
      `- Preferred cadence: ${trimBlock(extractedHeartbeat, 240)}`,
      "- Review pending tasks and follow-ups on each heartbeat.",
      "- If there is no actionable update, reply with `noop`.",
    ].join("\n");
    await upsertRuntimeMemoryDoc({
      deploymentId: input.deploymentId,
      docKey: "HEARTBEAT.md",
      content: heartbeatDoc,
    });
  }

  if (isRuntimeMemoryDocSelfUpdateEnabled(selfUpdateByKey, "NOTES.md") && isAutofillContent(byKey.get("NOTES.md"))) {
    const notesDoc = [
      "# NOTES",
      "",
      `- Initial calibration captured at ${now}.`,
      "- User can refine USER.md / SOUL.md / STYLE.md / HEARTBEAT.md at any time.",
    ].join("\n");
    await upsertRuntimeMemoryDoc({
      deploymentId: input.deploymentId,
      docKey: "NOTES.md",
      content: notesDoc,
    });
  }
}

export async function touchRuntimeSession(input: { deploymentId: string; sessionId: string }) {
  await pool.query(
    `UPDATE runtime_chat_sessions
     SET updated_at = NOW()
     WHERE deployment_id = $1
       AND id = $2`,
    [input.deploymentId, input.sessionId],
  );
}

export async function listRuntimeSessions(deploymentId: string) {
  const sessions = await pool.query<RuntimeSessionWithStatsRow>(
    `SELECT s.id,
            s.name,
            s.created_at,
            s.updated_at,
            COALESCE(stats.message_count, '0') AS message_count,
            stats.last_message_at
     FROM runtime_chat_sessions s
     LEFT JOIN (
       SELECT session_id,
              COUNT(*)::text AS message_count,
              MAX(created_at) AS last_message_at
       FROM runtime_chat_messages
       WHERE deployment_id = $1
       GROUP BY session_id
     ) stats ON stats.session_id = s.id
     WHERE s.deployment_id = $1
     ORDER BY COALESCE(stats.last_message_at, s.updated_at) DESC, s.created_at DESC`,
    [deploymentId],
  );

  return sessions.rows.map((session) => ({
    id: session.id,
    name: session.name,
    createdAt: session.created_at,
    updatedAt: session.updated_at,
    messageCount: Number(session.message_count || "0"),
    lastMessageAt: session.last_message_at,
  }));
}
