// Sprint B A4 (0084): a model's connection revoked while a job for it is on its
// way to a runtime.
//
// The task's snapshot fixes the model and the connection it is reached
// through. The operator can take that connection away at any moment — the
// panel's disconnect, a key that expires, a connection that needs action —
// and the job must then end, with the reason, holding nothing. The two
// windows the plan names:
//
//   render → claim   — the job is routed and waiting; the panel showed the
//                      model as usable. The revocation lands before or while
//                      the worker claims it.
//   claim  → launch  — the job is claimed, its run started, the workspace lock
//                      and the grant held; the launch has not been recorded.
//
// Each in both orders, made deterministic as in runtime-removal-race.test.mjs:
// one transaction holds its write while PostgreSQL itself shows the other
// waiting behind it (pg_stat_activity), never a sleep. What must hold after
// each: no job pending or in flight, no lock held or left for reconciliation,
// no live grant, the job ended as model_access_revoked, which the operator is
// shown, and nothing launched unless the launch came first.
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

// The fixtures are created where the race fixture is (public); the product's
// tables are named as the product's functions name them.
function psql(sql, target = url) {
  const input = `SET search_path TO control_plane, public, extensions;\n${sql}`;
  const result = spawnSync(psqlBin, ["-X", "-qAt", "-v", "ON_ERROR_STOP=1", target], { encoding: "utf8", input });
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

// The race fixture's project, with what 0028 and 0083 add in production: a
// Codex connection the orchestrator's model is reached through, an OpenRouter
// connection the executor's is, a verified catalog entry on each, and the
// task's snapshot naming both.
const SNAPSHOT_FIXTURE = `
CREATE FUNCTION access_fixture(p_tag text) RETURNS jsonb LANGUAGE plpgsql
SET search_path=control_plane,public,extensions AS $$
DECLARE f jsonb; v_owner uuid; v_codex uuid; v_router uuid; v_codex_entry uuid; v_router_entry uuid; v_executor uuid;
BEGIN
  f:=race_fixture(p_tag);
  SELECT owner_id INTO v_owner FROM projects WHERE id=(f->>'project')::uuid;
  INSERT INTO provider_connections(operator_id,provider,auth_method,status,billing_boundary,access_gateway,native_credential_reference)
    VALUES(v_owner,'codex','device_code','connected','subscription','openai_chatgpt','codex-home:codex-worker') RETURNING id INTO v_codex;
  INSERT INTO provider_connections(operator_id,provider,auth_method,status,billing_boundary,access_gateway,native_credential_reference)
    VALUES(v_owner,'opencode','api_key','connected','third_party_metered','openrouter','opencode-home:opencode-worker') RETURNING id INTO v_router;
  INSERT INTO provider_model_catalog(operator_id,connection_id,billing_boundary,runtime_type,provider_id,model_id,display_name,
      capabilities,adapter_version,runtime_version,discovery_source,status,last_verified_at,verification_id)
    VALUES(v_owner,v_codex,'subscription','codex','openai','gpt-access-'||p_tag,'Access','{"streaming":true}','t','t',
      'codex_model_list','verified',clock_timestamp(),gen_random_uuid()) RETURNING id INTO v_codex_entry;
  INSERT INTO provider_model_catalog(operator_id,connection_id,billing_boundary,runtime_type,provider_id,model_id,display_name,
      capabilities,adapter_version,runtime_version,discovery_source,status,last_verified_at,verification_id)
    VALUES(v_owner,v_router,'third_party_metered','opencode','openrouter','openai/access-'||p_tag,'Access','{"streaming":true}','t','t',
      'opencode_provider_api','verified',clock_timestamp(),gen_random_uuid()) RETURNING id INTO v_router_entry;
  SELECT h.executor_assignment_id INTO v_executor FROM runtime_jobs j
    JOIN domain_events e ON e.id=j.source_event_id JOIN handoffs h ON h.id=(e.payload->>'handoff_id')::uuid
    WHERE j.id=(f->>'job')::bigint;
  INSERT INTO task_runtime_snapshots(task_id,orchestrator,executors,source)
    VALUES((f->>'task')::uuid,resolve_catalog_snapshot_entry(v_codex_entry),
      jsonb_build_array(resolve_catalog_snapshot_entry(v_router_entry)
        || jsonb_build_object('assignment_ids',jsonb_build_array(v_executor::text))),'catalog');
  RETURN f || jsonb_build_object('owner',v_owner,'codex_connection',v_codex,'router_connection',v_router);
END $$;`;

let counter = 0;
function fixture() {
  counter += 1;
  const tag = `${counter}-${randomUUID().slice(0, 6)}`;
  return { ...JSON.parse(psql(`SELECT access_fixture('${tag}')::text;`)), worker: `access-worker-${tag}` };
}

// ------------------------------------------------------------------ the operator's and the worker's steps

const lease = "1 minute";

// The panel's disconnect: the operator's request, which is the revocation —
// the broker carries it out later, and the decision is made when it is asked.
const REVOKE_SQL = `SELECT request_opencode_connection_action(:'connection'::uuid,:'owner'::uuid,'disconnect',NULL)::text;`;
async function revoke(f, execute = queryJson) {
  return execute(REVOKE_SQL, { connection: f.router_connection, owner: f.owner });
}

// The executor worker's claim, as it polls: every implementation job it may take.
const CLAIM_SQL = `SELECT COALESCE(jsonb_agg(j.id),'[]')::text FROM claim_executor_jobs(:'worker',10,:'lease'::interval) j;`;
async function claim(f, execute = queryJson) {
  return (await execute(CLAIM_SQL, { worker: f.worker, lease })).map(String);
}

// What the executor worker does with a claimed job before it asks the
// supervisor to launch: the run started, the lock and a grant taken.
async function start(f) {
  await queryJson(`SELECT start_implementation_job(:'job'::bigint,:'session'::uuid,:'worker',:'lease'::interval)::text;`,
    { job: String(f.job), session: f.session, worker: f.worker, lease });
  await queryJson(`SELECT issue_workspace_access_grant(:'job'::bigint,:'worker')::text;`, { job: String(f.job), worker: f.worker });
}

const opencode = driverFor("opencode");
const launch = JSON.stringify(launchProvenance(opencode, {
  adapter_version: opencode.verified.adapterVersion, runtime_version: opencode.verified.runtimeVersion,
  verified_runtime_version: opencode.verified.runtimeVersion, status: "verified",
}, { surface: "task" }));
const DISPATCH_SQL = `SELECT record_runtime_dispatch(:'job'::bigint,:'worker',:'launch'::jsonb)::text;`;

async function dispatch(f, execute = queryJson) {
  try {
    return { attempt: await execute(DISPATCH_SQL, { job: String(f.job), worker: f.worker, launch }) };
  } catch (error) {
    return { refused: failureReason(error) ?? `unclassified: ${error.message}` };
  }
}

async function reportFailure(f, error) {
  return queryJson(`SELECT to_jsonb(retry_runtime_job(:'job'::bigint,:'worker',:'error','15 seconds'::interval,3))::text;`,
    { job: String(f.job), worker: f.worker, error });
}

// ------------------------------------------------------------------ what must hold

async function assertEndedClean(f, { launched, runStarted }) {
  const state = await queryJson(`SELECT jsonb_build_object(
      'open_jobs',(SELECT count(*) FROM runtime_jobs WHERE project_id=:'project'::uuid AND status IN ('pending','in_flight')),
      'job_status',(SELECT status FROM runtime_jobs WHERE id=:'job'::bigint),
      'job_reason',(SELECT failure_reason FROM runtime_jobs WHERE id=:'job'::bigint),
      'lock',(SELECT status FROM workspace_locks WHERE project_id=:'project'::uuid),
      'live_grants',(SELECT count(*) FROM workspace_access_grants WHERE job_id=:'job'::bigint AND revoked_at IS NULL),
      'active_runs',(SELECT count(*) FROM task_runs WHERE task_id=:'task'::uuid
        AND status IN ('queued','starting','running','waiting_for_input','blocked')),
      'run_failure',(SELECT r.failure_code FROM runtime_jobs j JOIN task_runs r ON r.id=j.run_id WHERE j.id=:'job'::bigint),
      'task',(SELECT status FROM tasks WHERE id=:'task'::uuid),
      'attempts',(SELECT count(*) FROM runtime_dispatch_attempts WHERE job_id=:'job'::bigint),
      'unfinished_attempts',(SELECT count(*) FROM runtime_dispatch_attempts WHERE job_id=:'job'::bigint AND finished_at IS NULL),
      'said',(SELECT e.payload->>'message' FROM domain_events e WHERE e.task_id=:'task'::uuid
        AND e.event_type='runtime_job.dead_lettered' ORDER BY e.occurred_at DESC LIMIT 1)
    )::text;`, { project: f.project, job: String(f.job), task: f.task });
  assert.equal(state.open_jobs, 0, "a runtime_jobs row was left pending or in flight");
  assert.equal(state.job_status, "dead_letter", "the job did not end");
  assert.equal(state.job_reason, "model_access_revoked", "the job ended without the revocation's reason");
  assert.ok(state.lock !== "held" && state.lock !== "reconciliation_required", `the workspace lock was left ${state.lock}`);
  assert.equal(state.live_grants, 0, "a workspace grant outlived the job");
  assert.equal(state.active_runs, 0, "a run outlived the job");
  if (runStarted) assert.equal(state.run_failure, "model_access_revoked", "the run does not say why it ended");
  assert.equal(state.task, "needs_attention", "the operator is not asked to look at the task");
  assert.match(state.said ?? "", /disconnected, expired or needs action/, "the task's conversation does not say why the work stopped");
  assert.equal(state.attempts, launched ? 1 : 0,
    launched ? "the launch that ran was not recorded" : "a launch was recorded against a revoked connection");
  assert.equal(state.unfinished_attempts, 0, "a dispatch attempt was left without its result");
  return state;
}

test.before(async () => {
  if (skip) return;
  scratch = `infra_cod_access_${randomUUID().slice(0, 8)}`;
  psql(`CREATE DATABASE ${scratch};`, adminUrl("postgres"));
  url = adminUrl(scratch);
  const migrate = spawnSync(process.execPath, [path.join(root, "services/control-plane/migrate.mjs")], {
    encoding: "utf8", env: { ...process.env, DATABASE_URL: url },
  });
  if (migrate.status !== 0) throw new Error(`migrate failed: ${migrate.stderr}`);
  process.env.DATABASE_URL = url;
  psql(FIXTURE_FUNCTION);
  psql(SNAPSHOT_FIXTURE);
});

test.after(async () => {
  if (skip) return;
  await closePool();
  spawnSync(psqlBin, ["-X", "-qAt", adminUrl("postgres")], { encoding: "utf8", input: `DROP DATABASE IF EXISTS ${scratch} WITH (FORCE);` });
});

test.beforeEach(async () => {
  if (skip) return;
  await queryJson(RUNTIME_HEALTH_UPSERT_SQL, snapshotOf(READY));
  // The claims take any job that is due; each test starts from a queue holding
  // only its own.
  psql(`UPDATE runtime_jobs SET status='completed',completed_at=clock_timestamp(),leased_by=NULL,leased_until=NULL
        WHERE status IN ('pending','in_flight');`);
});

// ------------------------------------------------------------------ render → claim

test("render → claim: revoked before the claim — the job is ended in the claim and never handed out", { skip }, async () => {
  const f = fixture();
  await revoke(f);
  assert.deepEqual(await claim(f), [], "a job whose connection was revoked was handed to the worker");
  await assertEndedClean(f, { launched: false, runStarted: false });
});

test("render → claim: the revocation commits while the claim waits on it — the claim sees it", { skip }, async () => {
  const f = fixture();
  let commitRevocation;
  const revocationHeld = new Promise((resolve) => { commitRevocation = resolve; });
  let written;
  const revocationWritten = new Promise((resolve) => { written = resolve; });
  const revocation = withTransaction(async (client) => {
    await revoke(f, (sql, variables) => queryJsonOn(client, sql, variables));
    written();
    await revocationHeld;
  });
  await revocationWritten;
  const claiming = withTransaction(async (client) => {
    const me = await queryJsonOn(client, `SELECT jsonb_build_object('pid',pg_backend_pid())::text;`);
    const outcome = claim(f, (sql, variables) => queryJsonOn(client, sql, variables));
    // Without the share lock the claim reads the connection from before the
    // revocation and hands the job out: what this proves is closed.
    await waitUntil(() => blockedOnLock(me.pid), "the claim to wait on the revocation");
    commitRevocation();
    return outcome;
  });
  await revocation;
  assert.deepEqual(await claiming, [], "the claim did not see the revocation it waited for");
  await assertEndedClean(f, { launched: false, runStarted: false });
});

test("render → claim: the claim commits first — the revocation waits for it, and the launch is refused", { skip }, async () => {
  const f = fixture();
  let commitClaim;
  const claimHeld = new Promise((resolve) => { commitClaim = resolve; });
  let claimedNow;
  const claimed = new Promise((resolve) => { claimedNow = resolve; });
  const claiming = withTransaction(async (client) => {
    const outcome = await claim(f, (sql, variables) => queryJsonOn(client, sql, variables));
    claimedNow(outcome);
    await claimHeld;
    return outcome;
  });
  assert.deepEqual(await claimed, [String(f.job)], "a job with a live connection was not claimed");
  const revocation = withTransaction(async (client) => {
    const me = await queryJsonOn(client, `SELECT jsonb_build_object('pid',pg_backend_pid())::text;`);
    const writing = revoke(f, (sql, variables) => queryJsonOn(client, sql, variables));
    await waitUntil(() => blockedOnLock(me.pid), "the revocation to wait on the claim");
    commitClaim();
    return writing;
  });
  await claiming;
  await revocation;
  await start(f);
  const outcome = await dispatch(f);
  assert.equal(outcome.refused, "model_access_revoked", "a claimed job was launched after its connection was revoked");
  assert.equal(await reportFailure(f, "runtime launch refused: model_access_revoked"), "dead_letter",
    "a job whose connection is revoked was put back to be retried");
  await assertEndedClean(f, { launched: false, runStarted: true });
});

// ------------------------------------------------------------------ claim → launch

test("claim → launch: the revocation commits while the launch waits on it — the launch is refused", { skip }, async () => {
  const f = fixture();
  assert.deepEqual(await claim(f), [String(f.job)]);
  await start(f);
  let commitRevocation;
  const revocationHeld = new Promise((resolve) => { commitRevocation = resolve; });
  let written;
  const revocationWritten = new Promise((resolve) => { written = resolve; });
  const revocation = withTransaction(async (client) => {
    await revoke(f, (sql, variables) => queryJsonOn(client, sql, variables));
    written();
    await revocationHeld;
  });
  await revocationWritten;
  const launching = withTransaction(async (client) => {
    const me = await queryJsonOn(client, `SELECT jsonb_build_object('pid',pg_backend_pid())::text;`);
    const outcome = dispatch(f, (sql, variables) => queryJsonOn(client, sql, variables));
    await waitUntil(() => blockedOnLock(me.pid), "the launch to wait on the revocation");
    commitRevocation();
    return outcome;
  });
  await revocation;
  const outcome = await launching;
  assert.equal(outcome.refused, "model_access_revoked", "the launch did not see the revocation it waited for");
  assert.equal(await reportFailure(f, "runtime launch refused: model_access_revoked"), "dead_letter");
  await assertEndedClean(f, { launched: false, runStarted: true });
});

test("claim → launch: the launch commits first — the revocation waits, and the run that started ends with the reason", { skip }, async () => {
  const f = fixture();
  assert.deepEqual(await claim(f), [String(f.job)]);
  await start(f);
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
  assert.ok(outcome.attempt?.attempt_id, `the launch on a live connection was refused: ${outcome.refused}`);
  const revocation = withTransaction(async (client) => {
    const me = await queryJsonOn(client, `SELECT jsonb_build_object('pid',pg_backend_pid())::text;`);
    const writing = revoke(f, (sql, variables) => queryJsonOn(client, sql, variables));
    await waitUntil(() => blockedOnLock(me.pid), "the revocation to wait on the launch");
    commitLaunch();
    return writing;
  });
  await launching;
  await revocation;
  // The running process loses its credential and fails; the supervisor
  // records how, the worker reports it — and it is not retried.
  await queryJson(`SELECT finish_runtime_dispatch_attempt(:'attempt'::bigint,:'worker','{"status":"exited","exit_code":1}'::jsonb,'')::text;`,
    { attempt: String(outcome.attempt.attempt_id), worker: f.worker });
  assert.equal(await reportFailure(f, "OpenCode exited with code 1"), "dead_letter",
    "a job whose connection was revoked under it was put back to be retried against it");
  await assertEndedClean(f, { launched: true, runStarted: true });
});

// ------------------------------------------------------------------ the other ways a connection goes

test("an expired connection, and one that needs action, are revoked as a disconnected one is", { skip }, async () => {
  for (const status of ["expired", "action_required"]) {
    const f = fixture();
    psql(`UPDATE provider_connections SET status='${status}' WHERE id='${f.router_connection}';`);
    assert.deepEqual(await claim(f), [], `a job whose connection is ${status} was handed out`);
    await assertEndedClean(f, { launched: false, runStarted: false });
  }
});

test("a live connection is not touched, and a task without a catalog snapshot is not asked", { skip }, async () => {
  const live = fixture();
  assert.deepEqual(await claim(live), [String(live.job)]);
  psql(`UPDATE runtime_jobs SET status='completed',completed_at=clock_timestamp(),leased_by=NULL,leased_until=NULL WHERE id=${live.job};`);
  const legacy = fixture();
  psql(`DELETE FROM task_runtime_snapshots WHERE task_id='${legacy.task}';
        UPDATE provider_connections SET status='disconnected' WHERE id='${legacy.router_connection}';`);
  assert.deepEqual(await claim(legacy), [String(legacy.job)], "a job naming no connection was ended by one it does not use");
});

// ------------------------------------------------------------------ an orchestrator turn, and a review

async function routedTurn(f, jobType) {
  const eventType = jobType === "resume_orchestrator" ? "implementation.completed" : "chat.user_message";
  return queryJson(`WITH e AS (SELECT * FROM append_event(:'event_type',:'project'::uuid,:'task'::uuid,NULL,'user','operator',
      NULL,:'key',:'key','task',:'task'::uuid,
      (SELECT COALESCE(max(aggregate_version),0)+1 FROM domain_events WHERE aggregate_type='task' AND aggregate_id=:'task'::uuid),'{}'::jsonb))
    INSERT INTO runtime_jobs(source_event_id,job_type,project_id,task_id,payload)
    SELECT e.id,:'job_type',:'project'::uuid,:'task'::uuid,'{}' FROM e
    RETURNING jsonb_build_object('job',id,'event',source_event_id)::text;`,
  { event_type: eventType, job_type: jobType, project: f.project, task: f.task, key: `turn-${randomUUID()}` });
}

test("a turn whose orchestrator's connection is revoked ends in the claim, closes its run and does not hold the conversation", { skip }, async () => {
  const f = fixture();
  psql(`UPDATE runtime_jobs SET status='completed',completed_at=clock_timestamp() WHERE id=${f.job};
        UPDATE provider_connections SET status='disconnected' WHERE id='${f.codex_connection}';`);
  const turn = await routedTurn(f, "orchestrator_turn");
  const claimed = await queryJson(`SELECT COALESCE(jsonb_agg(j.id),'[]')::text FROM claim_orchestrator_jobs(:'worker',10,'1 minute'::interval) j;`,
    { worker: f.worker });
  assert.deepEqual(claimed, [], "a turn on a revoked connection was handed to the worker");
  const state = await queryJson(`SELECT jsonb_build_object('status',j.status,'reason',j.failure_reason,'run',r.status,'code',r.failure_code)::text
    FROM runtime_jobs j JOIN task_runs r ON r.id=j.run_id WHERE j.id=:'job'::bigint;`, { job: String(turn.job) });
  assert.deepEqual(state, { status: "dead_letter", reason: "model_access_revoked", run: "failed", code: "turn_dead_lettered" });
  psql(`UPDATE provider_connections SET status='connected' WHERE id='${f.codex_connection}';`);
  const next = await routedTurn(f, "orchestrator_turn");
  const blocker = await queryJson(`SELECT jsonb_build_object('b',ingress_blocker(:'job'::bigint))::text;`, { job: String(next.job) });
  assert.equal(blocker.b, null, "the dead-lettered turn holds the conversation");
});

test("a review ended at the claim can be retried once the connection is back, and not before", { skip }, async () => {
  const f = fixture();
  psql(`UPDATE runtime_jobs SET status='completed',completed_at=clock_timestamp() WHERE id=${f.job};
        UPDATE tasks SET status='awaiting_review',version=version+1 WHERE id='${f.task}';
        UPDATE provider_connections SET status='expired' WHERE id='${f.codex_connection}';`);
  const review = await routedTurn(f, "resume_orchestrator");
  await queryJson(`SELECT COALESCE(jsonb_agg(j.id),'[]')::text FROM claim_orchestrator_jobs(:'worker',10,'1 minute'::interval) j;`,
    { worker: f.worker });
  const ended = await queryJson(`SELECT jsonb_build_object('status',j.status,'reason',j.failure_reason,'attempt',j.attempt_count,'task',t.status)::text
    FROM runtime_jobs j JOIN tasks t ON t.id=j.task_id WHERE j.id=:'job'::bigint;`, { job: String(review.job) });
  assert.equal(ended.status, "dead_letter");
  assert.equal(ended.reason, "model_access_revoked");
  // Where a retry expects a review to be: the claim moved it before ending it.
  assert.equal(ended.task, "reviewing");
  const retry = () => queryJson(`SELECT retry_dead_letter_job(:'job'::bigint,:'attempt'::integer,:'owner'::uuid,'operator','reconnected','access-retry')::text;`,
    { job: String(review.job), attempt: String(ended.attempt), owner: f.owner });
  await assert.rejects(retry(), (error) => failureReason(error) === "model_access_revoked",
    "a retry was accepted while the connection was still revoked");
  psql(`UPDATE provider_connections SET status='connected' WHERE id='${f.codex_connection}';`);
  const retried = await retry();
  assert.equal(retried.status, "pending");
});

// ------------------------------------------------------------------ mutations

async function withMutation(name, from, to, body) {
  const definition = await queryJson(`SELECT to_jsonb(pg_get_functiondef(p.oid))::text FROM pg_proc p
    WHERE p.proname=:'name' AND p.pronamespace='control_plane'::regnamespace;`, { name });
  assert.ok(definition.includes(from), `${name} no longer contains the line this mutation removes`);
  psql(definition.replace(from, to));
  try { return await body(); } finally { psql(definition); }
}

test("mutation: without the share lock the claim does not wait for the revocation, and hands the job out", { skip }, async () => {
  // 0088: the lock moved into connection_revoked, the rule revoked_model_access
  // and project_readiness share.
  await withMutation("connection_revoked", "WHERE c.id=p_connection FOR SHARE;", "WHERE c.id=p_connection;", async () => {
    const f = fixture();
    let commitRevocation;
    const revocationHeld = new Promise((resolve) => { commitRevocation = resolve; });
    let written;
    const revocationWritten = new Promise((resolve) => { written = resolve; });
    const revocation = withTransaction(async (client) => {
      await revoke(f, (sql, variables) => queryJsonOn(client, sql, variables));
      written();
      await revocationHeld;
    });
    await revocationWritten;
    const claimed = await claim(f);
    commitRevocation();
    await revocation;
    assert.deepEqual(claimed, [String(f.job)], "the claim waited even without the lock — the test no longer shows what the lock does");
  });
});

test("mutation: without the check in the claim a revoked job is handed out", { skip }, async () => {
  await withMutation("claim_executor_jobs", "v_revoked := revoked_model_access(v_job);", "v_revoked := NULL;", async () => {
    const f = fixture();
    await revoke(f);
    assert.deepEqual(await claim(f), [String(f.job)]);
  });
});

test("mutation: without the check in record_runtime_dispatch a revoked job is launched", { skip }, async () => {
  await withMutation("record_runtime_dispatch", "v_revoked:=revoked_model_access(v_job);", "v_revoked:=NULL;", async () => {
    const f = fixture();
    assert.deepEqual(await claim(f), [String(f.job)]);
    await start(f);
    await revoke(f);
    const outcome = await dispatch(f);
    assert.ok(outcome.attempt?.attempt_id, `the launch was refused without the check: ${outcome.refused}`);
  });
});
