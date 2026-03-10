import { pool } from "@/lib/db";
import { ensureOttoAuthAccountForBot } from "@/lib/runtime/ottoauthAccounts";

type ToolJson = Record<string, unknown>;

type RuntimeToolPolicyBlob = {
  web_enabled?: unknown;
  mcp_enabled?: unknown;
  shell_enabled?: unknown;
  disabled_tools?: unknown;
};

export type ServerlessRuntimeToolPolicy = {
  webEnabled: boolean;
  mcpEnabled: boolean;
  shellEnabled: boolean;
  disabledTools: string[];
};

export type ServerlessRuntimeTool = {
  name: string;
  description: string;
  source: "builtin" | "ottoauth-mcp";
  inputSchema: ToolJson;
  available: boolean;
  availabilityReason: string | null;
};

export type ServerlessRuntimeToolCatalog = {
  tools: ServerlessRuntimeTool[];
  ottoauth: {
    enabled: boolean;
    baseUrl: string;
    tokenConfigured: boolean;
  };
  policy: {
    webEnabled: boolean;
    mcpEnabled: boolean;
    shellEnabled: boolean;
    mcpTools: Record<string, boolean>;
  };
};

export type ServerlessRuntimeToolResult = {
  ok: boolean;
  tool: string;
  result?: unknown;
  error?: string;
};

const DEFAULT_POLICY: ServerlessRuntimeToolPolicy = {
  webEnabled: true,
  mcpEnabled: true,
  shellEnabled: false,
  disabledTools: [],
};

const OTTOAUTH_TOOL_NAMES = [
  "ottoauth_list_services",
  "ottoauth_get_service",
  "ottoauth_http_request",
] as const;

