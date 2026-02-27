"use client";

type Props = {
  provider: "openai" | "anthropic";
  apiKey: string;
  telegramBotToken: string;
  onProviderChange: (value: "openai" | "anthropic") => void;
  onApiKeyChange: (value: string) => void;
  onTelegramBotTokenChange: (value: string) => void;
};

export function ChannelStep({
  provider,
  apiKey,
  telegramBotToken,
  onProviderChange,
  onApiKeyChange,
  onTelegramBotTokenChange,
}: Props) {
  return (
    <div className="card">
      <h2 style={{ margin: 0 }}>Add your model API key</h2>
      <p className="muted">
        Pick your provider and paste a key now. Model and Telegram credentials are optional, and can be added later.
      </p>
      <div className="row" style={{ gap: 8 }}>
        <button
          className={`button ${provider === "openai" ? "" : "secondary"}`}
          onClick={() => onProviderChange("openai")}
          type="button"
        >
          OpenAI
        </button>
        <button
          className={`button ${provider === "anthropic" ? "" : "secondary"}`}
          onClick={() => onProviderChange("anthropic")}
          type="button"
        >
          Anthropic
        </button>
      </div>
      <div style={{ display: "grid", gap: 8 }}>
        <label className="muted" htmlFor="provider-api-key" style={{ display: "block" }}>
          API key (optional)
        </label>
        <input
          id="provider-api-key"
          className="input"
          type="password"
          placeholder={provider === "openai" ? "sk-..." : "sk-ant-..."}
          value={apiKey}
          onChange={(event) => onApiKeyChange(event.target.value)}
          autoComplete="off"
        />
        <p className="muted">Optional. If omitted, runtime launches without a provider key.</p>
      </div>
      <hr style={{ border: 0, borderTop: "1px solid var(--border)", margin: "16px 0" }} />
      <h3 style={{ margin: "0 0 8px" }}>Connect Telegram</h3>
      <div
        style={{
          border: "1px solid var(--border)",
          borderRadius: 12,
          padding: 12,
          background: "var(--surface-strong)",
          display: "grid",
          gap: 10,
        }}
      >
        <p className="muted" style={{ marginTop: 0 }}>
          Create your bot in BotFather, copy the token, and paste it below when you want Telegram enabled.
        </p>
        <div className="row" style={{ gap: 10 }}>
          <a
            href="https://t.me/BotFather?text=%2Fnewbot"
            target="_blank"
            rel="noreferrer"
            className="button"
            style={{ textDecoration: "none" }}
          >
            Open BotFather to create bot
          </a>
          <span className="muted" style={{ fontSize: 13 }}>
            Runs <code>/newbot</code> automatically.
          </span>
        </div>
      </div>
      <div style={{ display: "grid", gap: 8 }}>
        <label className="muted" htmlFor="telegram-bot-token" style={{ display: "block" }}>
          Telegram bot token (optional)
        </label>
        <input
          id="telegram-bot-token"
          className="input"
          type="password"
          placeholder="123456789:AA..."
          value={telegramBotToken}
          onChange={(event) => onTelegramBotTokenChange(event.target.value)}
          autoComplete="off"
        />
        <p className="muted">Optional. If omitted, Telegram channel stays disabled.</p>
      </div>
    </div>
  );
}
