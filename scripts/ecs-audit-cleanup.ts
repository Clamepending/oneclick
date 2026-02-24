import dotenv from "dotenv";
import { DescribeServicesCommand, ECSClient, ListServicesCommand } from "@aws-sdk/client-ecs";

type DeploymentRuntimeRow = {
  id: string;
  status: string;
  runtime_id: string | null;
  deploy_provider: string | null;
  error: string | null;
};

function readTrimmedEnv(name: string) {
  const raw = process.env[name];
  if (!raw) return "";
  return raw.trim().replace(/^"(.*)"$/, "$1").replace(/\\n/g, "").trim();
}

function readBoolEnv(name: string, fallback = false) {
  const raw = readTrimmedEnv(name).toLowerCase();
  if (!raw) return fallback;
  if (["1", "true", "yes", "on"].includes(raw)) return true;
  if (["0", "false", "no", "off"].includes(raw)) return false;
  return fallback;
}

function parseEcsRuntimeId(runtimeId: string) {
  if (!runtimeId.startsWith("ecs:")) return null;
  const body = runtimeId.slice(4);
  const parts = body.split("|");
  if (parts.length !== 2) return null;
  const [cluster, serviceName] = parts;
  if (!cluster || !serviceName) return null;
  return { cluster, serviceName };
}

async function appendEvent(deploymentId: string, status: string, message: string) {
  const { pool } = await import("@/lib/db");
  await pool.query(
    `INSERT INTO deployment_events (deployment_id, status, message)
     VALUES ($1, $2, $3)`,
    [deploymentId, status, message],
  );
}

async function listAllServiceArns(ecs: ECSClient, cluster: string) {
  const arns: string[] = [];
  let nextToken: string | undefined;
  do {
    const result = await ecs.send(new ListServicesCommand({ cluster, nextToken, maxResults: 10 }));
    arns.push(...(result.serviceArns ?? []));
    nextToken = result.nextToken;
  } while (nextToken);
  return arns;
}

async function describeServices(ecs: ECSClient, cluster: string, serviceArns: string[]) {
  const out: any[] = [];
  for (let i = 0; i < serviceArns.length; i += 10) {
    const batch = serviceArns.slice(i, i + 10);
    if (!batch.length) continue;
    const result = await ecs.send(new DescribeServicesCommand({ cluster, services: batch }));
    out.push(...(result.services ?? []));
  }
  return out;
}

async function main() {
  dotenv.config({ path: ".env", quiet: true });
  dotenv.config({ path: ".env.local", override: false, quiet: true });
  const region = readTrimmedEnv("AWS_REGION");
  const cluster = readTrimmedEnv("ECS_CLUSTER");
  const servicePrefix = readTrimmedEnv("ECS_SERVICE_PREFIX") || "oneclick-agent";
  const dryRun = readBoolEnv("ECS_AUDIT_DRY_RUN", true);
  const deleteOrphans = readBoolEnv("ECS_AUDIT_DELETE_ORPHANS", false);
  const accessKeyId = readTrimmedEnv("AWS_ACCESS_KEY_ID");
  const secretAccessKey = readTrimmedEnv("AWS_SECRET_ACCESS_KEY");
  const sessionToken = readTrimmedEnv("AWS_SESSION_TOKEN");

  if (!region || !cluster) {
    throw new Error("AWS_REGION and ECS_CLUSTER are required.");
  }

  const { ensureSchema, pool } = await import("@/lib/db");
  const { destroyUserRuntime } = await import("@/lib/provisioner/runtimeProvider");
  await ensureSchema();
  const ecs = new ECSClient({
    region,
    ...(accessKeyId && secretAccessKey
      ? {
          credentials: {
            accessKeyId,
            secretAccessKey,
            ...(sessionToken ? { sessionToken } : {}),
          },
        }
      : {}),
  });

  const deploymentRows = await pool.query<DeploymentRuntimeRow>(
    `SELECT id, status, runtime_id, deploy_provider, error
     FROM deployments
     WHERE runtime_id IS NOT NULL AND COALESCE(TRIM(deploy_provider), '') = 'ecs'`,
    [],
  );

  const byServiceName = new Map<string, DeploymentRuntimeRow[]>();
  for (const row of deploymentRows.rows) {
    if (!row.runtime_id) continue;
    const parsed = parseEcsRuntimeId(row.runtime_id);
    if (!parsed || parsed.cluster !== cluster) continue;
    const list = byServiceName.get(parsed.serviceName) ?? [];
    list.push(row);
    byServiceName.set(parsed.serviceName, list);
  }

  const serviceArns = await listAllServiceArns(ecs, cluster);
  const services = await describeServices(ecs, cluster, serviceArns);
  const managedServices = services.filter((service: any) =>
    (service.serviceName ?? "").startsWith(`${servicePrefix}-`),
  );

  const orphanFindings: Array<{
    serviceName: string;
    reason: string;
    deploymentId: string | null;
    deploymentStatus: string | null;
    latestEvent: string | null;
  }> = [];

  for (const service of managedServices as any[]) {
    const serviceName = service.serviceName ?? "";
    if (!serviceName) continue;
    const matches = byServiceName.get(serviceName) ?? [];
    const latestEvent = service.events?.[0]?.message?.trim() || null;

    if (matches.length === 0) {
      orphanFindings.push({
        serviceName,
        reason: "No deployment row references this ECS service",
        deploymentId: null,
        deploymentStatus: null,
        latestEvent,
      });
      continue;
    }

    const activeMatch = matches.find((row) => ["queued", "starting", "ready"].includes(row.status));
    if (activeMatch) continue;

    const latestRow = matches[0];
    orphanFindings.push({
      serviceName,
      reason: "Deployment is not active but ECS service still exists",
      deploymentId: latestRow?.id ?? null,
      deploymentStatus: latestRow?.status ?? null,
      latestEvent,
    });
  }

  console.log(
    JSON.stringify(
      {
        checkedAt: new Date().toISOString(),
        region,
        cluster,
        dryRun,
        deleteOrphans,
        managedServiceCount: managedServices.length,
        orphanCount: orphanFindings.length,
        orphans: orphanFindings,
      },
      null,
      2,
    ),
  );

  if (!deleteOrphans || dryRun || orphanFindings.length === 0) return;

  for (const orphan of orphanFindings) {
    const runtimeId = `ecs:${cluster}|${orphan.serviceName}`;
    console.log(`Deleting orphan ECS service ${orphan.serviceName}`);
    try {
      await destroyUserRuntime({ runtimeId, deployProvider: "ecs" });
      if (orphan.deploymentId) {
        await appendEvent(
          orphan.deploymentId,
          "failed",
          `ECS audit cleanup removed orphan runtime service ${orphan.serviceName}.`,
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Failed to delete ${orphan.serviceName}: ${message}`);
      if (orphan.deploymentId) {
        await appendEvent(
          orphan.deploymentId,
          "failed",
          `ECS audit cleanup failed for ${orphan.serviceName}: ${message}`,
        );
      }
    }
  }
}

void main()
  .catch((error) => {
    console.error("ECS audit/cleanup failed:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    try {
      const { pool } = await import("@/lib/db");
      await pool.end();
    } catch {
      // Ignore pool shutdown errors during script exit.
    }
  });
