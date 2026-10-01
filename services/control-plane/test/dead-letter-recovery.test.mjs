// The way back from dead_letter, as the operator takes it (0072, prework C2).
//
// db/tests/0048 proves the two functions — retry to completed, the refusals,
// the selection reused or superseded, the idempotency mutation. This file goes
// through what the operator actually touches and what the host actually
// reports:
//
//   * the card: the panel's own getProjectWorkspace shows a dead letter with its
//     reason from the vocabulary and the attempt it died at;
//   * the buttons: the panel's own performControlPlaneAction, clicked twice at
//     once, is one retry of one job;
//   * the health snapshot: the timer's own statement and alert rules
//     (health-state.mjs) say `degraded` while a dead letter is open and stop
//     saying it when every one has been retried or dismissed.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import path from "node:path";

import { FIXTURE_FUNCTION, READY, snapshotOf } from "./runtime-job-fixture.mjs";
import { DATABASE_STATE_SQL, RUNTIME_HEALTH_UPSERT_SQL, databaseAlerts, healthStatusOf, HEALTH_STATUS_NAMES } from "../../operations/health-state.mjs";

const adminDatabaseUrl = process.env.DATABASE_URL;
const psqlBin = process.env.PSQL_BIN ?? "psql";
let hasPsql = false;
try { hasPsql = spawnSync("sh", ["-c", `command -v ${JSON.stringify(psqlBin)}`], { stdio: "ignore" }).status === 0; } catch {}
const skip = !adminDatabaseUrl ? "DATABASE_URL is not set" : !hasPsql ? "psql is not available" : false;

registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith("@/")) {
      return next(new URL(`../../../apps/web/src/${specifier.slice(2)}.ts`, import.meta.url).href, context);
    }
    return next(specifier, context);
  },
});

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
const json = (sql) => JSON.parse(psql(sql).split("\n").at(-1));
const quote = (value) => `'${String(value).replaceAll("'", "''")}'`;

function report(runtimes) {
  const snapshot = snapshotOf(runtimes);
  psql(`SET search_path TO control_plane,public,extensions;
    ${RUNTIME_HEALTH_UPSERT_SQL.replace(":'status'", quote(snapshot.status)).replace(":'snapshot'", quote(snapshot.snapshot))
      .replace(":'observed_at'", quote(snapshot.observed_at))}`);
}

// What the timer would write now, from the database half it asks.
function health() {
  const state = json(`SET search_path TO control_plane,public,extensions; ${DATABASE_STATE_SQL}`);
  // The outbox of a test database has no dispatcher; its lag is not what this
  // file is about.
  const alerts = databaseAlerts(state, { eventLagWarn: 24 * 3600 });
  return { state, alerts, status: HEALTH_STATUS_NAMES[healthStatusOf(alerts)] };
}

// An implementation that died because OpenCode was removed under it (3.8).
function deadImplementation() {
  const f = json(`SET search_path TO control_plane,public,extensions; SELECT race_fixture('${randomUUID().slice(0, 8)}')::text;`);
  const worker = `dl-supervisor-${f.job}`;
  report({ ...READY, opencode: { installed: false, authenticated: false } });
  const status = psql(`SET search_path TO control_plane,public,extensions;
    SELECT claim_runtime_job_for_event('${f.event}','implementation_run','${worker}','1 minute') IS NOT NULL;
    SELECT start_implementation_job(${f.job},'${f.session}','${worker}','1 minute') IS NOT NULL;
    SELECT retry_runtime_job(${f.job},'${worker}','runtime launch refused','15 seconds',3);`).split("\n").at(-1);
  assert.equal(status, "dead_letter");
  return f;
}

// A Codex turn whose attempts all failed.
function deadTurn(f) {
  const turn = json(`SET search_path TO control_plane,public,extensions;
    WITH t AS (UPDATE tasks SET version=version+1,updated_at=clock_timestamp() WHERE id='${f.task}' RETURNING version),
    e AS (SELECT * FROM append_event('chat.user_message','${f.project}','${f.task}',NULL,'user','operator',NULL,
      'dl-turn-${f.job}','dl-turn-${f.job}','task','${f.task}',(SELECT version FROM t),'{"content":"again"}'))
    INSERT INTO runtime_jobs(source_event_id,job_type,project_id,task_id,payload)
    SELECT e.id,'orchestrator_turn','${f.project}','${f.task}','{}' FROM e RETURNING jsonb_build_object('job',id,'event',source_event_id)::text;`);
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    psql(`SET search_path TO control_plane,public,extensions;
      UPDATE runtime_jobs SET available_at=clock_timestamp() WHERE id=${turn.job};
      SELECT claim_runtime_job_for_event('${turn.event}','orchestrator_turn','dl-codex','1 minute') IS NOT NULL;
      SELECT retry_runtime_job(${turn.job},'dl-codex','codex app-server exited','0 seconds',2);`);
  }
  return turn;
}

