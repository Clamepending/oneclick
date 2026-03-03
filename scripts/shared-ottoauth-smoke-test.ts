import { config as loadEnv } from "dotenv";
import { DescribeNetworkInterfacesCommand, EC2Client } from "@aws-sdk/client-ec2";
import { DescribeTasksCommand, ECSClient, ListTasksCommand } from "@aws-sdk/client-ecs";

loadEnv({ path: ".env", quiet: true });
loadEnv({ path: ".env.local", override: true, quiet: true });

type RuntimeRequestInput = {
  baseUrl: string;
  path: string;
  method?: "GET" | "POST";
  body?: Record<string, unknown>;
  headers?: Record<string, string>;
  timeoutMs?: number;
};

type RuntimeRequestResult = {
  ok: boolean;
  status: number;
  body: Record<string, unknown>;
};

type ToolCallOutcome = "pass" | "warn" | "skip" | "fail";

function readTrimmedEnv(name: string) {
  const raw = process.env[name];
  if (!raw) return "";
  return raw.trim().replace(/^"(.*)"$/, "$1").trim();
}

function readBoolEnv(name: string, fallback = false) {
  const value = readTrimmedEnv(name).toLowerCase();
  if (!value) return fallback;
  if (["1", "true", "yes", "on"].includes(value)) return true;
  if (["0", "false", "no", "off"].includes(value)) return false;
  return fallback;
}

function normalizeBaseUrl(value: string) {
  const parsed = new URL(value);
  parsed.pathname = "/";
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString();
}

function parseEcsRuntimeId(runtimeId: string) {
  if (!runtimeId.startsWith("ecs:")) return null;
  const body = runtimeId.slice(4);
  const split = body.split("|");
  if (split.length !== 2) return null;
  return { cluster: split[0], serviceName: split[1] };
}

function buildAwsConfig(region: string) {
  const accessKeyId = readTrimmedEnv("AWS_ACCESS_KEY_ID");
  const secretAccessKey = readTrimmedEnv("AWS_SECRET_ACCESS_KEY");
  const sessionToken = readTrimmedEnv("AWS_SESSION_TOKEN");
  if (!accessKeyId || !secretAccessKey) {
    return { region };
  }
  return {
    region,
    credentials: {
      accessKeyId,
      secretAccessKey,
      sessionToken: sessionToken || undefined,
    },
  };
}

async function resolveServicePublicIp(region: string, cluster: string, serviceName: string) {
  const ecs = new ECSClient(buildAwsConfig(region));
  const ec2 = new EC2Client(buildAwsConfig(region));
  const tasks = await ecs.send(
    new ListTasksCommand({
      cluster,
      serviceName,
      desiredStatus: "RUNNING",
      maxResults: 5,
    }),
  );
  if (!tasks.taskArns?.length) return null;

  const described = await ecs.send(
    new DescribeTasksCommand({
      cluster,
      tasks: tasks.taskArns,
    }),
  );

  const networkInterfaceIds = (described.tasks ?? [])
    .flatMap((task) => task.attachments ?? [])
    .filter((attachment) => attachment.type === "ElasticNetworkInterface")
    .flatMap((attachment) => attachment.details ?? [])
    .filter((detail) => detail.name === "networkInterfaceId" && Boolean(detail.value))
    .map((detail) => detail.value as string);

  if (networkInterfaceIds.length === 0) return null;

  const interfaces = await ec2.send(
    new DescribeNetworkInterfacesCommand({
      NetworkInterfaceIds: Array.from(new Set(networkInterfaceIds)),
    }),
  );

  return interfaces.NetworkInterfaces?.find((eni) => eni.Association?.PublicIp)?.Association?.PublicIp ?? null;
}

