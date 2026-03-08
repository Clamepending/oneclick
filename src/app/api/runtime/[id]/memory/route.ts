import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { ensureSchema, pool } from "@/lib/db";
import {
  DEFAULT_RUNTIME_MEMORY_DOC_KEYS,
  ensureDefaultRuntimeMemoryDocs,
  requireOwnedServerlessDeployment,
  setRuntimeMemoryDocSelfUpdatePreference,
} from "../shared";

const DEFAULT_DOC_KEYS = DEFAULT_RUNTIME_MEMORY_DOC_KEYS;

const patchSchema = z.object({
  docKey: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9_.-]{1,80}\.md$/),
  content: z.string().max(100_000).optional(),
  selfUpdateEnabled: z.boolean().optional(),
}).refine(
  (value) => value.content !== undefined || value.selfUpdateEnabled !== undefined,
  { message: "At least one field must be provided." },
);

type MemoryDocRow = {
  doc_key: string;
  content: string;
  updated_at: string | null;
  self_update_enabled: boolean | null;
};

function sortDocKeys(keys: string[]) {
  const defaultOrder = new Map<string, number>(DEFAULT_DOC_KEYS.map((key, index) => [key, index]));
  return keys.sort((a, b) => {
    const aIndex = defaultOrder.get(a);
    const bIndex = defaultOrder.get(b);
    if (aIndex !== undefined && bIndex !== undefined) return aIndex - bIndex;
    if (aIndex !== undefined) return -1;
    if (bIndex !== undefined) return 1;
    return a.localeCompare(b);
  });
}

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  const userId = session?.user?.email?.trim();
  if (!userId) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await context.params;
  await ensureSchema();

  const access = await requireOwnedServerlessDeployment({ deploymentId: id, userId });
  if (!access.ok) {
    return NextResponse.json({ ok: false, error: access.error }, { status: access.status });
  }
  await ensureDefaultRuntimeMemoryDocs(id);

  const docs = await pool.query<MemoryDocRow>(
    `SELECT docs.doc_key,
            docs.content,
            docs.updated_at,
            COALESCE(prefs.self_update_enabled, TRUE) AS self_update_enabled
     FROM runtime_memory_docs docs
     LEFT JOIN runtime_memory_doc_prefs prefs
       ON prefs.deployment_id = docs.deployment_id
      AND prefs.doc_key = docs.doc_key
     WHERE docs.deployment_id = $1`,
    [id],
  );

  const byKey = new Map<string, MemoryDocRow>();
  for (const row of docs.rows) byKey.set(row.doc_key, row);

  const allKeys = sortDocKeys(Array.from(new Set([...DEFAULT_DOC_KEYS, ...docs.rows.map((row) => row.doc_key)])));
  return NextResponse.json({
    ok: true,
    docs: allKeys.map((key) => {
      const row = byKey.get(key);
      return {
        docKey: key,
        content: row?.content ?? "",
        updatedAt: row?.updated_at ?? null,
        selfUpdateEnabled: row?.self_update_enabled ?? true,
      };
    }),
  });
}

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  const userId = session?.user?.email?.trim();
  if (!userId) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  const parsed = patchSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ ok: false, error: "Invalid memory payload" }, { status: 400 });
  }

  const { id } = await context.params;
  await ensureSchema();

  const access = await requireOwnedServerlessDeployment({ deploymentId: id, userId });
  if (!access.ok) {
    return NextResponse.json({ ok: false, error: access.error }, { status: access.status });
  }
  await ensureDefaultRuntimeMemoryDocs(id);

  if (parsed.data.content !== undefined) {
    await pool.query(
      `INSERT INTO runtime_memory_docs (deployment_id, doc_key, content, created_at, updated_at)
       VALUES ($1, $2, $3, NOW(), NOW())
       ON CONFLICT (deployment_id, doc_key)
       DO UPDATE
         SET content = EXCLUDED.content,
             updated_at = NOW()`,
      [id, parsed.data.docKey, parsed.data.content],
    );
  }

  if (parsed.data.selfUpdateEnabled !== undefined) {
    await setRuntimeMemoryDocSelfUpdatePreference({
      deploymentId: id,
      docKey: parsed.data.docKey,
      selfUpdateEnabled: parsed.data.selfUpdateEnabled,
    });
  }

  const selected = await pool.query<MemoryDocRow>(
    `SELECT docs.doc_key,
            docs.content,
            docs.updated_at,
            COALESCE(prefs.self_update_enabled, TRUE) AS self_update_enabled
     FROM runtime_memory_docs docs
     LEFT JOIN runtime_memory_doc_prefs prefs
       ON prefs.deployment_id = docs.deployment_id
      AND prefs.doc_key = docs.doc_key
     WHERE docs.deployment_id = $1
       AND docs.doc_key = $2
     LIMIT 1`,
    [id, parsed.data.docKey],
  );

  const row = selected.rows[0];
  if (!row) {
    return NextResponse.json({
      ok: true,
      doc: {
        docKey: parsed.data.docKey,
        content: "",
        updatedAt: null,
        selfUpdateEnabled: parsed.data.selfUpdateEnabled ?? true,
      },
    });
  }

  return NextResponse.json({
    ok: true,
    doc: {
      docKey: row.doc_key,
      content: row.content,
      updatedAt: row.updated_at,
      selfUpdateEnabled: row.self_update_enabled ?? true,
    },
  });
}
