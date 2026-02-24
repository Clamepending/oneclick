import Link from "next/link";
import { auth } from "@/lib/auth";
import { ensureSchema, pool } from "@/lib/db";

type LatestDeployment = {
  id: string;
  status: "queued" | "starting" | "ready" | "failed";
  ready_url: string | null;
  error: string | null;
  updated_at: string;
};

export default async function HomePage() {
  const session = await auth();
  let latestDeployment: LatestDeployment | null = null;
  let deploymentLookupFailed = false;

  if (session?.user?.email) {
    try {
      await ensureSchema();
      const result = await pool.query<LatestDeployment>(
        `SELECT id, status, ready_url, error, updated_at
         FROM deployments
         WHERE user_id = $1
         ORDER BY updated_at DESC
         LIMIT 1`,
        [session.user.email],
      );
      latestDeployment = result.rows[0] ?? null;
    } catch {
      deploymentLookupFailed = true;
    }
  }

  return (
    <main className="container">
      <div className="card">
        <h1>OneClick OpenClaw</h1>
        <p className="muted">
          Sign in, complete three quick steps, and launch your OpenClaw deployment.
        </p>
        {!session?.user ? (
          <Link className="button" href="/login">
            Continue with Google
          </Link>
        ) : (
          <div style={{ display: "grid", gap: 12 }}>
            {latestDeployment ? (
              <div style={{ display: "grid", gap: 4 }}>
                <p className="muted" style={{ marginBottom: 0 }}>
                  Latest deployment: <code>{latestDeployment.id}</code>
                </p>
                <p className="muted" style={{ marginBottom: 0 }}>
                  Status: <code>{latestDeployment.status.toUpperCase()}</code>
                </p>
                <p className="muted" style={{ marginBottom: 0 }}>
                  Updated: <code>{new Date(latestDeployment.updated_at).toLocaleString()}</code>
                </p>
                {latestDeployment.status === "ready" && latestDeployment.ready_url ? (
                  <p style={{ marginBottom: 0 }}>
                    <a className="button" href={latestDeployment.ready_url} target="_blank" rel="noreferrer">
                      Open OpenClaw
                    </a>
                  </p>
                ) : null}
                {latestDeployment.status === "failed" && latestDeployment.error ? (
                  <p style={{ color: "#ff8e8e", marginBottom: 0 }}>{latestDeployment.error}</p>
                ) : null}
                <p style={{ marginBottom: 0 }}>
                  <Link className="button secondary" href={`/deployments/${latestDeployment.id}`}>
                    View deployment details
                  </Link>
                </p>
              </div>
            ) : (
              <p className="muted" style={{ marginBottom: 0 }}>
                No deployments yet. Start one below.
              </p>
            )}
            {deploymentLookupFailed ? (
              <p className="muted" style={{ marginBottom: 0 }}>
                Deployment details are temporarily unavailable. You can still start a new deployment.
              </p>
            ) : null}

            <div className="row">
              <Link className="button" href="/onboarding">
                Start new deployment
              </Link>
              <Link className="button secondary" href="/admin">
                Admin
              </Link>
            </div>
          </div>
        )}
      </div>
    </main>
  );
}