async function resolveSharedBaseUrl() {
  const explicit = readTrimmedEnv("ECS_SHARED_OTTOAUTH_SMOKE_BASE_URL") || readTrimmedEnv("SIMPLE_AGENT_MICROSERVICES_SHARED_BASE_URL");
  if (explicit) return normalizeBaseUrl(explicit);

  const runtimeId = readTrimmedEnv("SIMPLE_AGENT_MICROSERVICES_SHARED_RUNTIME_ID");
  if (!runtimeId) {
    throw new Error(
      "Missing shared runtime location. Set ECS_SHARED_OTTOAUTH_SMOKE_BASE_URL or SIMPLE_AGENT_MICROSERVICES_SHARED_BASE_URL or SIMPLE_AGENT_MICROSERVICES_SHARED_RUNTIME_ID.",
    );
  }
  const parsed = parseEcsRuntimeId(runtimeId);
  if (!parsed) {
    throw new Error("SIMPLE_AGENT_MICROSERVICES_SHARED_RUNTIME_ID must use ecs:<cluster>|<service> format.");
  }
  const region = readTrimmedEnv("AWS_REGION");
  if (!region) {
    throw new Error("AWS_REGION is required to resolve SIMPLE_AGENT_MICROSERVICES_SHARED_RUNTIME_ID.");
  }
  const publicIp = await resolveServicePublicIp(region, parsed.cluster, parsed.serviceName);
  if (!publicIp) {
    throw new Error(`Could not resolve public IP for shared runtime service ${parsed.serviceName}.`);
  }
  const port = Number(readTrimmedEnv("SIMPLE_AGENT_MICROSERVICES_FRONTEND_PORT") || "18789");
  return `http://${publicIp}:${port}/`;
}

async function readResponseBody(response: Response) {
  const text = await response.text().catch(() => "");
  if (!text) return {};
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return { raw: text.slice(0, 1000) };
  }
}

async function runtimeRequest(input: RuntimeRequestInput): Promise<RuntimeRequestResult> {
  const response = await fetch(new URL(input.path, input.baseUrl), {
    method: input.method ?? "GET",
    headers: {
      ...(input.body ? { "content-type": "application/json" } : {}),
      ...(input.headers ?? {}),
    },
    body: input.body ? JSON.stringify(input.body) : undefined,
    signal: AbortSignal.timeout(input.timeoutMs ?? 15_000),
  });
  const body = await readResponseBody(response);
  return {
    ok: response.ok,
    status: response.status,
    body,
  };
}

function extractToolNamesFromBody(body: Record<string, unknown>) {
  const names = new Set<string>();
  const collect = (value: unknown) => {
    if (!Array.isArray(value)) return;
    for (const entry of value) {
      if (!entry || typeof entry !== "object") continue;
      const name = String((entry as { name?: unknown }).name ?? "").trim();
      if (name) names.add(name);
    }
  };
  collect(body.tools);
  collect(body.mcp_tools);
  if (body.mcp && typeof body.mcp === "object" && !Array.isArray(body.mcp)) {
    collect((body.mcp as { tools?: unknown }).tools);
  }
  return [...names].sort();
}

function isOttoAuthToolName(name: string) {
  const normalized = name.trim().toLowerCase();
  return normalized.includes("ottoauth") || normalized.includes("ottoagent");
}

function summarizeBody(body: Record<string, unknown>) {
  const direct = [
    typeof body.error === "string" ? body.error : "",
    typeof body.detail === "string" ? body.detail : "",
    typeof body.message === "string" ? body.message : "",
    typeof body.raw === "string" ? body.raw : "",
  ].find(Boolean);
  if (direct) return direct;
  return JSON.stringify(body).slice(0, 500);
}

function extractChatAssistantMessage(body: Record<string, unknown>) {
  return String(body.assistant_message ?? "").trim();
}

function extractChatStatus(body: Record<string, unknown>) {
  return String(body.status ?? "").trim().toLowerCase();
}

function looksLikeMissingArgsError(message: string) {
  const normalized = message.toLowerCase();
  return (
    normalized.includes("missing required") ||
    normalized.includes("path parameter") ||
    normalized.includes("invalid argument") ||
    normalized.includes("arguments") ||
    normalized.includes("required argument")
  );
}

function looksLikeUnknownToolError(message: string) {
  return message.toLowerCase().includes("unknown tool");
}

