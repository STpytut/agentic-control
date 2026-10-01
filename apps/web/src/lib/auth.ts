// Local operator authentication: username + password against the control-plane
// database, with opaque server-side sessions.
//
// Supabase is gone from this module entirely. Every decision here is made
// against `control_plane` through the SECURITY DEFINER surface created in 0037
// and 0043; the web role holds no DML on any authentication table, so this file
// cannot read a password hash except through `authenticate_lookup`, and cannot
// write a session except through the functions that validate what they are
// given.
//
// Three rules shape the code below:
//
//   1. Nothing secret is persisted in usable form. Passwords are Argon2id
//      encodings, session and CSRF tokens exist as SHA-256 digests, and client
//      addresses and user agents are stored only as peppered HMACs.
//   2. Every protected entry point authorizes itself. `src/proxy.ts` only
//      redirects on the presence of a cookie, which is a navigation
//      convenience, not a security boundary.
//   3. Failures are indistinguishable. An unknown username still pays for an
//      Argon2id verification, and every denial path is padded to the same
//      floor, so neither the response body nor the response time says whether
//      the account exists.

import { randomBytes, randomUUID } from "node:crypto";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { NextResponse } from "next/server";
import { executeJson } from "@/lib/database";
import {
  constantTimeEqual,
  dummyPasswordHash,
  hashPassword,
  needsRehash,
  PasswordPolicyError,
  pepperedDigest,
  sha256Digest,
  verifyPassword,
} from "../../../../services/control-plane/password.mjs";
import {
  assertCookieConfiguration,
  cookieAttributes,
  cookieName,
  SESSION_ABSOLUTE,
  SESSION_ABSOLUTE_SECONDS,
  SESSION_IDLE,
  SESSION_SLIDE,
} from "@/lib/auth-cookies";

export type Operator = {
  userId: string;
  username: string;
  displayName: string;
  role: "owner";
  mustChangePassword: boolean;
  sessionId: string;
};

export type Session = {
  operator: Operator;
  csrfDigest: Buffer;
  expiresAt: string;
};

export type ClientContext = {
  ipHash: Buffer;
  userAgentHash: Buffer;
};

export type IssuedSession = {
  token: string;
  csrfToken: string;
  sessionId: string;
  expiresAt: string;
};

// A denial must never be cheaper than a success to produce, and an unknown
// username must never be cheaper than a known one. 250 ms comfortably exceeds
// the cost of one Argon2id verification at the parameters in password.mjs.
const MINIMUM_DENIAL_MS = 250;

// Refusing to boot is the point: with insecure cookies the session token would
// travel over plain HTTP and the `__Host-` protection would be gone.
assertCookieConfiguration();

// The panel's own origin, used for redirect targets and for the CSRF origin
// check. It is runtime configuration, deliberately not `NEXT_PUBLIC_*`: that
// prefix marks a value inlined at build time, which would bind one standalone
// artifact to one domain and force a rebuild to install it on another host.
// Every use is server-side, so nothing is lost by keeping it out of the client
// bundle.
//
// In production it must be an explicit `https://` origin. There is no fallback
// and no `Host` header: behind a proxy that header is attacker-controlled, and a
// panel that accepts it as its own origin would accept cross-origin mutations
// from anyone who can reach it.
const SITE_URL = process.env.INFRA_COD_SITE_URL?.trim();

// A build is not a running server. Next sets NODE_ENV=production for `next build`
// too and evaluates route modules while collecting page data, so a developer's
// http origin would fail the build itself. The exception is the same one
// `assertCookieConfiguration` makes and for the same reason: nothing but a build
// sets NEXT_PHASE, and a real server never has it.
function assertingAtRuntime() {
  return process.env.NODE_ENV === "production" && process.env.NEXT_PHASE !== "phase-production-build";
}

