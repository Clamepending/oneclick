"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { ProgressTimeline } from "@/components/deployment/ProgressTimeline";
import { DeploymentActions } from "@/components/deployment/DeploymentActions";

type DeploymentResponse = {
  id: string;
  botName?: string | null;
  status: "queued" | "starting" | "ready" | "failed";
  hostName?: string | null;
  runtimeId?: string | null;
  deployProvider?: string | null;
  readyUrl?: string | null;
  error?: string | null;
  createdAt?: string;
  updatedAt?: string;
  health?: {
    ok: boolean;
    status: number | null;
  } | null;
};

type EventResponse = {
  items: Array<{ status: string; message: string; ts: string }>;
};

function getStatusMeta(status?: DeploymentResponse["status"]) {
  if (status === "ready") return { label: "READY", color: "#1f9d55", bg: "rgba(31,157,85,0.18)" };
  if (status === "failed") return { label: "FAILED", color: "#ff6b6b", bg: "rgba(255,107,107,0.2)" };
  if (status === "starting") return { label: "STARTING", color: "#f5c542", bg: "rgba(245,197,66,0.2)" };
  if (status === "queued") return { label: "QUEUED", color: "#7ea7ff", bg: "rgba(126,167,255,0.2)" };
  return { label: "LOADING", color: "#b7bfd3", bg: "rgba(183,191,211,0.2)" };
}

export default function DeploymentDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const [deploymentId, setDeploymentId] = useState("");
  const [deployment, setDeployment] = useState<DeploymentResponse | null>(null);
  const [events, setEvents] = useState<EventResponse["items"]>([]);
  const [error, setError] = useState("");

  useEffect(() => {
    params.then((p) => setDeploymentId(p.id)).catch(() => setError("Invalid deployment id"));
  }, [params]);

  useEffect(() => {
    if (!deploymentId) return;

    const pollInterval = Number(process.env.NEXT_PUBLIC_DEPLOY_POLL_INTERVAL_MS ?? "10000");

    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | null = null;
    const poll = async () => {
      try {
        const [dRes, eRes] = await Promise.all([
          fetch(`/api/deployments/${deploymentId}`, { cache: "no-store" }),
          fetch(`/api/deployments/${deploymentId}/events`, { cache: "no-store" }),
        ]);

        if (!dRes.ok) throw new Error("Failed to fetch deployment");
        if (!eRes.ok) throw new Error("Failed to fetch deployment events");

        const dData = (await dRes.json()) as DeploymentResponse;
        const eData = (await eRes.json()) as EventResponse;
        if (!cancelled) {
          setDeployment(dData);
          setEvents(eData.items);
          setError("");
          if (dData.status === "ready" || dData.status === "failed") {
            if (timer) clearInterval(timer);
            timer = null;
          }
        }
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : "Unknown error");
        }
      }
    };

    void poll();
    timer = setInterval(() => {
      void poll();
    }, pollInterval);

    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
    };
  }, [deploymentId]);

  const statusTitle = useMemo(() => {
    if (!deployment) return "Loading deployment...";
    if (deployment.status === "ready") return "Deployment ready";
    if (deployment.status === "failed") return "Deployment failed";
    return "Deployment in progress";
  }, [deployment]);
  const statusMeta = getStatusMeta(deployment?.status);

  return (
    <main className="container">
      <div className="card">
        <div className="row" style={{ justifyContent: "space-between", alignItems: "center" }}>
          <h1 style={{ margin: 0 }}>Deployment dashboard</h1>
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
        <p className="muted" style={{ marginTop: -6 }}>
          {statusTitle}
        </p>
        {deployment ? (
          <div style={{ display: "grid", gap: 6 }}>
            <p className="muted">
              Bot: <code>{deployment.botName ?? "Unnamed bot"}</code>
            </p>
            <p className="muted">
              Deployment ID: <code>{deployment.id}</code>
            </p>
            <p className="muted">
              Provider: <code>{deployment.deployProvider ?? "unknown"}</code>
            </p>
            <p className="muted">
              Runtime ID: <code>{deployment.runtimeId ?? "pending"}</code>
            </p>
            <p className="muted">
              Host: <code>{deployment.hostName ?? "pending"}</code>
            </p>
            {deployment.health ? (
              <p className="muted">
                Health:{" "}
                <code>
                  {deployment.health.ok
                    ? `healthy (${deployment.health.status ?? "ok"})`
                    : `unhealthy (${deployment.health.status ?? "no response"})`}
                </code>
              </p>
            ) : null}
            <p className="muted">
              Updated:{" "}
              <code>
                {deployment.updatedAt ? new Date(deployment.updatedAt).toLocaleString() : "pending"}
              </code>
            </p>
          </div>
        ) : null}
        {deployment?.status === "ready" && deployment.readyUrl ? (
          <div style={{ display: "grid", gap: 8 }}>
            <p style={{ margin: 0 }}>
              <a className="button" href={deployment.readyUrl} target="_blank" rel="noreferrer">
                Open OpenClaw
              </a>
            </p>
            <p className="muted" style={{ margin: 0 }}>
              If you skipped API key setup during onboarding, add your customer&apos;s OpenAI or Anthropic key in
              runtime settings (never use a personal key).
            </p>
          </div>
        ) : null}
        {deployment ? (
          <DeploymentActions
            deploymentId={deployment.id}
            status={deployment.status}
            botName={deployment.botName}
          />
        ) : null}
        {deployment?.status === "failed" ? (
          <p style={{ color: "#ff8e8e" }}>{deployment.error ?? "Deployment failed."}</p>
        ) : null}
        {error ? <p style={{ color: "#ff8e8e" }}>{error}</p> : null}
      </div>

      <h2>Progress</h2>
      <ProgressTimeline items={events} />

      <p style={{ marginTop: 16 }}>
        <Link href="/onboarding" className="muted">
          Start another deployment
        </Link>
      </p>
    </main>
  );
}
