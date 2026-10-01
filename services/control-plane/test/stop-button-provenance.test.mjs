// The panel's Stop button follows the driver's declaration (WP-9c).
//
// On rc.38 a running Codex turn showed no "Stop run": the activity query read
// `runtime_profiles.capabilities->>'interrupt'`, the Codex profile row did not
// say it, and Codex's driver declares interrupt in its mandatory core. Two
// sources for one capability, and the wrong one won.
//
// This test fails if any runtime whose driver declares `interrupt` is shown as
// not interruptible. It goes the whole way the product does: the driver objects
// the supervisor loads, the launch description the worker and the supervisor
// record (provenance.mjs), record_runtime_dispatch in a migrated database, and
// the panel's own getTaskActivity from apps/web — with each runtime's profile
// row saying nothing about interrupt, as rc.38's did. Then the mutation: the
// same launch with `interrupt` left out of what is recorded hides the button, so
// it is the declaration that holds it up.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";

import { allDrivers } from "../../runtime-supervisor/drivers/index.mjs";
import { hasCapability } from "../../runtime-supervisor/drivers/capabilities.mjs";
import { launchProvenance } from "../../runtime-supervisor/provenance.mjs";
import { allAdapters } from "../../operations/runtime-adapters.mjs";

const databaseUrl = process.env.DATABASE_URL;
let hasPsql = false;
try { execFileSync("sh", ["-c", "command -v psql"], { stdio: "ignore" }); hasPsql = true; } catch {}
const skip = !databaseUrl || !hasPsql ? "needs DATABASE_URL and psql" : false;

// The web tier's `@/` alias, so the panel's module is imported as it ships.
registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith("@/")) {
      return next(new URL(`../../../apps/web/src/${specifier.slice(2)}.ts`, import.meta.url).href, context);
    }
    return next(specifier, context);
  },
});

function sql(statement) {
  return execFileSync("psql", ["-X", "-qAt", "-v", "ON_ERROR_STOP=1", databaseUrl, "-c",
    `SET search_path TO control_plane, public, extensions; ${statement}`], { encoding: "utf8" }).trim();
}

// A project whose task is assigned to `driver`'s runtime in its role, with a
// job of that runtime's first job type in flight and its run started and
// granted — everything a launch has before it records itself. Profiles are made
// with no capabilities at all.
function inFlightJobFor(driver) {
  const adapter = allAdapters().find((candidate) => candidate.name === driver.name);
  const role = adapter.roles[0];
  const jobType = adapter.dispatch.jobTypes[0];
  const tag = randomUUID().slice(0, 8);
  const out = sql(`
    WITH u AS (INSERT INTO users(display_name) VALUES('stop-${tag}') RETURNING id),
    p AS (INSERT INTO projects(owner_id,name,slug,workspace_path)
      SELECT id,'stop-${tag}','stop-${tag}','/srv/infra-cod/workspaces/stop-${tag}' FROM u RETURNING id,owner_id),
    orp AS (INSERT INTO runtime_profiles(runtime_type,adapter_version,runtime_version,provider_type,model)
      VALUES('codex','t','t','openai','orchestrator-${tag}') RETURNING id),
    rp AS (INSERT INTO runtime_profiles(runtime_type,adapter_version,runtime_version,provider_type,model)
      VALUES('${driver.name}','t','t','p','model-${tag}') RETURNING id),
    oa AS (INSERT INTO agents(name,role,runtime_profile_id) SELECT 'o-${tag}','architect',id FROM orp RETURNING id,runtime_profile_id),
    ra AS (INSERT INTO agents(name,role,runtime_profile_id)
      SELECT 'r-${tag}','${role === "orchestrator" ? "architect" : "implementer"}',id FROM rp RETURNING id,runtime_profile_id),
    opa AS (INSERT INTO project_agent_assignments(project_id,agent_id,runtime_profile_id,assignment_role,is_default)
      SELECT p.id,oa.id,oa.runtime_profile_id,'orchestrator',true FROM p,oa RETURNING id),
    epa AS (INSERT INTO project_agent_assignments(project_id,agent_id,runtime_profile_id,assignment_role)
      SELECT p.id,ra.id,ra.runtime_profile_id,'executor' FROM p,ra WHERE '${role}'='executor' RETURNING id)
    SELECT jsonb_build_object('project',p.id,'owner',p.owner_id,'orchestrator',opa.id,'executor',(SELECT id FROM epa),
      'orchestrator_agent',oa.id,'runtime_agent',ra.id)::text FROM p,opa,oa,ra;`);
  const f = JSON.parse(out.split("\n").at(-1));
  // For an orchestrator runtime the task's orchestrator is that runtime.
  const orchestratorAssignment = role === "orchestrator"
    ? sql(`UPDATE project_agent_assignments SET agent_id='${f.runtime_agent}',
        runtime_profile_id=(SELECT runtime_profile_id FROM agents WHERE id='${f.runtime_agent}')
        WHERE id='${f.orchestrator}' RETURNING id;`)
    : f.orchestrator;
  const task = sql(`INSERT INTO tasks(project_id,title,objective,status,active_agent_id,orchestrator_assignment_id,created_by)
    VALUES('${f.project}','stop','stop','planning','${f.orchestrator_agent}','${orchestratorAssignment}','test') RETURNING id;`);
  const event = sql(`SELECT (append_event('${role === "orchestrator" ? "chat.user_message" : "implementation.requested"}',
    '${f.project}','${task}',NULL,'user','operator',NULL,'stop-${tag}','stop-${tag}','task','${task}',1,'{}')).id;`);
  const job = sql(`INSERT INTO runtime_jobs(source_event_id,job_type,project_id,task_id,payload)
    VALUES('${event}','${jobType}','${f.project}','${task}','{}') RETURNING id;`);
  // In flight, the way a claim leaves it; for a turn, the trigger makes the run.
  sql(`UPDATE runtime_jobs SET status='in_flight',attempt_count=1,leased_by='stop-worker',
    leased_until=clock_timestamp()+interval '5 minutes' WHERE id=${job};`);
  if (role === "executor") {
    const run = sql(`INSERT INTO task_runs(task_id,agent_id,phase,status,write_capable,workspace_fencing_token)
      VALUES('${task}','${f.runtime_agent}','implementation','running',true,1) RETURNING id;`);
    sql(`UPDATE runtime_jobs SET run_id='${run}' WHERE id=${job};`);
  }
  sql(`INSERT INTO workspace_access_grants(token_sha256,project_id,job_id,run_id,assignment_id,mode,fencing_token,issued_to,expires_at)
    SELECT digest(gen_random_uuid()::text,'sha256'),j.project_id,j.id,j.run_id,
      '${role === "executor" ? f.executor : orchestratorAssignment}',
      '${role === "executor" ? "read_write" : "read_only"}',${role === "executor" ? 1 : "NULL"},'stop-worker',
      clock_timestamp()+interval '10 minutes'
    FROM runtime_jobs j WHERE j.id=${job};`);
  return { ...f, task, job };
}

