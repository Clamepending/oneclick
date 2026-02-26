import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { ensureSchema, pool } from "@/lib/db";
import {
  computeFreeTrialExpiry,
  normalizeDeploymentFlavor,
  FREE_TRIAL_DAYS,
  isFreeTrialExpired,
  normalizePlanTier,
  PAID_MONTHLY_PRICE_CENTS,
  type PlanTier,
} from "@/lib/plans";
import { getRuntimeBaseDomain } from "@/lib/subdomainConfig";
import { deactivateExpiredFreeTrialsForUser, freeTrialExpiredMessage } from "@/lib/trialEnforcement";
import { buildRuntimeSubdomain, normalizeBotName } from "@/lib/provisioner/runtimeSlug";
import { applyMemoryRateLimit } from "@/lib/security/rateLimit";
import {
  enqueueDeploymentJob,
  markDeploymentFailed,
  newDeploymentId,
  processDeploymentJob,
} from "@/workers/deployWorker";

type BotIdentityRow = {
  owner_user_id: string;
  bot_name: string;
  bot_name_normalized: string;
  runtime_slug: string;
};

function getClientIp(request: Request) {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0].trim();
  return "unknown";
}

type QueueModeInfo = {
  usable: boolean;
  redisUrl: string;
  reason:
    | "ok"
    | "missing_redis_url"
    | "localhost_redis_url";
};

function getQueueModeInfo(): QueueModeInfo {
  const redisUrl = readTrimmedEnv("REDIS_URL");
  if (!redisUrl) {
    return { usable: false, redisUrl: "", reason: "missing_redis_url" };
  }
  if (redisUrl.includes("127.0.0.1") || redisUrl.includes("localhost")) {
    return { usable: false, redisUrl, reason: "localhost_redis_url" };
  }
  return { usable: true, redisUrl, reason: "ok" };
}

function isVercelRuntime() {
  return readBoolEnv("VERCEL", false) || readTrimmedEnv("VERCEL_ENV") !== "";
}

function summarizeRedisUrl(raw: string) {
  if (!raw) return "none";
  try {
    const url = new URL(raw);
    return `${url.protocol}//${url.hostname}${url.port ? `:${url.port}` : ""}`;
  } catch {
    return raw.slice(0, 40);
  }
}

function queueUnavailableMessage(queueInfo: QueueModeInfo) {
  if (queueInfo.reason === "missing_redis_url") {
    return "Deployment queue unavailable: REDIS_URL is not configured. Deployments require a running worker + Redis in production.";
  }
  if (queueInfo.reason === "localhost_redis_url") {
    return "Deployment queue unavailable: REDIS_URL points to localhost, which is not usable from Vercel. Configure a hosted Redis and run the deployment worker.";
  }
  return "Deployment queue unavailable. Please try again shortly.";
}

function readTrimmedEnv(name: string) {
  const raw = process.env[name];
  if (!raw) return "";
  return raw.trim().replace(/^"(.*)"$/, "$1").replace(/\\n/g, "").trim();
}

function readBoolEnv(name: string, fallback = false) {
  const value = readTrimmedEnv(name).toLowerCase();
  if (!value) return fallback;
  if (["1", "true", "yes", "on"].includes(value)) return true;
  if (["0", "false", "no", "off"].includes(value)) return false;
  return fallback;
}

function readLimitEnv(name: string) {
  const value = readTrimmedEnv(name);
  if (!value) return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return Math.floor(parsed);
}

async function failStaleInProgressDeployments(userId: string) {
  const staleAfterMs = Number(process.env.DEPLOY_STALE_STARTING_TIMEOUT_MS ?? "900000");
  const staleMessage =
    "Deployment timed out while in progress. The deployment worker may be unavailable. Please redeploy.";
  await pool.query(
    `WITH stale AS (
       UPDATE deployments
       SET status = 'failed',
           error = $2,
           updated_at = NOW()
       WHERE user_id = $1
         AND status IN ('queued', 'starting')
         AND updated_at < NOW() - ($3::double precision * INTERVAL '1 millisecond')
       RETURNING id
     )
     INSERT INTO deployment_events (deployment_id, status, message)
     SELECT id, 'failed', $2
     FROM stale`,
    [userId, staleMessage, staleAfterMs],
  );
}