function readTrimmedEnv(name: string) {
  const raw = process.env[name];
  if (!raw) return "";
  return raw.trim().replace(/^("|')(.*)("|')$/, "$2").trim();
}

function readBoolEnv(name: string, fallback: boolean) {
  const raw = readTrimmedEnv(name).toLowerCase();
  if (!raw) return fallback;
  if (["1", "true", "yes", "on"].includes(raw)) return true;
  if (["0", "false", "no", "off"].includes(raw)) return false;
  return fallback;
}

function asObject(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {} as ToolJson;
  return value as ToolJson;
}

function normalizeBaseUrl(raw: string, fallback: string) {
  const trimmed = raw.trim();
  const withProtocol = trimmed && /^https?:\/\//i.test(trimmed) ? trimmed : trimmed ? `https://${trimmed}` : fallback;
  const parsed = new URL(withProtocol);
  parsed.pathname = "/";
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString().replace(/\/$/, "");
}

function normalizeToolName(value: unknown) {
  return String(value ?? "").trim().toLowerCase();
}

function normalizeDisabledTools(value: unknown) {
  if (!Array.isArray(value)) return [] as string[];
  return Array.from(
    new Set(
      value
        .map((item) => normalizeToolName(item))
        .filter((item) => Boolean(item)),
    ),
  ).sort((a, b) => a.localeCompare(b));
}

function parseToolPolicy(value: unknown): ServerlessRuntimeToolPolicy {
  const source = asObject(value) as RuntimeToolPolicyBlob;
  const disabledTools = normalizeDisabledTools(source.disabled_tools);
  return {
    webEnabled: source.web_enabled === undefined ? DEFAULT_POLICY.webEnabled : Boolean(source.web_enabled),
    mcpEnabled: source.mcp_enabled === undefined ? DEFAULT_POLICY.mcpEnabled : Boolean(source.mcp_enabled),
    shellEnabled: source.shell_enabled === undefined ? DEFAULT_POLICY.shellEnabled : Boolean(source.shell_enabled),
    disabledTools,
  };
}

function serializeToolPolicy(policy: ServerlessRuntimeToolPolicy) {
  return {
    web_enabled: Boolean(policy.webEnabled),
    mcp_enabled: Boolean(policy.mcpEnabled),
    shell_enabled: Boolean(policy.shellEnabled),
    disabled_tools: normalizeDisabledTools(policy.disabledTools),
  };
}

type DeploymentToolPolicyRow = {
  runtime_tool_policy: unknown;
};

export async function getServerlessRuntimeToolPolicy(deploymentId: string) {
  const row = await pool.query<DeploymentToolPolicyRow>(
    `SELECT runtime_tool_policy
     FROM deployments
     WHERE id = $1
     LIMIT 1`,
    [deploymentId],
  );
  return parseToolPolicy(row.rows[0]?.runtime_tool_policy ?? null);
}

export async function setServerlessRuntimeToolPolicy(input: {
  deploymentId: string;
  webEnabled?: boolean;
  mcpEnabled?: boolean;
  shellEnabled?: boolean;
  mcpTools?: Record<string, boolean>;
}) {
  const current = await getServerlessRuntimeToolPolicy(input.deploymentId);
  const disabled = new Set(current.disabledTools);

  if (input.mcpTools && typeof input.mcpTools === "object") {
    for (const [nameRaw, enabledRaw] of Object.entries(input.mcpTools)) {
      const name = normalizeToolName(nameRaw);
      if (!name || !OTTOAUTH_TOOL_NAMES.includes(name as (typeof OTTOAUTH_TOOL_NAMES)[number])) continue;
      if (Boolean(enabledRaw)) {
        disabled.delete(name);
      } else {
        disabled.add(name);
      }
    }
  }

  const next: ServerlessRuntimeToolPolicy = {
    webEnabled: input.webEnabled === undefined ? current.webEnabled : Boolean(input.webEnabled),
    mcpEnabled: input.mcpEnabled === undefined ? current.mcpEnabled : Boolean(input.mcpEnabled),
    shellEnabled: input.shellEnabled === undefined ? current.shellEnabled : Boolean(input.shellEnabled),
    disabledTools: Array.from(disabled).sort((a, b) => a.localeCompare(b)),
  };

  await pool.query(
    `UPDATE deployments
     SET runtime_tool_policy = $2::jsonb,
         updated_at = NOW()
     WHERE id = $1`,
    [input.deploymentId, JSON.stringify(serializeToolPolicy(next))],
  );

  return next;
}

function resolveOttoAuthConfig() {
  const enabled = readBoolEnv("SIMPLE_AGENT_SERVERLESS_OTTOAUTH_TOOLS_ENABLED", true);
  const baseUrl = normalizeBaseUrl(readTrimmedEnv("OTTOAGENT_MCP_BASE_URL"), "https://ottoauth.vercel.app");
  const token = readTrimmedEnv("OTTOAGENT_MCP_TOKEN");
  return {
    enabled,
    baseUrl,
    token,
  };
}

function resolveWebConfig() {
  return {
    enabled: readBoolEnv("SIMPLE_AGENT_SERVERLESS_WEB_TOOLS_ENABLED", true),
    timeoutSeconds: Math.max(1, Number(readTrimmedEnv("SIMPLE_AGENT_SERVERLESS_WEB_TIMEOUT_S") || "12") || 12),
    maxChars: Math.max(500, Number(readTrimmedEnv("SIMPLE_AGENT_SERVERLESS_WEB_MAX_CHARS") || "6000") || 6000),
    maxResults: Math.max(
      1,
      Math.min(8, Number(readTrimmedEnv("SIMPLE_AGENT_SERVERLESS_WEB_SEARCH_MAX_RESULTS") || "5") || 5),
    ),
  };
}

const CURRENT_TIME_TOOL: ServerlessRuntimeTool = {
  name: "current_time",
  description: "Get the current date/time in ISO + localized formatting. Optional input: timezone.",
  source: "builtin",
  inputSchema: {
    type: "object",
    properties: {
      timezone: { type: "string", description: "Optional IANA timezone, e.g. America/New_York" },
    },
  },
  available: true,
  availabilityReason: null,
};

const WEB_SEARCH_TOOL: ServerlessRuntimeTool = {
  name: "web_search",
  description: "Search the web for current information. Input: query.",
  source: "builtin",
  inputSchema: {
    type: "object",
    required: ["query"],
    properties: {
      query: { type: "string", description: "Search query text" },
      max_results: { type: "number", description: "Optional max results (1-8)", default: 5 },
    },
  },
  available: true,
  availabilityReason: null,
};

const WEB_FETCH_TOOL: ServerlessRuntimeTool = {
  name: "web_fetch",
  description: "Fetch and summarize content from a public web URL. Input: url.",
  source: "builtin",
  inputSchema: {
    type: "object",
    required: ["url"],
    properties: {
      url: { type: "string", description: "Public http/https URL" },
    },
  },
  available: true,
  availabilityReason: null,
};

function ottoAuthTools(available: boolean, reason: string | null): ServerlessRuntimeTool[] {
  return [
    {
      name: "ottoauth_list_services",
      description: "API access to any online services involving buying or selling.",
      source: "ottoauth-mcp",
      inputSchema: { type: "object", properties: {} },
      available,
      availabilityReason: reason,
    },
    {
      name: "ottoauth_get_service",
      description: "Get a single OttoAuth service by id.",
      source: "ottoauth-mcp",
      inputSchema: {
        type: "object",
        required: ["id"],
        properties: {
          id: { type: "string", description: "Service id" },
        },
      },
      available,
      availabilityReason: reason,
    },
    {
      name: "ottoauth_http_request",
      description: "Make an OttoAuth API request. Path must start with /api/.",
      source: "ottoauth-mcp",
      inputSchema: {
        type: "object",
        required: ["path"],
        properties: {
          method: { type: "string", description: "GET/POST/PUT/PATCH/DELETE", default: "GET" },
          path: { type: "string", description: "API path, e.g. /api/services" },
          query: { type: "object" },
          body: { type: "object" },
          headers: { type: "object" },
        },
      },
      available,
      availabilityReason: reason,
    },
  ];
}

function resolveToolAvailability(input: {
  name: string;
  globallyEnabled: boolean;
  policyEnabled: boolean;
  disabledNames: Set<string>;
  envReason: string;
}) {
  const key = normalizeToolName(input.name);
  if (input.disabledNames.has(key)) {
    return {
      available: false,
      reason: "Disabled in tool settings.",
    };
  }
  if (!input.globallyEnabled) {
    return {
      available: false,
      reason: input.envReason,
    };
  }
  if (!input.policyEnabled) {
    return {
      available: false,
      reason: "Disabled in tool settings.",
    };
  }
  return {
    available: true,
    reason: null,
  };
}

export async function listServerlessRuntimeTools(input?: {
  deploymentId?: string;
  policy?: ServerlessRuntimeToolPolicy | null;
}): Promise<ServerlessRuntimeToolCatalog> {
  const policy =
    input?.policy ?? (input?.deploymentId ? await getServerlessRuntimeToolPolicy(input.deploymentId) : DEFAULT_POLICY);
  const disabledNames = new Set(policy.disabledTools.map((value) => normalizeToolName(value)));

  const ottoauth = resolveOttoAuthConfig();
  const web = resolveWebConfig();

  const webSearchAvailability = resolveToolAvailability({
    name: WEB_SEARCH_TOOL.name,
    globallyEnabled: web.enabled,
    policyEnabled: policy.webEnabled,
    disabledNames,
    envReason: "Disabled by SIMPLE_AGENT_SERVERLESS_WEB_TOOLS_ENABLED",
  });
  const webFetchAvailability = resolveToolAvailability({
    name: WEB_FETCH_TOOL.name,
    globallyEnabled: web.enabled,
    policyEnabled: policy.webEnabled,
    disabledNames,
    envReason: "Disabled by SIMPLE_AGENT_SERVERLESS_WEB_TOOLS_ENABLED",
  });

  const mcpAvailability = resolveToolAvailability({
    name: "ottoauth_list_services",
    globallyEnabled: ottoauth.enabled,
    policyEnabled: policy.mcpEnabled,
    disabledNames,
    envReason: "Disabled by SIMPLE_AGENT_SERVERLESS_OTTOAUTH_TOOLS_ENABLED",
  });

  const mcpTools = ottoAuthTools(mcpAvailability.available, mcpAvailability.reason).map((tool) => {
    const specific = resolveToolAvailability({
      name: tool.name,
      globallyEnabled: ottoauth.enabled,
      policyEnabled: policy.mcpEnabled,
      disabledNames,
      envReason: "Disabled by SIMPLE_AGENT_SERVERLESS_OTTOAUTH_TOOLS_ENABLED",
    });
    return {
      ...tool,
      available: specific.available,
      availabilityReason: specific.reason,
    };
  });

  const tools: ServerlessRuntimeTool[] = [
    CURRENT_TIME_TOOL,
    {
      ...WEB_SEARCH_TOOL,
      available: webSearchAvailability.available,
      availabilityReason: webSearchAvailability.reason,
    },
    {
      ...WEB_FETCH_TOOL,
      available: webFetchAvailability.available,
      availabilityReason: webFetchAvailability.reason,
    },
    ...mcpTools,
  ];

  const mcpToolsMap: Record<string, boolean> = {};
  for (const name of OTTOAUTH_TOOL_NAMES) {
    mcpToolsMap[name] = !disabledNames.has(name);
  }

  return {
    tools,
    ottoauth: {
      enabled: ottoauth.enabled,
      baseUrl: ottoauth.baseUrl,
      tokenConfigured: Boolean(ottoauth.token),
    },
    policy: {
      webEnabled: policy.webEnabled,
      mcpEnabled: policy.mcpEnabled,
      shellEnabled: policy.shellEnabled,
      mcpTools: mcpToolsMap,
    },
  };
}

function formatCurrentTime(timezone: string) {
  const now = new Date();
  const formatter = new Intl.DateTimeFormat("en-US", {
    dateStyle: "full",
    timeStyle: "long",
    timeZone: timezone,
  });
  return {
    now_iso: now.toISOString(),
    epoch_ms: now.getTime(),
    timezone,
    human_readable: formatter.format(now),
  };
}

function normalizeHttpMethod(value: unknown) {
  const normalized = String(value ?? "GET").trim().toUpperCase();
  if (["GET", "POST", "PUT", "PATCH", "DELETE"].includes(normalized)) return normalized;
  return "GET";
}

function parseJsonObjectFromText(value: string) {
  const trimmed = String(value ?? "").trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return null;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as ToolJson;
  } catch {
    return null;
  }
}

function readFirstString(args: ToolJson, keys: string[]) {
  for (const key of keys) {
    const value = args[key];
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (trimmed) return trimmed;
    }
  }
  return "";
}

