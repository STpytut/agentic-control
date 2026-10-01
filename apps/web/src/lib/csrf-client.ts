"use client";

// The client half of the double-submit CSRF check.
//
// The raw token lives in a non-HttpOnly cookie and, because a deployment may be
// using either the `__Host-` name (production, Secure) or the dev-only name
// (http://localhost cannot set a Secure cookie), the server also renders it into
// a `<meta name="csrf-token">` in the root layout. The meta tag is tried first so
// neither side has to know which environment it is in.

const CSRF_COOKIE_PROD = "__Host-infra_cod_csrf";
const CSRF_COOKIE_DEV = "infra_cod_csrf_dev";

function readCookie(name: string) {
  if (typeof document === "undefined") return "";
  const prefix = `${name}=`;
  for (const part of document.cookie.split(";")) {
    const trimmed = part.trim();
    if (trimmed.startsWith(prefix)) {
      return decodeURIComponent(trimmed.slice(prefix.length));
    }
  }
  return "";
}

export function csrfToken() {
  if (typeof document === "undefined") return "";
  const fromMeta = document.querySelector('meta[name="csrf-token"]')?.getAttribute("content") ?? "";
  if (fromMeta) return fromMeta;
  return readCookie(CSRF_COOKIE_PROD) || readCookie(CSRF_COOKIE_DEV);
}

// The headers every `/api/control-plane/actions` call must carry. Kept in one
// place so a new call site cannot quietly omit the token and be refused by the
// route, which is the failure mode that would look like a random 403.
export function controlPlaneActionHeaders(): Record<string, string> {
  return {
    "Content-Type": "application/json",
    "X-Control-Plane-Action": "confirmed",
    "X-CSRF-Token": csrfToken(),
  };
}

export function jsonPostHeaders(): Record<string, string> {
  return { "Content-Type": "application/json", "X-CSRF-Token": csrfToken() };
}
