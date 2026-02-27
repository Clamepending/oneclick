import { DescribeTasksCommand, ECSClient, ListTasksCommand } from "@aws-sdk/client-ecs";
import { DescribeNetworkInterfacesCommand, EC2Client } from "@aws-sdk/client-ec2";
import net from "node:net";
import { redirect } from "next/navigation";
import { ensureSchema, pool } from "@/lib/db";

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

async function resolveEcsPublicUrl(input: { runtimeId: string; deploymentId: string }) {
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

  const port = Number(readTrimmedEnv("OPENCLAW_CONTAINER_PORT") || "18789");
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
        <h1>OpenClaw Runtime Endpoint</h1>
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
        <h1>OpenClaw Runtime Endpoint</h1>
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

async function isRuntimeControlUiReachable(readyUrl: string) {
  try {
    const probeUrl = new URL("/__openclaw/control-ui-config.json", readyUrl);
    const response = await fetch(probeUrl.toString(), {
      cache: "no-store",
      signal: AbortSignal.timeout(3000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

export default async function RuntimePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await ensureSchema();

  const result = await pool.query<{
    status: string;
    deploy_provider: string | null;
    runtime_id: string | null;
    ready_url: string | null;
    error: string | null;
  }>(
    `SELECT status, deploy_provider, runtime_id, ready_url, error
     FROM deployments
     WHERE id = $1
     LIMIT 1`,
    [id],
  );

  const deployment = result.rows[0];
  if (!deployment) {
    return renderPlaceholder(id, "Deployment not found.");
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
      if (provider !== "ecs") {
        const reachable = await isRuntimeControlUiReachable(parsedReadyUrl.toString());
        if (!reachable) {
          return renderRuntimeUnavailable(
            id,
            parsedReadyUrl.toString(),
            "The runtime accepted deployment but is not serving the Control UI over HTTP yet.",
          );
        }
      }
      redirect(parsedReadyUrl.toString());
    }
  }

  const provider = (deployment.deploy_provider ?? "").trim();
  if (provider === "ecs" && deployment.runtime_id) {
    let resolved: string | null = null;
    try {
      resolved = await resolveEcsPublicUrl({ runtimeId: deployment.runtime_id, deploymentId: id });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unexpected runtime resolution error.";
      return renderPlaceholder(id, message);
    }
    if (resolved) {
      redirect(mergeResolvedRuntimeUrl(resolved, deployment.ready_url));
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