function configuredSiteOrigin() {
  if (!SITE_URL) {
    if (assertingAtRuntime()) {
      throw new Error(
        "INFRA_COD_SITE_URL must be set to the panel's public https:// origin in production "
        + "(for example https://panel.example.com). It is the origin the CSRF check accepts.",
      );
    }
    return null;
  }
  let url: URL;
  try {
    url = new URL(SITE_URL);
  } catch {
    throw new Error(`INFRA_COD_SITE_URL is not a valid URL: ${SITE_URL}`);
  }
  if (assertingAtRuntime() && url.protocol !== "https:") {
    throw new Error(
      `INFRA_COD_SITE_URL must use https in production, got ${url.protocol}//`,
    );
  }
  return url.origin;
}

// Evaluated here, at module load, and not only where the origin is used.
//
// Every other use is on a redirect or CSRF path, which means a server started
// with no origin configured would still answer pages that need no redirect — the
// login form among them — and only refuse the requests that happened to call this
// function. That is a misconfigured production installation serving traffic. The
// call below makes the process refuse to start instead, which is what "fails
// closed" has to mean for configuration. A build is exempt through
// `assertingAtRuntime`; the first request after a real start is not.
configuredSiteOrigin();

export function authSiteUrl(request?: Request) {
  const configured = configuredSiteOrigin();
  if (configured) return configured;
  const origin = request ? new URL(request.url).origin : "http://localhost:3000";
  return origin.replace(/\/$/, "");
}

export function loginRedirectUrl(request: Request, error?: string) {
  const url = new URL("/login", authSiteUrl(request));
  if (error) url.searchParams.set("error", error);
  return url;
}

// ------------------------------------------------------------- identity ----

function newToken() {
  return randomBytes(32).toString("base64url");
}

function toHex(value: Buffer) {
  return value.toString("hex");
}

// Only our own Caddy sets `x-forwarded-for`, and it overwrites whatever the
// client sent, so behind it the header is trustworthy. Anywhere else it is
// attacker-controlled, so it is ignored and every caller shares one bucket
// rather than being handed a per-request identity they could forge.
function clientAddress(request: Request) {
  if (process.env.NODE_ENV !== "production") return "local-development";
  const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return forwarded || request.headers.get("x-real-ip")?.trim() || "unknown";
}

export function clientContext(request: Request): ClientContext {
  const userAgent = request.headers.get("user-agent") ?? "";
  return {
    ipHash: pepperedDigest("ip", clientAddress(request)),
    userAgentHash: pepperedDigest("ua", userAgent),
  };
}

// -------------------------------------------------------------- cookies ----

export async function setSessionCookies(token: string, csrfToken: string) {
  const store = await cookies();
  store.set(cookieName("session"), token, cookieAttributes("session", SESSION_ABSOLUTE_SECONDS));
  store.set(cookieName("csrf"), csrfToken, cookieAttributes("csrf", SESSION_ABSOLUTE_SECONDS));
}

export async function clearSessionCookies() {
  const store = await cookies();
  store.set(cookieName("session"), "", cookieAttributes("session", 0));
  store.set(cookieName("csrf"), "", cookieAttributes("csrf", 0));
}

export async function readSessionToken(): Promise<string | null> {
  const store = await cookies();
  const value = store.get(cookieName("session"))?.value;
  return value ? value : null;
}

export async function readLoginCsrfToken(): Promise<string | null> {
  const store = await cookies();
  const value = store.get(cookieName("login-csrf"))?.value;
  return value ? value : null;
}

// The raw session CSRF token, for server-rendered hidden inputs. The database
// only ever holds its digest, so this cookie is the one place the value lives.
export async function readSessionCsrfToken(): Promise<string> {
  const store = await cookies();
  return store.get(cookieName("csrf"))?.value ?? "";
}

// Mints the pre-auth token when the cookie is missing. `src/proxy.ts` normally
// sets it on GET /login; this is the fallback for a request that arrives
// without one, and it fails closed: the freshly minted value cannot match a
// token the caller already submitted, so the attempt is refused and the retry
// carries a cookie.
export async function ensureLoginCsrfCookie(): Promise<string> {
  const existing = await readLoginCsrfToken();
  if (existing) return existing;
  const token = newToken();
  const store = await cookies();
  store.set(cookieName("login-csrf"), token, cookieAttributes("login-csrf", 60 * 60));
  return token;
}

