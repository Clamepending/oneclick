import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { ensureSchema, pool } from "@/lib/db";
import { listRuntimeEventLogs } from "@/lib/runtime/runtimeEventLog";
import { resolveServerlessBotId } from "@/lib/runtime/ottoauthAccounts";
import { requireOwnedServerlessDeployment } from "../../shared";

export const dynamic = "force-dynamic";

type RouteContext = {
  params: Promise<{
    id: string;
    segments?: string[];
  }>;
};

type DeploymentRow = {
  id: string;
  bot_name: string | null;
  runtime_bot_id: string | null;
  default_model: string | null;
  telegram_bot_token: string | null;
  status: string;
  deploy_provider: string | null;
  runtime_id: string | null;
  ready_url: string | null;
  updated_at: string;
  openai_api_key: string | null;
  anthropic_api_key: string | null;
  openrouter_api_key: string | null;
};

type AuthorizedContext = {
  deploymentId: string;
  userId: string;
  deployment: DeploymentRow;
};

type RuntimeEventPayload = Record<string, unknown>;

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toUnixSeconds(value: string | null | undefined) {
  if (!value) return 0;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return 0;
  return Math.floor(parsed / 1000);
}

function maskSecret(value: string | null | undefined) {
  const text = String(value ?? "").trim();
  if (!text) return "";
  if (text.length <= 8) return "*".repeat(text.length);
  return `${text.slice(0, 4)}...${text.slice(-4)}`;
}

function readString(input: Record<string, unknown>, key: string) {
  return String(input[key] ?? "").trim();
}

function readOptionalString(input: Record<string, unknown>, key: string) {
  const value = String(input[key] ?? "").trim();
  return value ? value : null;
}

