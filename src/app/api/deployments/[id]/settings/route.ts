import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { ensureSchema, pool } from "@/lib/db";
import { enqueueDeploymentJob, markDeploymentFailed, newDeploymentId } from "@/workers/deployWorker";

const payloadSchema = z
  .object({
    openaiApiKey: z.string().trim().min(1).max(300).optional(),
    anthropicApiKey: z.string().trim().min(1).max(300).optional(),
    openrouterApiKey: z.string().trim().min(1).max(300).optional(),
    telegramBotToken: z.string().trim().min(1).max(300).optional(),
    redeploy: z.boolean().optional(),
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

type QueueModeInfo = {
  usable: boolean;
  endpoint: string;
  reason: "ok" | "missing_sqs_queue_url" | "missing_aws_region";
};

function readTrimmedEnv(name: string) {
  const raw = process.env[name];
  if (!raw) return "";
  return raw.trim().replace(/^"(.*)"$/, "$1").replace(/\\n/g, "").trim();
}

function getQueueModeInfo(): QueueModeInfo {
  const region = readTrimmedEnv("AWS_REGION");
  const queueUrl = readTrimmedEnv("SQS_DEPLOYMENT_QUEUE_URL");
  if (!region) return { usable: false, endpoint: "", reason: "missing_aws_region" };
  if (!queueUrl) return { usable: false, endpoint: "", reason: "missing_sqs_queue_url" };
  return { usable: true, endpoint: queueUrl, reason: "ok" };
}

function summarizeQueueEndpoint(raw: string) {
  if (!raw) return "none";
  try {
    const url = new URL(raw);
    return `${url.protocol}//${url.hostname}${url.port ? `:${url.port}` : ""}`;
  } catch {
    return raw.slice(0, 40);
  }
}

function queueUnavailableMessage(queueInfo: QueueModeInfo) {
  if (queueInfo.reason === "missing_aws_region") {
    return "Deployment queue unavailable: AWS_REGION is not configured for SQS queueing.";
  }
  if (queueInfo.reason === "missing_sqs_queue_url") {
    return "Deployment queue unavailable: SQS_DEPLOYMENT_QUEUE_URL is not configured.";
  }
  return "Deployment queue unavailable. Please try again shortly.";
}

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
  const owned = await pool.query<{
    id: string;
    status: string;
    bot_name: string | null;
    openai_api_key: string | null;
    anthropic_api_key: string | null;
    openrouter_api_key: string | null;
    telegram_bot_token: string | null;
  }>(
    `SELECT id, status, bot_name, openai_api_key, anthropic_api_key, openrouter_api_key, telegram_bot_token
     FROM deployments
     WHERE id = $1 AND user_id = $2
     LIMIT 1`,
    [id, session.user.email],
  );
  const current = owned.rows[0];
  if (!current) {
    return NextResponse.json({ ok: false, error: "Not found" }, { status: 404 });
  }

  const { openaiApiKey, anthropicApiKey, openrouterApiKey, telegramBotToken, redeploy } = parsed.data;
  const updated = await pool.query<{
    bot_name: string | null;
    openai_api_key: string | null;
    anthropic_api_key: string | null;
    openrouter_api_key: string | null;
    telegram_bot_token: string | null;
  }>(
    `UPDATE deployments
     SET openai_api_key = COALESCE($1, openai_api_key),
         anthropic_api_key = COALESCE($2, anthropic_api_key),
         openrouter_api_key = COALESCE($3, openrouter_api_key),
         telegram_bot_token = COALESCE($4, telegram_bot_token),
         updated_at = NOW()
     WHERE id = $5 AND user_id = $6
     RETURNING bot_name, openai_api_key, anthropic_api_key, openrouter_api_key, telegram_bot_token`,
    [
      openaiApiKey ?? null,
      anthropicApiKey ?? null,
      openrouterApiKey ?? null,
      telegramBotToken ?? null,
      id,
      session.user.email,
    ],
  );

  if (!redeploy) {
    return NextResponse.json({ ok: true });
  }

  if (current.status === "queued" || current.status === "starting") {
    return NextResponse.json(
      { ok: false, error: "Cannot redeploy while this deployment is still in progress." },
      { status: 409 },
    );
  }

  const active = await pool.query<{ count: string }>(
    `SELECT COUNT(*)::text as count
     FROM deployments
     WHERE user_id = $1
       AND id <> $2
       AND status IN ('queued', 'starting')`,
    [session.user.email, id],
  );
  const maxActive = Number(process.env.DEPLOY_MAX_ACTIVE_PER_USER ?? "1");
  if (Number(active.rows[0]?.count ?? "0") >= maxActive) {
    return NextResponse.json(
      { ok: false, error: "You already have an active deployment in progress." },
      { status: 409 },
    );
  }

  const nextDeploymentId = newDeploymentId();
  const source = updated.rows[0] ?? current;
  await pool.query(
    `INSERT INTO deployments (
       id, user_id, bot_name, status, openai_api_key, anthropic_api_key, openrouter_api_key, telegram_bot_token
     )
     VALUES ($1, $2, $3, 'queued', $4, $5, $6, $7)`,
    [
      nextDeploymentId,
      session.user.email,
      source.bot_name,
      source.openai_api_key,
      source.anthropic_api_key,
      source.openrouter_api_key,
      source.telegram_bot_token,
    ],
  );

  await pool.query(
    `INSERT INTO deployment_events (deployment_id, status, message)
     VALUES ($1, 'queued', 'Deployment accepted and queued (redeploy from settings)')`,
    [nextDeploymentId],
  );

  const queueInfo = getQueueModeInfo();
  await pool.query(
    `INSERT INTO deployment_events (deployment_id, status, message)
     VALUES ($1, 'queued', $2)`,
    [
      nextDeploymentId,
      `Queue routing: runtime=vercel queueProvider=sqs queueUsable=${queueInfo.usable ? "yes" : "no"} endpoint=${summarizeQueueEndpoint(queueInfo.endpoint)} reason=${queueInfo.reason}`,
    ],
  );

  if (!queueInfo.usable) {
    const message = queueUnavailableMessage(queueInfo);
    await markDeploymentFailed(nextDeploymentId, new Error(message));
    return NextResponse.json({ ok: false, error: message }, { status: 503 });
  }

  try {
    await pool.query(
      `INSERT INTO deployment_events (deployment_id, status, message)
       VALUES ($1, 'queued', 'Queue available; enqueueing deployment job for AWS consumer')`,
      [nextDeploymentId],
    );
    await enqueueDeploymentJob({ deploymentId: nextDeploymentId, userId: session.user.email });
    await pool.query(
      `INSERT INTO deployment_events (deployment_id, status, message)
       VALUES ($1, 'queued', 'Deployment job enqueued successfully; waiting for AWS consumer pickup')`,
      [nextDeploymentId],
    );
  } catch (error) {
    await markDeploymentFailed(nextDeploymentId, error);
    const message = error instanceof Error ? error.message : "Failed to enqueue deployment";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }

  return NextResponse.json({ ok: true, redeployed: true, deploymentId: nextDeploymentId });
}
