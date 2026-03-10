import { pool } from "@/lib/db";
import {
  applyCalibrationFromFirstUserMessage,
  ensureDefaultRuntimeMemoryDocs,
  touchRuntimeSession,
} from "@/app/api/runtime/[id]/shared";
import {
  executeServerlessRuntimeToolCall,
  listServerlessRuntimeTools,
  type ServerlessRuntimeTool,
  type ServerlessRuntimeToolResult,
} from "@/lib/runtime/serverlessTools";
import { resolveServerlessBotId } from "@/lib/runtime/ottoauthAccounts";
import {
  RUNTIME_CONTRACT_VERSION,
  TOOLS_PROTOCOL_VERSION,
} from "@/lib/runtime/runtimeMetadata";

type StoredMessage = {
  role: "user" | "assistant";
  content: string;
};

type MemoryDocRow = {
  doc_key: string;
  content: string;
};

type InsertedMessageRow = {
  id: number;
  content: string;
  created_at: string;
};

export type ServerlessRuntimeModelConfig = {
  model_provider: string | null;
  default_model: string | null;
  openai_api_key: string | null;
  anthropic_api_key: string | null;
  openrouter_api_key: string | null;
  subsidy_proxy_token: string | null;
  runtime_bot_id?: string | null;
  bot_name?: string | null;
};

export type ServerlessToolTraceEntry = {
  call_id: string;
  tool: string;
  source: "builtin" | "mcp" | "gateway";
  ok: boolean;
  latency_ms: number;
  arguments?: Record<string, unknown> | null;
  result?: unknown;
  error?: string | null;
};

export type ServerlessContextUsage = {
  estimated: true;
  model: string;
  currentTokens: number;
  maxTokens: number;
  remainingTokens: number;
  usageRatio: number;
};

function readTrimmedEnv(name: string) {
  const raw = process.env[name];
  if (!raw) return "";
  return raw.trim().replace(/^"(.*)"$/, "$1").replace(/\\n/g, "").trim();
}

function clipForPrompt(value: string, maxChars: number) {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}\n...[truncated]`;
}

function buildToolInstructionBlock(tools: ServerlessRuntimeTool[]) {
  if (!tools.length) return "";
  const lines = tools
    .map((tool) => {
      const schema = JSON.stringify(tool.inputSchema);
      return `- ${tool.name}: ${tool.description} (schema: ${schema})`;
    })
    .join("\n");
  return [
    "Tool usage is enabled.",
    "When you need a tool, output exactly one tool call and no extra text:",
    "- For current time: <tool:current_time>{\"timezone\":\"UTC\"}</tool:current_time>",
    "- For OttoAuth tools: <tool:mcp name=\"tool_name\">{\"arg\":\"value\"}</tool:mcp>",
    "- Do not ask the user for OttoAuth username/private_key. Bot credentials are injected automatically.",
    "After receiving TOOL_RESULT, respond normally to the user.",
    "Available tools:",
    lines,
  ].join("\n");
}

function resolveSystemPrompt(memoryDocs: MemoryDocRow[], tools: ServerlessRuntimeTool[]) {
  const basePrompt = readTrimmedEnv("SIMPLE_AGENT_MICROSERVICES_SYSTEM_PROMPT") || "You are a concise, helpful assistant.";
  const toolBlock = buildToolInstructionBlock(tools);
  if (!memoryDocs.length) {
    return toolBlock ? `${basePrompt}\n\n${toolBlock}` : basePrompt;
  }

  const docsBlock = memoryDocs
    .map((doc) => {
      const key = doc.doc_key.trim();
      const content = clipForPrompt(doc.content.replace(/<!--\s*oneclick:autofill\s*-->/gi, "").trim(), 12_000);
      return `### ${key}\n${content}`;
    })
    .join("\n\n");

  return `${basePrompt}

Follow these runtime memory docs exactly when they apply:

${docsBlock}

${toolBlock}`.trim();
}

function resolveOpenAiModel(defaultModel: string | null | undefined) {
  return defaultModel?.trim() || readTrimmedEnv("SIMPLE_AGENT_MODEL") || "gpt-4o-mini";
}

function resolveAnthropicModel(defaultModel: string | null | undefined) {
  return defaultModel?.trim() || readTrimmedEnv("ANTHROPIC_MODEL") || "claude-3-5-haiku-latest";
}

function normalizeBaseUrl(raw: string, fallback: string) {
  const trimmed = raw.trim();
  if (!trimmed) return fallback;
  const withProtocol = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  const parsed = new URL(withProtocol);
  parsed.hash = "";
  parsed.search = "";
  parsed.pathname = parsed.pathname.replace(/\/+$/, "") || "/v1";
  return parsed.toString().replace(/\/$/, "");
}

