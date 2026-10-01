import { NextResponse, type NextRequest } from "next/server";
import { cookieAttributes, cookieName } from "@/lib/auth-cookies";

// Cheap navigation guard, not authorization.
//
// The presence of a cookie says nothing about whether the session behind it is
// live, so this file deliberately knows nothing about sessions. Every protected
// page, Route Handler and Server Action calls `requireOperator()` itself and
// fails closed on its own; a request that reaches one of them without passing
// through here is still refused.
//
// It must also stay free of PostgreSQL and of `node:crypto`: this module runs in
// the edge runtime.
const PROTECTED_PREFIXES = ["/projects", "/settings", "/change-password"];

const LOGIN_CSRF_MAX_AGE_SECONDS = 60 * 60;

function isProtected(pathname: string) {
  return PROTECTED_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}

function randomToken() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  let response: NextResponse | null = null;

  // HEAD is a GET without a body as far as routing is concerned, and something
  // does send it: the installer's readiness probe is `curl -sI`. Treating it as
  // "not a GET" meant /login rendered without the pre-auth cookie ever being
  // issued, and the page then tried to set one from a Server Component — which
  // Next refuses, so the probe got HTTP 500 from a healthy panel.
  const isRead = request.method === "GET" || request.method === "HEAD";

  const hasSession = Boolean(request.cookies.get(cookieName("session"))?.value);
  if (isRead && !hasSession && isProtected(pathname)) {
    const url = request.nextUrl.clone();
    // No `next` parameter: an attacker-supplied redirect target is a phishing
    // primitive, and the operator can navigate on after signing in.
    url.pathname = "/login";
    url.search = "";
    response = NextResponse.redirect(url, 307);
  }

  // The login form's pre-auth CSRF cookie. Issued here because a Server
  // Component can read a cookie but not set one, and the form needs a token to
  // render. An existing cookie is left alone so the token already rendered into
  // a page the operator is looking at stays valid.
  if (isRead && pathname === "/login" && !request.cookies.get(cookieName("login-csrf"))?.value) {
    const token = randomToken();
    request.cookies.set(cookieName("login-csrf"), token);
    response = NextResponse.next({ request });
    response.cookies.set(
      cookieName("login-csrf"),
      token,
      cookieAttributes("login-csrf", LOGIN_CSRF_MAX_AGE_SECONDS),
    );
  }

  const finalResponse = response ?? NextResponse.next({ request });
  finalResponse.headers.set("X-Content-Type-Options", "nosniff");
  finalResponse.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  finalResponse.headers.set("X-Frame-Options", "DENY");
  finalResponse.headers.set("Cross-Origin-Opener-Policy", "same-origin");
  return finalResponse;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)"],
};
