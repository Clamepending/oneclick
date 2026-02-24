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
    const loginUrl = new URL("/login", req.url);
    loginUrl.searchParams.set(
      "callbackUrl",
      effectivePath + req.nextUrl.search,
    );
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
