import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import net from "node:net";
import path from "node:path";

// A control-plane action and the row saying the operator asked for it are one
// transaction.
//
// They used to be two: the action committed, then the audit was written. If the
// audit failed — or the session was revoked in between — the change stayed applied
// with no record of who asked, and the caller was told it failed, so a retry
// duplicates or conflicts.
//
// The fault is injected where a real failure would arrive: the audit function is
// replaced with one that raises, and the assertion is that the mutation rolled
// back with it. Checking only the response would pass for a route that returned
// an error while leaving the change behind — which is exactly the bug.
//
// This file starts a real panel. Next 16 locks the project directory for `next dev`,
// so no other dev server — including a developer's own `npm run web:dev`, or the
// other test that starts one — may be running against apps/web at the same time.
// `test:integration:live` runs the live tests with --test-concurrency=1 for that
// reason.

// Skipped only when psql or a superuser connection is genuinely unavailable.

const adminDatabaseUrl = process.env.DATABASE_URL;
const pepper = process.env.INFRA_COD_AUTH_PEPPER ?? "action-atomicity-pepper";
const psqlBin = process.env.PSQL_BIN ?? "psql";

let hasPsql = false;
try {
  const probe = spawnSync("sh", ["-c", `command -v ${JSON.stringify(psqlBin)}`], { stdio: "ignore" });
  hasPsql = probe.status === 0;
} catch {}

const skip = !adminDatabaseUrl ? "DATABASE_URL is not set" : !hasPsql ? "psql is not available" : false;

const root = path.resolve(import.meta.dirname, "../../..");
const ROUTE_TEST_DIST_DIR = ".next-route-test";
const AUDIT_SIGNATURE = "write_session_audit(bytea,text,text,text,text,jsonb,uuid,text)";

let scratch = "";
let url = "";
let owner = "";
let projectId = "";

