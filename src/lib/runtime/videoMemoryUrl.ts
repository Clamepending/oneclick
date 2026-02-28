import { createHash } from "crypto";
import { normalizeDeploymentFlavor } from "@/lib/plans";

function readTrimmed(name: string) {
  const raw = process.env[name];
  if (!raw) return "";
  return raw.trim().replace(/^"(.*)"$/, "$1").replace(/\\n/g, "").trim();
}

function parseSshRuntimeHost(runtimeId: string | null | undefined) {
  if (!runtimeId?.startsWith("ssh:")) return null;
  const body = runtimeId.slice(4);
  const [sshTarget] = body.split("|");
  if (!sshTarget) return null;
  const atIndex = sshTarget.lastIndexOf("@");
  const hostPart = atIndex >= 0 ? sshTarget.slice(atIndex + 1) : sshTarget;
  const host = hostPart.trim();
  return host || null;
}

function buildAssignedPort(seed: string) {
  const base = Number(readTrimmed("OPENCLAW_HOST_PORT_BASE") || "20000");
  const span = Number(readTrimmed("OPENCLAW_HOST_PORT_SPAN") || "10000");
  const hex = createHash("sha1").update(seed).digest("hex").slice(0, 8);
  const offset = Number.parseInt(hex, 16) % span;
  return base + offset;
}

export function buildVideoMemoryUrl(input: {
  deploymentId: string;
  deploymentFlavor: string | null | undefined;
  runtimeId: string | null | undefined;
  status: string | null | undefined;
  videoMemoryReadyAt?: string | null | undefined;
  requireReadyMarker?: boolean;
}) {
  if ((input.status ?? "").trim().toLowerCase() !== "ready") return null;
  if (input.requireReadyMarker && !input.videoMemoryReadyAt) return null;
  if (normalizeDeploymentFlavor(input.deploymentFlavor) !== "simple_agent_videomemory_free") return null;
  const host = parseSshRuntimeHost(input.runtimeId);
  if (!host) return null;
  const port = buildAssignedPort(`${input.deploymentId}-videomemory`);
  return `http://${host}:${port}/`;
}