// The same thing, for a Server Component render, where setting a cookie is not
// allowed and throwing means HTTP 500 on the page an operator signs in from.
//
// `src/proxy.ts` issues the cookie on every read of /login, so the mint below is
// already the unlikely path; what it must not do is turn "I could not set a
// cookie" into a 500. It returns an empty token instead, the form renders
// without one, and a submission then fails the CSRF check and redirects back to
// /login — a GET, which the proxy answers with a cookie. One extra round trip,
// and no request to this page can ever fail because of it.
export async function loginCsrfTokenForRender(): Promise<string> {
  const existing = await readLoginCsrfToken();
  if (existing) return existing;
  try {
    return await ensureLoginCsrfCookie();
  } catch {
    return "";
  }
}

export async function clearLoginCsrfCookie() {
  const store = await cookies();
  store.set(cookieName("login-csrf"), "", cookieAttributes("login-csrf", 0));
}

// -------------------------------------------------------------- session ----

export async function getSession(): Promise<Session | null> {
  const token = await readSessionToken();
  if (!token) return null;
  try {
    const result = await executeJson(
      `SELECT touch_web_session(decode(:'digest','hex'),:'idle'::interval,:'slide'::interval)::text;`,
      { digest: toHex(sha256Digest(token)), idle: SESSION_IDLE, slide: SESSION_SLIDE },
    );
    // `revoked`, `expired`, `disabled` and `unknown` all arrive as valid:false
    // and are all "no session": the caller does not need to tell them apart and
    // the browser must not be able to.
    if (!result || result.valid !== true || result.role !== "owner") return null;
    return {
      operator: {
        userId: String(result.user_id),
        username: typeof result.username === "string" ? result.username : "",
        displayName: typeof result.display_name === "string" ? result.display_name : "",
        role: "owner",
        mustChangePassword: result.must_change_password === true,
        sessionId: String(result.session_id),
      },
      csrfDigest: Buffer.from(String(result.csrf_digest ?? ""), "hex"),
      expiresAt: String(result.expires_at ?? ""),
    };
  } catch {
    return null;
  }
}

export async function getOperator(): Promise<Operator | null> {
  return (await getSession())?.operator ?? null;
}

export type RequireOperatorOptions = {
  // The forced-password-change fence, and the only way past it. Exactly three
  // entry points set this: the change-password page, its POST handler, and
  // logout. Everything else redirects to /change-password while the flag is set.
  allowPasswordChange?: boolean;
};

// The single implementation of the two guard rules, so a page and a Route
// Handler cannot drift apart on what counts as authorized.
//
// Redirects rather than throwing, so a protected page never renders while
// unauthenticated. Callers that need a status code instead use
// `requireOperatorApi`.
export async function requireSession(options: RequireOperatorOptions = {}): Promise<Session> {
  const session = await getSession();
  if (!session) redirect("/login");
  if (session.operator.mustChangePassword && !options.allowPasswordChange) {
    redirect("/change-password");
  }
  return session;
}

// Server Component / Server Action guard.
export async function requireOperator(options: RequireOperatorOptions = {}): Promise<Operator> {
  return (await requireSession(options)).operator;
}

// Route Handler guard. Returns a Response instead of redirecting: an API client
// wants a status code, and a 307 into an HTML page is not one.
export async function requireOperatorApi(
  options: RequireOperatorOptions = {},
): Promise<Operator | Response> {
  const session = await getSession();
  if (!session) {
    return Response.json({ ok: false, error: "Authentication required" }, { status: 401 });
  }
  if (session.operator.mustChangePassword && !options.allowPasswordChange) {
    return Response.json(
      { ok: false, error: "Password change required", redirectTo: "/change-password" },
      { status: 403 },
    );
  }
  return session.operator;
}

