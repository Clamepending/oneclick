import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { ensureSchema, pool } from "@/lib/db";

function readTrimmedEnv(name: string) {
  const raw = process.env[name];
  if (!raw) return "";
  return raw.trim().replace(/^"(.*)"$/, "$1").replace(/\\n/g, "").trim();
}

function readLimitEnv(name: string) {
  const value = readTrimmedEnv(name);
  if (!value) return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return Math.floor(parsed);
}

export async function GET() {
  try {
    const session = await auth();
    if (!session?.user?.email) {
      return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
    }

    await ensureSchema();

    const freeActiveLimit = readLimitEnv("DEPLOY_MAX_FREE_ACTIVE_PER_USER") ?? 1;
    const freeActive = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text as count
       FROM deployments
       WHERE user_id = $1
         AND status IN ('queued', 'starting', 'ready')
         AND COALESCE(NULLIF(TRIM(plan_tier), ''), 'free') = 'free'`,
      [session.user.email],
    );
    const freeActiveCount = Number(freeActive.rows[0]?.count ?? "0");

    return NextResponse.json({
      ok: true,
      plans: {
        free: {
          selectable: freeActiveCount < freeActiveLimit,
          activeCount: freeActiveCount,
          activeLimit: freeActiveLimit,
        },
        paid: {
          selectable: true,
        },
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Eligibility lookup failed";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