function resolveWebSearchQuery(args: ToolJson) {
  const value = readFirstString(args, ["value"]);
  if (value) {
    const parsedValue = parseJsonObjectFromText(value);
    if (parsedValue) {
      const payloadQuery = readFirstString(parsedValue, ["query", "q", "text", "value"]);
      if (payloadQuery) return payloadQuery;
    }
    return value;
  }
  return readFirstString(args, ["query", "q", "text"]);
}

function resolveWebFetchUrl(args: ToolJson) {
  const value = readFirstString(args, ["value"]);
  if (value) {
    const parsedValue = parseJsonObjectFromText(value);
    if (parsedValue) {
      const payloadUrl = readFirstString(parsedValue, ["url", "link", "value"]);
      if (payloadUrl) return payloadUrl;
    }
    return value;
  }
  return readFirstString(args, ["url", "link"]);
}

function truncateText(value: string, maxChars: number) {
  const text = String(value ?? "");
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n...[truncated]`;
}

function stripHtmlTags(input: string) {
  return String(input ?? "").replace(/<[^>]+>/g, " ");
}

function htmlToText(input: string) {
  const withoutScripts = String(input ?? "").replace(/<(script|style|noscript)[^>]*>[\s\S]*?<\/\1>/gi, " ");
  const normalized = stripHtmlTags(withoutScripts)
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/[ \t\r\f\v]+/g, " ")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return normalized;
}

function normalizeResultUrl(raw: unknown) {
  const value = String(raw ?? "").trim();
  if (!value) return "";
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "";
    return parsed.toString();
  } catch {
    return "";
  }
}

function isPrivateIpv4(hostname: string) {
  const ipv4 = hostname.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!ipv4) return false;
  const parts = ipv4.slice(1).map((part) => Number(part));
  if (parts.some((part) => !Number.isFinite(part) || part < 0 || part > 255)) return true;
  if (parts[0] === 10) return true;
  if (parts[0] === 127) return true;
  if (parts[0] === 169 && parts[1] === 254) return true;
  if (parts[0] === 192 && parts[1] === 168) return true;
  if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
  if (parts[0] === 0) return true;
  return false;
}

function isPrivateHost(hostname: string) {
  const host = hostname.trim().toLowerCase();
  if (!host) return true;
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) return true;
  if (host === "::1") return true;
  if (host.startsWith("fc") || host.startsWith("fd") || host.startsWith("fe80")) return true;
  if (isPrivateIpv4(host)) return true;
  return false;
}

function validatePublicHttpUrl(rawUrl: unknown) {
  const value = String(rawUrl ?? "").trim();
  if (!value) {
    throw new Error("URL is required.");
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("Invalid URL.");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Only http/https URLs are allowed.");
  }
  if (isPrivateHost(parsed.hostname)) {
    throw new Error("Private/local URLs are not allowed.");
  }
  return parsed.toString();
}

function extractJinaSearchResults(markdownText: string, maxResults: number) {
  const results: Array<{ title: string; url: string }> = [];
  const seen = new Set<string>();
  const regex = /^\s*\d+\.\[(.*?)\]\((https?:\/\/[^\s)]+)\)/gm;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(markdownText || "")) !== null) {
    const title = String(match[1] ?? "").trim();
    const url = normalizeResultUrl(match[2]);
    if (!url || seen.has(url)) continue;
    results.push({ title: (title || url).slice(0, 240), url });
    seen.add(url);
    if (results.length >= maxResults) break;
  }
  return results;
}

async function runWebSearch(input: { query: string; maxResults: number }) {
  const web = resolveWebConfig();
  const query = input.query.trim();
  if (!web.enabled) {
    throw new Error("Web tools are disabled.");
  }
  if (!query) {
    throw new Error("web_search query is empty");
  }

  const targetMax = Math.max(1, Math.min(8, Number(input.maxResults || web.maxResults) || web.maxResults));
  const searchUrl = `https://r.jina.ai/http://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}`;
  const response = await fetch(searchUrl, {
    headers: {
      "User-Agent": "oneclick-serverless/1.0",
      "Accept-Language": "en-US,en;q=0.9",
    },
    signal: AbortSignal.timeout(web.timeoutSeconds * 1000),
  });
  if (!response.ok) {
    throw new Error(`web_search failed (${response.status})`);
  }
  const text = await response.text().catch(() => "");
  const results = extractJinaSearchResults(text, targetMax);
  return {
    query,
    results,
    source: "duckduckgo_lite_via_jina",
  };
}

