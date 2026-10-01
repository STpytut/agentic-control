import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { closePool, queryJson, queryJsonOn, withTransaction } from "../db.mjs";

// The credential fence, under actual concurrency.
//
// The sequential version of these races is pinned in
// db/tests/0030_local_auth_credential_fence_test.sql. What this file adds is the
// interleaving: two connections, one holding the account row while the other
// waits behind it, which is the only way to show that the lock is what makes the
// outcome deterministic rather than the order the statements happen to run in.
//
// Skipped only when psql or a superuser connection is genuinely unavailable.

const adminDatabaseUrl = process.env.DATABASE_URL;
const psqlBin = process.env.PSQL_BIN ?? "psql";

let hasPsql = false;
try {
  const probe = spawnSync("sh", ["-c", `command -v ${JSON.stringify(psqlBin)}`], { stdio: "ignore" });
  hasPsql = probe.status === 0;
} catch {}

const skip = !adminDatabaseUrl ? "DATABASE_URL is not set" : !hasPsql ? "psql is not available" : false;

const root = path.resolve(import.meta.dirname, "../../..");
const HASH_A = "$argon2id$v=19$m=19456,t=2,p=1$c2FsdHNhbHRzYWx0c2E$aGFzaGhhc2hoYXNoaGFzaA";
const HASH_B = "$argon2id$v=19$m=19456,t=2,p=1$c2FsdHNhbHRzYWx0c2I$aGFzaGhhc2hoYXNoaGFzaA";

let scratch = "";
let url = "";
let owner = "";
let attemptCounter = 0;

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

// A fresh reservation, the way the login path opens one.
async function reserveAttempt(username) {  attemptCounter += 1;
  const ip = Buffer.alloc(32, attemptCounter % 251);
  const result = await queryJson(
    `SELECT begin_auth_attempt(:'username', :'ip_hash', NULL)::text;`,
    { username, ip_hash: ip.toString("hex") },
  );
  assert.equal(result.allowed, true, "the attempt was refused before it started");
  return { attemptId: result.attempt_id, ip };
}

function loginArguments({ attemptId, ip, expectedUsername, expectedHash, tokenByte }) {
  return {
    attempt_id: String(attemptId),
    user_id: owner,
    expected_username: expectedUsername,
    expected_password_hash: expectedHash,
    token_digest: Buffer.alloc(32, tokenByte).toString("hex"),
    csrf_digest: Buffer.alloc(32, tokenByte + 1).toString("hex"),
    ip_hash: ip.toString("hex"),
    user_agent_hash: Buffer.alloc(32, 7).toString("hex"),
    idle: "12 hours",
    absolute: "30 days",
  };
}

const COMPLETE_SQL = `SELECT complete_local_login(
  :'attempt_id'::bigint, :'user_id'::uuid, :'expected_username', :'expected_password_hash',
  decode(:'token_digest','hex'), decode(:'csrf_digest','hex'),
  decode(:'ip_hash','hex'), decode(:'user_agent_hash','hex'),
  :'idle'::interval, :'absolute'::interval)::text;`;

