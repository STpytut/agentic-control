// Neutral job names, contract half (0077, Stage 11.2 N6).
//
// db/tests run on a schema that is already past 0077, where an old name cannot
// be written; what the contract does to a host that still has old-named rows
// has to be shown on a database stopped at 0076. So this file builds one, puts
// jobs under the old names exactly as a release before 0073 left them, applies
// 0077 by itself, and follows the renamed jobs through the functions that now
// know only the new names:
//
//   * a queued implementation and a queued turn are renamed in place — same
//     rows, same events — and are claimed and started under the new names;
//   * an old name is refused afterwards, by the claim and by the CHECK;
//   * an event that somehow has a job under both names stops the migration,
//     naming the event, rather than colliding on the unique key.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readdirSync } from "node:fs";
import path from "node:path";

import { FIXTURE_FUNCTION } from "./runtime-job-fixture.mjs";

const adminDatabaseUrl = process.env.DATABASE_URL;
const psqlBin = process.env.PSQL_BIN ?? "psql";
let hasPsql = false;
try { hasPsql = spawnSync("sh", ["-c", `command -v ${JSON.stringify(psqlBin)}`], { stdio: "ignore" }).status === 0; } catch {}
const skip = !adminDatabaseUrl ? "DATABASE_URL is not set" : !hasPsql ? "psql is not available" : false;

const root = path.resolve(import.meta.dirname, "../../..");
const migrationsDir = path.join(root, "db/migrations");
const CONTRACT = "0077_neutral_job_vocabulary_contract.sql";
// migrate.mjs's boundary: through 0038 a file opens its own transaction.
const LEGACY_SELF_MANAGED_THROUGH = 38;
const scratches = [];

function adminUrl(database) {
  const parsed = new URL(adminDatabaseUrl);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

function psql(url, sql, { file } = {}) {
  const args = ["-X", "-qAt", "-v", "ON_ERROR_STOP=1"];
  if (file && Number(path.basename(file).slice(0, 4)) > LEGACY_SELF_MANAGED_THROUGH) args.push("--single-transaction");
  args.push(url);
  if (file) args.push("-f", file);
  const result = spawnSync(psqlBin, args, { encoding: "utf8", input: file ? undefined : sql });
  return { ok: result.status === 0, out: result.stdout.trim(), err: result.stderr.trim() };
}
function must(url, sql) {
  const result = psql(url, `SET search_path TO control_plane,public,extensions;\n${sql}`);
  if (!result.ok) throw new Error(result.err);
  return result.out.split("\n").at(-1);
}

// A database with every migration before the contract, the way the runner
// would have left it.
function databaseBeforeContract() {
  const database = `infra_cod_n6_${randomUUID().slice(0, 8)}`;
  const created = psql(adminUrl("postgres"), `CREATE DATABASE ${database};`);
  if (!created.ok) throw new Error(created.err);
  scratches.push(database);
  const url = adminUrl(database);
  const files = readdirSync(migrationsDir).filter((name) => /^\d{4}_.+\.sql$/.test(name) && name < CONTRACT).sort();
  for (const name of files) {
    const applied = psql(url, "", { file: path.join(migrationsDir, name) });
    if (!applied.ok) throw new Error(`${name}: ${applied.err}`);
  }
  must(url, FIXTURE_FUNCTION);
  return url;
}

const contract = (url) => psql(url, "", { file: path.join(migrationsDir, CONTRACT) });

// A chat turn queued for the fixture's task under a given name.
function queueTurn(url, f, jobType, tag) {
  return JSON.parse(must(url, `
    WITH t AS (UPDATE tasks SET version=version+1,updated_at=clock_timestamp() WHERE id='${f.task}' RETURNING version),
    e AS (SELECT * FROM append_event('chat.user_message','${f.project}','${f.task}',NULL,'user','operator',NULL,
      'n6-${tag}','n6-${tag}','task','${f.task}',(SELECT version FROM t),'{"content":"queued before the update"}'))
    INSERT INTO runtime_jobs(source_event_id,job_type,project_id,task_id,payload)
    SELECT e.id,'${jobType}','${f.project}','${f.task}','{}' FROM e
    RETURNING jsonb_build_object('job',id,'event',source_event_id)::text;`));
}

test.after(() => {
  if (skip) return;
  for (const database of scratches) {
    psql(adminUrl("postgres"), `DROP DATABASE IF EXISTS ${database} WITH (FORCE);`);
  }
});

test("jobs queued under the old names are renamed in place and run under the new ones", { skip }, () => {
  const url = databaseBeforeContract();
  const f = JSON.parse(must(url, `SELECT race_fixture('n6')::text;`));
  // What a release before 0073 left behind: the delegation's job and a chat
  // turn, both pending, under the vendor's names.
  must(url, `UPDATE runtime_jobs SET job_type='start_implementation' WHERE id=${f.job};`);
  const turn = queueTurn(url, f, "codex_chat_turn", "turn");

  const applied = contract(url);
  assert.ok(applied.ok, applied.err);

  const types = must(url, `SELECT string_agg(id||':'||job_type, ',' ORDER BY id) FROM runtime_jobs WHERE id IN (${f.job},${turn.job});`);
  assert.equal(types, `${f.job}:implementation_run,${turn.job}:orchestrator_turn`);
  assert.equal(must(url, `SELECT count(*) FROM runtime_jobs WHERE job_type IN ('codex_chat_turn','resume_codex','start_implementation');`), "0");

  // The renamed implementation is claimed and started by its new name.
  const worker = "n6-supervisor";
  assert.equal(must(url, `SELECT (claim_runtime_job_for_event('${f.event}','implementation_run','${worker}','1 minute')).id;`), String(f.job));
  assert.equal(must(url, `SELECT start_implementation_job(${f.job},'${f.session}','${worker}','1 minute') IS NOT NULL;`), "t");
  // The renamed turn is claimed by its new name; the old one no longer finds it.
  const byOldName = psql(url, `SET search_path TO control_plane,public,extensions;
    SELECT claim_runtime_job_for_event('${turn.event}','codex_chat_turn','n6-codex','1 minute');`);
  assert.ok(!byOldName.ok);
  assert.match(byOldName.err, /runtime_job_unavailable|is unavailable/);
  assert.equal(must(url, `SELECT (claim_runtime_job_for_event('${turn.event}','orchestrator_turn','n6-codex','1 minute')).id;`), String(turn.job));

  // And an old name cannot be written again.
  const written = psql(url, `SET search_path TO control_plane,public,extensions;
    UPDATE runtime_jobs SET job_type='resume_codex' WHERE id=${turn.job};`);
  assert.ok(!written.ok);
  assert.match(written.err, /runtime_jobs_job_type_check/);
});

test("an event with a job under both names stops the contract, named", { skip }, () => {
  const url = databaseBeforeContract();
  const f = JSON.parse(must(url, `SELECT race_fixture('both')::text;`));
  const turn = queueTurn(url, f, "orchestrator_turn", "both");
  must(url, `INSERT INTO runtime_jobs(source_event_id,job_type,project_id,task_id,payload)
    VALUES('${turn.event}','codex_chat_turn','${f.project}','${f.task}','{}');`);

  const applied = contract(url);
  assert.ok(!applied.ok, "the contract renamed into a collision");
  assert.match(applied.err, new RegExp(`cannot be renamed: ${turn.event}`));
  // Nothing moved: the migration is one transaction.
  assert.equal(must(url, `SELECT count(*) FROM runtime_jobs WHERE job_type='codex_chat_turn';`), "1");
});
