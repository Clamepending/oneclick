import { ensureOttoAuthAccountForBot } from "@/lib/runtime/ottoauthAccounts";

type ToolJson = Record<string, unknown>;

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
};

export type ServerlessRuntimeToolResult = {
  ok: boolean;
  tool: string;
  result?: unknown;
  error?: string;
};

function readTrimmedEnv(name: string) {
  const raw = process.env[name];
  if (!raw) return "";
  return raw.trim().replace(/^"(.*)"$/, "$1").trim();
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
  const withProtocol = trimmed && /^https?:\/\//i.test(trimmed) ? trimmed : (trimmed ? `https://${trimmed}` : fallback);
  const parsed = new URL(withProtocol);
  parsed.pathname = "/";
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString().replace(/\/$/, "");
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

export async function listServerlessRuntimeTools(): Promise<ServerlessRuntimeToolCatalog> {
  const ottoauth = resolveOttoAuthConfig();
  const availabilityReason = ottoauth.enabled ? null : "Disabled by SIMPLE_AGENT_SERVERLESS_OTTOAUTH_TOOLS_ENABLED";
  return {
    tools: [CURRENT_TIME_TOOL, ...ottoAuthTools(ottoauth.enabled, availabilityReason)],
    ottoauth: {
      enabled: ottoauth.enabled,
      baseUrl: ottoauth.baseUrl,
      tokenConfigured: Boolean(ottoauth.token),
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