// There is deliberately no `createSession` here any more.
//
// It issued a session for a user id and nothing else, which is exactly the shape
// of the race this file used to lose: a login that had verified a password, then
// a reset, then a session created from the now-dead credential. Session creation
// for a sign-in lives in `complete_local_login`, which locks the account row and
// checks the verified values first, and the password path goes through
// `change_local_password`, which derives the account from the presented token.
// Leaving the third entry point exported would invite its reintroduction.

// Revokes the presented session. `revoke_web_session` also writes the audit row,
// from the account it reads off the revoked session — the caller supplies no
// actor, so a logout cannot be attributed to somebody else.
//
// The caller decides what to do when this throws. Clearing the cookie regardless
// is deliberate: the browser forgetting the token is strictly better than keeping
// it, and the session it names expires on its own.
export async function destroySession(reason = "logout"): Promise<boolean> {
  const token = await readSessionToken();
  let revoked = false;
  if (token) {
    try {
      const result = await executeJson(
        `SELECT revoke_web_session(decode(:'digest','hex'),:'reason')::text;`,
        { digest: toHex(sha256Digest(token)), reason },
      );
      revoked = result?.revoked === true;
    } catch (error) {
      // Not swallowed silently: the caller may still clear the cookie, but the
      // failure is visible to whoever reads the server log.
      process.stderr.write(`${JSON.stringify({
        type: "auth.logout_failed",
        error: error instanceof Error ? error.message : "unknown",
      })}\n`);
      revoked = false;
    }
  }
  await clearSessionCookies();
  return revoked;
}

// ----------------------------------------------------------------- csrf ----

export type CsrfFailureReason = "no-session" | "site" | "origin" | "missing" | "mismatch";

export class CsrfError extends Error {
  readonly reason: CsrfFailureReason;

  constructor(reason: CsrfFailureReason) {
    super(`the CSRF check failed: ${reason}`);
    this.name = "CsrfError";
    this.reason = reason;
  }
}

function sameOrigin(request: Request) {
  const origin = request.headers.get("origin");
  if (!origin) return false;
  try {
    const configured = configuredSiteOrigin();
    if (configured) {
      // A configured origin is the only accepted one. `Host` and
      // `X-Forwarded-Host` are not consulted: they are what the caller says
      // about itself, which is exactly the claim a CSRF check must not trust.
      return new URL(origin).origin === configured;
    }
    const host = request.headers.get("host");
    return Boolean(host) && new URL(origin).host === host;
  } catch {
    return false;
  }
}

// `Sec-Fetch-Site` is the browser's own statement about who started the
// request, and unlike Origin it is present on same-origin GET navigations too.
// Absent (an old browser, or curl) is tolerated because Origin is then the
// binding check; present and wrong is not.
function sameSiteRequest(request: Request) {
  const site = request.headers.get("sec-fetch-site");
  if (!site) return true;
  return site === "same-origin" || site === "none";
}

async function csrfCandidate(request: Request): Promise<string> {
  const header = request.headers.get("x-csrf-token");
  if (header) return header;
  const contentType = request.headers.get("content-type") ?? "";
  if (
    contentType.includes("application/x-www-form-urlencoded")
    || contentType.includes("multipart/form-data")
  ) {
    try {
      // A clone, so the handler can still read the body afterwards.
      const form = await request.clone().formData();
      const value = form.get("csrf_token");
      return typeof value === "string" ? value : "";
    } catch {
      return "";
    }
  }
  return "";
}

export async function requireCsrf(request: Request, session?: Session | null): Promise<void> {
  const active = session === undefined ? await getSession() : session;
  if (!active) throw new CsrfError("no-session");
  if (!sameSiteRequest(request)) throw new CsrfError("site");
  if (!sameOrigin(request)) throw new CsrfError("origin");
  const candidate = await csrfCandidate(request);
  if (!candidate) throw new CsrfError("missing");
  // Constant time, and compared as digests so the stored value is never handed
  // out even to a caller that guessed the token.
  if (!constantTimeEqual(sha256Digest(candidate), active.csrfDigest)) {
    throw new CsrfError("mismatch");
  }
}

