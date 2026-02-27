import { createHash, randomUUID } from "crypto";
import { Client } from "ssh2";
import {
  CreateServiceCommand,
  DeleteServiceCommand,
  ECSClient,
  type ECSClientConfig,
  RegisterTaskDefinitionCommand,
  UpdateServiceCommand,
} from "@aws-sdk/client-ecs";
import {
  CreateRuleCommand,
  CreateTargetGroupCommand,
  DeleteRuleCommand,
  DeleteTargetGroupCommand,
  DescribeRulesCommand,
  DescribeTargetGroupsCommand,
  ElasticLoadBalancingV2Client,
} from "@aws-sdk/client-elastic-load-balancing-v2";
import { getRuntimeBaseDomain } from "@/lib/subdomainConfig";
import { getEcsPlanResources, normalizeDeploymentFlavor, normalizePlanTier, type DeploymentFlavor, type PlanTier } from "@/lib/plans";
import {
  getOpenClawImage,
  getOpenClawPort,
  getOpenClawStartCommand,
  shouldAllowInsecureControlUi,
} from "@/lib/provisioner/openclawBundle";
import { destroyDedicatedVm } from "@/lib/provisioner/dedicatedVm";
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
  planTier?: PlanTier | null;
  deploymentFlavor?: DeploymentFlavor | null;
  providerOverride?: "mock" | "ssh" | "ecs" | null;
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

function sha1Hex(value: string) {
  return createHash("sha1").update(value).digest("hex");
}

type EcsAlbConfig = {
  enabled: boolean;
  httpsListenerArn: string;
  baseDomain: string;
  vpcId: string;
  healthCheckPath: string;
  healthCheckMatcher: string;
  rulePriorityMin: number;
  rulePriorityMax: number;
};

function getEcsAlbConfig(): EcsAlbConfig {
  const enabled = (readTrimmedEnv("ECS_RUNTIME_ALB_ENABLED") || "").toLowerCase() === "true";
  return {
    enabled,
    httpsListenerArn: readTrimmedEnv("ECS_RUNTIME_ALB_HTTPS_LISTENER_ARN"),
    baseDomain: readTrimmedEnv("ECS_RUNTIME_ALB_BASE_DOMAIN"),
    vpcId: readTrimmedEnv("ECS_VPC_ID"),
    healthCheckPath: readTrimmedEnv("ECS_RUNTIME_ALB_HEALTH_PATH") || "/__openclaw/control-ui-config.json",
    healthCheckMatcher: readTrimmedEnv("ECS_RUNTIME_ALB_HEALTH_MATCHER") || "200-499",
    rulePriorityMin: Number(readTrimmedEnv("ECS_RUNTIME_ALB_RULE_PRIORITY_MIN") || "10000"),
    rulePriorityMax: Number(readTrimmedEnv("ECS_RUNTIME_ALB_RULE_PRIORITY_MAX") || "49999"),
  };
}

function requireEcsAlbEnabledConfig(config: EcsAlbConfig) {
  if (!config.enabled) return;
  if (!config.httpsListenerArn) throw new Error("ECS_RUNTIME_ALB_HTTPS_LISTENER_ARN is required when ECS_RUNTIME_ALB_ENABLED=true.");
  if (!config.baseDomain) throw new Error("ECS_RUNTIME_ALB_BASE_DOMAIN is required when ECS_RUNTIME_ALB_ENABLED=true.");
  if (!config.vpcId) throw new Error("ECS_VPC_ID is required when ECS_RUNTIME_ALB_ENABLED=true.");
}

function buildEcsAlbHostLabel(serviceName: string) {
  return `oc-${sha1Hex(serviceName).slice(0, 16)}`;
}

function buildEcsAlbHostName(serviceName: string, baseDomain: string) {
  const domain = baseDomain.replace(/^\*\./, "").replace(/^\./, "").trim();
  return `${buildEcsAlbHostLabel(serviceName)}.${domain}`;
}

function buildEcsAlbTargetGroupName(serviceName: string) {
  return `oc-${sha1Hex(`tg:${serviceName}`).slice(0, 28)}`.slice(0, 32);
}

