export function buildBotDashboardUrl(runtimeSlug: string | null | undefined) {
  const slug = runtimeSlug?.trim().toLowerCase();
  if (!slug) return null;

  const baseDomain = process.env.BOT_DASHBOARD_BASE_DOMAIN?.trim().toLowerCase() ?? "";
  if (baseDomain) {
    return `https://${slug}.${baseDomain}`;
  }

  return `/bots/${slug}`;
}
