import { spawnSync } from "node:child_process";
import { mkdir, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { queryJson, closePool } from "../control-plane/db.mjs";
import { credentialsRetirement, readCredentialsState, retireCredentials } from "./initial-credentials.mjs";
import { LONG_RUNNING_SERVICES, POSTGRESQL_UNIT } from "./unit-contract.mjs";
import { runtimeNames } from "./runtime-adapters.mjs";
import { readinessOf } from "./runtime.mjs";
import { DATABASE_STATE_SQL, HEALTH_STATUS_NAMES, RUNTIME_HEALTH_UPSERT_SQL, databaseAlerts, healthStatusOf } from "./health-state.mjs";

if (process.getuid?.() !== 0) throw new Error("health snapshot must run as root");
const outputRoot = process.env.INFRA_OBSERVABILITY_ROOT ?? "/var/lib/infra-control/observability";
const backupRoot = process.env.INFRA_BACKUP_ROOT ?? "/var/lib/infra-cod-backups";
const diskWarn = Number(process.env.INFRA_DISK_WARN_PERCENT ?? 85);
const backupMaxHours = Number(process.env.INFRA_BACKUP_MAX_AGE_HOURS ?? 36);
const restoreMaxHours = Number(process.env.INFRA_RESTORE_MAX_AGE_HOURS ?? 192);
const eventLagWarn = Number(process.env.INFRA_EVENT_LAG_WARN_SECONDS ?? 60);

function run(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`${command} failed: ${(result.stderr || result.stdout).trim()}`);
  return result.stdout.trim();
}
function ageSeconds(value) { return value ? Math.max(0, (Date.now() - new Date(value).getTime()) / 1000) : -1; }
function metric(name, value, help) { return `# HELP ${name} ${help}\n# TYPE ${name} gauge\n${name} ${Number(value)}\n`; }

await mkdir(outputRoot, { recursive: true, mode: 0o755 });
const state = await queryJson(DATABASE_STATE_SQL);
const df = run("df", ["-P", "/"]).split("\n").at(-1).trim().split(/\s+/);
const diskPercent = Number(df[4].replace("%", ""));
const services = {};
// One list, shared with `doctor` and the acceptance workflow. The hand-kept copy
// this replaces was missing caddy and the project provisioner, and asked
// `postgresql.service` — a meta-unit that is inactive while PostgreSQL 17 runs
// under postgresql@17-main.service, so health called a healthy database dead.
for (const name of [POSTGRESQL_UNIT, ...LONG_RUNNING_SERVICES.map((unit) => `${unit}.service`)]) {
  services[name] = spawnSync("systemctl", ["is-active", "--quiet", name]).status === 0;
}

const latestBackup = JSON.parse(await readFile(path.join(backupRoot, "latest.json"), "utf8").catch(() => "null"));
const restoreReceipts = (await readdir(backupRoot).catch(() => [])).filter((name) => name.endsWith(".restore.json"));
let latestRestore = null;
for (const name of restoreReceipts) {
  const receipt = JSON.parse(await readFile(path.join(backupRoot, name), "utf8"));
  if (!latestRestore || new Date(receipt.tested_at) > new Date(latestRestore.tested_at)) latestRestore = receipt;
}
const backupAgeSeconds = ageSeconds(latestBackup?.created_at);
const restoreAgeSeconds = ageSeconds(latestRestore?.tested_at);

// The generated-password file is the one plaintext secret this system writes to
// disk, and this process is the only one that may delete it: infra-web must not
// have access to /etc/infra-cod, and nothing in the web tier should be deciding
// that a root-only file is expendable. So the decision is made here, from the
// database, on the same timer that already runs as root.
//
// Removal and its audit row are two steps that cannot be one transaction — one
// touches the filesystem, the other the database — so `retireCredentials` records
// its progress durably and resumes whatever a previous run left half-done. That
// is what stops a crash between the unlink and the audit from deleting a
// credential with no record of why.
const credentialsBefore = readCredentialsState();
const credentialStatus = await queryJson(`SELECT initial_credentials_status()::text;`);
const credentialRetirement = credentialsRetirement(credentialStatus);
const resumable = (await queryJson(`SELECT open_credential_retirements()::text;`))?.retirements ?? [];
let credentialsRemoved = null;
let credentialRetirementReport = null;

