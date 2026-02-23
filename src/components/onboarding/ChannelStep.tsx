"use client";

type Props = {
  value: "none" | "telegram";
  onChange: (value: "none" | "telegram") => void;
};

export function ChannelStep({ value, onChange }: Props) {
  return (
    <div className="card">
      <h2>Connect your phone (optional)</h2>
      <p className="muted">Skip for now and finish setup quickly.</p>
      <div className="row">
        <button
          className={`button ${value === "telegram" ? "" : "secondary"}`}
          onClick={() => onChange("telegram")}
          type="button"
        >
          Telegram
        </button>
        <button
          className={`button ${value === "none" ? "" : "secondary"}`}
          onClick={() => onChange("none")}
          type="button"
        >
          Skip for now
        </button>
      </div>
    </div>
  );
}
