"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";

type ChatMessage = {
  id: number;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
};

type RuntimeSession = {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  lastMessageAt: string | null;
};

type MemoryDoc = {
  docKey: string;
  content: string;
  updatedAt: string | null;
};

type DeploymentEvent = {
  status: string;
  message: string;
  ts: string;
};

type DeploymentSettingsState = {
  modelProvider: string;
  defaultModel: string;
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
  | { ok?: boolean; error?: string; sessionId?: string; messages?: ChatMessage[] }
  | null;

type RuntimeChatResponse =
  | {
      ok?: boolean;
      error?: string;
      sessionId?: string;
      userMessage?: ChatMessage;
      assistantMessage?: ChatMessage;
    }
  | null;

type RuntimeSessionsResponse =
  | {
      ok?: boolean;
      error?: string;
      activeSessionId?: string;
      sessions?: RuntimeSession[];
    }
  | null;

type RuntimeCreateSessionResponse =
  | {
      ok?: boolean;
      error?: string;
      session?: RuntimeSession;
    }
  | null;

type RuntimeMemoryResponse =
  | {
      ok?: boolean;
      error?: string;
      docs?: MemoryDoc[];
    }
  | null;

type RuntimeMemoryPatchResponse =
  | {
      ok?: boolean;
      error?: string;
      doc?: MemoryDoc;
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
        defaultModel?: string;
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
        defaultModel?: string;
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

function normalizeDefaultModel(value: string | null | undefined) {
  return (value ?? "").trim();
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
  const [activeTab, setActiveTab] = useState<"chat" | "memory" | "settings" | "debug">("chat");

  const [deployment, setDeployment] = useState<DeploymentState | null>(
    initialState
      ? {
          ...initialState,
          health: initialState.health ?? null,
          settings: {
            modelProvider: normalizeModelProvider(initialState.settings.modelProvider),
            defaultModel: normalizeDefaultModel(initialState.settings.defaultModel),
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

  const [sessions, setSessions] = useState<RuntimeSession[]>([]);
  const [sessionsLoading, setSessionsLoading] = useState(true);
  const [sessionsError, setSessionsError] = useState("");
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [creatingSession, setCreatingSession] = useState(false);

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [messagesLoading, setMessagesLoading] = useState(true);
  const [chatError, setChatError] = useState("");
  const [sending, setSending] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [draft, setDraft] = useState("");

  const [memoryDocs, setMemoryDocs] = useState<MemoryDoc[]>([]);
  const [memoryLoading, setMemoryLoading] = useState(true);
  const [memoryError, setMemoryError] = useState("");
  const [memoryMessage, setMemoryMessage] = useState("");
  const [memorySaving, setMemorySaving] = useState(false);
  const [selectedDocKey, setSelectedDocKey] = useState<string | null>(null);
  const [docDrafts, setDocDrafts] = useState<Record<string, string>>({});

  const [events, setEvents] = useState<DeploymentEvent[]>([]);
  const [eventsLoading, setEventsLoading] = useState(true);
  const [eventsError, setEventsError] = useState("");

  const [openaiApiKey, setOpenaiApiKey] = useState("");
  const [anthropicApiKey, setAnthropicApiKey] = useState("");
  const [openrouterApiKey, setOpenrouterApiKey] = useState("");
  const [telegramBotToken, setTelegramBotToken] = useState("");
  const [modelProvider, setModelProvider] = useState("auto");
  const [defaultModel, setDefaultModel] = useState("");
  const [settingsHydrated, setSettingsHydrated] = useState(false);
  const [settingsSaving, setSettingsSaving] = useState(false);
  const [settingsRedeploying, setSettingsRedeploying] = useState(false);
  const [settingsError, setSettingsError] = useState("");
  const [settingsMessage, setSettingsMessage] = useState("");

  const title = useMemo(() => (botName?.trim() ? botName.trim() : "Serverless Bot"), [botName]);
  const statusMeta = statusPillMeta(deployment?.status);

  const selectedDoc = useMemo(
    () => (selectedDocKey ? memoryDocs.find((doc) => doc.docKey === selectedDocKey) ?? null : null),
    [memoryDocs, selectedDocKey],
  );

  useEffect(() => {
    if (!deployment || settingsHydrated) return;
    setModelProvider(normalizeModelProvider(deployment.settings.modelProvider));
    setDefaultModel(normalizeDefaultModel(deployment.settings.defaultModel));
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
          defaultModel: normalizeDefaultModel(body.settings?.defaultModel),
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

  async function loadSessions() {
    setSessionsLoading(true);
    setSessionsError("");
    try {
      const response = await fetch(`/api/runtime/${deploymentId}/sessions`, { cache: "no-store" });
      const body = await readJson<RuntimeSessionsResponse>(response);
      if (!response.ok || !body?.ok || !Array.isArray(body.sessions)) {
        throw new Error(body?.error || "Failed to load sessions.");
      }
      setSessions(body.sessions);
      setActiveSessionId((current) => {
        if (current && body.sessions?.some((item) => item.id === current)) return current;
        return body.activeSessionId?.trim() || body.sessions?.[0]?.id || null;
      });
    } catch (error) {
      setSessionsError(error instanceof Error ? error.message : "Failed to load sessions.");
    } finally {
      setSessionsLoading(false);
    }
  }

  async function loadMessages(sessionId: string) {
    setMessagesLoading(true);
    setChatError("");
    try {
      const response = await fetch(`/api/runtime/${deploymentId}/messages?sessionId=${encodeURIComponent(sessionId)}`, {
        cache: "no-store",
      });
      const body = await readJson<RuntimeMessagesResponse>(response);
      if (!response.ok || !body?.ok || !Array.isArray(body.messages)) {
        throw new Error(body?.error || "Failed to load chat history.");
      }
      if (body.sessionId && body.sessionId !== sessionId) {
        setActiveSessionId(body.sessionId);
      }
      setMessages(body.messages);
    } catch (error) {
      setChatError(error instanceof Error ? error.message : "Failed to load chat history.");
    } finally {
      setMessagesLoading(false);
    }
  }

  async function loadMemoryDocs() {
    setMemoryLoading(true);
    setMemoryError("");
    try {
      const response = await fetch(`/api/runtime/${deploymentId}/memory`, { cache: "no-store" });
      const body = await readJson<RuntimeMemoryResponse>(response);
      if (!response.ok || !body?.ok || !Array.isArray(body.docs)) {
        throw new Error(body?.error || "Failed to load memory docs.");
      }
      setMemoryDocs(body.docs);
      setDocDrafts((current) => {
        const next = { ...current };
        for (const doc of body.docs ?? []) {
          next[doc.docKey] = doc.content;
        }
        return next;
      });
      setSelectedDocKey((current) => {
        if (current && body.docs?.some((doc) => doc.docKey === current)) return current;
        return body.docs?.[0]?.docKey ?? null;
      });
    } catch (error) {
      setMemoryError(error instanceof Error ? error.message : "Failed to load memory docs.");
    } finally {
      setMemoryLoading(false);
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
    await Promise.all([loadDeployment(), loadSessions(), loadMemoryDocs(), loadEvents()]);
  }

  useEffect(() => {
    void refreshRuntimeData();
  }, [deploymentId]);

  useEffect(() => {
    if (!activeSessionId) {
      setMessages([]);
      setMessagesLoading(false);
      return;
    }
    void loadMessages(activeSessionId);
  }, [deploymentId, activeSessionId]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const nextMessage = draft.trim();
    if (!nextMessage || sending || !activeSessionId) return;

    setSending(true);
    setChatError("");
    try {
      const response = await fetch(`/api/runtime/${deploymentId}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: nextMessage, sessionId: activeSessionId }),
      });
      const body = await readJson<RuntimeChatResponse>(response);
      if (!response.ok || !body?.ok || !body.userMessage || !body.assistantMessage) {
        throw new Error(body?.error || "Failed to send message.");
      }
      if (body.sessionId && body.sessionId !== activeSessionId) {
        setActiveSessionId(body.sessionId);
      }
      setMessages((current) => [...current, body.userMessage as ChatMessage, body.assistantMessage as ChatMessage]);
      setSessions((current) =>
        current.map((session) =>
          session.id === (body.sessionId ?? activeSessionId)
            ? {
                ...session,
                updatedAt: new Date().toISOString(),
                lastMessageAt: new Date().toISOString(),
                messageCount: session.messageCount + 2,
              }
            : session,
        ),
      );
      setDraft("");
      await loadDeployment();
    } catch (error) {
      setChatError(error instanceof Error ? error.message : "Failed to send message.");
    } finally {
      setSending(false);
    }
  }

  async function handleCreateSession() {
    if (creatingSession || sending || clearing) return;

    const promptValue = window.prompt("Session name (optional)", "");
    if (promptValue === null) return;
    const providedName = promptValue;

    setCreatingSession(true);
    setChatError("");
    try {
      const response = await fetch(`/api/runtime/${deploymentId}/sessions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(providedName.trim() ? { name: providedName.trim() } : {}),
      });
      const body = await readJson<RuntimeCreateSessionResponse>(response);
      if (!response.ok || !body?.ok || !body.session) {
        throw new Error(body?.error || "Failed to create session.");
      }
      setSessions((current) => [body.session as RuntimeSession, ...current]);
      setActiveSessionId(body.session.id);
      setMessages([]);
      setDraft("");
    } catch (error) {
      setChatError(error instanceof Error ? error.message : "Failed to create session.");
    } finally {
      setCreatingSession(false);
    }
  }

  async function handleClearCurrentSession() {
    if (clearing || sending || !activeSessionId) return;
    const confirmed = window.confirm("Clear all messages in the current session?");
    if (!confirmed) return;

    setClearing(true);
    setChatError("");
    try {
      const response = await fetch(
        `/api/runtime/${deploymentId}/messages?sessionId=${encodeURIComponent(activeSessionId)}`,
        { method: "DELETE" },
      );
      const body = (await readJson<{ ok?: boolean; error?: string }>(response)) ?? null;
      if (!response.ok || !body?.ok) {
        throw new Error(body?.error || "Failed to clear session messages.");
      }
      setMessages([]);
      setSessions((current) =>
        current.map((session) =>
          session.id === activeSessionId
            ? {
                ...session,
                messageCount: 0,
                lastMessageAt: null,
                updatedAt: new Date().toISOString(),
              }
            : session,
        ),
      );
    } catch (error) {
      setChatError(error instanceof Error ? error.message : "Failed to clear session messages.");
    } finally {
      setClearing(false);
    }
  }

  async function handleSaveMemoryDoc() {
    if (memorySaving || !selectedDocKey) return;

    setMemorySaving(true);
    setMemoryError("");
    setMemoryMessage("");
    try {
      const response = await fetch(`/api/runtime/${deploymentId}/memory`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          docKey: selectedDocKey,
          content: docDrafts[selectedDocKey] ?? "",
        }),
      });
      const body = await readJson<RuntimeMemoryPatchResponse>(response);
      if (!response.ok || !body?.ok || !body.doc) {
        throw new Error(body?.error || "Failed to save memory doc.");
      }
      setMemoryDocs((current) =>
        current.map((doc) =>
          doc.docKey === selectedDocKey
            ? { ...doc, content: body.doc?.content ?? doc.content, updatedAt: body.doc?.updatedAt ?? doc.updatedAt }
            : doc,
        ),
      );
      setMemoryMessage(`Saved ${selectedDocKey}.`);
    } catch (error) {
      setMemoryError(error instanceof Error ? error.message : "Failed to save memory doc.");
    } finally {
      setMemorySaving(false);
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

      const currentDefaultModel = normalizeDefaultModel(deployment?.settings.defaultModel);
      const nextDefaultModel = normalizeDefaultModel(defaultModel);
      if (nextDefaultModel && nextDefaultModel !== currentDefaultModel) {
        payload.defaultModel = nextDefaultModel;
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

      if (saveBody?.settings?.defaultModel && saveBody.settings.defaultModel !== defaultModel) {
        setDefaultModel(saveBody.settings.defaultModel);
      }

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
    <main className="container" style={{ maxWidth: 1180 }}>
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
            className={`button ${activeTab === "memory" ? "" : "secondary"}`}
            onClick={() => setActiveTab("memory")}
          >
            Memory
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
            <div
              style={{
                border: "1px solid var(--border)",
                borderRadius: 10,
                background: "var(--surface-strong)",
                padding: 12,
                display: "grid",
                gap: 8,
              }}
            >
              <div className="row" style={{ justifyContent: "space-between", alignItems: "center" }}>
                <p className="muted" style={{ margin: 0 }}>
                  Sessions
                </p>
                <div className="row">
                  <button
                    className="button secondary"
                    type="button"
                    onClick={() => void loadSessions()}
                    disabled={sessionsLoading || creatingSession}
                  >
                    Refresh sessions
                  </button>
                  <button
                    className="button"
                    type="button"
                    onClick={() => void handleCreateSession()}
                    disabled={creatingSession || sending || clearing}
                  >
                    {creatingSession ? "Creating..." : "New session"}
                  </button>
                </div>
              </div>

              {sessionsLoading ? (
                <p className="muted" style={{ margin: 0 }}>
                  Loading sessions...
                </p>
              ) : sessions.length === 0 ? (
                <p className="muted" style={{ margin: 0 }}>
                  No sessions yet.
                </p>
              ) : (
                <div style={{ display: "grid", gap: 6, maxHeight: 200, overflowY: "auto" }}>
                  {sessions.map((session) => {
                    const active = session.id === activeSessionId;
                    return (
                      <button
                        key={session.id}
                        type="button"
                        className={`button ${active ? "" : "secondary"}`}
                        onClick={() => setActiveSessionId(session.id)}
                        style={{
                          justifyContent: "space-between",
                          minHeight: 0,
                          padding: "10px 12px",
                        }}
                      >
                        <span style={{ textAlign: "left" }}>{session.name}</span>
                        <span style={{ fontSize: 12, opacity: 0.85 }}>
                          {session.messageCount} msg
                        </span>
                      </button>
                    );
                  })}
                </div>
              )}

              {sessionsError ? (
                <p role="alert" style={{ color: "#ff8e8e", margin: 0 }}>
                  {sessionsError}
                </p>
              ) : null}
            </div>

            <div className="row" style={{ justifyContent: "space-between", alignItems: "center" }}>
              <p className="muted" style={{ margin: 0 }}>
                Model reply target: a few seconds
              </p>
              <button
                className="button secondary"
                type="button"
                onClick={() => void handleClearCurrentSession()}
                disabled={clearing || sending || !activeSessionId}
              >
                {clearing ? "Clearing..." : "Clear current session"}
              </button>
            </div>

            <div
              style={{
                border: "1px solid var(--border)",
                borderRadius: 10,
                background: "var(--surface-strong)",
                maxHeight: "52vh",
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
              ) : !activeSessionId ? (
                <p className="muted" style={{ margin: 0 }}>
                  Select or create a session to start chatting.
                </p>
              ) : messages.length === 0 ? (
                <p className="muted" style={{ margin: 0 }}>
                  No messages yet in this session.
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
                disabled={sending || clearing || !activeSessionId}
              />
              <div className="row" style={{ justifyContent: "flex-end" }}>
                <button className="button" type="submit" disabled={sending || clearing || !draft.trim() || !activeSessionId}>
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

        {activeTab === "memory" ? (
          <section style={{ display: "grid", gap: 10 }}>
            <p className="muted" style={{ margin: 0 }}>
              Edit runtime memory docs used by the chat system prompt.
            </p>

            <div className="row" style={{ alignItems: "flex-end" }}>
              <label className="muted" style={{ display: "grid", gap: 6, minWidth: 220 }}>
                Memory file
                <select
                  className="input"
                  value={selectedDocKey ?? ""}
                  onChange={(event) => setSelectedDocKey(event.target.value || null)}
                  disabled={memoryLoading || memorySaving || memoryDocs.length === 0}
                >
                  {(memoryDocs ?? []).map((doc) => (
                    <option key={doc.docKey} value={doc.docKey}>
                      {doc.docKey}
                    </option>
                  ))}
                </select>
              </label>
              <button
                className="button secondary"
                type="button"
                onClick={() => void loadMemoryDocs()}
                disabled={memoryLoading || memorySaving}
              >
                Refresh docs
              </button>
            </div>

            {memoryLoading ? (
              <p className="muted" style={{ margin: 0 }}>
                Loading memory docs...
              </p>
            ) : selectedDocKey ? (
              <>
                <textarea
                  className="input"
                  rows={18}
                  value={docDrafts[selectedDocKey] ?? ""}
                  onChange={(event) =>
                    setDocDrafts((current) => ({
                      ...current,
                      [selectedDocKey]: event.target.value,
                    }))
                  }
                  placeholder="Write instructions or persona content for this memory doc..."
                  style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace" }}
                  disabled={memorySaving}
                />
                <div className="row" style={{ justifyContent: "space-between", alignItems: "center" }}>
                  <p className="muted" style={{ margin: 0, fontSize: 12 }}>
                    Last updated:{" "}
                    <code>{selectedDoc?.updatedAt ? new Date(selectedDoc.updatedAt).toLocaleString() : "never"}</code>
                  </p>
                  <button className="button" type="button" onClick={() => void handleSaveMemoryDoc()} disabled={memorySaving}>
                    {memorySaving ? "Saving..." : "Save memory file"}
                  </button>
                </div>
              </>
            ) : (
              <p className="muted" style={{ margin: 0 }}>
                No memory files available.
              </p>
            )}

            {memoryMessage ? <p className="muted" style={{ margin: 0 }}>{memoryMessage}</p> : null}
            {memoryError ? (
              <p role="alert" style={{ color: "#ff8e8e", margin: 0 }}>
                {memoryError}
              </p>
            ) : null}
          </section>
        ) : null}

        {activeTab === "settings" ? (
          <section style={{ display: "grid", gap: 10 }}>
            <p className="muted" style={{ margin: 0 }}>
              Update default model, provider preference, and runtime credentials. Leave secrets blank to keep existing values.
            </p>

            <label className="muted" style={{ display: "grid", gap: 6 }}>
              Default model
              <input
                className="input"
                value={defaultModel}
                onChange={(event) => setDefaultModel(event.target.value)}
                placeholder="gpt-4o-mini or claude-3-5-haiku-latest"
                disabled={settingsSaving || settingsRedeploying}
              />
            </label>

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
                Active sessions: <code>{sessions.length}</code>
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

        {deploymentLoading && activeTab !== "chat" ? (
          <p className="muted" style={{ margin: 0 }}>
            Refreshing deployment details...
          </p>
        ) : null}
      </div>
    </main>
  );
}
