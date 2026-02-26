import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { ensureSchema, pool } from "@/lib/db";
import { PAID_MONTHLY_PRICE_CENTS } from "@/lib/plans";

export async function POST(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  if (!session?.user?.email) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await context.params;
  await ensureSchema();

  const result = await pool.query<{ id: string; plan_tier: string | null }>(
    `SELECT id, plan_tier
     FROM deployments
     WHERE id = $1 AND user_id = $2`,
    [id, session.user.email],
  );
  const deployment = result.rows[0];
  if (!deployment) {
    return NextResponse.json({ ok: false, error: "Not found" }, { status: 404 });
  }

  await pool.query(
    `UPDATE onboarding_sessions
     SET plan = 'paid',
         deployment_flavor = 'basic',
         updated_at = NOW()
     WHERE user_id = $1`,
    [session.user.email],
  );
  await pool.query(
    `UPDATE deployments
     SET plan_tier = 'paid',
         deployment_flavor = 'basic',
         monthly_price_cents = $2,
         deactivated_at = NULL,
         deactivation_reason = NULL,
         error = CASE WHEN deactivation_reason = 'trial_expired' THEN NULL ELSE error END,
         updated_at = NOW()
     WHERE id = $1`,
    [id, PAID_MONTHLY_PRICE_CENTS],
  );
  await pool.query(
    `INSERT INTO deployment_events (deployment_id, status, message)
     VALUES ($1, 'starting', 'Plan upgraded to Paid (Basic) ($20/month). Redeploy to apply upgraded specs.')`,
    [id],
  );

  return NextResponse.json({ ok: true, planTier: "paid", monthlyPriceCents: PAID_MONTHLY_PRICE_CENTS });
}
