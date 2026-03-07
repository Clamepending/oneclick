import { pool } from "@/lib/db";

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

export type RuntimeSessionSummary = {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  lastMessageAt: string | null;
};

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
