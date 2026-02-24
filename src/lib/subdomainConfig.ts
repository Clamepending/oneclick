function readTrimmed(name: string) {
  const raw = process.env[name];
  if (!raw) return "";
  return raw.trim().replace(/^"(.*)"$/, "$1").replace(/\\n/g, "").trim();
}

function readBool(name: string) {
  const value = readTrimmed(name).toLowerCase();
  return ["1", "true", "yes", "on"].includes(value);
}

export function wildcardSubdomainsEnabled() {
  return readBool("ENABLE_WILDCARD_SUBDOMAINS");
}

export function getBotDashboardBaseDomain() {
  if (!wildcardSubdomainsEnabled()) return "";
  return readTrimmed("BOT_DASHBOARD_BASE_DOMAIN").toLowerCase();
}

export function getRuntimeBaseDomain() {
  if (!wildcardSubdomainsEnabled()) return "";
  return readTrimmed("RUNTIME_BASE_DOMAIN").toLowerCase();
}
