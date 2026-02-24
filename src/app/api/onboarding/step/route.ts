import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { ensureSchema, pool } from "@/lib/db";

const stepPayload = z.object({
  step: z.number().min(1).max(3),
  botName: z.string().trim().min(1).max(80).optional(),
  channel: z.enum(["none", "telegram"]).optional(),
  plan: z.enum(["free"]).optional(),
});

export async function POST(request: Request) {
  try {
    const session = await auth();
    if (!session?.user?.email) {
      return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
    }

    const parsed = stepPayload.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json({ ok: false, error: "Invalid payload" }, { status: 400 });
    }

    const { step, botName, channel, plan } = parsed.data;
    await ensureSchema();

    await pool.query(
      `INSERT INTO onboarding_sessions (user_id)
       VALUES ($1)
       ON CONFLICT (user_id) DO NOTHING`,
      [session.user.email],
    );

    await pool.query(
      `UPDATE onboarding_sessions
       SET bot_name = COALESCE($1, bot_name),
           channel = COALESCE($2, channel),
           plan = COALESCE($3, plan),
           current_step = GREATEST(current_step, $4),
           completed = CASE WHEN $4 >= 3 THEN TRUE ELSE completed END,
           updated_at = NOW()
       WHERE user_id = $5`,
      [botName ?? null, channel ?? null, plan ?? null, step, session.user.email],
    );

    return NextResponse.json({ ok: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Onboarding save failed";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