function normalizeOriginUrl(raw: string, fallback: string) {
  const trimmed = raw.trim();
  const withProtocol = trimmed && /^https?:\/\//i.test(trimmed) ? trimmed : (trimmed ? `https://${trimmed}` : fallback);
  const parsed = new URL(withProtocol);
  parsed.pathname = "/";
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString().replace(/\/$/, "");
}

function openAiContentToText(content: unknown) {
  if (typeof content === "string") return content.trim();
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (!part || typeof part !== "object") return "";
        const text = (part as { text?: unknown }).text;
        return typeof text === "string" ? text : "";
      })
      .join("\n")
      .trim();
  }
  return "";
}

type ParsedToolCall = {
  name: string;
  arguments: Record<string, unknown>;
};

function parseJsonObjectOrDefault(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return {} as Record<string, unknown>;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {} as Record<string, unknown>;
    }
    return parsed as Record<string, unknown>;
  } catch {
    return {} as Record<string, unknown>;
  }
}

function extractToolCall(text: string, availableToolNames: Set<string>) {
  const mcpMatch = text.match(/<tool:mcp\s+name="([^"]+)">\s*([\s\S]*?)\s*<\/tool:mcp>/i);
  if (mcpMatch) {
    const mcpName = mcpMatch[1]?.trim() || "";
    if (!mcpName) return null;
    return {
      name: mcpName,
      arguments: parseJsonObjectOrDefault(mcpMatch[2] ?? ""),
    } satisfies ParsedToolCall;
  }

  const directMatch = text.match(/<tool:([A-Za-z0-9_.-]+)>\s*([\s\S]*?)\s*<\/tool:\1>/i);
  if (!directMatch) return null;

  const rawName = directMatch[1]?.trim() || "";
  if (!rawName || rawName === "mcp") return null;
  const name = rawName === "time_now" ? "current_time" : rawName;
  if (!availableToolNames.has(name)) {
    return {
      name,
      arguments: parseJsonObjectOrDefault(directMatch[2] ?? ""),
    } satisfies ParsedToolCall;
  }
  return {
    name,
    arguments: parseJsonObjectOrDefault(directMatch[2] ?? ""),
  } satisfies ParsedToolCall;
}

function resolveToolSource(toolName: string): "builtin" | "mcp" | "gateway" {
  if (toolName.includes(".")) return "mcp";
  if (toolName.startsWith("gateway")) return "gateway";
  return "builtin";
}

const MODEL_CONTEXT_LIMITS_TOKENS: Record<string, number> = {
  "gpt-4o-mini": 128_000,
  "gpt-5.3-codex": 200_000,
  "gpt-5-thinking-high": 200_000,
  "gpt-5-mini": 200_000,
  "gpt-5.2-pro": 200_000,
  "claude-opus-4-6": 200_000,
  "claude-sonnet-4-6": 200_000,
  "claude-haiku-4-5": 200_000,
  "gemini-3.1-pro": 1_000_000,
  "gemini-3-flash": 1_000_000,
};

export function maxContextTokensForModel(modelId: string | null | undefined) {
  const clean = (modelId ?? "").trim();
  if (!clean) return 128_000;
  const exact = MODEL_CONTEXT_LIMITS_TOKENS[clean];
  if (exact) return exact;
  const lowered = clean.toLowerCase();
  if (lowered.startsWith("gpt-4o")) return 128_000;
  if (lowered.startsWith("gpt-5") || lowered.startsWith("o1") || lowered.startsWith("o3") || lowered.includes("codex")) {
    return 200_000;
  }
  if (lowered.startsWith("claude")) return 200_000;
  if (lowered.startsWith("gemini")) return 1_000_000;
  return 128_000;
}

export function estimateTokensForMessages(messages: Array<{ role: string; content: string }>) {
  let total = 2;
  for (const message of messages) {
    const role = String(message.role ?? "").trim();
    const content = String(message.content ?? "").trim();
    total += 4;
    if (role) total += Math.max(1, Math.ceil(role.length / 4));
    if (content) total += Math.max(1, Math.ceil(content.length / 4));
  }
  return Math.max(0, total);
}

