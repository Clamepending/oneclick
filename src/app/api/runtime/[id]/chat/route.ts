import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { ensureSchema, pool } from "@/lib/db";

const payloadSchema = z.object({
  message: z.string().trim().min(1).max(8000),
});

type DeploymentRow = {
  id: string;
  status: string;
  deploy_provider: string | null;
  model_provider: string | null;
  openai_api_key: string | null;
  anthropic_api_key: string | null;
  openrouter_api_key: string | null;
  subsidy_proxy_token: string | null;
};

type StoredMessage = {
  role: "user" | "assistant";
  content: string;
};

type InsertedMessageRow = {
  id: number;
  content: string;
  created_at: string;
};

function readTrimmedEnv(name: string) {
  const raw = process.env[name];
  if (!raw) return "";
  return raw.trim().replace(/^"(.*)"$/, "$1").replace(/\\n/g, "").trim();
}

function resolveSystemPrompt() {
  return readTrimmedEnv("SIMPLE_AGENT_MICROSERVICES_SYSTEM_PROMPT") || "You are a concise, helpful assistant.";
}

function resolveOpenAiModel() {
  return readTrimmedEnv("SIMPLE_AGENT_MODEL") || "gpt-4o-mini";
}

function resolveAnthropicModel() {
  return readTrimmedEnv("ANTHROPIC_MODEL") || "claude-3-5-haiku-latest";
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

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  const userId = session?.user?.email?.trim();
  if (!userId) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  const parsedBody = payloadSchema.safeParse(await request.json().catch(() => null));
  if (!parsedBody.success) {
    return NextResponse.json({ ok: false, error: "Invalid payload" }, { status: 400 });
  }

  const { id } = await context.params;
  await ensureSchema();

  const deployment = await pool.query<DeploymentRow>(
    `SELECT id,
            status,
            deploy_provider,
            model_provider,
            openai_api_key,
            anthropic_api_key,
            openrouter_api_key,
            subsidy_proxy_token
     FROM deployments
     WHERE id = $1
       AND user_id = $2
     LIMIT 1`,
    [id, userId],
  );
  const row = deployment.rows[0];
  if (!row) {
    return NextResponse.json({ ok: false, error: "Deployment not found" }, { status: 404 });
  }
  if ((row.deploy_provider ?? "").trim().toLowerCase() !== "lambda") {
    return NextResponse.json({ ok: false, error: "Runtime is not serverless." }, { status: 400 });
  }
  if ((row.status ?? "").trim().toLowerCase() !== "ready") {
    return NextResponse.json({ ok: false, error: "Deployment is not ready yet." }, { status: 409 });
  }

  const userInsert = await pool.query<InsertedMessageRow>(
    `INSERT INTO runtime_chat_messages (deployment_id, role, content)
     VALUES ($1, 'user', $2)
     RETURNING id, content, created_at`,
    [id, parsedBody.data.message.trim()],
  );
  const userMessage = userInsert.rows[0];

  const history = await pool.query<{ role: string; content: string }>(
    `SELECT role, content
     FROM runtime_chat_messages
     WHERE deployment_id = $1
       AND role IN ('user', 'assistant')
     ORDER BY id DESC
     LIMIT 24`,
    [id],
  );
  const contextMessages: StoredMessage[] = history.rows
    .reverse()
    .map((item) => ({ role: item.role as "user" | "assistant", content: item.content }));

  const systemPrompt = resolveSystemPrompt();
  const openaiApiKey = row.openai_api_key?.trim() || "";
  const openrouterApiKey = row.openrouter_api_key?.trim() || "";
  const anthropicApiKey = row.anthropic_api_key?.trim() || "";
  const subsidyToken = row.subsidy_proxy_token?.trim() || "";
  const preferredModelProvider = (row.model_provider ?? "").trim().toLowerCase();

  let assistantText = "";
  try {
    if (preferredModelProvider === "openrouter") {
      if (!openrouterApiKey) {
        throw new Error("Model provider is set to OpenRouter, but no OpenRouter API key is configured.");
      }
      assistantText = await callOpenAiCompatible({
        baseUrl: normalizeBaseUrl(readTrimmedEnv("OPENROUTER_BASE_URL"), "https://openrouter.ai/api/v1"),
        token: openrouterApiKey,
        model: resolveOpenAiModel(),
        systemPrompt,
        messages: contextMessages,
        extraHeaders: {
          "HTTP-Referer": normalizeOriginUrl(readTrimmedEnv("APP_BASE_URL"), "http://localhost:3000"),
          "X-Title": "OneClick Serverless Runtime",
        },
      });
    } else if (preferredModelProvider === "openai") {
      if (!openaiApiKey && !subsidyToken) {
        throw new Error("Model provider is set to OpenAI, but no OpenAI key or subsidy token is available.");
      }
      const origin = new URL(request.url).origin;
      const baseUrl = subsidyToken
        ? `${origin}/api/subsidy/openai/${id}/v1`
        : normalizeBaseUrl(readTrimmedEnv("OPENAI_BASE_URL") || readTrimmedEnv("OPENAI_API_BASE"), "https://api.openai.com/v1");
      assistantText = await callOpenAiCompatible({
        baseUrl,
        token: subsidyToken || openaiApiKey,
        model: resolveOpenAiModel(),
        systemPrompt,
        messages: contextMessages,
      });
    } else if (preferredModelProvider === "anthropic") {
      if (!anthropicApiKey) {
        throw new Error("Model provider is set to Anthropic, but no Anthropic API key is configured.");
      }
      assistantText = await callAnthropic({
        token: anthropicApiKey,
        model: resolveAnthropicModel(),
        systemPrompt,
        messages: contextMessages,
      });
    } else if (openrouterApiKey) {
      assistantText = await callOpenAiCompatible({
        baseUrl: normalizeBaseUrl(readTrimmedEnv("OPENROUTER_BASE_URL"), "https://openrouter.ai/api/v1"),
        token: openrouterApiKey,
        model: resolveOpenAiModel(),
        systemPrompt,
        messages: contextMessages,
        extraHeaders: {
          "HTTP-Referer": normalizeOriginUrl(readTrimmedEnv("APP_BASE_URL"), "http://localhost:3000"),
          "X-Title": "OneClick Serverless Runtime",
        },
      });
    } else if (openaiApiKey || subsidyToken) {
      const origin = new URL(request.url).origin;
      const baseUrl = subsidyToken
        ? `${origin}/api/subsidy/openai/${id}`
        : normalizeBaseUrl(readTrimmedEnv("OPENAI_BASE_URL") || readTrimmedEnv("OPENAI_API_BASE"), "https://api.openai.com/v1");
      assistantText = await callOpenAiCompatible({
        baseUrl,
        token: subsidyToken || openaiApiKey,
        model: resolveOpenAiModel(),
        systemPrompt,
        messages: contextMessages,
      });
    } else if (anthropicApiKey) {
      assistantText = await callAnthropic({
        token: anthropicApiKey,
        model: resolveAnthropicModel(),
        systemPrompt,
        messages: contextMessages,
      });
    } else {
      throw new Error("No model API key found. Set OpenAI, OpenRouter, or Anthropic key in deployment settings.");
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Model call failed.";
    return NextResponse.json({ ok: false, error: message }, { status: 502 });
  }

  const assistantInsert = await pool.query<InsertedMessageRow>(
    `INSERT INTO runtime_chat_messages (deployment_id, role, content)
     VALUES ($1, 'assistant', $2)
     RETURNING id, content, created_at`,
    [id, assistantText],
  );
  const assistantMessage = assistantInsert.rows[0];

  return NextResponse.json({
    ok: true,
    userMessage: {
      id: userMessage.id,
      role: "user",
      content: userMessage.content,
      createdAt: userMessage.created_at,
    },
    assistantMessage: {
      id: assistantMessage.id,
      role: "assistant",
      content: assistantMessage.content,
      createdAt: assistantMessage.created_at,
    },
  });
}
