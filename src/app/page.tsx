import Link from "next/link";
import { auth, signIn } from "@/lib/auth";
import { ensureSchema, pool } from "@/lib/db";
import { DeploymentActions } from "@/components/deployment/DeploymentActions";

type DeploymentSummary = {
  id: string;
  status: "queued" | "starting" | "ready" | "failed";
  host_name: string | null;
  runtime_id: string | null;
  deploy_provider: string | null;
  ready_url: string | null;
  error: string | null;
  updated_at: string;
};

function getStatusMeta(status: DeploymentSummary["status"]) {
  if (status === "ready") return { label: "READY", color: "#1f9d55", bg: "rgba(31,157,85,0.18)" };
  if (status === "failed") return { label: "FAILED", color: "#ff6b6b", bg: "rgba(255,107,107,0.2)" };
  if (status === "starting") return { label: "STARTING", color: "#f5c542", bg: "rgba(245,197,66,0.2)" };
  return { label: "QUEUED", color: "#7ea7ff", bg: "rgba(126,167,255,0.2)" };
}

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
        `SELECT id, status, host_name, runtime_id, deploy_provider, ready_url, error, updated_at
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
        {!deploymentLookupFailed && deployments.length === 0 ? (
          <p className="muted" style={{ marginBottom: 0 }}>
            No deployments yet. Start your first one to create a container.
          </p>
        ) : null}
        <div style={{ display: "grid", gap: 12 }}>
          {deployments.map((deployment) => {
            const statusMeta = getStatusMeta(deployment.status);

            return (
              <div
                key={deployment.id}
                style={{
                  display: "grid",
                  gap: 8,
                  border: "1px solid #243041",
                  borderRadius: 12,
                  padding: 14,
                  background: "#0f1521",
                }}
              >
                <div className="row" style={{ justifyContent: "space-between", alignItems: "center" }}>
                  <p className="muted" style={{ margin: 0 }}>
                    <code>{deployment.id}</code>
                  </p>
                  <span
                    style={{
                      fontSize: 12,
                      fontWeight: 700,
                      letterSpacing: 0.4,
                      padding: "6px 10px",
                      borderRadius: 999,
                      color: statusMeta.color,
                      background: statusMeta.bg,
                    }}
                  >
                    {statusMeta.label}
                  </span>
                </div>
                <p className="muted" style={{ margin: 0 }}>
                  Provider: <code>{deployment.deploy_provider ?? "pending"}</code> • Runtime:{" "}
                  <code>{deployment.runtime_id ?? "pending"}</code>
                </p>
                <p className="muted" style={{ margin: 0 }}>
                  Host: <code>{deployment.host_name ?? "pending"}</code> • Updated:{" "}
                  <code>{new Date(deployment.updated_at).toLocaleString()}</code>
                </p>
                {deployment.status === "failed" && deployment.error ? (
                  <p style={{ color: "#ff8e8e", margin: 0 }}>{deployment.error}</p>
                ) : null}
                <div className="row">
                  <Link className="button secondary" href={`/deployments/${deployment.id}`}>
                    View details
                  </Link>
                  {deployment.status === "ready" && deployment.ready_url ? (
                    <a className="button" href={deployment.ready_url} target="_blank" rel="noreferrer">
                      Open OpenClaw
                    </a>
                  ) : null}
                </div>
                <DeploymentActions deploymentId={deployment.id} status={deployment.status} compact />
              </div>
            );
          })}
        </div>
        <div className="row">
          <Link className="button secondary" href="/admin">
            Admin
          </Link>
        </div>
      </div>
    </main>
  );
}