async function runWebFetch(rawUrl: string) {
  const web = resolveWebConfig();
  if (!web.enabled) {
    throw new Error("Web tools are disabled.");
  }
  const url = validatePublicHttpUrl(rawUrl);
  const response = await fetch(url, {
    headers: { "User-Agent": "oneclick-serverless/1.0" },
    redirect: "follow",
    signal: AbortSignal.timeout(web.timeoutSeconds * 1000),
  });
  if (!response.ok) {
    throw new Error(`web_fetch failed (${response.status})`);
  }

  const finalUrl = validatePublicHttpUrl(response.url || url);
  const contentType = String(response.headers.get("content-type") || "").toLowerCase();
  const body = await response.text().catch(() => "");
  const titleMatch = body.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? stripHtmlTags(titleMatch[1] ?? "").trim().slice(0, 240) : "";
  const content = contentType.includes("html") || /<html/i.test(body) ? htmlToText(body) : body.trim();

  return {
    url: finalUrl,
    status_code: response.status,
    content_type: contentType || "unknown",
    title,
    content: truncateText(content, web.maxChars),
  };
}

async function callOttoAuthApi(input: {
  deploymentId: string;
  botId: string;
  botName?: string | null;
  method: string;
  path: string;
  query?: unknown;
  body?: unknown;
  headers?: unknown;
}) {
  const config = resolveOttoAuthConfig();
  if (!config.enabled) {
    return { ok: false, status: 0, error: "OttoAuth tools are disabled." };
  }

  const path = String(input.path ?? "").trim();
  if (!path.startsWith("/api/")) {
    return { ok: false, status: 400, error: "Path must start with /api/." };
  }

  const url = new URL(path, `${config.baseUrl}/`);
  const query = asObject(input.query);
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) continue;
    url.searchParams.set(key, String(value));
  }

  const method = normalizeHttpMethod(input.method);
  const shouldSendBody = method !== "GET" && method !== "DELETE";
  const requestHeaders: Record<string, string> = {};
  const extraHeaders = asObject(input.headers);
  for (const [key, value] of Object.entries(extraHeaders)) {
    if (!key.trim() || value === undefined || value === null) continue;
    requestHeaders[key] = String(value);
  }
  if (shouldSendBody) {
    requestHeaders["content-type"] = requestHeaders["content-type"] || "application/json";
  }
  if (config.token) {
    requestHeaders.authorization = `Bearer ${config.token}`;
    requestHeaders["x-agent-gateway-auth-token"] = config.token;
    requestHeaders["x-agent-gateway-token"] = config.token;
    requestHeaders["x-gateway-token"] = config.token;
  }
  requestHeaders["x-oneclick-bot-id"] = input.botId;

  let requestBody = asObject(input.body);
  if (shouldSendBody) {
    const account = await ensureOttoAuthAccountForBot({
      deploymentId: input.deploymentId,
      botId: input.botId,
      botName: input.botName,
    });
    requestBody = {
      ...requestBody,
      ...(requestBody.username === undefined ? { username: account.username } : {}),
      ...(requestBody.private_key === undefined && requestBody.privateKey === undefined && requestBody.password === undefined
        ? { private_key: account.privateKey }
        : {}),
    };
  }

  try {
    const response = await fetch(url.toString(), {
      method,
      headers: requestHeaders,
      body: shouldSendBody ? JSON.stringify(requestBody) : undefined,
      signal: AbortSignal.timeout(30_000),
    });
    const contentType = response.headers.get("content-type") || "";
    const parsedBody = contentType.toLowerCase().includes("application/json")
      ? await response.json().catch(() => null)
      : await response.text().catch(() => "");
    return {
      ok: response.ok,
      status: response.status,
      statusText: response.statusText,
      url: url.toString(),
      body: parsedBody,
    };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      error: error instanceof Error ? error.message : String(error),
      url: url.toString(),
    };
  }
}

