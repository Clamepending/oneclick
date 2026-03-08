import { NextResponse } from "next/server";
import { GetFunctionConfigurationCommand, LambdaClient, type LambdaClientConfig } from "@aws-sdk/client-lambda";
import { auth } from "@/lib/auth";
import { ensureSchema, pool } from "@/lib/db";
import {
  normalizeDeploymentFlavor,
  normalizePlanTier,
  type DeploymentFlavor,
} from "@/lib/plans";
import { destroyDedicatedVm } from "@/lib/provisioner/dedicatedVm";
import { destroyUserRuntime } from "@/lib/provisioner/runtimeProvider";
import { getRuntimeBaseDomain } from "@/lib/subdomainConfig";
import { deactivateExpiredFreeTrialsForUser } from "@/lib/trialEnforcement";
import { buildRuntimeSubdomain, normalizeBotName } from "@/lib/provisioner/runtimeSlug";
import { applyMemoryRateLimit } from "@/lib/security/rateLimit";
import { cloneRuntimeHistoryForRedeploy } from "@/lib/runtime/redeployClone";
import { resolveDefaultRuntimeMetadata } from "@/lib/runtime/runtimeMetadata";
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
  endpoint: string;
  reason:
    | "ok"
    | "missing_sqs_queue_url"
    | "missing_aws_region";
};

function getQueueModeInfo(): QueueModeInfo {
  const region = readTrimmedEnv("AWS_REGION");
  const queueUrl = readTrimmedEnv("SQS_DEPLOYMENT_QUEUE_URL");
  if (!region) return { usable: false, endpoint: "", reason: "missing_aws_region" };
  if (!queueUrl) return { usable: false, endpoint: "", reason: "missing_sqs_queue_url" };
  return { usable: true, endpoint: queueUrl, reason: "ok" };
}

