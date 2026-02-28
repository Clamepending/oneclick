import { normalizeDeploymentFlavor, type DeploymentFlavor } from "@/lib/plans";

function readEnv(name: string) {
  const raw = process.env[name];
  if (!raw) return "";
  // Handle accidentally quoted or newline-suffixed env values from CLI imports.
  return raw.trim().replace(/^"(.*)"$/, "$1").trim();
}

function readBool(name: string, fallback: boolean) {
  const value = readEnv(name).toLowerCase();
  if (!value) return fallback;
  if (["1", "true", "yes", "on"].includes(value)) return true;
  if (["0", "false", "no", "off"].includes(value)) return false;
  return fallback;
}

let warnedAboutFloatingImage = false;

function isDigestRef(image: string) {
  return /@sha256:[a-f0-9]{64}$/i.test(image.trim());
}

function isFloatingImageRef(image: string) {
  const trimmed = image.trim();
  if (!trimmed) return true;
  if (isDigestRef(trimmed)) return false;

  const lastSlash = trimmed.lastIndexOf("/");
  const lastColon = trimmed.lastIndexOf(":");
  const hasExplicitTag = lastColon > lastSlash;
  if (!hasExplicitTag) return true;

  const tag = trimmed.slice(lastColon + 1).trim().toLowerCase();
  return !tag || tag === "latest";
}

export function getOpenClawImage() {
  const image = readEnv("OPENCLAW_IMAGE") || "alpine/openclaw:latest";
  const requirePinned = readBool("OPENCLAW_REQUIRE_PINNED_IMAGE", false);
  if (isFloatingImageRef(image)) {
    const message =
      `OPENCLAW_IMAGE must be pinned (tag or digest, not floating/latest). Current value: ${image}`;
    if (requirePinned) {
      throw new Error(`${message}. Set a stable image tag/digest or disable OPENCLAW_REQUIRE_PINNED_IMAGE.`);
    }
    if (!warnedAboutFloatingImage) {
      warnedAboutFloatingImage = true;
      console.warn(`[oneclick] ${message}`);
    }
  }
  return image;
}

export function getOpenClawPort() {
  return Number(readEnv("OPENCLAW_CONTAINER_PORT") || "18789");
}

export function getOpenClawStartCommand() {
  const raw = readEnv("OPENCLAW_START_COMMAND") || "gateway --allow-unconfigured";
  // Some images expose `gateway` directly and fail on `gateway run ...`.
  return raw.replace(/^gateway\s+run(\s+|$)/i, "gateway ");
}

export function shouldAllowInsecureControlUi() {
  return readBool("OPENCLAW_ALLOW_INSECURE_CONTROL_UI", true);
}

export function getSimpleAgentImage() {
  return readEnv("SIMPLE_AGENT_IMAGE") || "oneclick/adminagent:main";
}

export function getSimpleAgentPort() {
  return Number(readEnv("SIMPLE_AGENT_CONTAINER_PORT") || "18789");
}

export function getSimpleAgentStartCommand() {
  return readEnv("SIMPLE_AGENT_START_COMMAND") || "";
}

export function getSimpleAgentBuildRepo() {
  return readEnv("SIMPLE_AGENT_BUILD_REPO") || "https://github.com/Clamepending/adminagent.git#main";
}

export function shouldBuildSimpleAgentImage() {
  return readBool("SIMPLE_AGENT_BUILD_ON_HOST", true);
}

export function getOttoAgentImage() {
  return readEnv("OTTOAGENT_IMAGE") || getSimpleAgentImage();
}

export function getOttoAgentPort() {
  const configured = readEnv("OTTOAGENT_CONTAINER_PORT");
  return configured ? Number(configured) : getSimpleAgentPort();
}

export function getOttoAgentStartCommand() {
  const configured = readEnv("OTTOAGENT_START_COMMAND");
  return configured || getSimpleAgentStartCommand();
}

export function getOttoAgentBuildRepo() {
  return readEnv("OTTOAGENT_BUILD_REPO") || "../ottoagent";
}

export function shouldBuildOttoAgentImage() {
  return readBool("OTTOAGENT_BUILD_ON_HOST", shouldBuildSimpleAgentImage());
}

export function getOttoAgentMcpImage() {
  return readEnv("OTTOAGENT_MCP_IMAGE") || "oneclick/ottoagent-mcp:main";
}

export function getOttoAgentMcpPort() {
  return Number(readEnv("OTTOAGENT_MCP_PORT") || "8787");
}

export function getOttoAgentMcpPath() {
  return readEnv("OTTOAGENT_MCP_PATH") || "/mcp";
}

export function getOttoAgentMcpStartCommand() {
  return readEnv("OTTOAGENT_MCP_START_COMMAND") || "";
}

export function getOttoAgentMcpBuildRepo() {
  return readEnv("OTTOAGENT_MCP_BUILD_REPO") || "../ottoagent-mcp";
}

export function shouldBuildOttoAgentMcpImage() {
  return readBool("OTTOAGENT_MCP_BUILD_ON_HOST", true);
}

export function getVideoMemoryImage() {
  return readEnv("VIDEOMEMORY_IMAGE") || "oneclick/videomemory:main";
}

export function getVideoMemoryPort() {
  return Number(readEnv("VIDEOMEMORY_CONTAINER_PORT") || "5050");
}

export function getVideoMemoryStartCommand() {
  return readEnv("VIDEOMEMORY_START_COMMAND") || "";
}

export function getVideoMemoryBuildRepo() {
  return readEnv("VIDEOMEMORY_BUILD_REPO") || "https://github.com/Clamepending/videomemory.git#MCP-ify";
}

export function shouldBuildVideoMemoryImage() {
  return readBool("VIDEOMEMORY_BUILD_ON_HOST", true);
}

export function getRuntimeImage(flavor: DeploymentFlavor | null | undefined) {
  const normalized = normalizeDeploymentFlavor(flavor);
  if (normalized === "ottoagent_free") return getOttoAgentImage();
  return normalized === "deploy_openclaw_free" ? getOpenClawImage() : getSimpleAgentImage();
}

export function getRuntimePort(flavor: DeploymentFlavor | null | undefined) {
  const normalized = normalizeDeploymentFlavor(flavor);
  if (normalized === "ottoagent_free") return getOttoAgentPort();
  return normalized === "deploy_openclaw_free" ? getOpenClawPort() : getSimpleAgentPort();
}

export function getRuntimeStartCommand(flavor: DeploymentFlavor | null | undefined) {
  const normalized = normalizeDeploymentFlavor(flavor);
  if (normalized === "ottoagent_free") return getOttoAgentStartCommand();
  return normalized === "deploy_openclaw_free" ? getOpenClawStartCommand() : getSimpleAgentStartCommand();
}
