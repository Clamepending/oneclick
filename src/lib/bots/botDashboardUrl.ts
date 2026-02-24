import { getBotDashboardBaseDomain } from "@/lib/subdomainConfig";

export function buildBotDashboardUrl(runtimeSlug: string | null | undefined) {
  const slug = runtimeSlug?.trim().toLowerCase();
  if (!slug) return null;

  const baseDomain = getBotDashboardBaseDomain();
  if (baseDomain) {
    return `https://${slug}.${baseDomain}`;
  }

  return `/bots/${slug}`;
}
