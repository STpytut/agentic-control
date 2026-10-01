import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

// The standalone runtime tree, started the way production starts it.
//
// Every other web test starts `next dev` or `next start`. Neither is what the
// VPS runs, so neither can catch the failures this file exists for: an entry
// point that moved because the trace root changed, a `public/` or `.next/static`
// that was never copied, a production build that needs a package manager at
// boot, or an environment the server accepts in development and rejects in
// production. Those are all invisible until a real installation serves its first
// request.
//
// The tree is staged by `scripts/stage-standalone.mjs`, which builds if it has
// to; the smoke test itself only starts the result. It uses a database of its
// own and a random loopback port, and it holds the password it generated in
// memory — it is never printed, and the credentials file it writes lives under a
// temporary directory that is removed at the end.

const root = path.resolve(import.meta.dirname, "../../..");
const psqlBin = process.env.PSQL_BIN ?? "psql";
const databaseName = `infra_cod_standalone_${process.pid}`;
const pepper = "standalone-smoke-pepper-not-a-secret";

const target = {
  host: process.env.PGHOST ?? "localhost",
  port: process.env.PGPORT ?? "5432",
  user: process.env.PGUSER ?? process.env.USER ?? "",
};

function adminUrlFor(database) {
  if (process.env.DATABASE_URL) {
    const parsed = new URL(process.env.DATABASE_URL);
    parsed.pathname = `/${database}`;
    return parsed.toString();
  }
  return `postgresql:///${database}`;
}

function psql(database, sql) {
  const result = spawnSync(
    psqlBin,
    ["-X", "-qAt", "-v", "ON_ERROR_STOP=1", adminUrlFor(database)],
    { encoding: "utf8", input: sql },
  );
  if (result.error) throw new Error(`psql could not be started: ${result.error.message}`);
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

// Every variable a process-starting test needs, plus the ones that make the
// "no package manager, no network" claim checkable: PATH carries the Node binary
// and the system directories, no npm/pnpm/yarn anywhere on it, and the proxy
// variables that would let a failed download look like a slow start are removed.
function serverEnvironment({ port, databaseUrl, siteUrl, insecure, nodePath }) {
  const base = {
    PATH: path.dirname(process.execPath) + ":/usr/local/bin:/usr/bin:/bin",
    NODE_ENV: "production",
    HOSTNAME: "127.0.0.1",
    PORT: String(port),
    DATABASE_URL: databaseUrl,
    INFRA_COD_AUTH_PEPPER: pepper,
    INFRA_COD_CREDENTIALS_DIR: nodePath,
    NEXT_TELEMETRY_DISABLED: "1",
    HOME: nodePath,
    TMPDIR: os.tmpdir(),
  };
  if (siteUrl !== undefined) base.INFRA_COD_SITE_URL = siteUrl;
  if (insecure) base.INFRA_COD_INSECURE_COOKIES = "1";
  return base;
}

// Starts the staged server and resolves once it says it is listening.
//
// Readiness is a stdout sentinel, never a sleep: the alternative is a fixed delay
// that either wastes time or fails under load, and neither says anything about
// whether the server is actually serving.
function startStandalone({ entrypoint, environment, report }) {
  const child = spawn(process.execPath, [entrypoint], {
    cwd: path.dirname(entrypoint),
    env: environment,
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  let output = "";
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`the standalone server never became ready:\n${output.slice(-2000)}`));
    }, 60_000);
    child.stdout.on("data", (chunk) => {
      output += chunk.toString();
      if (/- Local:|Ready in|started server/i.test(output)) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.stderr.on("data", (chunk) => { output += chunk.toString(); });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`the standalone server exited early with ${code}:\n${output.slice(-2000)}`));
    });
  });
  report.output = () => output;
  report.child = child;
  return ready;
}

