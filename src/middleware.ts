import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";

const PROTECTED_PREFIXES = [
  "/onboarding",
  "/deployments",
  "/bots",
  "/admin",
  "/api/onboarding",
  "/api/deployments",
  "/api/admin",
];

function normalizeOrigin(value: string | null | undefined) {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  try {
    const url = new URL(trimmed);
    return url.origin;
  } catch {
    return null;
  }
}

function getCanonicalLoginOrigin() {
  const explicit = normalizeOrigin(process.env.BOT_AUTH_LOGIN_BASE_URL);
  if (explicit) return explicit;
  const app = normalizeOrigin(process.env.APP_BASE_URL);
  if (app) return app;
  return normalizeOrigin(process.env.AUTH_URL);
}

function getBotSubdomain(hostname: string) {
  const baseDomain = process.env.BOT_DASHBOARD_BASE_DOMAIN?.trim().toLowerCase() ?? "";
  if (!baseDomain) return null;
  if (!hostname.endsWith(`.${baseDomain}`)) return null;
  const subdomain = hostname.slice(0, -(baseDomain.length + 1)).trim().toLowerCase();
  if (!subdomain || subdomain.includes(".")) return null;
  if (["www", "api", "app"].includes(subdomain)) return null;
  return subdomain;
}

export default auth((req) => {
  const rewrittenUrl = req.nextUrl.clone();
  const botSubdomain = getBotSubdomain(req.nextUrl.hostname.toLowerCase());
  const shouldRewriteBotRoot = botSubdomain && req.nextUrl.pathname === "/";
  if (shouldRewriteBotRoot) {
    rewrittenUrl.pathname = `/bots/${botSubdomain}`;
  }

  const effectivePath = shouldRewriteBotRoot ? rewrittenUrl.pathname : req.nextUrl.pathname;
  const isProtected = PROTECTED_PREFIXES.some((prefix) => effectivePath.startsWith(prefix));

  if (req.nextUrl.pathname.startsWith("/api/")) {
    return NextResponse.next();
  }

  if (!req.auth && isProtected) {
    const canonicalLoginOrigin = getCanonicalLoginOrigin();
    const shouldUseCanonicalLogin =
      Boolean(botSubdomain) && Boolean(canonicalLoginOrigin) && canonicalLoginOrigin !== req.nextUrl.origin;

    const loginBase = shouldUseCanonicalLogin && canonicalLoginOrigin ? canonicalLoginOrigin : req.url;
    const loginUrl = new URL("/login", loginBase);
    const callbackUrl = shouldUseCanonicalLogin
      ? req.nextUrl.toString()
      : effectivePath + req.nextUrl.search;
    loginUrl.searchParams.set("callbackUrl", callbackUrl);
    return NextResponse.redirect(loginUrl);
  }

  if (req.auth && effectivePath === "/login") {
    return NextResponse.redirect(new URL("/", req.url));
  }

  if (shouldRewriteBotRoot) {
    return NextResponse.rewrite(rewrittenUrl);
  }

  return NextResponse.next();
});

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
