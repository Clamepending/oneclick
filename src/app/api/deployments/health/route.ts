import { NextResponse } from "next/server";
import { Queue } from "bullmq";
import { GetQueueAttributesCommand, SQSClient } from "@aws-sdk/client-sqs";
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

type QueueHealthConfig =
  | { provider: "redis"; usable: boolean; reason: string; endpoint: string }
  | { provider: "sqs"; usable: boolean; reason: string; endpoint: string; region: string };

function getQueueModeInfo(): QueueHealthConfig {
  const provider = readTrimmedEnv("DEPLOY_QUEUE_PROVIDER").toLowerCase() === "sqs" ? "sqs" : "redis";
  if (provider === "sqs") {
    const region = readTrimmedEnv("AWS_REGION");
    const queueUrl = readTrimmedEnv("SQS_DEPLOYMENT_QUEUE_URL");
    if (!region) return { provider, usable: false, reason: "missing_aws_region", endpoint: "", region: "" };
    if (!queueUrl) return { provider, usable: false, reason: "missing_sqs_queue_url", endpoint: "", region };
    return { provider, usable: true, reason: "ok", endpoint: queueUrl, region };
  }

  const redisUrl = readTrimmedEnv("REDIS_URL");
  if (!redisUrl) return { provider, usable: false, reason: "missing_redis_url", endpoint: "" };
  if (redisUrl.includes("127.0.0.1") || redisUrl.includes("localhost")) {
    return { provider, usable: false, reason: "localhost_redis_url", endpoint: redisUrl };
  }
  return { provider, usable: true, reason: "ok", endpoint: redisUrl };
}

function summarizeEndpoint(raw: string) {
  if (!raw) return "none";
  try {
    const url = new URL(raw);
    return `${url.protocol}//${url.hostname}${url.port ? `:${url.port}` : ""}`;
  } catch {
    return raw.slice(0, 80);
  }
}

function buildAwsConfig(region: string) {
  const accessKeyId = readTrimmedEnv("AWS_ACCESS_KEY_ID");
  const secretAccessKey = readTrimmedEnv("AWS_SECRET_ACCESS_KEY");
  const sessionToken = readTrimmedEnv("AWS_SESSION_TOKEN");
  if (!accessKeyId || !secretAccessKey) return { region };
  return {
    region,
    credentials: {
      accessKeyId,
      secretAccessKey,
      sessionToken: sessionToken || undefined,
    },
  };
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
    queueConfig: { provider: "redis" | "sqs"; usable: boolean; reason: string; endpoint: string; region?: string };
    queueReachability: { reachable: boolean; pingMs: number | null; error: string | null; details?: Record<string, unknown> | null };
    consumer: {
      mode: "redis-worker" | "lambda-sqs";
      heartbeat: {
        present: boolean;
        ageMs: number | null;
        stale: boolean | null;
        payload: Record<string, unknown> | null;
      } | null;
    };
  } = {
    ok: true,
    checkedAt: new Date(now).toISOString(),
    runtime: { provider: isVercelRuntime() ? "vercel" : "node" },
    queueConfig: {
      provider: queueInfo.provider,
      usable: queueInfo.usable,
      reason: queueInfo.reason,
      endpoint: summarizeEndpoint(queueInfo.endpoint),
      ...(queueInfo.provider === "sqs" ? { region: queueInfo.region } : {}),
    },
    queueReachability: { reachable: false, pingMs: null, error: null, details: null },
    consumer: {
      mode: queueInfo.provider === "sqs" ? "lambda-sqs" : "redis-worker",
      heartbeat:
        queueInfo.provider === "redis"
          ? { present: false, ageMs: null, stale: null, payload: null }
          : null,
    },
  };

  if (!queueInfo.usable) {
    return NextResponse.json(response);
  }

  if (queueInfo.provider === "sqs") {
    const client = new SQSClient(buildAwsConfig(queueInfo.region));
    try {
      const started = Date.now();
      const result = await client.send(
        new GetQueueAttributesCommand({
          QueueUrl: queueInfo.endpoint,
          AttributeNames: [
            "ApproximateNumberOfMessages",
            "ApproximateNumberOfMessagesNotVisible",
            "VisibilityTimeout",
          ],
        }),
      );
      response.queueReachability.reachable = true;
      response.queueReachability.pingMs = Date.now() - started;
      response.queueReachability.details = {
        approximateMessages: Number(result.Attributes?.ApproximateNumberOfMessages ?? "0"),
        approximateInFlight: Number(result.Attributes?.ApproximateNumberOfMessagesNotVisible ?? "0"),
        visibilityTimeout: Number(result.Attributes?.VisibilityTimeout ?? "0"),
      };
    } catch (error) {
      response.ok = false;
      response.queueReachability.error = error instanceof Error ? error.message : String(error);
    }
    return NextResponse.json(response, { status: response.ok ? 200 : 503 });
  }

  const queue = new Queue(queueName, { connection: { url: queueInfo.endpoint } });
  try {
    const client = await queue.client;
    const pingStarted = Date.now();
    await client.ping();
    response.queueReachability.reachable = true;
    response.queueReachability.pingMs = Date.now() - pingStarted;

    const rawHeartbeat = await client.get(workerHeartbeatKey);
    if (rawHeartbeat && response.consumer.heartbeat) {
      let payload: Record<string, unknown> | null = null;
      try {
        payload = JSON.parse(rawHeartbeat) as Record<string, unknown>;
      } catch {
        payload = { raw: rawHeartbeat };
      }
      const tsValue = typeof payload.ts === "string" ? payload.ts : null;
      const ts = tsValue ? new Date(tsValue).getTime() : NaN;
      const ageMs = Number.isFinite(ts) ? Math.max(0, Date.now() - ts) : null;
      response.consumer.heartbeat = {
        present: true,
        ageMs,
        stale: ageMs !== null ? ageMs > 120_000 : null,
        payload,
      };
    }
  } catch (error) {
    response.ok = false;
    response.queueReachability.error = error instanceof Error ? error.message : String(error);
  } finally {
    await queue.close().catch(() => {});
  }

  return NextResponse.json(response, { status: response.ok ? 200 : 503 });
}