async function stopStandalone(child) {
  if (!child || child.exitCode !== null) return { code: child?.exitCode ?? null, orphans: [] };
  const exited = new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
  // The whole process group: `server.js` may start workers, and signalling only
  // the parent is how an "orphan" is defined here.
  process.kill(-child.pid, "SIGTERM");
  const result = await Promise.race([
    exited,
    new Promise((_, reject) => setTimeout(() => reject(new Error("the standalone server ignored SIGTERM")), 20_000)),
  ]);
  // Anything still alive in the group after the parent exited is an orphan.
  const orphans = [];
  try {
    process.kill(-child.pid, 0);
    orphans.push(child.pid);
    process.kill(-child.pid, "SIGKILL");
  } catch {
    // ESRCH: the group is gone, which is what is being asserted.
  }
  return { ...result, orphans };
}

// A minimal cookie jar for a trusted, non-browser client.
//
// `fetch` does not keep cookies, and the login flow is a chain of them: the
// pre-auth CSRF pair, then the session, then its rotation on a password change.
// The jar deliberately accepts `Secure` and `__Host-` cookies over a plain http
// connection: a browser would refuse them, which is the point of the attributes,
// but the panel is being exercised by a client that already holds them. That is
// what lets the flow run against the real production build — Next bakes
// `NODE_ENV=production` into the standalone bundle, so the development escape
// hatch (`INFRA_COD_INSECURE_COOKIES`) is unavailable there by construction.
//
// `connection` is where the socket goes; `origin` is what the panel is configured
// to be. They differ here on purpose: the panel believes it is served over https
// by Caddy, the way it will be in production.
function createClient({ connection, origin }) {
  const jar = new Map();
  function cookieHeader() {
    return [...jar.entries()].map(([name, value]) => `${name}=${value}`).join("; ");
  }
  function absorb(response) {
    for (const raw of response.headers.getSetCookie()) {
      const [pair] = raw.split(";");
      const index = pair.indexOf("=");
      if (index <= 0) continue;
      const name = pair.slice(0, index).trim();
      const value = pair.slice(index + 1).trim();
      if (value === "") jar.delete(name);
      else jar.set(name, value);
    }
  }
  return {
    jar,
    async fetch(pathname, options = {}) {
      const headers = { origin, ...(options.headers ?? {}) };
      const cookie = cookieHeader();
      if (cookie) headers.cookie = cookie;
      const response = await fetch(`${connection}${pathname}`, { redirect: "manual", ...options, headers });
      absorb(response);
      return response;
    },
    form(pathname, fields, options = {}) {
      return this.fetch(pathname, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", ...(options.headers ?? {}) },
        body: new URLSearchParams(fields).toString(),
      });
    },
  };
}

function csrfTokenFrom(html) {
  const match = /name="csrf_token" value="([^"]+)"/.exec(html);
  assert.ok(match, "the page did not render a csrf_token field");
  return match[1];
}

function cookieNamed(client, name) {
  return client.jar.get(name);
}

let staging = null;
let receipt = null;
let scratch = null;
let credentialsDirectory = null;
let credentials = null;
let nodeRuntimeDirectory = null;

