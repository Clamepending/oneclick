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

export function getOpenClawImage() {
  return readEnv("OPENCLAW_IMAGE") || "ghcr.io/phioranex/openclaw-docker:latest";
}

export function getOpenClawPort() {
  return Number(readEnv("OPENCLAW_CONTAINER_PORT") || "18789");
}

export function getOpenClawStartCommand() {
  return readEnv("OPENCLAW_START_COMMAND") || "gateway --allow-unconfigured";
}

export function shouldAllowInsecureControlUi() {
  return readBool("OPENCLAW_ALLOW_INSECURE_CONTROL_UI", true);
}
