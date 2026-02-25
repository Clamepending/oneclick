import { randomUUID } from "crypto";
import {
  CreateServiceCommand,
  DeleteServiceCommand,
  ECSClient,
  type ECSClientConfig,
  RegisterTaskDefinitionCommand,
  UpdateServiceCommand,
} from "@aws-sdk/client-ecs";
import { getRuntimeBaseDomain } from "@/lib/subdomainConfig";
import {
  getOpenClawImage,
  getOpenClawPort,
  getOpenClawStartCommand,
  shouldAllowInsecureControlUi,
} from "@/lib/provisioner/openclawBundle";
import { buildRuntimeSubdomain } from "@/lib/provisioner/runtimeSlug";
import type { Host } from "@/lib/provisioner/hostScheduler";

type LaunchInput = {
  deploymentId: string;
  userId: string;
  runtimeSlugSource?: string | null;
  telegramBotToken?: string | null;
  openaiApiKey?: string | null;
  anthropicApiKey?: string | null;
  openrouterApiKey?: string | null;
  subsidyProxyBaseUrl?: string | null;
  subsidyProxyToken?: string | null;
  host?: Host;
};

type DestroyInput = {
  runtimeId: string;
  deployProvider: string | null;
};

function sanitizeSegment(value: string) {
  return value.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 48) || "default";
}

function readTrimmedEnv(name: string) {
  const raw = process.env[name];
  if (!raw) return "";
  return raw.trim().replace(/^"(.*)"$/, "$1").replace(/\\n/g, "").trim();
}

function requireEnv(name: string) {
  const value = readTrimmedEnv(name);
  if (!value) {
    throw new Error(`${name} is required for DEPLOY_PROVIDER=ecs.`);
  }
  return value;
}

function parseCsvEnv(name: string, required = true) {
  const value = readTrimmedEnv(name);
  if (!value) {
    if (required) {
      throw new Error(`${name} is required for DEPLOY_PROVIDER=ecs.`);
    }
    return [] as string[];
  }
  const parsed = value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  if (required && parsed.length === 0) {
    throw new Error(`${name} must contain at least one value for DEPLOY_PROVIDER=ecs.`);
  }
  return parsed;
}

function buildAwsConfigWithTrimmedCreds(region: string): ECSClientConfig {
  const accessKeyId = readTrimmedEnv("AWS_ACCESS_KEY_ID");
  const secretAccessKey = readTrimmedEnv("AWS_SECRET_ACCESS_KEY");
  const sessionToken = readTrimmedEnv("AWS_SESSION_TOKEN");
  if (!accessKeyId || !secretAccessKey) {
    return { region };
  }
  return {
    region,
    credentials: {
      accessKeyId,
      secretAccessKey,
      sessionToken: sessionToken || undefined,
    },
  };
}

function shellQuote(value: string) {
  return `'${value.replace(/'/g, `'\"'\"'`)}'`;
}

function readEnvLimit(key: string, fallback: string) {
  const value = process.env[key]?.trim();
  return value && value.length > 0 ? value : fallback;
}

function getDockerResourceFlags() {
  const memory = readEnvLimit("OPENCLAW_LIMIT_MEMORY", "1g");
  const cpus = readEnvLimit("OPENCLAW_LIMIT_CPUS", "0.5");
  const pids = readEnvLimit("OPENCLAW_LIMIT_PIDS", "256");
  const shmSize = readEnvLimit("OPENCLAW_LIMIT_SHM", "128m");
  const logMaxSize = readEnvLimit("OPENCLAW_LIMIT_LOG_MAX_SIZE", "10m");
  const logMaxFiles = readEnvLimit("OPENCLAW_LIMIT_LOG_MAX_FILES", "3");
  // Writable-layer storage cap; may require specific Docker storage-driver support.
  const writableLayerSize = process.env.OPENCLAW_LIMIT_WRITABLE_LAYER_SIZE?.trim() ?? "";

  return {
    memory,
    cpus,
    pids,
    shmSize,
    logMaxSize,
    logMaxFiles,
    writableLayerSize,
  };
}

function sanitizeNamePart(value: string, maxLength: number) {
  const sanitized = value
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  return sanitized.slice(0, maxLength) || "default";
}

function buildRuntimeName(input: { runtimeSlugSource?: string | null; userId: string; deploymentId: string }) {
  const botPart = sanitizeNamePart(input.runtimeSlugSource?.trim() || "bot", 20);
  const userPart = sanitizeNamePart(input.userId, 24);
  const deploymentPart = sanitizeNamePart(input.deploymentId, 10);
  const joined = `oneclick-${botPart}-${userPart}-${deploymentPart}`;
  return joined.slice(0, 63);
}

