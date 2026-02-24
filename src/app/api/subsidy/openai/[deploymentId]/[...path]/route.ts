import { NextResponse } from "next/server";
import { ensureSchema, pool } from "@/lib/db";
import { applyMemoryRateLimit } from "@/lib/security/rateLimit";

const OPENAI_API_BASE = "https://api.openai.com/v1";
const SUBSIDY_LIMIT_PER_MIN = Number(process.env.SUBSIDY_RATE_LIMIT_PER_MIN ?? "50");

function readBearerToken(request: Request) {
  const authHeader = request.headers.get("authorization")?.trim() ?? "";
  if (!authHeader.toLowerCase().startsWith("bearer ")) return null;
  return authHeader.slice("bearer ".length).trim() || null;
}

async function proxyToOpenAi(
  request: Request,
  context: { params: Promise<{ deploymentId: string; path: string[] }> },
) {
  const subsidyApiKey = process.env.OPENAI_SUBSIDY_API_KEY?.trim() || "";
  if (!subsidyApiKey) {
    return NextResponse.json(
      { ok: false, error: "OPENAI_SUBSIDY_API_KEY is not configured." },
      { status: 503 },
    );
  }

  const { deploymentId, path } = await context.params;
  const requestedToken = readBearerToken(request);
  if (!requestedToken) {
    return NextResponse.json({ ok: false, error: "Missing subsidy token." }, { status: 401 });
  }

  await ensureSchema();
  const deployment = await pool.query<{ id: string }>(
    `SELECT id
     FROM deployments
     WHERE id = $1
       AND status = 'ready'
       AND subsidy_proxy_token = $2
     LIMIT 1`,
    [deploymentId, requestedToken],
  );
  if (!deployment.rows[0]) {
    return NextResponse.json({ ok: false, error: "Invalid subsidy token." }, { status: 403 });
  }

  const rateLimit = applyMemoryRateLimit(
    `subsidy:deployment:${deploymentId}`,
    SUBSIDY_LIMIT_PER_MIN,
    60_000,
  );
  if (!rateLimit.allowed) {
    return NextResponse.json(
      { ok: false, error: "Subsidy rate limit exceeded (50 requests per minute)." },
      { status: 429, headers: { "Retry-After": "60" } },
    );
  }

  const targetPath = path.join("/");
  const targetUrl = `${OPENAI_API_BASE}/${targetPath}`;
  const upstreamHeaders = new Headers();
  const contentType = request.headers.get("content-type");
  if (contentType) upstreamHeaders.set("content-type", contentType);
  upstreamHeaders.set("authorization", `Bearer ${subsidyApiKey}`);

  const method = request.method.toUpperCase();
  const body =
    method === "GET" || method === "HEAD"
      ? undefined
      : new Uint8Array(await request.arrayBuffer());

  const upstream = await fetch(targetUrl, {
    method,
    headers: upstreamHeaders,
    body,
  });
  const responseBody = await upstream.arrayBuffer();
  const responseHeaders = new Headers();
  const upstreamType = upstream.headers.get("content-type");
  if (upstreamType) responseHeaders.set("content-type", upstreamType);

  return new Response(responseBody, {
    status: upstream.status,
    headers: responseHeaders,
  });
}

export async function GET(
  request: Request,
  context: { params: Promise<{ deploymentId: string; path: string[] }> },
) {
  return proxyToOpenAi(request, context);
}

export async function POST(
  request: Request,
  context: { params: Promise<{ deploymentId: string; path: string[] }> },
) {
  return proxyToOpenAi(request, context);
}

export async function PUT(
  request: Request,
  context: { params: Promise<{ deploymentId: string; path: string[] }> },
) {
  return proxyToOpenAi(request, context);
}

export async function PATCH(
  request: Request,
  context: { params: Promise<{ deploymentId: string; path: string[] }> },
) {
  return proxyToOpenAi(request, context);
}

export async function DELETE(
  request: Request,
  context: { params: Promise<{ deploymentId: string; path: string[] }> },
) {
  return proxyToOpenAi(request, context);
}
