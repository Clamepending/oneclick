"use client";

type Props = {
  onDeploy: () => void;
  loading: boolean;
  hasApiKey: boolean;
};

export function PlanStep({ onDeploy, loading, hasApiKey }: Props) {
  return (
    <div className="card">
      <h2>Choose your plan</h2>
      <p className="muted">Free is preselected to keep this fast.</p>
      <div
        style={{
          border: "1px solid var(--border)",
          borderRadius: 10,
          padding: 16,
          marginBottom: 12,
        }}
      >
        <strong>Free</strong>
        <p className="muted" style={{ marginBottom: 8 }}>
          One active deployment with shared-host safeguards.
        </p>
        <ul className="muted" style={{ margin: 0, paddingLeft: 18, display: "grid", gap: 4 }}>
          <li>1 active deployment</li>
          <li>1 GB RAM limit</li>
          <li>0.5 vCPU limit</li>
          <li>256 process limit (PIDs)</li>
          <li>128 MB shared memory (/dev/shm)</li>
          <li>Persistent workspace storage on shared host (no fixed per-container disk cap)</li>
        </ul>
      </div>
      <h3 style={{ margin: "0 0 8px" }}>Deployment checklist</h3>
      <ol className="muted" style={{ marginTop: 0, marginBottom: 12, paddingLeft: 18, display: "grid", gap: 6 }}>
        <li>Start your deployment from this screen.</li>
        <li>Open your runtime once status is ready.</li>
        <li>{hasApiKey ? "Your API key will already be configured for first launch." : "You can add an API key later in runtime settings."}</li>
      </ol>
      <button className="button" type="button" onClick={onDeploy} disabled={loading}>
        {loading ? "Starting..." : "Start Free Deploy"}
      </button>
    </div>
  );
}
