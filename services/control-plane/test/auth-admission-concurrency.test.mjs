import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

// begin_auth_attempt admits a login only if it can reserve a slot inside the
// same advisory-locked transaction that reads the failure count. A check that
// merely *read* the count under a lock would serialise nothing, because the
// lock is released when that statement's transaction commits and the password
// verification happens later: N concurrent requests would all see a count below
// the cap and all proceed. This drives real concurrent sessions to prove the
// cap holds. Skipped only when DATABASE_URL or psql is genuinely unavailable.

const databaseUrl = process.env.DATABASE_URL;
const psqlBin = process.env.PSQL_BIN ?? "psql";
let hasPsql = false;
try {
  execFileSync("sh", ["-c", `command -v ${JSON.stringify(psqlBin)}`], { stdio: "ignore" });
  hasPsql = true;
} catch {}

const skip = !databaseUrl ? "DATABASE_URL is not set" : !hasPsql ? "psql is not available" : false;

function runPsql(sql) {
  return new Promise((resolve, reject) => {
    const child = spawn(psqlBin, ["-X", "-qAt", "-v", "ON_ERROR_STOP=1", databaseUrl], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code !== 0) reject(new Error(stderr.trim() || `psql exited ${code}`));
      else resolve(stdout.trim());
    });
    child.stdin.end(sql);
  });
}

test("concurrent login attempts cannot exceed the lockout cap", { skip }, async () => {
  const username = `race-${randomUUID().slice(0, 8)}`;
  const cap = 5;
  const attempts = 20;

  // Each session opens its own transaction, so the advisory lock is contended
  // exactly as it would be under concurrent HTTP requests.
  const sql = `BEGIN;
    SELECT (control_plane.begin_auth_attempt(
      '${username}', sha256('race-ip'::bytea), NULL, interval '15 minutes', ${cap}
    )->>'allowed')::text;
    COMMIT;`;

  const results = await Promise.all(
    Array.from({ length: attempts }, () => runPsql(sql).catch((error) => `ERR:${error.message}`)),
  );

  const admitted = results.filter((line) => line.includes("true")).length;
  const errors = results.filter((line) => line.startsWith("ERR:"));

  assert.deepEqual(errors, [], "no attempt should error");
  assert.equal(
    admitted, cap,
    `expected exactly ${cap} of ${attempts} concurrent attempts to be admitted, got ${admitted}`,
  );

  // Every attempt is recorded either way, so a refusal is not a free probe.
  const recorded = Number(await runPsql(
    `SELECT count(*) FROM control_plane.auth_attempts WHERE username='${username}';`));
  assert.equal(recorded, attempts, "every attempt, admitted or refused, must be recorded");

  await runPsql(`DELETE FROM control_plane.auth_attempts WHERE username='${username}';`);
});

test("concurrent attempts from one address cannot exceed the per-IP cap", { skip }, async () => {
  // The per-IP budget needs its own advisory lock. With only a username lock,
  // requests carrying different usernames never contend, so all of them read
  // the same IP count and all proceed — measured at 20 admitted against a
  // budget of 15 before the second lock was added.
  const ip = `ip-${randomUUID().slice(0, 8)}`;
  const cap = 5;
  const ipBudget = cap * 3;
  const attempts = 20;

  const results = await Promise.all(
    Array.from({ length: attempts }, (_, index) => runPsql(`BEGIN;
      SELECT (control_plane.begin_auth_attempt(
        'ipuser-${index}', sha256('${ip}'::bytea), NULL, interval '15 minutes', ${cap}
      )->>'allowed')::text;
      COMMIT;`).catch((error) => `ERR:${error.message}`)),
  );

  const errors = results.filter((line) => line.startsWith("ERR:"));
  assert.deepEqual(errors, [], "no attempt should error");

  const admitted = results.filter((line) => line.includes("true")).length;
  // Exactly, not at most. A broken lock does not always overshoot — under a
  // narrow race window it can land on the budget by chance — so "<= budget"
  // would let the defect pass.
  assert.equal(
    admitted, ipBudget,
    `expected exactly ${ipBudget} of ${attempts} concurrent attempts from one address to be admitted, got ${admitted}`,
  );

  await runPsql(`DELETE FROM control_plane.auth_attempts WHERE ip_hash=sha256('${ip}'::bytea);`);
});

// Polls until `check` reports true, or fails after `label`-specific timeout.
// Used instead of fixed sleeps: on a loaded machine a timer proves nothing —
// too short and a healthy run fails, too long and a broken lock looks fine
// because the waiter simply had not got there yet.
async function waitUntil(check, label, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function advisoryWaiters() {
  const value = await runPsql(`SELECT count(*) FROM pg_stat_activity
    WHERE datname=current_database()
      AND wait_event_type='Lock' AND wait_event='advisory';`);
  return Number(value);
}

test("an in-flight reservation blocks another username from the same address", { skip }, async () => {
  // The deterministic half of the per-IP guarantee. Rather than counting
  // outcomes under load, this observes the second caller actually waiting on
  // the first one's advisory lock in pg_stat_activity. Without the IP lock it
  // never waits, and the assertion fails immediately rather than by timeout.
  const ip = `hold-${randomUUID().slice(0, 8)}`;

  const holder = spawn(psqlBin, ["-X", "-qAt", "-v", "ON_ERROR_STOP=1", databaseUrl], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  let holderOut = "";
  holder.stdout.on("data", (chunk) => { holderOut += chunk; });
  holder.stderr.resume();

  try {
    // Take the reservation and hold the transaction open. Readiness is read
    // from the sentinel the session prints, not assumed after a delay.
    holder.stdin.write(`BEGIN;
      SELECT control_plane.begin_auth_attempt(
        'holder', sha256('${ip}'::bytea), NULL, interval '15 minutes', 5) IS NOT NULL;
      SELECT 'holder-ready';\n`);
    await waitUntil(async () => holderOut.includes("holder-ready"), "the holder to take its reservation");

    const before = await advisoryWaiters();

    let waiterDone = false;
    const waiter = runPsql(`SELECT control_plane.begin_auth_attempt(
      'waiter', sha256('${ip}'::bytea), NULL, interval '15 minutes', 5) IS NOT NULL;`)
      .then((value) => { waiterDone = true; return value; });

    // The proof: a session is parked on an advisory lock. Without the IP lock
    // the waiter would finish instead, which this catches directly.
    await waitUntil(
      async () => waiterDone || (await advisoryWaiters()) > before,
      "the second username to block on the advisory lock",
    );
    assert.equal(waiterDone, false,
      "a second username from the same address completed instead of waiting on the lock");

    holder.stdin.end("COMMIT;\n");
    await waiter;
    assert.equal(waiterDone, true, "the waiter never completed after the holder committed");
  } finally {
    holder.kill("SIGKILL");
    await runPsql(`DELETE FROM control_plane.auth_attempts WHERE ip_hash=sha256('${ip}'::bytea);`);
  }
});
