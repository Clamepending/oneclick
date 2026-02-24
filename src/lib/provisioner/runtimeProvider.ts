import { randomUUID } from "crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getOpenClawImage, getOpenClawPort, getOpenClawStartCommand } from "@/lib/provisioner/openclawBundle";
import type { Host } from "@/lib/provisioner/hostScheduler";

const execFileAsync = promisify(execFile);

type LaunchInput = {
  deploymentId: string;
  userId: string;
  host: Host;
};

function sanitizeSegment(value: string) {
  return value.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 48) || "default";
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

function buildSshArgs(sshTarget: string) {
  const args = ["-o", "BatchMode=yes"];
  const knownHosts = process.env.DEPLOY_SSH_KNOWN_HOSTS?.trim();
  const privateKeyRaw = process.env.DEPLOY_SSH_PRIVATE_KEY?.trim();
  let keyPath: string | null = null;

  if (knownHosts) {
    const knownHostsPath = join(tmpdir(), "oneclick-known-hosts");
    writeFileSync(knownHostsPath, `${knownHosts}\n`, { mode: 0o600 });
    args.push("-o", `UserKnownHostsFile=${knownHostsPath}`);
    args.push("-o", "StrictHostKeyChecking=yes");
  } else {
    args.push("-o", "StrictHostKeyChecking=no");
  }

  if (privateKeyRaw) {
    keyPath = join(tmpdir(), `oneclick-key-${Date.now()}`);
    const keyMaterial = privateKeyRaw.replace(/\\n/g, "\n");
    writeFileSync(keyPath, `${keyMaterial}\n`, { mode: 0o600 });
    args.push("-i", keyPath);
  }

  args.push(sshTarget);
  return { args, keyPath };
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
  const region = process.env.DO_REGION ?? "nyc1";
  const size = process.env.DO_SIZE ?? "s-1vcpu-2gb";
  const osImage = process.env.DO_IMAGE ?? "ubuntu-24-04-x64";
  const safeDeployment = sanitizeSegment(input.deploymentId);
  const safeUser = sanitizeSegment(input.userId);
  const dropletName = `oneclick-${safeDeployment}`.slice(0, 63);

  const configBase = process.env.OPENCLAW_CONFIG_MOUNT_BASE ?? "/var/lib/oneclick/openclaw";
  const workspaceSuffix = process.env.OPENCLAW_WORKSPACE_SUFFIX ?? "workspace";
  const userDir = `${configBase}/${safeUser}/${safeDeployment}`;
  const workspaceDir = `${userDir}/${workspaceSuffix}`;
  const containerName = `oneclick-${safeDeployment}`;

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
docker pull "${image}"
docker rm -f "${containerName}" >/dev/null 2>&1 || true
docker run -d --name "${containerName}" --restart unless-stopped \\
  -v "${userDir}:/home/node/.openclaw" \\
  -v "${workspaceDir}:/home/node/.openclaw/workspace" \\
  -p "${containerPort}:${containerPort}" \\
  "${image}" sh -lc '${startCommand.replace(/'/g, `'\"'\"'`)}'
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

  const readyUrl = `http://${publicIp}:${containerPort}`;
  return {
    runtimeId: String(dropletId),
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
  const hostPort = buildAssignedPort(input.deploymentId);

  const safeUser = sanitizeSegment(input.userId);
  const safeDeployment = sanitizeSegment(input.deploymentId);
  const containerName = `oneclick-${safeDeployment}`;
  const configBase = process.env.OPENCLAW_CONFIG_MOUNT_BASE ?? "/var/lib/oneclick/openclaw";
  const workspaceSuffix = process.env.OPENCLAW_WORKSPACE_SUFFIX ?? "workspace";
  const userDir = `${configBase}/${safeUser}/${safeDeployment}`;
  const workspaceDir = `${userDir}/${workspaceSuffix}`;

  const remoteScript = [
    `set -e`,
    `mkdir -p "${userDir}" "${workspaceDir}"`,
    `docker pull "${image}"`,
    `docker rm -f "${containerName}" >/dev/null 2>&1 || true`,
    `docker run -d --name "${containerName}" --restart unless-stopped \\`,
    `  -v "${userDir}:/home/node/.openclaw" \\`,
    `  -v "${workspaceDir}:/home/node/.openclaw/workspace" \\`,
    `  -p "${hostPort}:${containerPort}" \\`,
    `  "${image}" sh -lc '${startCommand.replace(/'/g, `'\"'\"'`)}'`,
  ].join(" && ");

  const { args, keyPath } = buildSshArgs(sshTarget);
  try {
    await execFileAsync("ssh", [...args, remoteScript], {
      timeout: Number(process.env.OPENCLAW_SSH_TIMEOUT_MS ?? "120000"),
    });
  } finally {
    if (keyPath) {
      rmSync(keyPath, { force: true });
    }
  }

  return {
    runtimeId: randomUUID(),
    image,
    port: containerPort,
    hostPort,
    startCommand,
    hostName: input.host.name,
    readyUrl: toReadyUrl(input.host, hostPort, input.deploymentId),
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
    image,
    port,
    hostPort: null,
    startCommand,
    hostName: input.host.name,
    readyUrl: `${process.env.APP_BASE_URL ?? "http://localhost:3000"}/runtime/${input.deploymentId}`,
  };
}
