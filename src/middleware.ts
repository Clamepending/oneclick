import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";

const PROTECTED_PREFIXES = ["/onboarding", "/deployments", "/api/onboarding", "/api/deployments"];

export default auth((req) => {
  const isProtected = PROTECTED_PREFIXES.some((prefix) =>
    req.nextUrl.pathname.startsWith(prefix),
  );

  if (req.nextUrl.pathname.startsWith("/api/")) {
    return NextResponse.next();
  }

  if (!req.auth && isProtected) {
    const loginUrl = new URL("/login", req.url);
    loginUrl.searchParams.set("callbackUrl", req.nextUrl.pathname + req.nextUrl.search);
    return NextResponse.redirect(loginUrl);
  }

  if (req.auth && req.nextUrl.pathname === "/login") {
    return NextResponse.redirect(new URL("/onboarding", req.url));
  }

  return NextResponse.next();
});

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