export async function verifyCsrf(request: Request, session?: Session | null): Promise<boolean> {
  try {
    await requireCsrf(request, session);
    return true;
  } catch {
    return false;
  }
}

// A refused CSRF check is always a 403, including for a browser form. An HTML
// body rather than a redirect, because a redirect would report success-shaped
// behaviour for a request that was rejected — and because the alternative, a
// bare JSON error, leaves a person staring at a blank page.
export function csrfFailureResponse(): Response {
  return new NextResponse(
    "<!doctype html><meta charset=\"utf-8\"><title>Request refused</title>"
    + "<style>body{font:15px/1.6 system-ui,sans-serif;max-width:34rem;margin:4rem auto;padding:0 1rem}"
    + "a{color:#2563eb}</style>"
    + "<h1>Request refused</h1>"
    + "<p>This request could not be verified as coming from the panel, so nothing was changed.</p>"
    + "<p><a href=\"/\">Back to the panel</a></p>",
    {
      status: 403,
      headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
    },
  );
}

// The login form's own CSRF token, issued before there is a session. It is a
// double-submit against a cookie that `src/proxy.ts` sets on GET /login, so a
// cross-site page can neither read it nor forge the matching cookie.
export async function verifyLoginCsrf(request: Request, candidate: string): Promise<boolean> {
  if (!candidate) return false;
  if (!sameSiteRequest(request)) return false;
  if (!sameOrigin(request)) return false;
  const cookie = await ensureLoginCsrfCookie();
  return constantTimeEqual(Buffer.from(candidate, "utf8"), Buffer.from(cookie, "utf8"));
}

// ---------------------------------------------------------------- audit ----

// Records a control-plane action the operator performed.
//
// This is the one audit row the web tier originates rather than inheriting from
// a database operation, so it takes the session token — not a user id. The actor
// is read from the session row by `write_session_audit`, which means this can
// only ever attribute an action to the session it is already holding. There is no
// parameter to point at somebody else, which is what the previous
// `writeOperatorAudit(operator, ...)` allowed: it trusted a user id the caller
// supplied and checked only that the id belonged to an owner.
//
// Credential events — sign-in, password change, rename, session revocation,
// logout — are not written from here at all. They belong to the database
// operation that performed them.
export async function writeSessionAudit(
  action: string,
  targetType: string,
  targetId: string,
  decision: "allowed" | "denied" | "not_required" = "allowed",
  details: Record<string, unknown> = {},
  projectId = "",
) {
  const token = await readSessionToken();
  if (!token) throw new Error("no session to attribute the audit entry to");
  return executeJson(
    `SELECT write_session_audit(
       decode(:'digest','hex'),:'action',:'target_type',:'target_id',:'decision',
       :'details'::jsonb,NULLIF(:'project_id','')::uuid,:'correlation'
     )::text;`,
    {
      digest: toHex(sha256Digest(token)),
      action,
      target_type: targetType,
      target_id: targetId,
      decision,
      details: JSON.stringify(details),
      project_id: projectId,
      correlation: randomUUID(),
    },
  );
}

// ---------------------------------------------------------------- login ----

export type LoginDenial = "invalid" | "locked" | "unavailable";

export type LoginResult =
  | { status: "success"; operator: Operator; session: IssuedSession }
  | { status: "denied"; reason: LoginDenial };

async function padToMinimum(startedAt: number) {
  const elapsed = Date.now() - startedAt;
  if (elapsed < MINIMUM_DENIAL_MS) {
    await new Promise((resolve) => setTimeout(resolve, MINIMUM_DENIAL_MS - elapsed));
  }
}

async function finishAttempt(attemptId: unknown, outcome: string): Promise<boolean> {
  try {
    const result = await executeJson(
      `SELECT finish_auth_attempt(:'attempt_id'::bigint,:'outcome')::text;`,
      { attempt_id: String(attemptId), outcome },
    );
    return result?.resolved === true;
  } catch {
    return false;
  }
}