function buildRuntimeUrlFromDomain(runtimeSlugSource: string | null | undefined, userId: string) {
  const baseDomain = getRuntimeBaseDomain();
  if (!baseDomain) return null;
  const subdomain = buildRuntimeSubdomain(runtimeSlugSource, userId);
  return {
    fqdn: `${subdomain}.${baseDomain}`,
    readyUrl: `https://${subdomain}.${baseDomain}`,
  };
}

function buildAssignedPort(deploymentId: string) {
  const base = Number(process.env.OPENCLAW_HOST_PORT_BASE ?? "20000");
  const span = Number(process.env.OPENCLAW_HOST_PORT_SPAN ?? "10000");
  const hex = deploymentId.replace(/-/g, "").slice(-6);
  const offset = Number.parseInt(hex, 16) % span;
  return base + offset;
}

function parseSshTarget(dockerHost: string) {
  // Expected format: ssh://user@hostname
  if (!dockerHost.startsWith("ssh://")) return null;
  return dockerHost.replace("ssh://", "");
}

function parseUserAndHost(sshTarget: string) {
  const [user, host] = sshTarget.includes("@")
    ? sshTarget.split("@")
    : ["root", sshTarget];
  return { user, host };
}

function runtimeIdFromSsh(sshTarget: string, containerName: string) {
  return `ssh:${sshTarget}|${containerName}`;
}

function runtimeIdFromEcs(cluster: string, serviceName: string) {
  return `ecs:${cluster}|${serviceName}`;
}

function getGatewayToken() {
  return randomUUID().replace(/-/g, "");
}

function withGatewayToken(readyUrl: string, token: string) {
  const url = new URL(readyUrl);
  url.searchParams.set("token", token);
  return url.toString();
}

function parseSshRuntimeId(runtimeId: string) {
  if (!runtimeId.startsWith("ssh:")) return null;
  const body = runtimeId.slice(4);
  const split = body.split("|");
  if (split.length !== 2) return null;
  return { sshTarget: split[0], containerName: split[1] };
}

function parseEcsRuntimeId(runtimeId: string) {
  if (!runtimeId.startsWith("ecs:")) return null;
  const body = runtimeId.slice(4);
  const split = body.split("|");
  if (split.length !== 2) return null;
  return { cluster: split[0], serviceName: split[1] };
}

function splitStartCommand(command: string) {
  return command
    .trim()
    .split(/\s+/)
    .map((segment) => segment.trim())
    .filter(Boolean);
}

function buildEcsReadyUrl(input: { deploymentId: string; userId: string; serviceName: string }) {
  const template = readTrimmedEnv("ECS_READY_URL_TEMPLATE");
  if (!template) {
    return `${process.env.APP_BASE_URL ?? "http://localhost:3000"}/runtime/${input.deploymentId}`;
  }
  return template
    .replaceAll("{deploymentId}", input.deploymentId)
    .replaceAll("{userId}", input.userId)
    .replaceAll("{service}", input.serviceName);
}

