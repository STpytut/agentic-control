import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { argon2id } from "hash-wasm";
import { needsRehash } from "../password.mjs";

// Route authorization.
//
// Two independent claims are checked here, and both matter:
//
//   1. Every page and Route Handler that serves a route is written down, and
//      every protected one guards itself. `src/proxy.ts` only looks at whether a
//      cookie is present, so it is a navigation convenience — if a route relied
//      on it, an attacker who set any cookie would walk straight in. The
//      registry is an explicit allowlist: adding `app/whatever/page.tsx` without
//      listing it fails the first test.
//
//   2. The claim is true at runtime. A real panel is started against a scratch
//      database and driven over HTTP: no cookie, an unknown cookie, a revoked
//      cookie and an expired cookie are all refused, and a mutating route is
//      refused without a CSRF token.
//
// The static half always runs. The live half needs a database and is skipped
// only when DATABASE_URL is genuinely unavailable.
//
// It also starts a real panel, and Next 16 locks the project directory for
// `next dev`: no other dev server — a developer's own `npm run web:dev`, or the
// other test that starts one — may be running against apps/web at the same time.
// `test:integration:live` runs the live tests with --test-concurrency=1 for that
// reason; without it the second server refuses to start and this test fails with
// "Another next dev server is already running".

const root = path.resolve(import.meta.dirname, "../../..");
const appDir = path.join(root, "apps/web/src/app");
// A fixed name, declared in apps/web/tsconfig.json's `include`: Next rewrites
// that file whenever it meets an undeclared dist dir, which would leave the
// working tree dirty after every test run — and a pid-suffixed name would be a
// different undeclared dir every time.
const ROUTE_TEST_DIST_DIR = ".next-route-test";

// ------------------------------------------------------------ registry ----

// key: path relative to apps/web/src/app, using URL-ish segments.
// access:
//   "public"                — reachable without a session
//   "protected"             — requires a live session and the must-change fence
//   "password-change"       — requires a live session, but is reachable *during*
//                             the forced password change
// mutating: the handler changes state and therefore needs a CSRF token.
const REGISTRY = {
  "page.tsx": { url: "/", kind: "page", access: "public" },
  "login/page.tsx": { url: "/login", kind: "page", access: "public" },
  "change-password/page.tsx": { url: "/change-password", kind: "page", access: "password-change" },
  "projects/page.tsx": { url: "/projects", kind: "page", access: "protected" },
  "projects/[projectId]/page.tsx": { url: "/projects/:id", kind: "page", access: "protected" },
  "projects/[projectId]/[section]/page.tsx": { url: "/projects/:id/:section", kind: "page", access: "protected" },
  "projects/new/page.tsx": { url: "/projects/new", kind: "page", access: "protected" },
  "projects/[projectId]/chats/page.tsx": { url: "/projects/:id/chats", kind: "page", access: "protected" },
  "projects/[projectId]/settings/page.tsx": { url: "/projects/:id/settings", kind: "page", access: "protected" },
  "projects/[projectId]/settings/[page]/page.tsx": { url: "/projects/:id/settings/:page", kind: "page", access: "protected" },
  "settings/page.tsx": { url: "/settings", kind: "page", access: "protected" },
  "settings/[page]/page.tsx": { url: "/settings/:page", kind: "page", access: "protected" },

  "auth/login/route.ts": { url: "/auth/login", kind: "route", access: "public", mutating: true, csrf: "preauth" },
  "auth/logout/route.ts": { url: "/auth/logout", kind: "route", access: "password-change", mutating: true },
  "auth/change-password/route.ts": { url: "/auth/change-password", kind: "route", access: "password-change", mutating: true },
  "auth/change-username/route.ts": { url: "/auth/change-username", kind: "route", access: "protected", mutating: true },
  "auth/revoke-session/route.ts": { url: "/auth/revoke-session", kind: "route", access: "protected", mutating: true },
  "auth/revoke-other-sessions/route.ts": { url: "/auth/revoke-other-sessions", kind: "route", access: "protected", mutating: true },

  "api/control-plane/actions/route.ts": { url: "/api/control-plane/actions", kind: "route", access: "protected", mutating: true },
  "api/control-plane/snapshot/route.ts": { url: "/api/control-plane/snapshot", kind: "route", access: "protected" },
  "api/control-plane/pulse/route.ts": { url: "/api/control-plane/pulse", kind: "route", access: "protected" },
  "api/control-plane/usage/route.ts": { url: "/api/control-plane/usage", kind: "route", access: "protected" },
  "api/control-plane/codex/status/route.ts": { url: "/api/control-plane/codex/status", kind: "route", access: "protected" },
  "api/control-plane/github/callback/route.ts": { url: "/api/control-plane/github/callback", kind: "route", access: "protected" },
  "api/control-plane/github/app-manifest/route.ts": { url: "/api/control-plane/github/app-manifest", kind: "route", access: "protected" },
  "api/control-plane/github/repositories/route.ts": { url: "/api/control-plane/github/repositories", kind: "route", access: "protected" },
  "api/control-plane/github/status/route.ts": { url: "/api/control-plane/github/status", kind: "route", access: "protected" },
  "api/control-plane/models/checks/[checkId]/route.ts": { url: "/api/control-plane/models/checks/:id", kind: "route", access: "protected" },
  "api/control-plane/models/search/route.ts": { url: "/api/control-plane/models/search", kind: "route", access: "protected" },
  "api/control-plane/opencode/broker-key/route.ts": { url: "/api/control-plane/opencode/broker-key", kind: "route", access: "protected" },
  "api/control-plane/opencode/status/route.ts": { url: "/api/control-plane/opencode/status", kind: "route", access: "protected" },
  "api/projects/[projectId]/activity/route.ts": { url: "/api/projects/:id/activity", kind: "route", access: "protected" },
  "api/projects/[projectId]/usage/route.ts": { url: "/api/projects/:id/usage", kind: "route", access: "protected" },
  "opencode-enroll/route.ts": { url: "/opencode-enroll", kind: "route", access: "protected" },
};

