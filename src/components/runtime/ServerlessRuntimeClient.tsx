"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";

type ChatMessage = {
  id: number;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
};

type DeploymentEvent = {
  status: string;
  message: string;
  ts: string;
};

type DeploymentSettingsState = {
  modelProvider: string;
  hasOpenaiApiKey: boolean;
  hasAnthropicApiKey: boolean;
  hasOpenrouterApiKey: boolean;
  hasTelegramBotToken: boolean;
};

type DeploymentState = {
  status: string;
  deployProvider: string | null;
  runtimeId: string | null;
  readyUrl: string | null;
  deploymentFlavor: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  health: { ok: boolean; status: number } | null;
  settings: DeploymentSettingsState;
};

type Props = {
  deploymentId: string;
  botName: string | null;
  initialState?: Omit<DeploymentState, "health"> & { health?: DeploymentState["health"] };
};

type RuntimeMessagesResponse =
  | { ok?: boolean; error?: string; messages?: ChatMessage[] }
  | null;

type RuntimeChatResponse =
  | {
      ok?: boolean;
      error?: string;
      userMessage?: ChatMessage;
      assistantMessage?: ChatMessage;
    }
  | null;

type DeploymentResponse =
  | {
      status?: string;
      deployProvider?: string | null;
      runtimeId?: string | null;
      readyUrl?: string | null;
      deploymentFlavor?: string | null;
      error?: string | null;
      createdAt?: string;
      updatedAt?: string;
      health?: { ok?: boolean; status?: number } | null;
      settings?: {
        modelProvider?: string;
        hasOpenaiApiKey?: boolean;
        hasAnthropicApiKey?: boolean;
        hasOpenrouterApiKey?: boolean;
        hasTelegramBotToken?: boolean;
      };
    }
  | null;

type DeploymentEventsResponse =
  | {
      items?: Array<{
        status?: string;
        message?: string;
        ts?: string;
      }>;
    }
  | null;

type SettingsPatchResponse =
  | {
      ok?: boolean;
      error?: string;
      liveApply?: {
        attempted?: boolean;
        applied?: boolean;
        reason?: string;
      };
      settings?: {
        modelProvider?: string;
        hasOpenaiApiKey?: boolean;
        hasAnthropicApiKey?: boolean;
        hasOpenrouterApiKey?: boolean;
        hasTelegramBotToken?: boolean;
      };
    }
  | null;

type DeployResponse =
  | {
      id?: string;
      error?: string;
    }
  | null;

const MODEL_PROVIDER_OPTIONS = [
  { value: "auto", label: "Auto (fallback order)" },
  { value: "openai", label: "OpenAI" },
  { value: "openrouter", label: "OpenRouter" },
  { value: "anthropic", label: "Anthropic" },
] as const;

function normalizeModelProvider(value: string | null | undefined) {
  const normalized = (value ?? "").trim().toLowerCase();
  if (normalized === "openai" || normalized === "openrouter" || normalized === "anthropic") {
    return normalized;
  }
  return "auto";
}

async function readJson<T>(response: Response) {
  return (await response.json().catch(() => null)) as T;
}

function statusPillMeta(status: string | null | undefined) {
  const normalized = (status ?? "").trim().toLowerCase();
  if (normalized === "ready") return { label: "READY", color: "#1f9d55", bg: "rgba(31,157,85,0.18)" };
  if (normalized === "failed") return { label: "FAILED", color: "#ff6b6b", bg: "rgba(255,107,107,0.20)" };
  if (normalized === "starting") return { label: "STARTING", color: "#f5c542", bg: "rgba(245,197,66,0.20)" };
  if (normalized === "queued") return { label: "QUEUED", color: "#7ea7ff", bg: "rgba(126,167,255,0.20)" };
  return { label: (normalized || "unknown").toUpperCase(), color: "#c3c9d4", bg: "rgba(195,201,212,0.18)" };
}