function buildAlbRulePriority(serviceName: string, min: number, max: number) {
  const span = Math.max(1, max - min + 1);
  const hashInt = Number.parseInt(sha1Hex(`rule:${serviceName}`).slice(0, 8), 16);
  return min + (hashInt % span);
}

async function ensureEcsAlbRouting(input: {
  region: string;
  serviceName: string;
  containerName: string;
  containerPort: number;
}) {
  const alb = getEcsAlbConfig();
  if (!alb.enabled) return null;
  requireEcsAlbEnabledConfig(alb);

  const client = new ElasticLoadBalancingV2Client(buildAwsConfigWithTrimmedCreds(input.region));
  const targetGroupName = buildEcsAlbTargetGroupName(input.serviceName);
  const hostName = buildEcsAlbHostName(input.serviceName, alb.baseDomain);

  let targetGroupArn: string | null = null;
  try {
    const described = await client.send(new DescribeTargetGroupsCommand({ Names: [targetGroupName] }));
    targetGroupArn = described.TargetGroups?.[0]?.TargetGroupArn ?? null;
  } catch (error) {
    const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
    if (!message.includes("not found") && !message.includes("target group") && !message.includes("targetgroupnotfound")) {
      throw error;
    }
  }
  if (!targetGroupArn) {
    const created = await client.send(
      new CreateTargetGroupCommand({
        Name: targetGroupName,
        Protocol: "HTTP",
        Port: input.containerPort,
        VpcId: alb.vpcId,
        TargetType: "ip",
        HealthCheckProtocol: "HTTP",
        HealthCheckPort: "traffic-port",
        HealthCheckEnabled: true,
        HealthCheckPath: alb.healthCheckPath,
        Matcher: { HttpCode: alb.healthCheckMatcher },
      }),
    );
    targetGroupArn = created.TargetGroups?.[0]?.TargetGroupArn ?? null;
  }
  if (!targetGroupArn) {
    throw new Error("Failed to create or resolve ECS runtime ALB target group.");
  }

  const rules = await client.send(new DescribeRulesCommand({ ListenerArn: alb.httpsListenerArn }));
  const existingRule = (rules.Rules ?? []).find((rule) =>
    (rule.Conditions ?? []).some(
      (condition) =>
        condition.Field === "host-header" &&
        (condition.HostHeaderConfig?.Values ?? []).some((value) => value.trim().toLowerCase() === hostName.toLowerCase()),
    ),
  );

  if (!existingRule) {
    const usedPriorities = new Set(
      (rules.Rules ?? [])
        .map((rule) => rule.Priority)
        .filter((priority): priority is string => Boolean(priority) && priority !== "default")
        .map((priority) => Number(priority))
        .filter((priority) => Number.isFinite(priority)),
    );
    let priority = buildAlbRulePriority(input.serviceName, alb.rulePriorityMin, alb.rulePriorityMax);
    const maxAttempts = alb.rulePriorityMax - alb.rulePriorityMin + 1;
    for (let i = 0; i < maxAttempts && usedPriorities.has(priority); i += 1) {
      priority += 1;
      if (priority > alb.rulePriorityMax) priority = alb.rulePriorityMin;
    }
    if (usedPriorities.has(priority)) {
      throw new Error("No free ALB listener rule priority available in configured ECS_RUNTIME_ALB_RULE_PRIORITY range.");
    }
    await client.send(
      new CreateRuleCommand({
        ListenerArn: alb.httpsListenerArn,
        Priority: priority,
        Conditions: [
          {
            Field: "host-header",
            HostHeaderConfig: { Values: [hostName] },
          },
        ],
        Actions: [
          {
            Type: "forward",
            TargetGroupArn: targetGroupArn,
          },
        ],
      }),
    );
  }

  return {
    hostName,
    targetGroupArn,
  };
}

