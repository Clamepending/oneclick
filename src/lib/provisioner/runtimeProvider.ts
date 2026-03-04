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
import {
  getEcsPlanResources,
  isOttoAuthEcsFlavor,
  normalizeDeploymentFlavor,
  normalizePlanTier,
  type DeploymentFlavor,
  type PlanTier,
} from "@/lib/plans";
import {
  getOttoAgentBuildRepo,
  getOttoAgentMcpBuildRepo,
  getOttoAgentMcpImage,
  getOttoAgentMcpPath,
  getOttoAgentMcpPort,
  getOttoAgentMcpStartCommand,
  getRuntimeImage,
  getRuntimePort,
  getRuntimeStartCommand,
  getSimpleAgentBuildRepo,
  getVideoMemoryBuildRepo,
  getVideoMemoryImage,
  getVideoMemoryPort,
  getVideoMemoryStartCommand,
  shouldBuildOttoAgentImage,
  shouldBuildOttoAgentMcpImage,
  shouldBuildSimpleAgentImage,
  shouldBuildVideoMemoryImage,
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
  providerOverride?: "mock" | "ssh" | "ecs" | "lambda" | null;
  ecsServicePrefixOverride?: string | null;
  host?: Host;
};

type DestroyInput = {
  runtimeId: string;
  deployProvider: string | null;
  readyUrl?: string | null;
  hostName?: string | null;
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

function readBoolEnv(name: string, fallback = false) {
  const value = readTrimmedEnv(name).toLowerCase();
  if (!value) return fallback;
  if (["1", "true", "yes", "on"].includes(value)) return true;
  if (["0", "false", "no", "off"].includes(value)) return false;
  return fallback;
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
  healthCheckPath?: string | null;
}) {
  const alb = getEcsAlbConfig();
  if (!alb.enabled) return null;
  requireEcsAlbEnabledConfig(alb);

  const client = new ElasticLoadBalancingV2Client(buildAwsConfigWithTrimmedCreds(input.region));
  const targetGroupName = buildEcsAlbTargetGroupName(input.serviceName);
  const hostName = buildEcsAlbHostName(input.serviceName, alb.baseDomain);

  const healthCheckPath =
    input.healthCheckPath?.trim() ||
    alb.healthCheckPath;

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
        HealthCheckPath: healthCheckPath,
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
  void planTier;
  const memory = readOptionalEnv("OPENCLAW_LIMIT_MEMORY") || "2g";
  const cpus = readOptionalEnv("OPENCLAW_LIMIT_CPUS") || "1";
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

function appendContainerSuffix(baseName: string, suffix: string) {
  const maxLength = 63;
  const normalizedSuffix = suffix.startsWith("-") ? suffix : `-${suffix}`;
  if (baseName.length + normalizedSuffix.length <= maxLength) {
    return `${baseName}${normalizedSuffix}`;
  }

  // Keep names deterministic and unique even when baseName already reaches Docker's 63-char limit.
  const hash = sha1Hex(`${baseName}${normalizedSuffix}`).slice(0, 8);
  const reserved = normalizedSuffix.length + hash.length + 1; // trailing "-{hash}"
  const keepLength = Math.max(1, maxLength - reserved);
  const trimmedBase = baseName.slice(0, keepLength);
  return `${trimmedBase}-${hash}${normalizedSuffix}`.slice(0, maxLength);
}

function buildVideoMemoryContainerName(containerName: string) {
  return appendContainerSuffix(containerName, "videomemory");
}

function buildOttoAgentMcpContainerName(containerName: string) {
  return appendContainerSuffix(containerName, "ottoagent-mcp");
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
  const hex = sha1Hex(deploymentId).slice(0, 8);
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

function normalizeHostCandidate(value: string | null | undefined) {
  const trimmed = (value ?? "").trim();
  if (!trimmed) return "";
  const first = trimmed.split(",")[0]?.trim() || "";
  if (!first) return "";

  const withScheme = first.includes("://") ? first : `http://${first}`;
  try {
    return new URL(withScheme).hostname.trim();
  } catch {
    return "";
  }
}

function isUnusablePublicHost(value: string) {
  const host = value.trim().toLowerCase();
  if (!host) return true;
  if (host === "0.0.0.0" || host === "::" || host === "localhost") return true;
  if (host.startsWith("127.")) return true;
  return false;
}

function normalizeMcpPath(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return "/mcp";
  if (!trimmed.startsWith("/")) return `/${trimmed}`;
  return trimmed;
}

function isIpv4Address(value: string) {
  return /^(?:\d{1,3}\.){3}\d{1,3}$/.test(value.trim());
}

function getCloudflareConfig() {
  const token = readTrimmedEnv("CLOUDFLARE_API_TOKEN");
  const zoneId = readTrimmedEnv("CLOUDFLARE_ZONE_ID");
  return {
    token,
    zoneId,
    enabled: Boolean(token && zoneId),
  };
}

async function cloudflareRequest(path: string, init?: RequestInit) {
  const config = getCloudflareConfig();
  if (!config.enabled) {
    throw new Error("Cloudflare DNS automation requires CLOUDFLARE_API_TOKEN and CLOUDFLARE_ZONE_ID.");
  }
  const response = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${config.token}`,
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  const payload = (await response.json().catch(() => ({}))) as {
    success?: boolean;
    errors?: Array<{ message?: string }>;
    result?: unknown;
  };
  if (!response.ok || !payload.success) {
    const reason =
      payload.errors?.map((error) => error.message).filter(Boolean).join("; ") ||
      `HTTP ${response.status} ${response.statusText}`;
    throw new Error(`Cloudflare API request failed: ${reason}`);
  }
  return payload;
}

type CloudflareDnsRecord = {
  id: string;
  type: string;
  name: string;
  content: string;
  comment?: string;
};

async function upsertRuntimeDnsRecord(input: { fqdn: string; target: string }) {
  const config = getCloudflareConfig();
  if (!config.enabled) {
    throw new Error(
      "CLOUDFLARE_API_TOKEN and CLOUDFLARE_ZONE_ID are required for SSH runtime domain provisioning.",
    );
  }
  const fqdn = input.fqdn.trim().toLowerCase();
  const target = input.target.trim();
  if (!fqdn || !target) {
    throw new Error("Runtime DNS upsert requires both fqdn and target.");
  }
  const recordType = isIpv4Address(target) ? "A" : "CNAME";
  const list = (await cloudflareRequest(
    `/zones/${config.zoneId}/dns_records?name=${encodeURIComponent(fqdn)}`,
  )) as { result?: CloudflareDnsRecord[] };
  const existing = (list.result ?? []).find((record) => record.name.toLowerCase() === fqdn);
  const body = JSON.stringify({
    type: recordType,
    name: fqdn,
    content: target,
    ttl: 120,
    proxied: false,
    comment: "managed-by-oneclick-runtime",
  });
  if (existing) {
    await cloudflareRequest(`/zones/${config.zoneId}/dns_records/${existing.id}`, {
      method: "PUT",
      body,
    });
    return;
  }
  await cloudflareRequest(`/zones/${config.zoneId}/dns_records`, {
    method: "POST",
    body,
  });
}

function hostNameFromReadyUrl(readyUrl: string | null | undefined) {
  if (!readyUrl) return "";
  try {
    return new URL(readyUrl).hostname.trim().toLowerCase();
  } catch {
    return "";
  }
}

async function deleteRuntimeDnsRecordByHost(hostname: string) {
  const config = getCloudflareConfig();
  if (!config.enabled) return;
  const normalizedHost = hostname.trim().toLowerCase();
  if (!normalizedHost) return;
  const runtimeBaseDomain = getRuntimeBaseDomain();
  if (!runtimeBaseDomain || !normalizedHost.endsWith(`.${runtimeBaseDomain}`)) return;
  const list = (await cloudflareRequest(
    `/zones/${config.zoneId}/dns_records?name=${encodeURIComponent(normalizedHost)}`,
  )) as { result?: CloudflareDnsRecord[] };
  for (const record of list.result ?? []) {
    if (record.name.toLowerCase() !== normalizedHost) continue;
    const isManaged = (record.comment ?? "").includes("managed-by-oneclick-runtime");
    if (!isManaged) continue;
    await cloudflareRequest(`/zones/${config.zoneId}/dns_records/${record.id}`, {
      method: "DELETE",
    });
  }
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

function runtimeIdFromLambda(deploymentId: string) {
  return `lambda:${deploymentId}`;
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

function parseDedicatedVmIdFromHostName(hostName: string | null | undefined) {
  const normalized = (hostName ?? "").trim();
  if (!normalized) return null;
  const match = normalized.match(/^(?:lightsail-vm|do-vm)-(\d+)$/);
  return match?.[1] ?? null;
}

function resolveRuntimeDestroyProvider(deployProvider: string | null | undefined, runtimeId: string) {
  const normalized = (deployProvider ?? "").trim().toLowerCase();
  if (normalized === "ssh" || normalized === "ecs" || normalized === "shared" || normalized === "mock" || normalized === "lambda") {
    return normalized;
  }
  if (runtimeId.startsWith("ssh:")) return "ssh";
  if (runtimeId.startsWith("ecs:")) return "ecs";
  if (runtimeId.startsWith("shared:")) return "shared";
  if (runtimeId.startsWith("lambda:")) return "lambda";
  return normalized;
}

function resolveAppBaseUrl() {
  const candidates = [
    readTrimmedEnv("APP_BASE_URL"),
    readTrimmedEnv("AUTH_URL"),
    readTrimmedEnv("VERCEL_PROJECT_PRODUCTION_URL"),
    readTrimmedEnv("VERCEL_URL"),
  ].filter(Boolean);
  const raw = candidates[0] || "http://localhost:3000";
  const withProtocol = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  try {
    const parsed = new URL(withProtocol);
    parsed.pathname = "/";
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString().replace(/\/$/, "");
  } catch {
    return "http://localhost:3000";
  }
}

async function launchViaLambda(input: LaunchInput) {
  const deploymentFlavor = normalizeDeploymentFlavor(input.deploymentFlavor);
  const baseUrl = resolveAppBaseUrl();
  return {
    runtimeId: runtimeIdFromLambda(input.deploymentId),
    deployProvider: "lambda" as const,
    image: "serverless-runtime",
    port: getRuntimePort(deploymentFlavor),
    hostPort: null,
    startCommand: "",
    hostName: "lambda",
    readyUrl: `${baseUrl}/runtime/${input.deploymentId}`,
  };
}

function isIgnorableEcsDeleteError(error: unknown) {
  if (!error || typeof error !== "object") return false;
  const name = String((error as { name?: unknown }).name ?? "").toLowerCase();
  const type = String((error as { __type?: unknown }).__type ?? "").toLowerCase();
  const message = String((error as { message?: unknown }).message ?? "").toLowerCase();
  return (
    name.includes("servicenotfound") ||
    type.includes("servicenotfound") ||
    message.includes("servicenotfound") ||
    message.includes("service not found") ||
    message.includes("serviceinactive")
  );
}

function splitStartCommand(command: string) {
  return command
    .trim()
    .split(/\s+/)
    .map((segment) => segment.trim())
    .filter(Boolean);
}

function parseGitRepoSpec(repo: string) {
  const trimmed = repo.trim();
  if (!trimmed) return { url: "", ref: "" };
  const hashIndex = trimmed.lastIndexOf("#");
  if (hashIndex <= 0) {
    return { url: trimmed, ref: "" };
  }
  return {
    url: trimmed.slice(0, hashIndex),
    ref: trimmed.slice(hashIndex + 1).trim(),
  };
}

function getBuiltinOttoAuthMcpBridgeDockerfile() {
  return [
    "FROM node:20-alpine",
    "WORKDIR /app",
    "COPY server.mjs /app/server.mjs",
    "EXPOSE 8787",
    'CMD ["node", "/app/server.mjs"]',
    "",
  ].join("\n");
}

function getBuiltinOttoAuthMcpBridgeServer() {
  return `
import http from "node:http";

const HOST = process.env.HOST || "0.0.0.0";
const PORT = Number(process.env.OTTOAGENT_MCP_PORT || process.env.PORT || "8787");
const RAW_PATH = process.env.OTTOAGENT_MCP_PATH || "/mcp";
const MCP_PATH = RAW_PATH.startsWith("/") ? RAW_PATH : "/" + RAW_PATH;
const BASE_URL = (process.env.OTTOAUTH_BASE_URL || process.env.OTTOAGENT_BASE_URL || "https://ottoauth.vercel.app").replace(/\\/$/, "");
const AUTH_TOKEN = process.env.OTTOAUTH_TOKEN || process.env.OTTOAGENT_TOKEN || "";
const REFRESH_INTERVAL_MS = Number(process.env.OTTOAGENT_MCP_REFRESH_MS || String(24 * 60 * 60 * 1000));
const HTTP_TIMEOUT_MS = Number(process.env.OTTOAGENT_MCP_HTTP_TIMEOUT_MS || "30000");
const VALID_HTTP_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);

let lastRefreshAt = 0;
let refreshPromise = null;
const endpointTools = new Map();

const ENDPOINT_INPUT_SCHEMA = {
  type: "object",
  properties: {
    path_params: { type: "object", additionalProperties: true },
    query: { type: "object", additionalProperties: true },
    body: { type: "object", additionalProperties: true },
    headers: { type: "object", additionalProperties: { type: "string" } },
  },
};

function writeJson(res, statusCode, body) {
  res.statusCode = statusCode;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(body));
}

function mcpResult(id, result) {
  return { jsonrpc: "2.0", id, result };
}

function mcpError(id, message, code = -32000) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function asObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value;
}