function discoverRoutes(directory = appDir, prefix = "") {
  const found = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      found.push(...discoverRoutes(path.join(directory, entry.name), relative));
      continue;
    }
    if (entry.name === "page.tsx" || entry.name === "route.ts") found.push(relative);
  }
  return found.sort();
}

const GUARDS = ["requireOperator(", "requireOperatorApi(", "requireSession(", "getSession("];

test("every route is in the authorization registry", () => {
  const discovered = discoverRoutes();
  const registered = Object.keys(REGISTRY).sort();

  const missing = discovered.filter((file) => !REGISTRY[file]);
  assert.deepEqual(
    missing,
    [],
    "these route files are not in the registry: add them with their access level, "
    + "or the authorization model has an undocumented hole",
  );

  const stale = registered.filter((file) => !existsSync(path.join(appDir, file)));
  assert.deepEqual(stale, [], "the registry lists files that no longer exist");
  assert.deepEqual(discovered, registered);
});

test("every protected entry point guards itself", () => {
  for (const [file, entry] of Object.entries(REGISTRY)) {
    const source = readFileSync(path.join(appDir, file), "utf8");
    if (entry.access === "protected" || entry.access === "password-change") {
      assert.ok(
        GUARDS.some((guard) => source.includes(guard)),
        `${file} serves a protected route but never calls a session guard`,
      );
    }
    if (entry.mutating) {
      const check = entry.csrf === "preauth" ? "verifyLoginCsrf(" : "requireCsrf(";
      assert.ok(
        source.includes(check),
        `${file} mutates state but never calls ${check.replace("(", "")}`,
      );
    }
  }
});

