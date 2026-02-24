import { randomUUID } from "crypto";
import { Client } from "ssh2";
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
  modelProvider?: string | null;
  modelApiKey?: string | null;
  subsidyProxyBaseUrl?: string | null;
  subsidyProxyToken?: string | null;
  host: Host;
};

type DestroyInput = {
  runtimeId: string;
  deployProvider: string | null;
};

function sanitizeSegment(value: string) {
  return value.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 48) || "default";
}

function shellQuote(value: string) {
  return `'${value.replace(/'/g, `'\"'\"'`)}'`;
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

function getRuntimeBaseDomain() {
  return process.env.RUNTIME_BASE_DOMAIN?.trim().toLowerCase() ?? "";
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

async function runSshCommand(sshTarget: string, command: string) {
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
    let timer: NodeJS.Timeout | null = null;

    const clearTimer = () => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    };

    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimer();
      conn.end();
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    };

    conn
      .on("ready", () => {
        timer = setTimeout(() => {
          finish(new Error(`SSH command timed out after ${timeoutMs}ms`));
        }, timeoutMs);

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

function extractPublicIp(networks: unknown): string | null {
  if (!networks || typeof networks !== "object") return null;
  const maybe = networks as { v4?: Array<{ type?: string; ip_address?: string }> };
  const publicNet = maybe.v4?.find((entry) => entry.type === "public" && entry.ip_address);
  return publicNet?.ip_address ?? null;
}

async function launchViaDigitalOcean(input: LaunchInput) {
  const token = process.env.DO_API_TOKEN?.trim();
  if (!token) {
    throw new Error("DO_API_TOKEN is required for DEPLOY_PROVIDER=digitalocean.");
  }

  const image = getOpenClawImage();
  const containerPort = getOpenClawPort();
  const startCommand = getOpenClawStartCommand();
  const allowInsecureControlUi = shouldAllowInsecureControlUi();
  const gatewayToken = getGatewayToken();
  const region = process.env.DO_REGION ?? "nyc1";
  const size = process.env.DO_SIZE ?? "s-1vcpu-2gb";
  const osImage = process.env.DO_IMAGE ?? "ubuntu-24-04-x64";
  const safeDeployment = sanitizeSegment(input.deploymentId);
  const safeUser = sanitizeSegment(input.userId);
  const runtimeName = buildRuntimeName(input);
  const dropletName = runtimeName;
  const telegramBotToken = input.telegramBotToken?.trim() || "";
  const modelProvider = input.modelProvider?.trim().toLowerCase() || "";
  const modelApiKey = input.modelApiKey?.trim() || "";
  const subsidyProxyBaseUrl = input.subsidyProxyBaseUrl?.trim() || "";
  const subsidyProxyToken = input.subsidyProxyToken?.trim() || "";

  const configBase = process.env.OPENCLAW_CONFIG_MOUNT_BASE ?? "/var/lib/oneclick/openclaw";
  const workspaceSuffix = process.env.OPENCLAW_WORKSPACE_SUFFIX ?? "workspace";
  const userDir = `${configBase}/${safeUser}/${safeDeployment}`;
  const workspaceDir = `${userDir}/${workspaceSuffix}`;
  const containerName = runtimeName;
  const telegramEnvArgs = telegramBotToken
    ? `  -e TELEGRAM_BOT_TOKEN=${shellQuote(telegramBotToken)} \\\n`
    : "";
  const modelEnvArgs =
    modelProvider === "openai" && modelApiKey
      ? `  -e OPENAI_API_KEY=${shellQuote(modelApiKey)} \\\n`
      : modelProvider === "anthropic" && modelApiKey
        ? `  -e ANTHROPIC_API_KEY=${shellQuote(modelApiKey)} \\\n`
        : "";
  const subsidyEnvArgs =
    !modelApiKey && subsidyProxyBaseUrl && subsidyProxyToken
      ? `  -e OPENAI_API_KEY=${shellQuote(subsidyProxyToken)} \\\n  -e OPENAI_BASE_URL=${shellQuote(subsidyProxyBaseUrl)} \\\n  -e OPENAI_API_BASE=${shellQuote(subsidyProxyBaseUrl)} \\\n`
      : "";

  // Cloud-init script bootstraps Docker and launches the OpenClaw container.
  const userDataScript = `#!/bin/bash
set -euxo pipefail
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y ca-certificates curl
curl -fsSL https://get.docker.com | sh
systemctl enable docker
systemctl start docker
mkdir -p "${userDir}" "${workspaceDir}"
chown -R 1000:1000 "${userDir}" "${workspaceDir}" || true
docker pull "${image}"
docker rm -f "${containerName}" >/dev/null 2>&1 || true
docker run --rm \\
  -v "${userDir}:/home/node/.openclaw" \\
  -v "${workspaceDir}:/home/node/.openclaw/workspace" \\
  "${image}" config set gateway.bind lan
docker run --rm \\
  -v "${userDir}:/home/node/.openclaw" \\
  -v "${workspaceDir}:/home/node/.openclaw/workspace" \\
  "${image}" config set gateway.auth.token ${shellQuote(gatewayToken)}
${allowInsecureControlUi ? `docker run --rm \\
  -v "${userDir}:/home/node/.openclaw" \\
  -v "${workspaceDir}:/home/node/.openclaw/workspace" \\
  "${image}" config set gateway.controlUi.allowInsecureAuth true
docker run --rm \\
  -v "${userDir}:/home/node/.openclaw" \\
  -v "${workspaceDir}:/home/node/.openclaw/workspace" \\
  "${image}" config set gateway.controlUi.dangerouslyDisableDeviceAuth true
docker run --rm \\
  -v "${userDir}:/home/node/.openclaw" \\
  -v "${workspaceDir}:/home/node/.openclaw/workspace" \\
  "${image}" config set gateway.trustedProxies '["172.16.0.0/12"]'` : ""}
docker run -d --name "${containerName}" --restart unless-stopped \\
  -v "${userDir}:/home/node/.openclaw" \\
  -v "${workspaceDir}:/home/node/.openclaw/workspace" \\
${telegramEnvArgs}
${modelEnvArgs}
${subsidyEnvArgs}
  -p "${containerPort}:${containerPort}" \\
  "${image}" ${startCommand}
`;

  const response = await fetch("https://api.digitalocean.com/v2/droplets", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      name: dropletName,
      region,
      size,
      image: osImage,
      user_data: userDataScript,
      ipv6: true,
      monitoring: true,
      backups: false,
      tags: ["oneclick", "openclaw"],
    }),
    signal: AbortSignal.timeout(Number(process.env.DO_API_TIMEOUT_MS ?? "15000")),
  });

  if (!response.ok) {
    const details = await response.text();
    throw new Error(`DigitalOcean create droplet failed (${response.status}): ${details}`);
  }

  const payload = (await response.json()) as {
    droplet?: {
      id?: number;
      networks?: unknown;
    };
  };

  const dropletId = payload?.droplet?.id;
  if (!dropletId) {
    throw new Error("DigitalOcean did not return droplet id.");
  }

  // Try IP from create response first.
  let publicIp = extractPublicIp(payload?.droplet?.networks);
  if (!publicIp) {
    // Then fetch droplet detail once.
    const detailRes = await fetch(`https://api.digitalocean.com/v2/droplets/${dropletId}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(Number(process.env.DO_API_TIMEOUT_MS ?? "15000")),
    });
    if (detailRes.ok) {
      const detail = (await detailRes.json()) as {
        droplet?: { networks?: unknown };
      };
      publicIp = extractPublicIp(detail?.droplet?.networks);
    }
  }

  if (!publicIp) {
    throw new Error("Droplet created but public IP not available yet.");
  }

  const readyUrl = withGatewayToken(`http://${publicIp}:${containerPort}`, gatewayToken);
  return {
    runtimeId: String(dropletId),
    deployProvider: "digitalocean",
    image,
    port: containerPort,
    hostPort: containerPort,
    startCommand,
    hostName: `do:${dropletName}`,
    readyUrl,
  };
}

async function launchViaSsh(input: LaunchInput) {
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
  const modelProvider = input.modelProvider?.trim().toLowerCase() || "";
  const modelApiKey = input.modelApiKey?.trim() || "";
  const subsidyProxyBaseUrl = input.subsidyProxyBaseUrl?.trim() || "";
  const subsidyProxyToken = input.subsidyProxyToken?.trim() || "";

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
          `docker run --rm -v "${userDir}:/home/node/.openclaw" -v "${workspaceDir}:/home/node/.openclaw/workspace" "${image}" config set gateway.trustedProxies '["172.16.0.0/12"]'`,
        ]
      : []),
    `docker run -d --name "${containerName}" --restart unless-stopped -v "${userDir}:/home/node/.openclaw" -v "${workspaceDir}:/home/node/.openclaw/workspace"${telegramBotToken ? ` -e TELEGRAM_BOT_TOKEN=${shellQuote(telegramBotToken)}` : ""}${modelProvider === "openai" && modelApiKey ? ` -e OPENAI_API_KEY=${shellQuote(modelApiKey)}` : ""}${modelProvider === "anthropic" && modelApiKey ? ` -e ANTHROPIC_API_KEY=${shellQuote(modelApiKey)}` : ""}${!modelApiKey && subsidyProxyBaseUrl && subsidyProxyToken ? ` -e OPENAI_API_KEY=${shellQuote(subsidyProxyToken)} -e OPENAI_BASE_URL=${shellQuote(subsidyProxyBaseUrl)} -e OPENAI_API_BASE=${shellQuote(subsidyProxyBaseUrl)}` : ""} -p "${hostPort}:${containerPort}" "${image}" ${startCommand}`,
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
    hostName: input.host.name,
    readyUrl: withGatewayToken(
      runtimeDomain?.readyUrl ?? toReadyUrl(input.host, hostPort, input.deploymentId),
      gatewayToken,
    ),
  };
}

