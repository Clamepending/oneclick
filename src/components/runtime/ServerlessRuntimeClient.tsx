"use client";

import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
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
  selfUpdateEnabled: boolean;
};

type RuntimeTool = {
  name: string;
  description: string;
  source: "builtin" | "ottoauth-mcp";
  inputSchema: Record<string, unknown>;
  available: boolean;
  availabilityReason: string | null;
};

type RuntimeToolsConfig = {
  webEnabled: boolean;
  mcpEnabled: boolean;
  shellEnabled: boolean;
  mcpTools: Record<string, boolean>;
};

type RuntimeToolTraceEntry = {
  call_id: string;
  tool: string;
  source: "builtin" | "mcp" | "gateway";
  status: "running" | "ok" | "error";
  ok: boolean | null;
  latency_ms: number;
  arguments?: Record<string, unknown> | null;
  result?: unknown;
  error?: string | null;
};

type RuntimeContextUsage = {
  estimated: boolean;
  model: string;
  currentTokens: number;
  maxTokens: number;
  remainingTokens: number;
  usageRatio: number;
};

type DeploymentEvent = {
  status: string;
  message: string;
  ts: string;
};

type RuntimeEvent = {
  id: number;
  source: string;
  eventType: string;
  status: string;
  sessionId: string | null;
  error: string | null;
  payload: Record<string, unknown>;
  result: Record<string, unknown> | null;
  replayOfEventId: number | null;
  createdAt: string;
  updatedAt: string;
  replayable: boolean;
};

