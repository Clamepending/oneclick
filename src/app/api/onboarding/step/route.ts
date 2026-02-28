import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { ensureSchema, pool } from "@/lib/db";
import { normalizeDeploymentFlavor } from "@/lib/plans";

const stepPayload = z.object({
  step: z.number().min(1).max(3),
  botName: z.string().trim().min(1).max(80).optional(),
  channel: z.enum(["none", "telegram"]).optional(),
  telegramBotToken: z.string().trim().min(1).max(200).nullable().optional(),
  modelProvider: z.enum(["openai", "anthropic"]).nullable().optional(),
  modelApiKey: z.string().trim().min(1).max(200).nullable().optional(),
  plan: z.enum(["free", "paid"]).optional(),
  deploymentFlavor: z.enum(["simple_agent_free", "simple_agent_videomemory_free", "deploy_openclaw_free", "ottoagent_free"]).optional(),
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

    const { step, botName, channel, telegramBotToken, modelProvider, modelApiKey, plan, deploymentFlavor } =
      parsed.data;
    const normalizedFlavor = deploymentFlavor ? normalizeDeploymentFlavor(deploymentFlavor) : null;
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
           telegram_bot_token = $3,
           model_provider = $4,
           model_api_key = $5,
           plan = COALESCE($6, plan),
           deployment_flavor = COALESCE($7, deployment_flavor),
           current_step = GREATEST(current_step, $8),
           completed = CASE WHEN $8 >= 3 THEN TRUE ELSE completed END,
           updated_at = NOW()
       WHERE user_id = $9`,
      [
        botName ?? null,
        channel ?? null,
        telegramBotToken ?? null,
        modelProvider ?? null,
        modelApiKey ?? null,
        plan ?? null,
        normalizedFlavor,
        step,
        session.user.email,
      ],
    );

    return NextResponse.json({ ok: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Onboarding save failed";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
