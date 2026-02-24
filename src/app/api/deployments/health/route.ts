import { NextResponse } from "next/server";
import { Queue } from "bullmq";
import { auth } from "@/lib/auth";

const queueName = "deployment-jobs";
const workerHeartbeatKey = "oneclick:deploy-worker:heartbeat";

function readTrimmedEnv(name: string) {
  const raw = process.env[name];
  if (!raw) return "";
  return raw.trim().replace(/^"(.*)"$/, "$1").replace(/\\n/g, "").trim();
}

function readBoolEnv(name: string, fallback = false) {
  const value = readTrimmedEnv(name).toLowerCase();
  if (!value) return fallback;
  if (["1", "true", "yes", "on"].includes(value)) return true;
  if (["0", "false", "no", "off"].includes(value)) return false;
  return fallback;
}

function isVercelRuntime() {
  return readBoolEnv("VERCEL", false) || readTrimmedEnv("VERCEL_ENV") !== "";
}

function getQueueModeInfo() {
  const redisUrl = readTrimmedEnv("REDIS_URL");
  if (!redisUrl) return { usable: false, redisUrl: "", reason: "missing_redis_url" as const };
  if (redisUrl.includes("127.0.0.1") || redisUrl.includes("localhost")) {
    return { usable: false, redisUrl, reason: "localhost_redis_url" as const };
  }
  return { usable: true, redisUrl, reason: "ok" as const };
}

function summarizeRedisUrl(raw: string) {
  if (!raw) return "none";
  try {
    const url = new URL(raw);
    return `${url.protocol}//${url.hostname}${url.port ? `:${url.port}` : ""}`;
  } catch {
    return raw.slice(0, 40);
  }
}

export async function GET() {
  const session = await auth();
  if (!session?.user?.email) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  const queueInfo = getQueueModeInfo();
  const now = Date.now();
  const response: {
    ok: boolean;
    checkedAt: string;
    runtime: { provider: "vercel" | "node" };
    queueConfig: { usable: boolean; reason: string; redis: string };
    redis: { reachable: boolean; pingMs: number | null; error: string | null };
    workerHeartbeat: {
      present: boolean;
      ageMs: number | null;
      stale: boolean | null;
      payload: Record<string, unknown> | null;
    };
  } = {
    ok: true,
    checkedAt: new Date(now).toISOString(),
    runtime: { provider: isVercelRuntime() ? "vercel" : "node" },
    queueConfig: {
      usable: queueInfo.usable,
      reason: queueInfo.reason,
      redis: summarizeRedisUrl(queueInfo.redisUrl),
    },
    redis: { reachable: false, pingMs: null, error: null },
    workerHeartbeat: { present: false, ageMs: null, stale: null, payload: null },
  };

  if (!queueInfo.usable) {
    return NextResponse.json(response);
  }

  const queue = new Queue(queueName, { connection: { url: queueInfo.redisUrl } });
  try {
    const client = await queue.client;
    const pingStarted = Date.now();
    await client.ping();
    response.redis.reachable = true;
    response.redis.pingMs = Date.now() - pingStarted;

    const rawHeartbeat = await client.get(workerHeartbeatKey);
    if (rawHeartbeat) {
      let payload: Record<string, unknown> | null = null;
      try {
        payload = JSON.parse(rawHeartbeat) as Record<string, unknown>;
      } catch {
        payload = { raw: rawHeartbeat };
      }
      const tsValue = typeof payload.ts === "string" ? payload.ts : null;
      const ts = tsValue ? new Date(tsValue).getTime() : NaN;
      const ageMs = Number.isFinite(ts) ? Math.max(0, Date.now() - ts) : null;
      response.workerHeartbeat = {
        present: true,
        ageMs,
        stale: ageMs !== null ? ageMs > 120_000 : null,
        payload,
      };
    }
  } catch (error) {
    response.ok = false;
    response.redis.error = error instanceof Error ? error.message : String(error);
  } finally {
    await queue.close().catch(() => {});
  }

  return NextResponse.json(response, { status: response.ok ? 200 : 503 });
}
