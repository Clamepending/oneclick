function readEnv(name: string) {
  const raw = process.env[name];
  if (!raw) return "";
  // Handle accidentally quoted or newline-suffixed env values from CLI imports.
  return raw.trim().replace(/^"(.*)"$/, "$1").trim();
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