function startInProcessDeployment(deploymentId: string, userId: string) {
  setTimeout(() => {
    void processDeploymentJob({ deploymentId, userId }).catch(async (error) => {
      await markDeploymentFailed(deploymentId, error);
    });
  }, 0);
}

async function readDeployRequest(request: Request) {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) {
    return {
      ok: true as const,
      botName: null as string | null,
      planTier: null as PlanTier | null,
      deploymentFlavor: null as "basic" | "advanced" | null,
    };
  }

  const payload = (await request.json().catch(() => null)) as
    | { botName?: unknown; planTier?: unknown; deploymentFlavor?: unknown }
    | null;
  if (!payload) {
    return {
      ok: true as const,
      botName: null as string | null,
      planTier: null as PlanTier | null,
      deploymentFlavor: null as "basic" | "advanced" | null,
    };
  }
  if (payload.botName !== undefined && typeof payload.botName !== "string") {
    return { ok: false as const, error: "botName must be a string" };
  }
  if (payload.planTier !== undefined && typeof payload.planTier !== "string") {
    return { ok: false as const, error: "planTier must be a string" };
  }
  if (payload.deploymentFlavor !== undefined && typeof payload.deploymentFlavor !== "string") {
    return { ok: false as const, error: "deploymentFlavor must be a string" };
  }

  const botName = payload.botName?.trim() ?? "";
  if (payload.botName !== undefined && (!botName || botName.length > 80)) {
    return { ok: false as const, error: "botName must be 1-80 characters" };
  }
  return {
    ok: true as const,
    botName: botName || null,
    planTier: payload.planTier ? normalizePlanTier(payload.planTier) : null,
    deploymentFlavor: payload.deploymentFlavor ? normalizeDeploymentFlavor(payload.deploymentFlavor) : null,
  };
}

function buildRuntimeUrlPreview(runtimeSlug: string) {
  const baseDomain = getRuntimeBaseDomain();
  if (!baseDomain) return null;
  return `https://${runtimeSlug}.${baseDomain}`;
}

function uniqueViolation(error: unknown) {
  if (!error || typeof error !== "object") return false;
  return "code" in error && (error as { code?: string }).code === "23505";
}

function getBotIdentityConflictMessage(
  rows: BotIdentityRow[],
  ownerUserId: string,
  botNameNormalized: string,
  runtimeSlug: string,
) {
  const nameTakenByAnother = rows.find(
    (row) => row.bot_name_normalized === botNameNormalized && row.owner_user_id !== ownerUserId,
  );
  if (nameTakenByAnother) {
    return "This bot name is already taken. Choose a different bot name.";
  }

  const slugTakenByAnother = rows.find(
    (row) => row.runtime_slug === runtimeSlug && row.owner_user_id !== ownerUserId,
  );
  if (slugTakenByAnother) {
    const previewUrl = buildRuntimeUrlPreview(runtimeSlug);
    if (previewUrl) {
      return `This bot name conflicts with an existing runtime URL (${previewUrl}). Choose a different bot name.`;
    }
    return `This bot name conflicts with an existing runtime slug "${runtimeSlug}". Choose a different bot name.`;
  }

  const slugTakenBySameUser = rows.find(
    (row) =>
      row.runtime_slug === runtimeSlug &&
      row.owner_user_id === ownerUserId &&
      row.bot_name_normalized !== botNameNormalized,
  );
  if (slugTakenBySameUser) {
    const previewUrl = buildRuntimeUrlPreview(runtimeSlug);
    if (previewUrl) {
      return `You already have a bot name that uses ${previewUrl}. Choose a different bot name to avoid URL conflicts.`;
    }
    return `You already have a bot name that uses runtime slug "${runtimeSlug}". Choose a different bot name.`;
  }

  return null;
}