type RuntimeHealth = {
  status: string;
  provider: string | null;
  runtimeId: string | null;
  readyUrl: string | null;
  updatedAt: string;
  db: { ok: boolean };
  runtime: { probe: { ok: boolean; status: number } | null };
  telegram: { configured: boolean };
  events: {
    total24h: number;
    failed24h: number;
    latestEventAt: string | null;
    lastFailed: {
      id: number;
      status: string;
      source: string;
      error: string | null;
      createdAt: string;
    } | null;
  };
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
      turnId?: string;
      userMessage?: ChatMessage;
      assistantMessage?: ChatMessage;
      toolTrace?: RuntimeToolTraceEntry[];
      contextUsage?: RuntimeContextUsage;
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

type RuntimeToolsResponse =
  | {
      ok?: boolean;
      error?: string;
      tools?: RuntimeTool[];
      config?: {
        webEnabled?: boolean;
        mcpEnabled?: boolean;
        shellEnabled?: boolean;
        mcpTools?: Record<string, boolean>;
      };
      ottoauth?: {
        enabled?: boolean;
        baseUrl?: string;
        tokenConfigured?: boolean;
      };
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

type RuntimeEventsResponse =
  | {
      ok?: boolean;
      error?: string;
      items?: Array<{
        id?: number;
        source?: string;
        eventType?: string;
        status?: string;
        sessionId?: string | null;
        error?: string | null;
        payload?: Record<string, unknown>;
        result?: Record<string, unknown> | null;
        replayOfEventId?: number | null;
        createdAt?: string;
        updatedAt?: string;
        replayable?: boolean;
      }>;
    }
  | null;

type RuntimeHealthResponse =
  | {
      ok?: boolean;
      error?: string;
      status?: string;
      provider?: string | null;
      runtimeId?: string | null;
      readyUrl?: string | null;
      updatedAt?: string;
      db?: { ok?: boolean };
      runtime?: { probe?: { ok?: boolean; status?: number } | null };
      telegram?: { configured?: boolean };
      events?: {
        total24h?: number;
        failed24h?: number;
        latestEventAt?: string | null;
        lastFailed?: {
          id?: number;
          status?: string;
          source?: string;
          error?: string | null;
          createdAt?: string;
        } | null;
      };
    }
  | null;

type ReplayRuntimeEventResponse =
  | {
      ok?: boolean;
      error?: string | null;
      replayed?: boolean;
      eventId?: number | null;
      originalEventId?: number | null;
      sessionId?: string;
    }
  | null;

type RuntimeContextUsageResponse =
  | {
      ok?: boolean;
      error?: string;
      sessionId?: string;
      estimated?: boolean;
      model?: string;
      currentTokens?: number;
      maxTokens?: number;
      remainingTokens?: number;
      usageRatio?: number;
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

function formatTokenCount(value: number) {
  const safe = Math.max(0, Number(value || 0));
  if (safe >= 1_000_000) return `${(safe / 1_000_000).toFixed(2)}M`;
  if (safe >= 1_000) return `${(safe / 1_000).toFixed(1)}k`;
  return String(Math.round(safe));
}

function defaultToolsConfig(): RuntimeToolsConfig {
  return {
    webEnabled: true,
    mcpEnabled: true,
    shellEnabled: false,
    mcpTools: {},
  };
}

function normalizeToolTraceState(entry: Partial<RuntimeToolTraceEntry> | null | undefined): RuntimeToolTraceEntry["status"] {
  const explicit = String(entry?.status ?? "")
    .trim()
    .toLowerCase();
  if (explicit === "running" || explicit === "ok" || explicit === "error") {
    return explicit;
  }
  if (entry?.ok === true) return "ok";
  if (entry?.ok === false || String(entry?.error ?? "").trim()) return "error";
  return "running";
}

function normalizeToolTraceEntry(raw: unknown, fallbackKey: string): RuntimeToolTraceEntry | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  const sourceRaw = String(value.source ?? "")
    .trim()
    .toLowerCase();
  const source: RuntimeToolTraceEntry["source"] =
    sourceRaw === "mcp" || sourceRaw === "gateway" ? sourceRaw : "builtin";
  const status = normalizeToolTraceState({
    status: String(value.status ?? "") as RuntimeToolTraceEntry["status"],
    ok: typeof value.ok === "boolean" ? value.ok : null,
    error: typeof value.error === "string" ? value.error : null,
  });
  const ok =
    status === "running"
      ? null
      : status === "ok"
        ? true
        : false;
  return {
    call_id: String(value.call_id ?? "").trim() || fallbackKey,
    tool: String(value.tool ?? "tool"),
    source,
    status,
    ok,
    latency_ms: Math.max(0, Number(value.latency_ms ?? 0) || 0),
    arguments:
      value.arguments && typeof value.arguments === "object" && !Array.isArray(value.arguments)
        ? (value.arguments as Record<string, unknown>)
        : {},
    result: value.result ?? null,
    error: typeof value.error === "string" ? value.error : null,
  };
}

function normalizeToolTraceEntries(raw: unknown) {
  if (!Array.isArray(raw)) return [] as RuntimeToolTraceEntry[];
  return raw
    .map((entry, index) => normalizeToolTraceEntry(entry, `tc_${index + 1}`))
    .filter((entry): entry is RuntimeToolTraceEntry => Boolean(entry));
}

function mergeToolTraceEntries(
  existing: RuntimeToolTraceEntry[],
  incoming: RuntimeToolTraceEntry[],
) {
  if (!incoming.length) return existing;
  const order: string[] = [];
  const byKey = new Map<string, RuntimeToolTraceEntry>();
  for (const entry of existing) {
    const key = entry.call_id.trim();
    if (!key) continue;
    order.push(key);
    byKey.set(key, entry);
  }
  for (const entry of incoming) {
    const key = entry.call_id.trim();
    if (!key) continue;
    if (!byKey.has(key)) {
      order.push(key);
    }
    byKey.set(key, {
      ...(byKey.get(key) ?? entry),
      ...entry,
    });
  }
  return order.map((key) => byKey.get(key)).filter((entry): entry is RuntimeToolTraceEntry => Boolean(entry));
}

function buildToolTracePayload(entry: RuntimeToolTraceEntry, state: RuntimeToolTraceEntry["status"]) {
  const payload: Record<string, unknown> = {
    status: state,
  };
  const args =
    entry.arguments && typeof entry.arguments === "object" && !Array.isArray(entry.arguments)
      ? (entry.arguments as Record<string, unknown>)
      : {};
  if (Object.keys(args).length) {
    payload.arguments = args;
  }
  if (state === "ok" && entry.result !== null && entry.result !== undefined) {
    payload.result = entry.result;
  }
  if (state === "error" && entry.error) {
    payload.error = entry.error;
  }
  return payload;
}

export function ServerlessRuntimeClient({ deploymentId, botName, initialState }: Props) {
  const router = useRouter();
  const [activeTab, setActiveTab] = useState<"chat" | "memory" | "tools" | "settings" | "debug">("chat");

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
  const [latestToolTrace, setLatestToolTrace] = useState<RuntimeToolTraceEntry[]>([]);
  const [contextUsage, setContextUsage] = useState<RuntimeContextUsage | null>(null);
  const [contextUsageUnavailable, setContextUsageUnavailable] = useState(false);
  const contextUsageRequestSeq = useRef(0);
  const toolProgressPollSeq = useRef(0);
  const toolProgressPollTimer = useRef<number | null>(null);

  const [memoryDocs, setMemoryDocs] = useState<MemoryDoc[]>([]);
  const [memoryLoading, setMemoryLoading] = useState(true);
  const [memoryError, setMemoryError] = useState("");
  const [memoryMessage, setMemoryMessage] = useState("");
  const [memorySaving, setMemorySaving] = useState(false);
  const [memoryToggleSavingKey, setMemoryToggleSavingKey] = useState<string | null>(null);
  const [selectedDocKey, setSelectedDocKey] = useState<string | null>(null);
  const [docDrafts, setDocDrafts] = useState<Record<string, string>>({});

  const [tools, setTools] = useState<RuntimeTool[]>([]);
  const [toolsLoading, setToolsLoading] = useState(true);
  const [toolsError, setToolsError] = useState("");
  const [toolsMessage, setToolsMessage] = useState("");
  const [toolsSaving, setToolsSaving] = useState(false);
  const [toolsConfig, setToolsConfig] = useState<RuntimeToolsConfig>(() => defaultToolsConfig());
  const [ottoauthStatus, setOttoauthStatus] = useState<{
    enabled: boolean;
    baseUrl: string;
    tokenConfigured: boolean;
  } | null>(null);

  const [events, setEvents] = useState<DeploymentEvent[]>([]);
  const [eventsLoading, setEventsLoading] = useState(true);
  const [eventsError, setEventsError] = useState("");

  const [runtimeEvents, setRuntimeEvents] = useState<RuntimeEvent[]>([]);
  const [runtimeEventsLoading, setRuntimeEventsLoading] = useState(true);
  const [runtimeEventsError, setRuntimeEventsError] = useState("");
  const [replayingEventId, setReplayingEventId] = useState<number | null>(null);
  const [runtimeEventActionMessage, setRuntimeEventActionMessage] = useState("");

  const [runtimeHealth, setRuntimeHealth] = useState<RuntimeHealth | null>(null);
  const [runtimeHealthLoading, setRuntimeHealthLoading] = useState(true);
  const [runtimeHealthError, setRuntimeHealthError] = useState("");

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
  const contextUsageRatio = useMemo(() => {
    if (!contextUsage) return 0;
    return Math.max(0, Math.min(1, Number(contextUsage.usageRatio || 0)));
  }, [contextUsage]);
  const contextUsageLabel = useMemo(() => {
    if (contextUsageUnavailable) return "context: unavailable";
    if (!contextUsage) return "context: -- / --";
    return `context: ${formatTokenCount(contextUsage.currentTokens)} / ${formatTokenCount(contextUsage.maxTokens)}`;
  }, [contextUsage, contextUsageUnavailable]);
  const contextUsageColor = useMemo(() => {
    if (contextUsageRatio >= 0.9) return "#a33535";
    if (contextUsageRatio >= 0.75) return "#b16b21";
    return "#6a8693";
  }, [contextUsageRatio]);

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

  async function loadContextUsage(input?: { draftMessage?: string }) {
    if (!activeSessionId) {
      setContextUsage(null);
      setContextUsageUnavailable(false);
      return;
    }

    const requestSeq = ++contextUsageRequestSeq.current;
    try {
      const response = await fetch(`/api/runtime/${deploymentId}/context/usage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId: activeSessionId,
          draftMessage: input?.draftMessage ?? draft,
          model: defaultModel || deployment?.settings.defaultModel || "",
        }),
      });
      const body = await readJson<RuntimeContextUsageResponse>(response);
      if (requestSeq !== contextUsageRequestSeq.current) return;
      if (!response.ok || !body?.ok) {
        throw new Error(body?.error || "Failed to load context usage.");
      }

      setContextUsage({
        estimated: Boolean(body.estimated),
        model: String(body.model ?? (defaultModel || deployment?.settings.defaultModel || "gpt-4o-mini")),
        currentTokens: Number(body.currentTokens ?? 0),
        maxTokens: Number(body.maxTokens ?? 0),
        remainingTokens: Number(body.remainingTokens ?? 0),
        usageRatio: Number(body.usageRatio ?? 0),
      });
      setContextUsageUnavailable(false);
    } catch {
      if (requestSeq !== contextUsageRequestSeq.current) return;
      setContextUsageUnavailable(true);
    }
  }

  function stopToolProgressPolling() {
    toolProgressPollSeq.current += 1;
    if (toolProgressPollTimer.current !== null) {
      window.clearInterval(toolProgressPollTimer.current);
      toolProgressPollTimer.current = null;
    }
  }

  async function loadToolProgressForTurn(input: { sessionId: string; turnId: string; requestSeq: number }) {
    if (!input.sessionId || !input.turnId) return;
    try {
      const response = await fetch(`/api/runtime/${deploymentId}/events?limit=120`, { cache: "no-store" });
      const body = await readJson<RuntimeEventsResponse>(response);
      if (input.requestSeq !== toolProgressPollSeq.current) return;
      if (!response.ok || !body?.ok || !Array.isArray(body.items)) return;

      const traceEntries: RuntimeToolTraceEntry[] = [];
      const orderedEvents = [...body.items].sort((a, b) => Number(a.id ?? 0) - Number(b.id ?? 0));
      for (const item of orderedEvents) {
        if (String(item?.eventType ?? "").trim() !== "tool_call_progress") continue;
        if (String(item?.sessionId ?? "").trim() !== input.sessionId) continue;
        const payload =
          item?.payload && typeof item.payload === "object"
            ? (item.payload as Record<string, unknown>)
            : {};
        const payloadTurnId = String(payload.turnId ?? "").trim();
        if (payloadTurnId !== input.turnId) continue;
        traceEntries.push(...normalizeToolTraceEntries(payload.toolTrace));
      }
      if (!traceEntries.length) return;
      setLatestToolTrace((current) => mergeToolTraceEntries(current, traceEntries));
    } catch {
      // Best-effort progress polling; final chat response still contains authoritative trace.
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

  async function loadTools() {
    setToolsLoading(true);
    setToolsError("");
    setToolsMessage("");
    try {
      const response = await fetch(`/api/runtime/${deploymentId}/tools`, { cache: "no-store" });
      const body = await readJson<RuntimeToolsResponse>(response);
      if (!response.ok || !body?.ok || !Array.isArray(body.tools)) {
        throw new Error(body?.error || "Failed to load tools.");
      }
      const toolsList = body.tools as RuntimeTool[];
      setTools(toolsList);
      setOttoauthStatus({
        enabled: Boolean(body.ottoauth?.enabled),
        baseUrl: String(body.ottoauth?.baseUrl ?? ""),
        tokenConfigured: Boolean(body.ottoauth?.tokenConfigured),
      });
      setToolsConfig((current) => {
        const mcpToolNames = toolsList
          .filter((tool) => tool.source === "ottoauth-mcp")
          .map((tool) => tool.name)
          .filter((name) => Boolean(name.trim()));
        const configuredMcpMap = body.config?.mcpTools ?? {};
        const mcpToolsMap: Record<string, boolean> = {};
        for (const toolName of mcpToolNames) {
          if (typeof configuredMcpMap[toolName] === "boolean") {
            mcpToolsMap[toolName] = Boolean(configuredMcpMap[toolName]);
          } else if (typeof current.mcpTools[toolName] === "boolean") {
            mcpToolsMap[toolName] = Boolean(current.mcpTools[toolName]);
          } else {
            mcpToolsMap[toolName] = true;
          }
        }
        return {
          webEnabled: body.config?.webEnabled ?? current.webEnabled,
          mcpEnabled: body.config?.mcpEnabled ?? current.mcpEnabled,
          shellEnabled: body.config?.shellEnabled ?? current.shellEnabled,
          mcpTools: mcpToolsMap,
        };
      });
    } catch (error) {
      setToolsError(error instanceof Error ? error.message : "Failed to load tools.");
    } finally {
      setToolsLoading(false);
    }
  }

  async function handleSaveToolsConfig() {
    if (toolsSaving || toolsLoading) return;
    setToolsSaving(true);
    setToolsError("");
    setToolsMessage("");
    try {
      const response = await fetch(`/api/runtime/${deploymentId}/tools`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          webEnabled: toolsConfig.webEnabled,
          mcpEnabled: toolsConfig.mcpEnabled,
          shellEnabled: toolsConfig.shellEnabled,
          mcpTools: toolsConfig.mcpTools,
        }),
      });
      const body = await readJson<RuntimeToolsResponse>(response);
      if (!response.ok || !body?.ok || !Array.isArray(body.tools)) {
        throw new Error(body?.error || "Failed to save tool settings.");
      }
      const toolsList = body.tools as RuntimeTool[];
      setTools(toolsList);
      setOttoauthStatus({
        enabled: Boolean(body.ottoauth?.enabled),
        baseUrl: String(body.ottoauth?.baseUrl ?? ""),
        tokenConfigured: Boolean(body.ottoauth?.tokenConfigured),
      });
      setToolsConfig((current) => {
        const mcpToolNames = toolsList
          .filter((tool) => tool.source === "ottoauth-mcp")
          .map((tool) => tool.name)
          .filter((name) => Boolean(name.trim()));
        const configuredMcpMap = body.config?.mcpTools ?? {};
        const mcpToolsMap: Record<string, boolean> = {};
        for (const toolName of mcpToolNames) {
          if (typeof configuredMcpMap[toolName] === "boolean") {
            mcpToolsMap[toolName] = Boolean(configuredMcpMap[toolName]);
          } else if (typeof current.mcpTools[toolName] === "boolean") {
            mcpToolsMap[toolName] = Boolean(current.mcpTools[toolName]);
          } else {
            mcpToolsMap[toolName] = true;
          }
        }
        return {
          webEnabled: body.config?.webEnabled ?? current.webEnabled,
          mcpEnabled: body.config?.mcpEnabled ?? current.mcpEnabled,
          shellEnabled: body.config?.shellEnabled ?? current.shellEnabled,
          mcpTools: mcpToolsMap,
        };
      });
      setToolsMessage("Tool settings saved.");
    } catch (error) {
      setToolsError(error instanceof Error ? error.message : "Failed to save tool settings.");
    } finally {
      setToolsSaving(false);
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

  async function loadRuntimeEvents() {
    setRuntimeEventsLoading(true);
    setRuntimeEventsError("");
    try {
      const response = await fetch(`/api/runtime/${deploymentId}/events?limit=120`, { cache: "no-store" });
      const body = await readJson<RuntimeEventsResponse>(response);
      if (!response.ok || !body?.ok || !Array.isArray(body.items)) {
        throw new Error(body?.error || "Failed to load runtime events.");
      }
      setRuntimeEvents(
        body.items
          .filter((item) => item && typeof item.id === "number")
          .map((item) => ({
            id: item.id as number,
            source: String(item.source ?? "unknown"),
            eventType: String(item.eventType ?? "unknown"),
            status: String(item.status ?? "unknown"),
            sessionId: typeof item.sessionId === "string" ? item.sessionId : null,
            error: typeof item.error === "string" ? item.error : null,
            payload: item.payload && typeof item.payload === "object" ? item.payload : {},
            result: item.result && typeof item.result === "object" ? item.result : null,
            replayOfEventId: typeof item.replayOfEventId === "number" ? item.replayOfEventId : null,
            createdAt: String(item.createdAt ?? new Date().toISOString()),
            updatedAt: String(item.updatedAt ?? item.createdAt ?? new Date().toISOString()),
            replayable: Boolean(item.replayable),
          })),
      );
    } catch (error) {
      setRuntimeEventsError(error instanceof Error ? error.message : "Failed to load runtime events.");
    } finally {
      setRuntimeEventsLoading(false);
    }
  }

  async function loadRuntimeHealth() {
    setRuntimeHealthLoading(true);
    setRuntimeHealthError("");
    try {
      const response = await fetch(`/api/runtime/${deploymentId}/health`, { cache: "no-store" });
      const body = await readJson<RuntimeHealthResponse>(response);
      if (!response.ok || !body?.ok || !body.status) {
        throw new Error(body?.error || "Failed to load runtime health.");
      }
      setRuntimeHealth({
        status: body.status,
        provider: body.provider ?? null,
        runtimeId: body.runtimeId ?? null,
        readyUrl: body.readyUrl ?? null,
        updatedAt: body.updatedAt ?? "",
        db: {
          ok: Boolean(body.db?.ok),
        },
        runtime: {
          probe:
            body.runtime?.probe &&
            typeof body.runtime.probe.ok === "boolean" &&
            typeof body.runtime.probe.status === "number"
              ? {
                  ok: body.runtime.probe.ok,
                  status: body.runtime.probe.status,
                }
              : null,
        },
        telegram: {
          configured: Boolean(body.telegram?.configured),
        },
        events: {
          total24h: Number(body.events?.total24h ?? 0),
          failed24h: Number(body.events?.failed24h ?? 0),
          latestEventAt: body.events?.latestEventAt ?? null,
          lastFailed:
            body.events?.lastFailed && typeof body.events.lastFailed.id === "number"
              ? {
                  id: body.events.lastFailed.id,
                  status: String(body.events.lastFailed.status ?? "unknown"),
                  source: String(body.events.lastFailed.source ?? "unknown"),
                  error:
                    typeof body.events.lastFailed.error === "string"
                      ? body.events.lastFailed.error
                      : null,
                  createdAt: String(body.events.lastFailed.createdAt ?? ""),
                }
              : null,
        },
      });
    } catch (error) {
      setRuntimeHealthError(error instanceof Error ? error.message : "Failed to load runtime health.");
    } finally {
      setRuntimeHealthLoading(false);
    }
  }

  async function refreshRuntimeData() {
    await Promise.all([
      loadDeployment(),
      loadSessions(),
      loadMemoryDocs(),
      loadTools(),
      loadEvents(),
      loadRuntimeEvents(),
      loadRuntimeHealth(),
    ]);
  }

  useEffect(() => {
    void refreshRuntimeData();
  }, [deploymentId]);

  useEffect(() => {
    return () => {
      toolProgressPollSeq.current += 1;
      if (toolProgressPollTimer.current !== null) {
        window.clearInterval(toolProgressPollTimer.current);
        toolProgressPollTimer.current = null;
      }
    };
  }, []);

  useEffect(() => {
    if (!activeSessionId) {
      stopToolProgressPolling();
      setMessages([]);
      setMessagesLoading(false);
      setLatestToolTrace([]);
      setContextUsage(null);
      setContextUsageUnavailable(false);
      return;
    }
    stopToolProgressPolling();
    setLatestToolTrace([]);
    void loadMessages(activeSessionId);
  }, [deploymentId, activeSessionId]);

  useEffect(() => {
    if (activeTab !== "chat" || !activeSessionId) return;
    const timer = setTimeout(() => {
      void loadContextUsage();
    }, 140);
    return () => clearTimeout(timer);
  }, [activeTab, deploymentId, activeSessionId, draft, defaultModel, deployment?.settings.defaultModel, messages.length]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const nextMessage = draft.trim();
    if (!nextMessage || sending || !activeSessionId) return;

    const turnSessionId = activeSessionId;
    const turnId = `turn_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    stopToolProgressPolling();
    setLatestToolTrace([]);

    setSending(true);
    setChatError("");
    const pollRequestSeq = ++toolProgressPollSeq.current;
    const poll = () =>
      void loadToolProgressForTurn({
        sessionId: turnSessionId,
        turnId,
        requestSeq: pollRequestSeq,
      });
    poll();
    toolProgressPollTimer.current = window.setInterval(poll, 450);

    try {
      const response = await fetch(`/api/runtime/${deploymentId}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: nextMessage, sessionId: turnSessionId, turnId }),
      });
      const body = await readJson<RuntimeChatResponse>(response);
      if (!response.ok || !body?.ok || !body.userMessage || !body.assistantMessage) {
        throw new Error(body?.error || "Failed to send message.");
      }
      const resolvedSessionId = body.sessionId ?? turnSessionId;
      const resolvedTurnId = String(body.turnId ?? turnId).trim() || turnId;
      if (body.sessionId && body.sessionId !== turnSessionId) {
        setActiveSessionId(body.sessionId);
      }
      setMessages((current) => [...current, body.userMessage as ChatMessage, body.assistantMessage as ChatMessage]);
      await loadToolProgressForTurn({
        sessionId: resolvedSessionId,
        turnId: resolvedTurnId,
        requestSeq: pollRequestSeq,
      });
      setLatestToolTrace((current) =>
        mergeToolTraceEntries(current, normalizeToolTraceEntries(body.toolTrace)),
      );
      if (body.contextUsage) {
        setContextUsage({
          estimated: Boolean(body.contextUsage.estimated),
          model: String(
            body.contextUsage.model ?? (defaultModel || deployment?.settings.defaultModel || "gpt-4o-mini"),
          ),
          currentTokens: Number(body.contextUsage.currentTokens ?? 0),
          maxTokens: Number(body.contextUsage.maxTokens ?? 0),
          remainingTokens: Number(body.contextUsage.remainingTokens ?? 0),
          usageRatio: Number(body.contextUsage.usageRatio ?? 0),
        });
        setContextUsageUnavailable(false);
      } else {
        void loadContextUsage({ draftMessage: "" });
      }
      setSessions((current) =>
        current.map((session) =>
          session.id === resolvedSessionId
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
      stopToolProgressPolling();
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
      stopToolProgressPolling();
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
      setLatestToolTrace([]);
      setContextUsage(null);
      setContextUsageUnavailable(false);
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
      stopToolProgressPolling();
      const response = await fetch(
        `/api/runtime/${deploymentId}/messages?sessionId=${encodeURIComponent(activeSessionId)}`,
        { method: "DELETE" },
      );
      const body = (await readJson<{ ok?: boolean; error?: string }>(response)) ?? null;
      if (!response.ok || !body?.ok) {
        throw new Error(body?.error || "Failed to clear session messages.");
      }
      setMessages([]);
      setLatestToolTrace([]);
      setContextUsage(null);
      setContextUsageUnavailable(false);
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

  async function handleReplayRuntimeEvent(eventId: number) {
    if (replayingEventId !== null) return;
    setReplayingEventId(eventId);
    setRuntimeEventActionMessage("");
    setRuntimeEventsError("");
    try {
      const response = await fetch(`/api/runtime/${deploymentId}/events/${eventId}/replay`, {
        method: "POST",
      });
      const body = await readJson<ReplayRuntimeEventResponse>(response);
      if (!response.ok || !body) {
        throw new Error(body?.error || "Failed to replay runtime event.");
      }
      if (body.ok) {
        setRuntimeEventActionMessage("Replay succeeded.");
      } else {
        const detail = body.error ? ` (${body.error})` : "";
        setRuntimeEventActionMessage(`Replay attempted but did not complete${detail}.`);
      }
      await Promise.all([loadRuntimeEvents(), loadRuntimeHealth(), loadSessions(), loadDeployment()]);
      if (body.sessionId && body.sessionId === activeSessionId) {
        await loadMessages(body.sessionId);
      }
    } catch (error) {
      setRuntimeEventsError(error instanceof Error ? error.message : "Failed to replay runtime event.");
    } finally {
      setReplayingEventId(null);
    }
  }

  async function patchMemoryDoc(input: {
    docKey: string;
    content?: string;
    selfUpdateEnabled?: boolean;
    successMessage: string;
    syncDraft?: boolean;
  }) {
    const response = await fetch(`/api/runtime/${deploymentId}/memory`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        docKey: input.docKey,
        ...(input.content !== undefined ? { content: input.content } : {}),
        ...(input.selfUpdateEnabled !== undefined ? { selfUpdateEnabled: input.selfUpdateEnabled } : {}),
      }),
    });
    const body = await readJson<RuntimeMemoryPatchResponse>(response);
    if (!response.ok || !body?.ok || !body.doc) {
      throw new Error(body?.error || "Failed to save memory doc.");
    }

    setMemoryDocs((current) => {
      const existing = current.find((doc) => doc.docKey === input.docKey);
      if (!existing) {
        return [
          ...current,
          {
            docKey: input.docKey,
            content: body.doc?.content ?? "",
            updatedAt: body.doc?.updatedAt ?? null,
            selfUpdateEnabled: body.doc?.selfUpdateEnabled ?? true,
          },
        ];
      }
      return current.map((doc) =>
        doc.docKey === input.docKey
          ? {
              ...doc,
              content: body.doc?.content ?? doc.content,
              updatedAt: body.doc?.updatedAt ?? doc.updatedAt,
              selfUpdateEnabled: body.doc?.selfUpdateEnabled ?? doc.selfUpdateEnabled,
            }
          : doc,
      );
    });

    if (input.syncDraft) {
      setDocDrafts((current) => ({
        ...current,
        [input.docKey]: body.doc?.content ?? current[input.docKey] ?? "",
      }));
    }
    setMemoryMessage(input.successMessage);
  }

  async function handleSaveMemoryDoc() {
    if (memorySaving || !selectedDocKey) return;

    setMemorySaving(true);
    setMemoryError("");
    setMemoryMessage("");
    try {
      await patchMemoryDoc({
        docKey: selectedDocKey,
        content: docDrafts[selectedDocKey] ?? "",
        successMessage: `Saved ${selectedDocKey}.`,
        syncDraft: true,
      });
    } catch (error) {
      setMemoryError(error instanceof Error ? error.message : "Failed to save memory doc.");
    } finally {
      setMemorySaving(false);
    }
  }

  async function handleSetMemorySelfUpdate(docKey: string, selfUpdateEnabled: boolean) {
    if (memoryLoading || memorySaving || memoryToggleSavingKey === docKey) return;

    setMemoryToggleSavingKey(docKey);
    setMemoryError("");
    setMemoryMessage("");
    try {
      await patchMemoryDoc({
        docKey,
        selfUpdateEnabled,
        successMessage: `${selfUpdateEnabled ? "Enabled" : "Disabled"} auto-update for ${docKey}.`,
      });
    } catch (error) {
      setMemoryError(error instanceof Error ? error.message : "Failed to update memory toggle.");
    } finally {
      setMemoryToggleSavingKey(null);
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

        <nav className="runtime-tab-strip" aria-label="Runtime sections">
          <button
            type="button"
            className={`runtime-tab-btn ${activeTab === "chat" ? "active" : ""}`}
            onClick={() => setActiveTab("chat")}
          >
            Chat
          </button>
          <button
            type="button"
            className={`runtime-tab-btn ${activeTab === "memory" ? "active" : ""}`}
            onClick={() => setActiveTab("memory")}
          >
            Memory
          </button>
          <button
            type="button"
            className={`runtime-tab-btn ${activeTab === "tools" ? "active" : ""}`}
            onClick={() => setActiveTab("tools")}
          >
            Tools
          </button>
          <button
            type="button"
            className={`runtime-tab-btn ${activeTab === "settings" ? "active" : ""}`}
            onClick={() => setActiveTab("settings")}
          >
            Settings
          </button>
          <button
            type="button"
            className={`runtime-tab-btn ${activeTab === "debug" ? "active" : ""}`}
            onClick={() => setActiveTab("debug")}
          >
            Debug
          </button>
        </nav>

        {activeTab === "chat" ? (
          <section style={{ display: "grid", gap: 10 }}>
            <div className="runtime-chat-layout">
              <aside className="runtime-panel" style={{ display: "grid", gap: 10 }}>
                <div className="row" style={{ justifyContent: "space-between", alignItems: "center", margin: 0 }}>
                  <p className="runtime-section-title" style={{ margin: 0 }}>
                    Sessions
                  </p>
                  <div className="row" style={{ margin: 0 }}>
                    <button
                      className="button secondary"
                      type="button"
                      onClick={() => void loadSessions()}
                      disabled={sessionsLoading || creatingSession}
                    >
                      Refresh
                    </button>
                    <button
                      className="button"
                      type="button"
                      onClick={() => void handleCreateSession()}
                      disabled={creatingSession || sending || clearing}
                    >
                      {creatingSession ? "Creating..." : "New"}
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
                  <div className="runtime-list">
                    {sessions.map((session) => {
                      const active = session.id === activeSessionId;
                      return (
                        <button
                          key={session.id}
                          type="button"
                          className={`runtime-list-item ${active ? "active" : ""}`}
                          onClick={() => setActiveSessionId(session.id)}
                        >
                          <span style={{ textAlign: "left", overflow: "hidden", textOverflow: "ellipsis" }}>
                            {session.name}
                          </span>
                          <span className="muted" style={{ fontSize: 12 }}>
                            {session.messageCount} msg
                          </span>
                        </button>
                      );
                    })}
                  </div>
                )}

                <p className="muted" style={{ margin: 0, fontSize: 12 }}>
                  Model reply target: a few seconds
                </p>
                {sessionsError ? (
                  <p role="alert" style={{ color: "#ff8e8e", margin: 0 }}>
                    {sessionsError}
                  </p>
                ) : null}
              </aside>

              <div className="runtime-panel runtime-chat-main">
                <div className="row" style={{ justifyContent: "space-between", alignItems: "center", margin: 0 }}>
                  <p className="runtime-section-title" style={{ margin: 0 }}>
                    Conversation
                  </p>
                  <button
                    className="button secondary"
                    type="button"
                    onClick={() => void handleClearCurrentSession()}
                    disabled={clearing || sending || !activeSessionId}
                  >
                    {clearing ? "Clearing..." : "Clear session"}
                  </button>
                </div>

                <div className="runtime-chat-scroll">
                  {messagesLoading ? (
                    <p className="muted" style={{ margin: 0 }}>
                      Loading messages...
                    </p>
                  ) : !activeSessionId ? (
                    <p className="muted" style={{ margin: 0 }}>
                      Select or create a session to start chatting.
                    </p>
                  ) : messages.length === 0 && !sending ? (
                    <p className="muted" style={{ margin: 0 }}>
                      No messages yet in this session.
                    </p>
                  ) : (
                    <>
                      {messages.map((message) => (
                        <div
                          key={message.id}
                          className={`runtime-msg ${message.role === "user" ? "runtime-msg-user" : "runtime-msg-assistant"}`}
                          style={{ justifySelf: message.role === "user" ? "end" : "start" }}
                        >
                          <p style={{ margin: 0, whiteSpace: "pre-wrap" }}>{message.content}</p>
                        </div>
                      ))}
                      {sending ? (
                        <div className="runtime-msg runtime-msg-assistant" style={{ justifySelf: "start" }}>
                          <p className="muted" style={{ margin: 0 }}>
                            Typing...
                          </p>
                        </div>
                      ) : null}
                      {latestToolTrace.length ? (
                        <div className="runtime-tool-trace-group">
                          <div className="runtime-tool-trace-title">Tool Calls</div>
                          {latestToolTrace.map((entry, index) => {
                            const state = normalizeToolTraceState(entry);
                            const payload = buildToolTracePayload(entry, state);
                            return (
                              <details
                                key={`${entry.call_id || "call"}-${entry.tool}-${index}`}
                                className="runtime-tool-call"
                              >
                                <summary>
                                  <span className={`runtime-tool-call-state ${state}`}>
                                    {state === "running" ? "CALLED" : state === "ok" ? "COMPLETED" : "ERROR"}
                                  </span>
                                  <span className="runtime-tool-call-name">{entry.tool}</span>
                                  <span className="runtime-tool-call-meta">
                                    {state === "running"
                                      ? `${entry.source} · calling...`
                                      : `${entry.source} · ${Math.max(0, Number(entry.latency_ms || 0))}ms`}
                                  </span>
                                </summary>
                                <pre className="runtime-tool-call-payload">{JSON.stringify(payload, null, 2)}</pre>
                              </details>
                            );
                          })}
                        </div>
                      ) : null}
                    </>
                  )}
                </div>

                <form onSubmit={handleSubmit} className="runtime-compose-row">
                  <textarea
                    className="input"
                    value={draft}
                    onChange={(event) => setDraft(event.target.value)}
                    placeholder="Type your message..."
                    rows={3}
                    disabled={sending || clearing || !activeSessionId}
                  />
                  <button
                    className="button"
                    type="submit"
                    disabled={sending || clearing || !draft.trim() || !activeSessionId}
                  >
                    {sending ? "Sending..." : "Send"}
                  </button>
                </form>

                <div className="runtime-context-meter-wrap">
                  <div className="runtime-context-meter">
                    <div
                      className="runtime-context-meter-bar"
                      style={{
                        width: `${(contextUsageRatio * 100).toFixed(1)}%`,
                        background: contextUsageColor,
                      }}
                    />
                  </div>
                  <div className="runtime-context-meter-label" title="Estimated prompt context usage for the selected model.">
                    {contextUsageLabel}
                  </div>
                </div>

              </div>
            </div>

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

            {memoryDocs.length ? (
              <div style={{ display: "grid", gap: 6 }}>
                <p className="muted" style={{ margin: 0 }}>
                  Agent self-update toggles
                </p>
                <div style={{ display: "grid", gap: 6 }}>
                  {memoryDocs.map((doc) => (
                    <label
                      key={`self-update-${doc.docKey}`}
                      className="muted"
                      style={{ display: "flex", alignItems: "center", gap: 8 }}
                    >
                      <input
                        type="checkbox"
                        checked={doc.selfUpdateEnabled}
                        onChange={(event) => void handleSetMemorySelfUpdate(doc.docKey, event.target.checked)}
                        disabled={memoryLoading || memorySaving || memoryToggleSavingKey === doc.docKey}
                      />
                      <span>{`Update ${doc.docKey}`}</span>
                      {memoryToggleSavingKey === doc.docKey ? (
                        <span className="muted" style={{ fontSize: 12 }}>
                          Saving...
                        </span>
                      ) : null}
                    </label>
                  ))}
                </div>
              </div>
            ) : null}

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

        {activeTab === "tools" ? (
          <section style={{ display: "grid", gap: 10 }}>
            <div className="row" style={{ justifyContent: "space-between", alignItems: "center" }}>
              <p className="muted" style={{ margin: 0 }}>
                Tools available to the serverless agent
              </p>
              <div className="row">
                <button
                  className="button secondary"
                  type="button"
                  onClick={() => void loadTools()}
                  disabled={toolsLoading || toolsSaving}
                >
                  {toolsLoading ? "Refreshing..." : "Refresh tools"}
                </button>
                <button
                  className="button"
                  type="button"
                  onClick={() => void handleSaveToolsConfig()}
                  disabled={toolsLoading || toolsSaving}
                >
                  {toolsSaving ? "Saving..." : "Save tool settings"}
                </button>
              </div>
            </div>

            {ottoauthStatus ? (
              <div
                style={{
                  border: "1px solid var(--border)",
                  borderRadius: 10,
                  background: "var(--surface-strong)",
                  padding: 10,
                  display: "grid",
                  gap: 4,
                }}
              >
                <p className="muted" style={{ margin: 0 }}>
                  OttoAuth MCP: <code>{ottoauthStatus.enabled ? "enabled" : "disabled"}</code>
                </p>
                <p className="muted" style={{ margin: 0 }}>
                  Base URL: <code>{ottoauthStatus.baseUrl || "n/a"}</code>
                </p>
                <p className="muted" style={{ margin: 0 }}>
                  Gateway token: <code>{ottoauthStatus.tokenConfigured ? "configured" : "not configured"}</code>
                </p>
              </div>
            ) : null}

            <div
              style={{
                border: "1px solid var(--border)",
                borderRadius: 10,
                background: "var(--surface-strong)",
                padding: 10,
                display: "grid",
                gap: 8,
              }}
            >
              <label className="muted" style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <input
                  type="checkbox"
                  checked={toolsConfig.webEnabled}
                  onChange={(event) =>
                    setToolsConfig((current) => ({
                      ...current,
                      webEnabled: event.target.checked,
                    }))
                  }
                  disabled={toolsLoading || toolsSaving}
                />
                <span>Enable web tools (`web_search`, `web_fetch`)</span>
              </label>
              <label className="muted" style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <input
                  type="checkbox"
                  checked={toolsConfig.mcpEnabled}
                  onChange={(event) =>
                    setToolsConfig((current) => ({
                      ...current,
                      mcpEnabled: event.target.checked,
                    }))
                  }
                  disabled={toolsLoading || toolsSaving}
                />
                <span>Enable OttoAuth MCP tools</span>
              </label>
              <label className="muted" style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <input type="checkbox" checked={toolsConfig.shellEnabled} disabled />
                <span>Shell tool support (not available on this serverless runtime yet)</span>
              </label>

              <div style={{ display: "grid", gap: 6 }}>
                <p className="muted" style={{ margin: 0 }}>
                  MCP tool toggles
                </p>
                {tools
                  .filter((tool) => tool.source === "ottoauth-mcp")
                  .map((tool) => (
                    <label
                      key={`mcp-toggle-${tool.name}`}
                      className="muted"
                      style={{ display: "flex", alignItems: "center", gap: 8 }}
                    >
                      <input
                        type="checkbox"
                        checked={toolsConfig.mcpTools[tool.name] !== false}
                        onChange={(event) =>
                          setToolsConfig((current) => ({
                            ...current,
                            mcpTools: {
                              ...current.mcpTools,
                              [tool.name]: event.target.checked,
                            },
                          }))
                        }
                        disabled={toolsLoading || toolsSaving}
                      />
                      <span>{tool.name}</span>
                    </label>
                  ))}
              </div>
            </div>

            {toolsLoading ? (
              <p className="muted" style={{ margin: 0 }}>
                Loading tools...
              </p>
            ) : tools.length === 0 ? (
              <p className="muted" style={{ margin: 0 }}>
                No tools available.
              </p>
            ) : (
              <div style={{ display: "grid", gap: 8 }}>
                {tools.map((tool) => (
                  <div
                    key={tool.name}
                    style={{
                      border: "1px solid var(--border)",
                      borderRadius: 10,
                      background: "var(--surface-strong)",
                      padding: 10,
                      display: "grid",
                      gap: 4,
                    }}
                  >
                    <p style={{ margin: 0 }}>
                      <code>{tool.name}</code>
                    </p>
                    <p className="muted" style={{ margin: 0 }}>
                      {tool.description || "No description."}
                    </p>
                    <p className="muted" style={{ margin: 0 }}>
                      Source: <code>{tool.source}</code> | Status: <code>{tool.available ? "available" : "unavailable"}</code>
                    </p>
                    {tool.availabilityReason ? (
                      <p className="muted" style={{ margin: 0 }}>
                        Reason: <code>{tool.availabilityReason}</code>
                      </p>
                    ) : null}
                  </div>
                ))}
              </div>
            )}

            {toolsMessage ? <p className="muted" style={{ margin: 0 }}>{toolsMessage}</p> : null}
            {toolsError ? (
              <p role="alert" style={{ color: "#ff8e8e", margin: 0 }}>
                {toolsError}
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
                DB health: <code>{runtimeHealthLoading ? "loading" : runtimeHealth?.db.ok ? "ok" : "not_ok"}</code>
              </p>
              <p className="muted" style={{ margin: 0 }}>
                Runtime probe:{" "}
                <code>
                  {runtimeHealthLoading
                    ? "loading"
                    : runtimeHealth?.runtime.probe
                      ? `${runtimeHealth.runtime.probe.ok ? "ok" : "not_ok"} (${runtimeHealth.runtime.probe.status})`
                      : "n/a"}
                </code>
              </p>
              <p className="muted" style={{ margin: 0 }}>
                Telegram configured: <code>{runtimeHealthLoading ? "loading" : runtimeHealth?.telegram.configured ? "yes" : "no"}</code>
              </p>
              <p className="muted" style={{ margin: 0 }}>
                Runtime events (24h):{" "}
                <code>
                  {runtimeHealthLoading
                    ? "loading"
                    : `${runtimeHealth?.events.total24h ?? 0} total / ${runtimeHealth?.events.failed24h ?? 0} failed`}
                </code>
              </p>
              <p className="muted" style={{ margin: 0 }}>
                Active sessions: <code>{sessions.length}</code>
              </p>
              <p className="muted" style={{ margin: 0 }}>
                Updated: <code>{deployment?.updatedAt ? new Date(deployment.updatedAt).toLocaleString() : "unknown"}</code>
              </p>
              {runtimeHealth?.events.lastFailed ? (
                <p style={{ color: "#ffb3b3", margin: 0 }}>
                  Last runtime error ({new Date(runtimeHealth.events.lastFailed.createdAt).toLocaleTimeString()}):{" "}
                  {runtimeHealth.events.lastFailed.error || "Unknown runtime failure"}
                </p>
              ) : null}
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
              <p className="muted" style={{ margin: 0 }}>
                Runtime event log
              </p>
              {runtimeEventsLoading ? (
                <p className="muted" style={{ margin: 0 }}>
                  Loading runtime events...
                </p>
              ) : runtimeEvents.length === 0 ? (
                <p className="muted" style={{ margin: 0 }}>
                  No runtime events yet.
                </p>
              ) : (
                runtimeEvents.map((item) => {
                  const payloadText = typeof item.payload.text === "string" ? item.payload.text : "";
                  return (
                    <div
                      key={`runtime-event-${item.id}`}
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
                        <strong style={{ fontSize: 12, letterSpacing: 0.3 }}>
                          {item.status.toUpperCase()} · {item.source}
                        </strong>
                        <span className="muted" style={{ fontSize: 12 }}>
                          {new Date(item.createdAt).toLocaleTimeString()}
                        </span>
                      </div>
                      <p className="muted" style={{ margin: 0 }}>
                        Event: <code>{item.eventType}</code> | Session: <code>{item.sessionId ?? "n/a"}</code>
                      </p>
                      {payloadText ? <p style={{ margin: 0 }}>Input: {payloadText}</p> : null}
                      {item.error ? (
                        <p style={{ margin: 0, color: "#ff9d9d" }}>
                          Error: {item.error}
                        </p>
                      ) : null}
                      {item.replayable ? (
                        <div className="row" style={{ justifyContent: "flex-end" }}>
                          <button
                            className="button secondary"
                            type="button"
                            onClick={() => void handleReplayRuntimeEvent(item.id)}
                            disabled={replayingEventId === item.id || replayingEventId !== null}
                          >
                            {replayingEventId === item.id ? "Replaying..." : "Replay"}
                          </button>
                        </div>
                      ) : null}
                    </div>
                  );
                })
              )}
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
              <p className="muted" style={{ margin: 0 }}>
                Deployment orchestration events
              </p>
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

            {runtimeEventActionMessage ? (
              <p className="muted" style={{ margin: 0 }}>
                {runtimeEventActionMessage}
              </p>
            ) : null}
            {eventsError ? (
              <p role="alert" style={{ color: "#ff8e8e", margin: 0 }}>
                {eventsError}
              </p>
            ) : null}
            {runtimeEventsError ? (
              <p role="alert" style={{ color: "#ff8e8e", margin: 0 }}>
                {runtimeEventsError}
              </p>
            ) : null}
            {runtimeHealthError ? (
              <p role="alert" style={{ color: "#ff8e8e", margin: 0 }}>
                {runtimeHealthError}
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