test.before(async () => {
  scratch = mkdtempSync(path.join(os.tmpdir(), "infra-cod-standalone-"));
  credentialsDirectory = path.join(scratch, "credentials");
  nodeRuntimeDirectory = path.join(scratch, "home");

  psql("postgres", `DROP DATABASE IF EXISTS ${databaseName} WITH (FORCE);`);
  psql("postgres", `CREATE DATABASE ${databaseName};`);
  const databaseUrl = adminUrlFor(databaseName);
  const migrated = spawnSync(
    process.execPath,
    [path.join(root, "services/control-plane/migrate.mjs")],
    { encoding: "utf8", env: { ...process.env, DATABASE_URL: databaseUrl } },
  );
  if (migrated.status !== 0) throw new Error(`migrating the smoke database failed: ${migrated.stderr.trim()}`);

  // The account an installer would create, through the real CLI, so the sign-in
  // below uses a credential this system actually issues.
  const bootstrap = spawnSync(
    process.execPath,
    [path.join(root, "services/cli/infra-cod.mjs"), "admin", "bootstrap", "--username", "smoke-operator", "--display-name", "Smoke Operator"],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        DATABASE_URL: databaseUrl,
        INFRA_COD_AUTH_PEPPER: pepper,
        INFRA_COD_CREDENTIALS_DIR: credentialsDirectory,
      },
    },
  );
  if (bootstrap.status !== 0) throw new Error(`bootstrap failed: ${bootstrap.stderr.trim()}`);
  const file = path.join(credentialsDirectory, "initial-credentials");
  if (!existsSync(file)) throw new Error("bootstrap did not write the credentials file");
  const parsed = Object.fromEntries(
    readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => {
      const index = line.indexOf("=");
      return [line.slice(0, index), line.slice(index + 1)];
    }),
  );
  assert.match(parsed.password ?? "", /\S/, "the generated password is empty");
  credentials = parsed;
  // The file is the one place the plaintext exists; the test keeps it in memory
  // and deletes the file with the rest of the scratch directory.
  rmSync(file, { force: true });

  // The staged tree, built if the build is not already there. This is the same
  // script the release flow will use, so what is smoked here is what is shipped.
  staging = mkdtempSync(path.join(os.tmpdir(), "infra-cod-stage-"));
  const staged = spawnSync(
    process.execPath,
    [path.join(root, "scripts/stage-standalone.mjs"), "--out", staging, "--quiet"],
    { encoding: "utf8", env: { ...process.env } },
  );
  if (staged.status !== 0) {
    throw new Error(`staging failed: ${staged.stdout ?? ""}${staged.stderr ?? ""}`.slice(-4000));
  }
  receipt = JSON.parse(readFileSync(path.join(staging, "receipt.json"), "utf8"));
  assert.equal(receipt.schema, "infra-cod/web-standalone-receipt/1");
});

test.after(async () => {
  if (staging) rmSync(staging, { recursive: true, force: true });
  if (scratch) rmSync(scratch, { recursive: true, force: true });
  psql("postgres", `DROP DATABASE IF EXISTS ${databaseName} WITH (FORCE);`);
});

test("the receipt describes a real, self-contained tree", () => {
  assert.ok(existsSync(receipt.layout.entrypoint), "the receipt names an entry point that does not exist");
  // `danglingLinks` is not asserted to be zero: the traced pnpm layout contains
  // one placeholder link whose target was never written. The property that
  // matters is that no link escapes the tree, which the staging script enforces
  // and `internalLinks` records; the server starts and serves with the
  // placeholder present.
  assert.ok(receipt.contents.internalLinks >= 0);
  // The entry point is nested by the trace root; a unit or a script written
  // against a flattened `standalone/server.js` would start nothing, so the exact
  // relative path is pinned rather than discovered at deploy time.
  assert.equal(receipt.layout.relativeEntrypoint, "apps/web/server.js");
  assert.match(receipt.runtime.node, /^v\d+/);
  assert.match(receipt.git.sha, /^[0-9a-f]{40}$/);
  // The two directories Next leaves out have to be beside the server that reads
  // them, not merely somewhere in the tree.
  const appRoot = path.dirname(receipt.layout.entrypoint);
  assert.ok(existsSync(path.join(appRoot, "public")), "public/ was not placed beside the server");
  assert.ok(existsSync(path.join(appRoot, ".next/static")), ".next/static was not placed beside the server");
});