test("the forced-password-change fence is opened by exactly three entry points", () => {
  const opened = Object.entries(REGISTRY)
    .filter(([, entry]) => entry.access === "password-change")
    .map(([file]) => file)
    .sort();
  assert.deepEqual(opened, [
    "auth/change-password/route.ts",
    "auth/logout/route.ts",
    "change-password/page.tsx",
  ]);

  // Each exemption has to be visible in the code that relies on it: either the
  // guard is called with the fence lifted, or the handler deliberately reads the
  // session without the fence (logout, which must stay callable with a dead
  // cookie so it can clear it).
  for (const file of opened) {
    const source = readFileSync(path.join(appDir, file), "utf8");
    assert.ok(
      source.includes("allowPasswordChange: true") || source.includes("getSession("),
      `${file} is exempt from the fence but the exemption is not visible in the code`,
    );
  }

  // And nothing else may lift it.
  for (const [file, entry] of Object.entries(REGISTRY)) {
    if (entry.access === "password-change") continue;
    const source = readFileSync(path.join(appDir, file), "utf8");
    assert.ok(
      !source.includes("allowPasswordChange: true"),
      `${file} lifts the forced-password-change fence`,
    );
  }
});

test("the proxy is not treated as an authorization boundary", () => {
  const proxy = readFileSync(path.join(root, "apps/web/src/proxy.ts"), "utf8");
  // Cheap by construction: no database, no cryptography beyond a random token.
  for (const forbidden of ["Pool", "pg\"", "password.mjs", "touch_web_session"]) {
    assert.ok(!proxy.includes(forbidden), `proxy.ts must not reference ${forbidden}`);
  }
});

// ------------------------------------------------------------- live half ----

const databaseUrl = process.env.DATABASE_URL;
const pepper = process.env.INFRA_COD_AUTH_PEPPER ?? "route-authorization-test-pepper";
const skip = databaseUrl ? false : "DATABASE_URL is not set";

function adminUrl(database) {
  const url = new URL(databaseUrl);
  url.pathname = `/${database}`;
  return url.toString();
}

