// 11.1 acceptance item 3.8: a runtime removed while a job for it is in the
// middle of being dispatched.
//
// "Start a task and remove a runtime version at the same moment. Expect no
// leaked runtime_jobs row and no held workspace lock." On the host that is a
// matter of timing; here it is made deterministic the way the WP-2
// characterisations were: two connections, one holding a row while the other is
// seen by PostgreSQL itself (pg_stat_activity, wait_event_type = 'Lock') to wait
// behind it, never a sleep.
//
// What "removed" is, as the product does it. The database learns what the
// runtimes are from exactly one statement: the health snapshot's upsert of
// `runtime_health` (health-state.mjs), written every minute by the root timer
// from `infra-cod runtime list`'s own readiness. `runtime remove` of the active
// version is refused, so the removals that can meet a dispatch are the two the
// snapshot reports — the runtime no longer provisioned (a tree switched away or
// gone) and its credential revoked (disconnect in the panel). Both are used.
//
// The three points of the dispatch the removal can land on:
//
//   selected  — the job is routed and waiting; nothing is claimed.
//   issued    — the job is claimed, its run started, the workspace lock and the
//               grant held; the launch has not been recorded.
//   launched  — the launch is recorded (WP-9c: selection and dispatch attempt),
//               the process is running and its socket open (WP-9b).
//
// And what must hold after each, the item's own words plus what WP-8a and WP-9
// added since: no runtime_jobs row left pending or in flight, no workspace lock
// held or left for reconciliation, the job ended with a reason from the closed
// vocabulary that the operator is shown, no live grant, and — for the points
// before the launch — no launch recorded at all, so nothing was spawned and no
// socket was opened. The socket of a launched run is removed by the
// supervisor's `finally` (WP-9b, worker-tool-socket.test.mjs); what this file
// shows is that the job the run belonged to does not outlive it.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";

import { closePool, queryJson, queryJsonOn, withTransaction } from "../db.mjs";
import { failureReason } from "../failure.mjs";
import { RUNTIME_HEALTH_UPSERT_SQL } from "../../operations/health-state.mjs";
import { FIXTURE_FUNCTION, READY, snapshotOf } from "./runtime-job-fixture.mjs";
import { driverFor } from "../../runtime-supervisor/drivers/index.mjs";
import { launchProvenance } from "../../runtime-supervisor/provenance.mjs";

const adminDatabaseUrl = process.env.DATABASE_URL;
const psqlBin = process.env.PSQL_BIN ?? "psql";
let hasPsql = false;
try { hasPsql = spawnSync("sh", ["-c", `command -v ${JSON.stringify(psqlBin)}`], { stdio: "ignore" }).status === 0; } catch {}
const skip = !adminDatabaseUrl ? "DATABASE_URL is not set" : !hasPsql ? "psql is not available" : false;

const root = path.resolve(import.meta.dirname, "../../..");
let scratch = "";
let url = "";

