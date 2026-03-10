import { DescribeTasksCommand, ECSClient, ListTasksCommand } from "@aws-sdk/client-ecs";
import { DescribeNetworkInterfacesCommand, EC2Client } from "@aws-sdk/client-ec2";
import net from "node:net";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { ensureSchema, pool } from "@/lib/db";
import { getRuntimePort } from "@/lib/provisioner/openclawBundle";
import { probeRuntimeHttp } from "@/lib/runtimeHealth";
import { normalizeDeploymentFlavor } from "@/lib/plans";
import { ServerlessRuntimeClient } from "@/components/runtime/ServerlessRuntimeClient";

export const dynamic = "force-dynamic";

function readTrimmedEnv(name: string) {
  const raw = process.env[name];
  if (!raw) return "";
  return raw.trim().replace(/^"(.*)"$/, "$1").replace(/\\n/g, "").trim();
}

function parseEcsRuntimeId(runtimeId: string | null) {
  if (!runtimeId || !runtimeId.startsWith("ecs:")) return null;
  const body = runtimeId.slice(4);
  const [cluster, serviceName] = body.split("|");
  if (!cluster || !serviceName) return null;
  return { cluster, serviceName };
}

async function probeTcpPort(host: string, port: number) {
  await new Promise<void>((resolve, reject) => {
    const socket = net.createConnection({ host, port, timeout: 2000 }, () => {
      socket.end();
      resolve();
    });
    socket.on("timeout", () => {
      socket.destroy();
      reject(new Error("timeout"));
    });
    socket.on("error", (error) => {
      socket.destroy();
      reject(error);
    });
  });
}

