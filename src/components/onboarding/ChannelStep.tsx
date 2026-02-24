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
      <h2>Add your model API key</h2>
      <p className="muted">
        Pick your provider and paste a key now so the runtime is ready to use immediately after deploy.
      </p>
      <div className="row">
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
      <label className="muted" htmlFor="provider-api-key" style={{ display: "block", marginTop: 12 }}>
        API key
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
      <p className="muted" style={{ marginBottom: 0 }}>
        Leave blank to skip for now.
      </p>
      <hr style={{ border: 0, borderTop: "1px solid #2f3c52", margin: "16px 0" }} />
      <h3 style={{ margin: "0 0 8px" }}>Connect Telegram bot (optional)</h3>
      <p className="muted" style={{ marginTop: 0 }}>
        <a href="https://t.me/BotFather?text=%2Fnewbot" target="_blank" rel="noreferrer">
          Open BotFather with /newbot
        </a>{" "}
        to create your bot, then paste the token below.
      </p>
      <label className="muted" htmlFor="telegram-bot-token" style={{ display: "block", marginTop: 12 }}>
        Telegram bot token
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
    </div>
  );
}
