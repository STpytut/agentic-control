// Cookie names and options for the local authentication scheme.
//
// Deliberately free of `node:crypto`, `pg` and `next/headers`: `src/proxy.ts`
// runs in the edge runtime and imports this module, while the route handlers
// and Server Components import it through `@/lib/auth`. Anything added here has
// to work in both places.
//
// The `__Host-` prefix is a browser-enforced contract: such a cookie must be
// Secure, must have Path=/ and must not carry a Domain. A development server on
// http://localhost cannot satisfy the Secure half, and browsers reject the
// cookie silently rather than downgrading it — which is why the insecure path
// renames the cookies instead of relaxing them.

export const SESSION_COOKIE_PROD = "__Host-infra_cod_session";
export const SESSION_COOKIE_DEV = "infra_cod_session_dev";
export const CSRF_COOKIE_PROD = "__Host-infra_cod_csrf";
export const CSRF_COOKIE_DEV = "infra_cod_csrf_dev";
export const LOGIN_CSRF_COOKIE_PROD = "__Host-infra_cod_login_csrf";
export const LOGIN_CSRF_COOKIE_DEV = "infra_cod_login_csrf_dev";

export const SESSION_IDLE = "12 hours";
export const SESSION_ABSOLUTE = "30 days";
export const SESSION_SLIDE = "5 minutes";
export const SESSION_ABSOLUTE_SECONDS = 30 * 24 * 60 * 60;

export type CookieKind = "session" | "csrf" | "login-csrf";

export function insecureCookies() {
  return process.env.INFRA_COD_INSECURE_COOKIES === "1";
}

export function assertCookieConfiguration() {
  if (insecureCookies() && process.env.NODE_ENV === "production") {
    // A build is not a running server. Next sets NODE_ENV=production for `next
    // build` too, and a developer's .env.local legitimately carries the dev
    // flag, so failing the build would mean the flag could not be used at all.
    // What must never happen is `next start` serving with it, and that is still
    // caught: nothing else sets NEXT_PHASE.
    if (process.env.NEXT_PHASE === "phase-production-build") return;
    throw new Error(
      "INFRA_COD_INSECURE_COOKIES=1 must never be combined with NODE_ENV=production: "
      + "it removes the Secure attribute from the session cookie.",
    );
  }
}

export function cookieName(kind: CookieKind) {
  const insecure = insecureCookies();
  switch (kind) {
    case "session":
      return insecure ? SESSION_COOKIE_DEV : SESSION_COOKIE_PROD;
    case "csrf":
      return insecure ? CSRF_COOKIE_DEV : CSRF_COOKIE_PROD;
    case "login-csrf":
      return insecure ? LOGIN_CSRF_COOKIE_DEV : LOGIN_CSRF_COOKIE_PROD;
    default: {
      const exhaustive: never = kind;
      throw new Error(`unknown cookie kind: ${String(exhaustive)}`);
    }
  }
}

export type CookieAttributes = {
  httpOnly: boolean;
  secure: boolean;
  sameSite: "lax";
  path: "/";
  maxAge?: number;
};

export function cookieAttributes(kind: CookieKind, maxAge?: number): CookieAttributes {
  return {
    // The session token is a bearer credential and must never be readable from
    // JavaScript. The CSRF cookie is the opposite: the double-submit pattern
    // needs the client to echo it, so it is deliberately readable. The login
    // CSRF token is rendered into the form by the server, so it stays HttpOnly.
    httpOnly: kind !== "csrf",
    secure: !insecureCookies(),
    sameSite: "lax",
    path: "/",
    ...(maxAge === undefined ? {} : { maxAge }),
  };
}