async function reserveBotIdentity(ownerUserId: string, botName: string) {
  const botNameNormalized = normalizeBotName(botName);
  if (!botNameNormalized) {
    return { ok: false as const, error: "botName must be 1-80 characters" };
  }
  const runtimeSlug = buildRuntimeSubdomain(botName, ownerUserId);
  const query = `SELECT owner_user_id, bot_name, bot_name_normalized, runtime_slug
                 FROM bot_identities
                 WHERE bot_name_normalized = $1 OR runtime_slug = $2`;

  const existingBefore = await pool.query<BotIdentityRow>(query, [botNameNormalized, runtimeSlug]);
  const beforeConflict = getBotIdentityConflictMessage(
    existingBefore.rows,
    ownerUserId,
    botNameNormalized,
    runtimeSlug,
  );
  if (beforeConflict) {
    return { ok: false as const, error: beforeConflict };
  }

  const alreadyOwned = existingBefore.rows.find(
    (row) => row.owner_user_id === ownerUserId && row.bot_name_normalized === botNameNormalized,
  );
  if (alreadyOwned) {
    await pool.query(
      `UPDATE bot_identities
       SET bot_name = $1,
           updated_at = NOW()
       WHERE owner_user_id = $2
         AND bot_name_normalized = $3`,
      [botName, ownerUserId, botNameNormalized],
    );
    return { ok: true as const };
  }

  try {
    await pool.query(
      `INSERT INTO bot_identities (owner_user_id, bot_name, bot_name_normalized, runtime_slug)
       VALUES ($1, $2, $3, $4)`,
      [ownerUserId, botName, botNameNormalized, runtimeSlug],
    );
    return { ok: true as const };
  } catch (error) {
    if (!uniqueViolation(error)) throw error;
    const existingAfter = await pool.query<BotIdentityRow>(query, [botNameNormalized, runtimeSlug]);
    const afterConflict = getBotIdentityConflictMessage(
      existingAfter.rows,
      ownerUserId,
      botNameNormalized,
      runtimeSlug,
    );
    if (afterConflict) {
      return { ok: false as const, error: afterConflict };
    }
    throw error;
  }
}

