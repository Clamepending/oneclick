"use client";

type Props = {
  onDeploy: () => void;
  loading: boolean;
  channel: "none" | "telegram";
};

export function PlanStep({ onDeploy, loading, channel }: Props) {
  const isTelegram = channel === "telegram";
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
        {isTelegram ? (
          <li>Link Telegram: we inject your server-configured bot token into the container during launch.</li>
        ) : null}
        <li>Open your runtime once status is ready.</li>
        <li>Enter your customer&apos;s OpenAI or Anthropic API key in OpenClaw (never use a personal key).</li>
      </ol>
      {isTelegram ? (
        <p className="muted" style={{ marginTop: -4 }}>
          If deployment fails at the Telegram step, set <code>OPENCLAW_TELEGRAM_BOT_TOKEN</code> in your app
          environment and redeploy.
        </p>
      ) : null}
      <button className="button" type="button" onClick={onDeploy} disabled={loading}>
        {loading ? "Starting..." : "Start Free Deploy"}
      </button>
    </div>
  );
}
