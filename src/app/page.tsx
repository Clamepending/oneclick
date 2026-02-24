import Link from "next/link";
import { auth, signIn } from "@/lib/auth";
import { ensureSchema, pool } from "@/lib/db";
import { BotDashboard } from "@/components/deployment/BotDashboard";

type DeploymentSummary = {
  id: string;
  bot_name: string | null;
  status: "queued" | "starting" | "ready" | "failed";
  host_name: string | null;
  runtime_id: string | null;
  deploy_provider: string | null;
  ready_url: string | null;
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
          <p className="muted">Use Google to view and manage your OpenClaw containers.</p>
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
      const result = await pool.query<DeploymentSummary>(
        `SELECT id, bot_name, status, host_name, runtime_id, deploy_provider, ready_url, error, updated_at
         FROM deployments
         WHERE user_id = $1
         ORDER BY updated_at DESC
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
        <div className="row" style={{ justifyContent: "space-between", alignItems: "center" }}>
          <h1 style={{ margin: 0 }}>Your deployment dashboard</h1>
          <Link className="button" href="/onboarding">
            Start new deployment
          </Link>
        </div>
        <p className="muted">Track and open your OpenClaw containers in one place.</p>
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
              status: deployment.status,
              hostName: deployment.host_name,
              runtimeId: deployment.runtime_id,
              deployProvider: deployment.deploy_provider,
              readyUrl: deployment.ready_url,
              error: deployment.error,
              updatedAt: deployment.updated_at,
            }))}
          />
        ) : null}
        <div className="row">
          <Link className="button secondary" href="/admin">
            Admin
          </Link>
        </div>
      </div>
    </main>
  );
}