function isVercelRuntime() {
  return readBoolEnv("VERCEL", false) || readTrimmedEnv("VERCEL_ENV") !== "";
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

function buildAwsConfigWithTrimmedCreds(region: string): LambdaClientConfig {
  const accessKeyId = readTrimmedEnv("AWS_ACCESS_KEY_ID");
  const secretAccessKey = readTrimmedEnv("AWS_SECRET_ACCESS_KEY");
  const sessionToken = readTrimmedEnv("AWS_SESSION_TOKEN");
  if (!accessKeyId || !secretAccessKey) {
    return { region };
  }
  return {
    region,
    credentials: {
      accessKeyId,
      secretAccessKey,
      sessionToken: sessionToken || undefined,
    },
  };
}

function parseCsvSet(value: string) {
  return new Set(
    value
      .split(",")
      .map((item) => item.trim().toLowerCase())
      .filter(Boolean),
  );
}

type WorkerFeatureRequirement = {
  feature: string;
  label: string;
};

const BASE_WORKER_FEATURE: WorkerFeatureRequirement = {
  feature: "deployment_strategy_v2",
  label: "deployment strategy v2",
};

function getRequiredWorkerFeatures(
  selectedDeploymentFlavor: DeploymentFlavor,
): WorkerFeatureRequirement[] {
  const required: WorkerFeatureRequirement[] = [BASE_WORKER_FEATURE];
  if (selectedDeploymentFlavor === "simple_agent_videomemory_free") {
    required.push({ feature: "simple_agent_videomemory_free", label: "Simple Agent + VideoMemory" });
  }
  return required;
}

async function ensureQueueWorkerSupportsFlavor(input: {
  selectedDeploymentFlavor: DeploymentFlavor;
  queueInfo: QueueModeInfo;
}) {
  if (!input.queueInfo.usable) return { ok: true as const };
  const requiredFeatures = getRequiredWorkerFeatures(input.selectedDeploymentFlavor);

  const region = readTrimmedEnv("AWS_REGION");
  if (!region) {
    return {
      ok: false as const,
      error:
        "Deployments require AWS_REGION so OneClick can verify queue worker compatibility.",
    };
  }

  const functionName = readTrimmedEnv("DEPLOY_QUEUE_LAMBDA_FUNCTION_NAME") || "oneclick-sqs-deploy-consumer";
  try {
    const lambda = new LambdaClient(buildAwsConfigWithTrimmedCreds(region));
    const config = await lambda.send(
      new GetFunctionConfigurationCommand({
        FunctionName: functionName,
      }),
    );
    const workerFeatures = parseCsvSet(
      config.Environment?.Variables?.DEPLOY_WORKER_FEATURES ?? "",
    );
    const missingFeatures = requiredFeatures
      .filter((item) => !workerFeatures.has(item.feature) && !workerFeatures.has("*"))
      .map((item) => item.feature);
    if (missingFeatures.length > 0) {
      return {
        ok: false as const,
        error:
          `Deployments are blocked because queue worker ${functionName} is outdated (missing DEPLOY_WORKER_FEATURES=${missingFeatures.join(",")}). Update the Lambda consumer and retry.`,
      };
    }

    if (input.selectedDeploymentFlavor === "simple_agent_videomemory_free") {
      const hasDoToken = Boolean((config.Environment?.Variables?.DO_API_TOKEN ?? "").trim());
      const hasSshKey = Boolean((config.Environment?.Variables?.DEPLOY_SSH_PRIVATE_KEY ?? "").trim());
      const hasRuntimeBaseDomain = Boolean((config.Environment?.Variables?.RUNTIME_BASE_DOMAIN ?? "").trim());
      const missing: string[] = [];
      if (!hasDoToken) missing.push("DO_API_TOKEN");
      if (!hasSshKey) missing.push("DEPLOY_SSH_PRIVATE_KEY");
      if (!hasRuntimeBaseDomain) missing.push("RUNTIME_BASE_DOMAIN");
      if (missing.length > 0) {
        return {
          ok: false as const,
          error:
            `Simple Agent + VideoMemory is blocked because queue worker ${functionName} is missing required SSH runtime env vars: ${missing.join(", ")}.`,
        };
      }
    }

    return { ok: true as const };
  } catch (error) {
    const details = error instanceof Error ? error.message : String(error);
    return {
      ok: false as const,
      error:
        `Deployments are blocked because OneClick could not verify queue worker ${functionName}: ${details}`,
    };
  }
}

function readLimitEnv(name: string) {
  const value = readTrimmedEnv(name);
  if (!value) return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return Math.floor(parsed);
}

function isIgnorableRuntimeDestroyError(error: unknown) {
  if (!(error instanceof Error)) return false;
  const message = error.message.toLowerCase();
  return (
    message.includes("not found") ||
    message.includes("404") ||
    message.includes("does not exist") ||
    message.includes("serviceinactive") ||
    message.includes("servicenotfound")
  );
}

function parseDedicatedVmId(hostName: string | null | undefined) {
  const normalized = (hostName ?? "").trim();
  if (!normalized) return null;
  const match = normalized.match(/^(?:lightsail-vm|do-vm)-(\d+)$/);
  return match?.[1] ?? null;
}

async function cleanupDeploymentRuntime(input: {
  runtime_id: string | null;
  deploy_provider: string | null;
  ready_url: string | null;
  host_name: string | null;
}) {
  if (input.runtime_id) {
    await destroyUserRuntime({
      runtimeId: input.runtime_id,
      deployProvider: input.deploy_provider,
      readyUrl: input.ready_url,
      hostName: input.host_name,
    });
  }
  const vmId = parseDedicatedVmId(input.host_name);
  if (!vmId) return;
  await destroyDedicatedVm(vmId);
}

async function failStaleInProgressDeployments(userId: string) {
  const staleAfterMs = Number(process.env.DEPLOY_STALE_STARTING_TIMEOUT_MS ?? "900000");
  const staleMessage =
    "Deployment timed out while in progress. The deployment worker may be unavailable. Please redeploy.";
  const stale = await pool.query<{
    id: string;
    host_name: string | null;
    runtime_id: string | null;
    deploy_provider: string | null;
    ready_url: string | null;
  }>(
    `SELECT id, host_name, runtime_id, deploy_provider, ready_url
     FROM deployments
     WHERE user_id = $1
       AND status IN ('queued', 'starting')
       AND updated_at < NOW() - ($2::double precision * INTERVAL '1 millisecond')`,
    [userId, staleAfterMs],
  );

  for (const row of stale.rows) {
    let eventMessage = staleMessage;
    try {
      await cleanupDeploymentRuntime(row);
    } catch (error) {
      if (!isIgnorableRuntimeDestroyError(error)) {
        const details = error instanceof Error ? error.message : String(error);
        eventMessage = `${staleMessage} Cleanup warning: ${details}`;
      }
    }
    await pool.query(
      `UPDATE deployments
       SET status = 'failed',
           error = $2,
           updated_at = NOW()
       WHERE id = $1`,
      [row.id, staleMessage],
    );
    await pool.query(
      `INSERT INTO deployment_events (deployment_id, status, message)
       VALUES ($1, 'failed', $2)`,
      [row.id, eventMessage],
    );
  }
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
      planTier: null as "free" | "paid" | null,
      deploymentFlavor: null as DeploymentFlavor | null,
      sourceDeploymentId: null as string | null,
    };
  }

  const payload = (await request.json().catch(() => null)) as
    | { botName?: unknown; planTier?: unknown; deploymentFlavor?: unknown; sourceDeploymentId?: unknown }
    | null;
  if (!payload) {
    return {
      ok: true as const,
      botName: null as string | null,
      planTier: null as "free" | "paid" | null,
      deploymentFlavor: null as DeploymentFlavor | null,
      sourceDeploymentId: null as string | null,
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
  if (payload.sourceDeploymentId !== undefined && typeof payload.sourceDeploymentId !== "string") {
    return { ok: false as const, error: "sourceDeploymentId must be a string" };
  }

  const botName = payload.botName?.trim() ?? "";
  if (payload.botName !== undefined && (!botName || botName.length > 80)) {
    return { ok: false as const, error: "botName must be 1-80 characters" };
  }
  const sourceDeploymentId = payload.sourceDeploymentId?.trim() ?? "";
  if (payload.sourceDeploymentId !== undefined && (!sourceDeploymentId || sourceDeploymentId.length > 80)) {
    return { ok: false as const, error: "sourceDeploymentId must be 1-80 characters" };
  }
  return {
    ok: true as const,
    botName: botName || null,
    planTier: payload.planTier ? normalizePlanTier(payload.planTier) : null,
    deploymentFlavor: payload.deploymentFlavor ? normalizeDeploymentFlavor(payload.deploymentFlavor) : null,
    sourceDeploymentId: sourceDeploymentId || null,
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
  try {
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
    const sourceDeployment = parsedPayload.sourceDeploymentId
      ? await pool.query<{
          id: string;
          bot_name: string | null;
          deployment_flavor: string | null;
          model_provider: string | null;
          default_model: string | null;
        }>(
          `SELECT id, bot_name, deployment_flavor, model_provider, default_model
           FROM deployments
           WHERE id = $1 AND user_id = $2
           LIMIT 1`,
          [parsedPayload.sourceDeploymentId, session.user.email],
        )
      : null;
    const sourceDeploymentRow = sourceDeployment?.rows[0] ?? null;
    if (parsedPayload.sourceDeploymentId && !sourceDeploymentRow) {
      return NextResponse.json({ ok: false, error: "Source deployment not found." }, { status: 404 });
    }

    const fallbackBotName = onboarding.rows[0]?.bot_name?.trim() || "MyAssistant";
    const sourceBotName = sourceDeploymentRow?.bot_name?.trim() || null;
    const botName = parsedPayload.botName ?? sourceBotName ?? fallbackBotName;
    // Deployment keys must come from explicit setup inputs for that deployment.
    // Do not inherit stale model keys from onboarding session history.
    const openaiApiKey = null;
    const anthropicApiKey = null;
    const telegramBotToken = onboarding.rows[0]?.telegram_bot_token?.trim() || null;
    const selectedPlan = "free";
    const sourceDeploymentFlavor = sourceDeploymentRow?.deployment_flavor?.trim()
      ? normalizeDeploymentFlavor(sourceDeploymentRow.deployment_flavor)
      : null;
    const sourceModelProvider = sourceDeploymentRow?.model_provider?.trim() || null;
    const sourceDefaultModel = sourceDeploymentRow?.default_model?.trim() || null;
    const onboardingModelProviderValue = onboarding.rows[0]?.model_provider?.trim() || null;
    const selectedModelProvider = sourceModelProvider ?? onboardingModelProviderValue;
    const onboardingDeploymentFlavor = onboarding.rows[0]?.deployment_flavor?.trim()
      ? normalizeDeploymentFlavor(onboarding.rows[0].deployment_flavor)
      : null;
    const selectedDeploymentFlavor =
      sourceDeploymentFlavor ??
      parsedPayload.deploymentFlavor ??
      onboardingDeploymentFlavor ??
      "simple_agent_free";
    const runtimeMetadata = resolveDefaultRuntimeMetadata(selectedDeploymentFlavor);
    const queueInfo = getQueueModeInfo();
    const vercelRuntime = isVercelRuntime();
    const workerCompatibility = await ensureQueueWorkerSupportsFlavor({
      selectedDeploymentFlavor,
      queueInfo,
    });
    if (!workerCompatibility.ok) {
      return NextResponse.json({ ok: false, error: workerCompatibility.error }, { status: 503 });
    }
    const reservation = await reserveBotIdentity(session.user.email, botName);
    if (!reservation.ok) {
      return NextResponse.json({ ok: false, error: reservation.error }, { status: 409 });
    }

    await pool.query(
    `UPDATE onboarding_sessions
     SET plan = $1,
         trial_started_at = NULL,
         trial_expires_at = NULL,
         deployment_flavor = $2,
         updated_at = NOW()
     WHERE user_id = $3`,
    [
      selectedPlan,
      selectedDeploymentFlavor,
      session.user.email,
    ],
  );

    await pool.query(
    `INSERT INTO deployments (
       id, user_id, bot_name, status, model_provider, default_model, openai_api_key, anthropic_api_key, telegram_bot_token,
       plan_tier, deployment_flavor, trial_started_at, trial_expires_at, monthly_price_cents,
       runtime_kind, runtime_version, runtime_contract_version, runtime_release_channel
     )
     VALUES ($1, $2, $3, 'queued', $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)`,
    [
      deploymentId,
      session.user.email,
      botName,
      selectedModelProvider,
      sourceDefaultModel,
      openaiApiKey,
      anthropicApiKey,
      telegramBotToken,
      selectedPlan,
      selectedDeploymentFlavor,
      null,
      null,
      null,
      runtimeMetadata.runtimeKind,
      runtimeMetadata.runtimeVersion,
      runtimeMetadata.runtimeContractVersion,
      runtimeMetadata.runtimeReleaseChannel,
    ],
  );

    if (sourceDeploymentRow) {
      await pool.query(
        `INSERT INTO runtime_memory_docs (deployment_id, doc_key, content, created_at, updated_at)
         SELECT $1, doc_key, content, NOW(), NOW()
         FROM runtime_memory_docs
         WHERE deployment_id = $2
         ON CONFLICT (deployment_id, doc_key)
         DO UPDATE
           SET content = EXCLUDED.content,
               updated_at = NOW()`,
        [deploymentId, sourceDeploymentRow.id],
      );
      await pool.query(
        `INSERT INTO runtime_memory_doc_prefs (deployment_id, doc_key, self_update_enabled, created_at, updated_at)
         SELECT $1, doc_key, self_update_enabled, NOW(), NOW()
         FROM runtime_memory_doc_prefs
         WHERE deployment_id = $2
         ON CONFLICT (deployment_id, doc_key)
         DO UPDATE
           SET self_update_enabled = EXCLUDED.self_update_enabled,
               updated_at = NOW()`,
        [deploymentId, sourceDeploymentRow.id],
      );
      await cloneRuntimeHistoryForRedeploy({
        sourceDeploymentId: sourceDeploymentRow.id,
        targetDeploymentId: deploymentId,
      });
    }

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
      selectedDeploymentFlavor === "deploy_openclaw_free"
        ? "Selected deployment type: Simple Agent (Serverless)."
        : selectedDeploymentFlavor === "simple_agent_videomemory_free"
          ? "Selected deployment type: Simple Agent + VideoMemory (Free)."
          : "Selected deployment type: Simple Agent (Serverless).",
    ],
  );
  await pool.query(
    `INSERT INTO deployment_events (deployment_id, status, message)
     VALUES ($1, 'queued', $2)`,
    [
      deploymentId,
      `Runtime metadata pinned: kind=${runtimeMetadata.runtimeKind} version=${runtimeMetadata.runtimeVersion} contract=${runtimeMetadata.runtimeContractVersion} channel=${runtimeMetadata.runtimeReleaseChannel}`,
    ],
  );
  if (sourceDeploymentRow) {
    await pool.query(
      `INSERT INTO deployment_events (deployment_id, status, message)
       VALUES ($1, 'queued', $2)`,
      [deploymentId, `Redeploy requested from ${sourceDeploymentRow.id}; preserving deployment type.`],
    );
  }

    try {
      await pool.query(
      `INSERT INTO deployment_events (deployment_id, status, message)
       VALUES ($1, 'queued', $2)`,
      [
        deploymentId,
        `Queue routing: runtime=${vercelRuntime ? "vercel" : "node"} queueProvider=sqs queueUsable=${queueInfo.usable ? "yes" : "no"} endpoint=${summarizeQueueEndpoint(queueInfo.endpoint)} reason=${queueInfo.reason}`,
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
      console.info(`[deploy:${deploymentId}] enqueueing deployment job via SQS ${summarizeQueueEndpoint(queueInfo.endpoint)}`);
      await pool.query(
        `INSERT INTO deployment_events (deployment_id, status, message)
         VALUES ($1, 'queued', 'Queue available; enqueueing deployment job for AWS consumer')`,
        [deploymentId],
      );
      await enqueueDeploymentJob({ deploymentId, userId: session.user.email });
      await pool.query(
        `INSERT INTO deployment_events (deployment_id, status, message)
         VALUES ($1, 'queued', 'Deployment job enqueued successfully; waiting for AWS consumer pickup')`,
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
          "Deploy queue connection failed on production. The AWS deploy queue or consumer may be unavailable. Please try again shortly.";
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
  } catch (error) {
    const message = error instanceof Error ? error.message : "Deployment request failed";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