function findFirstServiceId(value: unknown, depth = 0): string {
  if (depth > 6 || value === null || value === undefined) return "";
  if (Array.isArray(value)) {
    for (const item of value) {
      const nested = findFirstServiceId(item, depth + 1);
      if (nested) return nested;
    }
    return "";
  }
  if (typeof value !== "object") return "";
  const objectValue = value as Record<string, unknown>;
  if (Array.isArray(objectValue.services)) {
    for (const service of objectValue.services) {
      if (!service || typeof service !== "object") continue;
      const id = String((service as { id?: unknown }).id ?? "").trim();
      if (id) return id;
    }
  }
  for (const nestedValue of Object.values(objectValue)) {
    const nested = findFirstServiceId(nestedValue, depth + 1);
    if (nested) return nested;
  }
  return "";
}

function parseJsonLikePayload(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const candidates = [trimmed];
  const objectStart = trimmed.indexOf("{");
  const objectEnd = trimmed.lastIndexOf("}");
  if (objectStart >= 0 && objectEnd > objectStart) {
    candidates.push(trimmed.slice(objectStart, objectEnd + 1));
  }
  const arrayStart = trimmed.indexOf("[");
  const arrayEnd = trimmed.lastIndexOf("]");
  if (arrayStart >= 0 && arrayEnd > arrayStart) {
    candidates.push(trimmed.slice(arrayStart, arrayEnd + 1));
  }
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch {
      // Keep trying.
    }
  }
  return null;
}

function buildProbeHeaders() {
  const token = readTrimmedEnv("OTTOAGENT_MCP_TOKEN");
  const headers: Record<string, string> = {};
  if (!token) return headers;
  headers.authorization = `Bearer ${token}`;
  headers["x-agent-gateway-auth-token"] = token;
  headers["x-agent-gateway-token"] = token;
  headers["x-gateway-token"] = token;
  return headers;
}

function isLikelyMutatingTool(name: string) {
  const normalized = name.toLowerCase();
  return (
    normalized.includes("_post_") ||
    normalized.includes("_put_") ||
    normalized.includes("_patch_") ||
    normalized.includes("_delete_")
  );
}

function toolArgsForProbe(toolName: string, firstServiceId: string) {
  const normalized = toolName.toLowerCase();
  if (normalized.includes("http_request")) {
    return { method: "GET", path: "/api/services" } as Record<string, unknown>;
  }
  if (normalized.includes("get_service") && firstServiceId) {
    return { id: firstServiceId } as Record<string, unknown>;
  }
  return {} as Record<string, unknown>;
}

