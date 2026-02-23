"use client";

type Props = {
  onDeploy: () => void;
  loading: boolean;
};

export function PlanStep({ onDeploy, loading }: Props) {
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
      <button className="button" type="button" onClick={onDeploy} disabled={loading}>
        {loading ? "Starting..." : "Start Free Deploy"}
      </button>
    </div>
  );
}