export function ServerlessRuntimeClient({ deploymentId, botName, initialState }: Props) {
  const router = useRouter();
  const [activeTab, setActiveTab] = useState<"chat" | "settings" | "debug">("chat");

  const [deployment, setDeployment] = useState<DeploymentState | null>(
    initialState
      ? {
          ...initialState,
          health: initialState.health ?? null,
          settings: {
            modelProvider: normalizeModelProvider(initialState.settings.modelProvider),
            hasOpenaiApiKey: Boolean(initialState.settings.hasOpenaiApiKey),
            hasAnthropicApiKey: Boolean(initialState.settings.hasAnthropicApiKey),
            hasOpenrouterApiKey: Boolean(initialState.settings.hasOpenrouterApiKey),
            hasTelegramBotToken: Boolean(initialState.settings.hasTelegramBotToken),
          },
        }
      : null,
  );
  const [deploymentLoading, setDeploymentLoading] = useState(!initialState);
  const [deploymentError, setDeploymentError] = useState("");

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [messagesLoading, setMessagesLoading] = useState(true);
  const [chatError, setChatError] = useState("");
  const [sending, setSending] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [draft, setDraft] = useState("");

  const [events, setEvents] = useState<DeploymentEvent[]>([]);
  const [eventsLoading, setEventsLoading] = useState(true);
  const [eventsError, setEventsError] = useState("");

  const [openaiApiKey, setOpenaiApiKey] = useState("");
  const [anthropicApiKey, setAnthropicApiKey] = useState("");
  const [openrouterApiKey, setOpenrouterApiKey] = useState("");
  const [telegramBotToken, setTelegramBotToken] = useState("");
  const [modelProvider, setModelProvider] = useState("auto");
  const [settingsHydrated, setSettingsHydrated] = useState(false);
  const [settingsSaving, setSettingsSaving] = useState(false);
  const [settingsRedeploying, setSettingsRedeploying] = useState(false);
  const [settingsError, setSettingsError] = useState("");
  const [settingsMessage, setSettingsMessage] = useState("");

  const title = useMemo(() => (botName?.trim() ? botName.trim() : "Serverless Bot"), [botName]);
  const statusMeta = statusPillMeta(deployment?.status);

  useEffect(() => {
    if (!deployment || settingsHydrated) return;
    setModelProvider(normalizeModelProvider(deployment.settings.modelProvider));
    setSettingsHydrated(true);
  }, [deployment, settingsHydrated]);

  async function loadDeployment() {
    setDeploymentLoading(true);
    setDeploymentError("");
    try {
      const response = await fetch(`/api/deployments/${deploymentId}`, { cache: "no-store" });
      const body = await readJson<DeploymentResponse>(response);
      if (!response.ok || !body?.status) {
        throw new Error((body as { error?: string } | null)?.error || "Failed to load deployment details.");
      }
      setDeployment({
        status: body.status,
        deployProvider: body.deployProvider ?? null,
        runtimeId: body.runtimeId ?? null,
        readyUrl: body.readyUrl ?? null,
        deploymentFlavor: body.deploymentFlavor ?? null,
        error: body.error ?? null,
        createdAt: body.createdAt ?? "",
        updatedAt: body.updatedAt ?? "",
        health:
          body.health && typeof body.health.ok === "boolean" && typeof body.health.status === "number"
            ? { ok: body.health.ok, status: body.health.status }
            : null,
        settings: {
          modelProvider: normalizeModelProvider(body.settings?.modelProvider),
          hasOpenaiApiKey: Boolean(body.settings?.hasOpenaiApiKey),
          hasAnthropicApiKey: Boolean(body.settings?.hasAnthropicApiKey),
          hasOpenrouterApiKey: Boolean(body.settings?.hasOpenrouterApiKey),
          hasTelegramBotToken: Boolean(body.settings?.hasTelegramBotToken),
        },
      });
    } catch (error) {
      setDeploymentError(error instanceof Error ? error.message : "Failed to load deployment details.");
    } finally {
      setDeploymentLoading(false);
    }
  }

  async function loadMessages() {
    setMessagesLoading(true);
    setChatError("");
    try {
      const response = await fetch(`/api/runtime/${deploymentId}/messages`, { cache: "no-store" });
      const body = await readJson<RuntimeMessagesResponse>(response);
      if (!response.ok || !body?.ok || !Array.isArray(body.messages)) {
        throw new Error(body?.error || "Failed to load chat history.");
      }
      setMessages(body.messages);
    } catch (error) {
      setChatError(error instanceof Error ? error.message : "Failed to load chat history.");
    } finally {
      setMessagesLoading(false);
    }
  }

  async function loadEvents() {
    setEventsLoading(true);
    setEventsError("");
    try {
      const response = await fetch(`/api/deployments/${deploymentId}/events`, { cache: "no-store" });
      const body = await readJson<DeploymentEventsResponse>(response);
      if (!response.ok || !Array.isArray(body?.items)) {
        throw new Error((body as { error?: string } | null)?.error || "Failed to load debug events.");
      }
      setEvents(
        body.items
          .filter((item) => item && typeof item.status === "string" && typeof item.message === "string")
          .map((item) => ({
            status: item.status as string,
            message: item.message as string,
            ts: typeof item.ts === "string" ? item.ts : new Date().toISOString(),
          })),
      );
    } catch (error) {
      setEventsError(error instanceof Error ? error.message : "Failed to load debug events.");
    } finally {
      setEventsLoading(false);
    }
  }

  async function refreshRuntimeData() {
    await Promise.all([loadDeployment(), loadMessages(), loadEvents()]);
  }

  useEffect(() => {
    void refreshRuntimeData();
  }, [deploymentId]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const nextMessage = draft.trim();
    if (!nextMessage || sending) return;

    setSending(true);
    setChatError("");
    try {
      const response = await fetch(`/api/runtime/${deploymentId}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: nextMessage }),
      });
      const body = await readJson<RuntimeChatResponse>(response);
      if (!response.ok || !body?.ok || !body.userMessage || !body.assistantMessage) {
        throw new Error(body?.error || "Failed to send message.");
      }
      setMessages((current) => [...current, body.userMessage as ChatMessage, body.assistantMessage as ChatMessage]);
      setDraft("");
      await loadDeployment();
    } catch (error) {
      setChatError(error instanceof Error ? error.message : "Failed to send message.");
    } finally {
      setSending(false);
    }
  }

  async function handleNewChatSession() {
    if (clearing) return;
    const confirmed = window.confirm("Start a new chat session? This clears the current runtime chat history.");
    if (!confirmed) return;

    setClearing(true);
    setChatError("");
    try {
      const response = await fetch(`/api/runtime/${deploymentId}/messages`, { method: "DELETE" });
      const body = (await readJson<{ ok?: boolean; error?: string }>(response)) ?? null;
      if (!response.ok || !body?.ok) {
        throw new Error(body?.error || "Failed to clear chat session.");
      }
      setMessages([]);
    } catch (error) {
      setChatError(error instanceof Error ? error.message : "Failed to clear chat session.");
    } finally {
      setClearing(false);
    }
  }

  async function handleSaveSettings(redeployAfterSave: boolean) {
    if (redeployAfterSave) {
      setSettingsRedeploying(true);
    } else {
      setSettingsSaving(true);
    }
    setSettingsError("");
    setSettingsMessage("");

    try {
      const payload: Record<string, string | boolean> = {};
      const currentModelProvider = normalizeModelProvider(deployment?.settings.modelProvider);
      if (normalizeModelProvider(modelProvider) !== currentModelProvider) {
        payload.modelProvider = normalizeModelProvider(modelProvider);
      }
      if (openaiApiKey.trim()) payload.openaiApiKey = openaiApiKey.trim();
      if (anthropicApiKey.trim()) payload.anthropicApiKey = anthropicApiKey.trim();
      if (openrouterApiKey.trim()) payload.openrouterApiKey = openrouterApiKey.trim();
      if (telegramBotToken.trim()) payload.telegramBotToken = telegramBotToken.trim();

      if (!Object.keys(payload).length) {
        throw new Error("Enter at least one change to save.");
      }

      const saveResponse = await fetch(`/api/deployments/${deploymentId}/settings`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const saveBody = await readJson<SettingsPatchResponse>(saveResponse);
      if (!saveResponse.ok || !saveBody?.ok) {
        throw new Error(saveBody?.error || "Failed to save settings.");
      }

      setOpenaiApiKey("");
      setAnthropicApiKey("");
      setOpenrouterApiKey("");
      setTelegramBotToken("");

      if (redeployAfterSave) {
        const redeployResponse = await fetch("/api/deployments", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            sourceDeploymentId: deploymentId,
            botName: botName ?? undefined,
            deploymentFlavor: deployment?.deploymentFlavor ?? undefined,
          }),
        });
        const redeployBody = await readJson<DeployResponse>(redeployResponse);
        if (!redeployResponse.ok || !redeployBody?.id) {
          throw new Error(redeployBody?.error || "Saved settings, but failed to queue redeploy.");
        }
        setSettingsMessage("Saved and queued redeploy. Opening the new runtime...");
        router.push(`/runtime/${redeployBody.id}`);
        router.refresh();
        return;
      }

      await loadDeployment();
      if (saveBody?.liveApply?.attempted && saveBody.liveApply.applied) {
        setSettingsMessage("Saved and live-applied to runtime.");
      } else if (saveBody?.liveApply?.attempted) {
        const reason = saveBody.liveApply.reason ? ` (${saveBody.liveApply.reason})` : "";
        setSettingsMessage(`Saved. Live apply was not successful${reason}.`);
      } else {
        setSettingsMessage("Saved runtime settings.");
      }
    } catch (error) {
      setSettingsError(error instanceof Error ? error.message : "Failed to save settings.");
    } finally {
      setSettingsSaving(false);
      setSettingsRedeploying(false);
    }
  }

  return (
    <main className="container" style={{ maxWidth: 1080 }}>
      <div className="card" style={{ gap: 14 }}>
        <div className="row" style={{ justifyContent: "space-between", alignItems: "center" }}>
          <div style={{ display: "grid", gap: 4 }}>
            <h1 style={{ margin: 0 }}>{title}</h1>
            <p className="muted" style={{ margin: 0 }}>
              Deployment <code>{deploymentId}</code>
            </p>
          </div>
          <div className="row" style={{ justifyContent: "flex-end" }}>
            <span
              style={{
                fontSize: 12,
                fontWeight: 700,
                letterSpacing: 0.4,
                padding: "6px 10px",
                borderRadius: 999,
                color: statusMeta.color,
                background: statusMeta.bg,
                whiteSpace: "nowrap",
              }}
            >
              {statusMeta.label}
            </span>
            {deployment?.readyUrl ? (
              <a className="button secondary" href={deployment.readyUrl} target="_blank" rel="noreferrer">
                Open runtime page
              </a>
            ) : null}
          </div>
        </div>

        <div className="row" style={{ gap: 8 }}>
          <button
            type="button"
            className={`button ${activeTab === "chat" ? "" : "secondary"}`}
            onClick={() => setActiveTab("chat")}
          >
            Chat
          </button>
          <button
            type="button"
            className={`button ${activeTab === "settings" ? "" : "secondary"}`}
            onClick={() => setActiveTab("settings")}
          >
            Settings
          </button>
          <button
            type="button"
            className={`button ${activeTab === "debug" ? "" : "secondary"}`}
            onClick={() => setActiveTab("debug")}
          >
            Debug
          </button>
        </div>

        {activeTab === "chat" ? (
          <section style={{ display: "grid", gap: 10 }}>
            <div className="row" style={{ justifyContent: "space-between", alignItems: "center" }}>
              <p className="muted" style={{ margin: 0 }}>
                Model reply target: a few seconds
              </p>
              <button
                className="button secondary"
                type="button"
                onClick={() => void handleNewChatSession()}
                disabled={clearing || sending}
              >
                {clearing ? "Clearing..." : "New chat session"}
              </button>
            </div>

            <div
              style={{
                border: "1px solid var(--border)",
                borderRadius: 10,
                background: "var(--surface-strong)",
                maxHeight: "56vh",
                overflowY: "auto",
                padding: 12,
                display: "grid",
                gap: 10,
              }}
            >
              {messagesLoading ? (
                <p className="muted" style={{ margin: 0 }}>
                  Loading messages...
                </p>
              ) : messages.length === 0 ? (
                <p className="muted" style={{ margin: 0 }}>
                  No messages yet. Send one to start.
                </p>
              ) : (
                messages.map((message) => (
                  <div
                    key={message.id}
                    style={{
                      justifySelf: message.role === "user" ? "end" : "start",
                      maxWidth: "88%",
                      borderRadius: 10,
                      border: "1px solid var(--border)",
                      background: message.role === "user" ? "var(--accent-surface)" : "var(--surface)",
                      padding: "8px 10px",
                    }}
                  >
                    <p style={{ margin: 0, whiteSpace: "pre-wrap" }}>{message.content}</p>
                  </div>
                ))
              )}
            </div>

            <form onSubmit={handleSubmit} style={{ display: "grid", gap: 8 }}>
              <textarea
                className="input"
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                placeholder="Type your message..."
                rows={4}
                disabled={sending || clearing}
              />
              <div className="row" style={{ justifyContent: "flex-end" }}>
                <button className="button" type="submit" disabled={sending || clearing || !draft.trim()}>
                  {sending ? "Sending..." : "Send"}
                </button>
              </div>
            </form>

            {chatError ? (
              <p role="alert" style={{ color: "#ff8e8e", margin: 0 }}>
                {chatError}
              </p>
            ) : null}
          </section>
        ) : null}

        {activeTab === "settings" ? (
          <section style={{ display: "grid", gap: 10 }}>
            <p className="muted" style={{ margin: 0 }}>
              Update model and channel credentials. Values stay hidden; leave blank to keep existing secrets.
            </p>

            <label className="muted" style={{ display: "grid", gap: 6 }}>
              Preferred model provider
              <select
                className="input"
                value={modelProvider}
                onChange={(event) => setModelProvider(normalizeModelProvider(event.target.value))}
                disabled={settingsSaving || settingsRedeploying}
              >
                {MODEL_PROVIDER_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>

            <label className="muted" style={{ display: "grid", gap: 6 }}>
              OpenAI API key {deployment?.settings.hasOpenaiApiKey ? "(already set)" : "(not set)"}
              <input
                className="input"
                type="password"
                value={openaiApiKey}
                onChange={(event) => setOpenaiApiKey(event.target.value)}
                placeholder={deployment?.settings.hasOpenaiApiKey ? "Already set (hidden)" : "sk-..."}
                autoComplete="off"
              />
            </label>

            <label className="muted" style={{ display: "grid", gap: 6 }}>
              Anthropic API key {deployment?.settings.hasAnthropicApiKey ? "(already set)" : "(not set)"}
              <input
                className="input"
                type="password"
                value={anthropicApiKey}
                onChange={(event) => setAnthropicApiKey(event.target.value)}
                placeholder={deployment?.settings.hasAnthropicApiKey ? "Already set (hidden)" : "sk-ant-..."}
                autoComplete="off"
              />
            </label>

            <label className="muted" style={{ display: "grid", gap: 6 }}>
              OpenRouter API key {deployment?.settings.hasOpenrouterApiKey ? "(already set)" : "(not set)"}
              <input
                className="input"
                type="password"
                value={openrouterApiKey}
                onChange={(event) => setOpenrouterApiKey(event.target.value)}
                placeholder={deployment?.settings.hasOpenrouterApiKey ? "Already set (hidden)" : "sk-or-..."}
                autoComplete="off"
              />
            </label>

            <label className="muted" style={{ display: "grid", gap: 6 }}>
              Telegram bot token {deployment?.settings.hasTelegramBotToken ? "(already set)" : "(not set)"}
              <input
                className="input"
                type="password"
                value={telegramBotToken}
                onChange={(event) => setTelegramBotToken(event.target.value)}
                placeholder={deployment?.settings.hasTelegramBotToken ? "Already set (hidden)" : "123456789:AA..."}
                autoComplete="off"
              />
            </label>

            <div className="row">
              <button
                className="button"
                type="button"
                onClick={() => void handleSaveSettings(false)}
                disabled={settingsSaving || settingsRedeploying}
              >
                {settingsSaving ? "Saving..." : "Save"}
              </button>
              <button
                className="button secondary"
                type="button"
                onClick={() => void handleSaveSettings(true)}
                disabled={settingsSaving || settingsRedeploying}
              >
                {settingsRedeploying ? "Redeploying..." : "Save and redeploy"}
              </button>
            </div>

            {settingsMessage ? <p className="muted" style={{ margin: 0 }}>{settingsMessage}</p> : null}
            {settingsError ? (
              <p role="alert" style={{ color: "#ff8e8e", margin: 0 }}>
                {settingsError}
              </p>
            ) : null}
          </section>
        ) : null}

        {activeTab === "debug" ? (
          <section style={{ display: "grid", gap: 10 }}>
            <div className="row" style={{ justifyContent: "space-between", alignItems: "center" }}>
              <p className="muted" style={{ margin: 0 }}>
                Runtime and deployment diagnostics
              </p>
              <button className="button secondary" type="button" onClick={() => void refreshRuntimeData()}>
                Refresh debug data
              </button>
            </div>

            <div
              style={{
                border: "1px solid var(--border)",
                borderRadius: 10,
                background: "var(--surface-strong)",
                padding: 12,
                display: "grid",
                gap: 6,
              }}
            >
              <p className="muted" style={{ margin: 0 }}>
                Provider: <code>{deployment?.deployProvider ?? "unknown"}</code>
              </p>
              <p className="muted" style={{ margin: 0 }}>
                Runtime ID: <code>{deployment?.runtimeId ?? "pending"}</code>
              </p>
              <p className="muted" style={{ margin: 0 }}>
                Deployment flavor: <code>{deployment?.deploymentFlavor ?? "unknown"}</code>
              </p>
              <p className="muted" style={{ margin: 0 }}>
                Health: <code>{deployment?.health ? `${deployment.health.ok ? "ok" : "not_ok"} (${deployment.health.status})` : "unknown"}</code>
              </p>
              <p className="muted" style={{ margin: 0 }}>
                Updated: <code>{deployment?.updatedAt ? new Date(deployment.updatedAt).toLocaleString() : "unknown"}</code>
              </p>
              {deployment?.error ? (
                <p style={{ color: "#ff8e8e", margin: 0 }}>
                  Deployment error: {deployment.error}
                </p>
              ) : null}
            </div>

            <div
              style={{
                border: "1px solid var(--border)",
                borderRadius: 10,
                background: "var(--surface-strong)",
                padding: 12,
                display: "grid",
                gap: 8,
                maxHeight: "44vh",
                overflowY: "auto",
              }}
            >
              {eventsLoading ? (
                <p className="muted" style={{ margin: 0 }}>
                  Loading events...
                </p>
              ) : events.length === 0 ? (
                <p className="muted" style={{ margin: 0 }}>
                  No events yet.
                </p>
              ) : (
                events.map((item, index) => (
                  <div
                    key={`${item.ts}-${item.status}-${index}`}
                    style={{
                      border: "1px solid var(--border)",
                      borderRadius: 8,
                      padding: 10,
                      display: "grid",
                      gap: 6,
                      background: "rgba(0,0,0,0.14)",
                    }}
                  >
                    <div className="row" style={{ justifyContent: "space-between", alignItems: "center" }}>
                      <strong style={{ fontSize: 12, letterSpacing: 0.3 }}>{item.status.toUpperCase()}</strong>
                      <span className="muted" style={{ fontSize: 12 }}>
                        {new Date(item.ts).toLocaleTimeString()}
                      </span>
                    </div>
                    <p style={{ margin: 0 }}>{item.message}</p>
                  </div>
                ))
              )}
            </div>

            {eventsError ? (
              <p role="alert" style={{ color: "#ff8e8e", margin: 0 }}>
                {eventsError}
              </p>
            ) : null}
            {deploymentError ? (
              <p role="alert" style={{ color: "#ff8e8e", margin: 0 }}>
                {deploymentError}
              </p>
            ) : null}
          </section>
        ) : null}

        {(deploymentLoading && activeTab !== "chat") ? (
          <p className="muted" style={{ margin: 0 }}>
            Refreshing deployment details...
          </p>
        ) : null}
      </div>
    </main>
  );
}