function recordLaunch(job, launch) {
  return JSON.parse(sql(`SELECT record_runtime_dispatch(${job},'stop-worker','${JSON.stringify(launch).replaceAll("'", "''")}'::jsonb)::text;`));
}

const verified = (driver) => ({ adapter_version: driver.verified.adapterVersion, runtime_version: driver.verified.runtimeVersion,
  verified_runtime_version: driver.verified.runtimeVersion, status: "verified" });

let productData;
test.before(async () => {
  if (skip) return;
  productData = await import("../../../apps/web/src/lib/product-data.ts");
});
test.after(async () => {
  if (skip) return;
  await globalThis.controlPlanePool?.end();
});

const interruptible = allDrivers().filter((driver) => hasCapability(driver, "interrupt"));

test("every runtime this product ships declares interrupt — so the list below is not empty by accident", () => {
  assert.deepEqual(interruptible.map((driver) => driver.name).sort(), allDrivers().map((driver) => driver.name).sort());
});

for (const driver of interruptible) {
  test(`a running ${driver.name} job shows Stop, from its driver's declaration`, { skip }, async () => {
    const fixture = inFlightJobFor(driver);
    // The profile row says nothing about interrupt — rc.38's Codex row.
    assert.equal(sql(`SELECT COALESCE(capabilities->>'interrupt','absent') FROM runtime_profiles rp
      JOIN agents a ON a.runtime_profile_id=rp.id WHERE a.id='${fixture.runtime_agent}';`), "absent");
    recordLaunch(fixture.job, launchProvenance(driver, verified(driver), { surface: "test" }));
    const activity = await productData.getTaskActivity(fixture.owner, fixture.project, fixture.task);
    assert.equal(activity?.status, "in_flight");
    assert.equal(activity?.runtimeType, driver.name);
    assert.equal(activity?.canInterrupt, true,
      `${driver.name}'s driver declares interrupt, and the panel shows its running job as not interruptible`);

    // A message typed during the run is a job of its own, waiting behind it
    // (0070). The card still shows the running job, and its Stop.
    const event = sql(`SELECT (append_event('chat.user_message','${fixture.project}','${fixture.task}',NULL,'user','operator',
      NULL,'later-${fixture.job}','later-${fixture.job}','task','${fixture.task}',2,'{"content":"later"}')).id;`);
    sql(`INSERT INTO runtime_jobs(source_event_id,job_type,project_id,task_id,payload)
      VALUES('${event}','orchestrator_turn','${fixture.project}','${fixture.task}','{}');`);
    const behind = await productData.getTaskActivity(fixture.owner, fixture.project, fixture.task);
    assert.equal(behind?.status, "in_flight", "a message waiting behind the run replaced the running job on the card");
    assert.equal(behind?.canInterrupt, true, "a message waiting behind the run hid the running job's Stop");
  });

  test(`mutation: ${driver.name} recorded without interrupt shows no Stop`, { skip }, async () => {
    const fixture = inFlightJobFor(driver);
    const launch = launchProvenance(driver, verified(driver), { surface: "test" });
    launch.capabilities = launch.capabilities.filter((capability) => capability !== "interrupt");
    recordLaunch(fixture.job, launch);
    const activity = await productData.getTaskActivity(fixture.owner, fixture.project, fixture.task);
    assert.equal(activity?.canInterrupt, false,
      "with interrupt left out of the record the button still showed — something other than the declaration holds it");
  });
}

// A dead letter retried nine days after its first start showed "Elapsed
// 14359:36" on the host: the card timed the attempt from the job's first start.
test("the card times the attempt now running, not the job's first start", { skip }, async () => {
  const [driver] = interruptible;
  const fixture = inFlightJobFor(driver);
  sql(`UPDATE runtime_jobs SET started_at=clock_timestamp()-interval '9 days' WHERE id=${fixture.job};`);
  recordLaunch(fixture.job, launchProvenance(driver, verified(driver), { surface: "test" }));
  const activity = await productData.getTaskActivity(fixture.owner, fixture.project, fixture.task);
  const age = Date.now() - new Date(activity?.startedAt).getTime();
  assert.ok(age >= 0 && age < 10 * 60_000, `the card's clock starts ${Math.round(age / 60_000)} minutes ago, not at the running attempt`);
});