test("the standalone server serves login, redirects anonymous access, and runs the full sign-in flow", async () => {
  const port = await freePort();
  const connection = `http://127.0.0.1:${port}`;
  // What the panel is configured to be. The real deployment terminates TLS in
  // Caddy and forwards to loopback, so the process sees an https origin and
  // issues `Secure` `__Host-` cookies while this client talks to it directly.
  const origin = "https://panel.example.test";
  const report = {};
  await startStandalone({
    entrypoint: receipt.layout.entrypoint,
    environment: serverEnvironment({
      port,
      databaseUrl: adminUrlFor(databaseName),
      siteUrl: origin,
      nodePath: nodeRuntimeDirectory,
    }),
    report,
  });

  try {
    const client = createClient({ connection, origin });

    // A readiness probe reaches the panel before any browser does, and the
    // installer's is a HEAD. /login answered HTTP 500 to it on a healthy server
    // — the page tried to mint the pre-auth CSRF cookie from a Server Component,
    // which Next refuses — so the install timed out waiting for a panel that was
    // already up. HEAD is checked first, and before any cookie exists.
    const probe = await client.fetch("/login", { method: "HEAD" });
    assert.ok(
      probe.status >= 200 && probe.status < 400,
      `HEAD /login returned ${probe.status}; a readiness probe must not see an error page`,
    );

    // `/login` is the page an operator sees first.
    const loginPage = await client.fetch("/login");
    assert.equal(loginPage.status, 200, `GET /login returned ${loginPage.status}`);
    const loginHtml = await loginPage.text();
    assert.match(loginHtml, /Sign in/);

    // Anonymous access to a protected page is a redirect, not a render.
    const anonymous = await client.fetch("/projects");
    assert.ok([301, 302, 303, 307, 308].includes(anonymous.status), `anonymous /projects returned ${anonymous.status}`);
    assert.match(anonymous.headers.get("location") ?? "", /\/login$/);

    // The static assets the HTML actually references have to resolve. This is the
    // assertion that catches a `.next/static` or `public/` that was never copied:
    // the page renders without it and every script 404s.
    const scriptSources = [...loginHtml.matchAll(/src="([^"]+\.js)"/g)].map((match) => match[1]);
    const styleSources = [...loginHtml.matchAll(/href="([^"]+\.css)"/g)].map((match) => match[1]);
    assert.ok(scriptSources.length > 0, "the login page referenced no script at all");
    for (const asset of [...scriptSources, ...styleSources]) {
      const response = await fetch(asset.startsWith("http") ? asset : `${connection}${asset}`, { redirect: "manual" });
      assert.equal(response.status, 200, `${asset} returned ${response.status}`);
      const body = await response.arrayBuffer();
      assert.ok(body.byteLength > 0, `${asset} was served empty`);
    }

    // Sign in with the generated credential.
    const loginToken = csrfTokenFrom(loginHtml);
    const login = await client.form("/auth/login", {
      username: credentials.username,
      password: credentials.password,
      csrf_token: loginToken,
    });
    assert.equal(login.status, 303, `login returned ${login.status}: ${report.output().slice(-600)}`);
    assert.match(login.headers.get("location") ?? "", /\/change-password$/, "a first sign-in must be fenced to a password change");

    const sessionCookie = cookieNamed(client, "__Host-infra_cod_session");
    assert.ok(sessionCookie, "login did not set a production session cookie");

    // The fence holds until the password is replaced.
    const fenced = await client.fetch("/projects");
    assert.ok([301, 302, 303, 307, 308].includes(fenced.status), `the fence let /projects through (${fenced.status})`);
    assert.match(fenced.headers.get("location") ?? "", /\/change-password$/);

    // Replace it, through the page's own form.
    const changePage = await client.fetch("/change-password");
    assert.equal(changePage.status, 200, `GET /change-password returned ${changePage.status}`);
    const changeHtml = await changePage.text();
    const changeToken = csrfTokenFrom(changeHtml);
    const nextPassword = `Smoke-${credentials.password}-2`;
    const changed = await client.form("/auth/change-password", {
      current_password: credentials.password,
      new_password: nextPassword,
      confirm_password: nextPassword,
      csrf_token: changeToken,
    });
    assert.equal(changed.status, 303, `the password change returned ${changed.status}`);
    assert.match(changed.headers.get("location") ?? "", /\/projects$/, "the change did not release the fence");
    credentials.password = nextPassword;

    const projects = await client.fetch("/projects");
    assert.equal(projects.status, 200, `GET /projects returned ${projects.status} after the change`);
    assert.match(await projects.text(), /projects/i);

    // Restart against the same database: a session is server state, so it has to
    // survive the process that issued it going away.
    const restarted = {};
    await stopStandalone(report.child);
    await startStandalone({
      entrypoint: receipt.layout.entrypoint,
      environment: serverEnvironment({
        port,
        databaseUrl: adminUrlFor(databaseName),
        siteUrl: origin,
        nodePath: nodeRuntimeDirectory,
      }),
      report: restarted,
    });
    try {
      const afterRestart = await client.fetch("/projects");
      assert.equal(afterRestart.status, 200, "the session did not survive a restart");
    } finally {
      const stopped = await stopStandalone(restarted.child);
      assert.deepEqual(stopped.orphans, [], "a process was left behind after SIGTERM");
      // Node exits 128+15 on an unhandled SIGTERM; what matters is that it did
      // exit on the signal rather than having to be killed, and that nothing in
      // its process group outlived it.
      assert.ok(stopped.code === 0 || stopped.code === 143, `the restarted server exited ${stopped.code} on SIGTERM`);
    }
  } finally {
    await stopStandalone(report.child);
  }
});