function normalizeBotIdOrEmpty(raw: string | null | undefined) {
  const normalized = String(raw ?? "")
    .trim()
    .replace(/[^a-zA-Z0-9:_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized.slice(0, 120);
}

function normalizeSessionId(raw: string | null | undefined) {
  const normalized = String(raw ?? "").trim();
  if (!normalized) return "";
  return normalized.slice(0, 120);
}

function normalizeMarkdownFileName(raw: string) {
  const file = String(raw || "").trim();
  if (!/^[A-Za-z0-9_.-]{1,80}\.md$/.test(file)) return "";
  return file;
}

function buildSimpleBot(deployment: DeploymentRow) {
  const botId = resolveServerlessBotId({
    deploymentId: deployment.id,
    runtimeBotId: deployment.runtime_bot_id,
  });
  return {
    bot_id: botId,
    name: (deployment.bot_name ?? "").trim() || "OneClick Runtime",
    model: (deployment.default_model ?? "").trim() || "gpt-4o-mini",
    telegram_bot_token: maskSecret(deployment.telegram_bot_token),
    telegram_enabled: Boolean((deployment.telegram_bot_token ?? "").trim()),
    heartbeat_interval_s: 300,
    created_at: toUnixSeconds(deployment.updated_at),
    updated_at: toUnixSeconds(deployment.updated_at),
  };
}

function assertBotIdMatchesLockedBot(requestedBotId: string | null | undefined, lockedBotId: string) {
  const normalized = normalizeBotIdOrEmpty(requestedBotId);
  if (!normalized) return null;
  if (normalized !== lockedBotId) {
    return "bot_id is locked by server configuration";
  }
  return null;
}

async function readJsonBody(request: Request) {
  const parsed = await request.json().catch(() => null);
  if (!isObjectRecord(parsed)) return {} as Record<string, unknown>;
  return parsed;
}

function pickStringFromPayload(payload: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = String(payload[key] ?? "").trim();
    if (value) return value;
  }
  return "";
}

function pickToolTrace(payload: Record<string, unknown>) {
  const direct = payload.tool_trace;
  if (Array.isArray(direct)) return direct;
  const camel = payload.toolTrace;
  if (Array.isArray(camel)) return camel;
  return [];
}

async function authorizeRequest(context: RouteContext): Promise<AuthorizedContext | NextResponse> {
  const session = await auth();
  const userId = session?.user?.email?.trim();
  if (!userId) {
    return NextResponse.json({ status: "error", error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await context.params;
  await ensureSchema();

  const access = await requireOwnedServerlessDeployment({ deploymentId: id, userId });
  if (!access.ok) {
    return NextResponse.json({ status: "error", error: access.error }, { status: access.status });
  }

  const deploymentResult = await pool.query<DeploymentRow>(
    `SELECT id,
            bot_name,
            runtime_bot_id,
            default_model,
            telegram_bot_token,
            status,
            deploy_provider,
            runtime_id,
            ready_url,
            updated_at,
            openai_api_key,
            anthropic_api_key,
            openrouter_api_key
     FROM deployments
     WHERE id = $1
     LIMIT 1`,
    [id],
  );
  const deployment = deploymentResult.rows[0];
  if (!deployment) {
    return NextResponse.json({ status: "error", error: "Deployment not found" }, { status: 404 });
  }

  return { deploymentId: id, userId, deployment };
}

async function proxyRuntimeJson(input: {
  request: Request;
  deploymentId: string;
  path: string;
  method?: "GET" | "POST" | "PATCH" | "DELETE";
  body?: Record<string, unknown>;
}) {
  const target = new URL(input.path, new URL(input.request.url).origin);
  const headers = new Headers();
  const cookie = input.request.headers.get("cookie");
  if (cookie) headers.set("cookie", cookie);
  const authHeader = input.request.headers.get("authorization");
  if (authHeader) headers.set("authorization", authHeader);

  let body: string | undefined;
  if (input.body !== undefined) {
    headers.set("content-type", "application/json");
    body = JSON.stringify(input.body);
  }

  const response = await fetch(target.toString(), {
    method: input.method ?? "GET",
    headers,
    body,
    cache: "no-store",
  });

  const data = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  return { response, data: data ?? {} };
}

function mapToolsResponse(data: Record<string, unknown>) {
  const tools = Array.isArray(data.tools) ? data.tools : [];
  const config = isObjectRecord(data.config) ? data.config : {};
  const mcpToolsPolicy = isObjectRecord(config.mcpTools) ? config.mcpTools : {};

  const mcpTools = tools
    .filter((item) => isObjectRecord(item) && String(item.source ?? "") === "ottoauth-mcp")
    .map((item) => {
      const name = readString(item as Record<string, unknown>, "name");
      return {
        name,
        description: readString(item as Record<string, unknown>, "description"),
        enabled:
          name
            ? (mcpToolsPolicy[name] !== false && (item as Record<string, unknown>).available !== false)
            : false,
      };
    })
    .filter((tool) => Boolean(tool.name));

  return {
    status: "ok",
    shell_enabled: Boolean(config.shellEnabled),
    web_enabled: Boolean(config.webEnabled),
    mcp_enabled: Boolean(config.mcpEnabled),
    mcp_tools: mcpTools,
  };
}

function mapRuntimeEventToSimpleEvent(input: {
  item: Record<string, unknown>;
  botId: string;
}) {
  const payload = isObjectRecord(input.item.payload) ? (input.item.payload as RuntimeEventPayload) : {};
  const result = isObjectRecord(input.item.result) ? (input.item.result as RuntimeEventPayload) : {};
  const toolTrace = pickToolTrace(payload);
  const sessionId =
    String(input.item.sessionId ?? "").trim() ||
    pickStringFromPayload(payload, ["session_id", "sessionId"]);
  const assistantResponse =
    pickStringFromPayload(payload, ["assistant_response", "assistantResponse"]) ||
    pickStringFromPayload(result, ["assistant_response", "assistantResponse"]);

  return {
    id: Number(input.item.id ?? 0),
    received_at: toUnixSeconds(String(input.item.createdAt ?? "")),
    source: String(input.item.source ?? ""),
    event_type: String(input.item.eventType ?? ""),
    status: String(input.item.status ?? ""),
    bot_id: input.botId,
    session_id: sessionId || null,
    tool_trace: toolTrace,
    assistant_response: assistantResponse,
    payload,
    result,
    error: readOptionalString(input.item, "error"),
  };
}

async function handleGet(request: Request, context: RouteContext) {
  const authResult = await authorizeRequest(context);
  if (authResult instanceof NextResponse) return authResult;

  const params = await context.params;
  const segments = Array.isArray(params.segments) ? params.segments : [];
  const deploymentId = authResult.deploymentId;
  const deployment = authResult.deployment;
  const bot = buildSimpleBot(deployment);

  const query = new URL(request.url).searchParams;

  if (segments.length === 1 && segments[0] === "health") {
    return NextResponse.json({
      status: "ok",
      service_mode: "oneclick-serverless",
      bot_count: 1,
      bots: [bot],
      openai_api_key: maskSecret(deployment.openai_api_key),
      anthropic_api_key: maskSecret(deployment.anthropic_api_key),
      google_api_key: maskSecret(deployment.openrouter_api_key),
      fixed_bot_mode: {
        enabled: true,
        bot_id: bot.bot_id,
      },
      deployment_status: deployment.status,
      deploy_provider: deployment.deploy_provider,
      runtime_id: deployment.runtime_id,
      ready_url: deployment.ready_url,
      updated_at: deployment.updated_at,
    });
  }

  if (segments.length === 3 && segments[0] === "api" && segments[1] === "ui" && segments[2] === "config") {
    return NextResponse.json({
      status: "ok",
      ui_mode: "oneclick",
      fixed_bot_mode: {
        enabled: true,
        bot_id: bot.bot_id,
      },
      hide_bot_ui_default: true,
      hide_session_ui_default: false,
    });
  }

  if (segments.length === 2 && segments[0] === "api" && segments[1] === "bots") {
    return NextResponse.json({ status: "ok", bots: [bot] });
  }

  if (segments.length === 3 && segments[0] === "api" && segments[1] === "bots") {
    const requestedBotId = segments[2] || "";
    const botMismatch = assertBotIdMatchesLockedBot(requestedBotId, bot.bot_id);
    if (botMismatch) {
      return NextResponse.json({ status: "error", error: botMismatch }, { status: 400 });
    }
    return NextResponse.json({ status: "ok", bot });
  }

  if (segments.length === 4 && segments[0] === "api" && segments[1] === "bots" && segments[3] === "context") {
    const requestedBotId = segments[2] || "";
    const botMismatch = assertBotIdMatchesLockedBot(requestedBotId, bot.bot_id);
    if (botMismatch) {
      return NextResponse.json({ status: "error", error: botMismatch }, { status: 400 });
    }

    const runtimeMemory = await proxyRuntimeJson({
      request,
      deploymentId,
      path: `/api/runtime/${encodeURIComponent(deploymentId)}/memory`,
    });
    if (!runtimeMemory.response.ok) {
      return NextResponse.json(
        {
          status: "error",
          error: String(runtimeMemory.data.error ?? "failed to load context files"),
        },
        { status: runtimeMemory.response.status },
      );
    }

    const docs = Array.isArray(runtimeMemory.data.docs) ? runtimeMemory.data.docs : [];
    const files: Record<string, string> = {};
    for (const item of docs) {
      if (!isObjectRecord(item)) continue;
      const key = readString(item, "docKey");
      if (!key) continue;
      files[key] = readString(item, "content");
    }

    return NextResponse.json({
      status: "ok",
      bot_id: bot.bot_id,
      files,
    });
  }

  if (
    segments.length === 5 &&
    segments[0] === "api" &&
    segments[1] === "bots" &&
    segments[3] === "context"
  ) {
    const requestedBotId = segments[2] || "";
    const fileName = normalizeMarkdownFileName(segments[4] || "");
    const botMismatch = assertBotIdMatchesLockedBot(requestedBotId, bot.bot_id);
    if (botMismatch) {
      return NextResponse.json({ status: "error", error: botMismatch }, { status: 400 });
    }
    if (!fileName) {
      return NextResponse.json({ status: "error", error: "invalid context file name" }, { status: 400 });
    }

    const runtimeMemory = await proxyRuntimeJson({
      request,
      deploymentId,
      path: `/api/runtime/${encodeURIComponent(deploymentId)}/memory`,
    });
    if (!runtimeMemory.response.ok) {
      return NextResponse.json(
        {
          status: "error",
          error: String(runtimeMemory.data.error ?? "failed to load context file"),
        },
        { status: runtimeMemory.response.status },
      );
    }

    const docs = Array.isArray(runtimeMemory.data.docs) ? runtimeMemory.data.docs : [];
    const doc = docs.find((item) => isObjectRecord(item) && readString(item, "docKey") === fileName);

    return NextResponse.json({
      status: "ok",
      bot_id: bot.bot_id,
      file: fileName,
      content: isObjectRecord(doc) ? readString(doc, "content") : "",
    });
  }

  if (segments.length === 2 && segments[0] === "api" && segments[1] === "sessions") {
    const botMismatch = assertBotIdMatchesLockedBot(query.get("bot_id"), bot.bot_id);
    if (botMismatch) {
      return NextResponse.json({ status: "error", error: botMismatch }, { status: 400 });
    }

    const runtimeSessions = await proxyRuntimeJson({
      request,
      deploymentId,
      path: `/api/runtime/${encodeURIComponent(deploymentId)}/sessions`,
    });
    if (!runtimeSessions.response.ok) {
      return NextResponse.json(
        {
          status: "error",
          error: String(runtimeSessions.data.error ?? "failed to load sessions"),
        },
        { status: runtimeSessions.response.status },
      );
    }

    const sessions = (Array.isArray(runtimeSessions.data.sessions) ? runtimeSessions.data.sessions : [])
      .filter((item) => isObjectRecord(item))
      .map((item) => {
        const obj = item as Record<string, unknown>;
        return {
          session_id: readString(obj, "id"),
          message_count: Number(obj.messageCount ?? 0) || 0,
          last_ts: toUnixSeconds(String(obj.lastMessageAt ?? "")),
          updated_at: toUnixSeconds(String(obj.updatedAt ?? obj.createdAt ?? "")),
        };
      })
      .filter((item) => Boolean(item.session_id));

    return NextResponse.json({
      status: "ok",
      bot_id: bot.bot_id,
      sessions,
    });
  }

  if (segments.length === 3 && segments[0] === "api" && segments[1] === "sessions") {
    const botMismatch = assertBotIdMatchesLockedBot(query.get("bot_id"), bot.bot_id);
    if (botMismatch) {
      return NextResponse.json({ status: "error", error: botMismatch }, { status: 400 });
    }

    const sessionId = normalizeSessionId(segments[2] || "");
    if (!sessionId) {
      return NextResponse.json({ status: "error", error: "session_id is required" }, { status: 400 });
    }

    const runtimeMessages = await proxyRuntimeJson({
      request,
      deploymentId,
      path: `/api/runtime/${encodeURIComponent(deploymentId)}/messages?sessionId=${encodeURIComponent(sessionId)}`,
    });
    if (!runtimeMessages.response.ok && runtimeMessages.response.status !== 404) {
      return NextResponse.json(
        {
          status: "error",
          error: String(runtimeMessages.data.error ?? "failed to load session history"),
        },
        { status: runtimeMessages.response.status },
      );
    }

    const history =
      runtimeMessages.response.status === 404
        ? []
        : (Array.isArray(runtimeMessages.data.messages) ? runtimeMessages.data.messages : [])
      .filter((item) => isObjectRecord(item))
      .map((item) => {
        const obj = item as Record<string, unknown>;
        return {
          role: readString(obj, "role"),
          content: readString(obj, "content"),
          ts: toUnixSeconds(String(obj.createdAt ?? "")),
        };
      })
      .filter((item) => Boolean(item.content));

    return NextResponse.json({
      status: "ok",
      bot_id: bot.bot_id,
      session_id: sessionId,
      history,
    });
  }

  if (segments.length === 3 && segments[0] === "api" && segments[1] === "context" && segments[2] === "usage") {
    return NextResponse.json({ status: "error", error: "method not allowed" }, { status: 405 });
  }

  if (segments.length === 3 && segments[0] === "api" && segments[1] === "config" && segments[2] === "tools") {
    const runtimeTools = await proxyRuntimeJson({
      request,
      deploymentId,
      path: `/api/runtime/${encodeURIComponent(deploymentId)}/tools`,
    });
    if (!runtimeTools.response.ok) {
      return NextResponse.json(
        {
          status: "error",
          error: String(runtimeTools.data.error ?? "failed to load tools"),
        },
        { status: runtimeTools.response.status },
      );
    }
    return NextResponse.json(mapToolsResponse(runtimeTools.data));
  }

  if (segments.length === 3 && segments[0] === "api" && segments[1] === "events" && segments[2] === "stream") {
    const botMismatch = assertBotIdMatchesLockedBot(query.get("bot_id"), bot.bot_id);
    if (botMismatch) {
      return NextResponse.json({ status: "error", error: botMismatch }, { status: 400 });
    }

    const sessionFilter = normalizeSessionId(query.get("session_id"));
    const encoder = new TextEncoder();
    let closed = false;
    let lastSeenEventId = 0;

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode("retry: 1000\n\n"));

        const pump = async () => {
          if (closed) return;
          try {
            const rows = await listRuntimeEventLogs({ deploymentId, limit: 200 });
            const nextRows = rows
              .filter((row) => row.id > lastSeenEventId && row.event_type === "tool_call_progress")
              .sort((a, b) => a.id - b.id);

            for (const row of nextRows) {
              const payload = isObjectRecord(row.payload) ? (row.payload as RuntimeEventPayload) : {};
              const sessionId =
                (row.session_id ?? "").trim() ||
                pickStringFromPayload(payload, ["session_id", "sessionId"]);
              if (sessionFilter && sessionId !== sessionFilter) continue;
              const toolTrace = pickToolTrace(payload);
              if (!toolTrace.length) continue;

              const eventPayload = {
                id: row.id,
                received_at: toUnixSeconds(row.created_at),
                source: row.source,
                event_type: row.event_type,
                status: row.status,
                bot_id: bot.bot_id,
                session_id: sessionId || null,
                turn_id: pickStringFromPayload(payload, ["turn_id", "turnId"]),
                tool_trace: toolTrace,
              };
              controller.enqueue(
                encoder.encode(`event: tool_call_progress\\ndata: ${JSON.stringify(eventPayload)}\\n\\n`),
              );
            }

            if (nextRows.length) {
              lastSeenEventId = nextRows[nextRows.length - 1]?.id ?? lastSeenEventId;
            }
          } catch {
            controller.enqueue(encoder.encode("event: ping\\ndata: {}\\n\\n"));
          }
        };

        void pump();
        const pollTimer = setInterval(() => {
          void pump();
        }, 1200);
        const pingTimer = setInterval(() => {
          if (closed) return;
          controller.enqueue(encoder.encode("event: ping\\ndata: {}\\n\\n"));
        }, 15000);

        const cleanup = () => {
          if (closed) return;
          closed = true;
          clearInterval(pollTimer);
          clearInterval(pingTimer);
          try {
            controller.close();
          } catch {}
        };

        request.signal?.addEventListener?.("abort", cleanup);
      },
      cancel() {
        closed = true;
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      },
    });
  }

  if (segments.length === 2 && segments[0] === "api" && segments[1] === "events") {
    const botMismatch = assertBotIdMatchesLockedBot(query.get("bot_id"), bot.bot_id);
    if (botMismatch) {
      return NextResponse.json({ status: "error", error: botMismatch }, { status: 400 });
    }

    const limit = Math.max(1, Math.min(200, Number(query.get("limit") || "120") || 120));
    const runtimeEvents = await proxyRuntimeJson({
      request,
      deploymentId,
      path: `/api/runtime/${encodeURIComponent(deploymentId)}/events?limit=${limit}`,
    });
    if (!runtimeEvents.response.ok) {
      return NextResponse.json(
        {
          status: "error",
          error: String(runtimeEvents.data.error ?? "failed to load events"),
        },
        { status: runtimeEvents.response.status },
      );
    }

    const items = Array.isArray(runtimeEvents.data.items) ? runtimeEvents.data.items : [];
    const events = items
      .filter((item) => isObjectRecord(item))
      .map((item) => mapRuntimeEventToSimpleEvent({ item: item as Record<string, unknown>, botId: bot.bot_id }));

    const sessionsResp = await proxyRuntimeJson({
      request,
      deploymentId,
      path: `/api/runtime/${encodeURIComponent(deploymentId)}/sessions`,
    });
    const sessions = Array.isArray(sessionsResp.data.sessions) ? sessionsResp.data.sessions : [];
    const sessionIds = sessions
      .filter((item) => isObjectRecord(item))
      .map((item) => readString(item as Record<string, unknown>, "id"))
      .filter(Boolean);

    return NextResponse.json({
      status: "ok",
      events,
      last_forward: null,
      sessions: {
        bot_id: bot.bot_id,
        session_count: sessionIds.length,
        session_ids: sessionIds,
      },
    });
  }

  if (segments.length === 2 && segments[0] === "api" && segments[1] === "engagement") {
    const rows = await listRuntimeEventLogs({ deploymentId, limit: 200 });
    const totalEvents = rows.length;
    const failedEvents = rows.filter((row) => row.status === "failed" || row.status === "replay_failed").length;
    const successEvents = Math.max(0, totalEvents - failedEvents);
    const successRate = totalEvents > 0 ? (successEvents / totalEvents) * 100 : 0;

    return NextResponse.json({
      status: "ok",
      engagement: {
        window_days: 7,
        kpis: {
          active_agents_24h: totalEvents > 0 ? 1 : 0,
          retention_7d: {
            retained_agents: totalEvents > 0 ? 1 : 0,
            previous_active_agents: totalEvents > 0 ? 1 : 0,
          },
          retention_7d_pct: totalEvents > 0 ? 100 : 0,
          success_rate_window: {
            done_events: successEvents,
            terminal_events: totalEvents,
          },
          success_rate_window_pct: successRate,
          engagement_rate_window: {
            engaged_agents: totalEvents > 0 ? 1 : 0,
            active_agents_window: totalEvents > 0 ? 1 : 0,
          },
          engagement_rate_window_pct: totalEvents > 0 ? 100 : 0,
        },
        bots: [
          {
            bot_id: bot.bot_id,
            bot_name: bot.name,
            events_count: totalEvents,
          },
        ],
      },
    });
  }

  return NextResponse.json({ status: "error", error: "Not found" }, { status: 404 });
}