function adminUrl(database) {
  const parsed = new URL(adminDatabaseUrl);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

function psql(sql) {
  const result = spawnSync(psqlBin, ["-X", "-qAt", "-v", "ON_ERROR_STOP=1", url], {
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

// "provisioning_status/status" for the probe project.
function projectState() {
  return psql(`SELECT settings->>'provisioning_status'||'/'||status
               FROM control_plane.projects WHERE id='${projectId}';`);
}

function allowedAuditRows() {
  return Number(psql(
    "SELECT count(*) FROM control_plane.audit_events WHERE action='operator.retry_provisioning';",
  ));
}

test.before(async () => {
  if (skip) return;
  scratch = `infra_cod_atomic_${randomUUID().slice(0, 8).replace(/-/g, "")}`;
  const maintenance = adminUrl("postgres");
  const created = spawnSync(psqlBin, ["-X", "-qAt", "-v", "ON_ERROR_STOP=1", maintenance], {
    encoding: "utf8", input: `CREATE DATABASE ${scratch};`,
  });
  if (created.status !== 0) throw new Error(created.stderr);
  url = adminUrl(scratch);

  const migrate = spawnSync(process.execPath, [path.join(root, "services/control-plane/migrate.mjs")], {
    encoding: "utf8", env: { ...process.env, DATABASE_URL: url },
  });
  if (migrate.status !== 0) throw new Error(`migrate failed: ${migrate.stderr}`);
});

test.after(() => {
  if (skip) return;
  spawnSync(psqlBin, ["-X", "-qAt", adminUrl("postgres")], {
    encoding: "utf8", input: `DROP DATABASE IF EXISTS ${scratch} WITH (FORCE);`,
  });
});

test("an audit failure rolls the action back", { skip }, async () => {
  const hash = "$argon2id$v=19$m=19456,t=2,p=1$c2FsdHNhbHRzYWx0c2E$aGFzaGhhc2hoYXNoaGFzaA";
  owner = psql(`SELECT (control_plane.bootstrap_local_owner('admin-atomic', '${hash}', 'Owner')->>'user_id');`);
  projectId = psql(
    `INSERT INTO control_plane.projects(owner_id,name,slug,workspace_path,status,settings,credential_mode)
     VALUES ('${owner}','Atomic probe','atomic-probe','/tmp/atomic-probe','needs_attention',
             '{"provisioning_status":"failed"}'::jsonb,'empty')
     RETURNING id;`,
  );
  assert.equal(projectState(), "failed/needs_attention");

  // A live session, created directly: this test is about the action route's
  // transaction, not about how a session is issued.
  psql("UPDATE control_plane.users SET must_change_password=false;");
  const sessionToken = randomBytes(32).toString("base64url");
  const csrfToken = randomBytes(32).toString("base64url");
  const digest = (value) => createHash("sha256").update(value).digest("hex");
  psql(`INSERT INTO control_plane.web_sessions(user_id,token_digest,csrf_digest,expires_at,absolute_expires_at)
        VALUES ('${owner}', decode('${digest(sessionToken)}','hex'), decode('${digest(csrfToken)}','hex'),
                clock_timestamp()+interval '12 hours', clock_timestamp()+interval '30 days');`);

  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const server = spawn(
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
        NEXT_DIST_DIR: ROUTE_TEST_DIST_DIR,
        NEXT_TELEMETRY_DISABLED: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    },
  );
  let serverLog = "";
  server.stdout.on("data", (chunk) => { serverLog += chunk.toString(); });
  server.stderr.on("data", (chunk) => { serverLog += chunk.toString(); });

  const act = () => fetch(`${base}/api/control-plane/actions`, {
    method: "POST",
    redirect: "manual",
    headers: {
      origin: base,
      cookie: `infra_cod_session_dev=${sessionToken}; infra_cod_csrf_dev=${csrfToken}`,
      "content-type": "application/json",
      "x-control-plane-action": "confirmed",
      "x-csrf-token": csrfToken,
    },
    body: JSON.stringify({ kind: "retry_provisioning", projectId }),
  });

  try {
    try {
      await waitForPanel(base);
    } catch (error) {
      throw new Error(`${error.message}\n--- panel output ---\n${serverLog.slice(-3000)}`);
    }

    const before = allowedAuditRows();

    // ---- the happy path, so the rollback below means something -------------
    const ok = await act();
    assert.equal(ok.status, 200, `the action failed: ${await ok.text()} ${serverLog.slice(-400)}`);
    assert.equal(projectState(), "pending/needs_attention", "the action did not apply");
    assert.equal(allowedAuditRows(), before + 1, "the successful action was not audited");

    // Put it back, so the injected failure has something to roll back.
    psql(`UPDATE control_plane.projects
          SET status='needs_attention',
              settings=jsonb_set(settings,'{provisioning_status}','"failed"'::jsonb,true)
          WHERE id='${projectId}';`);
    assert.equal(projectState(), "failed/needs_attention");

    // ---- inject the fault --------------------------------------------------
    //
    // Renamed rather than dropped, so the real function can be put back and the
    // panel is left working for the last assertion.
    psql(`ALTER FUNCTION control_plane.${AUDIT_SIGNATURE} RENAME TO write_session_audit_real;`);
    psql(`CREATE FUNCTION control_plane.${AUDIT_SIGNATURE} RETURNS jsonb
          LANGUAGE plpgsql AS $injected$ BEGIN
            RAISE EXCEPTION 'injected audit failure' USING ERRCODE='55000';
          END $injected$;`);

    const failed = await act();
    assert.equal(failed.status, 400, `the faulted action did not report failure: ${failed.status}`);
    // The assertion that matters: the response said failure, and the row agrees
    // that nothing happened.
    assert.equal(
      projectState(),
      "failed/needs_attention",
      "the action was committed even though its audit row failed",
    );
    assert.equal(allowedAuditRows(), before + 1, "the faulted action wrote an audit row after all");

    // ---- the panel still works once the fault is gone ----------------------
    psql(`DROP FUNCTION control_plane.${AUDIT_SIGNATURE};`);
    psql("ALTER FUNCTION control_plane.write_session_audit_real RENAME TO write_session_audit;");

    const recovered = await act();
    assert.equal(recovered.status, 200, "the action did not work after the fault was removed");
    assert.equal(projectState(), "pending/needs_attention");
    assert.equal(allowedAuditRows(), before + 2);
  } finally {
    if (server.exitCode === null && server.signalCode === null) {
      try {
        process.kill(-server.pid, "SIGKILL");
      } catch {
        try { server.kill("SIGKILL"); } catch { /* already gone */ }
      }
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 5_000);
        server.once("exit", () => { clearTimeout(timer); resolve(); });
      });
    }
  }
});
