import { randomUUID } from "node:crypto";
import { config as loadEnv } from "dotenv";
import { DescribeNetworkInterfacesCommand, EC2Client } from "@aws-sdk/client-ec2";
import { DescribeServicesCommand, DescribeTasksCommand, ECSClient, ListTasksCommand } from "@aws-sdk/client-ecs";
import { destroyUserRuntime, launchUserContainer } from "@/lib/provisioner/runtimeProvider";

loadEnv({ path: ".env", quiet: true });
loadEnv({ path: ".env.local", override: true, quiet: true });

function requireEnv(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing env: ${name}`);
  return value.replace(/^"(.*)"$/, "$1");
}

async function sleep(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function describeService(region: string, cluster: string, serviceName: string) {
  const client = new ECSClient({ region });
  const res = await client.send(
    new DescribeServicesCommand({
      cluster,
      services: [serviceName],
    }),
  );
  const service = res.services?.[0] ?? null;
  const failure = res.failures?.[0] ?? null;
  return { service, failure };
}

async function printServiceDiagnostics(region: string, cluster: string, serviceName: string) {
  const client = new ECSClient({ region });
  const svc = await client.send(
    new DescribeServicesCommand({
      cluster,
      services: [serviceName],
    }),
  );
  const service = svc.services?.[0];
  if (!service) {
    console.log("Diagnostics: service not found.");
    return;
  }

  const recentEvents = (service.events ?? []).slice(0, 5);
  if (recentEvents.length > 0) {
    console.log("Recent ECS service events:");
    for (const event of recentEvents) {
      console.log(`- ${event.createdAt?.toISOString() ?? "unknown"} :: ${event.message ?? ""}`);
    }
  }

  const stoppedTasks = await client.send(
    new ListTasksCommand({
      cluster,
      serviceName,
      desiredStatus: "STOPPED",
      maxResults: 5,
    }),
  );
  if ((stoppedTasks.taskArns?.length ?? 0) === 0) {
    console.log("No stopped tasks found for diagnostics.");
    return;
  }
  const taskDetails = await client.send(
    new DescribeTasksCommand({
      cluster,
      tasks: stoppedTasks.taskArns,
    }),
  );
  console.log("Recent stopped task reasons:");
  for (const task of taskDetails.tasks ?? []) {
    const taskReason = task.stoppedReason ?? "unknown";
    const containerReason = task.containers?.[0]?.reason ?? "none";
    const containerExit = task.containers?.[0]?.exitCode;
    console.log(`- task=${task.taskArn?.split("/").pop()} stoppedReason=${taskReason} containerReason=${containerReason} exitCode=${containerExit ?? "n/a"}`);
  }
}

async function resolveServicePublicIp(region: string, cluster: string, serviceName: string) {
  const ecs = new ECSClient({ region });
  const ec2 = new EC2Client({ region });
  const tasks = await ecs.send(
    new ListTasksCommand({
      cluster,
      serviceName,
      desiredStatus: "RUNNING",
      maxResults: 5,
    }),
  );
  if (!tasks.taskArns?.length) return null;

  const described = await ecs.send(
    new DescribeTasksCommand({
      cluster,
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

  return interfaces.NetworkInterfaces?.find((eni) => eni.Association?.PublicIp)?.Association?.PublicIp ?? null;
}

async function fetchText(url: string) {
  const res = await fetch(url);
  const text = await res.text();
  return { res, text };
}

function mustMatch(text: string, pattern: RegExp, label: string) {
  const match = text.match(pattern);
  if (!match) {
    throw new Error(`Runtime smoke check failed: missing ${label}`);
  }
  return match;
}

async function runRuntimeHttpSmoke(baseUrl: string) {
  console.log(`Runtime HTTP smoke: ${baseUrl}`);

  const shell = await fetchText(`${baseUrl}/`);
  if (!shell.res.ok) {
    throw new Error(`Runtime shell request failed (${shell.res.status})`);
  }
  if (!shell.text.includes("<openclaw-app></openclaw-app>")) {
    throw new Error("Runtime shell is not serving OpenClaw Control UI markup.");
  }

  const assetMatch = mustMatch(
    shell.text,
    /<script type="module"[^>]*src="(\.\/assets\/[^"]+\.js)"/i,
    "control-ui asset script",
  );
  const assetPath = assetMatch[1];
  const asset = await fetchText(`${baseUrl}/${assetPath.replace(/^\.\//, "")}`);
  if (!asset.res.ok) {
    throw new Error(`Runtime control-ui asset request failed (${asset.res.status})`);
  }
  if (!asset.text.includes("openclaw-control-ui")) {
    throw new Error("Runtime control-ui JS asset did not include expected client identifier.");
  }

  const config = await fetch(`${baseUrl}/__openclaw/control-ui-config.json`);
  if (!config.ok) {
    throw new Error(`Runtime control-ui config request failed (${config.status})`);
  }
  const configJson = (await config.json()) as Record<string, unknown>;
  if (typeof configJson.basePath !== "string") {
    throw new Error("Runtime control-ui config missing basePath.");
  }

  console.log("Runtime HTTP smoke passed.");
}

async function runOptionalTelegramSmoke() {
  const token = process.env.ECS_SMOKE_TELEGRAM_TOKEN?.trim();
  if (!token) return;
  console.log("Telegram smoke: validating bot token + deleteWebhook...");

  const getMe = await fetch(`https://api.telegram.org/bot${token}/getMe`);
  if (!getMe.ok) {
    throw new Error(`Telegram getMe failed (${getMe.status})`);
  }

  const deleteWebhook = await fetch(`https://api.telegram.org/bot${token}/deleteWebhook`, { method: "POST" });
  if (!deleteWebhook.ok) {
    throw new Error(`Telegram deleteWebhook failed (${deleteWebhook.status})`);
  }

  console.log("Telegram smoke passed.");
}

function parseEcsRuntimeId(runtimeId: string) {
  if (!runtimeId.startsWith("ecs:")) throw new Error(`Unexpected runtime id: ${runtimeId}`);
  const body = runtimeId.slice(4);
  const [cluster, serviceName] = body.split("|");
  if (!cluster || !serviceName) throw new Error(`Invalid ecs runtime id: ${runtimeId}`);
  return { cluster, serviceName };
}

async function main() {
  const region = requireEnv("AWS_REGION");
  const pollCount = Number(process.env.ECS_SMOKE_POLL_COUNT ?? "36");
  const pollIntervalMs = Number(process.env.ECS_SMOKE_POLL_INTERVAL_MS ?? "5000");
  const runtimePort = Number(process.env.OPENCLAW_CONTAINER_PORT ?? "18789");
  const deploymentId = `smoke-${Date.now()}`;
  const userId = `smoke-${randomUUID().slice(0, 8)}`;
  let runtimeId: string | null = null;

  try {
    console.log("Creating ECS runtime...");
    const first = await launchUserContainer({
      deploymentId,
      userId,
      runtimeSlugSource: "smoke-test",
    });
    runtimeId = first.runtimeId;
    console.log(`Created runtimeId=${first.runtimeId}`);

    const parsed = parseEcsRuntimeId(first.runtimeId);
    const firstDescribe = await describeService(region, parsed.cluster, parsed.serviceName);
    console.log(`Service status after create: ${firstDescribe.service?.status ?? "missing"}`);

    console.log("Re-deploying same deployment (update path / idempotency check)...");
    const second = await launchUserContainer({
      deploymentId,
      userId,
      runtimeSlugSource: "smoke-test",
    });
    if (second.runtimeId !== first.runtimeId) {
      throw new Error("Expected same runtimeId on second launch for same deployment/service.");
    }
    console.log("Second launch succeeded and reused service name.");

    let runningTaskObserved = false;
    for (let i = 0; i < pollCount; i += 1) {
      const { service } = await describeService(region, parsed.cluster, parsed.serviceName);
      const status = service?.status ?? "missing";
      const running = service?.runningCount ?? 0;
      const desired = service?.desiredCount ?? 0;
      const pending = service?.pendingCount ?? 0;
      console.log(`Poll ${i + 1}/${pollCount}: status=${status} running=${running} pending=${pending} desired=${desired}`);
      if ((status === "ACTIVE" || status === "DRAINING") && desired === 1) {
        if (running > 0) {
          runningTaskObserved = true;
          break;
        }
      }
      await sleep(pollIntervalMs);
    }
    if (!runningTaskObserved) {
      console.warn("Warning: service did not report running task within poll window (may still be starting).");
      await printServiceDiagnostics(region, parsed.cluster, parsed.serviceName);
    } else {
      const publicIp = await resolveServicePublicIp(region, parsed.cluster, parsed.serviceName);
      if (!publicIp) {
        throw new Error("Smoke test could not resolve ECS task public IP after service reached running state.");
      }
      await runRuntimeHttpSmoke(`http://${publicIp}:${runtimePort}`);
      await runOptionalTelegramSmoke();
    }

    console.log("Destroying ECS runtime...");
    await destroyUserRuntime({
      runtimeId: first.runtimeId,
      deployProvider: "ecs",
    });

    await sleep(3000);
    const afterDelete = await describeService(region, parsed.cluster, parsed.serviceName);
    console.log(
      `After delete: status=${afterDelete.service?.status ?? "missing"} failure=${afterDelete.failure?.reason ?? "none"}`,
    );
    console.log("ECS smoke test completed.");
  } catch (error) {
    console.error("ECS smoke test failed:", error);
    if (runtimeId) {
      try {
        console.error("Attempting cleanup...");
        await destroyUserRuntime({ runtimeId, deployProvider: "ecs" });
      } catch (cleanupError) {
        console.error("Cleanup failed:", cleanupError);
      }
    }
    process.exitCode = 1;
  }
}

void main();
