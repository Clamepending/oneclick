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
          border: "1px solid #2f3c52",
          borderRadius: 10,
          padding: 16,
          marginBottom: 12,
        }}
      >
        <strong>Free</strong>
        <p className="muted" style={{ marginBottom: 0 }}>
          One active deployment, basic usage limits.
        </p>
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