function argumentError(message) {
  const error = new Error(message);
  error.code = -32602;
  return error;
}

function normalizeMethod(raw) {
  const method = String(raw || "GET").trim().toUpperCase();
  if (!VALID_HTTP_METHODS.has(method)) {
    throw argumentError("Invalid method. Expected one of GET, POST, PUT, PATCH, DELETE.");
  }
  return method;
}

function normalizePath(value) {
  const trimmed = String(value ?? "").trim();
  if (!trimmed) throw argumentError("Path is required.");
  if (!trimmed.startsWith("/")) {
    throw argumentError("Path must start with '/': " + trimmed);
  }
  return trimmed.replace(/\\/{2,}/g, "/");
}

function applyPathParams(pathTemplate, pathParams) {
  const params = asObject(pathParams);
  return pathTemplate.replace(/:([A-Za-z0-9_]+)/g, (_, name) => {
    const value = params?.[name];
    if (value === undefined || value === null) {
      throw argumentError("Missing required path parameter '" + name + "' for path '" + pathTemplate + "'.");
    }
    return encodeURIComponent(String(value));
  });
}

function toToolName(serviceId, method, path) {
  const normalizedPath = path
    .replace(/^\\/api\\//, "")
    .replace(/[:/]+/g, "_")
    .replace(/[^A-Za-z0-9_]/g, "")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
  return "ottoauth_" + serviceId + "_" + method.toLowerCase() + "_" + normalizedPath;
}

function safeServiceId(raw) {
  if (typeof raw !== "string") return null;
  const value = raw.trim().toLowerCase();
  if (!value) return null;
  return value.replace(/[^a-z0-9_-]/g, "");
}

function normalizeDiscoveredPath(value) {
  const url = String(value).startsWith("http")
    ? new URL(value)
    : new URL(value, BASE_URL + "/");
  let path = normalizePath(url.pathname);
  if (!path.startsWith("/api/")) return null;
  path = path
    .split("/")
    .map((segment) => {
      if (/^[A-Z][A-Z0-9_]+$/.test(segment)) {
        const normalized = segment.replace(/_HERE$/g, "").toLowerCase();
        return ":" + normalized;
      }
      return segment;
    })
    .join("/");
  return path;
}

function extractEndpointsFromMarkdown(markdown, serviceId) {
  if (!markdown) return [];
  const endpoints = [];
  const codeBlocks = [...markdown.matchAll(/\\\`\\\`\\\`[\\s\\S]*?\\\`\\\`\\\`/g)].map((match) => match[0]);

  for (const block of codeBlocks) {
    const directEndpointMatches = block.matchAll(
      /\\b(GET|POST|PUT|PATCH|DELETE)\\s+(https?:\\/\\/[^\\s\\\\\`]+|\\/[^\\s\\\\\`]+)/g,
    );
    for (const match of directEndpointMatches) {
      const method = match[1];
      const rawPath = match[2];
      const path = normalizeDiscoveredPath(rawPath);
      if (!path) continue;
      endpoints.push({
        toolName: toToolName(serviceId, method, path),
        title: serviceId.toUpperCase() + " " + method + " " + path,
        description: "Passthrough to " + method + " " + path + " on OttoAuth.",
        method,
        path,
        serviceId,
      });
    }

    const curlMatches = block.matchAll(
      /\\bcurl\\b[\\s\\S]*?\\b-X\\s+(GET|POST|PUT|PATCH|DELETE)\\s+(https?:\\/\\/[^\\s\\\\\`]+|\\/[^\\s\\\\\`]+)/g,
    );
    for (const match of curlMatches) {
      const method = match[1];
      const rawPath = match[2];
      const path = normalizeDiscoveredPath(rawPath);
      if (!path) continue;
      endpoints.push({
        toolName: toToolName(serviceId, method, path),
        title: serviceId.toUpperCase() + " " + method + " " + path,
        description: "Passthrough to " + method + " " + path + " on OttoAuth.",
        method,
        path,
        serviceId,
      });
    }
  }

  return endpoints;
}

async function fetchWithTimeout(url, init, timeoutMs) {
  const controller = new AbortController();
  const timeout = Number.isFinite(timeoutMs) && timeoutMs > 0
    ? setTimeout(() => controller.abort(), timeoutMs)
    : null;
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function parseResponseBody(response) {
  const text = await response.text();
  const contentType = response.headers.get("content-type") || "";
  if (!text) {
    return { contentType, body: null };
  }
  if (contentType.includes("application/json")) {
    try {
      return { contentType, body: JSON.parse(text) };
    } catch {
      return { contentType, body: text };
    }
  }
  try {
    return { contentType, body: JSON.parse(text) };
  } catch {
    return { contentType, body: text };
  }
}

function baseTools() {
  return [
    {
      name: "ottoauth_list_services",
      description: "List OttoAuth services from /api/services.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "ottoauth_get_service",
      description: "Get OttoAuth service details by id from /api/services/:id.",
      inputSchema: {
        type: "object",
        required: ["id"],
        properties: { id: { type: "string" } },
      },
    },
    {
      name: "ottoauth_http_request",
      description: "Generic OttoAuth HTTP request. Path must start with /api/.",
      inputSchema: {
        type: "object",
        required: ["method", "path"],
        properties: {
          method: { type: "string", enum: ["GET", "POST", "PUT", "PATCH", "DELETE"] },
          path: { type: "string" },
          query: { type: "object", additionalProperties: true },
          body: { type: "object", additionalProperties: true },
          headers: { type: "object", additionalProperties: { type: "string" } },
        },
      },
    },
    {
      name: "ottoauth_refresh_tools",
      description: "Refresh OttoAuth endpoint-discovered tools immediately.",
      inputSchema: { type: "object", properties: {} },
    },
  ];
}

function toolList() {
  const dynamic = [...endpointTools.values()]
    .map((endpoint) => ({
      name: endpoint.toolName,
      description: endpoint.description,
      inputSchema: ENDPOINT_INPUT_SCHEMA,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return [...baseTools(), ...dynamic];
}

function buildHeaders(input = {}) {
  const headers = {
    Accept: "application/json, text/plain;q=0.9, */*;q=0.8",
    ...(asObject(input.extraHeaders) || {}),
  };
  if (input.shouldSendBody) {
    headers["Content-Type"] = headers["Content-Type"] || "application/json";
  }
  if (AUTH_TOKEN) {
    headers.authorization = \`Bearer \${AUTH_TOKEN}\`;
  }
  return headers;
}

function mapResultContent(value) {
  return [{ type: "text", text: JSON.stringify(value, null, 2) }];
}

function toMcpToolResult(response, options = {}) {
  const preferBodyOnSuccess = Boolean(options.preferBodyOnSuccess);
  if (response.ok && preferBodyOnSuccess) {
    return { content: mapResultContent(response.body), structuredContent: response.body };
  }
  return {
    isError: !response.ok,
    content: mapResultContent(response),
    structuredContent: response,
  };
}

async function callOttoAuth(method, path, query, body, headers) {
  const normalizedMethod = normalizeMethod(method);
  const normalizedPath = normalizePath(path);
  if (!normalizedPath.startsWith("/api/")) {
    throw argumentError("Path must start with /api/.");
  }
  const url = new URL(normalizedPath, BASE_URL + "/");
  const queryObject = asObject(query);
  if (queryObject) {
    for (const [key, value] of Object.entries(queryObject)) {
      if (value === undefined || value === null) continue;
      url.searchParams.set(key, String(value));
    }
  }

  const shouldSendBody = normalizedMethod !== "GET" && normalizedMethod !== "DELETE";
  const bodyObject = asObject(body);

  try {
    const response = await fetchWithTimeout(
      url.toString(),
      {
        method: normalizedMethod,
        headers: buildHeaders({ shouldSendBody, extraHeaders: headers }),
        body: shouldSendBody ? JSON.stringify(bodyObject || {}) : undefined,
      },
      HTTP_TIMEOUT_MS,
    );
    const { contentType, body: parsedBody } = await parseResponseBody(response);
    return {
      ok: response.ok,
      status: response.status,
      statusText: response.statusText,
      url: url.toString(),
      contentType,
      body: parsedBody,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      status: 0,
      statusText: "NetworkError",
      url: url.toString(),
      contentType: "",
      body: { error: message },
    };
  }
}

async function fetchDocsMarkdown(docsUrl) {
  try {
    const response = await fetchWithTimeout(
      docsUrl,
      {
        method: "GET",
        headers: { Accept: "text/markdown, text/plain;q=0.9, */*;q=0.1" },
      },
      HTTP_TIMEOUT_MS,
    );
    if (!response.ok) return "";
    return await response.text();
  } catch {
    return "";
  }
}

async function discoverEndpoints() {
  const servicesResponse = await callOttoAuth("GET", "/api/services");
  if (!servicesResponse.ok) {
    console.error(
      "[ottoauth-http-mcp] discovery failed to load /api/services:",
      servicesResponse.status,
      servicesResponse.statusText,
      JSON.stringify(servicesResponse.body),
    );
    return [];
  }

  const services = Array.isArray(servicesResponse.body?.services)
    ? servicesResponse.body.services
    : [];
  const discovered = new Map();

  for (const service of services) {
    const serviceId = safeServiceId(service?.id);
    if (!serviceId) continue;
    const docsUrl =
      typeof service?.docsUrl === "string" && service.docsUrl
        ? service.docsUrl
        : BASE_URL + "/api/services/" + encodeURIComponent(serviceId);
    const markdown = await fetchDocsMarkdown(docsUrl);
    const endpoints = extractEndpointsFromMarkdown(markdown, serviceId);
    for (const endpoint of endpoints) {
      discovered.set(endpoint.method + " " + endpoint.path, endpoint);
    }
  }

  return [...discovered.values()].sort((a, b) => a.toolName.localeCompare(b.toolName));
}

async function refreshEndpointTools() {
  if (refreshPromise) return refreshPromise;
  refreshPromise = (async () => {
    const discovered = await discoverEndpoints();
    endpointTools.clear();
    for (const endpoint of discovered) {
      endpointTools.set(endpoint.toolName, endpoint);
    }
    lastRefreshAt = Date.now();
    console.log(
      "[ottoauth-http-mcp] refreshed " +
        endpointTools.size +
        " endpoint tools from " +
        BASE_URL,
    );
  })();
  try {
    await refreshPromise;
  } finally {
    refreshPromise = null;
  }
}

async function ensureFreshTools(force = false) {
  const stale = Date.now() - lastRefreshAt > REFRESH_INTERVAL_MS;
  if (force || stale || endpointTools.size === 0) {
    await refreshEndpointTools();
  }
}

async function handleRpc(payload) {
  const id = payload?.id ?? null;
  const method = String(payload?.method || "");
  const params = asObject(payload?.params) || {};

  if (method === "initialize") {
    return mcpResult(id, {
      protocolVersion: "2024-11-05",
      capabilities: { tools: { listChanged: true } },
      serverInfo: { name: "ottoauth-http-mcp", version: "0.2.0" },
    });
  }
  if (method === "notifications/initialized") {
    return mcpResult(id, {});
  }
  if (method === "tools/list") {
    try {
      await ensureFreshTools(false);
    } catch (error) {
      console.error("[ottoauth-http-mcp] tools/list refresh error:", error);
    }
    return mcpResult(id, { tools: toolList() });
  }
  if (method === "tools/call") {
    const name = String(params.name || "");
    const args = asObject(params.arguments) || {};
    try {
      if (name === "ottoauth_list_services") {
        const result = await callOttoAuth("GET", "/api/services");
        if (result.ok) {
          try {
            await ensureFreshTools(true);
          } catch (error) {
            console.error("[ottoauth-http-mcp] list_services refresh error:", error);
          }
        }
        return mcpResult(id, toMcpToolResult(result, { preferBodyOnSuccess: true }));
      }
      if (name === "ottoauth_get_service") {
        const serviceId = String(args.id || "").trim();
        if (!serviceId) return mcpError(id, "Missing required argument: id", -32602);
        const result = await callOttoAuth("GET", "/api/services/" + encodeURIComponent(serviceId));
        return mcpResult(id, toMcpToolResult(result, { preferBodyOnSuccess: true }));
      }
      if (name === "ottoauth_refresh_tools") {
        await refreshEndpointTools();
        const summary = {
          ok: true,
          endpoint_count: endpointTools.size,
          last_refresh_at: lastRefreshAt,
          base_url: BASE_URL,
        };
        return mcpResult(id, { content: mapResultContent(summary), structuredContent: summary });
      }
      if (name === "ottoauth_http_request") {
        const httpMethod = normalizeMethod(args.method || "GET");
        const path = String(args.path || "");
        const result = await callOttoAuth(httpMethod, path, args.query, args.body, args.headers);
        return mcpResult(id, toMcpToolResult(result));
      }

      await ensureFreshTools(false);
      const endpoint = endpointTools.get(name);
      if (endpoint) {
        const path = applyPathParams(endpoint.path, args.path_params);
        const result = await callOttoAuth(endpoint.method, path, args.query, args.body, args.headers);
        return mcpResult(id, toMcpToolResult(result));
      }
      return mcpError(id, \`Unknown tool: \${name}\`, -32601);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const code = typeof error === "object" && error && "code" in error && typeof error.code === "number"
        ? error.code
        : -32000;
      return mcpError(id, message, code);
    }
  }

  return mcpError(id, \`Unknown method: \${method}\`, -32601);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", "http://" + HOST + ":" + PORT);
  if (url.pathname === "/healthz") {
    return writeJson(res, 200, {
      ok: true,
      baseUrl: BASE_URL,
      endpointCount: endpointTools.size,
      lastRefreshAt,
      refreshIntervalMs: REFRESH_INTERVAL_MS,
    });
  }
  if (req.method !== "POST" || url.pathname !== MCP_PATH) {
    return writeJson(res, 404, { error: "not found" });
  }
  const chunks = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  let payload = null;
  try {
    payload = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    return writeJson(res, 400, mcpError(null, "Invalid JSON payload", -32700));
  }
  const response = await handleRpc(payload);
  return writeJson(res, 200, response);
});

server.listen(PORT, HOST, () => {
  console.log("[ottoauth-http-mcp] listening on " + HOST + ":" + PORT + MCP_PATH + " base=" + BASE_URL);
  refreshEndpointTools().catch((error) => {
    console.error("[ottoauth-http-mcp] initial endpoint refresh failed:", error);
  });
  const timer = setInterval(() => {
    refreshEndpointTools().catch((error) => {
      console.error("[ottoauth-http-mcp] scheduled endpoint refresh failed:", error);
    });
  }, REFRESH_INTERVAL_MS);
  if (typeof timer.unref === "function") timer.unref();
});
`;
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
  const bootstrapApiKey = readTrimmedEnv("OPENCLAW_BOOTSTRAP_API_KEY") || "oneclick-bootstrap-placeholder";

  const args = [
    "node /app/dist/index.js onboard",
    "--non-interactive",
    "--accept-risk",
    "--mode local",
    `--gateway-port ${input.containerPort}`,
    "--gateway-bind lan",
    "--skip-daemon",
    "--skip-channels",
    "--skip-health",
    "--skip-ui",
    "--skip-skills",
  ];

  if (anthropicApiKey) {
    args.push("--auth-choice apiKey", `--anthropic-api-key ${shellQuote(anthropicApiKey)}`);
  } else if (openaiApiKey) {
    args.push("--auth-choice apiKey", `--openai-api-key ${shellQuote(openaiApiKey)}`);
  } else if (openrouterApiKey) {
    args.push("--auth-choice apiKey", `--openai-api-key ${shellQuote(openrouterApiKey)}`);
  } else if (subsidyProxyToken) {
    args.push("--auth-choice apiKey", `--openai-api-key ${shellQuote(subsidyProxyToken)}`);
  } else {
    // Keep gateway bootstrap non-interactive for test deployments that omit provider keys.
    args.push("--auth-choice apiKey", `--openai-api-key ${shellQuote(bootstrapApiKey)}`);
  }

  return args.join(" ");
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
  const runtimeDomain = buildRuntimeUrlFromDomain(input.runtimeSlugSource, input.userId);
  if (!runtimeDomain) {
    throw new Error(
      "Runtime domain is not configured. Set RUNTIME_BASE_DOMAIN so SSH deployments can publish HTTPS runtime URLs.",
    );
  }

  const deploymentFlavor = normalizeDeploymentFlavor(input.deploymentFlavor);
  const isOpenClawRuntime = deploymentFlavor === "deploy_openclaw_free";
  const isSimpleAgentWithVideoMemory = deploymentFlavor === "simple_agent_videomemory_free";
  const isSimpleAgentWithOttoAgentMcp = deploymentFlavor === "ottoagent_free";
  const vmPublicHost = normalizeHostCandidate(parseUserAndHost(sshTarget).host);
  const runtimeDomainHost = normalizeHostCandidate(runtimeDomain.fqdn);
  const hostPublicBaseHost = normalizeHostCandidate(input.host.publicBaseUrl ?? "");
  const videoMemoryPublicHost = [runtimeDomainHost, hostPublicBaseHost, vmPublicHost].find(
    (candidate) => candidate && !isUnusablePublicHost(candidate),
  ) || runtimeDomainHost || hostPublicBaseHost || vmPublicHost;
  const image = getRuntimeImage(deploymentFlavor);
  const containerPort = getRuntimePort(deploymentFlavor);
  const startCommand = getRuntimeStartCommand(deploymentFlavor);
  const ottoAgentMcpImage = getOttoAgentMcpImage();
  const ottoAgentMcpContainerPort = getOttoAgentMcpPort();
  const ottoAgentMcpPath = normalizeMcpPath(getOttoAgentMcpPath());
  const ottoAgentMcpStartCommand = getOttoAgentMcpStartCommand();
  const videoMemoryImage = getVideoMemoryImage();
  const videoMemoryContainerPort = getVideoMemoryPort();
  const videoMemoryStartCommand = getVideoMemoryStartCommand();
  const videoMemoryMcpContainerPort = Number(readTrimmedEnv("VIDEOMEMORY_MCP_PORT") || "8765");
  const allowInsecureControlUi = shouldAllowInsecureControlUi();
  const gatewayToken = getGatewayToken();
  const hostPort = buildAssignedPort(input.deploymentId);
  const ottoAgentMcpHostPort = buildAssignedPort(`${input.deploymentId}-ottoagent-mcp`);
  const videoMemoryHostPort = buildAssignedPort(`${input.deploymentId}-videomemory`);
  const videoMemoryMcpHostPort = buildAssignedPort(`${input.deploymentId}-videomemory-mcp`);
  const telegramBotToken = input.telegramBotToken?.trim() || "";
  const telegramEnabled = telegramBotToken ? "true" : "false";
  const openaiApiKey = input.openaiApiKey?.trim() || "";
  const anthropicApiKey = input.anthropicApiKey?.trim() || "";
  const openrouterApiKey = input.openrouterApiKey?.trim() || "";
  const subsidyProxyBaseUrl = input.subsidyProxyBaseUrl?.trim() || "";
  const subsidyProxyToken = input.subsidyProxyToken?.trim() || "";
  const planTier = "free";
  const resourceFlags = getDockerResourceFlags(planTier);
  const openclawNodeOptions = readTrimmedEnv("OPENCLAW_NODE_OPTIONS") || "--max-old-space-size=1536";
  const onboardCommand = isOpenClawRuntime
    ? buildOpenClawOnboardCommand({
      anthropicApiKey,
      openaiApiKey,
      openrouterApiKey,
      subsidyProxyToken,
      containerPort,
    })
    : "";
  const runSshOnboard =
    isOpenClawRuntime && (readTrimmedEnv("OPENCLAW_SSH_RUN_ONBOARD") || "false").toLowerCase() === "true";
  const setTelegramPluginConfig =
    isOpenClawRuntime &&
    (readTrimmedEnv("OPENCLAW_SSH_SET_TELEGRAM_PLUGIN_CONFIG") || "false").toLowerCase() === "true";
  const simpleAgentOpenAiApiKey = openaiApiKey;
  const simpleAgentAnthropicApiKey = anthropicApiKey;
  const simpleAgentGoogleApiKey = "";
  const simpleAgentModel =
    (isSimpleAgentWithOttoAgentMcp ? readTrimmedEnv("OTTOAGENT_MODEL") : "") ||
    readTrimmedEnv("SIMPLE_AGENT_MODEL") ||
    "gpt-4o-mini";
  const simpleAgentLlmUrl =
    (isSimpleAgentWithOttoAgentMcp ? readTrimmedEnv("OTTOAGENT_LLM_URL") : "") ||
    readTrimmedEnv("SIMPLE_AGENT_LLM_URL");
  const resolvedSimpleAgentLlmUrl = simpleAgentLlmUrl || subsidyProxyBaseUrl;
  const shouldBuildSimpleAgent = !isOpenClawRuntime && (
    isSimpleAgentWithOttoAgentMcp ? shouldBuildOttoAgentImage() : shouldBuildSimpleAgentImage()
  );
  const simpleAgentBuildRepo = isSimpleAgentWithOttoAgentMcp ? getOttoAgentBuildRepo() : getSimpleAgentBuildRepo();
  const shouldBuildOttoAgentMcp = isSimpleAgentWithOttoAgentMcp && shouldBuildOttoAgentMcpImage();
  const ottoAgentMcpBuildRepo = getOttoAgentMcpBuildRepo().trim();
  const ottoAgentMcpRepoSpec = ottoAgentMcpBuildRepo ? parseGitRepoSpec(ottoAgentMcpBuildRepo) : null;
  const ottoAgentMcpBuildDir = `/tmp/oneclick-ottoagent-mcp-${sanitizeSegment(input.deploymentId)}`;
  const ottoAuthMcpBridgeServerBase64 = Buffer.from(getBuiltinOttoAuthMcpBridgeServer(), "utf8").toString("base64");
  const ottoAuthMcpBridgeDockerfileBase64 = Buffer.from(getBuiltinOttoAuthMcpBridgeDockerfile(), "utf8").toString("base64");
  const shouldBuildVideoMemory = isSimpleAgentWithVideoMemory && shouldBuildVideoMemoryImage();
  const videoMemoryBuildRepo = getVideoMemoryBuildRepo();
  const videoMemoryRepoSpec = parseGitRepoSpec(videoMemoryBuildRepo);
  const videoMemoryBuildDir = `/tmp/oneclick-videomemory-${sanitizeSegment(input.deploymentId)}`;
  const defaultVideoMemoryMcpStartCommand = `bash -lc ${shellQuote(
    `/app/deploy/start-cloud.sh & uv run python -m videomemory.mcp_server --transport http --host 0.0.0.0 --port ${videoMemoryMcpContainerPort} --api-base-url http://127.0.0.1:${videoMemoryContainerPort}; wait -n`,
  )}`;
  const resolvedVideoMemoryStartCommand =
    isSimpleAgentWithVideoMemory
      ? videoMemoryStartCommand || defaultVideoMemoryMcpStartCommand
      : videoMemoryStartCommand;
  const videoMemoryWebhookUrl = `http://host.docker.internal:${hostPort}/hooks/videomemory-alert`;
  const simpleAgentMcpServers: Array<{ id: string; transport: "http"; url: string }> = [];
  if (isSimpleAgentWithVideoMemory) {
    simpleAgentMcpServers.push({
      id: "videomemory",
      transport: "http",
      url: `http://host.docker.internal:${videoMemoryMcpHostPort}/mcp`,
    });
  }
  if (isSimpleAgentWithOttoAgentMcp) {
    simpleAgentMcpServers.push({
      id: "ottoagent",
      transport: "http",
      url: `http://host.docker.internal:${ottoAgentMcpHostPort}${ottoAgentMcpPath}`,
    });
  }
  const simpleAgentMcpServersJson = simpleAgentMcpServers.length ? JSON.stringify(simpleAgentMcpServers) : "";
  const simpleAgentRuntimeArgs = [
    `-e TELEGRAM_ENABLED=${telegramEnabled}`,
    telegramBotToken ? `-e TELEGRAM_BOT_TOKEN=${shellQuote(telegramBotToken)}` : "",
    gatewayToken ? `-e GATEWAY_TOKEN=${shellQuote(gatewayToken)}` : "",
    simpleAgentOpenAiApiKey ? `-e SIMPLEAGENT_LLM_API_KEY=${shellQuote(simpleAgentOpenAiApiKey)}` : "",
    resolvedSimpleAgentLlmUrl ? `-e SIMPLEAGENT_LLM_URL=${shellQuote(resolvedSimpleAgentLlmUrl)}` : "",
    // Latest SimpleAgent stores/reads provider keys from these env vars.
    simpleAgentOpenAiApiKey ? `-e OPENAI_API_KEY=${shellQuote(simpleAgentOpenAiApiKey)}` : "",
    simpleAgentAnthropicApiKey ? `-e ANTHROPIC_API_KEY=${shellQuote(simpleAgentAnthropicApiKey)}` : "",
    simpleAgentGoogleApiKey ? `-e GOOGLE_API_KEY=${shellQuote(simpleAgentGoogleApiKey)}` : "",
    simpleAgentModel ? `-e SIMPLEAGENT_MODEL=${shellQuote(simpleAgentModel)}` : "",
    simpleAgentMcpServersJson ? `-e SIMPLEAGENT_MCP_SERVERS_JSON=${shellQuote(simpleAgentMcpServersJson)}` : "",
    resolvedSimpleAgentLlmUrl ? `-e OPENAI_BASE_URL=${shellQuote(resolvedSimpleAgentLlmUrl)}` : "",
    resolvedSimpleAgentLlmUrl ? `-e OPENAI_API_BASE=${shellQuote(resolvedSimpleAgentLlmUrl)}` : "",
    `-e PORT=${containerPort}`,
  ]
    .filter(Boolean)
    .join(" ");

  const safeUser = sanitizeSegment(input.userId);
  const safeDeployment = sanitizeSegment(input.deploymentId);
  const containerName = buildRuntimeName(input);
  const ottoAgentMcpContainerName = buildOttoAgentMcpContainerName(containerName);
  const videoMemoryContainerName = buildVideoMemoryContainerName(containerName);
  const ottoAgentMcpBaseUrl = readTrimmedEnv("OTTOAGENT_MCP_BASE_URL") || "https://ottoauth.vercel.app";
  const ottoAgentMcpToken = readTrimmedEnv("OTTOAGENT_MCP_TOKEN");
  const ottoAgentMcpRuntimeArgs = [
    `-e OTTOAGENT_MCP_PORT=${ottoAgentMcpContainerPort}`,
    `-e OTTOAGENT_MCP_PATH=${shellQuote(ottoAgentMcpPath)}`,
    ottoAgentMcpBaseUrl ? `-e OTTOAGENT_BASE_URL=${shellQuote(ottoAgentMcpBaseUrl)}` : "",
    ottoAgentMcpBaseUrl ? `-e OTTOAUTH_BASE_URL=${shellQuote(ottoAgentMcpBaseUrl)}` : "",
    ottoAgentMcpToken ? `-e OTTOAGENT_TOKEN=${shellQuote(ottoAgentMcpToken)}` : "",
    ottoAgentMcpToken ? `-e OTTOAUTH_TOKEN=${shellQuote(ottoAgentMcpToken)}` : "",
  ]
    .filter(Boolean)
    .join(" ");
  const configBase = readTrimmedEnv("OPENCLAW_CONFIG_MOUNT_BASE") || "/var/lib/oneclick/openclaw";
  const workspaceSuffix = readTrimmedEnv("OPENCLAW_WORKSPACE_SUFFIX") || "workspace";
  const userDir = `${configBase}/${safeUser}/${safeDeployment}`;
  const workspaceDir = `${userDir}/${workspaceSuffix}`;
  const videoMemoryDataDir = `${userDir}/videomemory-data`;

  const remoteScript = [
    `set -e`,
    `>&2 echo "oneclick-debug image=${image} container=${containerName} hostPort=${hostPort} containerPort=${containerPort}"`,
    `if ! command -v docker >/dev/null 2>&1; then >&2 echo "[oneclick] waiting briefly for cloud-init"; if command -v cloud-init >/dev/null 2>&1; then timeout 180 cloud-init status --wait || true; fi; fi`,
    `if ! command -v docker >/dev/null 2>&1; then >&2 echo "[oneclick] installing docker via apt"; export DEBIAN_FRONTEND=noninteractive; for i in $(seq 1 30); do if apt-get -o DPkg::Lock::Timeout=120 update -y && apt-get -o DPkg::Lock::Timeout=120 install -y docker.io git; then break; fi; sleep 5; done; fi`,
    `if ! command -v git >/dev/null 2>&1; then >&2 echo "[oneclick] installing git via apt"; export DEBIAN_FRONTEND=noninteractive; for i in $(seq 1 30); do if apt-get -o DPkg::Lock::Timeout=120 update -y && apt-get -o DPkg::Lock::Timeout=120 install -y git; then break; fi; sleep 5; done; fi`,
    `if command -v docker >/dev/null 2>&1; then systemctl enable docker || true; systemctl restart docker || true; fi`,
    `for i in $(seq 1 120); do if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then break; fi; sleep 2; done`,
    `if ! command -v docker >/dev/null 2>&1 || ! docker info >/dev/null 2>&1; then >&2 echo "[oneclick] docker install/daemon startup failed"; exit 1; fi`,
    `mkdir -p "${userDir}" "${workspaceDir}" "${videoMemoryDataDir}"`,
    `chown -R 1000:1000 "${userDir}" "${workspaceDir}" "${videoMemoryDataDir}" || true`,
    ...(shouldBuildSimpleAgent
      ? [`docker build -t "${image}" "${simpleAgentBuildRepo}"`]
      : [`docker pull "${image}"`]),
    `docker rm -f "${containerName}" "${videoMemoryContainerName}" "${ottoAgentMcpContainerName}" >/dev/null 2>&1 || true`,
    ...(shouldBuildOttoAgentMcp
      ? ottoAgentMcpRepoSpec
        ? [
            `rm -rf "${ottoAgentMcpBuildDir}" && git clone --depth 1 ${ottoAgentMcpRepoSpec.ref ? `--branch ${shellQuote(ottoAgentMcpRepoSpec.ref)} ` : ""}${shellQuote(ottoAgentMcpRepoSpec.url)} "${ottoAgentMcpBuildDir}"`,
            `docker build -t "${ottoAgentMcpImage}" "${ottoAgentMcpBuildDir}"`,
          ]
        : [
            `rm -rf "${ottoAgentMcpBuildDir}" && mkdir -p "${ottoAgentMcpBuildDir}"`,
            `printf '%s' '${ottoAuthMcpBridgeServerBase64}' | base64 -d > "${ottoAgentMcpBuildDir}/server.mjs"`,
            `printf '%s' '${ottoAuthMcpBridgeDockerfileBase64}' | base64 -d > "${ottoAgentMcpBuildDir}/Dockerfile"`,
            `docker build -t "${ottoAgentMcpImage}" "${ottoAgentMcpBuildDir}"`,
          ]
      : isSimpleAgentWithOttoAgentMcp
        ? [`docker pull "${ottoAgentMcpImage}"`]
        : []),
    ...(shouldBuildVideoMemory
      ? [
          `rm -rf "${videoMemoryBuildDir}" && git clone --depth 1 ${videoMemoryRepoSpec.ref ? `--branch ${shellQuote(videoMemoryRepoSpec.ref)} ` : ""}${shellQuote(videoMemoryRepoSpec.url)} "${videoMemoryBuildDir}"`,
          // Upstream caption endpoint keeps a startup-time provider reference; apply settings-saved key updates there too.
          "sed -i 's/response = model_provider\\._sync_generate_content(/response = task_manager._model_provider._sync_generate_content(/g' " +
            `"${videoMemoryBuildDir}/flask_app/app.py"`,
          // Upstream Dockerfile currently points to a non-existent MediaMTX artifact path.
          "sed -i 's/mediamtx_\\${MEDIAMTX_VERSION}_linux_amd64/mediamtx_v\\${MEDIAMTX_VERSION}_linux_amd64/g' " +
            `"${videoMemoryBuildDir}/Dockerfile"`,
          // Upstream main currently has a quoting typo that breaks startup on Python import.
          "sed -i \"s/time.strftime(\\\"%Y-%m-%d %H:%M:%S\\\"/time.strftime('%Y-%m-%d %H:%M:%S'/g\" " +
            `"${videoMemoryBuildDir}/videomemory/system/stream_ingestors/video_stream_ingestor.py"`,
          `docker build -t "${videoMemoryImage}" "${videoMemoryBuildDir}"`,
        ]
      : isSimpleAgentWithVideoMemory
        ? [`docker pull "${videoMemoryImage}"`]
        : []),
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
    isOpenClawRuntime
      ? `docker run -d --name "${containerName}" --restart unless-stopped --memory=${resourceFlags.memory} --memory-swap=${resourceFlags.memory} --cpus=${resourceFlags.cpus} --pids-limit=${resourceFlags.pids} --shm-size=${resourceFlags.shmSize} --log-opt max-size=${resourceFlags.logMaxSize} --log-opt max-file=${resourceFlags.logMaxFiles}${resourceFlags.writableLayerSize ? ` --storage-opt size=${resourceFlags.writableLayerSize}` : ""} -v "${userDir}:/home/node/.openclaw" -v "${workspaceDir}:/home/node/.openclaw/workspace" -e OPENCLAW_GATEWAY_TOKEN=${shellQuote(gatewayToken)} -e OPENCLAW_ALLOW_INSECURE_CONTROL_UI=${allowInsecureControlUi ? "true" : "false"} -e NODE_OPTIONS=${shellQuote(openclawNodeOptions)} -e TELEGRAM_ENABLED=${telegramEnabled}${telegramBotToken ? ` -e TELEGRAM_BOT_TOKEN=${shellQuote(telegramBotToken)}` : ""}${openaiApiKey ? ` -e OPENAI_API_KEY=${shellQuote(openaiApiKey)}` : ""}${anthropicApiKey ? ` -e ANTHROPIC_API_KEY=${shellQuote(anthropicApiKey)}` : ""}${openrouterApiKey ? ` -e OPENROUTER_API_KEY=${shellQuote(openrouterApiKey)}` : ""}${!openaiApiKey && !anthropicApiKey && !openrouterApiKey && subsidyProxyBaseUrl && subsidyProxyToken ? ` -e OPENAI_API_KEY=${shellQuote(subsidyProxyToken)} -e OPENAI_BASE_URL=${shellQuote(subsidyProxyBaseUrl)} -e OPENAI_API_BASE=${shellQuote(subsidyProxyBaseUrl)}` : ""} -p "${hostPort}:${containerPort}" "${image}" ${startCommand}`
      : `docker run -d --name "${containerName}" --restart unless-stopped --add-host host.docker.internal:host-gateway --memory=${resourceFlags.memory} --memory-swap=${resourceFlags.memory} --cpus=${resourceFlags.cpus} --pids-limit=${resourceFlags.pids} --shm-size=${resourceFlags.shmSize} --log-opt max-size=${resourceFlags.logMaxSize} --log-opt max-file=${resourceFlags.logMaxFiles}${resourceFlags.writableLayerSize ? ` --storage-opt size=${resourceFlags.writableLayerSize}` : ""} -v "${userDir}:/home/node/.openclaw" -v "${workspaceDir}:/home/node/.openclaw/workspace" ${simpleAgentRuntimeArgs} -p "${hostPort}:${containerPort}" "${image}"${startCommand ? ` ${startCommand}` : ""}`,
    ...(isSimpleAgentWithOttoAgentMcp
      ? [
          `docker run -d --name "${ottoAgentMcpContainerName}" --restart unless-stopped --add-host host.docker.internal:host-gateway --memory=512m --memory-swap=512m --cpus=0.5 --pids-limit=256 --shm-size=128m --log-opt max-size=10m --log-opt max-file=3 ${ottoAgentMcpRuntimeArgs} -p "${ottoAgentMcpHostPort}:${ottoAgentMcpContainerPort}" "${ottoAgentMcpImage}"${ottoAgentMcpStartCommand ? ` ${ottoAgentMcpStartCommand}` : ""}`,
        ]
      : []),
    ...(isSimpleAgentWithVideoMemory
      ? [
          `docker run -d --name "${videoMemoryContainerName}" --restart unless-stopped --add-host host.docker.internal:host-gateway --memory=1024m --memory-swap=1024m --cpus=0.75 --pids-limit=512 --shm-size=256m --log-opt max-size=10m --log-opt max-file=3 -v "${videoMemoryDataDir}:/app/data" -e VIDEOMEMORY_MCP_PORT=${videoMemoryMcpContainerPort} -e VIDEOMEMORY_OPENCLAW_WEBHOOK_URL=${shellQuote(videoMemoryWebhookUrl)} -e VIDEOMEMORY_OPENCLAW_WEBHOOK_TOKEN=${shellQuote(gatewayToken)} -e RTMP_SERVER_HOST=${shellQuote(videoMemoryPublicHost)} -e RTMP_INGEST_INTERNAL_HOST=127.0.0.1${telegramBotToken ? ` -e TELEGRAM_BOT_TOKEN=${shellQuote(telegramBotToken)}` : ""}${openaiApiKey ? ` -e OPENAI_API_KEY=${shellQuote(openaiApiKey)}` : ""}${anthropicApiKey ? ` -e ANTHROPIC_API_KEY=${shellQuote(anthropicApiKey)}` : ""}${openrouterApiKey ? ` -e OPENROUTER_API_KEY=${shellQuote(openrouterApiKey)}` : ""} -p "${videoMemoryHostPort}:${videoMemoryContainerPort}" -p "${videoMemoryMcpHostPort}:${videoMemoryMcpContainerPort}" -p "1935:1935" -p "8554:8554" -p "8890:8890/udp" -p "8889:8889" "${videoMemoryImage}"${resolvedVideoMemoryStartCommand ? ` ${resolvedVideoMemoryStartCommand}` : ""}`,
        ]
      : []),
  ].join(" && ");

  const launchTimeoutMs = Number(readTrimmedEnv("OPENCLAW_SSH_LAUNCH_TIMEOUT_MS") || "1800000");
  await runSshCommand(sshTarget, remoteScript, launchTimeoutMs);
  const dnsTarget = vmPublicHost;
  await upsertRuntimeDnsRecord({
    fqdn: runtimeDomain.fqdn,
    target: dnsTarget,
  });
  await ensureCaddyRoute(sshTarget, runtimeDomain.fqdn, hostPort);

  return {
    runtimeId: runtimeIdFromSsh(sshTarget, containerName, input.host?.vmId),
    deployProvider: "ssh",
    image,
    port: containerPort,
    hostPort,
    startCommand,
    hostName: input.host?.name ?? "mock",
    readyUrl: withGatewayToken(runtimeDomain.readyUrl, gatewayToken),
  };
}

async function launchViaEcs(input: LaunchInput) {
  const region = requireEnv("AWS_REGION");
  const cluster = requireEnv("ECS_CLUSTER");
  const subnets = parseCsvEnv("ECS_SUBNET_IDS");
  const securityGroups = parseCsvEnv("ECS_SECURITY_GROUP_IDS");
  const executionRoleArn = requireEnv("ECS_EXECUTION_ROLE_ARN");
  const taskRoleArn = readTrimmedEnv("ECS_TASK_ROLE_ARN");
  const defaultServicePrefix = readTrimmedEnv("ECS_SERVICE_PREFIX") || "oneclick-agent";
  const servicePrefix = input.ecsServicePrefixOverride?.trim() || defaultServicePrefix;
  const launchType = readTrimmedEnv("ECS_LAUNCH_TYPE") || "FARGATE";
  const assignPublicIp = (readTrimmedEnv("ECS_ASSIGN_PUBLIC_IP") || "true").toLowerCase() === "false"
    ? "DISABLED"
    : "ENABLED";
  const deploymentFlavor = normalizeDeploymentFlavor(input.deploymentFlavor);
  const isOpenClawRuntime = deploymentFlavor === "deploy_openclaw_free";
  const isSimpleAgentMicroservicesEcs = deploymentFlavor === "simple_agent_microservices_ecs";
  const isSimpleAgentWithOttoAuthEcs = isOttoAuthEcsFlavor(deploymentFlavor);
  const image = getRuntimeImage(deploymentFlavor);
  const gatewayToken = getGatewayToken();
  const containerPort = getRuntimePort(deploymentFlavor);
  const startCommand = getRuntimeStartCommand(deploymentFlavor);
  const command = splitStartCommand(startCommand);
  const ottoAgentMcpImage = getOttoAgentMcpImage();
  const ottoAgentMcpContainerPort = getOttoAgentMcpPort();
  const ottoAgentMcpPath = normalizeMcpPath(getOttoAgentMcpPath());
  const ottoAgentMcpStartCommand = getOttoAgentMcpStartCommand();
  const ottoAgentMcpCommand = splitStartCommand(ottoAgentMcpStartCommand);
  const isPhioranexOpenClawImage = isOpenClawRuntime && image.toLowerCase().includes("ghcr.io/phioranex/openclaw-docker");
  const planTier = normalizePlanTier(input.planTier);
  const { cpu, memory } = getEcsPlanResources(planTier);
  const platformVersion = readTrimmedEnv("ECS_PLATFORM_VERSION");
  const serviceName = `${servicePrefix}-${sanitizeNamePart(input.userId, 16)}-${sanitizeNamePart(input.deploymentId, 10)}`.slice(0, 63);
  const family = `${servicePrefix}-${sanitizeNamePart(input.userId, 18)}-${sanitizeNamePart(input.deploymentId, 12)}`.slice(0, 255);
  const containerName = isSimpleAgentMicroservicesEcs
    ? (readTrimmedEnv("SIMPLE_AGENT_MICROSERVICES_FRONTEND_CONTAINER_NAME") || "frontend-service")
    : (readTrimmedEnv("ECS_CONTAINER_NAME") || "openclaw");
  const awslogsGroup = readTrimmedEnv("ECS_LOG_GROUP");
  const awslogsPrefix = readTrimmedEnv("ECS_LOG_STREAM_PREFIX") || "oneclick";
  const telemetryEnv = readTrimmedEnv("OPENCLAW_TELEMETRY");
  const openclawNodeOptions = readTrimmedEnv("OPENCLAW_NODE_OPTIONS") || "--max-old-space-size=1536";
  const simpleAgentModel = isOpenClawRuntime
    ? ""
    : (
      (isSimpleAgentWithOttoAuthEcs ? readTrimmedEnv("OTTOAGENT_MODEL") : "") ||
      readTrimmedEnv("SIMPLE_AGENT_MODEL") ||
      "gpt-4o-mini"
    );
  const simpleAgentLlmUrl = isOpenClawRuntime
    ? ""
    : (
      (isSimpleAgentWithOttoAuthEcs ? readTrimmedEnv("OTTOAGENT_LLM_URL") : "") ||
      readTrimmedEnv("SIMPLE_AGENT_LLM_URL")
    );
  const resolvedSimpleAgentLlmUrl = simpleAgentLlmUrl || input.subsidyProxyBaseUrl?.trim() || "";
  const simpleAgentMcpServersJson = isSimpleAgentWithOttoAuthEcs
    ? JSON.stringify([
        {
          id: "ottoagent",
          transport: "http",
          url: `http://127.0.0.1:${ottoAgentMcpContainerPort}${ottoAgentMcpPath}`,
        },
      ])
    : "";
  const ottoAgentMcpBaseUrl = readTrimmedEnv("OTTOAGENT_MCP_BASE_URL");
  const ottoAgentMcpToken = readTrimmedEnv("OTTOAGENT_MCP_TOKEN");
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
  const resolveLogConfiguration = (suffix: string) =>
    awslogsGroup
      ? {
          logDriver: "awslogs" as const,
          options: {
            "awslogs-group": awslogsGroup,
            "awslogs-region": region,
            "awslogs-stream-prefix": suffix ? `${awslogsPrefix}-${suffix}` : awslogsPrefix,
          },
        }
      : undefined;

  if (isSimpleAgentMicroservicesEcs) {
    const gatewayImage = readTrimmedEnv("SIMPLE_AGENT_MICROSERVICES_GATEWAY_IMAGE");
    const executionImage = readTrimmedEnv("SIMPLE_AGENT_MICROSERVICES_EXECUTION_IMAGE");
    const postImage = readTrimmedEnv("SIMPLE_AGENT_MICROSERVICES_POST_IMAGE");
    const missingImages = [
      !image ? "SIMPLE_AGENT_MICROSERVICES_FRONTEND_IMAGE" : "",
      !gatewayImage ? "SIMPLE_AGENT_MICROSERVICES_GATEWAY_IMAGE" : "",
      !executionImage ? "SIMPLE_AGENT_MICROSERVICES_EXECUTION_IMAGE" : "",
      !postImage ? "SIMPLE_AGENT_MICROSERVICES_POST_IMAGE" : "",
    ].filter(Boolean);
    if (missingImages.length > 0) {
      throw new Error(`Missing microservices image env vars: ${missingImages.join(", ")}`);
    }

    const redisImage = readTrimmedEnv("SIMPLE_AGENT_MICROSERVICES_REDIS_IMAGE") || "redis:7-alpine";
    const postgresImage = readTrimmedEnv("SIMPLE_AGENT_MICROSERVICES_POSTGRES_IMAGE") || "postgres:16-alpine";
    const mcpImage = readTrimmedEnv("SIMPLE_AGENT_MICROSERVICES_MCP_IMAGE");
    const telegramMockEnabled = readBoolEnv("SIMPLE_AGENT_MICROSERVICES_TELEGRAM_MOCK_ENABLED", false);
    const telegramMockImage = readTrimmedEnv("SIMPLE_AGENT_MICROSERVICES_TELEGRAM_MOCK_IMAGE");
    if (telegramMockEnabled && !telegramMockImage) {
      throw new Error("SIMPLE_AGENT_MICROSERVICES_TELEGRAM_MOCK_ENABLED=true requires SIMPLE_AGENT_MICROSERVICES_TELEGRAM_MOCK_IMAGE.");
    }

    const postgresUser = readTrimmedEnv("SIMPLE_AGENT_MICROSERVICES_POSTGRES_USER") || "simpleagent";
    const postgresPassword = readTrimmedEnv("SIMPLE_AGENT_MICROSERVICES_POSTGRES_PASSWORD") || "simpleagent";
    const postgresDb = readTrimmedEnv("SIMPLE_AGENT_MICROSERVICES_POSTGRES_DB") || "simpleagent";
    const postDatabaseUrl = `postgresql://${encodeURIComponent(postgresUser)}:${encodeURIComponent(postgresPassword)}@127.0.0.1:5432/${encodeURIComponent(postgresDb)}`;

    const microservicesTaskCpu = readTrimmedEnv("SIMPLE_AGENT_MICROSERVICES_TASK_CPU") || cpu;
    const microservicesTaskMemory = readTrimmedEnv("SIMPLE_AGENT_MICROSERVICES_TASK_MEMORY") || memory;
    const microservicesHealthPath = readTrimmedEnv("SIMPLE_AGENT_MICROSERVICES_HEALTH_PATH") || "/health";

    const simpleAgentModel = readTrimmedEnv("SIMPLE_AGENT_MODEL") || "gpt-4o-mini";
    const defaultSystemPrompt =
      readTrimmedEnv("SIMPLE_AGENT_MICROSERVICES_SYSTEM_PROMPT") ||
      "You are a concise, helpful assistant.";
    const telegramApiBase = telegramMockEnabled
      ? "http://127.0.0.1:8005"
      : (readTrimmedEnv("SIMPLE_AGENT_MICROSERVICES_TELEGRAM_API_BASE") || "https://api.telegram.org");
    const mcpToolServiceUrl = readTrimmedEnv("SIMPLE_AGENT_MICROSERVICES_MCP_TOOL_SERVICE_URL") || "http://127.0.0.1:8004";

    const baseProviderEnv = [
      input.openaiApiKey?.trim() ? { name: "OPENAI_API_KEY", value: input.openaiApiKey.trim() } : null,
      input.anthropicApiKey?.trim() ? { name: "ANTHROPIC_API_KEY", value: input.anthropicApiKey.trim() } : null,
      input.subsidyProxyToken?.trim() && input.subsidyProxyBaseUrl?.trim() && !input.openaiApiKey && !input.anthropicApiKey && !input.openrouterApiKey
        ? { name: "OPENAI_API_KEY", value: input.subsidyProxyToken.trim() }
        : null,
      input.subsidyProxyToken?.trim() && input.subsidyProxyBaseUrl?.trim() && !input.openaiApiKey && !input.anthropicApiKey && !input.openrouterApiKey
        ? { name: "OPENAI_BASE_URL", value: input.subsidyProxyBaseUrl.trim() }
        : null,
      input.subsidyProxyToken?.trim() && input.subsidyProxyBaseUrl?.trim() && !input.openaiApiKey && !input.anthropicApiKey && !input.openrouterApiKey
        ? { name: "OPENAI_API_BASE", value: input.subsidyProxyBaseUrl.trim() }
        : null,
    ].filter((entry): entry is { name: string; value: string } => Boolean(entry));

    const containerDefinitions = [
      {
        name: "redis",
        image: redisImage,
        essential: true,
        portMappings: [{ containerPort: 6379, protocol: "tcp" as const }],
        logConfiguration: resolveLogConfiguration("redis"),
      },
      {
        name: "postgres",
        image: postgresImage,
        essential: true,
        environment: [
          { name: "POSTGRES_USER", value: postgresUser },
          { name: "POSTGRES_PASSWORD", value: postgresPassword },
          { name: "POSTGRES_DB", value: postgresDb },
        ],
        portMappings: [{ containerPort: 5432, protocol: "tcp" as const }],
        logConfiguration: resolveLogConfiguration("postgres"),
      },
      {
        name: "post-service",
        image: postImage,
        essential: true,
        dependsOn: [{ containerName: "postgres", condition: "START" as const }],
        environment: [
          { name: "POST_DATABASE_URL", value: postDatabaseUrl },
          { name: "LLM_MODEL", value: simpleAgentModel },
          { name: "SYSTEM_PROMPT", value: defaultSystemPrompt },
          ...baseProviderEnv,
        ],
        portMappings: [{ containerPort: 8003, protocol: "tcp" as const }],
        logConfiguration: resolveLogConfiguration("post"),
      },
      ...(mcpImage
        ? [
            {
              name: "mcp-tool-service",
              image: mcpImage,
              essential: false,
              environment: [
                { name: "MCP_DEFAULT_ENABLED", value: "1" },
                { name: "MCP_AUTO_OFF_IDLE_S", value: readTrimmedEnv("SIMPLE_AGENT_MICROSERVICES_MCP_AUTO_OFF_IDLE_S") || "300" },
                { name: "MCP_LOOP_INTERVAL_S", value: readTrimmedEnv("SIMPLE_AGENT_MICROSERVICES_MCP_LOOP_INTERVAL_S") || "1" },
                { name: "OTTOAUTH_BASE_URL", value: readTrimmedEnv("OTTOAGENT_MCP_BASE_URL") || "https://ottoauth.vercel.app" },
                { name: "AGENT_GATEWAY_URL", value: "http://127.0.0.1:8001/hooks/ottoauth" },
                { name: "AGENT_GATEWAY_AUTH_TOKEN", value: readTrimmedEnv("OTTOAGENT_MCP_TOKEN") || gatewayToken },
              ],
              portMappings: [{ containerPort: 8004, protocol: "tcp" as const }],
              logConfiguration: resolveLogConfiguration("mcp"),
            },
          ]
        : []),
      ...(telegramMockEnabled
        ? [
            {
              name: "telegram-mock-service",
              image: telegramMockImage,
              essential: false,
              portMappings: [{ containerPort: 8005, protocol: "tcp" as const }],
              logConfiguration: resolveLogConfiguration("telegram-mock"),
            },
          ]
        : []),
      {
        name: "gateway-service",
        image: gatewayImage,
        essential: true,
        dependsOn: [
          { containerName: "redis", condition: "START" as const },
          { containerName: "post-service", condition: "START" as const },
          ...(mcpImage ? [{ containerName: "mcp-tool-service", condition: "START" as const }] : []),
          ...(telegramMockEnabled ? [{ containerName: "telegram-mock-service", condition: "START" as const }] : []),
        ],
        environment: [
          { name: "REDIS_URL", value: "redis://127.0.0.1:6379/0" },
          { name: "POST_SERVICE_URL", value: "http://127.0.0.1:8003" },
          { name: "MCP_TOOL_SERVICE_URL", value: mcpToolServiceUrl },
          { name: "TELEGRAM_ENABLED", value: "1" },
          { name: "TELEGRAM_API_BASE", value: telegramApiBase },
          { name: "AGENT_GATEWAY_AUTH_TOKEN", value: readTrimmedEnv("OTTOAGENT_MCP_TOKEN") || gatewayToken },
          ...baseProviderEnv,
        ],
        portMappings: [{ containerPort: 8001, protocol: "tcp" as const }],
        logConfiguration: resolveLogConfiguration("gateway"),
      },
      {
        name: "execution-service",
        image: executionImage,
        essential: true,
        dependsOn: [
          { containerName: "redis", condition: "START" as const },
          { containerName: "post-service", condition: "START" as const },
          ...(mcpImage ? [{ containerName: "mcp-tool-service", condition: "START" as const }] : []),
        ],
        environment: [
          { name: "REDIS_URL", value: "redis://127.0.0.1:6379/0" },
          { name: "POST_SERVICE_URL", value: "http://127.0.0.1:8003" },
          { name: "MCP_TOOL_SERVICE_URL", value: mcpToolServiceUrl },
          { name: "LLM_MODEL", value: simpleAgentModel },
          { name: "SYSTEM_PROMPT", value: defaultSystemPrompt },
          ...baseProviderEnv,
        ],
        portMappings: [{ containerPort: 8002, protocol: "tcp" as const }],
        logConfiguration: resolveLogConfiguration("execution"),
      },
      {
        name: containerName,
        image,
        essential: true,
        environment: [
          { name: "GATEWAY_URL", value: "http://127.0.0.1:8001" },
          { name: "PORT", value: String(containerPort) },
        ],
        dependsOn: [{ containerName: "gateway-service", condition: "START" as const }],
        portMappings: [{ containerPort, protocol: "tcp" as const }],
        logConfiguration: resolveLogConfiguration("frontend"),
      },
    ];

    const albRouting = await ensureEcsAlbRouting({
      region,
      serviceName,
      containerName,
      containerPort,
      healthCheckPath: microservicesHealthPath,
    });

    const register = await ecsClient.send(
      new RegisterTaskDefinitionCommand({
        family,
        networkMode: "awsvpc",
        requiresCompatibilities: ["FARGATE"],
        cpu: microservicesTaskCpu,
        memory: microservicesTaskMemory,
        executionRoleArn,
        taskRoleArn: taskRoleArn || undefined,
        containerDefinitions,
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
      readyUrl: readyUrlBase,
    };
  }

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
    !isOpenClawRuntime && input.openaiApiKey?.trim()
      ? { name: "SIMPLEAGENT_LLM_API_KEY", value: input.openaiApiKey.trim() }
      : null,
    !isOpenClawRuntime && resolvedSimpleAgentLlmUrl
      ? { name: "SIMPLEAGENT_LLM_URL", value: resolvedSimpleAgentLlmUrl }
      : null,
    !isOpenClawRuntime && simpleAgentModel
      ? { name: "SIMPLEAGENT_MODEL", value: simpleAgentModel }
      : null,
    !isOpenClawRuntime && simpleAgentMcpServersJson
      ? { name: "SIMPLEAGENT_MCP_SERVERS_JSON", value: simpleAgentMcpServersJson }
      : null,
    input.subsidyProxyToken?.trim() && input.subsidyProxyBaseUrl?.trim() && !input.openaiApiKey && !input.anthropicApiKey && !input.openrouterApiKey
      ? { name: "OPENAI_API_KEY", value: input.subsidyProxyToken.trim() }
      : null,
    input.subsidyProxyToken?.trim() && input.subsidyProxyBaseUrl?.trim() && !input.openaiApiKey && !input.anthropicApiKey && !input.openrouterApiKey
      ? { name: "OPENAI_BASE_URL", value: input.subsidyProxyBaseUrl.trim() }
      : null,
    input.subsidyProxyToken?.trim() && input.subsidyProxyBaseUrl?.trim() && !input.openaiApiKey && !input.anthropicApiKey && !input.openrouterApiKey
      ? { name: "OPENAI_API_BASE", value: input.subsidyProxyBaseUrl.trim() }
      : null,
    { name: "PORT", value: String(containerPort) },
    openclawNodeOptions ? { name: "NODE_OPTIONS", value: openclawNodeOptions } : null,
    telemetryEnv ? { name: "OPENCLAW_TELEMETRY", value: telemetryEnv } : null,
  ].filter((entry): entry is { name: string; value: string } => Boolean(entry));
  const ottoAgentMcpEnvironment = [
    ottoAgentMcpBaseUrl ? { name: "OTTOAGENT_BASE_URL", value: ottoAgentMcpBaseUrl } : null,
    ottoAgentMcpBaseUrl ? { name: "OTTOAUTH_BASE_URL", value: ottoAgentMcpBaseUrl } : null,
    ottoAgentMcpToken ? { name: "OTTOAGENT_TOKEN", value: ottoAgentMcpToken } : null,
    ottoAgentMcpToken ? { name: "OTTOAUTH_TOKEN", value: ottoAgentMcpToken } : null,
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
        `node /app/dist/index.js config set gateway.port ${containerPort} || true`,
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
          // Run onboarding before gateway startup to avoid bootstrap races on fresh ECS task state.
          scriptSteps.push(
            "echo '[oneclick] running onboarding bootstrap' >&2",
            `${onboardCommand} >/tmp/oneclick-onboard.log 2>&1 || true`,
          );
          if (shouldAllowInsecureControlUi()) {
            scriptSteps.push(
              "echo '[oneclick] reapply control UI auth flags after onboard' >&2",
              "node /app/dist/index.js config set gateway.controlUi.allowInsecureAuth true || true",
              "node /app/dist/index.js config set gateway.controlUi.dangerouslyDisableDeviceAuth true || true",
            );
          }
        }
      }
      void deploymentFlavor;
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
  const containerDefinitions = [
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
          protocol: "tcp" as const,
        },
      ],
      logConfiguration: resolveLogConfiguration(""),
    },
    ...(isSimpleAgentWithOttoAuthEcs
      ? [
          {
            name: `${containerName}-ottoauth-mcp`.slice(0, 255),
            image: ottoAgentMcpImage,
            essential: true,
            command: ottoAgentMcpCommand.length > 0 ? ottoAgentMcpCommand : undefined,
            environment: ottoAgentMcpEnvironment,
            portMappings: [
                {
                  containerPort: ottoAgentMcpContainerPort,
                  protocol: "tcp" as const,
                },
              ],
            logConfiguration: resolveLogConfiguration("ottoauth-mcp"),
          },
        ]
      : []),
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
      containerDefinitions,
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
  if (input.providerOverride === "ecs") {
    return launchViaEcs(input);
  }
  if (input.providerOverride === "lambda") {
    return launchViaLambda(input);
  }
  if (input.providerOverride === "ssh" || input.providerOverride === "mock") {
    return launchViaSsh(input);
  }
  const configuredProvider = readTrimmedEnv("DEPLOY_PROVIDER").toLowerCase();
  if (configuredProvider === "ecs") {
    return launchViaEcs(input);
  }
  if (configuredProvider === "lambda") {
    return launchViaLambda(input);
  }
  return launchViaSsh(input);
}

