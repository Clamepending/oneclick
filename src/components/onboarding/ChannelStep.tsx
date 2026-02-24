"use client";

type Props = {
  provider: "openai" | "anthropic";
  apiKey: string;
  onProviderChange: (value: "openai" | "anthropic") => void;
  onApiKeyChange: (value: string) => void;
};

export function ChannelStep({ provider, apiKey, onProviderChange, onApiKeyChange }: Props) {
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
    </div>
  );
}