async function waitUntil(check, label, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for ${label}`);
}

// Whether PostgreSQL itself reports this backend blocked on a lock. The pool has
// spare connections: the two transactions under test hold one each, and this
// query takes a third briefly.
async function backendBlockedOnLock(pid) {
  const row = await queryJson(
    `SELECT jsonb_build_object('blocked', state='active' AND wait_event_type='Lock')::text
     FROM pg_stat_activity WHERE pid=:'pid'::int;`,
    { pid: String(pid) },
  );
  return row?.blocked === true;
}

test.before(async () => {
  if (skip) return;
  scratch = `infra_cod_fence_${randomUUID().slice(0, 8).replace(/-/g, "")}`;
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

  // `db.mjs` reads this when it first opens a pool, so it has to be set before
  // any query in this file.
  process.env.DATABASE_URL = url;

  const boot = await queryJson(
    `SELECT bootstrap_local_owner(:'username', :'password_hash', 'Owner')::text;`,
    { username: "admin-fence", password_hash: HASH_A },
  );
  owner = boot.user_id;
});

test.after(async () => {
  if (skip) return;
  await closePool();
  spawnSync(psqlBin, ["-X", "-qAt", adminUrl("postgres")], {
    encoding: "utf8", input: `DROP DATABASE IF EXISTS ${scratch} WITH (FORCE);`,
  });
});

test("a login that loses the race to a reset is refused", { skip }, async () => {
  // The deterministic direction: the reset commits first, so the hash the login
  // verified no longer exists.
  await queryJson(`SELECT set_user_password(:'user_id'::uuid, :'hash', true, NULL)::text;`,
    { user_id: owner, hash: HASH_A });
  const { attemptId, ip } = await reserveAttempt("admin-fence");

  await queryJson(`SELECT set_user_password(:'user_id'::uuid, :'hash', true, NULL)::text;`,
    { user_id: owner, hash: HASH_B });

  const result = await queryJson(COMPLETE_SQL, loginArguments({
    attemptId, ip, expectedUsername: "admin-fence", expectedHash: HASH_A, tokenByte: 11,
  }));

  assert.equal(result.completed, false, "a session was issued for a superseded password");
  assert.equal(result.reason, "password_changed");
  assert.equal(psql("SELECT count(*) FROM control_plane.web_sessions;"), "0");
  // Fail-closed: the reservation is spent, not silently reusable.
  assert.equal(psql(`SELECT outcome FROM control_plane.auth_attempts WHERE id=${attemptId};`), "pending");
});

test("a login that loses the race to a rename is refused", { skip }, async () => {
  await queryJson(`SELECT set_user_password(:'user_id'::uuid, :'hash', true, NULL)::text;`,
    { user_id: owner, hash: HASH_A });
  const { attemptId, ip } = await reserveAttempt("admin-fence");
  psql("UPDATE control_plane.users SET username='admin-renamed' WHERE role='owner';");

  const result = await queryJson(COMPLETE_SQL, loginArguments({
    attemptId, ip, expectedUsername: "admin-fence", expectedHash: HASH_A, tokenByte: 12,
  }));
  assert.equal(result.completed, false, "a session was issued for a superseded username");
  assert.ok(["username_changed", "unknown_user"].includes(result.reason), result.reason);
  psql("UPDATE control_plane.users SET username='admin-fence' WHERE role='owner';");
});

test("a reset that loses the race still ends the session the login created", { skip }, async () => {
  // The other direction, and the reason the lock has to be on the account row
  // rather than around each statement: the login takes the row first, so the
  // reset waits. It then revokes everything the login just created — which is
  // what makes "reset ends every session" true even against an in-flight login.
  await queryJson(`SELECT set_user_password(:'user_id'::uuid, :'hash', true, NULL)::text;`,
    { user_id: owner, hash: HASH_A });
  psql("DELETE FROM control_plane.web_sessions;");
  const { attemptId, ip } = await reserveAttempt("admin-fence");

  let releaseReset;
  const resetMayStart = new Promise((resolve) => { releaseReset = resolve; });
  let loginTookLock;
  const loginHasLock = new Promise((resolve) => { loginTookLock = resolve; });

  const login = withTransaction(async (client) => {
    const execute = (sql, variables) => queryJsonOn(client, sql, variables);
    // Held for the whole transaction, exactly as complete_local_login holds it.
    // Wrapped in jsonb because the executor parses its result as JSON, and a bare
    // uuid column is not JSON — the strictness is deliberate, it catches this.
    await execute(
      `SELECT jsonb_build_object('id',id)::text FROM control_plane.users
       WHERE id=:'user_id'::uuid FOR UPDATE;`,
      { user_id: owner },
    );
    loginTookLock();
    await resetMayStart;
    return execute(COMPLETE_SQL, loginArguments({
      attemptId, ip, expectedUsername: "admin-fence", expectedHash: HASH_A, tokenByte: 21,
    }));
  });

  const reset = withTransaction(async (client) => {
    const execute = (sql, variables) => queryJsonOn(client, sql, variables);
    const me = await execute(`SELECT jsonb_build_object('pid', pg_backend_pid())::text;`);
    await loginHasLock;
    // Issued while the login holds the row: this blocks until the login commits.
    const pending = execute(
      `SELECT set_user_password(:'user_id'::uuid, :'hash', true, NULL)::text;`,
      { user_id: owner, hash: HASH_B },
    );
    // Readiness comes from the server, not from a stopwatch. A fixed pause here
    // would test statement order on a fast machine and flake on a loaded one;
    // asking pg_stat_activity whether this backend is actually blocked is the
    // difference between proving contention and assuming it.
    await waitUntil(
      () => backendBlockedOnLock(Number(me.pid)),
      "the reset to block on the user-row lock",
    );
    releaseReset();
    return pending;
  });

  const [loginResult] = await Promise.all([login, reset]);

  assert.equal(loginResult.completed, true, "the login lost a race it should have won");
  // The reset ran after it and removed what it created: nothing issued against
  // the old password is still usable.
  assert.equal(
    psql("SELECT count(*) FROM control_plane.web_sessions WHERE revoked_at IS NULL;"),
    "0",
    "a session survived a reset that committed after the login",
  );
  assert.equal(psql("SELECT password_hash FROM control_plane.users WHERE role='owner';"), HASH_B);
});

test("a rehash that loses the compare-and-swap leaves the newer password alone", { skip }, async () => {
  // The review's second reproduction: the login verified HASH_A, a reset installed
  // HASH_B, and the rehash then wrote a fresh encoding of the *old* password.
  await queryJson(`SELECT set_user_password(:'user_id'::uuid, :'hash', true, NULL)::text;`,
    { user_id: owner, hash: HASH_A });
  const before = Number(psql(
    "SELECT count(*) FROM control_plane.audit_events WHERE action='auth.password_rehashed';",
  ));

  await queryJson(`SELECT set_user_password(:'user_id'::uuid, :'hash', true, NULL)::text;`,
    { user_id: owner, hash: HASH_B });

  const stale = await queryJson(
    `SELECT rehash_local_password(:'user_id'::uuid, :'expected_old_hash', :'password_hash')::text;`,
    { user_id: owner, expected_old_hash: HASH_A, password_hash: HASH_B },
  );
  assert.equal(stale.rehashed, false, "a stale rehash overwrote a newer password");
  assert.equal(stale.reason, "hash_changed");
  assert.equal(psql("SELECT password_hash FROM control_plane.users WHERE role='owner';"), HASH_B);
  assert.equal(
    Number(psql("SELECT count(*) FROM control_plane.audit_events WHERE action='auth.password_rehashed';")),
    before,
    "a rehash that did not happen was audited",
  );

  // The swap still wins when nothing moved, so the fence is not just a refusal.
  const applied = await queryJson(
    `SELECT rehash_local_password(:'user_id'::uuid, :'expected_old_hash', :'password_hash')::text;`,
    { user_id: owner, expected_old_hash: HASH_B, password_hash: HASH_A },
  );
  assert.equal(applied.rehashed, true);
  assert.equal(psql("SELECT password_hash FROM control_plane.users WHERE role='owner';"), HASH_A);
  assert.equal(
    Number(psql("SELECT count(*) FROM control_plane.audit_events WHERE action='auth.password_rehashed';")),
    before + 1,
  );
});

test("two concurrent resets cannot both install a session", { skip }, async () => {
  // A last sanity check on the lock: two logins racing each other for one
  // reservation. Only one may resolve it, so only one session can exist.
  await queryJson(`SELECT set_user_password(:'user_id'::uuid, :'hash', true, NULL)::text;`,
    { user_id: owner, hash: HASH_A });
  psql("DELETE FROM control_plane.web_sessions;");
  const { attemptId, ip } = await reserveAttempt("admin-fence");

  const complete = (tokenByte) => queryJson(COMPLETE_SQL, loginArguments({
    attemptId, ip, expectedUsername: "admin-fence", expectedHash: HASH_A, tokenByte,
  }));
  const [first, second] = await Promise.all([complete(31), complete(41)]);

  const completed = [first, second].filter((result) => result.completed === true);
  assert.equal(completed.length, 1, "one reservation was completed twice");
  assert.equal(psql("SELECT count(*) FROM control_plane.web_sessions;"), "1");
});