export async function destroyUserRuntime(input: DestroyInput) {
  const provider = resolveRuntimeDestroyProvider(input.deployProvider, input.runtimeId);
  if (provider === "ssh") {
    const parsed = parseSshRuntimeId(input.runtimeId);
    const vmId = parsed?.vmId ?? parseDedicatedVmIdFromHostName(input.hostName);

    if (parsed) {
      let dockerCleanupError: Error | null = null;
      try {
        await runSshCommand(
          parsed.sshTarget,
          `if command -v docker >/dev/null 2>&1; then docker rm -f "${parsed.containerName}" "${buildVideoMemoryContainerName(parsed.containerName)}" "${buildOttoAgentMcpContainerName(parsed.containerName)}" >/dev/null 2>&1 || true; fi`,
        );
      } catch (error) {
        dockerCleanupError = error instanceof Error ? error : new Error(String(error));
      }
      if (vmId) {
        await deleteRuntimeDnsRecordByHost(hostNameFromReadyUrl(input.readyUrl)).catch(() => {});
        await destroyDedicatedVm(vmId);
        return;
      }
      if (dockerCleanupError) {
        throw dockerCleanupError;
      }
      await deleteRuntimeDnsRecordByHost(hostNameFromReadyUrl(input.readyUrl)).catch(() => {});
      return;
    }

    if (vmId) {
      await deleteRuntimeDnsRecordByHost(hostNameFromReadyUrl(input.readyUrl)).catch(() => {});
      await destroyDedicatedVm(vmId);
      return;
    }

    throw new Error("Invalid ssh runtime id format.");
  }
  if (provider === "shared" || provider === "lambda") {
    // Shared runtimes are intentionally reused and not deleted per deployment.
    return;
  }
  if (provider === "ecs") {
    const parsed = parseEcsRuntimeId(input.runtimeId);
    if (!parsed) {
      throw new Error("Invalid ecs runtime id format.");
    }
    const region = requireEnv("AWS_REGION");
    const ecsClient = new ECSClient(buildAwsConfigWithTrimmedCreds(region));
    try {
      await ecsClient.send(
        new DeleteServiceCommand({
          cluster: parsed.cluster,
          service: parsed.serviceName,
          force: true,
        }),
      );
    } catch (error) {
      if (!isIgnorableEcsDeleteError(error)) {
        throw error;
      }
    }
    await cleanupEcsAlbRouting({ region, serviceName: parsed.serviceName });
    return;
  }
  // For mock provider, destroy is a no-op.
}