async function createRuntimeProbeIdentity(baseUrl: string) {
  const userId = `smoke-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const createUser = await runtimeRequest({
    baseUrl,
    path: "/api/users",
    method: "POST",
    body: {
      user_id: userId,
      display_name: userId,
    },
  });
  if (!createUser.ok) {
    throw new Error(`Failed to create smoke user (${createUser.status}): ${summarizeBody(createUser.body)}`);
  }

  const botSeed = `smoke-bot-${Date.now().toString(36)}`;
  const createBot = await runtimeRequest({
    baseUrl,
    path: `/api/users/${encodeURIComponent(userId)}/bots`,
    method: "POST",
    body: {
      bot_id: botSeed,
      name: botSeed,
    },
  });
  if (!createBot.ok) {
    throw new Error(`Failed to create smoke bot (${createBot.status}): ${summarizeBody(createBot.body)}`);
  }

  const botBody = createBot.body.bot;
  const botId =
    botBody && typeof botBody === "object" && !Array.isArray(botBody)
      ? String((botBody as { bot_id?: unknown }).bot_id ?? "").trim()
      : "";
  if (!botId) {
    throw new Error("Smoke bot creation response did not include bot_id.");
  }

  return {
    userId,
    botId,
    sessionId: `hook:smoke-${Date.now().toString(36)}`,
  };
}

async function discoverMcpTools(baseUrl: string) {
  const candidates = ["/api/mcp/status", "/api/mcp/tools", "/api/config/tools", "/health", "/healthz"];
  let sawReachable = false;
  for (const endpoint of candidates) {
    const response = await runtimeRequest({
      baseUrl,
      path: endpoint,
      method: "GET",
    });
    if (response.status === 404) continue;
    sawReachable = true;
    if (response.status >= 500) {
      throw new Error(`GET ${endpoint} failed with status ${response.status}.`);
    }
    const tools = extractToolNamesFromBody(response.body);
    if (tools.length > 0) {
      return { endpoint, tools };
    }
  }
  if (!sawReachable) {
    throw new Error("No MCP tools endpoint found (all candidate paths returned 404).");
  }
  throw new Error("MCP tools endpoint reachable but no tools were returned.");
}

async function probeCallbacks(baseUrl: string) {
  const headers = buildProbeHeaders();
  const response = await runtimeRequest({
    baseUrl,
    path: "/hooks/ottoauth",
    method: "POST",
    headers,
    body: {
      source: "oneclick_smoke",
      message: "shared runtime callback probe",
      event_id: `smoke-${Date.now()}`,
    },
    timeoutMs: 10_000,
  });
  if (response.status === 404) {
    throw new Error("Callback route /hooks/ottoauth is missing (404).");
  }
  if (!response.ok) {
    throw new Error(`Callback probe failed (${response.status}): ${summarizeBody(response.body)}`);
  }
  return response.status;
}

async function runChatCommand(input: {
  baseUrl: string;
  botId: string;
  userId: string;
  sessionId: string;
  command: string;
}) {
  return runtimeRequest({
    baseUrl: input.baseUrl,
    path: "/api/chat",
    method: "POST",
    body: {
      bot_id: input.botId,
      user_id: input.userId,
      session_id: input.sessionId,
      message: input.command,
      wait_for_response: true,
      timeout_s: 90,
    },
    timeoutMs: 95_000,
  });
}

async function main() {
  const allowMutatingTools = readBoolEnv("ECS_SHARED_OTTOAUTH_SMOKE_ALLOW_MUTATING_TOOLS", false);
  const baseUrl = await resolveSharedBaseUrl();
  console.log(`Shared OttoAuth smoke target: ${baseUrl}`);

  const callbackStatus = await probeCallbacks(baseUrl);
  console.log(`Callback probe status: ${callbackStatus}`);

  const configEnable = await runtimeRequest({
    baseUrl,
    path: "/api/mcp/config",
    method: "POST",
    body: { enabled: true, mcp_enabled: true },
  });
  if (!configEnable.ok && configEnable.status !== 404) {
    throw new Error(`POST /api/mcp/config failed (${configEnable.status}): ${summarizeBody(configEnable.body)}`);
  }

  const toolsProbe = await discoverMcpTools(baseUrl);
  const ottoAuthTools = toolsProbe.tools.filter((name) => isOttoAuthToolName(name));
  if (ottoAuthTools.length === 0) {
    throw new Error(`No OttoAuth tools detected on ${toolsProbe.endpoint}.`);
  }

  console.log(`Discovered ${toolsProbe.tools.length} total tools (${ottoAuthTools.length} OttoAuth tools) via ${toolsProbe.endpoint}.`);

  const outcomes: Array<{ tool: string; outcome: ToolCallOutcome; reason: string }> = [];
  let firstServiceId = "";

  const prioritized = Array.from(
    new Set([
      ...ottoAuthTools.filter((name) => /list[_-]?services/i.test(name)),
      ...ottoAuthTools.filter((name) => /refresh[_-]?tools/i.test(name)),
      ...ottoAuthTools.filter((name) => /http[_-]?request/i.test(name)),
      ...ottoAuthTools.filter((name) => /get[_-]?service/i.test(name)),
    ]),
  );
  const prioritizedSet = new Set(prioritized);
  const probeIdentity = await createRuntimeProbeIdentity(baseUrl);
  console.log(`Created smoke probe identity user=${probeIdentity.userId} bot=${probeIdentity.botId}`);

  const toolsChat = await runChatCommand({
    baseUrl,
    botId: probeIdentity.botId,
    userId: probeIdentity.userId,
    sessionId: probeIdentity.sessionId,
    command: "/mcp tools",
  });
  if (!toolsChat.ok) {
    throw new Error(`Chat MCP tools command failed (${toolsChat.status}): ${summarizeBody(toolsChat.body)}`);
  }
  const toolsChatStatus = extractChatStatus(toolsChat.body);
  const toolsChatMessage = extractChatAssistantMessage(toolsChat.body);
  if (toolsChatStatus !== "completed" || !toolsChatMessage) {
    throw new Error(
      `Chat MCP tools command did not complete: status=${toolsChatStatus || "unknown"} payload=${summarizeBody(toolsChat.body)}`,
    );
  }

  const evaluateToolCall = (tool: string, response: RuntimeRequestResult, output: string, allowArgumentErrors: boolean) => {
    if (!response.ok) {
      outcomes.push({ tool, outcome: "fail", reason: `status=${response.status} ${summarizeBody(response.body)}` });
      return;
    }
    const chatStatus = extractChatStatus(response.body);
    const message = output.trim();
    if (chatStatus !== "completed" || !message) {
      outcomes.push({
        tool,
        outcome: "fail",
        reason: `chat_status=${chatStatus || "unknown"} payload=${summarizeBody(response.body)}`,
      });
      return;
    }
    if (looksLikeUnknownToolError(message)) {
      outcomes.push({ tool, outcome: "fail", reason: `unknown tool: ${message}` });
      return;
    }
    if (message.toLowerCase().includes("mcp tool call failed")) {
      if (allowArgumentErrors && looksLikeMissingArgsError(message)) {
        outcomes.push({ tool, outcome: "warn", reason: `argument warning: ${message}` });
        return;
      }
      outcomes.push({ tool, outcome: "fail", reason: message.slice(0, 300) });
      return;
    }
    if (allowArgumentErrors && looksLikeMissingArgsError(message)) {
      outcomes.push({ tool, outcome: "warn", reason: `argument warning: ${message}` });
      return;
    }
    outcomes.push({ tool, outcome: "pass", reason: "ok" });
  };

  for (const tool of prioritized) {
    const args = toolArgsForProbe(tool, firstServiceId);
    const response = await runChatCommand({
      baseUrl,
      botId: probeIdentity.botId,
      userId: probeIdentity.userId,
      sessionId: probeIdentity.sessionId,
      command: `/mcp call ${tool} ${JSON.stringify(args)}`,
    });
    const output = extractChatAssistantMessage(response.body);
    evaluateToolCall(tool, response, output, false);
    if (/list[_-]?services/i.test(tool)) {
      const maybeService = findFirstServiceId(parseJsonLikePayload(output));
      if (maybeService) {
        firstServiceId = maybeService;
      }
    }
  }

  for (const tool of ottoAuthTools) {
    if (prioritizedSet.has(tool)) continue;
    if (isLikelyMutatingTool(tool) && !allowMutatingTools) {
      outcomes.push({ tool, outcome: "skip", reason: "skipped mutating tool (enable ECS_SHARED_OTTOAUTH_SMOKE_ALLOW_MUTATING_TOOLS=true to run)" });
      continue;
    }
    const args = toolArgsForProbe(tool, firstServiceId);
    const response = await runChatCommand({
      baseUrl,
      botId: probeIdentity.botId,
      userId: probeIdentity.userId,
      sessionId: probeIdentity.sessionId,
      command: `/mcp call ${tool} ${JSON.stringify(args)}`,
    });
    const output = extractChatAssistantMessage(response.body);
    evaluateToolCall(tool, response, output, true);
  }

  const pass = outcomes.filter((entry) => entry.outcome === "pass");
  const warn = outcomes.filter((entry) => entry.outcome === "warn");
  const skip = outcomes.filter((entry) => entry.outcome === "skip");
  const fail = outcomes.filter((entry) => entry.outcome === "fail");

  for (const entry of outcomes) {
    const prefix =
      entry.outcome === "pass" ? "[PASS]" :
      entry.outcome === "warn" ? "[WARN]" :
      entry.outcome === "skip" ? "[SKIP]" :
      "[FAIL]";
    console.log(`${prefix} ${entry.tool} :: ${entry.reason}`);
  }

  console.log(
    `Summary: pass=${pass.length} warn=${warn.length} skip=${skip.length} fail=${fail.length} total=${outcomes.length}`,
  );

  if (fail.length > 0) {
    throw new Error("Shared OttoAuth smoke failed. See [FAIL] lines above.");
  }

  console.log("Shared OttoAuth smoke passed.");
}

void main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exit(1);
});
