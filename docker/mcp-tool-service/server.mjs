import http from "node:http";

const HOST = process.env.HOST || "0.0.0.0";
const PORT = Number(process.env.PORT || "8004");
const BASE_URL = (process.env.OTTOAUTH_BASE_URL || "https://ottoauth.vercel.app").replace(/\/$/, "");
const AUTH_TOKEN = (process.env.OTTOAUTH_TOKEN || process.env.OTTOAGENT_TOKEN || "").trim();
const AGENT_GATEWAY_URL = (process.env.AGENT_GATEWAY_URL || "").trim();
const AGENT_GATEWAY_AUTH_TOKEN = (process.env.AGENT_GATEWAY_AUTH_TOKEN || "").trim();
const REFRESH_INTERVAL_MS = Number(process.env.OTTOAGENT_MCP_REFRESH_MS || String(24 * 60 * 60 * 1000));
const HTTP_TIMEOUT_MS = Number(process.env.OTTOAGENT_MCP_HTTP_TIMEOUT_MS || "30000");
const LOOP_INTERVAL_S = Math.max(1, Number(process.env.MCP_LOOP_INTERVAL_S || "1"));
const VALID_HTTP_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);

let refreshPromise = null;
let lastRefreshAt = 0;
let lastActivityAt = Date.now();
const endpointTools = new Map();

const state = {
  enabled: parseBoolEnv("MCP_DEFAULT_ENABLED", true),
  autoOffIdleS: Math.max(0, Number(process.env.MCP_AUTO_OFF_IDLE_S || "300")),
  disabledReason: "",
  mcpTools: normalizeMcpToolsMap(null),
};

if (!state.enabled) {
  state.disabledReason = "disabled_by_default";
}

const ENDPOINT_INPUT_SCHEMA = {
  type: "object",
  properties: {
    path_params: { type: "object", additionalProperties: true },
    query: { type: "object", additionalProperties: true },
    body: { type: "object", additionalProperties: true },
    headers: { type: "object", additionalProperties: { type: "string" } },
  },
};

function parseBoolEnv(name, fallback) {
  const raw = String(process.env[name] || "").trim().toLowerCase();
  if (!raw) return fallback;
  if (["1", "true", "yes", "on"].includes(raw)) return true;
  if (["0", "false", "no", "off"].includes(raw)) return false;
  return fallback;
}

function writeJson(res, statusCode, body) {
  res.statusCode = statusCode;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(body));
}

function mcpResult(id, result) {
  return { jsonrpc: "2.0", id, result };
}

function mcpError(id, message, code = -32000) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function asObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value;
}

function argumentError(message) {
  const error = new Error(message);
  error.code = -32602;
  return error;
}

function normalizeMethod(raw) {
  const method = String(raw || "GET").trim().toUpperCase();
  if (!VALID_HTTP_METHODS.has(method)) {
    throw argumentError("Invalid method. Expected one of GET, POST, PUT, PATCH, DELETE.");
  }
  return method;
}

function normalizePath(value) {
  const trimmed = String(value ?? "").trim();
  if (!trimmed) throw argumentError("Path is required.");
  if (!trimmed.startsWith("/")) {
    throw argumentError("Path must start with '/': " + trimmed);
  }
  return trimmed.replace(/\/{2,}/g, "/");
}

function applyPathParams(pathTemplate, pathParams) {
  const params = asObject(pathParams);
  return pathTemplate.replace(/:([A-Za-z0-9_]+)/g, (_, name) => {
    const value = params?.[name];
    if (value === undefined || value === null) {
      throw argumentError("Missing required path parameter '" + name + "' for path '" + pathTemplate + "'.");
    }
    return encodeURIComponent(String(value));
  });
}

