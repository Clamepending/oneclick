import Link from "next/link";
import { auth, signIn } from "@/lib/auth";
import { ensureSchema, pool } from "@/lib/db";
import { BotDashboard } from "@/components/deployment/BotDashboard";
import { buildBotDashboardUrl } from "@/lib/bots/botDashboardUrl";
import { buildVideoMemoryUrl } from "@/lib/runtime/videoMemoryUrl";
import { deactivateExpiredFreeTrialsForUser } from "@/lib/trialEnforcement";

type DeploymentSummary = {
  id: string;
  bot_name: string | null;
  runtime_slug: string | null;
  status: "queued" | "starting" | "ready" | "failed" | "stopped" | "deactivated";
  host_name: string | null;
  runtime_id: string | null;
  deploy_provider: string | null;
  plan_tier: string | null;
  deployment_flavor: string | null;
  trial_expires_at: string | null;
  deactivated_at: string | null;
  monthly_price_cents: number | null;
  has_openai_api_key: boolean;
  has_anthropic_api_key: boolean;
  has_openrouter_api_key: boolean;
  has_telegram_bot_token: boolean;
  ready_url: string | null;
  video_memory_ready_at: string | null;
  error: string | null;
  updated_at: string;
};

export default async function HomePage() {
  const session = await auth();

  if (!session?.user) {
    return (
      <main className="container">
        <div className="card">
          <h1>Sign in</h1>
          <p className="muted">Use Google to view and manage your deployed agent runtimes.</p>
          <form
            action={async () => {
              "use server";
              await signIn("google", { redirectTo: "/" });
            }}
          >
            <button className="button" type="submit">
              Continue with Google
            </button>
          </form>
        </div>
      </main>
    );
  }

  let deployments: DeploymentSummary[] = [];
  let deploymentLookupFailed = false;

  if (session.user.email) {
    try {
      await ensureSchema();
      await deactivateExpiredFreeTrialsForUser(session.user.email);
      const result = await pool.query<DeploymentSummary>(
        `SELECT
           d.id,
           d.bot_name,
           bi.runtime_slug,
           d.status,
           d.host_name,
           d.runtime_id,
           d.deploy_provider,
           d.plan_tier,
           d.deployment_flavor,
           d.trial_expires_at,
           d.deactivated_at,
           d.monthly_price_cents,
           CASE WHEN COALESCE(d.openai_api_key, '') <> '' THEN TRUE ELSE FALSE END AS has_openai_api_key,
           CASE WHEN COALESCE(d.anthropic_api_key, '') <> '' THEN TRUE ELSE FALSE END AS has_anthropic_api_key,
           CASE WHEN COALESCE(d.openrouter_api_key, '') <> '' THEN TRUE ELSE FALSE END AS has_openrouter_api_key,
           CASE WHEN COALESCE(d.telegram_bot_token, '') <> '' THEN TRUE ELSE FALSE END AS has_telegram_bot_token,
           d.ready_url,
           d.video_memory_ready_at,
           d.error,
           d.updated_at
         FROM deployments d
         LEFT JOIN bot_identities bi
           ON bi.owner_user_id = d.user_id
          AND bi.bot_name_normalized = lower(regexp_replace(trim(COALESCE(d.bot_name, '')), '\s+', ' ', 'g'))
         WHERE d.user_id = $1
         ORDER BY d.updated_at DESC
         LIMIT 25`,
        [session.user.email],
      );
      deployments = result.rows;
    } catch {
      deploymentLookupFailed = true;
    }
  }

  return (
    <main className="container">
      <div className="card">
        <div
          className="row"
          style={{ justifyContent: "space-between", alignItems: "center", gap: 10, flexWrap: "wrap" }}
        >
          <h1 style={{ margin: 0 }}>Your deployment dashboard</h1>
          <Link className="button" href="/onboarding">
            Start new deployment
          </Link>
        </div>
        <p className="muted">Track and open your agent runtimes in one place.</p>
        {deploymentLookupFailed ? (
          <p className="muted" style={{ marginBottom: 0 }}>
            Deployment details are temporarily unavailable. You can still start a new deployment.
          </p>
        ) : null}
        {!deploymentLookupFailed ? (
          <BotDashboard
            deployments={deployments.map((deployment) => ({
              id: deployment.id,
              botName: deployment.bot_name,
              runtimeSlug: deployment.runtime_slug,
              botDashboardUrl: buildBotDashboardUrl(deployment.runtime_slug),
              status: deployment.status,
              hostName: deployment.host_name,
              runtimeId: deployment.runtime_id,
              deployProvider: deployment.deploy_provider,
              planTier: deployment.plan_tier,
              deploymentFlavor: deployment.deployment_flavor,
              trialExpiresAt: deployment.trial_expires_at,
              deactivatedAt: deployment.deactivated_at,
              monthlyPriceCents: deployment.monthly_price_cents,
              hasOpenaiApiKey: deployment.has_openai_api_key,
              hasAnthropicApiKey: deployment.has_anthropic_api_key,
              hasOpenrouterApiKey: deployment.has_openrouter_api_key,
              hasTelegramBotToken: deployment.has_telegram_bot_token,
              readyUrl: deployment.ready_url,
              videoMemoryUrl: buildVideoMemoryUrl({
                deploymentId: deployment.id,
                deploymentFlavor: deployment.deployment_flavor,
                runtimeId: deployment.runtime_id,
                status: deployment.status,
                videoMemoryReadyAt: deployment.video_memory_ready_at,
                requireReadyMarker: true,
              }),
              error: deployment.error,
              updatedAt: deployment.updated_at,
            }))}
          />
        ) : null}
        <div className="row" style={{ justifyContent: "flex-end" }}>
          <Link className="button secondary" href="/admin">
            Admin
          </Link>
        </div>
      </div>
    </main>
  );
}
