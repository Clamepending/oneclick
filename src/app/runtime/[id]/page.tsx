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

  const publicIp = interfaces.NetworkInterfaces?.find((eni) => eni.Association?.PublicIp)?.Association?.PublicIp;
  if (!publicIp) return null;

  const port = Number(readTrimmedEnv("OPENCLAW_CONTAINER_PORT") || "18789");
  try {
    await probeTcpPort(publicIp, port);
  } catch {
    return null;
  }
  return `http://${publicIp}:${port}`;
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

  if (deployment.status === "failed") {
    return renderPlaceholder(
      id,
      deployment.error || "This deployment is no longer active.",
    );
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
      redirect(resolved);
    }
    return renderPlaceholder(
      id,
      deployment.status === "failed"
        ? deployment.error || "Deployment failed before runtime became reachable."
        : "ECS task is still starting. Try again in a moment.",
    );
  }

  const readyUrl = deployment.ready_url?.trim();
  if (readyUrl) {
    try {
      const url = new URL(readyUrl);
      if (url.pathname !== `/runtime/${id}`) {
        redirect(url.toString());
      }
    } catch {
      // Keep placeholder for invalid URLs.
    }
  }

  return renderPlaceholder(
    id,
    deployment.status === "failed" ? deployment.error || "Deployment failed." : undefined,
  );
}
