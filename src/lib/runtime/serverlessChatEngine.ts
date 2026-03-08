import { pool } from "@/lib/db";
import {
  applyCalibrationFromFirstUserMessage,
  ensureDefaultRuntimeMemoryDocs,
  touchRuntimeSession,
} from "@/app/api/runtime/[id]/shared";

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

function resolveSystemPrompt(memoryDocs: MemoryDocRow[]) {
  const basePrompt = readTrimmedEnv("SIMPLE_AGENT_MICROSERVICES_SYSTEM_PROMPT") || "You are a concise, helpful assistant.";
  if (!memoryDocs.length) return basePrompt;

  const docsBlock = memoryDocs
    .map((doc) => {
      const key = doc.doc_key.trim();
      const content = clipForPrompt(doc.content.replace(/<!--\s*oneclick:autofill\s*-->/gi, "").trim(), 12_000);
      return `### ${key}\n${content}`;
    })
    .join("\n\n");

  return `${basePrompt}

Follow these runtime memory docs exactly when they apply:

${docsBlock}`;
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
  const systemPrompt = resolveSystemPrompt(memoryDocs.rows);
  const openaiApiKey = input.modelConfig.openai_api_key?.trim() || "";
  const openrouterApiKey = input.modelConfig.openrouter_api_key?.trim() || "";
  const anthropicApiKey = input.modelConfig.anthropic_api_key?.trim() || "";
  const subsidyToken = input.modelConfig.subsidy_proxy_token?.trim() || "";
  const preferredModelProvider = (input.modelConfig.model_provider ?? "").trim().toLowerCase();
  const defaultModel = input.modelConfig.default_model?.trim() || null;

  let assistantText = "";
  if (preferredModelProvider === "openrouter") {
    if (!openrouterApiKey) {
      throw new Error("Model provider is set to OpenRouter, but no OpenRouter API key is configured.");
    }
    assistantText = await callOpenAiCompatible({
      baseUrl: normalizeBaseUrl(readTrimmedEnv("OPENROUTER_BASE_URL"), "https://openrouter.ai/api/v1"),
      token: openrouterApiKey,
      model: resolveOpenAiModel(defaultModel),
      systemPrompt,
      messages: contextMessages,
      extraHeaders: {
        "HTTP-Referer": normalizeOriginUrl(readTrimmedEnv("APP_BASE_URL"), input.requestOrigin || "http://localhost:3000"),
        "X-Title": "OneClick Serverless Runtime",
      },
    });
  } else if (preferredModelProvider === "openai") {
    if (!openaiApiKey && !subsidyToken) {
      throw new Error("Model provider is set to OpenAI, but no OpenAI key or subsidy token is available.");
    }
    const baseUrl = subsidyToken
      ? `${input.requestOrigin}/api/subsidy/openai/${input.deploymentId}`
      : normalizeBaseUrl(readTrimmedEnv("OPENAI_BASE_URL") || readTrimmedEnv("OPENAI_API_BASE"), "https://api.openai.com/v1");
    assistantText = await callOpenAiCompatible({
      baseUrl,
      token: subsidyToken || openaiApiKey,
      model: resolveOpenAiModel(defaultModel),
      systemPrompt,
      messages: contextMessages,
    });
  } else if (preferredModelProvider === "anthropic") {
    if (!anthropicApiKey) {
      throw new Error("Model provider is set to Anthropic, but no Anthropic API key is configured.");
    }
    assistantText = await callAnthropic({
      token: anthropicApiKey,
      model: resolveAnthropicModel(defaultModel),
      systemPrompt,
      messages: contextMessages,
    });
  } else if (openrouterApiKey) {
    assistantText = await callOpenAiCompatible({
      baseUrl: normalizeBaseUrl(readTrimmedEnv("OPENROUTER_BASE_URL"), "https://openrouter.ai/api/v1"),
      token: openrouterApiKey,
      model: resolveOpenAiModel(defaultModel),
      systemPrompt,
      messages: contextMessages,
      extraHeaders: {
        "HTTP-Referer": normalizeOriginUrl(readTrimmedEnv("APP_BASE_URL"), input.requestOrigin || "http://localhost:3000"),
        "X-Title": "OneClick Serverless Runtime",
      },
    });
  } else if (openaiApiKey || subsidyToken) {
    const baseUrl = subsidyToken
      ? `${input.requestOrigin}/api/subsidy/openai/${input.deploymentId}`
      : normalizeBaseUrl(readTrimmedEnv("OPENAI_BASE_URL") || readTrimmedEnv("OPENAI_API_BASE"), "https://api.openai.com/v1");
    assistantText = await callOpenAiCompatible({
      baseUrl,
      token: subsidyToken || openaiApiKey,
      model: resolveOpenAiModel(defaultModel),
      systemPrompt,
      messages: contextMessages,
    });
  } else if (anthropicApiKey) {
    assistantText = await callAnthropic({
      token: anthropicApiKey,
      model: resolveAnthropicModel(defaultModel),
      systemPrompt,
      messages: contextMessages,
    });
  } else {
    throw new Error("No model API key found. Set OpenAI, OpenRouter, or Anthropic key in deployment settings.");
  }

  const assistantInsert = await pool.query<InsertedMessageRow>(
    `INSERT INTO runtime_chat_messages (deployment_id, session_id, role, content)
     VALUES ($1, $2, 'assistant', $3)
     RETURNING id, content, created_at`,
    [input.deploymentId, input.sessionId, assistantText],
  );
  const assistantMessage = assistantInsert.rows[0];
  await touchRuntimeSession({ deploymentId: input.deploymentId, sessionId: input.sessionId });

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
  };
}