function toToolName(serviceId, method, path) {
  const normalizedPath = path
    .replace(/^\/api\//, "")
    .replace(/[:/]+/g, "_")
    .replace(/[^A-Za-z0-9_]/g, "")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
  return "ottoauth_" + serviceId + "_" + method.toLowerCase() + "_" + normalizedPath;
}

function safeServiceId(raw) {
  if (typeof raw !== "string") return null;
  const value = raw.trim().toLowerCase();
  if (!value) return null;
  return value.replace(/[^a-z0-9_-]/g, "");
}

function normalizeDiscoveredPath(value) {
  const url = String(value).startsWith("http")
    ? new URL(value)
    : new URL(value, BASE_URL + "/");
  let path = normalizePath(url.pathname);
  if (!path.startsWith("/api/")) return null;
  path = path
    .split("/")
    .map((segment) => {
      if (/^[A-Z][A-Z0-9_]+$/.test(segment)) {
        const normalized = segment.replace(/_HERE$/g, "").toLowerCase();
        return ":" + normalized;
      }
      return segment;
    })
    .join("/");
  return path;
}

function extractEndpointsFromMarkdown(markdown, serviceId) {
  if (!markdown) return [];
  const endpoints = [];
  const codeBlocks = [...markdown.matchAll(/```[\s\S]*?```/g)].map((match) => match[0]);

  for (const block of codeBlocks) {
    const fetchMatches = block.matchAll(
      /\bfetch\s*\(([^\)]*)\)/g,
    );
    for (const match of fetchMatches) {
      const snippet = match[1] || "";
      const urlMatch = snippet.match(/["'`](https?:\/\/[^"'`]+|\/[^"'`]+)["'`]/);
      const methodMatch = snippet.match(/method\s*:\s*["'`](GET|POST|PUT|PATCH|DELETE)["'`]/i);
      const rawPath = urlMatch ? urlMatch[1] : "";
      if (!rawPath) continue;
      const method = methodMatch ? methodMatch[1].toUpperCase() : "GET";
      const path = normalizeDiscoveredPath(rawPath);
      if (!path) continue;
      endpoints.push({
        toolName: toToolName(serviceId, method, path),
        title: serviceId.toUpperCase() + " " + method + " " + path,
        description: "Passthrough to " + method + " " + path + " on OttoAuth.",
        method,
        path,
        serviceId,
      });
    }

    const axiosMatches = block.matchAll(
      /\baxios\.(get|post|put|patch|delete)\s*\(([^\)]*)\)/gi,
    );
    for (const match of axiosMatches) {
      const method = match[1].toUpperCase();
      const snippet = match[2] || "";
      const urlMatch = snippet.match(/["'`](https?:\/\/[^"'`]+|\/[^"'`]+)["'`]/);
      const rawPath = urlMatch ? urlMatch[1] : "";
      if (!rawPath) continue;
      const path = normalizeDiscoveredPath(rawPath);
      if (!path) continue;
      endpoints.push({
        toolName: toToolName(serviceId, method, path),
        title: serviceId.toUpperCase() + " " + method + " " + path,
        description: "Passthrough to " + method + " " + path + " on OttoAuth.",
        method,
        path,
        serviceId,
      });
    }

    const curlMatches = block.matchAll(
      /\bcurl\b[\s\S]*?\b-X\s+(GET|POST|PUT|PATCH|DELETE)\s+(https?:\/\/[^\s\\`]+|\/[^\s\\`]+)/g,
    );
    for (const match of curlMatches) {
      const method = match[1];
      const rawPath = match[2];
      const path = normalizeDiscoveredPath(rawPath);
      if (!path) continue;
      endpoints.push({
        toolName: toToolName(serviceId, method, path),
        title: serviceId.toUpperCase() + " " + method + " " + path,
        description: "Passthrough to " + method + " " + path + " on OttoAuth.",
        method,
        path,
        serviceId,
      });
    }
  }

  return endpoints;
}

function baseTools() {
  return [
    {
      name: "ottoauth_list_services",
      description: "List OttoAuth services from /api/services.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "ottoauth_get_service",
      description: "Get OttoAuth service details by id from /api/services/:id.",
      inputSchema: {
        type: "object",
        required: ["id"],
        properties: { id: { type: "string" } },
      },
    },
    {
      name: "ottoauth_http_request",
      description: "Generic OttoAuth HTTP request. Path must start with /api/.",
      inputSchema: {
        type: "object",
        required: ["method", "path"],
        properties: {
          method: { type: "string", enum: ["GET", "POST", "PUT", "PATCH", "DELETE"] },
          path: { type: "string" },
          query: { type: "object", additionalProperties: true },
          body: { type: "object", additionalProperties: true },
          headers: { type: "object", additionalProperties: { type: "string" } },
        },
      },
    },
    {
      name: "ottoauth_refresh_tools",
      description: "Refresh OttoAuth endpoint-discovered tools immediately.",
      inputSchema: { type: "object", properties: {} },
    },
  ];
}

function toolListAll() {
  const dynamic = [...endpointTools.values()]
    .map((endpoint) => ({
      name: endpoint.toolName,
      description: endpoint.description,
      inputSchema: ENDPOINT_INPUT_SCHEMA,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return [...baseTools(), ...dynamic];
}

function normalizeMcpToolsMap(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const out = {};
  for (const [name, value] of Object.entries(input)) {
    const key = String(name || "").trim();
    if (!key) continue;
    out[key] = Boolean(value);
  }
  return Object.keys(out).length > 0 ? out : null;
}

function isToolEnabledByMap(name) {
  if (!state.mcpTools) return true;
  return state.mcpTools[name] === true;
}

function filteredToolList() {
  return toolListAll().filter((tool) => isToolEnabledByMap(String(tool.name || "")));
}

function buildHeaders(input = {}) {
  const headers = {
    Accept: "application/json, text/plain;q=0.9, */*;q=0.8",
    ...(asObject(input.extraHeaders) || {}),
  };
  if (input.shouldSendBody) {
    headers["Content-Type"] = headers["Content-Type"] || "application/json";
  }
  if (AUTH_TOKEN) {
    headers.authorization = `Bearer ${AUTH_TOKEN}`;
  }
  if (AGENT_GATEWAY_URL) {
    headers["x-agent-gateway-url"] = AGENT_GATEWAY_URL;
  }
  if (AGENT_GATEWAY_AUTH_TOKEN) {
    headers["x-agent-gateway-auth-token"] = AGENT_GATEWAY_AUTH_TOKEN;
  }
  return headers;
}

function mapResultContent(value) {
  return [{ type: "text", text: JSON.stringify(value, null, 2) }];
}

function toMcpToolResult(response, options = {}) {
  const preferBodyOnSuccess = Boolean(options.preferBodyOnSuccess);
  if (response.ok && preferBodyOnSuccess) {
    return { content: mapResultContent(response.body), structuredContent: response.body };
  }
  return {
    isError: !response.ok,
    content: mapResultContent(response),
    structuredContent: response,
  };
}

async function fetchWithTimeout(url, init, timeoutMs) {
  const controller = new AbortController();
  const timeout = Number.isFinite(timeoutMs) && timeoutMs > 0
    ? setTimeout(() => controller.abort(), timeoutMs)
    : null;
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function parseResponseBody(response) {
  const text = await response.text();
  const contentType = response.headers.get("content-type") || "";
  if (!text) {
    return { contentType, body: null };
  }
  if (contentType.includes("application/json")) {
    try {
      return { contentType, body: JSON.parse(text) };
    } catch {
      return { contentType, body: text };
    }
  }
  try {
    return { contentType, body: JSON.parse(text) };
  } catch {
    return { contentType, body: text };
  }
}

async function callOttoAuth(method, path, query, body, headers) {
  const normalizedMethod = normalizeMethod(method);
  const normalizedPath = normalizePath(path);
  if (!normalizedPath.startsWith("/api/")) {
    throw argumentError("Path must start with /api/.");
  }
  const url = new URL(normalizedPath, BASE_URL + "/");
  const queryObject = asObject(query);
  if (queryObject) {
    for (const [key, value] of Object.entries(queryObject)) {
      if (value === undefined || value === null) continue;
      url.searchParams.set(key, String(value));
    }
  }

  const shouldSendBody = normalizedMethod !== "GET" && normalizedMethod !== "DELETE";
  const bodyObject = asObject(body);

  try {
    const response = await fetchWithTimeout(
      url.toString(),
      {
        method: normalizedMethod,
        headers: buildHeaders({ shouldSendBody, extraHeaders: headers }),
        body: shouldSendBody ? JSON.stringify(bodyObject || {}) : undefined,
      },
      HTTP_TIMEOUT_MS,
    );
    const { contentType, body: parsedBody } = await parseResponseBody(response);
    return {
      ok: response.ok,
      status: response.status,
      statusText: response.statusText,
      url: url.toString(),
      contentType,
      body: parsedBody,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      status: 0,
      statusText: "NetworkError",
      url: url.toString(),
      contentType: "",
      body: { error: message },
    };
  }
}

async function fetchDocsMarkdown(docsUrl) {
  try {
    const response = await fetchWithTimeout(
      docsUrl,
      {
        method: "GET",
        headers: { Accept: "text/markdown, text/plain;q=0.9, */*;q=0.1" },
      },
      HTTP_TIMEOUT_MS,
    );
    if (!response.ok) return "";
    return await response.text();
  } catch {
    return "";
  }
}

async function discoverEndpoints() {
  const servicesResponse = await callOttoAuth("GET", "/api/services");
  if (!servicesResponse.ok) {
    console.error(
      "[mcp-tool-service] discovery failed to load /api/services:",
      servicesResponse.status,
      servicesResponse.statusText,
      JSON.stringify(servicesResponse.body),
    );
    return [];
  }

  const services = Array.isArray(servicesResponse.body?.services)
    ? servicesResponse.body.services
    : [];
  const discovered = new Map();

  for (const service of services) {
    const serviceId = safeServiceId(service?.id);
    if (!serviceId) continue;
    const docsUrl =
      typeof service?.docsUrl === "string" && service.docsUrl
        ? service.docsUrl
        : BASE_URL + "/api/services/" + encodeURIComponent(serviceId);
    const markdown = await fetchDocsMarkdown(docsUrl);
    const endpoints = extractEndpointsFromMarkdown(markdown, serviceId);
    for (const endpoint of endpoints) {
      discovered.set(endpoint.method + " " + endpoint.path, endpoint);
    }
  }

  return [...discovered.values()].sort((a, b) => a.toolName.localeCompare(b.toolName));
}

async function refreshEndpointTools() {
  if (refreshPromise) return refreshPromise;
  refreshPromise = (async () => {
    const discovered = await discoverEndpoints();
    endpointTools.clear();
    for (const endpoint of discovered) {
      endpointTools.set(endpoint.toolName, endpoint);
    }
    lastRefreshAt = Date.now();
    console.log("[mcp-tool-service] refreshed", endpointTools.size, "endpoint tools from", BASE_URL);
  })();
  try {
    await refreshPromise;
  } finally {
    refreshPromise = null;
  }
}

async function ensureFreshTools(force = false) {
  const stale = Date.now() - lastRefreshAt > REFRESH_INTERVAL_MS;
  if (force || stale || endpointTools.size === 0) {
    await refreshEndpointTools();
  }
}

function touchActivity() {
  lastActivityAt = Date.now();
  if (!state.enabled && state.disabledReason === "idle_timeout") {
    state.disabledReason = "";
  }
}

function shouldAutoDisable() {
  if (!state.enabled) return false;
  if (!Number.isFinite(state.autoOffIdleS) || state.autoOffIdleS <= 0) return false;
  const elapsedMs = Date.now() - lastActivityAt;
  return elapsedMs >= state.autoOffIdleS * 1000;
}

function setEnabled(next, reason = "") {
  state.enabled = Boolean(next);
  state.disabledReason = state.enabled ? "" : (reason || "manual");
  if (state.enabled) {
    touchActivity();
  }
}

function configSnapshot() {
  const secondsUntilAutoOff = state.enabled && state.autoOffIdleS > 0
    ? Math.max(0, state.autoOffIdleS - Math.floor((Date.now() - lastActivityAt) / 1000))
    : null;
  const tools = filteredToolList();
  return {
    enabled: state.enabled,
    mcp_enabled: state.enabled,
    auto_off_idle_s: state.autoOffIdleS,
    seconds_until_auto_off: secondsUntilAutoOff,
    disabled_reason: state.enabled ? null : (state.disabledReason || "manual"),
    base_url: BASE_URL,
    refresh_interval_ms: REFRESH_INTERVAL_MS,
    last_refresh_at: lastRefreshAt || null,
    tool_count: tools.length,
    tools,
    mcp_tools: tools,
  };
}

async function executeToolCall(name, args) {
  if (name === "ottoauth_list_services") {
    const result = await callOttoAuth("GET", "/api/services");
    if (result.ok) {
      try {
        await ensureFreshTools(true);
      } catch (error) {
        console.error("[mcp-tool-service] list_services refresh error:", error);
      }
    }
    return toMcpToolResult(result, { preferBodyOnSuccess: true });
  }
  if (name === "ottoauth_get_service") {
    const serviceId = String(args.id || "").trim();
    if (!serviceId) throw argumentError("Missing required argument: id");
    const result = await callOttoAuth("GET", "/api/services/" + encodeURIComponent(serviceId));
    return toMcpToolResult(result, { preferBodyOnSuccess: true });
  }
  if (name === "ottoauth_refresh_tools") {
    await refreshEndpointTools();
    const summary = {
      ok: true,
      endpoint_count: endpointTools.size,
      last_refresh_at: lastRefreshAt,
      base_url: BASE_URL,
    };
    return { content: mapResultContent(summary), structuredContent: summary };
  }
  if (name === "ottoauth_http_request") {
    const httpMethod = normalizeMethod(args.method || "GET");
    const path = String(args.path || "");
    const result = await callOttoAuth(httpMethod, path, args.query, args.body, args.headers);
    return toMcpToolResult(result);
  }

  await ensureFreshTools(false);
  const endpoint = endpointTools.get(name);
  if (!endpoint) {
    throw Object.assign(new Error(`Unknown tool: ${name}`), { code: -32601 });
  }
  const path = applyPathParams(endpoint.path, args.path_params);
  const result = await callOttoAuth(endpoint.method, path, args.query, args.body, args.headers);
  return toMcpToolResult(result);
}

async function handleRpc(payload) {
  const id = payload?.id ?? null;
  const method = String(payload?.method || "");
  const params = asObject(payload?.params) || {};

  if (method === "initialize") {
    return mcpResult(id, {
      protocolVersion: "2024-11-05",
      capabilities: { tools: { listChanged: true } },
      serverInfo: { name: "mcp-tool-service", version: "0.1.0" },
    });
  }
  if (method === "notifications/initialized") {
    return mcpResult(id, {});
  }
  if (method === "tools/list") {
    try {
      await ensureFreshTools(false);
    } catch (error) {
      console.error("[mcp-tool-service] tools/list refresh error:", error);
    }
    return mcpResult(id, { tools: filteredToolList() });
  }
  if (method === "tools/call") {
    if (!state.enabled) {
      return mcpError(id, "MCP tools are disabled.", -32001);
    }
    const name = String(params.name || "").trim();
    const args = asObject(params.arguments) || {};
    if (!name) {
      return mcpError(id, "Missing required argument: name", -32602);
    }
    if (!isToolEnabledByMap(name)) {
      return mcpError(id, `Tool is disabled by config: ${name}`, -32001);
    }
    try {
      touchActivity();
      const result = await executeToolCall(name, args);
      return mcpResult(id, result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const code = typeof error === "object" && error && "code" in error && typeof error.code === "number"
        ? error.code
        : -32000;
      return mcpError(id, message, code);
    }
  }

  return mcpError(id, `Unknown method: ${method}`, -32601);
}

async function parseJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  const raw = Buffer.concat(chunks).toString("utf8") || "{}";
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error("Invalid JSON payload");
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${HOST}:${PORT}`);

  if (req.method === "GET" && (url.pathname === "/health" || url.pathname === "/healthz")) {
    return writeJson(res, 200, {
      ok: true,
      ...configSnapshot(),
      service: "mcp-tool-service",
    });
  }

  if (req.method === "GET" && url.pathname === "/config") {
    try {
      await ensureFreshTools(false);
    } catch (error) {
      console.error("[mcp-tool-service] config refresh error:", error);
    }
    return writeJson(res, 200, configSnapshot());
  }

  if (req.method === "POST" && url.pathname === "/config") {
    let payload = {};
    try {
      payload = asObject(await parseJsonBody(req)) || {};
    } catch {
      return writeJson(res, 400, { ok: false, error: "Invalid JSON payload" });
    }

    if (typeof payload.enabled === "boolean") {
      setEnabled(payload.enabled, payload.enabled ? "" : "manual");
    }
    if (typeof payload.mcp_enabled === "boolean") {
      setEnabled(payload.mcp_enabled, payload.mcp_enabled ? "" : "manual");
    }
    if (payload.auto_off_idle_s !== undefined) {
      const parsed = Number(payload.auto_off_idle_s);
      if (!Number.isFinite(parsed) || parsed < 0) {
        return writeJson(res, 400, { ok: false, error: "auto_off_idle_s must be a non-negative number" });
      }
      state.autoOffIdleS = Math.floor(parsed);
    }
    if (payload.mcp_tools !== undefined) {
      state.mcpTools = normalizeMcpToolsMap(payload.mcp_tools);
    }

    try {
      await ensureFreshTools(false);
    } catch (error) {
      console.error("[mcp-tool-service] config refresh error:", error);
    }

    return writeJson(res, 200, {
      ok: true,
      ...configSnapshot(),
    });
  }

  if (req.method === "GET" && url.pathname === "/tools") {
    try {
      await ensureFreshTools(false);
    } catch (error) {
      console.error("[mcp-tool-service] tools refresh error:", error);
    }
    return writeJson(res, 200, {
      ok: true,
      enabled: state.enabled,
      tools: filteredToolList(),
    });
  }

  if (req.method === "POST" && url.pathname === "/tool/echo") {
    let payload = {};
    try {
      payload = asObject(await parseJsonBody(req)) || {};
    } catch {
      return writeJson(res, 400, { ok: false, error: "Invalid JSON payload" });
    }
    if (!state.enabled) {
      return writeJson(res, 409, { ok: false, error: "MCP tools are disabled", disabled_reason: state.disabledReason || "manual" });
    }
    touchActivity();
    const text = String(payload.text ?? "");
    return writeJson(res, 200, { ok: true, output: text });
  }

  if (req.method === "POST" && url.pathname === "/tool/call") {
    let payload = {};
    try {
      payload = asObject(await parseJsonBody(req)) || {};
    } catch {
      return writeJson(res, 400, { ok: false, error: "Invalid JSON payload" });
    }
    if (!state.enabled) {
      return writeJson(res, 409, { ok: false, error: "MCP tools are disabled", disabled_reason: state.disabledReason || "manual" });
    }
    const tool = String(payload.tool || "").trim();
    if (!tool) {
      return writeJson(res, 400, { ok: false, error: "tool is required" });
    }
    if (!isToolEnabledByMap(tool)) {
      return writeJson(res, 403, { ok: false, error: `tool is disabled: ${tool}` });
    }
    const args = asObject(payload.arguments) || {};
    try {
      touchActivity();
      const result = await executeToolCall(tool, args);
      return writeJson(res, 200, {
        ok: result?.isError !== true,
        result,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const code = typeof error === "object" && error && "code" in error && typeof error.code === "number"
        ? error.code
        : -32000;
      const status = code === -32602 ? 400 : code === -32601 ? 404 : 500;
      return writeJson(res, status, { ok: false, error: message, code });
    }
  }

  if (req.method === "POST" && url.pathname === "/mcp") {
    let payload = null;
    try {
      payload = await parseJsonBody(req);
    } catch {
      return writeJson(res, 400, mcpError(null, "Invalid JSON payload", -32700));
    }
    const response = await handleRpc(payload);
    return writeJson(res, 200, response);
  }

  return writeJson(res, 404, { error: "not found" });
});

server.listen(PORT, HOST, () => {
  console.log("[mcp-tool-service] listening on " + HOST + ":" + PORT + " base=" + BASE_URL);
  refreshEndpointTools().catch((error) => {
    console.error("[mcp-tool-service] initial refresh failed:", error);
  });

  const refreshTimer = setInterval(() => {
    refreshEndpointTools().catch((error) => {
      console.error("[mcp-tool-service] scheduled refresh failed:", error);
    });
  }, REFRESH_INTERVAL_MS);
  if (typeof refreshTimer.unref === "function") refreshTimer.unref();

  const autoOffTimer = setInterval(() => {
    if (shouldAutoDisable()) {
      setEnabled(false, "idle_timeout");
      console.log("[mcp-tool-service] auto-disabled MCP tools after idle timeout");
    }
  }, LOOP_INTERVAL_S * 1000);
  if (typeof autoOffTimer.unref === "function") autoOffTimer.unref();
});