export async function executeServerlessRuntimeToolCall(input: {
  deploymentId: string;
  botId: string;
  botName?: string | null;
  name: string;
  arguments: unknown;
}): Promise<ServerlessRuntimeToolResult> {
  const name = input.name.trim();
  const args = asObject(input.arguments);

  if (name === "current_time") {
    const requestedTimezone = String(args.timezone ?? "").trim();
    if (requestedTimezone) {
      try {
        return { ok: true, tool: name, result: formatCurrentTime(requestedTimezone) };
      } catch {
        return {
          ok: true,
          tool: name,
          result: {
            ...formatCurrentTime("UTC"),
            timezone_warning: `Invalid timezone '${requestedTimezone}'. Returned UTC instead.`,
          },
        };
      }
    }
    return { ok: true, tool: name, result: formatCurrentTime("UTC") };
  }

  if (name === "web_search") {
    const query = resolveWebSearchQuery(args);
    const maxResults = Number(args.max_results ?? args.maxResults ?? 5);
    if (!query) return { ok: false, tool: name, error: "Missing required argument: query" };
    try {
      const result = await runWebSearch({ query, maxResults });
      return { ok: true, tool: name, result };
    } catch (error) {
      return { ok: false, tool: name, error: error instanceof Error ? error.message : String(error) };
    }
  }

  if (name === "web_fetch") {
    const url = resolveWebFetchUrl(args);
    if (!url) return { ok: false, tool: name, error: "Missing required argument: url" };
    try {
      const result = await runWebFetch(url);
      return { ok: true, tool: name, result };
    } catch (error) {
      return { ok: false, tool: name, error: error instanceof Error ? error.message : String(error) };
    }
  }

  if (name === "ottoauth_list_services") {
    const result = await callOttoAuthApi({
      deploymentId: input.deploymentId,
      botId: input.botId,
      botName: input.botName,
      method: "GET",
      path: "/api/services",
    });
    return result.ok ? { ok: true, tool: name, result } : { ok: false, tool: name, error: JSON.stringify(result) };
  }

  if (name === "ottoauth_get_service") {
    const id = String(args.id ?? "").trim();
    if (!id) return { ok: false, tool: name, error: "Missing required argument: id" };
    const result = await callOttoAuthApi({
      deploymentId: input.deploymentId,
      botId: input.botId,
      botName: input.botName,
      method: "GET",
      path: `/api/services/${encodeURIComponent(id)}`,
    });
    return result.ok ? { ok: true, tool: name, result } : { ok: false, tool: name, error: JSON.stringify(result) };
  }

  if (name === "ottoauth_http_request") {
    const result = await callOttoAuthApi({
      deploymentId: input.deploymentId,
      botId: input.botId,
      botName: input.botName,
      method: normalizeHttpMethod(args.method),
      path: String(args.path ?? ""),
      query: args.query,
      body: args.body,
      headers: args.headers,
    });
    return result.ok ? { ok: true, tool: name, result } : { ok: false, tool: name, error: JSON.stringify(result) };
  }

  return { ok: false, tool: name, error: `Unknown tool: ${name}` };
}