async function cleanupEcsAlbRouting(input: { region: string; serviceName: string }) {
  const alb = getEcsAlbConfig();
  if (!alb.enabled || !alb.httpsListenerArn || !alb.baseDomain) return;
  const client = new ElasticLoadBalancingV2Client(buildAwsConfigWithTrimmedCreds(input.region));
  const hostName = buildEcsAlbHostName(input.serviceName, alb.baseDomain);
  try {
    const rules = await client.send(new DescribeRulesCommand({ ListenerArn: alb.httpsListenerArn }));
    for (const rule of rules.Rules ?? []) {
      const matchesHost = (rule.Conditions ?? []).some(
        (condition) =>
          condition.Field === "host-header" &&
          (condition.HostHeaderConfig?.Values ?? []).some((value) => value.trim().toLowerCase() === hostName.toLowerCase()),
      );
      if (matchesHost && rule.RuleArn) {
        await client.send(new DeleteRuleCommand({ RuleArn: rule.RuleArn }));
      }
    }
  } catch {
    // best-effort cleanup
  }
  try {
    const targetGroupName = buildEcsAlbTargetGroupName(input.serviceName);
    const described = await client.send(new DescribeTargetGroupsCommand({ Names: [targetGroupName] }));
    const tgArn = described.TargetGroups?.[0]?.TargetGroupArn;
    if (tgArn) {
      await client.send(new DeleteTargetGroupCommand({ TargetGroupArn: tgArn }));
    }
  } catch {
    // best-effort cleanup
  }
}

function readEnvLimit(key: string, fallback: string) {
  const value = process.env[key]?.trim();
  return value && value.length > 0 ? value : fallback;
}

function readOptionalEnv(key: string) {
  const value = process.env[key]?.trim();
  return value && value.length > 0 ? value : "";
}