function buildContextUsageMetrics(input: {
  messages: Array<{ role: string; content: string }>;
  model: string;
}): ServerlessContextUsage {
  const model = input.model.trim() || "gpt-4o-mini";
  const currentTokens = estimateTokensForMessages(input.messages);
  const maxTokens = maxContextTokensForModel(model);
  const remainingTokens = Math.max(0, maxTokens - currentTokens);
  const usageRatio = maxTokens > 0 ? Math.max(0, Math.min(1, currentTokens / maxTokens)) : 0;
  return {
    estimated: true,
    model,
    currentTokens,
    maxTokens,
    remainingTokens,
    usageRatio,
  };
}

async function loadServerlessPromptContext(input: { deploymentId: string; sessionId: string }) {
  const history = await pool.query<{ role: string; content: string }>(
    `SELECT role, content
     FROM runtime_chat_messages
     WHERE deployment_id = $1
       AND session_id = $2
       AND role IN ('user', 'assistant')
     ORDER BY id DESC
     LIMIT 24`,
    [input.deploymentId, input.sessionId],
  );
  const contextMessages: StoredMessage[] = history.rows
    .reverse()
    .map((item) => ({ role: item.role as "user" | "assistant", content: item.content }));

  await ensureDefaultRuntimeMemoryDocs(input.deploymentId);
  const memoryDocs = await pool.query<MemoryDocRow>(
    `SELECT doc_key, content
     FROM runtime_memory_docs
     WHERE deployment_id = $1
       AND LENGTH(TRIM(content)) > 0
     ORDER BY doc_key ASC
     LIMIT 12`,
    [input.deploymentId],
  );
  const toolsCatalog = await listServerlessRuntimeTools();
  const availableTools = toolsCatalog.tools.filter((tool) => tool.available);
  const systemPrompt = resolveSystemPrompt(memoryDocs.rows, availableTools);
  return {
    contextMessages,
    systemPrompt,
    availableToolNames: new Set(availableTools.map((tool) => tool.name)),
  };
}

export async function estimateServerlessContextUsage(input: {
  deploymentId: string;
  sessionId: string;
  selectedModel: string;
  draftMessage?: string | null;
}) {
  const promptContext = await loadServerlessPromptContext({
    deploymentId: input.deploymentId,
    sessionId: input.sessionId,
  });
  const draftMessage = (input.draftMessage ?? "").trim();
  const usageMessages: Array<{ role: string; content: string }> = [
    { role: "system", content: promptContext.systemPrompt },
    ...promptContext.contextMessages.map((item) => ({ role: item.role, content: item.content })),
  ];
  if (draftMessage) {
    usageMessages.push({ role: "user", content: draftMessage.slice(0, 8_000) });
  }
  return buildContextUsageMetrics({
    messages: usageMessages,
    model: input.selectedModel,
  });
}

