type OpenUiInput = {
  botDashboardUrl?: string | null;
  readyUrl?: string | null;
  fallbackRuntimePath?: string | null;
};

function looksLikeAbsoluteHttpUrl(value: string) {
  return /^https?:\/\//i.test(value);
}

function normalizeExternalDashboardUrl(raw: string | null | undefined) {
  const value = String(raw || "").trim();
  if (!value || !looksLikeAbsoluteHttpUrl(value)) return "";
  return value;
}

function withOneclickUiParams(rawUrl: string) {
  const value = String(rawUrl || "").trim();
  if (!value) return "";

  try {
    const absolute = looksLikeAbsoluteHttpUrl(value);
    const parsed = absolute ? new URL(value) : new URL(value, "https://oneclick.local");
    parsed.searchParams.set("ui_mode", "oneclick");
    parsed.searchParams.set("hide_bot_session", "1");
    if (absolute) return parsed.toString();
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    const hashIndex = value.indexOf("#");
    const base = hashIndex >= 0 ? value.slice(0, hashIndex) : value;
    const hash = hashIndex >= 0 ? value.slice(hashIndex) : "";
    const separator = base.includes("?") ? "&" : "?";
    return `${base}${separator}ui_mode=oneclick&hide_bot_session=1${hash}`;
  }
}

export function buildSimpleAgentOpenUiUrl(input: OpenUiInput) {
  const source =
    String(input.fallbackRuntimePath || "").trim() ||
    normalizeExternalDashboardUrl(input.botDashboardUrl) ||
    String(input.readyUrl || "").trim() ||
    "";
  if (!source) return null;
  return withOneclickUiParams(source);
}