export async function launchUserContainer(input: LaunchInput) {
  const provider = process.env.DEPLOY_PROVIDER ?? "mock";

  if (provider === "ssh") {
    return launchViaSsh(input);
  }

  if (provider === "digitalocean") {
    return launchViaDigitalOcean(input);
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
    hostName: input.host.name,
    readyUrl: `${process.env.APP_BASE_URL ?? "http://localhost:3000"}/runtime/${input.deploymentId}`,
  };
}

async function destroyDigitalOceanRuntime(runtimeId: string) {
  const token = process.env.DO_API_TOKEN?.trim();
  if (!token) {
    throw new Error("DO_API_TOKEN is required to destroy DigitalOcean runtime.");
  }

  const response = await fetch(`https://api.digitalocean.com/v2/droplets/${runtimeId}`, {
    method: "DELETE",
    headers: {
      Authorization: `Bearer ${token}`,
    },
    signal: AbortSignal.timeout(Number(process.env.DO_API_TIMEOUT_MS ?? "15000")),
  });

  if (response.status === 404) return;
  if (response.status !== 204) {
    const details = await response.text();
    throw new Error(`DigitalOcean destroy droplet failed (${response.status}): ${details}`);
  }
}

export async function destroyUserRuntime(input: DestroyInput) {
  const provider = input.deployProvider ?? "";
  if (provider === "digitalocean") {
    await destroyDigitalOceanRuntime(input.runtimeId);
    return;
  }
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
  // For mock provider, destroy is a no-op.
}
