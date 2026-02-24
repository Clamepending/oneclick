import { randomUUID } from "crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
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

  await execFileAsync("ssh", [sshTarget, remoteScript], {
    timeout: Number(process.env.OPENCLAW_SSH_TIMEOUT_MS ?? "120000"),
  });

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
