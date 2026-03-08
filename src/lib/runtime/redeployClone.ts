import crypto from "node:crypto";
import { pool } from "@/lib/db";

type RuntimeSessionRow = {
  id: string;
  name: string;
  created_at: string;
  updated_at: string;
};

function buildClonedSessionId(input: {
  targetDeploymentId: string;
  sourceSessionId: string;
  index: number;
}) {
  const hash = crypto
    .createHash("sha256")
    .update(`${input.targetDeploymentId}:${input.sourceSessionId}:${input.index}`)
    .digest("hex")
    .slice(0, 20);
  return `r_${input.targetDeploymentId.slice(0, 8)}_${hash}`;
}

export async function cloneRuntimeHistoryForRedeploy(input: {
  sourceDeploymentId: string;
  targetDeploymentId: string;
}) {
  if (input.sourceDeploymentId === input.targetDeploymentId) {
    return { sessionCount: 0, messageCount: 0 };
  }

  const sourceSessions = await pool.query<RuntimeSessionRow>(
    `SELECT id, name, created_at, updated_at
     FROM runtime_chat_sessions
     WHERE deployment_id = $1
     ORDER BY created_at ASC, id ASC`,
    [input.sourceDeploymentId],
  );
  if (!sourceSessions.rows.length) {
    return { sessionCount: 0, messageCount: 0 };
  }

  const sourceSessionIds: string[] = [];
  const targetSessionIds: string[] = [];
  for (let index = 0; index < sourceSessions.rows.length; index += 1) {
    const row = sourceSessions.rows[index];
    const clonedId = buildClonedSessionId({
      targetDeploymentId: input.targetDeploymentId,
      sourceSessionId: row.id,
      index,
    });
    sourceSessionIds.push(row.id);
    targetSessionIds.push(clonedId);
    await pool.query(
      `INSERT INTO runtime_chat_sessions (id, deployment_id, name, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [clonedId, input.targetDeploymentId, row.name, row.created_at, row.updated_at],
    );
  }

  const copiedMessages = await pool.query(
    `WITH session_map AS (
       SELECT source_session_id, target_session_id
       FROM UNNEST($3::text[], $4::text[]) AS map(source_session_id, target_session_id)
     )
     INSERT INTO runtime_chat_messages (deployment_id, session_id, role, content, created_at)
     SELECT $2 AS deployment_id,
            map.target_session_id,
            message.role,
            message.content,
            message.created_at
     FROM runtime_chat_messages message
     JOIN session_map map
       ON map.source_session_id = message.session_id
     WHERE message.deployment_id = $1
     ORDER BY message.id ASC`,
    [input.sourceDeploymentId, input.targetDeploymentId, sourceSessionIds, targetSessionIds],
  );

  return {
    sessionCount: sourceSessions.rowCount ?? sourceSessions.rows.length,
    messageCount: copiedMessages.rowCount ?? 0,
  };
}