function getDockerResourceFlags(planTier: PlanTier) {
  const memory =
    readOptionalEnv(planTier === "paid" ? "OPENCLAW_LIMIT_MEMORY_PAID" : "OPENCLAW_LIMIT_MEMORY_FREE") ||
    readOptionalEnv("OPENCLAW_LIMIT_MEMORY") ||
    (planTier === "paid" ? "2g" : "1536m");
  const cpus =
    readOptionalEnv(planTier === "paid" ? "OPENCLAW_LIMIT_CPUS_PAID" : "OPENCLAW_LIMIT_CPUS_FREE") ||
    readOptionalEnv("OPENCLAW_LIMIT_CPUS") ||
    (planTier === "paid" ? "1" : "0.75");
  const pids = readEnvLimit("OPENCLAW_LIMIT_PIDS", "256");
  const shmSize = readEnvLimit("OPENCLAW_LIMIT_SHM", "256m");
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

function buildEcsOpenClawStateDir(input: { userId: string; deploymentId: string }) {
  const user = sanitizeSegment(input.userId);
  const deployment = sanitizeSegment(input.deploymentId);
  return `${user}/${deployment}`;
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

function runtimeIdFromSsh(sshTarget: string, containerName: string, vmId?: string) {
  if (vmId?.trim()) {
    return `ssh:${sshTarget}|${containerName}|${vmId.trim()}`;
  }
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
  if (split.length < 2) return null;
  return {
    sshTarget: split[0],
    containerName: split[1],
    vmId: split[2]?.trim() || null,
  };
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

function buildOpenClawOnboardCommand(input: {
  anthropicApiKey?: string | null;
  openaiApiKey?: string | null;
  openrouterApiKey?: string | null;
  subsidyProxyToken?: string | null;
  containerPort: number;
}) {
  const anthropicApiKey = input.anthropicApiKey?.trim() || "";
  const openaiApiKey = input.openaiApiKey?.trim() || "";
  const openrouterApiKey = input.openrouterApiKey?.trim() || "";
  const subsidyProxyToken = input.subsidyProxyToken?.trim() || "";

  const authArg = anthropicApiKey
    ? `--anthropic-api-key ${shellQuote(anthropicApiKey)}`
    : openaiApiKey
      ? `--openai-api-key ${shellQuote(openaiApiKey)}`
      : openrouterApiKey
        ? `--openai-api-key ${shellQuote(openrouterApiKey)}`
        : subsidyProxyToken
          ? `--openai-api-key ${shellQuote(subsidyProxyToken)}`
          : "";

  if (!authArg) return "";

  return [
    "node /app/dist/index.js onboard",
    "--non-interactive",
    "--accept-risk",
    "--mode local",
    "--auth-choice apiKey",
    authArg,
    `--gateway-port ${input.containerPort}`,
    "--gateway-bind lan",
    "--skip-daemon",
    "--skip-channels",
    "--skip-health",
    "--skip-ui",
    "--skip-skills",
  ].join(" ");
}

function getAdvancedBootstrapMessage() {
  return "Please follow the instructions to join ottoauth: curl -s https://ottoauth.vercel.app/skill.md";
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

async function runSshCommand(sshTarget: string, command: string, timeoutMsOverride?: number) {
  const { user, host } = parseUserAndHost(sshTarget);
  const privateKeyRaw = process.env.DEPLOY_SSH_PRIVATE_KEY?.trim();
  if (!privateKeyRaw) {
    throw new Error("DEPLOY_SSH_PRIVATE_KEY is required for DEPLOY_PROVIDER=ssh.");
  }
  const privateKey = privateKeyRaw.replace(/\\n/g, "\n");
  const timeoutMs = timeoutMsOverride ?? Number(process.env.OPENCLAW_SSH_TIMEOUT_MS ?? "600000");

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
  const telegramEnabled = telegramBotToken ? "true" : "false";
  const openaiApiKey = input.openaiApiKey?.trim() || "";
  const anthropicApiKey = input.anthropicApiKey?.trim() || "";
  const openrouterApiKey = input.openrouterApiKey?.trim() || "";
  const subsidyProxyBaseUrl = input.subsidyProxyBaseUrl?.trim() || "";
  const subsidyProxyToken = input.subsidyProxyToken?.trim() || "";
  const planTier = normalizePlanTier(input.planTier);
  const resourceFlags = getDockerResourceFlags(planTier);
  const openclawNodeOptions = readTrimmedEnv("OPENCLAW_NODE_OPTIONS") || "--max-old-space-size=1536";
  const onboardCommand = buildOpenClawOnboardCommand({
    anthropicApiKey,
    openaiApiKey,
    openrouterApiKey,
    subsidyProxyToken,
    containerPort,
  });
  const runSshOnboard = (readTrimmedEnv("OPENCLAW_SSH_RUN_ONBOARD") || "false").toLowerCase() === "true";
  const setTelegramPluginConfig =
    (readTrimmedEnv("OPENCLAW_SSH_SET_TELEGRAM_PLUGIN_CONFIG") || "false").toLowerCase() === "true";

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
    `if ! command -v docker >/dev/null 2>&1; then >&2 echo "[oneclick] waiting briefly for cloud-init"; if command -v cloud-init >/dev/null 2>&1; then timeout 180 cloud-init status --wait || true; fi; fi`,
    `if ! command -v docker >/dev/null 2>&1; then >&2 echo "[oneclick] installing docker via apt"; export DEBIAN_FRONTEND=noninteractive; for i in $(seq 1 30); do if apt-get -o DPkg::Lock::Timeout=120 update -y && apt-get -o DPkg::Lock::Timeout=120 install -y docker.io; then break; fi; sleep 5; done; fi`,
    `if command -v docker >/dev/null 2>&1; then systemctl enable docker || true; systemctl restart docker || true; fi`,
    `for i in $(seq 1 120); do if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then break; fi; sleep 2; done`,
    `if ! command -v docker >/dev/null 2>&1 || ! docker info >/dev/null 2>&1; then >&2 echo "[oneclick] docker install/daemon startup failed"; exit 1; fi`,
    `mkdir -p "${userDir}" "${workspaceDir}"`,
    `chown -R 1000:1000 "${userDir}" "${workspaceDir}" || true`,
    `docker pull "${image}"`,
    `docker rm -f "${containerName}" >/dev/null 2>&1 || true`,
    ...(telegramBotToken && setTelegramPluginConfig
      ? [
          `docker run --rm -v "${userDir}:/home/node/.openclaw" -v "${workspaceDir}:/home/node/.openclaw/workspace" "${image}" config set plugins.entries.telegram.enabled true`,
        ]
      : []),
    ...(onboardCommand && runSshOnboard
      ? [
          `docker run --rm --entrypoint sh -v "${userDir}:/home/node/.openclaw" -v "${workspaceDir}:/home/node/.openclaw/workspace"${telegramBotToken ? ` -e TELEGRAM_BOT_TOKEN=${shellQuote(telegramBotToken)}` : ""}${openaiApiKey ? ` -e OPENAI_API_KEY=${shellQuote(openaiApiKey)}` : ""}${anthropicApiKey ? ` -e ANTHROPIC_API_KEY=${shellQuote(anthropicApiKey)}` : ""}${openrouterApiKey ? ` -e OPENROUTER_API_KEY=${shellQuote(openrouterApiKey)}` : ""}${subsidyProxyBaseUrl && subsidyProxyToken && !openaiApiKey && !anthropicApiKey && !openrouterApiKey ? ` -e OPENAI_BASE_URL=${shellQuote(subsidyProxyBaseUrl)} -e OPENAI_API_BASE=${shellQuote(subsidyProxyBaseUrl)}` : ""} "${image}" -lc ${shellQuote(`timeout 120 ${onboardCommand}`)}`,
        ]
      : []),
    `docker run -d --name "${containerName}" --restart unless-stopped --memory=${resourceFlags.memory} --memory-swap=${resourceFlags.memory} --cpus=${resourceFlags.cpus} --pids-limit=${resourceFlags.pids} --shm-size=${resourceFlags.shmSize} --log-opt max-size=${resourceFlags.logMaxSize} --log-opt max-file=${resourceFlags.logMaxFiles}${resourceFlags.writableLayerSize ? ` --storage-opt size=${resourceFlags.writableLayerSize}` : ""} -v "${userDir}:/home/node/.openclaw" -v "${workspaceDir}:/home/node/.openclaw/workspace" -e OPENCLAW_GATEWAY_TOKEN=${shellQuote(gatewayToken)} -e OPENCLAW_ALLOW_INSECURE_CONTROL_UI=${allowInsecureControlUi ? "true" : "false"} -e NODE_OPTIONS=${shellQuote(openclawNodeOptions)} -e TELEGRAM_ENABLED=${telegramEnabled}${telegramBotToken ? ` -e TELEGRAM_BOT_TOKEN=${shellQuote(telegramBotToken)}` : ""}${openaiApiKey ? ` -e OPENAI_API_KEY=${shellQuote(openaiApiKey)}` : ""}${anthropicApiKey ? ` -e ANTHROPIC_API_KEY=${shellQuote(anthropicApiKey)}` : ""}${openrouterApiKey ? ` -e OPENROUTER_API_KEY=${shellQuote(openrouterApiKey)}` : ""}${!openaiApiKey && !anthropicApiKey && !openrouterApiKey && subsidyProxyBaseUrl && subsidyProxyToken ? ` -e OPENAI_API_KEY=${shellQuote(subsidyProxyToken)} -e OPENAI_BASE_URL=${shellQuote(subsidyProxyBaseUrl)} -e OPENAI_API_BASE=${shellQuote(subsidyProxyBaseUrl)}` : ""} -p "${hostPort}:${containerPort}" "${image}" ${startCommand}`,
  ].join(" && ");

  const launchTimeoutMs = Number(readTrimmedEnv("OPENCLAW_SSH_LAUNCH_TIMEOUT_MS") || "1800000");
  await runSshCommand(sshTarget, remoteScript, launchTimeoutMs);
  const runtimeDomain = buildRuntimeUrlFromDomain(input.runtimeSlugSource, input.userId);
  if (runtimeDomain) {
    await ensureCaddyRoute(sshTarget, runtimeDomain.fqdn, hostPort);
  }

  return {
    runtimeId: runtimeIdFromSsh(sshTarget, containerName, input.host?.vmId),
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
  const gatewayToken = getGatewayToken();
  const containerPort = getOpenClawPort();
  const startCommand = getOpenClawStartCommand();
  const command = splitStartCommand(startCommand);
  const isPhioranexOpenClawImage = image.toLowerCase().includes("ghcr.io/phioranex/openclaw-docker");
  const planTier = normalizePlanTier(input.planTier);
  const deploymentFlavor = normalizeDeploymentFlavor(input.deploymentFlavor);
  const { cpu, memory } = getEcsPlanResources(planTier);
  const platformVersion = readTrimmedEnv("ECS_PLATFORM_VERSION");
  const serviceName = `${servicePrefix}-${sanitizeNamePart(input.userId, 16)}-${sanitizeNamePart(input.deploymentId, 10)}`.slice(0, 63);
  const family = `${servicePrefix}-${sanitizeNamePart(input.userId, 18)}-${sanitizeNamePart(input.deploymentId, 12)}`.slice(0, 255);
  const containerName = readTrimmedEnv("ECS_CONTAINER_NAME") || "openclaw";
  const awslogsGroup = readTrimmedEnv("ECS_LOG_GROUP");
  const awslogsPrefix = readTrimmedEnv("ECS_LOG_STREAM_PREFIX") || "oneclick";
  const telemetryEnv = readTrimmedEnv("OPENCLAW_TELEMETRY");
  const openclawNodeOptions = readTrimmedEnv("OPENCLAW_NODE_OPTIONS") || "--max-old-space-size=1536";
  const efsFileSystemId = readTrimmedEnv("ECS_EFS_FILE_SYSTEM_ID");
  const efsAccessPointId = readTrimmedEnv("ECS_EFS_ACCESS_POINT_ID");
  const efsTransitEncryption = (readTrimmedEnv("ECS_EFS_TRANSIT_ENCRYPTION") || "ENABLED").toUpperCase();
  const efsContainerMountPath = readTrimmedEnv("ECS_EFS_CONTAINER_MOUNT_PATH") || "/mnt/oneclick-efs";
  const workspaceSuffix = readTrimmedEnv("OPENCLAW_WORKSPACE_SUFFIX") || "workspace";
  const efsEnabled = Boolean(efsFileSystemId);
  const efsTransitEncryptionMode: "ENABLED" | "DISABLED" =
    efsTransitEncryption === "DISABLED" ? "DISABLED" : "ENABLED";
  const configVolumeName = "openclaw-data";
  const ecsClient = new ECSClient(buildAwsConfigWithTrimmedCreds(region));
  const albRouting = await ensureEcsAlbRouting({
    region,
    serviceName,
    containerName,
    containerPort,
  });

  const environment = [
    { name: "OPENCLAW_GATEWAY_TOKEN", value: gatewayToken },
    { name: "OPENCLAW_ALLOW_INSECURE_CONTROL_UI", value: shouldAllowInsecureControlUi() ? "true" : "false" },
    { name: "TELEGRAM_ENABLED", value: input.telegramBotToken?.trim() ? "true" : "false" },
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
    openclawNodeOptions ? { name: "NODE_OPTIONS", value: openclawNodeOptions } : null,
    telemetryEnv ? { name: "OPENCLAW_TELEMETRY", value: telemetryEnv } : null,
  ].filter((entry): entry is { name: string; value: string } => Boolean(entry));

  const containerMountPoints = efsEnabled
    ? [
        {
          sourceVolume: configVolumeName,
          containerPath: efsContainerMountPath,
          readOnly: false,
        },
      ]
    : undefined;

  const entryPointOverride = isPhioranexOpenClawImage ? ["sh", "-lc"] : undefined;
  const commandOverride = (() => {
    if (isPhioranexOpenClawImage) {
      const onboardCommand = buildOpenClawOnboardCommand({
        anthropicApiKey: input.anthropicApiKey,
        openaiApiKey: input.openaiApiKey,
        openrouterApiKey: input.openrouterApiKey,
        subsidyProxyToken: input.subsidyProxyToken,
        containerPort,
      });
      const usesSubsidyFallback =
        Boolean(input.subsidyProxyToken?.trim()) &&
        Boolean(input.subsidyProxyBaseUrl?.trim()) &&
        !input.openaiApiKey?.trim() &&
        !input.anthropicApiKey?.trim() &&
        !input.openrouterApiKey?.trim();
      const scriptSteps = [
        "set -e",
        "mkdir -p /tmp/oneclick-bin",
        `printf '%s\\n' '#!/bin/sh' 'exec node /app/dist/index.js "$@"' > /tmp/oneclick-bin/openclaw`,
        "chmod +x /tmp/oneclick-bin/openclaw",
        'export PATH="/tmp/oneclick-bin:$PATH"',
      ];
      if (efsEnabled) {
        const stateSuffix = buildEcsOpenClawStateDir({ userId: input.userId, deploymentId: input.deploymentId });
        const stateDir = `${efsContainerMountPath}/${stateSuffix}`;
        const workspaceDir = `${stateDir}/${workspaceSuffix}`;
        scriptSteps.push(
          `mkdir -p ${shellQuote(workspaceDir)}`,
          "rm -rf /home/node/.openclaw || true",
          `ln -s ${shellQuote(stateDir)} /home/node/.openclaw`,
        );
      }
      scriptSteps.push(
        "node /app/dist/index.js config set gateway.bind lan || true",
        `node /app/dist/index.js config set gateway.auth.token ${shellQuote(gatewayToken)} || true`,
      );
      if (input.telegramBotToken?.trim()) {
        scriptSteps.push(
          "node /app/dist/index.js config set channels.telegram.enabled true || node /app/dist/index.js config set plugins.entries.telegram.enabled true || true",
        );
      }
      if (shouldAllowInsecureControlUi()) {
        scriptSteps.push(
          "node /app/dist/index.js config set gateway.controlUi.allowInsecureAuth true || true",
          "node /app/dist/index.js config set gateway.controlUi.dangerouslyDisableDeviceAuth true || true",
        );
      }
      if (onboardCommand) {
        if (usesSubsidyFallback) {
          // Subsidy mode relies on env-based OpenAI-compatible auth; onboarding is memory-heavy and can OOM free-tier tasks.
          scriptSteps.push("echo '[oneclick] skipping onboard bootstrap for subsidy fallback' >&2");
        } else {
          // Keep gateway startup fast/reliable; run onboarding asynchronously so failures do not block container readiness.
          scriptSteps.push(
            "echo '[oneclick] starting onboarding in background' >&2",
            [
              "( ",
              `${onboardCommand} >/tmp/oneclick-onboard.log 2>&1 || true;`,
              ...(shouldAllowInsecureControlUi()
                ? [
                    "echo '[oneclick] reapply control UI auth flags after onboard' >&2;",
                    "node /app/dist/index.js config set gateway.controlUi.allowInsecureAuth true || true;",
                    "node /app/dist/index.js config set gateway.controlUi.dangerouslyDisableDeviceAuth true || true;",
                  ]
                : []),
              " ) &",
            ].join(" "),
          );
        }
      }
      if (deploymentFlavor === "advanced") {
        const advancedMessage = shellQuote(getAdvancedBootstrapMessage());
        scriptSteps.push(
          "BOOTSTRAP_SENTINEL=/home/node/.openclaw/.oneclick-advanced-ottoauth-sent",
          [
            "( if [ ! -f \"$BOOTSTRAP_SENTINEL\" ]; then",
            "for i in $(seq 1 60); do",
            "if openclaw health >/dev/null 2>&1; then break; fi;",
            "sleep 5;",
            "done;",
            "sleep 2;",
            `openclaw agent --session-id main --message ${advancedMessage} >/tmp/oneclick-advanced-bootstrap.log 2>&1 && touch \"$BOOTSTRAP_SENTINEL\" || true;`,
            "fi ) &",
          ].join(" "),
        );
      }
      scriptSteps.push(
        "echo '[oneclick] patch control UI unsupported-schema copy' >&2",
        [
          "for f in /app/dist/control-ui/assets/index-*.js; do",
          "[ -f \"$f\" ] || continue;",
          "sed -i 's/Unsupported schema node\\\\. Use Raw mode\\\\./Advanced field uses Raw mode./g' \"$f\" || true;",
          "done",
        ].join(" "),
      );
      scriptSteps.push(
        "echo '[oneclick] starting control UI device auto-approve loop' >&2",
        [
          "( for i in $(seq 1 60); do",
          "openclaw health >/dev/null 2>&1 && break;",
          "sleep 2;",
          "done;",
          "while :; do",
          "out=\"$(node /app/dist/index.js devices approve --latest 2>&1 || true)\";",
          "case \"$out\" in",
          "\"\"|\"No pending device pairing requests to approve\") ;;",
          "Approved*) echo \"[oneclick] $out\" >&2 ;;",
          "*) ;;",
          "esac;",
          "sleep 3;",
          "done ) &",
        ].join(" "),
      );
      scriptSteps.push(
        "echo '[oneclick] starting openclaw gateway' >&2",
        `exec node /app/dist/index.js gateway run --allow-unconfigured --bind lan --token ${shellQuote(gatewayToken)}`,
      );
      return [scriptSteps.join("\n")];
    }

    if (!efsEnabled) return command.length > 0 ? command : undefined;
    const stateSuffix = buildEcsOpenClawStateDir({ userId: input.userId, deploymentId: input.deploymentId });
    const stateDir = `${efsContainerMountPath}/${stateSuffix}`;
    const workspaceDir = `${stateDir}/${workspaceSuffix}`;
    return [
      "sh",
      "-lc",
      [
        "set -e",
        `mkdir -p ${shellQuote(workspaceDir)}`,
        `rm -rf /home/node/.openclaw || true`,
        `ln -s ${shellQuote(stateDir)} /home/node/.openclaw`,
        `exec ${startCommand}`,
      ].join("; "),
    ];
  })();

  const taskVolumes = efsFileSystemId
    ? [
        {
          name: configVolumeName,
          efsVolumeConfiguration: {
            fileSystemId: efsFileSystemId,
            transitEncryption: efsTransitEncryptionMode,
            authorizationConfig: efsAccessPointId
              ? {
                  accessPointId: efsAccessPointId,
                  iam: "DISABLED" as const,
                }
              : undefined,
          },
        },
      ]
    : [
        {
          name: configVolumeName,
        },
      ];

  const register = await ecsClient.send(
    new RegisterTaskDefinitionCommand({
      family,
      networkMode: "awsvpc",
      requiresCompatibilities: ["FARGATE"],
      cpu,
      memory,
      executionRoleArn,
      taskRoleArn: taskRoleArn || undefined,
      volumes: taskVolumes,
      containerDefinitions: [
        {
          name: containerName,
          image,
          entryPoint: entryPointOverride,
          essential: true,
          command: commandOverride,
          environment,
          mountPoints: containerMountPoints,
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
        loadBalancers: albRouting
          ? [
              {
                targetGroupArn: albRouting.targetGroupArn,
                containerName,
                containerPort,
              },
            ]
          : undefined,
        healthCheckGracePeriodSeconds: albRouting ? 300 : undefined,
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
        loadBalancers: albRouting
          ? [
              {
                targetGroupArn: albRouting.targetGroupArn,
                containerName,
                containerPort,
              },
            ]
          : undefined,
        healthCheckGracePeriodSeconds: albRouting ? 300 : undefined,
      }),
    );
  }

  const readyUrlBase = albRouting
    ? `https://${albRouting.hostName}/`
    : buildEcsReadyUrl({
        deploymentId: input.deploymentId,
        userId: input.userId,
        serviceName,
      });

  return {
    runtimeId: runtimeIdFromEcs(cluster, serviceName),
    deployProvider: "ecs",
    image,
    port: containerPort,
    hostPort: null,
    startCommand,
    hostName: albRouting?.hostName ?? `ecs:${cluster}`,
    readyUrl: withGatewayToken(readyUrlBase, gatewayToken),
  };
}

export async function launchUserContainer(input: LaunchInput) {
  const provider = input.providerOverride ?? (readTrimmedEnv("DEPLOY_PROVIDER") || "mock");

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
    let dockerCleanupError: Error | null = null;
    try {
      await runSshCommand(
        parsed.sshTarget,
        `if command -v docker >/dev/null 2>&1; then docker rm -f "${parsed.containerName}" >/dev/null 2>&1 || true; fi`,
      );
    } catch (error) {
      dockerCleanupError = error instanceof Error ? error : new Error(String(error));
    }
    if (parsed.vmId) {
      await destroyDedicatedVm(parsed.vmId);
      return;
    }
    if (dockerCleanupError) {
      throw dockerCleanupError;
    }
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
    await cleanupEcsAlbRouting({ region, serviceName: parsed.serviceName });
    return;
  }
  // For mock provider, destroy is a no-op.
}