export async function attemptLogin(input: {
  username: string;
  password: string;
  request: Request;
}): Promise<LoginResult> {
  const startedAt = Date.now();
  // Normalised here rather than in the form: the database lowercases too, but
  // the attempt row and the lookup must agree on the exact string.
  const username = input.username.trim().toLowerCase();
  const context = clientContext(input.request);

  const deny = async (reason: LoginDenial): Promise<LoginResult> => {
    await padToMinimum(startedAt);
    return { status: "denied", reason };
  };

  let admission: Record<string, unknown> | null = null;
  try {
    admission = await executeJson(
      `SELECT begin_auth_attempt(
         :'username', decode(:'ip_hash','hex'), decode(:'user_agent_hash','hex'))::text;`,
      {
        username,
        ip_hash: toHex(context.ipHash),
        user_agent_hash: toHex(context.userAgentHash),
      },
    );
  } catch {
    return deny("unavailable");
  }
  if (!admission) return deny("unavailable");

  if (admission.allowed !== true) {
    // Locked out. The reservation was refused, so there is nothing to resolve,
    // but the caller still pays for a real Argon2id verification: otherwise the
    // lockout itself would be measurable and would confirm the account exists.
    await verifyPassword(input.password, await dummyPasswordHash()).catch(() => false);
    return deny("locked");
  }

  const attemptId = admission.attempt_id;

  let lookup: Record<string, unknown> | null = null;
  try {
    lookup = await executeJson(
      `SELECT authenticate_lookup(:'username')::text;`,
      { username },
    );
  } catch {
    await finishAttempt(attemptId, "unknown_user");
    return deny("unavailable");
  }

  const found = lookup?.found === true;
  const storedHash = typeof lookup?.password_hash === "string" ? lookup.password_hash : "";
  // The unknown-user path runs the same Argon2id against a hash nobody knows.
  const hash = found && storedHash ? storedHash : await dummyPasswordHash();
  const verified = await verifyPassword(input.password, hash);

  const outcome = !found
    ? "unknown_user"
    : lookup?.disabled === true
      ? "disabled"
      : verified
        ? "success"
        : "bad_password";

  // A reservation that cannot be resolved is not a licence to continue: the
  // attempt row may have been rewritten, so the login is refused rather than
  // recorded as a success the database never confirmed.
  if (outcome !== "success") {
    if (!(await finishAttempt(attemptId, outcome))) return deny("unavailable");
    return deny("invalid");
  }

  // Everything after the password check happens inside one database function,
  // under a lock on the account row: confirm that the username and the hash are
  // still the ones that were verified, resolve the attempt, create the session
  // and record it.
  //
  // Split across round trips — which is what this used to be — a reset-password
  // or a rename landing between the verification and the session insert revoked
  // every session and the in-flight login immediately created a new one from a
  // credential that no longer existed. The lock closes that: either the change
  // commits first and this call refuses, or this call commits first and the
  // change then revokes the session it created.
  const operator: Operator = {
    userId: String(lookup?.user_id),
    username: typeof lookup?.username === "string" ? lookup.username : username,
    displayName: typeof lookup?.display_name === "string" ? lookup.display_name : "",
    role: "owner",
    mustChangePassword: lookup?.must_change_password === true,
    sessionId: "",
  };

  // The token is generated here and only its digest reaches the database, so the
  // raw credential never exists server-side.
  const token = newToken();
  const csrfToken = newToken();

  let completed: Record<string, unknown> | null = null;
  try {
    completed = await executeJson(
      `SELECT complete_local_login(
         :'attempt_id'::bigint, :'user_id'::uuid, :'expected_username', :'expected_password_hash',
         decode(:'token_digest','hex'), decode(:'csrf_digest','hex'),
         decode(:'ip_hash','hex'), decode(:'user_agent_hash','hex'),
         :'idle'::interval, :'absolute'::interval)::text;`,
      {
        attempt_id: String(attemptId),
        user_id: operator.userId,
        expected_username: operator.username,
        expected_password_hash: storedHash,
        token_digest: toHex(sha256Digest(token)),
        csrf_digest: toHex(sha256Digest(csrfToken)),
        ip_hash: toHex(context.ipHash),
        user_agent_hash: toHex(context.userAgentHash),
        idle: SESSION_IDLE,
        absolute: SESSION_ABSOLUTE,
      },
    );
  } catch {
    return deny("unavailable");
  }
  if (completed?.completed !== true) {
    // The credentials moved, or the reservation was not ours. Neither is a
    // successful sign-in, and the response says nothing beyond that.
    return deny("invalid");
  }

  operator.sessionId = String(completed.session_id);
  operator.mustChangePassword = completed.must_change_password === true;
  if (typeof completed.display_name === "string" && completed.display_name) {
    operator.displayName = completed.display_name;
  }

  const session: IssuedSession = {
    token,
    csrfToken,
    sessionId: operator.sessionId,
    expiresAt: String(completed.expires_at ?? ""),
  };

  // Transparently upgrade a hash produced with parameters this build no longer
  // uses. Best effort and after the commit: the login has already succeeded and
  // the stored hash still verifies, so a failed upgrade must not cost the
  // operator the session they just earned.
  //
  // Compare-and-swap against the hash that was verified. A blind write here
  // would reinstate the old password over a reset that landed in the meantime;
  // losing the swap simply means somebody else's change is the one that stands.
  if (needsRehash(storedHash)) {
    try {
      await executeJson(
        `SELECT rehash_local_password(:'user_id'::uuid, :'expected_old_hash', :'password_hash')::text;`,
        {
          user_id: operator.userId,
          expected_old_hash: storedHash,
          password_hash: await hashPassword(input.password),
        },
      );
    } catch {
      // The next successful sign-in tries again.
    }
  }

  await setSessionCookies(session.token, session.csrfToken);
  return { status: "success", operator, session };
}

