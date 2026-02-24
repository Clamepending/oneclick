import Link from "next/link";
import { notFound } from "next/navigation";
import { auth } from "@/lib/auth";
import { ensureSchema, pool } from "@/lib/db";
import { DeploymentActions } from "@/components/deployment/DeploymentActions";

type BotIdentityRow = {
  bot_name: string;
  bot_name_normalized: string;
  runtime_slug: string;
};

type DeploymentRow = {
  id: string;
  bot_name: string | null;
  status: "queued" | "starting" | "ready" | "failed";
  host_name: string | null;
  runtime_id: string | null;
  deploy_provider: string | null;
  ready_url: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
};

function getStatusMeta(status: DeploymentRow["status"]) {
  if (status === "ready") return { label: "READY", color: "#1f9d55", bg: "rgba(31,157,85,0.18)" };
  if (status === "failed") return { label: "FAILED", color: "#ff6b6b", bg: "rgba(255,107,107,0.2)" };
  if (status === "starting") return { label: "STARTING", color: "#f5c542", bg: "rgba(245,197,66,0.2)" };
  return { label: "QUEUED", color: "#7ea7ff", bg: "rgba(126,167,255,0.2)" };
}

export default async function BotPage({ params }: { params: Promise<{ slug: string }> }) {
  const session = await auth();
  const userId = session?.user?.email?.trim();
  if (!userId) {
    notFound();
  }

  const { slug } = await params;
  const runtimeSlug = slug.trim().toLowerCase();
  if (!runtimeSlug) {
    notFound();
  }

  await ensureSchema();

  const identityResult = await pool.query<BotIdentityRow>(
    `SELECT bot_name, bot_name_normalized, runtime_slug
     FROM bot_identities
     WHERE owner_user_id = $1
       AND runtime_slug = $2
     LIMIT 1`,
    [userId, runtimeSlug],
  );

  const identity = identityResult.rows[0];
  if (!identity) {
    notFound();
  }

  const deploymentsResult = await pool.query<DeploymentRow>(
    `SELECT
       id,
       bot_name,
       status,
       host_name,
       runtime_id,
       deploy_provider,
       ready_url,
       error,
       created_at,
       updated_at
     FROM deployments
     WHERE user_id = $1
       AND lower(regexp_replace(trim(COALESCE(bot_name, '')), '\s+', ' ', 'g')) = $2
     ORDER BY updated_at DESC
     LIMIT 50`,
    [userId, identity.bot_name_normalized],
  );

  return (
    <main className="container">
      <div className="card" style={{ display: "grid", gap: 8 }}>
        <div className="row" style={{ justifyContent: "space-between", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <h1 style={{ margin: 0 }}>Bot dashboard</h1>
          <Link className="button secondary" href="/">
            Back to all bots
          </Link>
        </div>
        <p className="muted" style={{ marginBottom: 0 }}>
          Bot: <code>{identity.bot_name}</code>
        </p>
        <p className="muted" style={{ marginBottom: 0 }}>
          URL slug: <code>{identity.runtime_slug}</code>
        </p>
        <p className="muted" style={{ marginBottom: 0 }}>
          Total deployments: <code>{deploymentsResult.rows.length}</code>
        </p>
      </div>

      <section className="card" style={{ marginTop: 14 }}>
        <h2 style={{ marginTop: 0 }}>Deployments</h2>
        {deploymentsResult.rows.length === 0 ? (
          <p className="muted">No deployments found for this bot yet.</p>
        ) : (
          <div style={{ display: "grid", gap: 10 }}>
            {deploymentsResult.rows.map((deployment) => {
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
                        whiteSpace: "nowrap",
                      }}
                    >
                      {statusMeta.label}
                    </span>
                  </div>
                  <div style={{ display: "grid", gap: 6 }}>
                    <p className="muted" style={{ margin: 0 }}>
                      Provider: <code>{deployment.deploy_provider ?? "pending"}</code>
                    </p>
                    <p className="muted" style={{ margin: 0 }}>
                      Runtime: <code>{deployment.runtime_id ?? "pending"}</code>
                    </p>
                    <p className="muted" style={{ margin: 0 }}>
                      Host: <code>{deployment.host_name ?? "pending"}</code>
                    </p>
                    <p className="muted" style={{ margin: 0 }}>
                      Updated: <code>{new Date(deployment.updated_at).toLocaleString()}</code>
                    </p>
                  </div>
                  {deployment.status === "failed" && deployment.error ? (
                    <p style={{ color: "#ff8e8e", margin: 0 }}>{deployment.error}</p>
                  ) : null}
                  <div className="row">
                    <Link className="button secondary" href={`/deployments/${deployment.id}`}>
                      View deployment details
                    </Link>
                    {deployment.status === "ready" && deployment.ready_url ? (
                      <a className="button" href={deployment.ready_url} target="_blank" rel="noreferrer">
                        Open OpenClaw
                      </a>
                    ) : null}
                  </div>
                  <DeploymentActions deploymentId={deployment.id} status={deployment.status} compact botName={deployment.bot_name} />
                </div>
              );
            })}
          </div>
        )}
      </section>
    </main>
  );
}