if (credentialsBefore.exists === null) {
  // Not "no file". An unreadable path is the one state where a plaintext
  // password may be sitting on disk while every other check passes.
  credentialRetirementReport = { state: "unreadable", error: credentialsBefore.error };
} else if ((credentialsBefore.exists || resumable.length > 0) && credentialRetirement === null) {
  const outcome = await retireCredentials({
    actorId: "cli:health-snapshot",
    run: (sql, variables) => queryJson(sql, variables),
  });
  credentialRetirementReport = outcome;
  credentialsRemoved = outcome.state === "recorded" ? true : null;
} else if (resumable.length > 0) {
  // An interrupted retirement whose credential is live again. Reported rather
  // than finished: the operator has kept using the file and it must not vanish.
  credentialRetirementReport = { state: "blocked", reason: credentialRetirement, open: resumable.length };
}
const credentialsAfter = readCredentialsState();

const alerts = [];
const add = (severity, code, message) => alerts.push({ severity, code, message });
if (diskPercent >= diskWarn) add("warning", "disk_usage_high", `root filesystem is ${diskPercent}% full`);
if (backupAgeSeconds < 0 || backupAgeSeconds > backupMaxHours * 3600) add("critical", "backup_stale", "encrypted backup is missing or stale");
if (restoreAgeSeconds < 0 || restoreAgeSeconds > restoreMaxHours * 3600) add("critical", "restore_drill_stale", "restore drill is missing or stale");
alerts.push(...databaseAlerts(state, { eventLagWarn }));
for (const [name, active] of Object.entries(services)) if (!active) add("critical", "service_inactive", `${name} is inactive`);
// Warns for as long as a plaintext password is on disk. Critical once the
// credential it holds is retired and the file is still there, because at that
// point nothing legitimate is keeping it — only a failed deletion or a
// permission problem.
if (credentialsAfter.exists) {
  const detail = credentialRetirement ?? "the generated password is retired";
  add(
    credentialRetirement === null ? "critical" : "warning",
    "initial_credentials_present",
    `${credentialsAfter.path} still holds a plaintext password (${detail})`,
  );
}
if (credentialsAfter.exists === null) {
  // The one state that must never be reported as clean: the file may be there
  // and we cannot see it.
  add(
    "critical",
    "initial_credentials_unreadable",
    `${credentialsAfter.path} could not be read (${credentialsAfter.error}); a plaintext password may still be on disk`,
  );
}
if (credentialRetirementReport?.state === "removal_refused") {
  add(
    "critical",
    "initial_credentials_removal_refused",
    `the retirement of ${credentialRetirementReport.path} was refused: ${credentialRetirementReport.reason}`,
  );
}
// A retirement left half-done is not an error in itself — the next run finishes
// it — but it should be visible rather than silent.
if (resumable.length > 0 && credentialRetirementReport?.state !== "recorded") {
  add("warning", "initial_credentials_retirement_open", `${resumable.length} credential retirement(s) are unfinished`);
}
// The runtimes, bounded and read here so the panel never has to.
//
// `runtimes.json` is root-owned under /etc, and the web tier runs as `infra-web`:
// a process that has no business opening that file, and should not be given a
// reason to. The snapshot carries what a panel legitimately needs — which
// runtime, which version, and whether it is installed, authenticated and
// verified — and nothing else. No paths, no digests, and by construction no
// credential: the states are booleans and the version is a version.
//
// Bounded on purpose: one entry per runtime this installation knows, never a
// directory listing. A snapshot that grows with whatever is on disk is a
// snapshot that can be made to grow.
//
// One runtime that cannot be read is a gap in the report, not the end of it.
// This section is an addition to a snapshot that already carried the database,
// the services and the backup; letting it throw took all of that down with it
// every minute — which is how a hardened unit's `ProtectHome=true` turned into a
// blank health record. A runtime that cannot be asked says so, in its own row.
const runtimes = runtimeNames().map((name) => {
  let readiness;
  try {
    readiness = readinessOf(name);
  } catch (error) {
    return {
      runtime: name, version: null, installed: false, authenticated: false,
      capability_verified: false, self_update_managed: false, ready: false,
      unreadable: error.message.slice(0, 200),
    };
  }
  return {
    runtime: readiness.runtime,
    version: readiness.version ?? null,
    installed: readiness.installed,
    authenticated: readiness.authenticated,
    capability_verified: readiness.capabilityVerified,
    self_update_managed: readiness.selfUpdateManaged,
    ready: readiness.ready,
    // The release baseline and what verifies the active version (0105 records
    // both from here, for the Runtimes card).
    baseline_version: readiness.baselineVersion ?? null,
    adapter_version: readiness.adapterVersion ?? null,
    verified_by: readiness.verifiedBy ?? null,
  };
});
for (const runtime of runtimes) {
  if (runtime.unreadable) {
    add("warning", "runtime_unreadable", `${runtime.runtime} could not be inspected: ${runtime.unreadable}`);
    continue;
  }
  if (!runtime.installed) {
    add("warning", "runtime_not_provisioned", `${runtime.runtime} is not provisioned`);
  } else if (!runtime.authenticated) {
    add("warning", "runtime_not_authenticated", `${runtime.runtime} holds no usable credential`);
  }
  if (runtime.installed && !runtime.self_update_managed) {
    add("warning", "runtime_self_update_unmanaged", `${runtime.runtime} may change its own version`);
  }
}