async function handlePost(request: Request, context: RouteContext) {
  const authResult = await authorizeRequest(context);
  if (authResult instanceof NextResponse) return authResult;

  const params = await context.params;
  const segments = Array.isArray(params.segments) ? params.segments : [];
  const deploymentId = authResult.deploymentId;
  const deployment = authResult.deployment;
  const bot = buildSimpleBot(deployment);

  if (segments.length === 2 && segments[0] === "api" && segments[1] === "bots") {
    return NextResponse.json(
      { status: "error", error: "bot creation is disabled for this deployment" },
      { status: 403 },
    );
  }

  if (segments.length === 4 && segments[0] === "api" && segments[1] === "bots" && segments[3] === "config") {
    const requestedBotId = segments[2] || "";
    const botMismatch = assertBotIdMatchesLockedBot(requestedBotId, bot.bot_id);
    if (botMismatch) {
      return NextResponse.json({ status: "error", error: botMismatch }, { status: 400 });
    }

    const body = await readJsonBody(request);
    const name = readOptionalString(body, "name");
    const model = readOptionalString(body, "model");
    const telegramBotToken = readOptionalString(body, "telegram_bot_token");

    if (name) {
      await pool.query(
        `UPDATE deployments
         SET bot_name = $2,
             updated_at = NOW()
         WHERE id = $1`,
        [deploymentId, name],
      );
    }

    const settingsPayload: Record<string, unknown> = {};
    if (model) settingsPayload.defaultModel = model;
    if (telegramBotToken) settingsPayload.telegramBotToken = telegramBotToken;

    if (Object.keys(settingsPayload).length > 0) {
      const runtimeSettings = await proxyRuntimeJson({
        request,
        deploymentId,
        path: `/api/deployments/${encodeURIComponent(deploymentId)}/settings`,
        method: "POST",
        body: settingsPayload,
      });
      if (!runtimeSettings.response.ok) {
        return NextResponse.json(
          {
            status: "error",
            error: String(runtimeSettings.data.error ?? "failed to update bot config"),
          },
          { status: runtimeSettings.response.status },
        );
      }
    }

    const refreshed = await pool.query<DeploymentRow>(
      `SELECT id,
              bot_name,
              runtime_bot_id,
              default_model,
              telegram_bot_token,
              status,
              deploy_provider,
              runtime_id,
              ready_url,
              updated_at,
              openai_api_key,
              anthropic_api_key,
              openrouter_api_key
       FROM deployments
       WHERE id = $1
       LIMIT 1`,
      [deploymentId],
    );
    const refreshedBot = buildSimpleBot(refreshed.rows[0] ?? deployment);

    return NextResponse.json({ status: "ok", bot: refreshedBot });
  }

  if (
    segments.length === 5 &&
    segments[0] === "api" &&
    segments[1] === "bots" &&
    segments[3] === "context"
  ) {
    const requestedBotId = segments[2] || "";
    const fileName = normalizeMarkdownFileName(segments[4] || "");
    const botMismatch = assertBotIdMatchesLockedBot(requestedBotId, bot.bot_id);
    if (botMismatch) {
      return NextResponse.json({ status: "error", error: botMismatch }, { status: 400 });
    }
    if (!fileName) {
      return NextResponse.json({ status: "error", error: "invalid context file name" }, { status: 400 });
    }

    const body = await readJsonBody(request);
    const content = readString(body, "content");

    const patch = await proxyRuntimeJson({
      request,
      deploymentId,
      path: `/api/runtime/${encodeURIComponent(deploymentId)}/memory`,
      method: "PATCH",
      body: {
        docKey: fileName,
        content,
      },
    });

    if (!patch.response.ok) {
      return NextResponse.json(
        {
          status: "error",
          error: String(patch.data.error ?? "failed to update context file"),
        },
        { status: patch.response.status },
      );
    }

    return NextResponse.json({
      status: "ok",
      bot_id: bot.bot_id,
      file: fileName,
      content,
    });
  }

  if (segments.length === 3 && segments[0] === "api" && segments[1] === "context" && segments[2] === "usage") {
    const body = await readJsonBody(request);
    const botMismatch = assertBotIdMatchesLockedBot(readOptionalString(body, "bot_id"), bot.bot_id);
    if (botMismatch) {
      return NextResponse.json({ status: "error", error: botMismatch }, { status: 400 });
    }

    const sessionId = normalizeSessionId(readOptionalString(body, "session_id")) || "default";
    const draftMessage = readString(body, "draft_message");
    const model = readOptionalString(body, "model");

    const runtimeUsage = await proxyRuntimeJson({
      request,
      deploymentId,
      path: `/api/runtime/${encodeURIComponent(deploymentId)}/context/usage`,
      method: "POST",
      body: {
        sessionId,
        draftMessage,
        model: model ?? undefined,
      },
    });
    if (!runtimeUsage.response.ok) {
      return NextResponse.json(
        {
          status: "error",
          error: String(runtimeUsage.data.error ?? "failed to compute context usage"),
        },
        { status: runtimeUsage.response.status },
      );
    }

    return NextResponse.json({
      status: "ok",
      estimated: Boolean(runtimeUsage.data.estimated),
      bot_id: bot.bot_id,
      session_id: String(runtimeUsage.data.sessionId ?? sessionId),
      model: String(runtimeUsage.data.model ?? model ?? bot.model),
      current_tokens: Number(runtimeUsage.data.currentTokens ?? 0) || 0,
      max_tokens: Number(runtimeUsage.data.maxTokens ?? 0) || 0,
      remaining_tokens: Number(runtimeUsage.data.remainingTokens ?? 0) || 0,
      usage_ratio: Number(runtimeUsage.data.usageRatio ?? 0) || 0,
    });
  }

  if (segments.length === 3 && segments[0] === "api" && segments[1] === "config" && segments[2] === "tools") {
    const body = await readJsonBody(request);
    const toolMap = isObjectRecord(body.mcp_tools) ? body.mcp_tools : {};

    const runtimeTools = await proxyRuntimeJson({
      request,
      deploymentId,
      path: `/api/runtime/${encodeURIComponent(deploymentId)}/tools`,
      method: "POST",
      body: {
        shellEnabled: body.shell_enabled === undefined ? undefined : Boolean(body.shell_enabled),
        webEnabled: body.web_enabled === undefined ? undefined : Boolean(body.web_enabled),
        mcpEnabled: body.mcp_enabled === undefined ? undefined : Boolean(body.mcp_enabled),
        mcpTools: Object.keys(toolMap).length ? Object.fromEntries(
          Object.entries(toolMap).map(([name, enabled]) => [name, Boolean(enabled)]),
        ) : undefined,
      },
    });

    if (!runtimeTools.response.ok) {
      return NextResponse.json(
        {
          status: "error",
          error: String(runtimeTools.data.error ?? "failed to update tool settings"),
        },
        { status: runtimeTools.response.status },
      );
    }

    return NextResponse.json(mapToolsResponse(runtimeTools.data));
  }

  if (segments.length === 3 && segments[0] === "api" && segments[1] === "config" && segments[2] === "settings") {
    const body = await readJsonBody(request);

    const settingsPayload: Record<string, unknown> = {};
    const openaiKey = readOptionalString(body, "openai_api_key");
    const anthropicKey = readOptionalString(body, "anthropic_api_key");
    const googleLikeKey = readOptionalString(body, "google_api_key") || readOptionalString(body, "openrouter_api_key");
    const telegramBotToken = readOptionalString(body, "telegram_bot_token");

    if (openaiKey) settingsPayload.openaiApiKey = openaiKey;
    if (anthropicKey) settingsPayload.anthropicApiKey = anthropicKey;
    if (googleLikeKey) settingsPayload.openrouterApiKey = googleLikeKey;
    if (telegramBotToken) settingsPayload.telegramBotToken = telegramBotToken;

    if (!Object.keys(settingsPayload).length) {
      return NextResponse.json({ status: "error", error: "At least one setting is required" }, { status: 400 });
    }

    const runtimeSettings = await proxyRuntimeJson({
      request,
      deploymentId,
      path: `/api/deployments/${encodeURIComponent(deploymentId)}/settings`,
      method: "POST",
      body: settingsPayload,
    });
    if (!runtimeSettings.response.ok) {
      return NextResponse.json(
        {
          status: "error",
          error: String(runtimeSettings.data.error ?? "failed to update settings"),
        },
        { status: runtimeSettings.response.status },
      );
    }

    const refreshed = await pool.query<DeploymentRow>(
      `SELECT id,
              bot_name,
              runtime_bot_id,
              default_model,
              telegram_bot_token,
              status,
              deploy_provider,
              runtime_id,
              ready_url,
              updated_at,
              openai_api_key,
              anthropic_api_key,
              openrouter_api_key
       FROM deployments
       WHERE id = $1
       LIMIT 1`,
      [deploymentId],
    );
    const row = refreshed.rows[0] ?? deployment;

    return NextResponse.json({
      status: "ok",
      openai_api_key: maskSecret(row.openai_api_key),
      anthropic_api_key: maskSecret(row.anthropic_api_key),
      google_api_key: maskSecret(row.openrouter_api_key),
      message: "Settings updated",
    });
  }

  if (segments.length === 2 && segments[0] === "api" && segments[1] === "chat") {
    const body = await readJsonBody(request);
    const botMismatch = assertBotIdMatchesLockedBot(readOptionalString(body, "bot_id"), bot.bot_id);
    if (botMismatch) {
      return NextResponse.json({ status: "error", error: botMismatch }, { status: 400 });
    }

    const message = readString(body, "message");
    if (!message) {
      return NextResponse.json({ status: "error", error: "message is required", bot_id: bot.bot_id }, { status: 400 });
    }

    const sessionId = normalizeSessionId(readOptionalString(body, "session_id")) || "default";
    const model = readOptionalString(body, "model") || bot.model;

    const runtimeChat = await proxyRuntimeJson({
      request,
      deploymentId,
      path: `/api/runtime/${encodeURIComponent(deploymentId)}/chat`,
      method: "POST",
      body: {
        message,
        sessionId,
      },
    });

    if (!runtimeChat.response.ok) {
      return NextResponse.json(
        {
          status: "error",
          error: String(runtimeChat.data.error ?? "chat request failed"),
          bot_id: bot.bot_id,
          session_id: sessionId,
        },
        { status: runtimeChat.response.status },
      );
    }

    const assistantMessage = isObjectRecord(runtimeChat.data.assistantMessage)
      ? (runtimeChat.data.assistantMessage as Record<string, unknown>)
      : {};

    return NextResponse.json({
      status: "ok",
      bot_id: bot.bot_id,
      session_id: String(runtimeChat.data.sessionId ?? sessionId),
      turn_id: readOptionalString(runtimeChat.data, "turnId"),
      model,
      response: readString(assistantMessage, "content"),
      tool_trace: Array.isArray(runtimeChat.data.toolTrace) ? runtimeChat.data.toolTrace : [],
      forwarded: false,
      forward_result: { ok: false, message: "forwarding is managed by oneclick runtime" },
    });
  }

  return NextResponse.json({ status: "error", error: "Not found" }, { status: 404 });
}