export async function POST(request: Request) {
  const session = await auth();
  if (!session?.user?.email) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  const parsedPayload = await readDeployRequest(request);
  if (!parsedPayload.ok) {
    return NextResponse.json({ ok: false, error: parsedPayload.error }, { status: 400 });
  }

  const ip = getClientIp(request);
  const ipLimit = applyMemoryRateLimit(
    `deploy:ip:${ip}`,
    Number(process.env.DEPLOY_RATE_LIMIT_PER_MIN ?? "5"),
    60_000,
  );
  if (!ipLimit.allowed) {
    return NextResponse.json({ ok: false, error: "Too many requests" }, { status: 429 });
  }

  await ensureSchema();
  if (readBoolEnv("DEPLOYMENTS_PAUSED", false)) {
    return NextResponse.json(
      { ok: false, error: "New deployments are temporarily paused. Please try again later." },
      { status: 503 },
    );
  }

  await failStaleInProgressDeployments(session.user.email);
  await deactivateExpiredFreeTrialsForUser(session.user.email);

  const globalInProgressLimit = readLimitEnv("DEPLOY_MAX_IN_PROGRESS_GLOBAL");
  if (globalInProgressLimit !== null) {
    const globalInProgress = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text as count
       FROM deployments
       WHERE status IN ('queued', 'starting')`,
      [],
    );
    if (Number(globalInProgress.rows[0]?.count ?? "0") >= globalInProgressLimit) {
      return NextResponse.json(
        { ok: false, error: "System is at deployment capacity. Please try again shortly." },
        { status: 503 },
      );
    }
  }

  const globalReadyLimit = readLimitEnv("DEPLOY_MAX_READY_GLOBAL");
  if (globalReadyLimit !== null) {
    const globalReady = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text as count
       FROM deployments
       WHERE status = 'ready'`,
      [],
    );
    if (Number(globalReady.rows[0]?.count ?? "0") >= globalReadyLimit) {
      return NextResponse.json(
        { ok: false, error: "System runtime capacity is full. Please try again later." },
        { status: 503 },
      );
    }
  }

  const active = await pool.query<{ count: string }>(
    `SELECT COUNT(*)::text as count
     FROM deployments
     WHERE user_id = $1 AND status IN ('queued', 'starting')`,
    [session.user.email],
  );

  const maxActive = Number(process.env.DEPLOY_MAX_ACTIVE_PER_USER ?? "1");
  if (Number(active.rows[0]?.count ?? "0") >= maxActive) {
    return NextResponse.json(
      { ok: false, error: "You already have an active deployment in progress." },
      { status: 409 },
    );
  }

  const perUserReadyLimit = readLimitEnv("DEPLOY_MAX_READY_PER_USER");
  if (perUserReadyLimit !== null) {
    const activeReady = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text as count
       FROM deployments
       WHERE user_id = $1 AND status = 'ready'`,
      [session.user.email],
    );
    if (Number(activeReady.rows[0]?.count ?? "0") >= perUserReadyLimit) {
      return NextResponse.json(
        { ok: false, error: "You have reached the maximum number of running bots for your account." },
        { status: 409 },
      );
    }
  }

  const deploymentId = newDeploymentId();
  const onboarding = await pool.query<{
    bot_name: string | null;
    model_provider: string | null;
    model_api_key: string | null;
    telegram_bot_token: string | null;
    plan: string | null;
    deployment_flavor: string | null;
    trial_started_at: string | null;
    trial_expires_at: string | null;
  }>(
    `SELECT bot_name, model_provider, model_api_key, telegram_bot_token, plan, deployment_flavor, trial_started_at, trial_expires_at
     FROM onboarding_sessions
     WHERE user_id = $1
     LIMIT 1`,
    [session.user.email],
  );
  const fallbackBotName = onboarding.rows[0]?.bot_name?.trim() || "MyAssistant";
  const botName = parsedPayload.botName ?? fallbackBotName;
  const modelProvider = onboarding.rows[0]?.model_provider?.trim() || "";
  const modelApiKey = onboarding.rows[0]?.model_api_key?.trim() || "";
  const openaiApiKey = modelProvider === "openai" ? modelApiKey : null;
  const anthropicApiKey = modelProvider === "anthropic" ? modelApiKey : null;
  const telegramBotToken = onboarding.rows[0]?.telegram_bot_token?.trim() || null;
  const selectedPlan = parsedPayload.planTier ?? normalizePlanTier(onboarding.rows[0]?.plan);
  const selectedDeploymentFlavor =
    selectedPlan === "paid"
      ? "basic"
      : parsedPayload.deploymentFlavor ?? normalizeDeploymentFlavor(onboarding.rows[0]?.deployment_flavor);
  const existingTrialStartedAt = onboarding.rows[0]?.trial_started_at ?? null;
  const existingTrialExpiresAt = onboarding.rows[0]?.trial_expires_at ?? null;
  let trialStartedAt: Date | null = null;
  let trialExpiresAt: Date | null = null;
  if (selectedPlan === "free") {
    trialStartedAt = existingTrialStartedAt ? new Date(existingTrialStartedAt) : new Date();
    trialExpiresAt = existingTrialExpiresAt ? new Date(existingTrialExpiresAt) : computeFreeTrialExpiry(trialStartedAt);
    if (isFreeTrialExpired(trialExpiresAt)) {
      return NextResponse.json(
        {
          ok: false,
          error: `${freeTrialExpiredMessage()} Select the paid tier ($20/month) to deploy again.`,
        },
        { status: 402 },
      );
    }

    const maxFreeActivePerUser = readLimitEnv("DEPLOY_MAX_FREE_ACTIVE_PER_USER") ?? 1;
    const freeActive = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text as count
       FROM deployments
       WHERE user_id = $1
         AND status IN ('queued', 'starting', 'ready')
         AND COALESCE(NULLIF(TRIM(plan_tier), ''), 'free') = 'free'`,
      [session.user.email],
    );
    const freeActiveCount = Number(freeActive.rows[0]?.count ?? "0");
    if (freeActiveCount >= maxFreeActivePerUser) {
      return NextResponse.json(
        {
          ok: false,
          error: "Free tier allows only one active deployment at a time. Stop or upgrade the existing free bot before deploying another.",
          freeActiveDeployments: freeActiveCount,
          freeActiveLimit: maxFreeActivePerUser,
        },
        { status: 409 },
      );
    }
  }
  const reservation = await reserveBotIdentity(session.user.email, botName);
  if (!reservation.ok) {
    return NextResponse.json({ ok: false, error: reservation.error }, { status: 409 });
  }

  await pool.query(
    `UPDATE onboarding_sessions
     SET plan = $1,
         trial_started_at = CASE
           WHEN $1 = 'free' THEN COALESCE(trial_started_at, $2)
           ELSE trial_started_at
         END,
         trial_expires_at = CASE
           WHEN $1 = 'free' THEN COALESCE(trial_expires_at, $3)
           ELSE trial_expires_at
         END,
         deployment_flavor = $4,
         updated_at = NOW()
     WHERE user_id = $5`,
    [
      selectedPlan,
      trialStartedAt?.toISOString() ?? null,
      trialExpiresAt?.toISOString() ?? null,
      selectedDeploymentFlavor,
      session.user.email,
    ],
  );

  await pool.query(
    `INSERT INTO deployments (
       id, user_id, bot_name, status, openai_api_key, anthropic_api_key, telegram_bot_token,
       plan_tier, deployment_flavor, trial_started_at, trial_expires_at, monthly_price_cents
     )
     VALUES ($1, $2, $3, 'queued', $4, $5, $6, $7, $8, $9, $10, $11)`,
    [
      deploymentId,
      session.user.email,
      botName,
      openaiApiKey,
      anthropicApiKey,
      telegramBotToken,
      selectedPlan,
      selectedDeploymentFlavor,
      selectedPlan === "free" ? trialStartedAt?.toISOString() ?? null : null,
      selectedPlan === "free" ? trialExpiresAt?.toISOString() ?? null : null,
      selectedPlan === "paid" ? PAID_MONTHLY_PRICE_CENTS : null,
    ],
  );

  await pool.query(
    `INSERT INTO deployment_events (deployment_id, status, message)
     VALUES ($1, 'queued', 'Deployment accepted and queued')`,
    [deploymentId],
  );
  await pool.query(
    `INSERT INTO deployment_events (deployment_id, status, message)
     VALUES ($1, 'queued', $2)`,
    [
      deploymentId,
      selectedPlan === "paid"
        ? `Paid tier selected ($20/month). Using upgraded runtime specs.`
        : `Free trial active for ${FREE_TRIAL_DAYS} days (expires ${trialExpiresAt?.toISOString() ?? "unknown"}).`,
    ],
  );
  if (selectedDeploymentFlavor === "advanced") {
    await pool.query(
      `INSERT INTO deployment_events (deployment_id, status, message)
       VALUES ($1, 'queued', 'Advanced mode selected: runtime will self-bootstrap OttoAuth instructions after startup.')`,
      [deploymentId],
    );
  }
  if (selectedPlan === "free") {
    const freeActiveAfterInsert = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text as count
       FROM deployments
       WHERE user_id = $1
         AND status IN ('queued', 'starting', 'ready')
         AND COALESCE(NULLIF(TRIM(plan_tier), ''), 'free') = 'free'`,
      [session.user.email],
    );
    await pool.query(
      `INSERT INTO deployment_events (deployment_id, status, message)
       VALUES ($1, 'queued', $2)`,
      [
        deploymentId,
        `Free-tier active deployments for user: ${Number(freeActiveAfterInsert.rows[0]?.count ?? "0")}/${readLimitEnv("DEPLOY_MAX_FREE_ACTIVE_PER_USER") ?? 1}.`,
      ],
    );
  }

  try {
    const queueInfo = getQueueModeInfo();
    const vercelRuntime = isVercelRuntime();
    await pool.query(
      `INSERT INTO deployment_events (deployment_id, status, message)
       VALUES ($1, 'queued', $2)`,
      [
        deploymentId,
        `Queue routing: provider=${vercelRuntime ? "vercel" : "node"} queueUsable=${queueInfo.usable ? "yes" : "no"} redis=${summarizeRedisUrl(queueInfo.redisUrl)} reason=${queueInfo.reason}`,
      ],
    );

    // Never do in-process background deployment on Vercel; it can be terminated mid-flight.
    if (!queueInfo.usable && vercelRuntime) {
      const message = queueUnavailableMessage(queueInfo);
      console.warn(`[deploy:${deploymentId}] ${message}`);
      await pool.query(
        `UPDATE deployments
         SET status = 'failed',
             error = $2,
             updated_at = NOW()
         WHERE id = $1`,
        [deploymentId, message],
      );
      await pool.query(
        `INSERT INTO deployment_events (deployment_id, status, message)
         VALUES ($1, 'failed', $2)`,
        [deploymentId, message],
      );
      return NextResponse.json({ ok: false, error: message }, { status: 503 });
    }

    if (!queueInfo.usable) {
      const fallbackMessage = `Queue unavailable (${queueInfo.reason}); using in-process deployment fallback.`;
      console.warn(`[deploy:${deploymentId}] ${fallbackMessage}`);
      await pool.query(
        `INSERT INTO deployment_events (deployment_id, status, message)
         VALUES ($1, 'starting', $2)`,
        [deploymentId, fallbackMessage],
      );
      startInProcessDeployment(deploymentId, session.user.email);
      return NextResponse.json({ id: deploymentId, status: "queued" }, { status: 202 });
    }

    try {
      console.info(`[deploy:${deploymentId}] enqueueing deployment job via Redis ${summarizeRedisUrl(queueInfo.redisUrl)}`);
      await pool.query(
        `INSERT INTO deployment_events (deployment_id, status, message)
         VALUES ($1, 'queued', 'Queue available; enqueueing deployment job for worker')`,
        [deploymentId],
      );
      await enqueueDeploymentJob({ deploymentId, userId: session.user.email });
      await pool.query(
        `INSERT INTO deployment_events (deployment_id, status, message)
         VALUES ($1, 'queued', 'Deployment job enqueued successfully; waiting for worker pickup')`,
        [deploymentId],
      );
    } catch (queueError) {
      const queueMessage =
        queueError instanceof Error ? queueError.message : String(queueError);
      const retryableQueueConnectivityError =
        queueMessage.includes("ECONNREFUSED") ||
        queueMessage.includes("ENOTFOUND") ||
        queueMessage.includes("ETIMEDOUT");
      console.warn(`[deploy:${deploymentId}] queue enqueue failed: ${queueMessage}`);
      await pool.query(
        `INSERT INTO deployment_events (deployment_id, status, message)
         VALUES ($1, 'starting', $2)`,
        [deploymentId, `Queue enqueue failed: ${queueMessage}`],
      );
      if (retryableQueueConnectivityError && vercelRuntime) {
        const message =
          "Deploy queue connection failed on production. The deployment worker may be unavailable or Redis may be unreachable. Please try again shortly.";
        await pool.query(
          `UPDATE deployments
           SET status = 'failed',
               error = $2,
               updated_at = NOW()
           WHERE id = $1`,
          [deploymentId, message],
        );
        await pool.query(
          `INSERT INTO deployment_events (deployment_id, status, message)
           VALUES ($1, 'failed', $2)`,
          [deploymentId, message],
        );
        return NextResponse.json({ ok: false, error: message }, { status: 503 });
      }
      if (retryableQueueConnectivityError) {
        await pool.query(
          `INSERT INTO deployment_events (deployment_id, status, message)
           VALUES ($1, 'starting', 'Falling back to in-process deployment after queue connectivity error')`,
          [deploymentId],
        );
        startInProcessDeployment(deploymentId, session.user.email);
        return NextResponse.json({ id: deploymentId, status: "queued" }, { status: 202 });
      }
      throw queueError;
    }
  } catch (error) {
    const message = await markDeploymentFailed(deploymentId, error);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }

  return NextResponse.json({ id: deploymentId, status: "queued" }, { status: 202 });
}
