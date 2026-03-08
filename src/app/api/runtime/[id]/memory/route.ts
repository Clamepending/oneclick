import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { ensureSchema, pool } from "@/lib/db";
import { ensureDefaultRuntimeMemoryDocs, requireOwnedServerlessDeployment } from "../shared";

const DEFAULT_DOC_KEYS = ["SOUL.md", "USER.md", "STYLE.md", "HEARTBEAT.md", "NOTES.md"] as const;

const patchSchema = z.object({
  docKey: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9_.-]{1,80}\.md$/),
  content: z.string().max(100_000),
});

type MemoryDocRow = {
  doc_key: string;
  content: string;
  updated_at: string;
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
    `SELECT doc_key, content, updated_at
     FROM runtime_memory_docs
     WHERE deployment_id = $1`,
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

  const upserted = await pool.query<MemoryDocRow>(
    `INSERT INTO runtime_memory_docs (deployment_id, doc_key, content, created_at, updated_at)
     VALUES ($1, $2, $3, NOW(), NOW())
     ON CONFLICT (deployment_id, doc_key)
     DO UPDATE
       SET content = EXCLUDED.content,
           updated_at = NOW()
     RETURNING doc_key, content, updated_at`,
    [id, parsed.data.docKey, parsed.data.content],
  );

  const row = upserted.rows[0];
  return NextResponse.json({
    ok: true,
    doc: {
      docKey: row.doc_key,
      content: row.content,
      updatedAt: row.updated_at,
    },
  });
}