async function resolveEcsPublicUrl(input: { runtimeId: string; deploymentId: string; runtimePort: number }) {
  const parsed = parseEcsRuntimeId(input.runtimeId);
  if (!parsed) return null;
  const region = readTrimmedEnv("AWS_REGION");
  if (!region) return null;

  const ecs = new ECSClient({
    region,
    credentials:
      readTrimmedEnv("AWS_ACCESS_KEY_ID") && readTrimmedEnv("AWS_SECRET_ACCESS_KEY")
        ? {
            accessKeyId: readTrimmedEnv("AWS_ACCESS_KEY_ID"),
            secretAccessKey: readTrimmedEnv("AWS_SECRET_ACCESS_KEY"),
          }
        : undefined,
  });
  const ec2 = new EC2Client({
    region,
    credentials:
      readTrimmedEnv("AWS_ACCESS_KEY_ID") && readTrimmedEnv("AWS_SECRET_ACCESS_KEY")
        ? {
            accessKeyId: readTrimmedEnv("AWS_ACCESS_KEY_ID"),
            secretAccessKey: readTrimmedEnv("AWS_SECRET_ACCESS_KEY"),
          }
        : undefined,
  });

  const tasks = await ecs.send(
    new ListTasksCommand({
      cluster: parsed.cluster,
      serviceName: parsed.serviceName,
      desiredStatus: "RUNNING",
      maxResults: 5,
    }),
  );
  if (!tasks.taskArns?.length) return null;

  const described = await ecs.send(
    new DescribeTasksCommand({
      cluster: parsed.cluster,
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

  const port = input.runtimePort;
  const publicIps = Array.from(
    new Set(
      (interfaces.NetworkInterfaces ?? [])
        .map((eni) => eni.Association?.PublicIp?.trim())
        .filter((ip): ip is string => Boolean(ip)),
    ),
  );
  for (const publicIp of publicIps) {
    try {
      await probeTcpPort(publicIp, port);
      return `http://${publicIp}:${port}`;
    } catch {
      // Try the next task ENI; ECS may be rolling and the first task can still be booting.
    }
  }
  return null;
}

function renderPlaceholder(id: string, details?: string) {
  return (
    <main className="container">
      <div className="card">
        <h1>Runtime Endpoint</h1>
        <p className="muted">
          This runtime URL is still being resolved for deployment <code>{id}</code>.
        </p>
        {details ? <p className="muted">{details}</p> : null}
      </div>
    </main>
  );
}

function renderRuntimeUnavailable(id: string, readyUrl: string | null, details?: string) {
  return (
    <main className="container">
      <div className="card">
        <h1>Runtime Endpoint</h1>
        <p className="muted">
          Deployment <code>{id}</code> is running, but the runtime web UI is not reachable yet.
        </p>
        {details ? <p className="muted">{details}</p> : null}
        <p className="muted">
          <a className="button secondary" href={`/deployments/${id}`}>
            Back to deployment dashboard
          </a>
        </p>
        {readyUrl ? (
          <p className="muted">
            Raw runtime URL: <code>{readyUrl}</code>
          </p>
        ) : null}
      </div>
    </main>
  );
}

function mergeResolvedRuntimeUrl(resolvedBaseUrl: string, storedReadyUrl: string | null) {
  try {
    const resolved = new URL(resolvedBaseUrl);
    if (!storedReadyUrl?.trim()) {
      return resolved.toString();
    }

    const stored = new URL(storedReadyUrl);

    // Preserve OpenClaw UI path/query (for gateway token or future flags) while
    // swapping in the currently reachable ECS task host/port.
    resolved.pathname = stored.pathname || "/";
    resolved.search = stored.search;
    resolved.hash = stored.hash;
    return resolved.toString();
  } catch {
    return resolvedBaseUrl;
  }
}

function firstSearchParam(value: string | string[] | undefined) {
  if (Array.isArray(value)) return String(value[0] || "").trim();
  return String(value || "").trim();
}

function collectRuntimeUiParams(
  searchParams: Record<string, string | string[] | undefined>,
) {
  const allowed = ["ui_mode", "hide_bot_session", "hide_bot_ui", "hide_session_ui"];
  const next = new URLSearchParams();
  for (const key of allowed) {
    const value = firstSearchParam(searchParams[key]);
    if (!value) continue;
    next.set(key, value);
  }
  return next;
}

function withRuntimeUiParams(urlValue: string, uiParams: URLSearchParams) {
  if (!uiParams.toString()) return urlValue;
  const parsed = new URL(urlValue);
  for (const [key, value] of uiParams.entries()) {
    parsed.searchParams.set(key, value);
  }
  return parsed.toString();
}

function buildRelativeUrlWithUiParams(pathname: string, uiParams: URLSearchParams) {
  const params = new URLSearchParams(uiParams);
  if (!params.get("ui_mode")) params.set("ui_mode", "oneclick");
  if (!params.get("hide_bot_session") && !params.get("hide_bot_ui")) {
    params.set("hide_bot_session", "1");
  }
  const query = params.toString();
  return query ? `${pathname}?${query}` : pathname;
}

async function isRuntimeControlUiReachable(readyUrl: string) {
  const result = await probeRuntimeHttp(readyUrl, 3000);
  return result.ok;
}

export default async function RuntimePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id } = await params;
  const session = await auth();
  const userId = session?.user?.email?.trim();
  if (!userId) {
    return renderPlaceholder(id, "Sign in required.");
  }
  const resolvedSearchParams = (searchParams ? await searchParams : {}) ?? {};
  const uiParams = collectRuntimeUiParams(resolvedSearchParams);

  await ensureSchema();

  const result = await pool.query<{
    bot_name: string | null;
    status: string;
    deploy_provider: string | null;
    runtime_id: string | null;
    ready_url: string | null;
    error: string | null;
    deployment_flavor: string | null;
    model_provider: string | null;
    default_model: string | null;
    openai_api_key: string | null;
    anthropic_api_key: string | null;
    openrouter_api_key: string | null;
    telegram_bot_token: string | null;
    created_at: string;
    updated_at: string;
  }>(
    `SELECT bot_name, status, deploy_provider, runtime_id, ready_url, error, deployment_flavor,
            model_provider, default_model, openai_api_key, anthropic_api_key, openrouter_api_key, telegram_bot_token,
            created_at, updated_at
     FROM deployments
     WHERE id = $1
       AND user_id = $2
     LIMIT 1`,
    [id, userId],
  );

  const deployment = result.rows[0];
  if (!deployment) {
    return renderPlaceholder(id, "Deployment not found.");
  }
  const simpleagentUiSupported = normalizeDeploymentFlavor(deployment.deployment_flavor) !== "deploy_openclaw_free";

  const provider = (deployment.deploy_provider ?? "").trim();
  if (provider === "lambda") {
    if (deployment.status === "ready") {
      const useSimpleagentUi = readTrimmedEnv("ONECLICK_USE_SIMPLEAGENT_UI_ADAPTER") !== "0";
      if (useSimpleagentUi && simpleagentUiSupported) {
        redirect(buildRelativeUrlWithUiParams(`/runtime/${id}/simpleagent-ui`, uiParams));
      }
      return (
        <ServerlessRuntimeClient
          deploymentId={id}
          botName={deployment.bot_name}
          initialState={{
            status: deployment.status,
            deployProvider: deployment.deploy_provider,
            runtimeId: deployment.runtime_id,
            readyUrl: deployment.ready_url,
            deploymentFlavor: deployment.deployment_flavor,
            error: deployment.error,
            createdAt: deployment.created_at,
            updatedAt: deployment.updated_at,
            settings: {
              modelProvider: deployment.model_provider?.trim() || "auto",
              defaultModel: deployment.default_model?.trim() || "",
              hasOpenaiApiKey: Boolean(deployment.openai_api_key?.trim()),
              hasAnthropicApiKey: Boolean(deployment.anthropic_api_key?.trim()),
              hasOpenrouterApiKey: Boolean(deployment.openrouter_api_key?.trim()),
              hasTelegramBotToken: Boolean(deployment.telegram_bot_token?.trim()),
            },
          }}
        />
      );
    }
    if (deployment.status === "failed" || deployment.status === "stopped") {
      return renderPlaceholder(id, deployment.error || "This deployment is no longer active.");
    }
    return renderPlaceholder(id, "Serverless runtime is still preparing. Try again in a moment.");
  }

  if (deployment.status === "ready" && simpleagentUiSupported) {
    redirect(buildRelativeUrlWithUiParams(`/runtime/${id}/simpleagent-ui`, uiParams));
  }

  const readyUrl = deployment.ready_url?.trim();
  if (deployment.status === "failed" || deployment.status === "stopped") {
    if (readyUrl) {
      return renderRuntimeUnavailable(
        id,
        readyUrl,
        deployment.error || "This deployment is no longer active.",
      );
    }
    return renderPlaceholder(
      id,
      deployment.error || "This deployment is no longer active.",
    );
  }

  if (readyUrl) {
    let parsedReadyUrl: URL | null = null;
    try {
      parsedReadyUrl = new URL(readyUrl);
    } catch {
      // Keep placeholder for invalid URLs.
    }
    if (parsedReadyUrl && parsedReadyUrl.pathname !== `/runtime/${id}`) {
      const provider = (deployment.deploy_provider ?? "").trim();
      const reachable = await isRuntimeControlUiReachable(parsedReadyUrl.toString());
      if (reachable) {
        redirect(withRuntimeUiParams(parsedReadyUrl.toString(), uiParams));
      }
      if (provider !== "ecs") {
        return renderRuntimeUnavailable(
          id,
          parsedReadyUrl.toString(),
          "The runtime accepted deployment but is not serving the Control UI over HTTP yet.",
        );
      }
    }
  }

  if (provider === "ecs" && deployment.runtime_id) {
    const runtimePort = getRuntimePort(normalizeDeploymentFlavor(deployment.deployment_flavor));
    let resolved: string | null = null;
    try {
      resolved = await resolveEcsPublicUrl({
        runtimeId: deployment.runtime_id,
        deploymentId: id,
        runtimePort,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unexpected runtime resolution error.";
      return renderPlaceholder(id, message);
    }
    if (resolved) {
      redirect(withRuntimeUiParams(mergeResolvedRuntimeUrl(resolved, deployment.ready_url), uiParams));
    }
    return renderPlaceholder(
      id,
      deployment.status === "failed" || deployment.status === "stopped"
        ? deployment.error || "Deployment failed before runtime became reachable."
        : "ECS task is still starting. Try again in a moment.",
    );
  }

  return renderPlaceholder(
    id,
    deployment.status === "failed" || deployment.status === "stopped"
      ? deployment.error || "Deployment failed."
      : undefined,
  );
}