let productData;
let actions;
test.before(async () => {
  if (skip) return;
  scratch = `infra_cod_dl_${randomUUID().slice(0, 8)}`;
  psql(`CREATE DATABASE ${scratch};`, adminUrl("postgres"));
  url = adminUrl(scratch);
  const migrate = spawnSync(process.execPath, [path.join(root, "services/control-plane/migrate.mjs")], {
    encoding: "utf8", env: { ...process.env, DATABASE_URL: url },
  });
  if (migrate.status !== 0) throw new Error(`migrate failed: ${migrate.stderr}`);
  psql(FIXTURE_FUNCTION);
  report(READY);
  process.env.DATABASE_URL = url;
  productData = await import("../../../apps/web/src/lib/product-data.ts");
  actions = await import("../../../apps/web/src/lib/control-plane-actions.ts");
});

test.after(async () => {
  if (skip) return;
  await globalThis.controlPlanePool?.end();
  spawnSync(psqlBin, ["-X", "-qAt", adminUrl("postgres")], { encoding: "utf8", input: `DROP DATABASE IF EXISTS ${scratch} WITH (FORCE);` });
});

test("dead letters are shown with their reason, retried once for a double click, dismissed, and health stops being degraded", { skip }, async () => {
  assert.ok(!health().alerts.some((alert) => alert.code === "dead_letters_present"), "a fresh database already reports dead letters");

  const f = deadImplementation();
  const turn = deadTurn(f);
  const before = health();
  assert.equal(before.state.runtime_jobs_dead_letter, 2);
  assert.ok(before.alerts.some((alert) => alert.code === "dead_letters_present"));
  assert.equal(before.status, "degraded");

  // The card, as the panel reads it.
  const owner = json(`SELECT jsonb_build_object('o',owner_id)::text FROM control_plane.projects WHERE id='${f.project}';`).o;
  const workspace = await productData.getProjectWorkspace(owner, f.project, f.task);
  const cards = workspace.attention.filter((item) => item.type === "incident");
  const implementation = cards.find((item) => item.id === String(f.job));
  const conversation = cards.find((item) => item.id === String(turn.job));
  assert.equal(implementation?.failureReason, "runtime_not_provisioned");
  assert.match(implementation.description, /not installed/, "the card does not say why in the vocabulary's words");
  assert.equal(conversation?.failureReason, "runtime_attempts_exhausted");
  assert.ok(Number.isInteger(implementation.attempt) && implementation.attempt > 0);
  // And the conversation says it too.
  assert.ok(workspace.messages.some((message) => message.eventType === "runtime_job.dead_lettered"
    && /not installed/.test(message.content)), "the conversation does not say the work stopped");

  // Retry while the runtime is still removed: refused with the reason, nothing changes.
  const operator = { userId: owner };
  await assert.rejects(actions.performControlPlaneAction(
    { kind: "dead_letter_retry", id: String(f.job), attempt: implementation.attempt, note: "" }, operator), /restore it, then retry/);

  // Restored. The same button clicked twice at once.
  report(READY);
  const click = () => actions.performControlPlaneAction(
    { kind: "dead_letter_retry", id: String(f.job), attempt: implementation.attempt, note: "" }, operator);
  const [first, second] = await Promise.all([click(), click()]);
  assert.equal(first.recovery_id, second.recovery_id, "two clicks made two recoveries");
  assert.deepEqual([first.repeat, second.repeat].sort(), [false, true]);
  assert.equal(json(`SELECT jsonb_build_object('n',count(*))::text FROM control_plane.runtime_jobs WHERE source_event_id='${f.event}';`).n, 1,
    "a double click made a second job");
  assert.equal(json(`SELECT jsonb_build_object('s',status)::text FROM control_plane.runtime_jobs WHERE id=${f.job};`).s, "pending");

  // The turn is dismissed: a short reason is refused, a real one closes it.
  await assert.rejects(actions.performControlPlaneAction(
    { kind: "dead_letter_dismiss", id: String(turn.job), attempt: conversation.attempt, note: "no" }, operator), /note is invalid/);
  const dismissed = await actions.performControlPlaneAction(
    { kind: "dead_letter_dismiss", id: String(turn.job), attempt: conversation.attempt, note: "Asked again in a new message" }, operator);
  assert.equal(dismissed.action, "dismiss");

  const after = health();
  assert.equal(after.state.runtime_jobs_dead_letter, 0);
  assert.ok(!after.alerts.some((alert) => alert.code === "dead_letters_present"), "health still reports dead letters");
  assert.equal(after.status, "healthy");

  // Someone else's operator cannot touch either.
  await assert.rejects(actions.performControlPlaneAction(
    { kind: "dead_letter_retry", id: String(f.job), attempt: implementation.attempt }, { userId: randomUUID() }),
    /resource is unavailable/);
});