function adminUrl(database) {
  const parsed = new URL(adminDatabaseUrl);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

function psql(sql, target = url) {
  const result = spawnSync(psqlBin, ["-X", "-qAt", "-v", "ON_ERROR_STOP=1", target], { encoding: "utf8", input: sql });
  if (result.status !== 0) throw new Error(result.stderr.trim() || `psql exited ${result.status}`);
  return result.stdout.trim();
}

async function waitUntil(check, label, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function blockedOnLock(pid) {
  const row = await queryJson(
    `SELECT jsonb_build_object('blocked', state='active' AND wait_event_type='Lock')::text
     FROM pg_stat_activity WHERE pid=:'pid'::int;`, { pid: String(pid) });
  return row?.blocked === true;
}

// ------------------------------------------------------------------ fixture

async function reportRuntimes(runtimes, execute = queryJson) {
  return execute(RUNTIME_HEALTH_UPSERT_SQL, snapshotOf(runtimes));
}

let counter = 0;
function fixture() {
  counter += 1;
  const tag = `${counter}-${randomUUID().slice(0, 6)}`;
  return { ...JSON.parse(psql(`SELECT race_fixture('${tag}')::text;`)), worker: `race-supervisor-${tag}` };
}

// ------------------------------------------------------------------ the worker's steps

const lease = "1 minute";

async function claim(f) {
  const job = await queryJson(`SELECT to_jsonb(claim_runtime_job_for_event(:'event'::uuid,'implementation_run',:'worker',:'lease'::interval))::text;`,
    { event: f.event, worker: f.worker, lease });
  assert.equal(String(job.id), String(f.job));
  return job;
}

// The run started, the lock and a grant taken: what the executor worker does
// before it asks the supervisor to launch.
async function issue(f) {
  await claim(f);
  const start = await queryJson(`SELECT start_implementation_job(:'job'::bigint,:'session'::uuid,:'worker',:'lease'::interval)::text;`,
    { job: String(f.job), session: f.session, worker: f.worker, lease });
  await queryJson(`SELECT issue_workspace_access_grant(:'job'::bigint,:'worker')::text;`, { job: String(f.job), worker: f.worker });
  return start;
}

const opencode = driverFor("opencode");
const launch = JSON.stringify(launchProvenance(opencode, {
  adapter_version: opencode.verified.adapterVersion, runtime_version: opencode.verified.runtimeVersion,
  verified_runtime_version: opencode.verified.runtimeVersion, status: "verified",
}, { surface: "task" }));

const DISPATCH_SQL = `SELECT record_runtime_dispatch(:'job'::bigint,:'worker',:'launch'::jsonb)::text;`;

// The supervisor's recording of the launch, before its socket and its spawn
// (server.mjs, runFencedBatch). Returns the refusal's reason, or the attempt.
async function dispatch(f, execute = queryJson) {
  try {
    return { attempt: await execute(DISPATCH_SQL, { job: String(f.job), worker: f.worker, launch }) };
  } catch (error) {
    return { refused: failureReason(error) ?? `unclassified: ${error.message}` };
  }
}

// What the worker does with a launch that failed, whichever way it failed: the
// executor's report path, with its production defaults.
async function reportFailure(f, error) {
  return (await queryJson(`SELECT to_jsonb(retry_runtime_job(:'job'::bigint,:'worker',:'error','15 seconds'::interval,3))::text;`,
    { job: String(f.job), worker: f.worker, error }));
}

// ------------------------------------------------------------------ what must hold

async function assertNothingLeaked(f, { reason, launched }) {
  const state = await queryJson(`SELECT jsonb_build_object(
      'open_jobs',(SELECT count(*) FROM runtime_jobs WHERE project_id=:'project'::uuid AND status IN ('pending','in_flight')),
      'job_status',(SELECT status FROM runtime_jobs WHERE id=:'job'::bigint),
      'job_reason',(SELECT failure_reason FROM runtime_jobs WHERE id=:'job'::bigint),
      'reason_known',(SELECT count(*) FROM failure_reasons r JOIN runtime_jobs j ON j.failure_reason=r.reason WHERE j.id=:'job'::bigint),
      'lock',(SELECT status FROM workspace_locks WHERE project_id=:'project'::uuid),
      'live_grants',(SELECT count(*) FROM workspace_access_grants WHERE job_id=:'job'::bigint AND revoked_at IS NULL),
      'active_runs',(SELECT count(*) FROM task_runs WHERE task_id=:'task'::uuid
        AND status IN ('queued','starting','running','waiting_for_input','blocked')),
      'run_failure',(SELECT r.failure_code FROM runtime_jobs j JOIN task_runs r ON r.id=j.run_id WHERE j.id=:'job'::bigint),
      'task',(SELECT status FROM tasks WHERE id=:'task'::uuid),
      'attempts',(SELECT count(*) FROM runtime_dispatch_attempts WHERE job_id=:'job'::bigint),
      'unfinished_attempts',(SELECT count(*) FROM runtime_dispatch_attempts WHERE job_id=:'job'::bigint AND finished_at IS NULL),
      'shown',(SELECT jsonb_build_object('reason',j.failure_reason,'note',r.note) FROM runtime_jobs j
        JOIN failure_reasons r ON r.reason=j.failure_reason WHERE j.id=:'job'::bigint)
    )::text;`, { project: f.project, job: String(f.job), task: f.task });
  assert.equal(state.open_jobs, 0, "a runtime_jobs row was left pending or in flight");
  assert.equal(state.job_status, "dead_letter", "the job did not end");
  assert.equal(state.job_reason, reason, "the job ended without the reason the removal gives");
  assert.equal(state.reason_known, 1, "the reason is not in the closed vocabulary");
  assert.ok(state.lock !== "held" && state.lock !== "reconciliation_required",
    `the workspace lock was left ${state.lock}`);
  assert.equal(state.live_grants, 0, "a workspace grant outlived the job");
  assert.equal(state.active_runs, 0, "a run outlived the job");
  assert.equal(state.run_failure, reason, "the run does not say why it ended");
  assert.equal(state.task, "needs_attention", "the operator is not asked to look at the task");
  assert.equal(state.shown?.reason, reason, "the operator is not shown the reason");
  assert.equal(state.attempts, launched ? 1 : 0, launched
    ? "the launch that ran was not recorded" : "a launch was recorded for a runtime already removed");
  assert.equal(state.unfinished_attempts, 0, "a dispatch attempt was left without its result");
  return state;
}

test.before(async () => {
  if (skip) return;
  scratch = `infra_cod_race_${randomUUID().slice(0, 8)}`;
  psql(`CREATE DATABASE ${scratch};`, adminUrl("postgres"));
  url = adminUrl(scratch);
  const migrate = spawnSync(process.execPath, [path.join(root, "services/control-plane/migrate.mjs")], {
    encoding: "utf8", env: { ...process.env, DATABASE_URL: url },
  });
  if (migrate.status !== 0) throw new Error(`migrate failed: ${migrate.stderr}`);
  process.env.DATABASE_URL = url;
  psql(FIXTURE_FUNCTION);
});

test.after(async () => {
  if (skip) return;
  await closePool();
  spawnSync(psqlBin, ["-X", "-qAt", adminUrl("postgres")], { encoding: "utf8", input: `DROP DATABASE IF EXISTS ${scratch} WITH (FORCE);` });
});

test.beforeEach(async () => {
  if (skip) return;
  await reportRuntimes(READY);
});

// ------------------------------------------------------------------ selected

test("selected: a runtime removed before its job is claimed — the launch is refused, the job ends with the reason", { skip }, async () => {
  const f = fixture();
  await reportRuntimes({ ...READY, opencode: { installed: false, authenticated: false } });
  await issue(f);
  const result = await dispatch(f);
  assert.equal(result.refused, "runtime_not_provisioned", "the launch of a removed runtime was recorded");
  assert.equal(await reportFailure(f, "runtime launch refused: runtime_not_provisioned"), "dead_letter",
    "a job whose runtime is gone was put back to be retried");
  await assertNothingLeaked(f, { reason: "runtime_not_provisioned", launched: false });
});

// ------------------------------------------------------------------ issued

test("issued: the removal commits while the launch waits on it — the launch sees it and is refused", { skip }, async () => {
  const f = fixture();
  await issue(f);
  // The removal, holding the row it wrote: the snapshot is written and not yet
  // committed when the launch asks.
  let commitRemoval;
  const removalHeld = new Promise((resolve) => { commitRemoval = resolve; });
  let removalWritten;
  const written = new Promise((resolve) => { removalWritten = resolve; });
  const removal = withTransaction(async (client) => {
    await reportRuntimes({ ...READY, opencode: { installed: false, authenticated: false } },
      (sql, variables) => queryJsonOn(client, sql, variables));
    removalWritten();
    await removalHeld;
  });
  await written;
  const launching = withTransaction(async (client) => {
    const me = await queryJsonOn(client, `SELECT jsonb_build_object('pid',pg_backend_pid())::text;`);
    const outcome = dispatch(f, (sql, variables) => queryJsonOn(client, sql, variables));
    // The launch reads the runtime's state the way the removal wrote it: it
    // waits for it. Without that wait it reads the snapshot from before the
    // removal and launches a runtime that is gone — what this proves is closed.
    await waitUntil(() => blockedOnLock(me.pid), "the launch to wait on the removal");
    commitRemoval();
    return outcome;
  });
  await removal;
  const result = await launching;
  assert.equal(result.refused, "runtime_not_provisioned", "the launch did not see the removal it waited for");
  assert.equal(await reportFailure(f, "runtime launch refused: runtime_not_provisioned"), "dead_letter");
  await assertNothingLeaked(f, { reason: "runtime_not_provisioned", launched: false });
});

test("issued: the launch commits first — the removal waits for it, and the run that started ends with the reason", { skip }, async () => {
  const f = fixture();
  await issue(f);
  let commitLaunch;
  const launchHeld = new Promise((resolve) => { commitLaunch = resolve; });
  let recorded;
  const launchRecorded = new Promise((resolve) => { recorded = resolve; });
  const launching = withTransaction(async (client) => {
    const outcome = await dispatch(f, (sql, variables) => queryJsonOn(client, sql, variables));
    recorded(outcome);
    await launchHeld;
    return outcome;
  });
  const outcome = await launchRecorded;
  assert.ok(outcome.attempt?.attempt_id, `the launch of a ready runtime was refused: ${outcome.refused}`);
  const removal = withTransaction(async (client) => {
    const me = await queryJsonOn(client, `SELECT jsonb_build_object('pid',pg_backend_pid())::text;`);
    const writing = reportRuntimes({ ...READY, opencode: { installed: false, authenticated: false } },
      (sql, variables) => queryJsonOn(client, sql, variables));
    await waitUntil(() => blockedOnLock(me.pid), "the removal to wait on the launch");
    commitLaunch();
    return writing;
  });
  await launching;
  await removal;
  // The process the launch started finds its tree gone and exits; the
  // supervisor records how, then the worker reports the failure.
  await queryJson(`SELECT finish_runtime_dispatch_attempt(:'attempt'::bigint,:'worker','{"status":"exited","exit_code":127}'::jsonb,'')::text;`,
    { attempt: String(outcome.attempt.attempt_id), worker: f.worker });
  assert.equal(await reportFailure(f, "OpenCode exited with code 127"), "dead_letter");
  await assertNothingLeaked(f, { reason: "runtime_not_provisioned", launched: true });
});

// ------------------------------------------------------------------ launched

test("launched: the credential is revoked under a running process — the job ends as not authenticated", { skip }, async () => {
  const f = fixture();
  await issue(f);
  const outcome = await dispatch(f);
  assert.ok(outcome.attempt?.attempt_id, `the launch was refused: ${outcome.refused}`);
  await reportRuntimes({ ...READY, opencode: { installed: true, authenticated: false } });
  await queryJson(`SELECT finish_runtime_dispatch_attempt(:'attempt'::bigint,:'worker','{"status":"exited","exit_code":1}'::jsonb,'')::text;`,
    { attempt: String(outcome.attempt.attempt_id), worker: f.worker });
  assert.equal(await reportFailure(f, "OpenCode exited with code 1"), "dead_letter",
    "a job whose runtime lost its credential was put back to be retried against it");
  await assertNothingLeaked(f, { reason: "runtime_not_authenticated", launched: true });
});

test("launched, before the snapshot catches up: the retries run out and still leave nothing held", { skip }, async () => {
  // The timer writes once a minute; a runtime removed between two snapshots is
  // retried as a transient failure. When the retries run out the job must end
  // the same way — not with its run running and the lock held until the lease
  // expires into reconciliation_required, which is what P-3 found an exhausted
  // retry did.
  const f = fixture();
  let status;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    if (attempt === 1) await issue(f);
    else {
      await queryJson(`UPDATE runtime_jobs SET available_at=clock_timestamp() WHERE id=:'job'::bigint RETURNING jsonb_build_object('id',id)::text;`, { job: String(f.job) });
      await claim(f);
      await queryJson(`SELECT start_implementation_job(:'job'::bigint,:'session'::uuid,:'worker',:'lease'::interval)::text;`,
        { job: String(f.job), session: f.session, worker: f.worker, lease });
      await queryJson(`SELECT issue_workspace_access_grant(:'job'::bigint,:'worker')::text;`, { job: String(f.job), worker: f.worker });
    }
    const outcome = await dispatch(f);
    assert.ok(outcome.attempt?.attempt_id, `attempt ${attempt} was refused: ${outcome.refused}`);
    await queryJson(`SELECT finish_runtime_dispatch_attempt(:'attempt'::bigint,:'worker','{"status":"exited","exit_code":127}'::jsonb,'')::text;`,
      { attempt: String(outcome.attempt.attempt_id), worker: f.worker });
    status = await reportFailure(f, "OpenCode exited with code 127");
    assert.equal(status, attempt < 3 ? "pending" : "dead_letter");
  }
  const state = await assertNothingLeaked(f, { reason: "runtime_attempts_exhausted", launched: true }).catch((error) => {
    // Three launches were recorded, not one; everything else is the same claim.
    if (/launch that ran was not recorded/.test(error.message)) return null;
    throw error;
  });
  if (state === null) {
    const attempts = await queryJson(`SELECT jsonb_build_object('n',count(*))::text FROM runtime_dispatch_attempts WHERE job_id=:'job'::bigint;`, { job: String(f.job) });
    assert.equal(attempts.n, 3);
  }
});

// ------------------------------------------------------------------ a lease already gone

test("reclaimed after its lease ran out: the job still ends, and the lock is left for reconciliation, not held", { skip }, async () => {
  // Found on the stand: a job reclaimed after its worker died carries its old
  // run, whose lock lease has expired. Ending it must not raise — a retry that
  // raises leaves the job in flight to be reclaimed and fail again — and must
  // not release a lock whose holder may still be writing: it is left the way
  // the reconciler leaves an expired lease, for the operator to recover.
  const f = fixture();
  await issue(f);
  await queryJson(`UPDATE workspace_locks SET lease_expires_at=clock_timestamp()-interval '1 second'
    WHERE project_id=:'project'::uuid RETURNING jsonb_build_object('s',status)::text;`, { project: f.project });
  await reportRuntimes({ ...READY, opencode: { installed: false, authenticated: false } });
  assert.equal(await reportFailure(f, "the workspace lease expired"), "dead_letter");
  const state = await queryJson(`SELECT jsonb_build_object('job',j.status,'reason',j.failure_reason,'run',r.status,
      'code',r.failure_code,'lock',l.status,'owner',l.owner_run_id)::text
    FROM runtime_jobs j JOIN task_runs r ON r.id=j.run_id JOIN workspace_locks l ON l.project_id=j.project_id
    WHERE j.id=:'job'::bigint;`, { job: String(f.job) });
  assert.deepEqual(state, { job: "dead_letter", reason: "runtime_not_provisioned", run: "lost",
    code: "workspace_lease_expired", lock: "reconciliation_required", owner: null });
  // And the reconciler, which would have met a failed run it cannot mark lost,
  // has nothing left to trip on.
  await queryJson(`SELECT to_jsonb(reconcile_expired_workspace_locks('race-reconciler',10))::text;`);
});

// ------------------------------------------------------------------ an orchestrator turn

test("a Codex turn whose runtime is removed ends with the reason and does not hold its conversation", { skip }, async () => {
  const f = fixture();
  // Retire the delegation so the conversation's next message is the only job.
  await queryJson(`UPDATE runtime_jobs SET status='completed',completed_at=clock_timestamp() WHERE id=:'job'::bigint RETURNING jsonb_build_object('id',id)::text;`, { job: String(f.job) });
  // `SELECT * FROM f()`, not `(f()).*`, which calls f once per column.
  const message = (key) => queryJson(`WITH e AS (SELECT * FROM append_event('chat.user_message',:'project'::uuid,:'task'::uuid,NULL,'user','operator',
      NULL,:'key',:'key','task',:'task'::uuid,
      (SELECT COALESCE(max(aggregate_version),0)+1 FROM domain_events WHERE aggregate_type='task' AND aggregate_id=:'task'::uuid),'{}'::jsonb))
    INSERT INTO runtime_jobs(source_event_id,job_type,project_id,task_id,payload)
    SELECT e.id,'orchestrator_turn',:'project'::uuid,:'task'::uuid,'{}' FROM e
    RETURNING jsonb_build_object('job',id,'event',source_event_id)::text;`, { project: f.project, task: f.task, key: `turn-${randomUUID()}` });
  const turn = await message();
  await reportRuntimes({ ...READY, codex: { installed: true, authenticated: false } });
  const claimed = await queryJson(`SELECT to_jsonb(claim_runtime_job_for_event(:'event'::uuid,'orchestrator_turn',:'worker','1 minute'::interval))::text;`,
    { event: turn.event, worker: f.worker });
  assert.ok(claimed.run_id, "the turn was claimed without its run");
  await queryJson(`SELECT issue_workspace_access_grant(:'job'::bigint,:'worker')::text;`, { job: String(turn.job), worker: f.worker });
  const codex = driverFor("codex");
  const codexLaunch = JSON.stringify(launchProvenance(codex, {
    adapter_version: codex.verified.adapterVersion, runtime_version: codex.verified.runtimeVersion,
    verified_runtime_version: codex.verified.runtimeVersion, status: "verified" }, { surface: "chat" }));
  let refused;
  try {
    await queryJson(DISPATCH_SQL, { job: String(turn.job), worker: f.worker, launch: codexLaunch });
  } catch (error) { refused = failureReason(error); }
  assert.equal(refused, "runtime_not_authenticated", "a turn was launched on a runtime without its credential");
  assert.equal(await queryJson(`SELECT to_jsonb(retry_runtime_job(:'job'::bigint,:'worker','refused','5 seconds'::interval,5))::text;`,
    { job: String(turn.job), worker: f.worker }), "dead_letter");
  const state = await queryJson(`SELECT jsonb_build_object('reason',j.failure_reason,'run',r.status,'code',r.failure_code)::text
    FROM runtime_jobs j JOIN task_runs r ON r.id=j.run_id WHERE j.id=:'job'::bigint;`, { job: String(turn.job) });
  assert.deepEqual(state, { reason: "runtime_not_authenticated", run: "failed", code: "turn_dead_lettered" });
  // The conversation is not held by it: the operator's next message is
  // claimable (0070: a dead letter is the operator's, not the queue's).
  await reportRuntimes(READY);
  const next = await message();
  const blocker = await queryJson(`SELECT jsonb_build_object('b',ingress_blocker(:'job'::bigint))::text;`, { job: String(next.job) });
  assert.equal(blocker.b, null, "the dead-lettered turn holds the conversation");
});

// ------------------------------------------------------------------ mutations
//
// Each protection above, switched off in this scratch database, and the
// scenario it guards shown to break — so it is that protection holding the
// result up, not the order the statements happened to run in.

async function withMutation(name, from, to, body) {
  const definition = await queryJson(`SELECT to_jsonb(pg_get_functiondef(p.oid))::text FROM pg_proc p
    WHERE p.proname=:'name' AND p.pronamespace='control_plane'::regnamespace;`, { name });
  assert.ok(definition.includes(from), `${name} no longer contains the line this mutation removes`);
  psql(definition.replace(from, to));
  try { return await body(); } finally { psql(definition); }
}

test("mutation: without the share lock a launch does not wait for the removal, and launches a runtime that is gone", { skip }, async () => {
  // 0088: the lock moved into runtime_health_reading, the reading
  // runtime_undispatchable_reason and project_readiness share.
  await withMutation("runtime_health_reading", "WHERE h.singleton FOR SHARE;", "WHERE h.singleton;", async () => {
    const f = fixture();
    await issue(f);
    let commitRemoval;
    const removalHeld = new Promise((resolve) => { commitRemoval = resolve; });
    let removalWritten;
    const written = new Promise((resolve) => { removalWritten = resolve; });
    const removal = withTransaction(async (client) => {
      await reportRuntimes({ ...READY, opencode: { installed: false, authenticated: false } },
        (sql, variables) => queryJsonOn(client, sql, variables));
      removalWritten();
      await removalHeld;
    });
    await written;
    // Resolves while the removal is still uncommitted: nothing made it wait.
    const outcome = await dispatch(f);
    commitRemoval();
    await removal;
    assert.ok(outcome.attempt?.attempt_id, "the launch was refused even without the lock — the test no longer shows what the lock does");
  });
});

test("mutation: without the gate in record_runtime_dispatch a removed runtime is launched", { skip }, async () => {
  await withMutation("record_runtime_dispatch", "v_blocked:=runtime_undispatchable_reason(v_runtime);", "v_blocked:=NULL;", async () => {
    const f = fixture();
    await reportRuntimes({ ...READY, opencode: { installed: false, authenticated: false } });
    await issue(f);
    const outcome = await dispatch(f);
    assert.ok(outcome.attempt?.attempt_id, `the launch was refused without the gate: ${outcome.refused}`);
  });
});

test("mutation: an ended job that does not release the lock leaves it held", { skip }, async () => {
  await withMutation("end_runtime_job",
    "PERFORM release_workspace_lock(v_job.project_id,v_run.id,v_lock.fencing_token);", "NULL;",
    async () => {
      const f = fixture();
      await reportRuntimes({ ...READY, opencode: { installed: false, authenticated: false } });
      await issue(f);
      await dispatch(f);
      assert.equal(await reportFailure(f, "refused"), "dead_letter");
      await assert.rejects(assertNothingLeaked(f, { reason: "runtime_not_provisioned", launched: false }),
        /workspace lock was left held/);
    });
});
