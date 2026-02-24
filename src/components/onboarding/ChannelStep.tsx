"use client";

type Props = {
  value: "none" | "telegram";
  onChange: (value: "none" | "telegram") => void;
};

export function ChannelStep({ value, onChange }: Props) {
  return (
    <div className="card">
      <h2>Connect your phone (recommended)</h2>
      <p className="muted">Text /newbot to @BotFather to create a new bot. Then send /start to the bot to get the token. Then paste the token here.</p>
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
