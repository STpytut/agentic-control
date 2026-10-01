import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

import { RESERVED_RUNTIME_NAMES, allAdapters } from "../../operations/runtime-adapters.mjs";
import { schemaGaps } from "../../operations/runtime-registry-check.mjs";
import { allDrivers } from "../../runtime-supervisor/drivers/index.mjs";
import { ROLE_CORE } from "../../runtime-supervisor/drivers/capabilities.mjs";

// The database repeats the adapter registry in CHECK constraints and in the
// functions that validate a runtime, a provider or a job type (WP-5a). SQL cannot
// import the registry, so this reads the migrated schema and compares — and,
// handed a fictional third runtime, names every constraint and function a
// migration adding one would have to change.
// Skipped only when DATABASE_URL or psql is genuinely unavailable.

const databaseUrl = process.env.DATABASE_URL;
const psqlBin = process.env.PSQL_BIN ?? "psql";
let hasPsql = false;
try {
  execFileSync("sh", ["-c", `command -v ${JSON.stringify(psqlBin)}`], { stdio: "ignore" });
  hasPsql = true;
} catch {}

function schemaFacts() {
  const output = execFileSync(psqlBin, [databaseUrl, "-X", "-qAt", "-v", "ON_ERROR_STOP=1", "-c", `
    SELECT jsonb_build_object(
      'checks',(SELECT jsonb_agg(jsonb_build_object('table',conrelid::regclass::text,'name',conname,
        'definition',pg_get_constraintdef(oid))) FROM pg_constraint
        WHERE contype='c' AND connamespace='control_plane'::regnamespace),
      'functions',(SELECT jsonb_agg(jsonb_build_object('name',proname,'source',prosrc)) FROM pg_proc
        WHERE pronamespace='control_plane'::regnamespace))`], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return JSON.parse(output);
}

const FICTIONAL = { name: "fictional", user: "fictional-worker", dispatch: { jobTypes: ["fictional_turn"], connectionProvider: "fictional" } };

test("the schema accepts exactly the runtimes, providers and job types the registry declares", { skip: !databaseUrl || !hasPsql }, () => {
  const gaps = schemaGaps({ adapters: allAdapters(), reserved: RESERVED_RUNTIME_NAMES, ...schemaFacts() });
  assert.deepEqual(gaps, [], gaps.join("\n"));
});

test("a fictional third runtime is refused by name in every constraint and validator", { skip: !databaseUrl || !hasPsql }, () => {
  const gaps = schemaGaps({ adapters: [...allAdapters(), FICTIONAL], reserved: RESERVED_RUNTIME_NAMES, ...schemaFacts() });
  const accepted = "[antigravity, claude, codex, opencode], the registry [antigravity, claude, codex, fictional, opencode]";
  assert.deepEqual(gaps.sort(), [
    `control_plane.provider_model_catalog.provider_model_catalog_runtime_type_check accepts ${accepted}`,
    `control_plane.runtime_activity_events.runtime_activity_events_runtime_type_check accepts ${accepted}`,
    // 0071: what a job selected is a runtime the schema knows.
    `control_plane.runtime_job_selections.runtime_job_selections_runtime_type_check accepts ${accepted}`,
    `control_plane.runtime_profiles.runtime_profiles_runtime_type_check accepts ${accepted}`,
    // 0095 (Stage 12 W2): the upstream versions the watch records, per runtime.
    `control_plane.runtime_versions.runtime_versions_runtime_type_check accepts ${accepted}`,
    `control_plane.runtime_watch_state.runtime_watch_state_runtime_type_check accepts ${accepted}`,
    // 0096 (Stage 12 W3): qualifications of runtime versions.
    `control_plane.runtime_qualifications.runtime_qualifications_runtime_type_check accepts ${accepted}`,
    // 0097 (Stage 12 W4): promotions and rollbacks of runtime versions.
    `control_plane.runtime_activations.runtime_activations_runtime_type_check accepts ${accepted}`,
    // 0098 (Stage 12 W5-a): which runtime versions list a catalog model.
    `control_plane.model_listings.model_listings_runtime_type_check accepts ${accepted}`,
    // 0099 (Stage 12 W6): the version each runtime runs, and the model checks.
    `control_plane.runtime_active_versions.runtime_active_versions_runtime_type_check accepts ${accepted}`,
    `control_plane.model_checks.model_checks_runtime_type_check accepts ${accepted}`,
    // 0105: each runtime's release baseline, from the health report.
    `control_plane.runtime_baselines.runtime_baselines_runtime_type_check accepts ${accepted}`,
    // 0113 (Stage 12, limits and usage): a connection's readings and a run's usage.
    `control_plane.provider_usage_readings.provider_usage_readings_runtime_type_check accepts ${accepted}`,
    `control_plane.run_usage.run_usage_runtime_type_check accepts ${accepted}`,
    // 0127: Qualify and Promote pressed in the panel, per runtime.
    `control_plane.runtime_update_requests.runtime_update_requests_runtime_type_check accepts ${accepted}`,
    `append_runtime_activity_event validates p_runtime_type against ${accepted}`,
    `ensure_structural_runtime_profile validates p_runtime_type against ${accepted}`,
    `upsert_catalog_entries validates COALESCE(v_entry->>'runtime_type','') against ${accepted}`,
    "request_catalog_refresh validates v_connection.provider against [claude, codex, opencode], the registry [claude, codex, fictional, opencode]",
    "control_plane.provider_connections.provider_connections_provider_check does not accept the provider fictional",
    "control_plane.provider_login_sessions.provider_login_sessions_provider_check does not accept the provider fictional",
    "runtime_jobs_job_type_check does not accept fictional_turn, which fictional serves",
    "nothing in the schema records the credential reference fictional-home:fictional-worker",
  ].sort());
});

test("a runtime user moved without a migration is named where the database still has the old one", { skip: !databaseUrl || !hasPsql }, () => {
  // Were the Codex user renamed again, this is the list of what a migration
  // would have to rewrite — as 0065 did for codex-poc.
  const moved = allAdapters().map((adapter) => adapter.name === "codex" ? { ...adapter, user: "codex-next" } : adapter);
  const gaps = schemaGaps({ adapters: moved, reserved: RESERVED_RUNTIME_NAMES, ...schemaFacts() });
  assert.ok(gaps.some((gap) => gap.includes("the credential reference codex-home:codex-worker, which is no runtime's")), gaps.join("\n"));
  assert.ok(gaps.includes("nothing in the schema records the credential reference codex-home:codex-next"), gaps.join("\n"));
});

// The roles, driver capabilities and role cores the database decides with
// (0074) are a mirror of code. A registry that gives a runtime a role, a driver
// that declares a capability, or a core that grows, without the migration that
// tells the database, is named here — and so is the reverse.
function roleMirror() {
  const output = execFileSync(psqlBin, [databaseUrl, "-X", "-qAt", "-v", "ON_ERROR_STOP=1", "-c", `
    SELECT jsonb_build_object(
      'roles',(SELECT jsonb_agg(runtime_type||' '||role ) FROM control_plane.runtime_roles),
      'capabilities',(SELECT jsonb_agg(runtime_type||' '||capability ) FROM control_plane.runtime_capabilities),
      'core',(SELECT jsonb_agg(role||' '||capability ) FROM control_plane.runtime_role_core))`], { encoding: "utf8" });
  const mirror = JSON.parse(output);
  return Object.fromEntries(Object.entries(mirror).map(([key, rows]) => [key, (rows ?? []).sort()]));
}

export function roleMirrorOf({ adapters, drivers, core }) {
  return {
    roles: adapters.flatMap((adapter) => adapter.roles.map((role) => `${adapter.name} ${role}`)).sort(),
    capabilities: drivers.flatMap((driver) => Object.keys(driver.capabilities).map((capability) => `${driver.name} ${capability}`)).sort(),
    core: Object.entries(core).flatMap(([role, capabilities]) => capabilities.map((capability) => `${role} ${capability}`)).sort(),
  };
}

test("the database's roles and capabilities are the registry's and the drivers'", { skip: !databaseUrl || !hasPsql }, () => {
  assert.deepEqual(roleMirror(), roleMirrorOf({ adapters: allAdapters(), drivers: allDrivers(), core: ROLE_CORE }));
});

test("a driver that gains a capability without a migration is a difference", { skip: !databaseUrl || !hasPsql }, () => {
  const drivers = allDrivers().map((driver) => driver.name === "opencode"
    ? { ...driver, capabilities: { ...driver.capabilities, "account.device_login": "fictional" } } : driver);
  assert.notDeepEqual(roleMirror(), roleMirrorOf({ adapters: allAdapters(), drivers, core: ROLE_CORE }));
});
