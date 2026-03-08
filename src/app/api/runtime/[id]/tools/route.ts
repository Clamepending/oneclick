import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { ensureSchema } from "@/lib/db";
import { listServerlessRuntimeTools } from "@/lib/runtime/serverlessTools";
import { requireOwnedServerlessDeployment } from "../shared";

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

  try {
    const catalog = await listServerlessRuntimeTools();
    return NextResponse.json({
      ok: true,
      tools: catalog.tools,
      ottoauth: catalog.ottoauth,
    });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : "Failed to load tools." },
      { status: 500 },
    );
  }
}
