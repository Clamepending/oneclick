import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { ensureSchema, pool } from "@/lib/db";
import { normalizeDeploymentFlavor } from "@/lib/plans";
import { renderSimpleagentUiHtml } from "@/lib/runtime/simpleagentUiAdapter";

export const dynamic = "force-dynamic";

type DeploymentRow = {
  id: string;
  status: string;
  deploy_provider: string | null;
  deployment_flavor: string | null;
  ready_url: string | null;
};

function isTruthyParam(value: string | null) {
  const normalized = String(value ?? "").trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

function resolveHostedSimpleagentUiUrl(input: {
  readyUrl: string;
  query: URLSearchParams;
}) {
  const target = new URL(input.readyUrl);
  const uiMode = String(input.query.get("ui_mode") || "oneclick").trim() || "oneclick";
  const hideBotSession =
    isTruthyParam(input.query.get("hide_bot_session")) ||
    uiMode.toLowerCase() === "oneclick" ||
    uiMode.toLowerCase() === "serverless";
  const hideBotUi = isTruthyParam(input.query.get("hide_bot_ui")) || hideBotSession;
  const hideSessionUi = isTruthyParam(input.query.get("hide_session_ui")) || hideBotSession;

  target.searchParams.set("ui_mode", uiMode);
  if (hideBotSession) target.searchParams.set("hide_bot_session", "1");
  if (hideBotUi) target.searchParams.set("hide_bot_ui", "1");
  if (hideSessionUi) target.searchParams.set("hide_session_ui", "1");
  return target.toString();
}

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
    `SELECT id, status, deploy_provider, deployment_flavor, ready_url
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
  if ((row.status ?? "").trim().toLowerCase() !== "ready") {
    return NextResponse.json({ ok: false, error: "Deployment is not ready yet." }, { status: 409 });
  }
  if (normalizeDeploymentFlavor(row.deployment_flavor) === "deploy_openclaw_free") {
    return NextResponse.json({ ok: false, error: "SimpleAgent UI is not available for this deployment flavor." }, { status: 400 });
  }
  const isServerless = (row.deploy_provider ?? "").trim().toLowerCase() === "lambda";

  const query = new URL(request.url).searchParams;
  if (!isServerless) {
    const readyUrl = String(row.ready_url ?? "").trim();
    if (!readyUrl) {
      return NextResponse.json({ ok: false, error: "Runtime URL is not configured yet." }, { status: 409 });
    }
    let targetUrl = "";
    try {
      targetUrl = resolveHostedSimpleagentUiUrl({ readyUrl, query });
    } catch {
      return NextResponse.json({ ok: false, error: "Runtime URL is invalid." }, { status: 502 });
    }
    return NextResponse.redirect(targetUrl, { status: 307 });
  }

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
