import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { ensureSchema, pool } from "@/lib/db";

type MessageRow = {
  id: number;
  role: string;
  content: string;
  created_at: string;
};

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

  const deployment = await pool.query<{ id: string; deploy_provider: string | null }>(
    `SELECT id, deploy_provider
     FROM deployments
     WHERE id = $1
       AND user_id = $2
     LIMIT 1`,
    [id, userId],
  );
  const row = deployment.rows[0];
  if (!row) {
    return NextResponse.json({ ok: false, error: "Deployment not found" }, { status: 404 });
  }
  if ((row.deploy_provider ?? "").trim().toLowerCase() !== "lambda") {
    return NextResponse.json({ ok: false, error: "Runtime is not serverless." }, { status: 400 });
  }

  const messages = await pool.query<MessageRow>(
    `SELECT id, role, content, created_at
     FROM runtime_chat_messages
     WHERE deployment_id = $1
     ORDER BY id ASC
     LIMIT 300`,
    [id],
  );

  return NextResponse.json({
    ok: true,
    messages: messages.rows
      .filter((item) => item.role === "user" || item.role === "assistant")
      .map((item) => ({
        id: item.id,
        role: item.role,
        content: item.content,
        createdAt: item.created_at,
      })),
  });
}
