export function sanitizeDnsLabel(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50);
}

export function buildRuntimeSubdomain(runtimeSlugSource: string | null | undefined, userId: string) {
  const preferred = sanitizeDnsLabel(runtimeSlugSource ?? "");
  if (preferred) return preferred;

  const localPart = userId.split("@")[0] ?? userId;
  const fallback = sanitizeDnsLabel(localPart);
  if (fallback) return fallback;

  return sanitizeDnsLabel(userId).slice(0, 12) || "runtime-user";
}

export function normalizeBotName(name: string) {
  return name.trim().toLowerCase().replace(/\s+/g, " ");
}
