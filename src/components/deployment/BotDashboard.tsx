"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { DeploymentActions } from "@/components/deployment/DeploymentActions";
import { deploymentModeDisplayName, normalizeDeploymentFlavor, normalizePlanTier } from "@/lib/plans";

type DeploymentSummary = {
  id: string;
  botName: string | null;
  runtimeSlug?: string | null;
  botDashboardUrl?: string | null;
  status: "queued" | "starting" | "ready" | "failed" | "stopped" | "deactivated";
  hostName: string | null;
  runtimeId: string | null;
  deployProvider: string | null;
  planTier?: string | null;
  deploymentFlavor?: string | null;
  trialExpiresAt?: string | null;
  monthlyPriceCents?: number | null;
  hasOpenaiApiKey: boolean;
  hasAnthropicApiKey: boolean;
  hasOpenrouterApiKey: boolean;
  hasTelegramBotToken: boolean;
  readyUrl: string | null;
  error: string | null;
  updatedAt: string;
};

type BotGroup = {
  name: string;
  deployments: DeploymentSummary[];
};

type Props = {
  deployments: DeploymentSummary[];
};

function getStatusMeta(status: DeploymentSummary["status"]) {
  if (status === "ready") return { label: "READY", color: "#1f9d55", bg: "rgba(31,157,85,0.18)" };
  if (status === "failed") return { label: "FAILED", color: "#ff6b6b", bg: "rgba(255,107,107,0.2)" };
  if (status === "stopped") return { label: "STOPPED", color: "#c3c9d4", bg: "rgba(195,201,212,0.18)" };
  if (status === "deactivated") return { label: "DEACTIVATED", color: "#ff9f43", bg: "rgba(255,159,67,0.2)" };
  if (status === "starting") return { label: "STARTING", color: "#f5c542", bg: "rgba(245,197,66,0.2)" };
  return { label: "QUEUED", color: "#7ea7ff", bg: "rgba(126,167,255,0.2)" };
}

