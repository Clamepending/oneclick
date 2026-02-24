import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { ensureSchema, pool } from "@/lib/db";
import { destroyUserRuntime } from "@/lib/provisioner/runtimeProvider";

async function checkRuntimeHealth(readyUrl: string) {
  try {
    const healthPath = process.env.OPENCLAW_HEALTH_PATH ?? "/health";
    const url = new URL(healthPath, readyUrl);
    const response = await fetch(url.toString(), {
      cache: "no-store",
      signal: AbortSignal.timeout(3000),
    });
    return {
      ok: response.ok,
      status: response.status,
    };
  } catch {
    return {
      ok: false,
      status: null,
    };
  }
}

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  if (!session?.user?.email) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await context.params;
  await ensureSchema();

  const result = await pool.query<{
    id: string;
    bot_name: string | null;
    status: string;
    host_name: string | null;
    runtime_id: string | null;
    deploy_provider: string | null;
    openai_api_key: string | null;
    anthropic_api_key: string | null;
    openrouter_api_key: string | null;
    telegram_bot_token: string | null;
    ready_url: string | null;
    error: string | null;
    created_at: string;
    updated_at: string;
  }>(
    `SELECT id, bot_name, status, host_name, runtime_id, deploy_provider,
            openai_api_key, anthropic_api_key, openrouter_api_key, telegram_bot_token,
            ready_url, error, created_at, updated_at
     FROM deployments
     WHERE id = $1 AND user_id = $2`,
    [id, session.user.email],
  );

  const item = result.rows[0];
  if (!item) {
    return NextResponse.json({ ok: false, error: "Not found" }, { status: 404 });
  }

  const health =
    item.status === "ready" && item.ready_url
      ? await checkRuntimeHealth(item.ready_url)
      : null;

  return NextResponse.json({
    id: item.id,
    botName: item.bot_name,
    status: item.status,
    hostName: item.host_name,
    runtimeId: item.runtime_id,
    deployProvider: item.deploy_provider,
    settings: {
      hasOpenaiApiKey: Boolean(item.openai_api_key?.trim()),
      hasAnthropicApiKey: Boolean(item.anthropic_api_key?.trim()),
      hasOpenrouterApiKey: Boolean(item.openrouter_api_key?.trim()),
      hasTelegramBotToken: Boolean(item.telegram_bot_token?.trim()),
    },
    readyUrl: item.ready_url,
    error: item.error,
    createdAt: item.created_at,
    updatedAt: item.updated_at,
    health,
  });
}

export async function DELETE(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  if (!session?.user?.email) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await context.params;
  await ensureSchema();

  const result = await pool.query<{
    id: string;
    status: string;
    runtime_id: string | null;
    deploy_provider: string | null;
  }>(
    `SELECT id, status, runtime_id, deploy_provider
     FROM deployments
     WHERE id = $1 AND user_id = $2`,
    [id, session.user.email],
  );

  const deployment = result.rows[0];
  if (!deployment) {
    return NextResponse.json({ ok: false, error: "Not found" }, { status: 404 });
  }

  if (deployment.status === "queued" || deployment.status === "starting") {
    return NextResponse.json(
      { ok: false, error: "Cannot delete a deployment that is still in progress." },
      { status: 409 },
    );
  }

  try {
    if (deployment.runtime_id) {
      await destroyUserRuntime({
        runtimeId: deployment.runtime_id,
        deployProvider: deployment.deploy_provider,
      });
    }

    await pool.query(`DELETE FROM deployment_events WHERE deployment_id = $1`, [id]);
    await pool.query(`DELETE FROM deployments WHERE id = $1 AND user_id = $2`, [id, session.user.email]);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to delete deployment";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