const healthStatus = healthStatusOf(alerts);
const snapshot = { type: "health.snapshot", observed_at: new Date().toISOString(), status: HEALTH_STATUS_NAMES[healthStatus],
  database: state, services, runtimes, disk_percent: diskPercent, backup_age_seconds: backupAgeSeconds, restore_age_seconds: restoreAgeSeconds,
  initial_credentials: {
    exists: credentialsAfter.exists,
    unreadable: credentialsAfter.exists === null,
    error: credentialsAfter.error,
    path: credentialsAfter.path,
    mode: credentialsAfter.mode,
    retirement_blocked_by: credentialRetirement,
    retirement: credentialRetirementReport?.state ?? null,
    removed_this_run: credentialsRemoved === true,
    retirements_open: resumable.length,
  },
  alerts };

let prometheus = metric("infra_cod_health_status", healthStatus, "0 healthy, 1 degraded, 2 critical");
for (const [name, value] of Object.entries(state)) prometheus += metric(`infra_cod_${name}`, value, name.replaceAll("_", " "));
prometheus += metric("infra_cod_disk_used_percent", diskPercent, "Root filesystem usage percent");
prometheus += metric("infra_cod_backup_age_seconds", backupAgeSeconds, "Age of latest encrypted backup");
prometheus += metric("infra_cod_restore_drill_age_seconds", restoreAgeSeconds, "Age of latest successful restore drill");
prometheus += metric("infra_cod_services_inactive", Object.values(services).filter((active) => !active).length, "Inactive required services");
const promTemp = path.join(outputRoot, ".infra_cod.prom.tmp");
const jsonTemp = path.join(outputRoot, ".health.json.tmp");
await writeFile(promTemp, prometheus, { mode: 0o644 });
await writeFile(jsonTemp, `${JSON.stringify(snapshot, null, 2)}\n`, { mode: 0o644 });
await rename(promTemp, path.join(outputRoot, "infra_cod.prom"));
await rename(jsonTemp, path.join(outputRoot, "health.json"));
await queryJson(
  RUNTIME_HEALTH_UPSERT_SQL,
  { status: snapshot.status, snapshot: JSON.stringify(snapshot), observed_at: snapshot.observed_at },
);
// What needs the operator goes to Telegram (0140), once a day per alert. A
// schema before 0140 has no such function; the snapshot is recorded either way.
await queryJson(`SELECT notify_health_alerts(:'alerts'::jsonb)::text;`, { alerts: JSON.stringify(alerts) })
  .catch((error) => process.stderr.write(`${JSON.stringify({ type: "health.notify_failed", error: String(error?.message ?? error).slice(0, 200) })}\n`));
process.stdout.write(`${JSON.stringify(snapshot)}\n`);
if (healthStatus === 2) process.exitCode = 1;

await closePool();