async function handleDelete(request: Request, context: RouteContext) {
  const authResult = await authorizeRequest(context);
  if (authResult instanceof NextResponse) return authResult;

  const params = await context.params;
  const segments = Array.isArray(params.segments) ? params.segments : [];
  const deploymentId = authResult.deploymentId;
  const bot = buildSimpleBot(authResult.deployment);
  const query = new URL(request.url).searchParams;

  if (segments.length === 3 && segments[0] === "api" && segments[1] === "sessions") {
    const botMismatch = assertBotIdMatchesLockedBot(query.get("bot_id"), bot.bot_id);
    if (botMismatch) {
      return NextResponse.json({ status: "error", error: botMismatch }, { status: 400 });
    }

    const sessionId = normalizeSessionId(segments[2] || "");
    if (!sessionId) {
      return NextResponse.json({ status: "error", error: "session_id is required" }, { status: 400 });
    }

    const runtimeDelete = await proxyRuntimeJson({
      request,
      deploymentId,
      path: `/api/runtime/${encodeURIComponent(deploymentId)}/messages?sessionId=${encodeURIComponent(sessionId)}`,
      method: "DELETE",
    });

    if (!runtimeDelete.response.ok && runtimeDelete.response.status !== 404) {
      return NextResponse.json(
        {
          status: "error",
          error: String(runtimeDelete.data.error ?? "failed to delete session"),
        },
        { status: runtimeDelete.response.status },
      );
    }

    return NextResponse.json({
      status: "ok",
      bot_id: bot.bot_id,
      session_id: sessionId,
      deleted_messages:
        runtimeDelete.response.status === 404
          ? 0
          : (Number(runtimeDelete.data.deletedCount ?? 0) || 0),
    });
  }

  return NextResponse.json({ status: "error", error: "Not found" }, { status: 404 });
}

export async function GET(request: Request, context: RouteContext) {
  return handleGet(request, context);
}

export async function POST(request: Request, context: RouteContext) {
  return handlePost(request, context);
}

export async function DELETE(request: Request, context: RouteContext) {
  return handleDelete(request, context);
}
