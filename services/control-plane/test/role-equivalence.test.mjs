// Roles as permission sets change no decision (Stage 11.3, sprint B R2–R4;
// §11.3: "the upgrade test compares decisions and events before and after the
// migration, not only row counts").
//
// Two databases: one stopped before the role migrations (the last file before
// 0079), one with every migration. The same host-shaped scenarios run on both —
// a Codex orchestrator with a revision, an OpenCode orchestrator choosing
// between two executors by priority — and what each leaves behind is read as a
// decision log: the events in order, the jobs and how they ended, which
// executor each handoff went to, and where the task stopped. The two logs must
// be the same. R3 and R4 rewrite the functions that make those decisions; this
// file is their proof as well.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const adminDatabaseUrl = process.env.DATABASE_URL;
const psqlBin = process.env.PSQL_BIN ?? "psql";
let hasPsql = false;
try { hasPsql = spawnSync("sh", ["-c", `command -v ${JSON.stringify(psqlBin)}`], { stdio: "ignore" }).status === 0; } catch {}
const skip = !adminDatabaseUrl ? "DATABASE_URL is not set" : !hasPsql ? "psql is not available" : false;

const root = path.resolve(import.meta.dirname, "../../..");
const migrationsDir = path.join(root, "db/migrations");
const FIRST_ROLE_MIGRATION = "0079";
const LEGACY_SELF_MANAGED_THROUGH = 38;
const SCENARIO = readFileSync(path.join(import.meta.dirname, "fixtures/role-equivalence-scenario.sql"), "utf8");
const SCENARIOS = [
  { tag: "codex-revised", orchestrator_runtime: "codex", executors: 1, revise: true, followup: false },
  { tag: "opencode-two-executors", orchestrator_runtime: "opencode", executors: 2, revise: false, followup: true },
  { tag: "opencode-revised", orchestrator_runtime: "opencode", executors: 2, revise: true, followup: false },
];
const scratches = [];

function adminUrl(database) {
  const parsed = new URL(adminDatabaseUrl);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

function psql(url, input, { file } = {}) {
  const args = ["-X", "-qAt", "-v", "ON_ERROR_STOP=1"];
  if (file && Number(path.basename(file).slice(0, 4)) > LEGACY_SELF_MANAGED_THROUGH) args.push("--single-transaction");
  args.push(url);
  if (file) args.push("-f", file);
  const result = spawnSync(psqlBin, args, { encoding: "utf8", input: file ? undefined : input });
  if (result.status !== 0) throw new Error(`${file ? path.basename(file) : "psql"}: ${result.stderr.trim()}`);
  return result.stdout.trim();
}

function database(prefix, { before } = {}) {
  const name = `infra_cod_${prefix}_${randomUUID().slice(0, 8)}`;
  psql(adminUrl("postgres"), `CREATE DATABASE ${name};`);
  scratches.push(name);
  const url = adminUrl(name);
  const files = readdirSync(migrationsDir).filter((file) => /^\d{4}_.+\.sql$/.test(file)
    && (!before || file.slice(0, 4) < before)).sort();
  for (const file of files) psql(url, "", { file: path.join(migrationsDir, file) });
  return url;
}

// What the decisions were, in terms both schemas share: names, not ids.
const DECISION_LOG = `SET search_path TO control_plane,public,extensions;
  SELECT jsonb_agg(entry ORDER BY entry->>'task')::text FROM (
    SELECT jsonb_build_object(
      'task', t.title,
      'follows', (SELECT s.title FROM tasks s WHERE s.id=t.followup_of_task_id),
      'task_status', t.status,
      -- In the order the conversation received them (ADR-0014); an event id is
      -- a uuid and says nothing about order.
      'events', (SELECT jsonb_agg(e.event_type ORDER BY e.conversation_sequence NULLS LAST, e.occurred_at, e.event_type)
                 FROM domain_events e WHERE e.task_id=t.id),
      'jobs', (SELECT jsonb_agg(jsonb_build_array(j.job_type, j.status, j.attempt_count) ORDER BY j.id)
               FROM runtime_jobs j WHERE j.task_id=t.id),
      'handoffs', (SELECT jsonb_agg(jsonb_build_array(h.revision_number, a.name) ORDER BY h.revision_number)
                   FROM handoffs h JOIN project_agent_assignments pa ON pa.id=h.executor_assignment_id
                   JOIN agents a ON a.id=pa.agent_id WHERE h.task_id=t.id),
      'runs', (SELECT jsonb_agg(jsonb_build_array(r.status, r.write_capable) ORDER BY r.created_at, r.id)
               FROM task_runs r WHERE r.task_id=t.id)
    ) AS entry
    FROM tasks t JOIN projects p ON p.id=t.project_id WHERE p.slug LIKE 'equivalence-%'
  ) entries;`;

function decisions(url) {
  for (const scenario of SCENARIOS) {
    const settings = Object.entries(scenario).map(([key, value]) => `SET eq.${key}='${value}';`).join(" ");
    psql(url, `${settings}\n${SCENARIO}`);
  }
  return JSON.parse(psql(url, DECISION_LOG));
}

test.after(() => {
  if (skip) return;
  for (const name of scratches) psql(adminUrl("postgres"), `DROP DATABASE IF EXISTS ${name} WITH (FORCE);`);
});

test("the role migrations change no routing decision, selection or event", { skip }, () => {
  const before = decisions(database("roles_before", { before: FIRST_ROLE_MIGRATION }));
  const after = decisions(database("roles_after"));
  assert.equal(before.length, SCENARIOS.length + SCENARIOS.filter((s) => s.followup).length, "a scenario left no task behind");
  // The scenarios did what they are for, so the comparison compares something.
  const byTask = Object.fromEntries(before.map((entry) => [entry.task, entry]));
  assert.deepEqual(byTask["Equivalence codex-revised"].handoffs.map(([revision]) => revision), [1, 2]);
  assert.equal(byTask["Equivalence opencode-two-executors"].handoffs.length, 1);
  assert.equal(byTask["Follow-up opencode-two-executors"].follows, "Equivalence opencode-two-executors");
  assert.equal(byTask["Follow-up opencode-two-executors"].handoffs.length, 1);
  assert.deepEqual(after, before);
});
