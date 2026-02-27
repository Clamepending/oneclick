"use client";

type Props = {
  deploymentFlavor: "simple_agent_free" | "deploy_openclaw_free";
  onDeploymentFlavorChange: (value: "simple_agent_free" | "deploy_openclaw_free") => void;
  onDeploy: () => void;
  loading: boolean;
};

export function PlanStep({ deploymentFlavor, onDeploymentFlavorChange, onDeploy, loading }: Props) {
  return (
    <div className="card">
      <h2>Deployment mode</h2>
      <p className="muted">Choose which runtime to deploy (both free).</p>
      <div style={{ display: "grid", gap: 10, marginBottom: 12 }}>
        <button
          type="button"
          onClick={() => onDeploymentFlavorChange("simple_agent_free")}
          style={{
            textAlign: "left",
            border: deploymentFlavor === "simple_agent_free" ? "1px solid var(--border-strong)" : "1px solid var(--border)",
            borderRadius: 10,
            padding: 16,
            background: deploymentFlavor === "simple_agent_free" ? "var(--accent-surface)" : "var(--surface-strong)",
            color: "inherit",
            cursor: "pointer",
          }}
        >
          <strong>Simple Agent (Free)</strong>
          <p className="muted" style={{ marginBottom: 8 }}>
            Deploys the `adminagent` UI/service.
          </p>
        </button>
        <button
          type="button"
          onClick={() => onDeploymentFlavorChange("deploy_openclaw_free")}
          style={{
            textAlign: "left",
            border: deploymentFlavor === "deploy_openclaw_free" ? "1px solid var(--border-strong)" : "1px solid var(--border)",
            borderRadius: 10,
            padding: 16,
            background: deploymentFlavor === "deploy_openclaw_free" ? "var(--accent-surface)" : "var(--surface-strong)",
            color: "inherit",
            cursor: "pointer",
          }}
        >
          <strong>Deploy OpenClaw (Free)</strong>
          <p className="muted" style={{ marginBottom: 0 }}>
            Deploys the OpenClaw runtime and Control UI.
          </p>
        </button>
      </div>
      <button className="button" type="button" onClick={onDeploy} disabled={loading}>
        {loading ? "Starting..." : "Start Deployment"}
      </button>
    </div>
  );
}
