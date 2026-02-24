import NextAuth from "next-auth";
import Google from "next-auth/providers/google";
import { getBotDashboardBaseDomain } from "@/lib/subdomainConfig";

function parseHostnameFromUrl(value: string | null | undefined) {
  if (!value) return null;
  try {
    return new URL(value).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function getAllowedRedirectHosts() {
  const hosts = new Set<string>();
  const authHost = parseHostnameFromUrl(process.env.AUTH_URL);
  const appHost = parseHostnameFromUrl(process.env.APP_BASE_URL);
  if (authHost) hosts.add(authHost);
  if (appHost) hosts.add(appHost);
  return hosts;
}

function getAllowedRedirectBaseDomains() {
  const domains = new Set<string>();
  const botBaseDomain = getBotDashboardBaseDomain();
  if (botBaseDomain) domains.add(botBaseDomain);
  return domains;
}

function isAllowedCrossSubdomainRedirect(candidate: URL) {
  const hostname = candidate.hostname.toLowerCase();
  const allowedHosts = getAllowedRedirectHosts();
  if (allowedHosts.has(hostname)) return true;

  const allowedBaseDomains = getAllowedRedirectBaseDomains();
  for (const baseDomain of allowedBaseDomains) {
    if (hostname === baseDomain || hostname.endsWith(`.${baseDomain}`)) {
      return true;
    }
  }

  return false;
}

function getSessionCookieConfig() {
  const cookieDomain = process.env.AUTH_COOKIE_DOMAIN?.trim();
  if (!cookieDomain) return undefined;

  const secureCookie =
    process.env.NODE_ENV === "production" ||
    process.env.AUTH_URL?.trim().startsWith("https://") ||
    process.env.APP_BASE_URL?.trim().startsWith("https://");

  return {
    sessionToken: {
      name: secureCookie ? "__Secure-authjs.session-token" : "authjs.session-token",
      options: {
        domain: cookieDomain,
        httpOnly: true,
        path: "/",
        sameSite: "lax" as const,
        secure: secureCookie,
      },
    },
  };
}

export const {
  handlers: { GET, POST },
  auth,
  signIn,
  signOut,
} = NextAuth({
  trustHost: true,
  session: { strategy: "jwt" },
  cookies: getSessionCookieConfig(),
  callbacks: {
    async redirect({ url, baseUrl }) {
      try {
        const candidate = new URL(url, baseUrl);
        if (candidate.origin === baseUrl) return candidate.toString();
        if (isAllowedCrossSubdomainRedirect(candidate)) return candidate.toString();
        return baseUrl;
      } catch {
        return baseUrl;
      }
    },
  },
  providers: [
    Google({
      clientId: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    }),
  ],
  pages: {
    signIn: "/login",
  },
});
