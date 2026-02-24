"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { DeploymentActions } from "@/components/deployment/DeploymentActions";

type DeploymentSummary = {
  id: string;
  botName: string | null;
  status: "queued" | "starting" | "ready" | "failed";
  hostName: string | null;
  runtimeId: string | null;
  deployProvider: string | null;
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
  if (status === "starting") return { label: "STARTING", color: "#f5c542", bg: "rgba(245,197,66,0.2)" };
  return { label: "QUEUED", color: "#7ea7ff", bg: "rgba(126,167,255,0.2)" };
}

export function BotDashboard({ deployments }: Props) {
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
        gridTemplateColumns: "minmax(220px, 1fr) minmax(0, 2fr)",
        gap: 14,
        alignItems: "start",
      }}
    >
      <div style={{ display: "grid", gap: 10 }}>
        {groups.map((group) => {
          const preview = group.deployments[0];
          const statusMeta = getStatusMeta(preview.status);
          const isActive = selectedBotName === group.name;

          return (
            <button
              key={group.name}
              type="button"
              onClick={() => setSelectedBotName(group.name)}
              style={{
                textAlign: "left",
                border: "1px solid #243041",
                borderRadius: 12,
                padding: "10px 12px",
                background: isActive ? "#182135" : "#0f1521",
                color: "#f5f7fa",
                cursor: "pointer",
                display: "grid",
                gap: 6,
              }}
            >
              <strong>{group.name}</strong>
              <p className="muted" style={{ margin: 0, fontSize: 13 }}>
                {group.deployments.length} deployment{group.deployments.length === 1 ? "" : "s"}
              </p>
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
              border: "1px solid #243041",
              borderRadius: 12,
              padding: 14,
              background: "#0f1521",
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
          </div>

          {selectedGroup.deployments.map((deployment) => {
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
                  Provider: <code>{deployment.deployProvider ?? "pending"}</code> • Runtime:{" "}
                  <code>{deployment.runtimeId ?? "pending"}</code>
                </p>
                <p className="muted" style={{ margin: 0 }}>
                  Host: <code>{deployment.hostName ?? "pending"}</code> • Updated:{" "}
                  <code>{new Date(deployment.updatedAt).toLocaleString()}</code>
                </p>
                {deployment.status === "failed" && deployment.error ? (
                  <p style={{ color: "#ff8e8e", margin: 0 }}>{deployment.error}</p>
                ) : null}
                <div className="row">
                  <Link className="button secondary" href={`/deployments/${deployment.id}`}>
                    View details
                  </Link>
                  {deployment.status === "ready" && deployment.readyUrl ? (
                    <a className="button" href={deployment.readyUrl} target="_blank" rel="noreferrer">
                      Open OpenClaw
                    </a>
                  ) : null}
                </div>
                <DeploymentActions
                  deploymentId={deployment.id}
                  status={deployment.status}
                  compact
                  botName={deployment.botName}
                />
              </div>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