// ------------------------------------------------------ password change ----

export type ChangePasswordResult =
  | { status: "changed"; session: IssuedSession }
  | { status: "denied"; reason: "invalid-current" | "policy" | "unavailable" };

export async function changeOperatorPassword(input: {
  currentPassword: string;
  newPassword: string;
  request: Request;
  session: Session;
}): Promise<ChangePasswordResult> {
  const token = await readSessionToken();
  if (!token) return { status: "denied", reason: "unavailable" };

  // Re-authenticate before re-credentialing, exactly as the UI asks: a walked-up
  // browser must not be able to change the password of the open session.
  let lookup: Record<string, unknown> | null = null;
  try {
    lookup = await executeJson(`SELECT authenticate_lookup(:'username')::text;`, {
      username: input.session.operator.username,
    });
  } catch {
    return { status: "denied", reason: "unavailable" };
  }
  const storedHash = typeof lookup?.password_hash === "string" ? lookup.password_hash : "";
  const currentHash = lookup?.found === true && storedHash ? storedHash : await dummyPasswordHash();
  if (!(await verifyPassword(input.currentPassword, currentHash))) {
    return { status: "denied", reason: "invalid-current" };
  }

  let newHash: string;
  try {
    newHash = await hashPassword(input.newPassword);
  } catch (error) {
    if (error instanceof PasswordPolicyError) return { status: "denied", reason: "policy" };
    return { status: "denied", reason: "unavailable" };
  }

  const context = clientContext(input.request);
  // Rotation, not reuse: the token that was valid against the old password is
  // revoked by the database function, and this is its replacement.
  const rotatedToken = newToken();
  const rotatedCsrfToken = newToken();

  let result: Record<string, unknown> | null = null;
  try {
    // One transaction: the hash change, the revocation of the other sessions,
    // the rotation of this one, its replacement, and the audit row. A failure
    // anywhere leaves the old password and the old session exactly as they were,
    // One statement, one transaction: the hash change, the revocation of the
    // other sessions, the rotation of this one, its replacement and the
    // `auth.password_changed` row all belong to `change_local_password`. The
    // audit is written there, from the account the function read off the token,
    // so this side never names an actor.
    result = await executeJson(
      `SELECT change_local_password(
         decode(:'current_digest','hex'), :'password_hash',
         decode(:'token_digest','hex'), decode(:'csrf_digest','hex'),
         :'idle'::interval, :'absolute'::interval,
         decode(:'ip_hash','hex'), decode(:'user_agent_hash','hex'))::text;`,
      {
        current_digest: toHex(sha256Digest(token)),
        password_hash: newHash,
        token_digest: toHex(sha256Digest(rotatedToken)),
        csrf_digest: toHex(sha256Digest(rotatedCsrfToken)),
        idle: SESSION_IDLE,
        absolute: SESSION_ABSOLUTE,
        ip_hash: toHex(context.ipHash),
        user_agent_hash: toHex(context.userAgentHash),
      },
    );
  } catch {
    return { status: "denied", reason: "unavailable" };
  }
  if (!result || typeof result.session_id !== "string") {
    return { status: "denied", reason: "unavailable" };
  }

  const session: IssuedSession = {
    token: rotatedToken,
    csrfToken: rotatedCsrfToken,
    sessionId: result.session_id,
    expiresAt: String(result.expires_at ?? ""),
  };
  await setSessionCookies(session.token, session.csrfToken);
  return { status: "changed", session };
}