async function callOpenAiCompatible(input: {
  baseUrl: string;
  token: string;
  model: string;
  systemPrompt: string;
  messages: StoredMessage[];
  extraHeaders?: Record<string, string>;
}) {
  const endpoint = `${input.baseUrl}/chat/completions`;
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${input.token}`,
      "Content-Type": "application/json",
      ...(input.extraHeaders ?? {}),
    },
    body: JSON.stringify({
      model: input.model,
      temperature: 0.4,
      messages: [
        { role: "system", content: input.systemPrompt },
        ...input.messages.map((message) => ({
          role: message.role,
          content: message.content,
        })),
      ],
    }),
    signal: AbortSignal.timeout(35_000),
  });

  const body = (await response.json().catch(() => null)) as
    | { choices?: Array<{ message?: { content?: unknown } }>; error?: { message?: string } }
    | null;
  if (!response.ok) {
    const details = body?.error?.message || `Provider request failed (${response.status})`;
    throw new Error(details);
  }
  const text = openAiContentToText(body?.choices?.[0]?.message?.content);
  if (!text) {
    throw new Error("Model returned an empty response.");
  }
  return text;
}

async function callAnthropic(input: {
  token: string;
  model: string;
  systemPrompt: string;
  messages: StoredMessage[];
}) {
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": input.token,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: input.model,
      max_tokens: 800,
      temperature: 0.4,
      system: input.systemPrompt,
      messages: input.messages.map((message) => ({
        role: message.role,
        content: message.content,
      })),
    }),
    signal: AbortSignal.timeout(35_000),
  });

  const body = (await response.json().catch(() => null)) as
    | {
        content?: Array<{ type?: string; text?: string }>;
        error?: { message?: string };
      }
    | null;
  if (!response.ok) {
    const details = body?.error?.message || `Anthropic request failed (${response.status})`;
    throw new Error(details);
  }
  const text = (body?.content ?? [])
    .filter((item) => item?.type === "text" && typeof item.text === "string")
    .map((item) => item.text as string)
    .join("\n")
    .trim();
  if (!text) {
    throw new Error("Model returned an empty response.");
  }
  return text;
}

export async function runServerlessChatTurn(input: {
  deploymentId: string;
  sessionId: string;
  userMessage: string;
  requestOrigin: string;
  modelConfig: ServerlessRuntimeModelConfig;
}) {
  const existingUserCount = await pool.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count
     FROM runtime_chat_messages
     WHERE deployment_id = $1
       AND session_id = $2
       AND role = 'user'`,
    [input.deploymentId, input.sessionId],
  );
  const isFirstUserMessageForSession = Number(existingUserCount.rows[0]?.count ?? "0") === 0;

  const userInsert = await pool.query<InsertedMessageRow>(
    `INSERT INTO runtime_chat_messages (deployment_id, session_id, role, content)
     VALUES ($1, $2, 'user', $3)
     RETURNING id, content, created_at`,
    [input.deploymentId, input.sessionId, input.userMessage.trim()],
  );
  const userMessage = userInsert.rows[0];

  if (isFirstUserMessageForSession) {
    try {
      await applyCalibrationFromFirstUserMessage({
        deploymentId: input.deploymentId,
        userMessage: userMessage.content,
      });
    } catch (error) {
      console.warn(
        `[runtime-chat:${input.deploymentId}] first-turn calibration update failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  const promptContext = await loadServerlessPromptContext({
    deploymentId: input.deploymentId,
    sessionId: input.sessionId,
  });
  const contextMessages = promptContext.contextMessages;
  const availableToolNames = promptContext.availableToolNames;
  const systemPrompt = promptContext.systemPrompt;
  const runtimeBotId = resolveServerlessBotId({
    deploymentId: input.deploymentId,
    runtimeBotId: input.modelConfig.runtime_bot_id ?? null,
  });
  const openaiApiKey = input.modelConfig.openai_api_key?.trim() || "";
  const openrouterApiKey = input.modelConfig.openrouter_api_key?.trim() || "";
  const anthropicApiKey = input.modelConfig.anthropic_api_key?.trim() || "";
  const subsidyToken = input.modelConfig.subsidy_proxy_token?.trim() || "";
  const preferredModelProvider = (input.modelConfig.model_provider ?? "").trim().toLowerCase();
  const defaultModel = input.modelConfig.default_model?.trim() || null;

  async function generateAssistantReply(messages: StoredMessage[]) {
    if (preferredModelProvider === "openrouter") {
      if (!openrouterApiKey) {
        throw new Error("Model provider is set to OpenRouter, but no OpenRouter API key is configured.");
      }
      return await callOpenAiCompatible({
        baseUrl: normalizeBaseUrl(readTrimmedEnv("OPENROUTER_BASE_URL"), "https://openrouter.ai/api/v1"),
        token: openrouterApiKey,
        model: resolveOpenAiModel(defaultModel),
        systemPrompt,
        messages,
        extraHeaders: {
          "HTTP-Referer": normalizeOriginUrl(readTrimmedEnv("APP_BASE_URL"), input.requestOrigin || "http://localhost:3000"),
          "X-Title": "OneClick Serverless Runtime",
        },
      });
    }

    if (preferredModelProvider === "openai") {
      if (!openaiApiKey && !subsidyToken) {
        throw new Error("Model provider is set to OpenAI, but no OpenAI key or subsidy token is available.");
      }
      const baseUrl = subsidyToken
        ? `${input.requestOrigin}/api/subsidy/openai/${input.deploymentId}`
        : normalizeBaseUrl(readTrimmedEnv("OPENAI_BASE_URL") || readTrimmedEnv("OPENAI_API_BASE"), "https://api.openai.com/v1");
      return await callOpenAiCompatible({
        baseUrl,
        token: subsidyToken || openaiApiKey,
        model: resolveOpenAiModel(defaultModel),
        systemPrompt,
        messages,
      });
    }

    if (preferredModelProvider === "anthropic") {
      if (!anthropicApiKey) {
        throw new Error("Model provider is set to Anthropic, but no Anthropic API key is configured.");
      }
      return await callAnthropic({
        token: anthropicApiKey,
        model: resolveAnthropicModel(defaultModel),
        systemPrompt,
        messages,
      });
    }

    if (openrouterApiKey) {
      return await callOpenAiCompatible({
        baseUrl: normalizeBaseUrl(readTrimmedEnv("OPENROUTER_BASE_URL"), "https://openrouter.ai/api/v1"),
        token: openrouterApiKey,
        model: resolveOpenAiModel(defaultModel),
        systemPrompt,
        messages,
        extraHeaders: {
          "HTTP-Referer": normalizeOriginUrl(readTrimmedEnv("APP_BASE_URL"), input.requestOrigin || "http://localhost:3000"),
          "X-Title": "OneClick Serverless Runtime",
        },
      });
    }

    if (openaiApiKey || subsidyToken) {
      const baseUrl = subsidyToken
        ? `${input.requestOrigin}/api/subsidy/openai/${input.deploymentId}`
        : normalizeBaseUrl(readTrimmedEnv("OPENAI_BASE_URL") || readTrimmedEnv("OPENAI_API_BASE"), "https://api.openai.com/v1");
      return await callOpenAiCompatible({
        baseUrl,
        token: subsidyToken || openaiApiKey,
        model: resolveOpenAiModel(defaultModel),
        systemPrompt,
        messages,
      });
    }

    if (anthropicApiKey) {
      return await callAnthropic({
        token: anthropicApiKey,
        model: resolveAnthropicModel(defaultModel),
        systemPrompt,
        messages,
      });
    }

    throw new Error("No model API key found. Set OpenAI, OpenRouter, or Anthropic key in deployment settings.");
  }

  let workingMessages = [...contextMessages];
  let assistantText = "";
  const maxToolPasses = 4;
  const toolTrace: ServerlessToolTraceEntry[] = [];
  for (let step = 0; step <= maxToolPasses; step++) {
    assistantText = await generateAssistantReply(workingMessages);
    const toolCall = extractToolCall(assistantText, availableToolNames);
    if (!toolCall) break;
    if (step === maxToolPasses) {
      assistantText = "I hit the tool-call depth limit. Please try again with a more specific request.";
      break;
    }

    let toolResult: ServerlessRuntimeToolResult;
    const callId = `tc_${step + 1}`;
    const toolStartedAt = Date.now();
    if (!availableToolNames.has(toolCall.name)) {
      toolResult = {
        ok: false,
        tool: toolCall.name,
        error: `Tool '${toolCall.name}' is not available in this runtime.`,
      };
    } else {
      try {
        toolResult = await executeServerlessRuntimeToolCall({
          deploymentId: input.deploymentId,
          botId: runtimeBotId,
          botName: input.modelConfig.bot_name ?? null,
          name: toolCall.name,
          arguments: toolCall.arguments,
        });
      } catch (error) {
        toolResult = {
          ok: false,
          tool: toolCall.name,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }
    toolTrace.push({
      call_id: callId,
      tool: toolCall.name,
      source: resolveToolSource(toolCall.name),
      ok: Boolean(toolResult.ok),
      latency_ms: Date.now() - toolStartedAt,
      arguments: toolCall.arguments,
      result: toolResult.ok ? (toolResult.result ?? null) : null,
      error: toolResult.ok ? null : toolResult.error ?? "tool call failed",
    });

    workingMessages = [
      ...workingMessages,
      { role: "assistant", content: assistantText },
      {
        role: "user",
        content: `TOOL_RESULT ${toolCall.name}\n${JSON.stringify(toolResult, null, 2)}`,
      },
    ];
  }

  const assistantInsert = await pool.query<InsertedMessageRow>(
    `INSERT INTO runtime_chat_messages (deployment_id, session_id, role, content)
     VALUES ($1, $2, 'assistant', $3)
     RETURNING id, content, created_at`,
    [input.deploymentId, input.sessionId, assistantText],
  );
  const assistantMessage = assistantInsert.rows[0];
  await touchRuntimeSession({ deploymentId: input.deploymentId, sessionId: input.sessionId });
  const contextUsage = buildContextUsageMetrics({
    messages: [
      { role: "system", content: systemPrompt },
      ...contextMessages,
      { role: "assistant", content: assistantMessage.content },
    ],
    model: defaultModel || resolveOpenAiModel(defaultModel),
  });

  return {
    sessionId: input.sessionId,
    userMessage: {
      id: userMessage.id,
      role: "user" as const,
      content: userMessage.content,
      createdAt: userMessage.created_at,
    },
    assistantMessage: {
      id: assistantMessage.id,
      role: "assistant" as const,
      content: assistantMessage.content,
      createdAt: assistantMessage.created_at,
    },
    toolTrace,
    contextUsage,
  };
}

export function getServerlessEmbeddedCapabilities() {
  return {
    runtime_contract_version: RUNTIME_CONTRACT_VERSION,
    tools_protocol: TOOLS_PROTOCOL_VERSION,
    max_tool_passes: 4,
    features: {
      web_search: true,
      web_fetch: true,
      mcp: true,
      telegram_webhook: true,
      streaming: false,
    },
  };
}
