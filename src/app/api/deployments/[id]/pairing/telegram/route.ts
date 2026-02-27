import {
  DescribeServicesCommand,
  DescribeTaskDefinitionCommand,
  DescribeTasksCommand,
  ECSClient,
  RunTaskCommand,
} from "@aws-sdk/client-ecs";
import { GetLogEventsCommand, type OutputLogEvent, CloudWatchLogsClient } from "@aws-sdk/client-cloudwatch-logs";
import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { ensureSchema, pool } from "@/lib/db";

const payloadSchema = z.object({
  code: z.string().trim().min(6).max(24).regex(/^[A-Za-z0-9]+$/, "Pairing code must be alphanumeric."),
});

function readTrimmedEnv(name: string) {
  const raw = process.env[name];
  if (!raw) return "";
  return raw.trim().replace(/^"(.*)"$/, "$1").replace(/\\n/g, "").trim();
}

function sanitizeSegment(value: string) {
  return value.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 48) || "default";
}

function parseEcsRuntimeId(runtimeId: string | null) {
  if (!runtimeId || !runtimeId.startsWith("ecs:")) return null;
  const body = runtimeId.slice(4);
  const [cluster, serviceName] = body.split("|");
  if (!cluster || !serviceName) return null;
  return { cluster, serviceName };
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

function collectLogText(events: OutputLogEvent[] | undefined) {
  return (events ?? []).map((event) => event.message ?? "").join("\n");
}

async function approveTelegramPairingViaEcs(input: {
  runtimeId: string;
  userId: string;
  deploymentId: string;
  code: string;
}) {
  const parsed = parseEcsRuntimeId(input.runtimeId);
  if (!parsed) {
    throw new Error("Invalid ECS runtime id.");
  }
  const region = readTrimmedEnv("AWS_REGION");
  if (!region) {
    throw new Error("AWS_REGION is not configured.");
  }

  const credentials =
    readTrimmedEnv("AWS_ACCESS_KEY_ID") && readTrimmedEnv("AWS_SECRET_ACCESS_KEY")
      ? {
          accessKeyId: readTrimmedEnv("AWS_ACCESS_KEY_ID"),
          secretAccessKey: readTrimmedEnv("AWS_SECRET_ACCESS_KEY"),
        }
      : undefined;

  const ecs = new ECSClient({ region, credentials });
  const logs = new CloudWatchLogsClient({ region, credentials });
  const containerName = readTrimmedEnv("ECS_CONTAINER_NAME") || "openclaw";
  const efsMountPath = readTrimmedEnv("ECS_EFS_CONTAINER_MOUNT_PATH") || "/mnt/oneclick-efs";
  const workspaceSuffix = readTrimmedEnv("OPENCLAW_WORKSPACE_SUFFIX") || "workspace";

  const serviceResponse = await ecs.send(
    new DescribeServicesCommand({
      cluster: parsed.cluster,
      services: [parsed.serviceName],
    }),
  );
  const service = serviceResponse.services?.[0];
  if (!service?.taskDefinition) {
    throw new Error("Runtime service not found.");
  }
  const awsvpc = service.networkConfiguration?.awsvpcConfiguration;
  if (!awsvpc?.subnets?.length) {
    throw new Error("Runtime network configuration is missing.");
  }

  const taskDefinition = await ecs.send(
    new DescribeTaskDefinitionCommand({
      taskDefinition: service.taskDefinition,
    }),
  );
  const mainContainer = (taskDefinition.taskDefinition?.containerDefinitions ?? []).find(
    (definition) => definition.name === containerName,
  );
  if (!mainContainer) {
    throw new Error(`Runtime container "${containerName}" not found.`);
  }

  const stateDir = `${efsMountPath}/${sanitizeSegment(input.userId)}/${sanitizeSegment(input.deploymentId)}`;
  const workspaceDir = `${stateDir}/${workspaceSuffix}`;
  const code = input.code.trim().toUpperCase();
  const commandScript = [
    "set -e",
    `mkdir -p ${JSON.stringify(workspaceDir)}`,
    "rm -rf /home/node/.openclaw || true",
    `ln -s ${JSON.stringify(stateDir)} /home/node/.openclaw`,
    `node /app/dist/index.js pairing approve telegram ${code}`,
  ].join("\n");

  const runResult = await ecs.send(
    new RunTaskCommand({
      cluster: parsed.cluster,
      taskDefinition: service.taskDefinition,
      launchType: (service.launchType ?? "FARGATE") as "FARGATE" | "EC2" | "EXTERNAL",
      platformVersion: service.platformVersion || undefined,
      count: 1,
      networkConfiguration: {
        awsvpcConfiguration: {
          subnets: awsvpc.subnets,
          securityGroups: awsvpc.securityGroups,
          assignPublicIp: awsvpc.assignPublicIp,
        },
      },
      overrides: {
        containerOverrides: [
          {
            name: containerName,
            command: [commandScript],
          },
        ],
      },
    }),
  );

  const taskArn = runResult.tasks?.[0]?.taskArn;
  if (!taskArn) {
    const reason = runResult.failures?.[0]?.reason || "Failed to start pairing helper task.";
    throw new Error(reason);
  }

  let helperExitCode: number | null = null;
  let helperReason = "";
  const timeoutMs = 90_000;
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const described = await ecs.send(
      new DescribeTasksCommand({
        cluster: parsed.cluster,
        tasks: [taskArn],
      }),
    );
    const task = described.tasks?.[0];
    if (!task) break;
    if (task.lastStatus === "STOPPED") {
      const container = task.containers?.find((entry) => entry.name === containerName);
      helperExitCode = container?.exitCode ?? null;
      helperReason = container?.reason || task.stoppedReason || "";
      break;
    }
    await sleep(1000);
  }

  const taskId = taskArn.split("/").pop();
  const logGroup = mainContainer.logConfiguration?.options?.["awslogs-group"] || "/ecs/oneclick";
  const logPrefix = mainContainer.logConfiguration?.options?.["awslogs-stream-prefix"] || "oneclick";
  const logStreamName = taskId ? `${logPrefix}/${containerName}/${taskId}` : "";

  let helperLogs = "";
  if (logStreamName) {
    try {
      const logResult = await logs.send(
        new GetLogEventsCommand({
          logGroupName: logGroup,
          logStreamName,
          startFromHead: true,
          limit: 200,
        }),
      );
      helperLogs = collectLogText(logResult.events);
    } catch {
      helperLogs = "";
    }
  }

  const approved = helperLogs.includes("Approved telegram sender");
  const noPending = helperLogs.includes("No pending pairing request found for code:");
  const timedOut = helperExitCode === null;

  return {
    approved,
    noPending,
    timedOut,
    helperExitCode,
    helperReason,
    helperLogs,
  };
}

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  if (!session?.user?.email) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  const payloadResult = payloadSchema.safeParse(await request.json().catch(() => null));
  if (!payloadResult.success) {
    return NextResponse.json({ ok: false, error: "Invalid pairing code." }, { status: 400 });
  }

  const { id } = await context.params;
  await ensureSchema();

  const deploymentResult = await pool.query<{
    id: string;
    status: string;
    runtime_id: string | null;
    deploy_provider: string | null;
    user_id: string;
    telegram_bot_token: string | null;
  }>(
    `SELECT id, status, runtime_id, deploy_provider, user_id, telegram_bot_token
     FROM deployments
     WHERE id = $1 AND user_id = $2`,
    [id, session.user.email],
  );
  const deployment = deploymentResult.rows[0];
  if (!deployment) {
    return NextResponse.json({ ok: false, error: "Not found" }, { status: 404 });
  }
  if (deployment.status !== "ready") {
    return NextResponse.json({ ok: false, error: "Deployment must be ready before approving pairing." }, { status: 409 });
  }
  if ((deployment.deploy_provider ?? "").trim() !== "ecs") {
    return NextResponse.json({ ok: false, error: "Telegram pairing approval is currently supported for ECS deployments only." }, { status: 400 });
  }
  if (!deployment.runtime_id) {
    return NextResponse.json({ ok: false, error: "Runtime is unavailable." }, { status: 409 });
  }
  if (!deployment.telegram_bot_token?.trim()) {
    return NextResponse.json({ ok: false, error: "Telegram token is not configured for this deployment." }, { status: 400 });
  }

  try {
    const result = await approveTelegramPairingViaEcs({
      runtimeId: deployment.runtime_id,
      userId: deployment.user_id,
      deploymentId: deployment.id,
      code: payloadResult.data.code,
    });

    if (result.approved) {
      return NextResponse.json({ ok: true, message: "Telegram pairing approved." });
    }
    if (result.noPending) {
      return NextResponse.json(
        { ok: false, error: "No pending pairing request found for that code. Generate a fresh code and try again." },
        { status: 409 },
      );
    }
    if (result.timedOut) {
      return NextResponse.json(
        { ok: false, error: "Pairing helper timed out while waiting for ECS task execution. Please retry." },
        { status: 504 },
      );
    }

    return NextResponse.json(
      { ok: false, error: result.helperReason || "Failed to approve Telegram pairing code." },
      { status: 500 },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to approve Telegram pairing code.";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
