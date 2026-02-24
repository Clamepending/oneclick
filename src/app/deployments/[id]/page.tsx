"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { ProgressTimeline } from "@/components/deployment/ProgressTimeline";

type DeploymentResponse = {
  id: string;
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

  return (
    <main className="container">
      <div className="card">
        <h1>Deployment dashboard</h1>
        <p className="muted" style={{ marginTop: -6 }}>
          {statusTitle}
        </p>
        {deployment ? (
          <div style={{ display: "grid", gap: 6 }}>
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
          <p>
            <a className="button" href={deployment.readyUrl} target="_blank" rel="noreferrer">
              Open OpenClaw
            </a>
          </p>
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
