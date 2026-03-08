import { pool } from "@/lib/db";

export type RuntimeEventLogStatus = "processed" | "failed" | "ignored" | "replay_failed";

export type RuntimeEventLogSource = "telegram_webhook" | "runtime_replay" | "runtime_chat";

export type RuntimeEventLogRow = {
  id: number;
  deployment_id: string;
  source: string;
  event_type: string;
  status: string;
  session_id: string | null;
  error: string | null;
  payload: unknown;
  result: unknown;
  replay_of_event_id: number | null;
  created_at: string;
  updated_at: string;
};

function stringifyJson(value: unknown) {
  try {
    return JSON.stringify(value ?? {});
  } catch {
    return "{}";
  }
}

export async function createRuntimeEventLog(input: {
  deploymentId: string;
  source: RuntimeEventLogSource;
  eventType: string;
  status: RuntimeEventLogStatus;
  sessionId?: string | null;
  error?: string | null;
  payload?: unknown;
  result?: unknown;
  replayOfEventId?: number | null;
}) {
  const inserted = await pool.query<RuntimeEventLogRow>(
    `INSERT INTO runtime_event_logs (
       deployment_id,
       source,
       event_type,
       status,
       session_id,
       error,
       payload,
       result,
       replay_of_event_id,
       created_at,
       updated_at
     )
     VALUES (
       $1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9, NOW(), NOW()
     )
     RETURNING id,
               deployment_id,
               source,
               event_type,
               status,
               session_id,
               error,
               payload,
               result,
               replay_of_event_id,
               created_at,
               updated_at`,
    [
      input.deploymentId,
      input.source,
      input.eventType.trim() || "unknown",
      input.status,
      input.sessionId ?? null,
      input.error ?? null,
      stringifyJson(input.payload),
      input.result === undefined ? null : stringifyJson(input.result),
      input.replayOfEventId ?? null,
    ],
  );
  return inserted.rows[0] ?? null;
}

export async function getRuntimeEventLogById(input: {
  deploymentId: string;
  eventId: number;
}) {
  const found = await pool.query<RuntimeEventLogRow>(
    `SELECT id,
            deployment_id,
            source,
            event_type,
            status,
            session_id,
            error,
            payload,
            result,
            replay_of_event_id,
            created_at,
            updated_at
     FROM runtime_event_logs
     WHERE deployment_id = $1
       AND id = $2
     LIMIT 1`,
    [input.deploymentId, input.eventId],
  );
  return found.rows[0] ?? null;
}

export async function listRuntimeEventLogs(input: {
  deploymentId: string;
  limit?: number;
}) {
  const safeLimit = Math.max(1, Math.min(200, Number(input.limit ?? 80) || 80));
  const rows = await pool.query<RuntimeEventLogRow>(
    `SELECT id,
            deployment_id,
            source,
            event_type,
            status,
            session_id,
            error,
            payload,
            result,
            replay_of_event_id,
            created_at,
            updated_at
     FROM runtime_event_logs
     WHERE deployment_id = $1
     ORDER BY id DESC
     LIMIT $2`,
    [input.deploymentId, safeLimit],
  );
  return rows.rows;
}

