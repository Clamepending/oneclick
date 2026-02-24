import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { ensureSchema, pool } from "@/lib/db";

const payloadSchema = z
  .object({
    openaiApiKey: z.string().trim().min(1).max(300).optional(),
    anthropicApiKey: z.string().trim().min(1).max(300).optional(),
    openrouterApiKey: z.string().trim().min(1).max(300).optional(),
    telegramBotToken: z.string().trim().min(1).max(300).optional(),
  })
  .refine(
    (value) =>
      Boolean(
        value.openaiApiKey ||
          value.anthropicApiKey ||
          value.openrouterApiKey ||
          value.telegramBotToken,
      ),
    { message: "At least one setting is required" },
  );

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  if (!session?.user?.email) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await context.params;
  const parsed = payloadSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ ok: false, error: "Invalid settings payload" }, { status: 400 });
  }

  await ensureSchema();
  const owned = await pool.query<{ id: string }>(
    `SELECT id FROM deployments WHERE id = $1 AND user_id = $2 LIMIT 1`,
    [id, session.user.email],
  );
  if (!owned.rows[0]) {
    return NextResponse.json({ ok: false, error: "Not found" }, { status: 404 });
  }

  const { openaiApiKey, anthropicApiKey, openrouterApiKey, telegramBotToken } = parsed.data;
  await pool.query(
    `UPDATE deployments
     SET openai_api_key = COALESCE($1, openai_api_key),
         anthropic_api_key = COALESCE($2, anthropic_api_key),
         openrouter_api_key = COALESCE($3, openrouter_api_key),
         telegram_bot_token = COALESCE($4, telegram_bot_token),
         updated_at = NOW()
     WHERE id = $5 AND user_id = $6`,
    [
      openaiApiKey ?? null,
      anthropicApiKey ?? null,
      openrouterApiKey ?? null,
      telegramBotToken ?? null,
      id,
      session.user.email,
    ],
  );

  return NextResponse.json({ ok: true });
}