async function runSshCommand(sshTarget: string, command: string) {
  const { Client } = await import("ssh2");
  const { user, host } = parseUserAndHost(sshTarget);
  const privateKeyRaw = process.env.DEPLOY_SSH_PRIVATE_KEY?.trim();
  if (!privateKeyRaw) {
    throw new Error("DEPLOY_SSH_PRIVATE_KEY is required for DEPLOY_PROVIDER=ssh.");
  }
  const privateKey = privateKeyRaw.replace(/\\n/g, "\n");
  const timeoutMs = Number(process.env.OPENCLAW_SSH_TIMEOUT_MS ?? "120000");

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const conn = new Client();
    const timer = setTimeout(() => {
      finish(new Error(`SSH command timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      conn.end();
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    };

    conn
      .on("ready", () => {
        conn.exec(command, (execErr, stream) => {
          if (execErr) {
            finish(execErr);
            return;
          }

          let stderr = "";
          stream.on("data", () => {
            // Consume stdout to avoid backpressure on long-running remote commands.
          });
          stream.stderr.on("data", (data: Buffer) => {
            stderr += data.toString("utf8");
          });

          stream.on("close", (code: number | null) => {
            if (code === 0) {
              finish();
            } else {
              finish(new Error(stderr || `SSH command failed with exit code ${code ?? "unknown"}`));
            }
          });
        });
      })
      .on("error", (error) => finish(error))
      .connect({
        host,
        username: user,
        privateKey,
        readyTimeout: timeoutMs,
      });
  });
}

async function ensureCaddyRoute(sshTarget: string, fqdn: string, hostPort: number) {
  const caddyEmail = process.env.CADDY_EMAIL?.trim() ?? "";
  const caddyRoot = "/var/lib/oneclick/caddy";
  const globalHeader = caddyEmail ? `{\n  email ${caddyEmail}\n}\n\n` : "";
  const caddyfileContent = `${globalHeader}import /etc/caddy/sites/*.caddy\n`;
  const siteBlock = `${fqdn} {\n  reverse_proxy 127.0.0.1:${hostPort}\n}\n`;
  const caddyfileBase64 = Buffer.from(caddyfileContent, "utf8").toString("base64");
  const siteBlockBase64 = Buffer.from(siteBlock, "utf8").toString("base64");

  const remoteScript = [
    "set -e",
    `mkdir -p "${caddyRoot}/sites" "${caddyRoot}/data" "${caddyRoot}/config"`,
    `printf '%s' '${caddyfileBase64}' | base64 -d > "${caddyRoot}/Caddyfile"`,
    `printf '%s' '${siteBlockBase64}' | base64 -d > "${caddyRoot}/sites/${fqdn}.caddy"`,
    `if ! docker ps --format '{{.Names}}' | grep -qx 'oneclick-caddy'; then docker rm -f oneclick-caddy >/dev/null 2>&1 || true && docker run -d --name oneclick-caddy --restart unless-stopped --network host -v "${caddyRoot}/Caddyfile:/etc/caddy/Caddyfile" -v "${caddyRoot}/sites:/etc/caddy/sites" -v "${caddyRoot}/data:/data" -v "${caddyRoot}/config:/config" caddy:2 >/dev/null; fi`,
    `docker exec oneclick-caddy caddy reload --config /etc/caddy/Caddyfile`,
  ].join(" && ");

  await runSshCommand(sshTarget, remoteScript);
}

function toReadyUrl(host: Host, hostPort: number, deploymentId: string) {
  if (host.publicBaseUrl) {
    if (host.publicBaseUrl.includes("{port}")) {
      return host.publicBaseUrl.replace("{port}", String(hostPort));
    }
    return `${host.publicBaseUrl}:${hostPort}`;
  }

  const sshTarget = parseSshTarget(host.dockerHost);
  if (!sshTarget) {
    return `${process.env.APP_BASE_URL ?? "http://localhost:3000"}/runtime/${deploymentId}`;
  }

  const hostname = sshTarget.split("@").pop() ?? sshTarget;
  return `http://${hostname}:${hostPort}`;
}

async function launchViaSsh(input: LaunchInput) {
  if (!input.host) {
    throw new Error("Host is required for DEPLOY_PROVIDER=ssh.");
  }
  const sshTarget = parseSshTarget(input.host.dockerHost);
  if (!sshTarget) {
    throw new Error(`Invalid ssh dockerHost value: ${input.host.dockerHost}`);
  }

  const image = getOpenClawImage();
  const containerPort = getOpenClawPort();
  const startCommand = getOpenClawStartCommand();
  const allowInsecureControlUi = shouldAllowInsecureControlUi();
  const gatewayToken = getGatewayToken();
  const hostPort = buildAssignedPort(input.deploymentId);
  const telegramBotToken = input.telegramBotToken?.trim() || "";
  const openaiApiKey = input.openaiApiKey?.trim() || "";
  const anthropicApiKey = input.anthropicApiKey?.trim() || "";
  const openrouterApiKey = input.openrouterApiKey?.trim() || "";
  const subsidyProxyBaseUrl = input.subsidyProxyBaseUrl?.trim() || "";
  const subsidyProxyToken = input.subsidyProxyToken?.trim() || "";
  const resourceFlags = getDockerResourceFlags();

  const safeUser = sanitizeSegment(input.userId);
  const safeDeployment = sanitizeSegment(input.deploymentId);
  const containerName = buildRuntimeName(input);
  const configBase = process.env.OPENCLAW_CONFIG_MOUNT_BASE ?? "/var/lib/oneclick/openclaw";
  const workspaceSuffix = process.env.OPENCLAW_WORKSPACE_SUFFIX ?? "workspace";
  const userDir = `${configBase}/${safeUser}/${safeDeployment}`;
  const workspaceDir = `${userDir}/${workspaceSuffix}`;

  const remoteScript = [
    `set -e`,
    `>&2 echo "oneclick-debug image=${image} container=${containerName} hostPort=${hostPort} containerPort=${containerPort}"`,
    `mkdir -p "${userDir}" "${workspaceDir}"`,
    `chown -R 1000:1000 "${userDir}" "${workspaceDir}" || true`,
    `docker pull "${image}"`,
    `docker rm -f "${containerName}" >/dev/null 2>&1 || true`,
    `docker run --rm -v "${userDir}:/home/node/.openclaw" -v "${workspaceDir}:/home/node/.openclaw/workspace" "${image}" config set gateway.bind lan`,
    `docker run --rm -v "${userDir}:/home/node/.openclaw" -v "${workspaceDir}:/home/node/.openclaw/workspace" "${image}" config set gateway.auth.token ${shellQuote(gatewayToken)}`,
    ...(allowInsecureControlUi
      ? [
          `docker run --rm -v "${userDir}:/home/node/.openclaw" -v "${workspaceDir}:/home/node/.openclaw/workspace" "${image}" config set gateway.controlUi.allowInsecureAuth true`,
          `docker run --rm -v "${userDir}:/home/node/.openclaw" -v "${workspaceDir}:/home/node/.openclaw/workspace" "${image}" config set gateway.controlUi.dangerouslyDisableDeviceAuth true`,
          `docker run --rm -v "${userDir}:/home/node/.openclaw" -v "${workspaceDir}:/home/node/.openclaw/workspace" "${image}" config set gateway.controlUi.dangerouslyAllowHostHeaderOriginFallback true`,
          `docker run --rm -v "${userDir}:/home/node/.openclaw" -v "${workspaceDir}:/home/node/.openclaw/workspace" "${image}" config set gateway.trustedProxies '["172.16.0.0/12"]'`,
        ]
      : []),
    `docker run -d --name "${containerName}" --restart unless-stopped --memory=${resourceFlags.memory} --memory-swap=${resourceFlags.memory} --cpus=${resourceFlags.cpus} --pids-limit=${resourceFlags.pids} --shm-size=${resourceFlags.shmSize} --log-opt max-size=${resourceFlags.logMaxSize} --log-opt max-file=${resourceFlags.logMaxFiles}${resourceFlags.writableLayerSize ? ` --storage-opt size=${resourceFlags.writableLayerSize}` : ""} -v "${userDir}:/home/node/.openclaw" -v "${workspaceDir}:/home/node/.openclaw/workspace"${telegramBotToken ? ` -e TELEGRAM_BOT_TOKEN=${shellQuote(telegramBotToken)}` : ""}${openaiApiKey ? ` -e OPENAI_API_KEY=${shellQuote(openaiApiKey)}` : ""}${anthropicApiKey ? ` -e ANTHROPIC_API_KEY=${shellQuote(anthropicApiKey)}` : ""}${openrouterApiKey ? ` -e OPENROUTER_API_KEY=${shellQuote(openrouterApiKey)}` : ""}${!openaiApiKey && !anthropicApiKey && !openrouterApiKey && subsidyProxyBaseUrl && subsidyProxyToken ? ` -e OPENAI_API_KEY=${shellQuote(subsidyProxyToken)} -e OPENAI_BASE_URL=${shellQuote(subsidyProxyBaseUrl)} -e OPENAI_API_BASE=${shellQuote(subsidyProxyBaseUrl)}` : ""} -p "${hostPort}:${containerPort}" "${image}" ${startCommand}`,
  ].join(" && ");

  await runSshCommand(sshTarget, remoteScript);
  const runtimeDomain = buildRuntimeUrlFromDomain(input.runtimeSlugSource, input.userId);
  if (runtimeDomain) {
    await ensureCaddyRoute(sshTarget, runtimeDomain.fqdn, hostPort);
  }

  return {
    runtimeId: runtimeIdFromSsh(sshTarget, containerName),
    deployProvider: "ssh",
    image,
    port: containerPort,
    hostPort,
    startCommand,
    hostName: input.host?.name ?? "mock",
    readyUrl: withGatewayToken(
      runtimeDomain?.readyUrl ?? toReadyUrl(input.host, hostPort, input.deploymentId),
      gatewayToken,
    ),
  };
}

async function launchViaEcs(input: LaunchInput) {
  const region = requireEnv("AWS_REGION");
  const cluster = requireEnv("ECS_CLUSTER");
  const subnets = parseCsvEnv("ECS_SUBNET_IDS");
  const securityGroups = parseCsvEnv("ECS_SECURITY_GROUP_IDS");
  const executionRoleArn = requireEnv("ECS_EXECUTION_ROLE_ARN");
  const taskRoleArn = readTrimmedEnv("ECS_TASK_ROLE_ARN");
  const servicePrefix = readTrimmedEnv("ECS_SERVICE_PREFIX") || "oneclick-agent";
  const launchType = readTrimmedEnv("ECS_LAUNCH_TYPE") || "FARGATE";
  const assignPublicIp = (readTrimmedEnv("ECS_ASSIGN_PUBLIC_IP") || "true").toLowerCase() === "false"
    ? "DISABLED"
    : "ENABLED";
  const image = getOpenClawImage();
  const containerPort = getOpenClawPort();
  const startCommand = getOpenClawStartCommand();
  const command = splitStartCommand(startCommand);
  const cpu = readTrimmedEnv("ECS_TASK_CPU") || "512";
  const memory = readTrimmedEnv("ECS_TASK_MEMORY") || "1024";
  const platformVersion = readTrimmedEnv("ECS_PLATFORM_VERSION");
  const serviceName = `${servicePrefix}-${sanitizeNamePart(input.userId, 16)}-${sanitizeNamePart(input.deploymentId, 10)}`.slice(0, 63);
  const family = `${servicePrefix}-${sanitizeNamePart(input.userId, 18)}-${sanitizeNamePart(input.deploymentId, 12)}`.slice(0, 255);
  const containerName = readTrimmedEnv("ECS_CONTAINER_NAME") || "openclaw";
  const awslogsGroup = readTrimmedEnv("ECS_LOG_GROUP");
  const awslogsPrefix = readTrimmedEnv("ECS_LOG_STREAM_PREFIX") || "oneclick";
  const telemetryEnv = readTrimmedEnv("OPENCLAW_TELEMETRY");
  const ecsClient = new ECSClient(buildAwsConfigWithTrimmedCreds(region));
  const configVolumeName = "openclaw-config";
  const configMountPath = "/home/node/.openclaw";
  const initContainerName = `${containerName}-config-init`.slice(0, 255);

  const environment = [
    { name: "OPENCLAW_ALLOW_INSECURE_CONTROL_UI", value: shouldAllowInsecureControlUi() ? "true" : "false" },
    input.telegramBotToken?.trim() ? { name: "TELEGRAM_BOT_TOKEN", value: input.telegramBotToken.trim() } : null,
    input.openaiApiKey?.trim() ? { name: "OPENAI_API_KEY", value: input.openaiApiKey.trim() } : null,
    input.anthropicApiKey?.trim() ? { name: "ANTHROPIC_API_KEY", value: input.anthropicApiKey.trim() } : null,
    input.openrouterApiKey?.trim() ? { name: "OPENROUTER_API_KEY", value: input.openrouterApiKey.trim() } : null,
    input.subsidyProxyToken?.trim() && input.subsidyProxyBaseUrl?.trim() && !input.openaiApiKey && !input.anthropicApiKey && !input.openrouterApiKey
      ? { name: "OPENAI_API_KEY", value: input.subsidyProxyToken.trim() }
      : null,
    input.subsidyProxyToken?.trim() && input.subsidyProxyBaseUrl?.trim() && !input.openaiApiKey && !input.anthropicApiKey && !input.openrouterApiKey
      ? { name: "OPENAI_BASE_URL", value: input.subsidyProxyBaseUrl.trim() }
      : null,
    input.subsidyProxyToken?.trim() && input.subsidyProxyBaseUrl?.trim() && !input.openaiApiKey && !input.anthropicApiKey && !input.openrouterApiKey
      ? { name: "OPENAI_API_BASE", value: input.subsidyProxyBaseUrl.trim() }
      : null,
    telemetryEnv ? { name: "OPENCLAW_TELEMETRY", value: telemetryEnv } : null,
  ].filter((entry): entry is { name: string; value: string } => Boolean(entry));

  const register = await ecsClient.send(
    new RegisterTaskDefinitionCommand({
      family,
      networkMode: "awsvpc",
      requiresCompatibilities: ["FARGATE"],
      cpu,
      memory,
      executionRoleArn,
      taskRoleArn: taskRoleArn || undefined,
      volumes: [
        {
          name: configVolumeName,
        },
      ],
      containerDefinitions: [
        {
          name: initContainerName,
          image,
          essential: false,
          command: ["config", "set", "gateway.bind", "lan"],
          mountPoints: [
            {
              sourceVolume: configVolumeName,
              containerPath: configMountPath,
              readOnly: false,
            },
          ],
          logConfiguration: awslogsGroup
            ? {
                logDriver: "awslogs",
                options: {
                  "awslogs-group": awslogsGroup,
                  "awslogs-region": region,
                  "awslogs-stream-prefix": `${awslogsPrefix}-init`,
                },
              }
            : undefined,
        },
        {
          name: containerName,
          image,
          essential: true,
          command: command.length > 0 ? command : undefined,
          environment,
          dependsOn: [
            {
              containerName: initContainerName,
              condition: "SUCCESS",
            },
          ],
          mountPoints: [
            {
              sourceVolume: configVolumeName,
              containerPath: configMountPath,
              readOnly: false,
            },
          ],
          portMappings: [
            {
              containerPort,
              protocol: "tcp",
            },
          ],
          logConfiguration: awslogsGroup
            ? {
                logDriver: "awslogs",
                options: {
                  "awslogs-group": awslogsGroup,
                  "awslogs-region": region,
                  "awslogs-stream-prefix": awslogsPrefix,
                },
              }
            : undefined,
        },
      ],
    }),
  );

  const taskDefinitionArn = register.taskDefinition?.taskDefinitionArn;
  if (!taskDefinitionArn) {
    throw new Error("ECS did not return a task definition ARN.");
  }

  try {
    await ecsClient.send(
      new CreateServiceCommand({
        cluster,
        serviceName,
        taskDefinition: taskDefinitionArn,
        desiredCount: 1,
        launchType: launchType as "FARGATE" | "EC2" | "EXTERNAL",
        platformVersion: platformVersion || undefined,
        networkConfiguration: {
          awsvpcConfiguration: {
            subnets,
            securityGroups,
            assignPublicIp,
          },
        },
      }),
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const lower = message.toLowerCase();
    const shouldUpdateExisting =
      lower.includes("already exists") || lower.includes("not idempotent");
    if (!shouldUpdateExisting) {
      throw error;
    }
    await ecsClient.send(
      new UpdateServiceCommand({
        cluster,
        service: serviceName,
        taskDefinition: taskDefinitionArn,
        desiredCount: 1,
      }),
    );
  }

  return {
    runtimeId: runtimeIdFromEcs(cluster, serviceName),
    deployProvider: "ecs",
    image,
    port: containerPort,
    hostPort: null,
    startCommand,
    hostName: `ecs:${cluster}`,
    readyUrl: buildEcsReadyUrl({
      deploymentId: input.deploymentId,
      userId: input.userId,
      serviceName,
    }),
  };
}

export async function launchUserContainer(input: LaunchInput) {
  const provider = readTrimmedEnv("DEPLOY_PROVIDER") || "mock";

  if (provider === "ssh") {
    return launchViaSsh(input);
  }

  if (provider === "ecs") {
    return launchViaEcs(input);
  }

  const image = getOpenClawImage();
  const port = getOpenClawPort();
  const startCommand = getOpenClawStartCommand();
  return {
    runtimeId: randomUUID(),
    deployProvider: "mock",
    image,
    port,
    hostPort: null,
    startCommand,
    hostName: input.host?.name ?? "mock",
    readyUrl: `${process.env.APP_BASE_URL ?? "http://localhost:3000"}/runtime/${input.deploymentId}`,
  };
}

export async function destroyUserRuntime(input: DestroyInput) {
  const provider = (input.deployProvider ?? "").trim();
  if (provider === "ssh") {
    const parsed = parseSshRuntimeId(input.runtimeId);
    if (!parsed) {
      throw new Error("Invalid ssh runtime id format.");
    }
    await runSshCommand(
      parsed.sshTarget,
      `docker rm -f "${parsed.containerName}" >/dev/null 2>&1 || true`,
    );
    return;
  }
  if (provider === "ecs") {
    const parsed = parseEcsRuntimeId(input.runtimeId);
    if (!parsed) {
      throw new Error("Invalid ecs runtime id format.");
    }
    const region = requireEnv("AWS_REGION");
    const ecsClient = new ECSClient(buildAwsConfigWithTrimmedCreds(region));
    await ecsClient.send(
      new DeleteServiceCommand({
        cluster: parsed.cluster,
        service: parsed.serviceName,
        force: true,
      }),
    );
    return;
  }
  // For mock provider, destroy is a no-op.
}
