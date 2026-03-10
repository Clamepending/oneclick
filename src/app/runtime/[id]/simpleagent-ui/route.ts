import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { ensureSchema, pool } from "@/lib/db";
import { renderSimpleagentUiHtml } from "@/lib/runtime/simpleagentUiAdapter";

export const dynamic = "force-dynamic";

type DeploymentRow = {
  id: string;
  status: string;
  deploy_provider: string | null;
};

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  const userId = session?.user?.email?.trim();
  if (!userId) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await context.params;
  await ensureSchema();

  const deployment = await pool.query<DeploymentRow>(
    `SELECT id, status, deploy_provider
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
  if ((row.status ?? "").trim().toLowerCase() !== "ready") {
    return NextResponse.json({ ok: false, error: "Deployment is not ready yet." }, { status: 409 });
  }

  const query = new URL(request.url).searchParams;
  const html = await renderSimpleagentUiHtml({
    deploymentId: id,
    forceOneclickMode: true,
    hideBotUi:
      query.get("hide_bot_ui") === "1" ||
      query.get("hide_bot_session") === "1" ||
      query.get("ui_mode") === "oneclick" ||
      query.get("ui_mode") === "serverless",
    hideSessionUi: query.get("hide_session_ui") === "1",
  });

  return new NextResponse(html, {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}