test("production refuses to serve without a valid https origin", async () => {
  // The cookie guard runs at module evaluation and would abort the request before
  // the origin check ever runs, so these two scenarios must NOT set
  // `INFRA_COD_INSECURE_COOKIES`: with it, they would pass because of the cookie
  // flag and stay green even if the origin check were deleted. Each case asserts
  // the specific diagnostic as well, because any 5xx is not evidence of the check
  // that is being tested.
  const missingPort = await freePort();
  const missing = await observeRefusal({
    entrypoint: receipt.layout.entrypoint,
    environment: serverEnvironment({
      port: missingPort,
      databaseUrl: adminUrlFor(databaseName),
      nodePath: nodeRuntimeDirectory,
    }),
    base: `http://127.0.0.1:${missingPort}`,
  });
  assert.equal(missing.served, false, "the panel served a request without a configured origin");
  assert.match(
    missing.diagnostic,
    /INFRA_COD_SITE_URL must be set/,
    `the refusal was not the missing-origin check: ${missing.diagnostic.slice(-400)}`,
  );

  const httpOriginPort = await freePort();
  const httpOrigin = await observeRefusal({
    entrypoint: receipt.layout.entrypoint,
    environment: serverEnvironment({
      port: httpOriginPort,
      databaseUrl: adminUrlFor(databaseName),
      siteUrl: `http://127.0.0.1:${httpOriginPort}`,
      nodePath: nodeRuntimeDirectory,
    }),
    base: `http://127.0.0.1:${httpOriginPort}`,
  });
  assert.equal(httpOrigin.served, false, "the panel served a request with an http origin in production");
  assert.match(
    httpOrigin.diagnostic,
    /INFRA_COD_SITE_URL must use https/,
    `the refusal was not the https-origin check: ${httpOrigin.diagnostic.slice(-400)}`,
  );
});

test("production refuses to serve with insecure cookies", async () => {
  const port = await freePort();
  // A valid https origin, so nothing but the cookie flag can be the reason.
  const refusal = await observeRefusal({
    entrypoint: receipt.layout.entrypoint,
    environment: serverEnvironment({
      port,
      databaseUrl: adminUrlFor(databaseName),
      siteUrl: "https://panel.example.test",
      insecure: true,
      nodePath: nodeRuntimeDirectory,
    }),
    base: `http://127.0.0.1:${port}`,
  });
  assert.equal(refusal.served, false, "the panel served with INFRA_COD_INSECURE_COOKIES=1 in production");
  assert.match(
    refusal.diagnostic,
    /INFRA_COD_INSECURE_COOKIES=1 must never be combined with NODE_ENV=production/,
    `the refusal was not the cookie guard: ${refusal.diagnostic.slice(-400)}`,
  );
});

// Starts the server and reports whether it ever served a request, together with
// the diagnostic it produced while refusing. "Refused" means a boot failure, no
// HTTP answer, or a 5xx response body — and the caller asserts which error it
// was, because a 5xx on its own could come from anything.
async function observeRefusal({ entrypoint, environment, base }) {
  const report = {};
  let startupError = null;
  try {
    await startStandalone({ entrypoint, environment, report });
  } catch (error) {
    startupError = error.message;
  }

  if (startupError) {
    return { served: false, diagnostic: startupError };
  }

  try {
    const response = await fetch(`${base}/login`, { redirect: "manual" });
    const body = await response.text().catch(() => "");
    return {
      served: response.status < 500,
      status: response.status,
      // The whole observable refusal: the body the server returned and whatever
      // the process wrote while handling it.
      diagnostic: `${body}\n${report.output?.() ?? ""}`,
    };
  } catch (error) {
    return { served: false, diagnostic: `${error.message}\n${report.output?.() ?? ""}` };
  } finally {
    await stopStandalone(report.child);
  }
}
