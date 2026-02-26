"use client";

type Props = {
  planTier: "free" | "paid";
  deploymentFlavor: "basic" | "advanced";
  onSelectionChange: (selection: { planTier: "free" | "paid"; deploymentFlavor: "basic" | "advanced" }) => void;
  onDeploy: () => void;
  loading: boolean;
  hasApiKey: boolean;
  freeSelectable?: boolean;
  freeActiveDeployments?: number;
  freeActiveLimit?: number;
};

export function PlanStep({
  planTier,
  deploymentFlavor,
  onSelectionChange,
  onDeploy,
  loading,
  hasApiKey,
  freeSelectable = true,
  freeActiveDeployments = 0,
  freeActiveLimit = 1,
}: Props) {
  const selectedMode = planTier === "paid" ? "paid_basic" : deploymentFlavor === "advanced" ? "free_advanced" : "free_basic";

  return (
    <div className="card">
      <h2>Choose your plan</h2>
      <p className="muted">Choose a deployment mode. Advanced adds an automatic post-setup agent instruction flow for integrations.</p>
      <div style={{ display: "grid", gap: 10, marginBottom: 12 }}>
        <button
          type="button"
          disabled={!freeSelectable}
          onClick={() => onSelectionChange({ planTier: "free", deploymentFlavor: "basic" })}
          style={{
            textAlign: "left",
            border: `1px solid ${selectedMode === "free_basic" && freeSelectable ? "var(--border-strong)" : "var(--border)"}`,
            borderRadius: 10,
            padding: 16,
            background: selectedMode === "free_basic" && freeSelectable ? "var(--accent-surface)" : "transparent",
            color: "inherit",
            cursor: freeSelectable ? "pointer" : "not-allowed",
            opacity: freeSelectable ? 1 : 0.6,
          }}
        >
          <strong>Free (Basic)</strong>
          <p className="muted" style={{ marginBottom: 8 }}>
            $0 for 30 days, then bot is deactivated until upgraded.
          </p>
          <ul className="muted" style={{ margin: 0, paddingLeft: 18, display: "grid", gap: 4 }}>
            <li>1 active deployment</li>
            <li>AWS ECS Fargate: 0.25 vCPU / 0.5 GB RAM</li>
            <li>Deactivates after 30 days unless upgraded</li>
          </ul>
          {!freeSelectable ? (
            <p className="muted" style={{ marginTop: 8, marginBottom: 0 }}>
              Unavailable: you already have {freeActiveDeployments}/{freeActiveLimit} active free deployment
              {freeActiveLimit === 1 ? "" : "s"}.
            </p>
          ) : null}
        </button>
        <button
          type="button"
          disabled={!freeSelectable}
          onClick={() => onSelectionChange({ planTier: "free", deploymentFlavor: "advanced" })}
          style={{
            textAlign: "left",
            border: `1px solid ${selectedMode === "free_advanced" && freeSelectable ? "var(--border-strong)" : "var(--border)"}`,
            borderRadius: 10,
            padding: 16,
            background: selectedMode === "free_advanced" && freeSelectable ? "var(--accent-surface)" : "transparent",
            color: "inherit",
            cursor: freeSelectable ? "pointer" : "not-allowed",
            opacity: freeSelectable ? 1 : 0.6,
          }}
        >
          <strong>Free (Advanced)</strong>
          <p className="muted" style={{ marginBottom: 8 }}>
            Same free trial specs, plus an automatic post-setup agent prompt for integration onboarding.
          </p>
          <ul className="muted" style={{ margin: 0, paddingLeft: 18, display: "grid", gap: 4 }}>
            <li>1 active deployment</li>
            <li>AWS ECS Fargate: 0.25 vCPU / 0.5 GB RAM</li>
            <li>Auto-prompts the agent with OttoAuth setup instructions after startup</li>
          </ul>
          {!freeSelectable ? (
            <p className="muted" style={{ marginTop: 8, marginBottom: 0 }}>
              Unavailable: you already have {freeActiveDeployments}/{freeActiveLimit} active free deployment
              {freeActiveLimit === 1 ? "" : "s"}.
            </p>
          ) : null}
        </button>
        <button
          type="button"
          onClick={() => onSelectionChange({ planTier: "paid", deploymentFlavor: "basic" })}
          style={{
            textAlign: "left",
            border: `1px solid ${selectedMode === "paid_basic" ? "var(--border-strong)" : "var(--border)"}`,
            borderRadius: 10,
            padding: 16,
            background: selectedMode === "paid_basic" ? "var(--accent-surface)" : "transparent",
            color: "inherit",
            cursor: "pointer",
          }}
        >
          <strong>Paid (Basic) - $20/month</strong>
          <p className="muted" style={{ marginBottom: 8 }}>
            Higher-performance runtime for always-on bots.
          </p>
          <ul className="muted" style={{ margin: 0, paddingLeft: 18, display: "grid", gap: 4 }}>
            <li>AWS ECS Fargate: 0.5 vCPU / 1 GB RAM</li>
            <li>No trial expiration deactivation</li>
            <li>Better for heavier MCP / media processing than free tier</li>
          </ul>
        </button>
      </div>
      <h3 style={{ margin: "0 0 8px" }}>Deployment checklist</h3>
      <ol className="muted" style={{ marginTop: 0, marginBottom: 12, paddingLeft: 18, display: "grid", gap: 6 }}>
        <li>Start your deployment from this screen.</li>
        <li>Open your runtime once status is ready.</li>
        <li>{hasApiKey ? "Your API key will already be configured for first launch." : "Model API key is required before deployment."}</li>
      </ol>
      <button className="button" type="button" onClick={onDeploy} disabled={loading}>
        {loading
          ? "Starting..."
          : planTier === "paid"
            ? "Start Paid (Basic) Deploy ($20/mo)"
            : deploymentFlavor === "advanced"
              ? "Start Free (Advanced) Deploy"
              : "Start Free (Basic) Deploy"}
      </button>
    </div>
  );
}
