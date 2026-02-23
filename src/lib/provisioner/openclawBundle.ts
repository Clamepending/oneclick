export function getOpenClawImage() {
  return process.env.OPENCLAW_IMAGE ?? "ghcr.io/phioranex/openclaw-docker:latest";
}

export function getOpenClawPort() {
  return Number(process.env.OPENCLAW_CONTAINER_PORT ?? "18789");
}

export function getOpenClawStartCommand() {
  return process.env.OPENCLAW_START_COMMAND ?? "gateway start --foreground";
}
