"use client";

type Props = {
  onDeploy: () => void;
  loading: boolean;
};

export function PlanStep({ onDeploy, loading }: Props) {
  return (
    <div className="card">
      <h2>Deployment mode</h2>
      <p className="muted">One deployment option: dedicated DigitalOcean VM per bot.</p>
      <div style={{ display: "grid", gap: 10, marginBottom: 12 }}>
        <div
          style={{
            textAlign: "left",
            border: "1px solid var(--border-strong)",
            borderRadius: 10,
            padding: 16,
            background: "var(--accent-surface)",
            color: "inherit",
          }}
        >
          <strong>DigitalOcean VM (Standard)</strong>
          <p className="muted" style={{ marginBottom: 8 }}>
            One VM per deployment with fixed runtime resources.
          </p>
          <ul className="muted" style={{ margin: 0, paddingLeft: 18, display: "grid", gap: 4 }}>
            <li>1 vCPU / 2 GB RAM</li>
            <li>Standard Droplet storage</li>
            <li>Dedicated host and persistent bot state</li>
          </ul>
        </div>
      </div>
      <button className="button" type="button" onClick={onDeploy} disabled={loading}>
        {loading ? "Starting..." : "Start Deployment"}
      </button>
    </div>
  );
}
