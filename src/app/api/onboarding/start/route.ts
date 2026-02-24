import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { ensureSchema, pool } from "@/lib/db";

export async function POST() {
  try {
    const session = await auth();
    if (!session?.user?.email) {
      return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
    }

    await ensureSchema();

    await pool.query(
      `INSERT INTO onboarding_sessions (user_id)
       VALUES ($1)
       ON CONFLICT (user_id) DO NOTHING`,
      [session.user.email],
    );

    return NextResponse.json({ ok: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Onboarding start failed";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