export function BotDashboard({ deployments }: Props) {
  const router = useRouter();
  const groups = useMemo<BotGroup[]>(() => {
    const byBot = new Map<string, DeploymentSummary[]>();
    for (const deployment of deployments) {
      const key = deployment.botName?.trim() || "Unnamed bot";
      const current = byBot.get(key) ?? [];
      current.push(deployment);
      byBot.set(key, current);
    }

    return Array.from(byBot.entries())
      .map(([name, groupedDeployments]) => ({
        name,
        deployments: groupedDeployments.sort(
          (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
        ),
      }))
      .sort(
        (a, b) =>
          new Date(b.deployments[0]?.updatedAt ?? 0).getTime() -
          new Date(a.deployments[0]?.updatedAt ?? 0).getTime(),
      );
  }, [deployments]);

  const [selectedBotName, setSelectedBotName] = useState<string>(groups[0]?.name ?? "");

  useEffect(() => {
    if (!groups.length) {
      setSelectedBotName("");
      return;
    }
    const stillExists = groups.some((group) => group.name === selectedBotName);
    if (!stillExists) {
      setSelectedBotName(groups[0].name);
    }
  }, [groups, selectedBotName]);

  const selectedGroup = groups.find((group) => group.name === selectedBotName) ?? null;
  const latestDeployment = selectedGroup?.deployments[0] ?? null;

  if (!groups.length) {
    return (
      <p className="muted" style={{ marginBottom: 0 }}>
        No deployments yet. Start your first one to create a container.
      </p>
    );
  }

  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))",
        gap: 16,
        alignItems: "start",
      }}
    >
      <div style={{ display: "grid", gap: 10, alignContent: "start" }}>
        {groups.map((group) => {
          const preview = group.deployments[0];
          const statusMeta = getStatusMeta(preview.status);
          const isActive = selectedBotName === group.name;

          return (
            <button
              key={group.name}
              type="button"
              onClick={() => {
                if (preview.botDashboardUrl && preview.status === "ready") {
                  router.push(preview.botDashboardUrl);
                  return;
                }
                setSelectedBotName(group.name);
              }}
              style={{
                textAlign: "left",
                border: "1px solid var(--border)",
                borderRadius: 12,
                padding: "10px 12px",
                background: isActive ? "rgba(255, 87, 95, 0.08)" : "var(--surface-strong)",
                color: "var(--text)",
                cursor: "pointer",
                display: "grid",
                gap: 6,
                transition: "border-color 120ms ease, transform 120ms ease",
                borderColor: isActive ? "var(--border-strong)" : "var(--border)",
              }}
            >
              <strong>{group.name}</strong>
              <p className="muted" style={{ margin: 0, fontSize: 13 }}>
                {group.deployments.length} deployment{group.deployments.length === 1 ? "" : "s"}
              </p>
              {preview.botDashboardUrl && preview.status === "ready" ? (
                <p className="muted" style={{ margin: 0, fontSize: 12 }}>
                  Bot page:{" "}
                  <Link
                    href={preview.botDashboardUrl}
                    onClick={(event) => event.stopPropagation()}
                    style={{ textDecoration: "underline", color: "var(--accent-soft)" }}
                  >
                    {preview.botDashboardUrl}
                  </Link>
                </p>
              ) : null}
              <span
                style={{
                  width: "fit-content",
                  fontSize: 11,
                  fontWeight: 700,
                  letterSpacing: 0.35,
                  padding: "5px 8px",
                  borderRadius: 999,
                  color: statusMeta.color,
                  background: statusMeta.bg,
                  whiteSpace: "nowrap",
                }}
              >
                {statusMeta.label}
              </span>
            </button>
          );
        })}
      </div>

      {selectedGroup ? (
        <div style={{ display: "grid", gap: 10 }}>
          <div
            style={{
              border: "1px solid var(--border)",
              borderRadius: 12,
              padding: 14,
              background: "var(--surface-strong)",
              display: "grid",
              gap: 6,
            }}
          >
            <h2 style={{ margin: 0 }}>{selectedGroup.name}</h2>
            <p className="muted" style={{ margin: 0 }}>
              {selectedGroup.deployments.length} total deployment
              {selectedGroup.deployments.length === 1 ? "" : "s"}
            </p>
            {latestDeployment ? (
              <p className="muted" style={{ margin: 0 }}>
                Latest update: <code>{new Date(latestDeployment.updatedAt).toLocaleString()}</code>
              </p>
            ) : null}
            {latestDeployment?.botDashboardUrl && latestDeployment.status === "ready" ? (
              <p style={{ margin: 0 }}>
                <Link className="button secondary" href={latestDeployment.botDashboardUrl}>
                  Open bot page
                </Link>
              </p>
            ) : null}
          </div>

          {selectedGroup.deployments.map((deployment) => {
            const statusMeta = getStatusMeta(deployment.status);
            return (
              <div
                key={deployment.id}
                style={{
                  display: "grid",
                  gap: 8,
                  border: "1px solid var(--border)",
                  borderRadius: 12,
                  padding: 14,
                  background: "var(--surface-strong)",
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
                    Provider: <code>{deployment.deployProvider ?? "pending"}</code>
                  </p>
                  <p className="muted" style={{ margin: 0 }}>
                    Plan:{" "}
                    <code>
                      {deploymentModeDisplayName(
                        normalizePlanTier(deployment.planTier),
                        normalizeDeploymentFlavor(deployment.deploymentFlavor),
                      )}
                      {deployment.planTier === "paid" && deployment.monthlyPriceCents
                        ? ` ($${(deployment.monthlyPriceCents / 100).toFixed(0)}/mo)`
                        : ""}
                    </code>
                  </p>
                  {deployment.trialExpiresAt ? (
                    <p className="muted" style={{ margin: 0 }}>
                      Trial expires: <code>{new Date(deployment.trialExpiresAt).toLocaleString()}</code>
                    </p>
                  ) : null}
                  <p className="muted" style={{ margin: 0 }}>
                    Runtime: <code>{deployment.runtimeId ?? "pending"}</code>
                  </p>
                  {deployment.deployProvider !== "ecs" ? (
                    <p className="muted" style={{ margin: 0 }}>
                      Host: <code>{deployment.hostName ?? "pending"}</code>
                    </p>
                  ) : null}
                  <p className="muted" style={{ margin: 0 }}>
                    Updated: <code>{new Date(deployment.updatedAt).toLocaleString()}</code>
                  </p>
                </div>
                {(deployment.status === "failed" || deployment.status === "stopped" || deployment.status === "deactivated") && deployment.error ? (
                  <p style={{ color: "var(--danger)", margin: 0 }}>{deployment.error}</p>
                ) : null}
                {(deployment.status === "queued" || deployment.status === "starting") ? (
                  <p className="muted" style={{ margin: 0 }}>
                    Deployments usually take ~10 minutes on DigitalOcean VM (image pull + startup).
                  </p>
                ) : null}
                {deployment.status === "ready" ? (
                  <div className="row">
                    <Link className="button" href={`/runtime/${deployment.id}`}>
                      Open UI
                    </Link>
                  </div>
                ) : null}
                <DeploymentActions
                  deploymentId={deployment.id}
                  status={deployment.status}
                  runtimeId={deployment.runtimeId}
                  deployProvider={deployment.deployProvider}
                  compact
                  botName={deployment.botName}
                  deploymentFlavor={normalizeDeploymentFlavor(deployment.deploymentFlavor)}
                />
              </div>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