function psql(url, sql) {
  const result = spawnSync("psql", ["-X", "-qAt", "-v", "ON_ERROR_STOP=1", url], {
    encoding: "utf8", input: sql,
  });
  if (result.status !== 0) throw new Error(result.stderr.trim() || `psql exited ${result.status}`);
  return result.stdout.trim();
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function waitForPanel(base, deadlineMs = 120_000) {
  const started = Date.now();
  let lastError = "no attempt";
  while (Date.now() - started < deadlineMs) {
    try {
      const response = await fetch(`${base}/login`, { redirect: "manual" });
      if (response.status < 500) return;
      lastError = `status ${response.status}`;
    } catch (error) {
      lastError = error.message;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`the panel never became ready: ${lastError}`);
}

function cookieHeader(name, value) {
  return `${name}=${value}`;
}

test("the panel refuses every unauthenticated and un-CSRF'd request", { skip }, async () => {
  const scratch = `infra_cod_route_${randomUUID().slice(0, 8).replace(/-/g, "")}`;
  const maintenance = adminUrl("postgres");
  const credentialsDir = path.join(os.tmpdir(), `infra-cod-route-${process.pid}`);
  mkdirSync(credentialsDir, { recursive: true });
  psql(maintenance, `CREATE DATABASE ${scratch};`);
  const url = adminUrl(scratch);
  let server = null;

  try {
    const migrate = spawnSync(process.execPath, [path.join(root, "services/control-plane/migrate.mjs")], {
      encoding: "utf8", env: { ...process.env, DATABASE_URL: url },
    });
    assert.equal(migrate.status, 0, `migrate failed: ${migrate.stderr}`);

    const password = "route-authorization-operator-password";
    const bootstrap = spawnSync(process.execPath, [path.join(root, "services/cli/admin.mjs"), "bootstrap", "--stdin"], {
      encoding: "utf8",
      input: `${password}\n`,
      env: {
        ...process.env,
        DATABASE_URL: url,
        INFRA_COD_AUTH_PEPPER: pepper,
        INFRA_COD_CREDENTIALS_DIR: credentialsDir,
      },
    });
    assert.equal(bootstrap.status, 0, `bootstrap failed: ${bootstrap.stderr}`);
    const receipt = JSON.parse(bootstrap.stdout.trim().split("\n").at(-1));
    const username = receipt.username;

    // Sessions inserted directly: this test is about what the HTTP surface does
    // with a session, not about how one is issued.
    const live = randomBytes(32).toString("base64url");
    const revoked = randomBytes(32).toString("base64url");
    const expired = randomBytes(32).toString("base64url");
    const csrf = randomBytes(32).toString("base64url");
    const digest = (token) => createHash("sha256").update(token).digest("hex");
    const csrfDigest = digest(csrf);

    const owner = psql(url, "SELECT id FROM control_plane.users LIMIT 1;");

    // A hash from an older cost profile, made with the same pepper the panel
    // runs with. The next successful sign-in has to upgrade it in place: a hash
    // that only ever gets weaker as parameters move on is a slow-motion
    // downgrade, and `needsRehash` existing is not the same as it being wired up.
    const weakHash = await argon2id({
      password, salt: randomBytes(16), secret: pepper,
      parallelism: 1, iterations: 1, memorySize: 4096, hashLength: 32, outputType: "encoded",
    });
    assert.equal(needsRehash(weakHash), true, "the fixture is not actually stale");
    psql(url, `UPDATE control_plane.users SET password_hash='${weakHash}' WHERE id='${owner}';`);

    psql(url, `INSERT INTO control_plane.web_sessions(user_id,token_digest,csrf_digest,expires_at,absolute_expires_at)
      VALUES
        ('${owner}', decode('${digest(live)}','hex'), decode('${csrfDigest}','hex'),
         clock_timestamp()+interval '12 hours', clock_timestamp()+interval '30 days'),
        ('${owner}', decode('${digest(revoked)}','hex'), decode('${csrfDigest}','hex'),
         clock_timestamp()+interval '12 hours', clock_timestamp()+interval '30 days'),
        ('${owner}', decode('${digest(expired)}','hex'), decode('${csrfDigest}','hex'),
         clock_timestamp()-interval '2 minutes', clock_timestamp()-interval '1 minute');
      UPDATE control_plane.web_sessions SET revoked_at=clock_timestamp(), revoked_reason='logout'
        WHERE token_digest=decode('${digest(revoked)}','hex');`);

    const port = await freePort();
    const base = `http://127.0.0.1:${port}`;
    server = spawn(
      process.execPath,
      [path.join(root, "apps/web/node_modules/next/dist/bin/next"), "dev", "--port", String(port)],
      {
        cwd: path.join(root, "apps/web"),
        env: {
          ...process.env,
          NODE_ENV: "development",
          DATABASE_URL: url,
          INFRA_COD_AUTH_PEPPER: pepper,
          INFRA_COD_INSECURE_COOKIES: "1",
          INFRA_COD_SITE_URL: base,
          PORT: String(port),
          // Isolated from a developer's own `next dev`, which would otherwise
          // contend for the same build directory.
          NEXT_DIST_DIR: ROUTE_TEST_DIST_DIR,
          NEXT_TELEMETRY_DISABLED: "1",
        },
        stdio: ["ignore", "pipe", "pipe"],
        // Its own process group: `next dev` starts workers, and killing only the
        // parent leaves them holding the inherited stdout pipe, which keeps this
        // test process alive forever.
        detached: true,
      },
    );
    let serverLog = "";
    server.stdout.on("data", (chunk) => { serverLog += chunk.toString(); });
    server.stderr.on("data", (chunk) => { serverLog += chunk.toString(); });
    try {
      await waitForPanel(base);
    } catch (error) {
      throw new Error(`${error.message}\n--- panel output ---\n${serverLog.slice(-3000)}`);
    }

    const status = async (pathname, { method = "GET", headers = {}, body } = {}) => {
      const response = await fetch(`${base}${pathname}`, { method, headers, body, redirect: "manual" });
      return response;
    };

    // -- a page without a cookie is refused ---------------------------------
    const noCookie = await status("/projects");
    assert.ok([301, 302, 303, 307, 308].includes(noCookie.status), `GET /projects returned ${noCookie.status}`);
    assert.match(noCookie.headers.get("location") ?? "", /\/login/);

    // -- a page with a cookie the proxy accepts but the database does not ---
    for (const [label, token] of [["unknown", "not-a-real-token"], ["revoked", revoked], ["expired", expired]]) {
      const response = await status("/projects", {
        headers: { cookie: cookieHeader("infra_cod_session_dev", token) },
      });
      assert.ok(
        [301, 302, 303, 307, 308].includes(response.status),
        `GET /projects with a ${label} session returned ${response.status}: ${serverLog.slice(-400)}`,
      );
      assert.match(response.headers.get("location") ?? "", /\/login/, `${label} session was not sent to /login`);
    }

    // -- API routes answer 401 rather than redirecting ----------------------
    for (const pathname of [
      "/api/control-plane/snapshot",
      "/api/control-plane/codex/status",
      "/api/control-plane/github/status",
      "/api/control-plane/opencode/status",
      "/api/control-plane/opencode/broker-key",
      "/api/control-plane/models/search",
    ]) {
      const response = await status(pathname, { headers: { cookie: cookieHeader("infra_cod_session_dev", revoked) } });
      assert.equal(response.status, 401, `${pathname} returned ${response.status} for a revoked session`);
    }

    // -- the login form needs its own pre-auth token ------------------------
    const loginWithoutToken = await status("/auth/login", {
      method: "POST",
      headers: { origin: base, "content-type": "application/x-www-form-urlencoded" },
      body: `username=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}`,
    });
    assert.match(loginWithoutToken.headers.get("location") ?? "", /error=csrf/);

    const loginWithBadToken = await status("/auth/login", {
      method: "POST",
      headers: {
        origin: base,
        "content-type": "application/x-www-form-urlencoded",
        cookie: cookieHeader("infra_cod_login_csrf_dev", csrf),
      },
      body: `username=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}&csrf_token=wrong`,
    });
    assert.match(loginWithBadToken.headers.get("location") ?? "", /error=csrf/);

    // -- unknown credentials are refused before anything else ---------------
    const badLogin = await status("/auth/login", {
      method: "POST",
      headers: {
        origin: base,
        "content-type": "application/x-www-form-urlencoded",
        cookie: cookieHeader("infra_cod_login_csrf_dev", csrf),
      },
      body: `username=${encodeURIComponent(username)}&password=not-the-password&csrf_token=${encodeURIComponent(csrf)}`,
    });
    assert.match(badLogin.headers.get("location") ?? "", /error=invalid/,
      "a wrong password did not produce the generic failure");

    // -- the happy path works, so the refusals above mean something ---------
    const loginPage = await status("/login");
    const html = await loginPage.text();
    const loginToken = /name="csrf_token" value="([^"]+)"/.exec(html)?.[1] ?? "";
    const setCookie = loginPage.headers.getSetCookie().find((value) => value.includes("infra_cod_login_csrf_dev")) ?? "";
    const loginCookie = setCookie.split(";")[0];
    assert.ok(loginToken && loginCookie, "GET /login did not issue a pre-auth CSRF token");

    const login = await status("/auth/login", {
      method: "POST",
      headers: {
        origin: base,
        "content-type": "application/x-www-form-urlencoded",
        cookie: loginCookie,
      },
      body: `username=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}`
        + `&csrf_token=${encodeURIComponent(loginToken)}`,
    });
    assert.equal(login.status, 303, `login returned ${login.status}: ${serverLog.slice(-400)}`);
    assert.match(login.headers.get("location") ?? "", /\/change-password$/);

    const sessionCookie = login.headers.getSetCookie()
      .map((value) => value.split(";")[0])
      .find((value) => value.startsWith("infra_cod_session_dev="));
    assert.ok(sessionCookie, "login did not set a session cookie");

    // ---- the forced-password-change fence, with the flag still set --------
    const fenced = await status("/settings", { headers: { cookie: sessionCookie } });
    assert.ok([301, 302, 303, 307, 308].includes(fenced.status), `the fence let /settings through (${fenced.status})`);
    assert.match(fenced.headers.get("location") ?? "", /\/change-password$/);

    const fencedApi = await status("/api/control-plane/snapshot", { headers: { cookie: sessionCookie } });
    assert.equal(fencedApi.status, 403, `an API route ignored the password-change fence (${fencedApi.status})`);

    const allowed = await status("/change-password", { headers: { cookie: sessionCookie } });
    assert.equal(allowed.status, 200, `the change-password page was not reachable (${allowed.status})`);

    // ---- and the CSRF surface, once the fence no longer redirects ---------
    //
    // The fence would otherwise answer every one of these with a 303 before the
    // CSRF check ever runs, which would hide whether the check works at all.
    psql(url, `UPDATE control_plane.users SET must_change_password=false WHERE id='${owner}';`);

    // /settings itself redirects to its first page since Stage 12 N7.
    const unfenced = await status("/settings/account", { headers: { cookie: sessionCookie } });
    assert.equal(unfenced.status, 200, `the panel was unreachable after the fence lifted (${unfenced.status})`);

    const actions = await status("/api/control-plane/actions", {
      method: "POST",
      headers: {
        cookie: cookieHeader("infra_cod_session_dev", live),
        origin: base,
        "content-type": "application/json",
        "x-control-plane-action": "confirmed",
      },
      body: JSON.stringify({ kind: "noop" }),
    });
    assert.equal(actions.status, 403, `a CSRF-less action returned ${actions.status}`);

    const wrongToken = await status("/api/control-plane/actions", {
      method: "POST",
      headers: {
        cookie: cookieHeader("infra_cod_session_dev", live),
        origin: base,
        "content-type": "application/json",
        "x-control-plane-action": "confirmed",
        "x-csrf-token": randomBytes(32).toString("base64url"),
      },
      body: JSON.stringify({ kind: "noop" }),
    });
    assert.equal(wrongToken.status, 403, `a forged CSRF token returned ${wrongToken.status}`);

    const crossOrigin = await status("/api/control-plane/actions", {
      method: "POST",
      headers: {
        cookie: cookieHeader("infra_cod_session_dev", live),
        origin: "https://attacker.example",
        "content-type": "application/json",
        "x-control-plane-action": "confirmed",
        "x-csrf-token": csrf,
      },
      body: JSON.stringify({ kind: "noop" }),
    });
    assert.equal(crossOrigin.status, 403, `a cross-origin action returned ${crossOrigin.status}`);

    for (const pathname of ["/auth/logout", "/auth/change-username", "/auth/revoke-other-sessions", "/auth/change-password", "/auth/revoke-session"]) {
      const response = await status(pathname, {
        method: "POST",
        headers: {
          cookie: cookieHeader("infra_cod_session_dev", live),
          origin: base,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: "csrf_token=wrong",
      });
      assert.equal(response.status, 403, `${pathname} accepted a forged CSRF token (${response.status})`);
    }

    // A valid session without the token is still refused: holding a session is
    // not the same as proving the request came from the panel.
    const validButNoCsrf = await status("/api/control-plane/actions", {
      method: "POST",
      headers: {
        cookie: sessionCookie,
        origin: base,
        "content-type": "application/json",
        "x-control-plane-action": "confirmed",
      },
      body: JSON.stringify({ kind: "noop" }),
    });
    assert.equal(validButNoCsrf.status, 403, `a live session bypassed CSRF (${validButNoCsrf.status})`);

    // The correct token gets past the CSRF check. It still fails on the unknown
    // action kind, which is a different status — that is the point.
    const withCorrectToken = await status("/api/control-plane/actions", {
      method: "POST",
      headers: {
        cookie: cookieHeader("infra_cod_session_dev", live),
        origin: base,
        "content-type": "application/json",
        "x-control-plane-action": "confirmed",
        "x-csrf-token": csrf,
      },
      body: JSON.stringify({ kind: "noop" }),
    });
    assert.notEqual(withCorrectToken.status, 403, "the correct CSRF token was rejected");
    assert.notEqual(withCorrectToken.status, 401, "the correct CSRF token was rejected");

    // ---- the sign-in upgraded a stale hash --------------------------------
    //
    // The operator was bootstrapped with a hash made under old parameters. The
    // successful sign-in above has to have replaced it, in place: no session
    // revoked, no forced change cleared, just a stronger encoding.
    const afterLogin = psql(url, `SELECT password_hash FROM control_plane.users WHERE id='${owner}';`);
    assert.equal(
      needsRehash(afterLogin), false,
      "a hash from an older cost profile survived a successful sign-in",
    );
    assert.equal(
      psql(url, `SELECT count(*) FROM control_plane.audit_events WHERE action='auth.password_rehashed';`),
      "1",
      "the rehash was not recorded",
    );

    // ---- the lockout is not a distinguishable answer ----------------------
    //
    // Every credential refusal, including the ones the lockout produces, must be
    // the same response — not merely the same error code. This compares the whole
    // thing the caller can observe: the status, the redirect target, the status
    // of the page it lands on, and the rendered body of that page with only the
    // per-request CSRF token normalised out. Twelve attempts is past the cap of
    // ten, so at least one of these is a locked-out attempt.
    const refusalShape = async (password) => {
      const page = await status("/login");
      const body = await page.text();
      const token = /name="csrf_token" value="([^"]+)"/.exec(body)?.[1] ?? "";
      const cookie = page.headers.getSetCookie()
        .map((value) => value.split(";")[0])
        .find((value) => value.startsWith("infra_cod_login_csrf_dev=")) ?? "";
      const response = await status("/auth/login", {
        method: "POST",
        headers: { origin: base, "content-type": "application/x-www-form-urlencoded", cookie },
        body: `username=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}`
          + `&csrf_token=${encodeURIComponent(token)}`,
      });
      const location = response.headers.get("location") ?? "";
      // Follow the redirect, the way a browser would, and keep what it renders.
      // Two things are normalised because they change on every request and say
      // nothing about the outcome: the CSRF token the page embeds (in the markup
      // and again, escaped, inside the RSC payload), and Next's per-request RSC
      // correlation id. Everything else is compared byte for byte.
      const landed = await status(new URL(location, base).pathname + new URL(location, base).search);
      const rendered = (await landed.text())
        .replace(/value="[^"]*"/g, 'value="<token>"')
        .replace(/self\.__next_r="[^"]*"/g, 'self.__next_r="<id>"')
        .replace(/\\"value\\":\\"[^"\\]*\\"/g, '\\"value\\":\\"<token>\\"');
      return {
        status: response.status,
        path: new URL(location, base).pathname + new URL(location, base).search,
        landedStatus: landed.status,
        rendered,
      };
    };

    // A refusal that is certainly not locked out, as the reference shape.
    const reference = await refusalShape("still-not-the-password");
    assert.equal(reference.status, 303);
    assert.match(reference.path, /error=invalid/);
    assert.match(reference.rendered, /Invalid username or password/);

    let distinguishable = null;
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const observed = await refusalShape("still-not-the-password");
      if (JSON.stringify(observed) !== JSON.stringify(reference)) {
        distinguishable = `attempt ${attempt}: ${JSON.stringify({
          status: observed.status, path: observed.path, landedStatus: observed.landedStatus,
        })}`;
        break;
      }
    }
    assert.equal(distinguishable, null, `a locked-out attempt was distinguishable: ${distinguishable}`);
  } finally {
    if (server && server.exitCode === null && server.signalCode === null) {
      // Negative pid: the whole group, workers included.
      try {
        process.kill(-server.pid, "SIGKILL");
      } catch {
        try { server.kill("SIGKILL"); } catch { /* already gone */ }
      }
      // `once("exit")` never fires for a process that already died, and a dev
      // server that ignored SIGKILL would hang the whole suite, so this waits
      // with a ceiling rather than indefinitely.
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 5_000);
        server.once("exit", () => { clearTimeout(timer); resolve(); });
      });
    }
    rmSync(credentialsDir, { recursive: true, force: true });
    rmSync(path.join(root, "apps/web", ROUTE_TEST_DIST_DIR), { recursive: true, force: true });
    psql(maintenance, `DROP DATABASE IF EXISTS ${scratch} WITH (FORCE);`);
  }
});
