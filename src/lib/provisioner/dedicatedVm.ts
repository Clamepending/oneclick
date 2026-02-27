import { setTimeout as sleep } from "node:timers/promises";
import type { Host } from "@/lib/provisioner/hostScheduler";

type DoDroplet = {
  id: number;
  name: string;
  status: string;
  networks?: {
    v4?: Array<{ ip_address: string; type: string }>;
  };
};

function readTrimmedEnv(name: string) {
  const raw = process.env[name];
  if (!raw) return "";
  return raw.trim().replace(/^"(.*)"$/, "$1").replace(/\\n/g, "").trim();
}

function getDoToken() {
  const token = readTrimmedEnv("DO_API_TOKEN");
  if (!token) {
    throw new Error("DO_API_TOKEN is required for dedicated DigitalOcean VM provisioning.");
  }
  return token;
}

async function doRequest(path: string, init?: RequestInit) {
  const token = getDoToken();
  const timeoutMs = Number(readTrimmedEnv("DO_API_TIMEOUT_MS") || "15000");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`https://api.digitalocean.com${path}`, {
      ...init,
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        ...(init?.headers ?? {}),
      },
    });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`DigitalOcean API ${response.status} ${response.statusText}: ${body.slice(0, 400)}`);
    }
    return response;
  } finally {
    clearTimeout(timer);
  }
}

async function resolveSshFingerprints() {
  const configured = readTrimmedEnv("DO_SSH_KEY_FINGERPRINTS") || readTrimmedEnv("DO_SSH_KEY_FINGERPRINT");
  if (configured) {
    return configured.split(",").map((item) => item.trim()).filter(Boolean);
  }

  const response = await doRequest("/v2/account/keys");
  const body = (await response.json()) as { ssh_keys?: Array<{ fingerprint?: string }> };
  const fingerprints = (body.ssh_keys ?? [])
    .map((key) => (key.fingerprint ?? "").trim())
    .filter(Boolean);
  if (fingerprints.length === 0) {
    throw new Error("No SSH keys found in DigitalOcean account. Add a key or set DO_SSH_KEY_FINGERPRINTS.");
  }
  return [fingerprints[0]];
}

function buildVmName(input: { deploymentId: string }) {
  const prefix = readTrimmedEnv("DO_VM_NAME_PREFIX") || "oneclick-bot";
  const suffix = input.deploymentId.replace(/[^a-zA-Z0-9-]/g, "").slice(0, 12).toLowerCase();
  return `${prefix}-${suffix}`.slice(0, 63);
}

function getPublicIp(droplet: DoDroplet) {
  return (
    droplet.networks?.v4?.find((network) => network.type === "public")?.ip_address?.trim() || ""
  );
}

function buildCloudInitUserData() {
  return `#cloud-config
package_update: true
packages:
  - docker.io
runcmd:
  - systemctl enable docker
  - systemctl restart docker
`;
}

export async function createDedicatedSshHost(input: { deploymentId: string; userId: string }): Promise<Host> {
  const region = readTrimmedEnv("DO_REGION") || "nyc1";
  const size = readTrimmedEnv("DO_SIZE") || "s-1vcpu-2gb";
  const image = readTrimmedEnv("DO_IMAGE") || "ubuntu-24-04-x64";
  const tags = (readTrimmedEnv("DO_TAGS") || "oneclick,oneclick-bot")
    .split(",")
    .map((tag) => tag.trim())
    .filter(Boolean);
  const sshFingerprints = await resolveSshFingerprints();

  const createResponse = await doRequest("/v2/droplets", {
    method: "POST",
    body: JSON.stringify({
      name: buildVmName({ deploymentId: input.deploymentId }),
      region,
      size,
      image,
      ssh_keys: sshFingerprints,
      tags,
      monitoring: true,
      backups: false,
      ipv6: false,
      user_data: buildCloudInitUserData(),
    }),
  });
  const created = (await createResponse.json()) as { droplet?: DoDroplet };
  const dropletId = created.droplet?.id;
  if (!dropletId) {
    throw new Error("DigitalOcean create droplet response missing droplet id.");
  }

  const deadline = Date.now() + Number(readTrimmedEnv("DO_PROVISION_TIMEOUT_MS") || "600000");
  let activeDroplet: DoDroplet | null = null;
  while (Date.now() < deadline) {
    const response = await doRequest(`/v2/droplets/${dropletId}`);
    const body = (await response.json()) as { droplet?: DoDroplet };
    const droplet = body.droplet ?? null;
    const publicIp = droplet ? getPublicIp(droplet) : "";
    if (droplet && droplet.status === "active" && publicIp) {
      activeDroplet = droplet;
      break;
    }
    await sleep(5000);
  }

  if (!activeDroplet) {
    throw new Error(`Timed out waiting for dedicated VM ${dropletId} to become active.`);
  }

  const publicIp = getPublicIp(activeDroplet);
  if (!publicIp) {
    throw new Error(`Dedicated VM ${dropletId} has no public IP.`);
  }

  const bootWaitMs = Number(readTrimmedEnv("OPENCLAW_VM_BOOT_WAIT_MS") || "30000");
  if (bootWaitMs > 0) {
    await sleep(bootWaitMs);
  }

  return {
    name: `do-vm-${dropletId}`,
    dockerHost: `ssh://root@${publicIp}`,
    publicBaseUrl: `http://${publicIp}`,
    vmId: String(dropletId),
  };
}

export async function destroyDedicatedVm(vmId: string) {
  const normalized = vmId.trim();
  if (!/^\d+$/.test(normalized)) {
    throw new Error("Invalid VM id.");
  }
  try {
    await doRequest(`/v2/droplets/${normalized}`, { method: "DELETE" });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("404")) return;
    throw error;
  }
}
