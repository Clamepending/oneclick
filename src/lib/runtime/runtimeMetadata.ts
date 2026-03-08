import { normalizeDeploymentFlavor, type DeploymentFlavor } from "@/lib/plans";

export const RUNTIME_CONTRACT_VERSION = "v1" as const;
export const TOOLS_PROTOCOL_VERSION = "tool-tag-v1" as const;

export type RuntimeKind = "simpleagent_embedded" | "simpleagent_vm_ssh";
export type RuntimeReleaseChannel = "stable" | "candidate" | "disabled";

export type RuntimeMetadata = {
  runtimeKind: RuntimeKind;
  runtimeVersion: string;
  runtimeContractVersion: typeof RUNTIME_CONTRACT_VERSION;
  runtimeReleaseChannel: RuntimeReleaseChannel;
};

type RuntimeMetadataRow = {
  deployment_flavor?: string | null;
  runtime_kind?: string | null;
  runtime_version?: string | null;
  runtime_contract_version?: string | null;
  runtime_release_channel?: string | null;
};

function readTrimmedEnv(name: string) {
  const raw = process.env[name];
  if (!raw) return "";
  return raw.trim().replace(/^"(.*)"$/, "$1").replace(/\\n/g, "").trim();
}

function normalizeRuntimeKind(value: string | null | undefined): RuntimeKind | null {
  const normalized = (value ?? "").trim().toLowerCase();
  if (normalized === "simpleagent_embedded") return "simpleagent_embedded";
  if (normalized === "simpleagent_vm_ssh") return "simpleagent_vm_ssh";
  return null;
}

function normalizeReleaseChannel(value: string | null | undefined): RuntimeReleaseChannel {
  const normalized = (value ?? "").trim().toLowerCase();
  if (normalized === "candidate") return "candidate";
  if (normalized === "disabled") return "disabled";
  return "stable";
}

function defaultEmbeddedRuntimeVersion() {
  return readTrimmedEnv("SIMPLE_AGENT_EMBEDDED_RUNTIME_VERSION") || "embedded-v1";
}

function defaultVmRuntimeVersion() {
  return readTrimmedEnv("SIMPLE_AGENT_VM_RUNTIME_VERSION") || "vm-legacy-v1";
}

export function resolveDefaultRuntimeMetadata(
  deploymentFlavor: DeploymentFlavor | string | null | undefined,
): RuntimeMetadata {
  const normalizedFlavor = normalizeDeploymentFlavor(deploymentFlavor);
  if (normalizedFlavor === "simple_agent_videomemory_free") {
    return {
      runtimeKind: "simpleagent_vm_ssh",
      runtimeVersion: defaultVmRuntimeVersion(),
      runtimeContractVersion: RUNTIME_CONTRACT_VERSION,
      runtimeReleaseChannel: "stable",
    };
  }
  return {
    runtimeKind: "simpleagent_embedded",
    runtimeVersion: defaultEmbeddedRuntimeVersion(),
    runtimeContractVersion: RUNTIME_CONTRACT_VERSION,
    runtimeReleaseChannel: "stable",
  };
}

export function resolveRuntimeMetadataFromRow(row: RuntimeMetadataRow): RuntimeMetadata {
  const fallback = resolveDefaultRuntimeMetadata(row.deployment_flavor ?? null);
  const runtimeKind = normalizeRuntimeKind(row.runtime_kind) ?? fallback.runtimeKind;
  return {
    runtimeKind,
    runtimeVersion: row.runtime_version?.trim() || fallback.runtimeVersion,
    runtimeContractVersion:
      row.runtime_contract_version?.trim() === RUNTIME_CONTRACT_VERSION
        ? RUNTIME_CONTRACT_VERSION
        : fallback.runtimeContractVersion,
    runtimeReleaseChannel: normalizeReleaseChannel(row.runtime_release_channel),
  };
}