// ------------------------------------------------------ account settings ----

export async function listOperatorSessions() {
  const token = await readSessionToken();
  if (!token) return { sessions: [] as Record<string, unknown>[], currentSessionId: "" };
  const result = await executeJson(
    `SELECT list_web_sessions(decode(:'digest','hex'))::text;`,
    { digest: toHex(sha256Digest(token)) },
  );
  const sessions = Array.isArray(result?.sessions) ? result.sessions as Record<string, unknown>[] : [];
  return { sessions, currentSessionId: String(result?.current_session_id ?? "") };
}

// No Session argument: the function derives the account from the presented token
// and refuses a session id belonging to anybody else, so the caller has nothing to
// pass that could widen it.
export async function revokeOperatorSession(sessionId: string) {
  const token = await readSessionToken();
  if (!token) return false;
  // The revocation and its `auth.session_revoked` row are one statement, written
  // by the function from the account it derived from the token.
  const result = await executeJson(
    `SELECT revoke_web_session_by_id(decode(:'digest','hex'), :'session_id'::uuid, 'admin_revoke')::text;`,
    { digest: toHex(sha256Digest(token)), session_id: sessionId },
  );
  return result?.revoked === true;
}

export async function revokeOtherOperatorSessions() {
  const token = await readSessionToken();
  if (!token) return 0;
  const result = await executeJson(
    `SELECT revoke_other_web_sessions(decode(:'digest','hex'), 'admin_revoke')::text;`,
    { digest: toHex(sha256Digest(token)) },
  );
  return Number(result?.sessions_revoked ?? 0);
}

export type ChangeUsernameResult =
  | { status: "changed"; username: string; sessionsRevoked: number }
  | { status: "denied"; reason: "invalid" | "unavailable" };

export async function changeOperatorUsername(input: {
  username: string;
  session: Session;
}): Promise<ChangeUsernameResult> {
  const token = await readSessionToken();
  if (!token) return { status: "denied", reason: "unavailable" };
  const username = input.username.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]{2,31}$/.test(username)) {
    return { status: "denied", reason: "invalid" };
  }
  let result: Record<string, unknown> | null = null;
  try {
    // Renamed and audited in one statement; the actor comes from the token.
    result = await executeJson(
      `SELECT change_local_username(decode(:'digest','hex'), :'username')::text;`,
      { digest: toHex(sha256Digest(token)), username },
    );
  } catch {
    return { status: "denied", reason: "unavailable" };
  }
  if (!result) return { status: "denied", reason: "unavailable" };

  await clearSessionCookies();
  return {
    status: "changed",
    username: String(result.username ?? username),
    sessionsRevoked: Number(result.sessions_revoked ?? 0),
  };
}

export { assertCookieConfiguration };
