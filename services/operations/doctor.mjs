#!/usr/bin/env node
// `infra-cod doctor` — system health diagnostics.
//
// Runs a battery of checks against the installed system and reports the result
// as human-readable text or JSON. The checks cover the artefact tree, the
// database, systemd, the network boundary and the runtime credentials.
//
// Exit codes:
//   0 — healthy
//   1 — degraded (warnings only)
//   2 — critical (at least one check is broken)
//
// Usage:
//   infra-cod doctor [--json]
//

import { existsSync, lstatSync, readFileSync, realpathSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { readCredentialsState } from "./initial-credentials.mjs";
import { detectLayout } from "./layout-migration.mjs";
import { HOST_REQUIREMENTS, adapterFor, runtimeNames, versionInRange } from "./runtime-adapters.mjs";
import { INSTALLATION_LAYOUT } from "./installation-layout.mjs";
import { RUNTIMES_FILE, executableDigest, readRuntimes } from "./runtime-inventory.mjs";
import { authenticationOf, probeHostRequirement, reconciliationOf, runAsRuntimeUser } from "./runtime.mjs";
import { activeQualification, capabilityVerification, pairOf } from "../runtime-supervisor/drivers/capabilities.mjs";
import { driverFor } from "../runtime-supervisor/drivers/index.mjs";
import { staleRunToolSockets } from "../runtime-supervisor/worker-tool-socket.mjs";
import { hiddenState } from "../runtime-supervisor/sandbox-shell.mjs";
import {
  LONG_RUNNING_SERVICES,
  ONESHOT_SERVICES,
  POSTGRESQL_UNIT,
  RUNTIME_SANDBOX_PATHS,
  TIMERS,
  unitFileNames,
} from "./unit-contract.mjs";

const COMMAND_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const RELEASE_MANIFEST = path.resolve(COMMAND_DIRECTORY, "../../manifest.json");

// The sandbox prefix `deploy/install.sh` documents. Empty on a real host, so
// every path below is the absolute one; set by the installer test harness so the
// same checks can run against a tree that is not `/`.
const PREFIX = (process.env.INFRA_COD_INSTALL_PREFIX ?? "").trim();
const sys = (absolute) => `${PREFIX}${absolute}`;

// ---------------------------------------------------------------------------
// Check helpers
// ---------------------------------------------------------------------------

class Check {
  constructor(name) {
    this.name = name;
    this.ok = true;
    this.severity = "info";
    this.message = null;
  }

  pass(message) {
    this.ok = true;
    this.message = message;
    return this;
  }

  warn(message) {
    this.ok = false;
    this.severity = "warning";
    this.message = message;
    return this;
  }

  fail(message) {
    this.ok = false;
    this.severity = "critical";
    this.message = message;
    return this;
  }

  toJSON() {
    return {
      check: this.name,
      ok: this.ok,
      severity: this.severity,
      message: this.message,
    };
  }
}

function commandExists(binary) {
  const result = spawnSync("which", [binary], { encoding: "utf8" });
  return result.status === 0;
}

function commandOutput(binary, args, options = {}) {
  const result = spawnSync(binary, args, {
    encoding: "utf8",
    timeout: 10_000,
    ...options,
  });
  if (result.error) return { ok: false, error: result.error.message, stdout: "", stderr: "" };
  return { ok: result.status === 0, exitCode: result.status, stdout: result.stdout.trim(), stderr: result.stderr.trim() };
}

// The pinned toolchain versions, read from the install manifest that ships
// inside the release. Reading them from the same file the installer reads is the
// point: a doctor with its own copy of "the version we expect" can agree with
// nobody.
function pinnedVersions() {
  const releaseRoot = resolveReleaseRoot();
  if (!releaseRoot) return { available: false, reason: "not running from a release" };
  try {
    const manifest = JSON.parse(readFileSync(path.join(releaseRoot, "deploy/install-manifest.json"), "utf8"));
    const node = manifest.node?.version;
    const caddy = manifest.caddy?.version;
    if (!node || !caddy) return { available: false, reason: "install-manifest.json names no pinned versions" };
    return { available: true, node, caddy };
  } catch (error) {
    // Swallowing this is how a broken manifest silently switched the version
    // pins off: Node and Caddy would then be whatever happened to be installed,
    // and the report would say so approvingly.
    return { available: false, reason: `install-manifest.json is unreadable (${error.message})` };
  }
}

function resolveReleaseRoot() {
  const candidate = path.resolve(COMMAND_DIRECTORY, "../../");
  if (existsSync(path.join(candidate, "manifest.json"))) return candidate;
  return null;
}

// ---------------------------------------------------------------------------
// Individual checks
// ---------------------------------------------------------------------------

async function checkReleaseInstallation() {
  const check = new Check("release.installation");

  const releaseRoot = resolveReleaseRoot();
  if (!releaseRoot) {
    return check.warn("cannot find manifest.json — running from source checkout?");
  }

  const currentPath = sys("/opt/infra-cod/current");
  if (!existsSync(currentPath)) {
    return check.fail(`${currentPath} does not exist — nothing is installed`);
  }

  let resolved;
  try {
    resolved = realpathSync(currentPath);
  } catch (error) {
    return check.fail(`${currentPath} cannot be resolved: ${error.message}`);
  }

  if (resolved !== releaseRoot) {
    // Not a note. The release that is installed and the release that is running
    // disagree, which means a rollback or an upgrade stopped halfway and the
    // units are serving a tree nobody is checking.
    return check.fail(`current symlink points to ${resolved}, but this release is ${releaseRoot}`);
  }

  let manifest;
  try {
    manifest = JSON.parse(readFileSync(RELEASE_MANIFEST, "utf8"));
  } catch (error) {
    return check.fail(`manifest.json is not readable JSON: ${error.message}`);
  }

  return check.pass(`release ${manifest.version || "unknown"} at ${releaseRoot}`);
}

// Every service reaches its executable through /opt/infra-cod/current. A
// perfectly intact release is still unusable when an ancestor is 0700: systemd
// fails at WorkingDirectory with status=200/CHDIR before Node can log anything.
async function checkReleasePathPermissions() {
  const check = new Check("release.path_permissions");
  const expected = [
    [sys("/opt/infra-cod"), 0o755],
    [sys("/opt/infra-cod/releases"), 0o755],
  ];
  const issues = [];

  for (const [candidate, wantedMode] of expected) {
    let stat;
    try {
      stat = lstatSync(candidate);
    } catch (error) {
      issues.push(`${candidate} cannot be inspected (${error.message})`);
      continue;
    }
    if (stat.isSymbolicLink()) issues.push(`${candidate} is a symlink`);
    else if (!stat.isDirectory()) issues.push(`${candidate} is not a directory`);
    const mode = stat.mode & 0o7777;
    if (mode !== wantedMode) {
      issues.push(`${candidate} mode=0${mode.toString(8)} (expected 0${wantedMode.toString(8)})`);
    }
    if (stat.uid !== 0 || stat.gid !== 0) {
      issues.push(`${candidate} owner=${stat.uid}:${stat.gid} (expected 0:0)`);
    }
  }

  return issues.length > 0
    ? check.fail(issues.join(", "))
    : check.pass("release ancestors are root:root 0755");
}

// The install manifest is the only place the pinned Node and Caddy versions are
// written down, so a release that cannot produce it has lost the ability to
// check its own toolchain — silently, before this check existed.
async function checkInstallManifest() {
  const check = new Check("release.install_manifest");
  const releaseRoot = resolveReleaseRoot();
  if (!releaseRoot) return check.warn("not running from a release — skipped");

  const manifestPath = path.join(releaseRoot, "deploy/install-manifest.json");
  if (!existsSync(manifestPath)) {
    return check.fail(`${manifestPath} is missing — the pinned Node and Caddy versions cannot be checked`);
  }
  const pinned = pinnedVersions();
  if (!pinned.available) return check.fail(pinned.reason);
  return check.pass(`pins Node v${pinned.node}, Caddy v${pinned.caddy}`);
}

// The installed tree against the checksums it shipped with.
//
// Everything else here asks whether a file exists or a service is up. Nothing
// asked whether the code being executed is the code that was signed, which is
// the one question the whole release contract exists to answer — and a single
// edited file under /opt would have passed every other check in this command.
async function checkReleaseIntegrity() {
  const check = new Check("release.filesums");
  const releaseRoot = resolveReleaseRoot();
  if (!releaseRoot) return check.warn("not running from a release — skipped");

  const sums = path.join(releaseRoot, "FILESUMS.sha256");
  if (!existsSync(sums)) {
    return check.fail("FILESUMS.sha256 is missing — the installed tree cannot be verified");
  }
  const result = spawnSync("sha256sum", ["--quiet", "-c", "FILESUMS.sha256"], {
    cwd: releaseRoot,
    encoding: "utf8",
    // Thousands of files, so this is the slowest check here by a wide margin.
    // It is also the only one that can catch a tampered release.
    timeout: 180_000,
  });
  if (result.error) {
    return check.fail(`cannot verify the installed tree: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const failures = (result.stdout || "").split("\n").filter((line) => line.includes("FAILED"));
    const detail = failures.length > 0 ? failures.slice(0, 5).join("; ") : (result.stderr || "").slice(0, 300);
    return check.fail(`the installed release does not match FILESUMS.sha256: ${detail}`);
  }
  return check.pass("the installed tree matches FILESUMS.sha256");
}

// The OpenCode Go usage probe (ADR-0019): the one file in the release that
// runs as a runtime's user and reads its key. Its bytes are covered by
// release.filesums; this asks what that does not — that it is root's, and
// that no one else can write it.
export function usageProbeCheck(releaseRoot, { stat = lstatSync } = {}) {
  const check = new Check("runtime.usage_probe");
  if (!releaseRoot) return check.warn("not running from a release — skipped");
  const file = path.join(releaseRoot, "services/runtime-supervisor/provider-usage.mjs");
  let info;
  try {
    info = stat(file);
  } catch {
    return check.fail(`${file} is missing: OpenCode Go's limits cannot be read (ADR-0019)`);
  }
  if (!info.isFile()) return check.fail(`${file} is not a regular file`);
  if (info.uid !== 0) return check.fail(`${file} is owned by uid ${info.uid}, not root: a runtime's user could change what reads its key`);
  if (info.mode & 0o022) return check.fail(`${file} is writable by its group or others (mode ${(info.mode & 0o777).toString(8)})`);
  return check.pass("root-owned and writable only by root; its bytes are checked by release.filesums");
}

async function checkUsageProbe() {
  return usageProbeCheck(resolveReleaseRoot());
}

// Stage 12 M0: the model's tools cannot read the login beside them.
//
// runtime.sandbox_shell: the shell OpenCode's writing runs use is root's, and
// as opencode-worker it covers the login — the login directory is empty
// inside it. It fails closed (the command does not run), so a broken one
// stops work rather than exposing anything; this says why before a task does.
//
// runtime.codex_login: Codex hides its login by a permission profile, which
// 0.154.0 and older cannot hold beside the legacy Landlock flag they need.
export function sandboxShellCheck(releaseRoot, { stat = lstatSync, run = commandOutput } = {}) {
  const check = new Check("runtime.sandbox_shell");
  if (!releaseRoot) return check.warn("not running from a release — skipped");
  const file = path.join(releaseRoot, "services/runtime-supervisor/sandbox-shell/bash");
  let info;
  try {
    info = stat(file);
  } catch {
    return check.fail(`${file} is missing: OpenCode's writing runs cannot start a command`);
  }
  if (!info.isFile()) return check.fail(`${file} is not a regular file`);
  if (info.uid !== 0) return check.fail(`${file} is owned by uid ${info.uid}, not root`);
  if (info.mode & 0o022) return check.fail(`${file} is writable by its group or others (mode ${(info.mode & 0o777).toString(8)})`);
  if (!(info.mode & 0o001)) return check.fail(`${file} is not executable by a runtime's user (mode ${(info.mode & 0o777).toString(8)})`);
  const adapter = adapterFor("opencode");
  const login = path.posix.join(adapter.home, adapter.loginState[0]);
  const result = run("/usr/sbin/runuser", [
    "-u", adapter.user, "--", "/usr/bin/env", "-i", `HOME=${adapter.home}`, "PATH=/usr/bin:/bin",
    `INFRA_COD_HIDDEN_STATE=${hiddenState(adapter).join(":")}`,
    file, "-c", 'if [ -z "$(ls -A "$1" 2>/dev/null)" ]; then echo covered; else echo visible; fi', "sandbox-shell", login,
  ], { timeout: 20_000 });
  const answer = String(result.stdout ?? "").trim();
  if (answer === "covered") return check.pass(`${adapter.user}'s commands run in bubblewrap with ${login} covered`);
  if (answer === "visible") return check.fail(`${login} is visible inside the sandbox shell`);
  return check.fail(`the sandbox shell did not start as ${adapter.user}: ${String(result.stderr || result.error || `exit ${result.exitCode}`).split("\n")[0].slice(0, 200)}`);
}

export function codexLoginCheck(activeVersion) {
  const check = new Check("runtime.codex_login");
  if (!activeVersion) return check.warn("no active Codex version is recorded — skipped");
  if (versionInRange(activeVersion, ">=0.155.0")) {
    return check.pass(`Codex ${activeVersion}: commands run under a permission profile that denies ~/.codex`);
  }
  return check.warn(`Codex ${activeVersion} cannot hide its login from the model's shell (permission profiles need 0.155.0 or later); promote a later version`);
}

// Stage 12 M1: every run has a memory limit of its own. The supervisor sits in
// its own leaf and the memory controller is on for the run leaves; otherwise
// the supervisor runs as before, with no per-run limit, and this says so.
export function runMemoryLimitsCheck({ run = commandOutput, read = (file) => readFileSync(file, "utf8") } = {}) {
  const check = new Check("runtime.run_memory_limits");
  const unit = run("/usr/bin/systemctl", ["show", "-p", "ControlGroup", "--value", "infra-cod-runtime-supervisor.service"]);
  const group = String(unit.stdout ?? "").trim();
  if (!unit.ok || !group.startsWith("/")) return check.warn("the supervisor's cgroup is not known (is the unit running?) — skipped");
  const root = path.posix.join("/sys/fs/cgroup", group);
  let subtree = "";
  let supervisorProcs = "";
  try { subtree = read(path.posix.join(root, "cgroup.subtree_control")); } catch {}
  try { supervisorProcs = read(path.posix.join(root, "supervisor", "cgroup.procs")); } catch {}
  if (!/\bmemory\b/.test(subtree)) {
    return check.warn("runs have no memory limit of their own: the memory controller is not enabled below the supervisor (its log says why: run_cgroup.memory_limits)");
  }
  if (!supervisorProcs.trim()) return check.warn("the memory controller is on, but the supervisor is not in its own leaf");
  return check.pass("each run's leaf has memory.max; the supervisor runs in its own leaf");
}

async function checkLoginIsolation() {
  let codex = null;
  try { codex = readRuntimes().runtimes?.codex?.active?.version ?? null; } catch {}
  return [sandboxShellCheck(resolveReleaseRoot()), codexLoginCheck(codex), runMemoryLimitsCheck()];
}

async function checkNodeVersion() {
  const check = new Check("runtime.node_version");

  const nodeBin = sys("/opt/node/bin/node");
  if (!existsSync(nodeBin)) {
    return check.fail(`${nodeBin} does not exist`);
  }

  const result = commandOutput(nodeBin, ["--version"]);
  if (!result.ok) {
    return check.fail(`cannot run ${nodeBin}: ${result.stderr || result.error}`);
  }

  const version = result.stdout.trim();
  const pinned = pinnedVersions();
  if (pinned.available) {
    if (version !== `v${pinned.node}`) {
      return check.fail(`Node is ${version}, but the install manifest pins v${pinned.node}`);
    }
    return check.pass(`Node ${version} (pinned)`);
  }
  if (!version.startsWith("v24.")) {
    return check.warn(`Node version is ${version}, expected v24.x`);
  }
  // The version could not be checked against anything. Saying so is the point.
  return check.warn(`Node ${version}, unverified: ${pinned.reason}`);
}

async function checkRuntimeBinaries() {
  const checks = [];

  // The unit runs /usr/bin/caddy and nothing else, so that is the binary to
  // look at. `caddy version` on PATH could report a build on /usr/local/bin that
  // systemd will never start.
  const caddyCheck = new Check("runtime.caddy");
  const caddyBin = sys("/usr/bin/caddy");
  const pinned = pinnedVersions();
  if (!existsSync(caddyBin)) {
    caddyCheck.fail(`${caddyBin} does not exist — infra-cod-caddy.service runs exactly this path`);
  } else {
    const caddyResult = commandOutput(caddyBin, ["version"]);
    const reported = caddyResult.ok ? caddyResult.stdout.split(/\s+/)[0] : null;
    if (!reported) {
      caddyCheck.fail(`cannot run ${caddyBin}: ${caddyResult.stderr || caddyResult.error}`);
    } else if (pinned.available && reported !== `v${pinned.caddy}`) {
      caddyCheck.fail(`${caddyBin} is ${reported}, but the install manifest pins v${pinned.caddy}`);
    } else if (pinned.available) {
      caddyCheck.pass(`Caddy ${reported} at ${caddyBin} (pinned)`);
    } else {
      caddyCheck.warn(`Caddy ${reported} at ${caddyBin}, unverified: ${pinned.reason}`);
    }
  }
  checks.push(caddyCheck);

  // git is how every project workspace is cloned. A host without it installs
  // cleanly and then fails on the first project, which is exactly the kind of
  // late failure this command exists to move forward.
  const gitCheck = new Check("runtime.git");
  const gitResult = commandOutput("git", ["--version"]);
  if (gitResult.ok) {
    gitCheck.pass(gitResult.stdout.split("\n")[0]);
  } else {
    gitCheck.fail("git not found in PATH — project workspaces cannot be cloned");
  }
  checks.push(gitCheck);

  const msCheck = new Check("runtime.minisign");
  if (commandExists("minisign")) {
    msCheck.pass("minisign available");
  } else {
    msCheck.fail("minisign not found in PATH");
  }
  checks.push(msCheck);

  return checks;
}

async function checkPostgresqlClusters() {
  const checks = [];

  const pgLsResult = commandOutput("pg_lsclusters", ["--no-header"], { timeout: 5_000 });
  if (!pgLsResult.ok) {
    const c = new Check("postgresql.clusters");
    c.fail("pg_lsclusters failed: PostgreSQL may not be installed");
    return [c];
  }

  const lines = pgLsResult.stdout.split("\n").filter(Boolean);

  const mainCluster = new Check("postgresql.cluster_17_main_5432");
  const mainLine = lines.find((l) => /^17\s+main\s+5432\b/.test(l));
  if (mainLine) {
    const active = /\bonline\b/.test(mainLine);
    if (active) mainCluster.pass("online");
    else mainCluster.fail(`not online: ${mainLine}`);
  } else {
    mainCluster.fail("not found");
  }
  checks.push(mainCluster);

  const restoreCluster = new Check("postgresql.cluster_17_restore_5433");
  const restoreLine = lines.find((l) => /^17\s+restore\s+5433\b/.test(l));
  if (restoreLine) {
    const active = /\bonline\b/.test(restoreLine);
    if (active) restoreCluster.pass("online");
    else restoreCluster.warn(`not online: ${restoreLine}`);
  } else {
    restoreCluster.warn("not found");
  }
  checks.push(restoreCluster);

  return checks;
}

// The extensions the schema's own functions need, asked of the database rather
// than assumed from the ledger.
//
// `0001` creates pgcrypto and the ledger says `0001` ran — and the production
// host had no pgcrypto at all. A database can lose an extension a migration
// created; a restore that carried the schema and not the extension is the
// ordinary way, and the ledger has no opinion about it, because a ledger records
// what ran, not what survived.
//
// Nothing said so. `doctor` was green, and the failure surfaced instead under a
// button in the panel as "function digest(text, unknown) does not exist", which
// names neither the extension nor the host.
async function checkDatabaseExtensions() {
  const check = new Check("database.extensions");
  const pg = sys("/usr/lib/postgresql/17/bin/psql");
  if (!existsSync(pg)) return check.fail(`${pg} not found — the database cannot be asked`);

  // Asked by resolving the function, not by reading `pg_extension`: what matters
  // is whether `digest()` is callable from where the schema calls it, and an
  // extension installed into a schema nothing searches would satisfy the catalog
  // and fail the query.
  const result = spawnSync(pg, [
    "-h", sys("/var/run/postgresql"), "-p", "5432",
    "-U", "infra_migrator", "-d", "infra_cod", "-X", "-qAt",
    "-c", "SELECT to_regprocedure('digest(bytea,text)') IS NOT NULL",
  ], { encoding: "utf8", timeout: 5_000, env: { DATABASE_URL: "", PGPASSWORD: "" } });

  if (result.status !== 0) {
    return check.fail(`cannot ask the database for its extensions: ${result.stderr?.trim() || `exit ${result.status}`}`);
  }
  if (result.stdout.trim() !== "t") {
    return check.fail(
      "pgcrypto is missing or not on the search path: `digest()` does not resolve, "
      + "so every command submission fails — the panel shows this as "
      + "\"function digest(text, unknown) does not exist\". "
      + "`CREATE EXTENSION IF NOT EXISTS pgcrypto` repairs it; migration 0055 does that.",
    );
  }
  return check.pass("pgcrypto is installed and digest() resolves");
}

async function checkLedger() {
  const check = new Check("database.ledger");

  const pg = sys("/usr/lib/postgresql/17/bin/psql");
  if (!existsSync(pg)) {
    return check.fail(`${pg} not found — the migration ledger cannot be read`);
  }

  const result = spawnSync(pg, [
    "-h", sys("/var/run/postgresql"),
    "-p", "5432",
    "-U", "infra_migrator",
    "-d", "infra_cod",
    "-X", "-qAt",
    "-c", "SELECT count(*) FROM control_plane.schema_migrations",
  ], {
    encoding: "utf8",
    timeout: 5_000,
    env: { DATABASE_URL: "", PGPASSWORD: "" },
  });

  if (result.error || result.status !== 0) {
    // Unreachable is not the same as healthy. A ledger nobody can read is a
    // ledger nobody has checked, and the installer must not accept it.
    return check.fail(`cannot query migration ledger: ${result.stderr || result.error?.message || "exit " + result.status}`);
  }

  const count = parseInt(result.stdout.trim(), 10);
  if (Number.isNaN(count) || count === 0) {
    return check.fail("migration ledger is empty — schema may not be migrated");
  }

  // A count that differs from the manifest is two different facts, and calling
  // both critical was wrong in the direction that matters.
  //
  // Fewer applied than the release carries means migrations this code needs have
  // not run: the schema is behind, and that is broken.
  //
  // *More* applied than the release carries is what a permitted rollback leaves
  // behind, by design. `infra-cod rollback` allows an application-only rollback
  // exactly when the release being returned to can still read the schema that is
  // there, so the ledger is ahead and the host is healthy. The first real
  // rollback across an additive migration was reported as a critically broken
  // host for precisely this reason — and, because the rollback consults doctor
  // before declaring itself healthy, it also made a correct rollback exit
  // non-zero.
  //
  // So the extra migrations are judged by the same contract the coordinator
  // uses: the compatibility declaration of the installed releases that carry
  // them. Anything nothing vouches for stays critical, because unknown
  // compatibility is not compatibility.
  const releaseRoot = resolveReleaseRoot();
  if (!releaseRoot) return check.pass(`${count} migrations applied`);

  let manifest;
  try {
    manifest = JSON.parse(readFileSync(path.join(releaseRoot, "manifest.json"), "utf8"));
  } catch {
    return check.pass(`${count} migrations applied`);
  }
  const expected = manifest.database?.migrationCount;
  if (!expected || count === expected) return check.pass(`${count} migrations applied`);
  if (count < expected) {
    return check.fail(`ledger has ${count} migrations, but this release carries ${expected}; the schema is behind the code`);
  }

  const ahead = migrationsAheadOfRelease(manifest);
  if (ahead === null) {
    return check.fail(`ledger has ${count} migrations, but this release carries ${expected}, and the ledger versions could not be read`);
  }
  const unvouched = ahead.filter((version) => !declaredCompatibleBySomeInstalledRelease(version));
  if (unvouched.length > 0) {
    return check.fail(
      `the schema is ahead of this release by ${ahead.join(", ")}, and nothing installed declares `
      + `${unvouched.join(", ")} readable by it — old code may be running against a schema it cannot read`,
    );
  }
  return check.pass(
    `${count} migrations applied; ${ahead.join(", ")} are ahead of this release and declared compatible with it, `
    + "which is what a rollback leaves behind",
  );
}

// The ledger versions this release does not carry.
function migrationsAheadOfRelease(manifest) {
  const pg = sys("/usr/lib/postgresql/17/bin/psql");
  const result = spawnSync(pg, [
    "-h", sys("/var/run/postgresql"), "-p", "5432", "-U", "infra_migrator", "-d", "infra_cod",
    "-X", "-qAt", "-c", "SELECT version FROM control_plane.schema_migrations ORDER BY version",
  ], { encoding: "utf8", timeout: 5_000, env: { DATABASE_URL: "", PGPASSWORD: "" } });
  if (result.error || result.status !== 0) return null;

  const latest = String(manifest.database?.latestMigration ?? "").slice(0, 4);
  if (!/^\d{4}$/.test(latest)) return null;
  return result.stdout.split("\n").map((line) => line.trim()).filter(Boolean).filter((version) => version > latest);
}

// Does any installed release declare this migration readable by the release
// before it? The contract travels in each release's manifest, so the release
// that introduced the migration is the one that can answer.
function declaredCompatibleBySomeInstalledRelease(version) {
  const releases = sys("/opt/infra-cod/releases");
  let entries = [];
  try {
    entries = readdirSync(releases);
  } catch {
    return false;
  }
  const manifests = [];
  for (const entry of entries) {
    try {
      manifests.push(JSON.parse(readFileSync(path.join(releases, entry, "manifest.json"), "utf8")));
    } catch {
      continue;
    }
  }
  return declaredCompatibleFor(version, manifests);
}

// Exported so the judgement can be tested without a host: given the manifests of
// the installed releases, is this migration declared readable by the release
// before it? An explicit incompatibility wins over anything else, and silence is
// never a yes.
//
// A release may only speak for migrations it actually carries. Without that, the
// check was fail-open in the one direction that matters: a contract summarises
// *exceptions*, so "past the boundary and in neither list" was read as a
// declaration of compatibility even for migrations the release had never heard
// of. A host whose ledger held a migration from nowhere — the state a restored
// or hand-migrated database can be in — was reported healthy by a release that
// stopped at 0050.
export function declaredCompatibleFor(version, manifests) {
  let vouched = false;
  for (const manifest of manifests) {
    const contract = manifest?.database?.compatibility;
    if (!contract || contract.contract !== "infra-cod/schema-compatibility/1") continue;

    const carriedThrough = String(manifest?.database?.latestMigration ?? "").slice(0, 4);
    if (!/^\d{4}$/.test(carriedThrough) || version > carriedThrough) continue;

    if ((contract.backwardIncompatible ?? []).includes(version)) return false;
    if ((contract.unverified ?? []).includes(version)) continue;
    if (version > contract.unverifiedThrough) vouched = true;
  }
  return vouched;
}

// Every socket the supervisor publishes, not only the first one.
//
// `github-workspace-broker.sock` is how the GitHub worker reaches a workspace.
// Checking one of the supervisor's sockets meant another control channel could
// have the wrong group or be missing outright and the report still said the
// sockets were fine.
//
// The worker tool sockets are not here: since WP-9b there is one per run, owned
// by the run's runtime account, under WORKER_TOOL_SOCKET_ROOT, and they are
// checked below — the root's ownership and mode, and any socket nobody listens
// on any more.
const SUPERVISOR_SOCKETS = [
  { path: "/run/infra-cod/runtime-supervisor.sock", group: "infra-control", mode: 0o660 },
  { path: "/run/infra-cod/github-workspace-broker.sock", group: "infra-cod-github", mode: 0o660 },
];
const WORKER_TOOL_SOCKET_ROOT = "/run/infra-cod/worker-tools";

async function checkSocketPermissions() {
  const checks = [];

  // A missing socket means one of two different things, and they are not both
  // notes: if the supervisor is running, the socket it publishes on start is
  // gone, and everything that talks to it is broken.
  const supervisor = commandOutput("systemctl", ["is-active", "infra-cod-runtime-supervisor.service"], { timeout: 5_000 });
  const supervisorActive = supervisor.ok && supervisor.stdout.trim() === "active";

  for (const socket of SUPERVISOR_SOCKETS) {
    const sockPath = sys(socket.path);
    const c = new Check(`systemd.socket.${path.basename(socket.path)}`);
    if (!existsSync(sockPath)) {
      if (supervisorActive) c.fail("missing while infra-cod-runtime-supervisor.service is active");
      else c.warn("not found (the runtime supervisor is not running)");
      checks.push(c);
      continue;
    }

    let stat;
    try { stat = lstatSync(sockPath); } catch { c.fail(`cannot read ${sockPath}`); checks.push(c); continue; }
    const mode = stat.mode & 0o777;
    const groupName = groupNameFromGid(stat.gid);

    // The owner was declared and never compared before. A socket owned by
    // somebody other than root is a socket somebody other than root can replace,
    // and the group and mode say nothing about that.
    const issues = [];
    if (!stat.isSocket()) issues.push("is not a socket");
    if (stat.uid !== 0) issues.push(`owner uid=${stat.uid} (expected root)`);
    if (groupName !== socket.group) issues.push(`group=${groupName} (expected ${socket.group})`);
    if (mode !== socket.mode) issues.push(`mode=0${mode.toString(8)} (expected 0${socket.mode.toString(8)})`);

    // Critical, not a note: these are the control channels for every runtime
    // agent, and a wrong owner or a wider mode is a way in.
    if (issues.length > 0) c.fail(`${sockPath}: ${issues.join(", ")}`);
    else c.pass("correct owner/group/mode");
    checks.push(c);
  }

  checks.push(...await checkRunToolSockets(supervisorActive));
  return checks;
}

// The per-run worker tool sockets (WP-9b). The root is the supervisor's, 0711,
// so an account reaches the run it was told about and lists nothing. A socket
// that refuses a connection is one a supervisor left when it died: the
// supervisor sweeps them at start and every minute, so one seen here means the
// sweep is not running — reported, and named, rather than left looking healthy.
async function checkRunToolSockets(supervisorActive) {
  const rootPath = sys(WORKER_TOOL_SOCKET_ROOT);
  const root = new Check("systemd.socket.worker-tools");
  const stale = new Check("systemd.socket.worker-tools.stale");
  if (!existsSync(rootPath)) {
    if (supervisorActive) root.fail(`${rootPath} is missing while infra-cod-runtime-supervisor.service is active`);
    else root.warn("not found (the runtime supervisor is not running)");
    stale.pass("no run sockets");
    return [root, stale];
  }
  const info = lstatSync(rootPath);
  const issues = [];
  if (!info.isDirectory()) issues.push("is not a directory");
  if (info.uid !== 0 || info.gid !== 0) issues.push(`owner ${info.uid}:${info.gid} (expected root:root)`);
  if ((info.mode & 0o777) !== 0o711) issues.push(`mode=0${(info.mode & 0o777).toString(8)} (expected 0711)`);
  if (issues.length) root.fail(`${rootPath}: ${issues.join(", ")}`);
  else root.pass("root-owned, 0711; one socket per run");
  const found = await staleRunToolSockets(rootPath);
  if (found.length) {
    stale.warn(`${found.length} run tool socket(s) with no listener: ${found.join(", ")} — the supervisor removes these at start and every minute; restart it if they persist`);
  } else {
    stale.pass("every run tool socket has its run");
  }
  return [root, stale];
}

// The supplementary groups the control plane needs in order to reach those
// sockets and the shared workspace root. Losing one produces an installation
// that starts and then cannot do its job.
const REQUIRED_MEMBERSHIPS = [
  { user: "infra-control", group: "opencode-worker" },
  { user: "infra-cod-github", group: "agent-workspace" },
];

async function checkGroupMemberships() {
  const checks = [];
  for (const { user, group } of REQUIRED_MEMBERSHIPS) {
    const c = new Check(`users.${user}_in_${group}`);
    const result = commandOutput("getent", ["group", group], { timeout: 5_000 });
    if (!result.ok) {
      c.fail(`group ${group} does not exist`);
    } else {
      const members = (result.stdout.split(":")[3] ?? "").split(",").filter(Boolean);
      if (members.includes(user)) c.pass(`${user} is a member of ${group}`);
      else c.fail(`${user} is not a member of ${group}`);
    }
    checks.push(c);
  }
  return checks;
}

// The agent runtimes the installer deliberately does not install.
//
// `deploy/install-manifest.json` records that decision: the Codex and OpenCode
// CLIs are credential-bearing tools with their own release cadence, provisioned
// per operator rather than pinned to an infra-cod release. That makes their
// absence expected on a fresh host — and it makes it something the operator has
// to be told, because the panel comes up either way and the first agent task is
// where it would otherwise surface, as ENOENT.
const RUNTIME_PATH = ["/usr/local/bin", "/usr/bin", "/bin"];

// The runtimes, asked the way production asks them.
//
// Stage 10 ran `--version` as root and reported the answer. That is a different
// question from the one that matters: the supervisor launches these binaries as
// `codex-worker` and `opencode-worker`, through `runuser` and a scrubbed
// environment, and an installation can pass the root version of the question
// while failing the real one — which is exactly how this host reached
// acceptance with runtimes nothing could execute.
//
// The four states are reported separately, because they fail separately. A
// binary that is present and unauthenticated is a different problem from one
// that is authenticated and unverified, and a panel that shows them as one
// number tells an operator to fix the wrong thing.
export async function checkAgentRuntimes({
  probe = runAsRuntimeUser, runtimes = null, hostProbe = probeHostRequirement, hashExecutable = executableDigest,
} = {}) {
  const checks = [];
  const inventory = runtimes ?? (() => {
    try {
      return readRuntimes().runtimes;
    } catch (error) {
      return { __unreadable: error.message };
    }
  })();

  if (inventory.__unreadable) {
    const check = new Check("runtime.inventory");
    check.fail(`${RUNTIMES_FILE} could not be read: ${inventory.__unreadable}`);
    return [check];
  }

  for (const name of runtimeNames()) {
    const adapter = adapterFor(name);
    const check = new Check(`runtime.agent_cli.${name}`);
    const entry = inventory[name];

    if (!entry?.active) {
      check.warn(
        `${name} is not provisioned — agent sessions will fail until it is. `
        + `Install it with \`infra-cod runtime install ${name}\`.`,
      );
      checks.push(check);
      continue;
    }

    // The probe runs as the runtime's own user. If this process cannot do that —
    // it is not root, or `runuser` is absent — the honest answer is that the
    // question was not asked, never the answer root would have given.
    // A probe that refuses to run — a missing runtime home is the case that
    // reaches here — is a finding, not a crash: doctor's job is to report the
    // state of the host, including the states where nothing can be asked.
    const ask = (args) => {
      try {
        return probe(adapter, args);
      } catch (error) {
        return { ok: false, code: null, stdout: "", stderr: error.message };
      }
    };

    const version = ask(adapter.versionProbe);
    if (!version.ok && /not permitted|must be (root|run as root)|Permission denied/i.test(version.stderr)) {
      check.warn(
        `${name} could not be probed as ${adapter.user}: ${version.stderr.split("\n")[0]}. `
        + "Running the probe as root would answer a question production never asks.",
      );
      checks.push(check);
      continue;
    }
    if (!version.ok) {
      check.fail(
        `${name} ${entry.active.version} is recorded as active, but ${adapter.user} cannot run it: `
        + `${version.stderr.split("\n")[0] || `exit ${version.code}`}`,
      );
      checks.push(check);
      continue;
    }

    const reported = version.stdout.split("\n")[0] ?? "";
    if (!reported.includes(entry.active.version)) {
      check.fail(
        `${name} on PATH reports ${JSON.stringify(reported)}, but ${RUNTIMES_FILE} records `
        + `${entry.active.version} as active`,
      );
      checks.push(check);
      continue;
    }
    check.pass(`${name} ${entry.active.version} runs as ${adapter.user}: ${reported}`);
    checks.push(check);

    // The version its driver's capabilities were shown at, against the one this
    // host runs (WP-5b). A different version may well work; what it has not
    // done is show that it does, so it is reported rather than refused —
    // RUNTIME_CONTRACT §13 blocks only an unknown major version.
    const driver = driverFor(name);
    const verified = new Check(`runtime.driver_verified.${name}`);
    const verification = capabilityVerification(driver, entry.active.version, { qualification: activeQualification(entry) });
    if (verification.status === "verified" && verification.verified_by !== "baseline") {
      verified.pass(`${name} ${entry.active.version} is verified by a ${verification.verified_by} (the driver's baseline is ${pairOf(driver)})`);
    } else if (verification.status === "verified") {
      verified.pass(`${name} ${entry.active.version} is the version its driver was verified at (${pairOf(driver)})`);
    } else {
      verified.warn(
        `${name} ${entry.active.version} is not the version its driver was verified at (${pairOf(driver)}); `
        + "its capabilities are unverified at this version until the driver's evidence is produced again for it",
      );
    }
    checks.push(verified);

    // A runtime that can change its own version is a different host tomorrow
    // than it is today. Stage 11.1 requires the control; where it could not be
    // established, the report says so rather than staying quiet.
    const policy = entry.verification?.autoUpdate ?? null;
    const selfUpdate = new Check(`runtime.self_update.${name}`);
    if (policy?.verified) selfUpdate.pass(`${name} self-update is disabled through ${policy.setting}`);
    else if (policy?.acceptedUnmanaged) {
      // The record describes the install; a later release may since have
      // established the control, and then re-recording it is one command.
      const now = adapter.autoUpdate?.mechanism
        ? `; this release establishes ${adapter.autoUpdate.setting} — \`infra-cod runtime install ${name} --version ${entry.active.version}\` records it`
        : "";
      selfUpdate.warn(
        `${name} was installed with self-update unmanaged at ${policy.acceptedBy}'s explicit request `
        + `(${policy.reason}); its version can change without an operator asking${now}`,
      );
    } else {
      selfUpdate.fail(`${name} self-update is not disabled (${policy?.reason ?? "no record of the control"})`);
    }
    checks.push(selfUpdate);

    // The executable on disk, against the one the signed package carried
    // (Stage 12 W1). Whatever changes it — a self-update the controls above
    // missed, a hand edit, a restore from somewhere else — it shows here.
    const digest = new Check(`runtime.executable_digest.${name}`);
    const installation = (entry.installed ?? []).find((installed) => installed.directory === entry.active.directory);
    if (!installation?.executableSha256) {
      digest.warn(
        `${name} ${entry.active.version} has no recorded executable digest (installed before it was recorded); `
        + `\`infra-cod runtime install ${name} --version ${entry.active.version}\` records it`,
      );
    } else {
      try {
        const actual = hashExecutable(path.join(entry.active.directory, adapter.executablePath));
        if (actual === installation.executableSha256) {
          digest.pass(`${name} ${entry.active.version} is the executable its package carried (sha256 ${actual.slice(0, 12)}…)`);
        } else {
          digest.fail(`${name}'s executable has changed since it was installed (recorded ${installation.executableSha256.slice(0, 12)}…, now ${actual.slice(0, 12)}…)`);
        }
      } catch (error) {
        digest.fail(`${name}'s executable could not be read: ${error.message}`);
      }
    }
    checks.push(digest);

    // What each version of this runtime needs from the host (Stage 12 W1).
    // Needed by the active version: a failure. Needed only by other versions:
    // a warning, so the day an update is asked for, the reason it cannot work
    // is already on the page.
    for (const declared of adapter.hostRequirements ?? []) {
      const known = HOST_REQUIREMENTS[declared.requirement];
      const label = known?.label ?? declared.requirement;
      const requirement = new Check(`runtime.host_requirement.${name}.${declared.requirement}`);
      const scope = declared.versions === "*" ? `every ${name} version` : `${name} ${declared.versions}`;
      let found;
      try {
        found = hostProbe(declared.requirement, adapter);
      } catch (error) {
        found = { met: false, detail: error.message };
      }
      if (found.met) requirement.pass(`${label}: met, needed by ${scope} — ${found.detail}`);
      else if (versionInRange(entry.active.version, declared.versions)) {
        requirement.fail(`${label}: not met, and the active ${name} ${entry.active.version} needs it (${known?.why ?? scope}) — ${found.detail}`);
      } else {
        requirement.warn(
          `${label}: not met; needed by ${scope}, not by the active ${entry.active.version}. `
          + `${known?.why ? `${known.why}. ` : ""}${known?.decision ? `Owner decision: ${known.decision}. ` : ""}${found.detail}`,
        );
      }
      checks.push(requirement);
    }

    // What is on PATH, against what the record says. A crash between the symlink
    // and the inventory write leaves the two describing different installations,
    // and every reader afterwards — this one included — would otherwise report
    // confidently about a host that does not exist.
    const agreement = new Check(`runtime.record_agrees.${name}`);
    try {
      const state = reconciliationOf(name);
      if (state.agree && !state.intent) agreement.pass(`${name} on PATH is the installation ${RUNTIMES_FILE} describes`);
      else if (state.agree) {
        agreement.warn(`${name} has a record of an interrupted switch that in fact completed; \`infra-cod runtime reconcile ${name} --apply\` clears it`);
      } else {
        agreement.fail(
          `${name} on PATH is not the installation ${RUNTIMES_FILE} describes `
          + `(PATH: ${state.target ?? "nothing"}; recorded: ${state.recorded ?? "nothing"}). `
          + `Run \`infra-cod runtime reconcile ${name}\`.`,
        );
      }
    } catch (error) {
      agreement.fail(`${name}'s record could not be compared with what is on PATH: ${error.message}`);
    }
    checks.push(agreement);

    // Authentication is its own check, and its message never carries the
    // runtime's output: an auth probe prints account state, and account state is
    // not something a health report repeats.
    //
    // Asked through the same function the panel's readiness uses, rather than by
    // reading the probe's exit code here. They were two readings of one question
    // and could disagree — and would have: `opencode auth list` exits 0 with an
    // empty store, so this check passed on a host with no credential while
    // nothing else did.
    const auth = new Check(`runtime.auth.${name}`);
    let credentials;
    try {
      credentials = authenticationOf(adapter, { probe });
    } catch (error) {
      credentials = { ok: false, detail: error.message };
    }
    if (credentials.ok) auth.pass(`${adapter.user} holds a usable ${name} credential`);
    else auth.warn(`${adapter.user} holds no usable ${name} credential (${credentials.detail}); the first agent task will fail`);
    checks.push(auth);
  }

  return checks;
}

async function checkSystemdTarget() {
  const check = new Check("systemd.target");

  const result = commandOutput("systemctl", ["is-active", "infra-cod.target"], { timeout: 5_000 });
  const active = result.ok ? result.stdout.trim() : "inactive";
  if (active === "active") {
    return check.pass("infra-cod.target is active");
  }
  return check.warn(`infra-cod.target is ${active}`);
}

// Unit files named for this product that the release does not ship.
//
// An update retires the units it installed and the next release no longer
// declares (install-reconcile.mjs), so after 11.2 N3 renamed the two workers
// no `infra-cod-codex-chat-worker` or `infra-cod-executor-worker` should be
// left. One that is — a retirement that failed and was left for the next
// reconcile, or a unit copied in by hand — is named here. A warning, not a
// failure: a unit an operator wrote under this prefix is theirs, and
// reconcile never touches what it did not install.
export function staleUnitFiles(listing, contract = unitFileNames()) {
  const shipped = new Set(contract);
  return listing.split("\n")
    .map((line) => line.trim().split(/\s+/))
    .filter(([name]) => /^infra-cod[.-]/.test(name ?? ""))
    .filter(([name]) => !shipped.has(name))
    .map(([name, state]) => ({ name, state: state ?? "unknown" }));
}

// Empty workspaces provisioned before rc.48 whose seeded AGENTS.md was never
// committed. Every first publish of such a project is refused — the approved
// tree holds a file no commit does — so the operator is told which projects,
// and nothing is committed for them: the tree is the operator's.
//
// Read from the files under .git, not by running git: git is never run as root
// (ADR-0015 §4). A workspace has no commit when the branch its HEAD names is
// neither a loose ref nor in packed-refs.
export function uncommittedSeedWorkspaces(root) {
  let entries;
  try { entries = readdirSync(root, { withFileTypes: true }); } catch { return []; }
  const found = [];
  for (const entry of entries.filter((item) => item.isDirectory())) {
    const workspace = path.join(root, entry.name);
    const gitDirectory = path.join(workspace, ".git");
    if (!existsSync(path.join(workspace, "AGENTS.md")) || !existsSync(gitDirectory)) continue;
    let head;
    try { head = readFileSync(path.join(gitDirectory, "HEAD"), "utf8").trim(); } catch { continue; }
    const ref = /^ref: (refs\/heads\/[^\s]+)$/.exec(head)?.[1];
    if (!ref) continue;
    if (existsSync(path.join(gitDirectory, ref))) continue;
    let packed = "";
    try { packed = readFileSync(path.join(gitDirectory, "packed-refs"), "utf8"); } catch {}
    if (packed.split("\n").some((line) => line.trim().endsWith(` ${ref}`))) continue;
    found.push(entry.name);
  }
  return found.sort();
}

async function checkWorkspaceSeeds() {
  const check = new Check("workspaces.seed_uncommitted");
  const root = INSTALLATION_LAYOUT.workspaceRoot.path;
  const found = uncommittedSeedWorkspaces(root);
  if (found.length) {
    check.warn(`${found.join(", ")}: no commit yet, and the seeded AGENTS.md is outside every commit, so the project's first publish will be refused — `
      + "commit AGENTS.md in that workspace, as its owner, or have the first task's executor commit it");
  } else {
    check.pass(`every workspace under ${root} with a seed has a commit`);
  }
  return [check];
}

async function checkSystemdUnits() {
  const checks = [];

  const staleCheck = new Check("systemd.units.stale");
  const listed = commandOutput("systemctl", ["list-unit-files", "--no-legend", "--plain", "infra-cod*"], { timeout: 5_000 });
  if (!listed.ok) {
    staleCheck.warn(`could not list unit files: ${listed.stderr || listed.error || "systemctl failed"}`);
  } else {
    const stale = staleUnitFiles(listed.stdout);
    if (stale.length) {
      staleCheck.warn(`${stale.map(({ name, state }) => `${name} (${state})`).join(", ")} ${stale.length === 1 ? "is" : "are"} installed and not part of this release — `
        + "an update retires what it installed; if one is left, stop, disable and remove it, unless it is your own");
    } else {
      staleCheck.pass("every infra-cod unit file is one this release ships");
    }
  }
  checks.push(staleCheck);

  // The database's real unit. `postgresql.service` is a meta-unit that stays
  // inactive while the cluster runs perfectly well, so asking it is asking the
  // wrong question and getting a confident wrong answer.
  const pgCheck = new Check(`systemd.unit.${POSTGRESQL_UNIT}`);
  const pgResult = commandOutput("systemctl", ["is-active", POSTGRESQL_UNIT], { timeout: 5_000 });
  const pgStatus = pgResult.ok ? pgResult.stdout.trim() : "inactive";
  if (pgStatus === "active") pgCheck.pass("active");
  else pgCheck.fail(`inactive: ${pgStatus}`);
  checks.push(pgCheck);

  for (const unit of LONG_RUNNING_SERVICES) {
    const c = new Check(`systemd.unit.${unit}`);
    const result = commandOutput("systemctl", ["is-active", `${unit}.service`], { timeout: 5_000 });
    const status = result.ok ? result.stdout.trim() : "inactive";
    if (status === "active") c.pass("active");
    else c.fail(`inactive: ${status}`);
    checks.push(c);
  }

  // A completed oneshot is `inactive`, so `is-active` is the wrong question for
  // these and Result=success is the right one.
  for (const unit of ONESHOT_SERVICES) {
    const c = new Check(`systemd.unit.${unit}`);
    const result = commandOutput("systemctl", ["show", "--property=Result", "--value", `${unit}.service`], { timeout: 5_000 });
    const unitResult = result.ok ? result.stdout.trim() : "unknown";
    if (unitResult === "success") c.pass("completed successfully");
    else c.warn(`last result: ${unitResult}`);
    checks.push(c);
  }

  for (const timer of TIMERS) {
    const c = new Check(`systemd.timer.${timer}`);
    const result = commandOutput("systemctl", ["is-active", `${timer}.timer`], { timeout: 5_000 });
    const status = result.ok ? result.stdout.trim() : "inactive";
    if (status === "active") c.pass("active");
    else c.warn("inactive or missing");
    checks.push(c);
  }

  return checks;
}


// The files that hold, or gate, every secret on the box.
//
// `required` says whether the installer is supposed to have created the file, so
// that "missing" can be told apart from "this feature was never configured".
// Wrong ownership or a wider mode is always critical, whatever the file: a
// world-readable pepper is not a note for the operator to get to later, and an
// installer that treats it as one reports a healthy install of a system anyone
// on the host can read the password hashes' key out of.
const SECRET_FILES = [
  { path: "/etc/infra-cod/.generated-secrets", expectedGroup: "root", expectedMode: 0o600, required: true },
  { path: "/etc/infra-cod/database.env", expectedGroup: "root", expectedMode: 0o640, required: true },
  { path: "/etc/infra-cod/web.env", expectedGroup: "infra-web", expectedMode: 0o640, required: true },
  { path: "/etc/infra-cod/caddy.env", expectedGroup: "caddy", expectedMode: 0o640, required: true },
  { path: "/etc/infra-cod/github-app.env", expectedGroup: "infra-cod-github", expectedMode: 0o640, required: true },
  { path: "/etc/infra-cod/backup.passphrase", expectedGroup: "root", expectedMode: 0o600, required: true },
  { path: "/etc/infra-cod/opencode/broker-private.pem", expectedGroup: "infra-control", expectedMode: 0o640, required: true },
];

async function checkSecrets() {
  const checks = [];

  for (const entry of SECRET_FILES) {
    const secretPath = sys(entry.path);
    const c = new Check(`secrets.${entry.path.replace(/[^a-z0-9.-]/g, "_")}`);
    if (!existsSync(secretPath)) {
      if (entry.required) {
        c.fail("does not exist — the installation is incomplete");
      } else {
        c.warn("does not exist — not configured");
      }
      checks.push(c);
      continue;
    }

    let stat;
    try {
      // lstat: a symlink planted in place of a secret must be reported as one,
      // not silently followed to whatever it points at.
      stat = lstatSync(secretPath);
    } catch { c.fail("cannot read file metadata"); checks.push(c); continue; }

    const mode = stat.mode & 0o777;
    const groupName = groupNameFromGid(stat.gid);

    const issues = [];
    if (stat.isSymbolicLink()) issues.push("is a symlink");
    else if (!stat.isFile()) issues.push("is not a regular file");
    if (stat.uid !== 0) issues.push(`owner uid=${stat.uid} (expected root)`);
    if (groupName !== entry.expectedGroup) issues.push(`group=${groupName} (expected ${entry.expectedGroup})`);
    if (mode !== entry.expectedMode) issues.push(`mode=0${mode.toString(8)} (expected 0${entry.expectedMode.toString(8)})`);

    if (issues.length > 0) c.fail(`${issues.join(", ")}`);
    else c.pass("exists with correct owner/group/mode");
    checks.push(c);
  }

  return checks;
}

// The public key the panel serves has to be the public half of the key the
// broker holds. A stale one from a previous installation passes every
// permission check and every existence check, and then no OpenCode credential
// enrolled against it can ever be decrypted.
async function checkBrokerKeypair() {
  const check = new Check("secrets.broker_keypair");
  const privateKey = sys("/etc/infra-cod/opencode/broker-private.pem");
  const publicKey = sys("/etc/infra-cod/opencode/broker-public.pem");

  if (!existsSync(privateKey) || !existsSync(publicKey)) {
    return check.fail("the broker keypair is incomplete");
  }
  const derived = commandOutput("openssl", ["rsa", "-pubout", "-in", privateKey]);
  if (!derived.ok) {
    return check.fail(`cannot read ${privateKey} as an RSA private key`);
  }
  let stored;
  try {
    stored = readFileSync(publicKey, "utf8");
  } catch (error) {
    return check.fail(`cannot read ${publicKey}: ${error.message}`);
  }
  if (stored.trim() !== derived.stdout.trim()) {
    return check.fail(`${publicKey} is not the public half of ${privateKey}`);
  }
  return check.pass("the broker public key matches the private key");
}

function groupNameFromGid(gid) {
  try {
    const result = spawnSync("getent", ["group", String(gid)], { encoding: "utf8", timeout: 2_000 });
    if (result.status === 0) return result.stdout.split(":")[0];
  } catch { /* fall through */ }
  return String(gid);
}

// The command the documentation tells an operator to run.
//
// A shim left behind by an older release still executes, and then points at a
// Node or a release path that no longer exists — so `infra-cod doctor` fails in a
// way that reads as a broken installation rather than a stale command.
// The directories systemd mounts into a unit's namespace, against the contract.
//
// Existence was the only thing checked here, and existence is not the property
// that matters on its own: `.codex` and `.local` hold the agents' credentials,
// so a directory that is there with mode 0777, or owned by the wrong account, is
// a finding and not a pass. Owner, group and mode all come from
// `unit-contract.mjs`, which is the same list tmpfiles declares.
// Which layout the host is on (WP-5c). A host half-way between the two is a
// finding, not a healthy host: every other path check would pass for whichever
// half it looked at.
async function checkHostLayout() {
  const c = new Check("layout.host");
  let state;
  try { state = detectLayout(); } catch (error) { c.fail(`the host layout could not be read: ${error.message}`); return [c]; }
  if (state.layout === "current") c.pass(`${state.target.user}, ${state.target.workspaceRoot}`);
  else if (state.layout === "legacy") c.warn(`still on the proof-of-concept layout (${state.legacy.user}, ${state.legacy.workspaceRoot}); \`infra-cod update\` moves it`);
  else if (state.layout === "fresh") c.warn(`neither ${state.legacy.user} nor ${state.target.user} exists yet`);
  else c.fail(`on neither layout: ${JSON.stringify(state.facts)}; see layout-migration.mjs plan`);
  return [c];
}

async function checkRuntimeSandboxPaths() {
  const checks = [];
  for (const entry of RUNTIME_SANDBOX_PATHS) {
    const c = new Check(`systemd.sandbox_path.${entry.path.replace(/[^a-z0-9.-]/g, "_")}`);
    const full = sys(entry.path);
    if (!existsSync(full)) {
      c.fail(`${full} does not exist — the units that mount it cannot build their namespace`);
      checks.push(c);
      continue;
    }
    let stat;
    try { stat = lstatSync(full); } catch (error) { c.fail(`cannot read ${full}: ${error.message}`); checks.push(c); continue; }

    const issues = [];
    if (stat.isSymbolicLink()) issues.push("is a symlink");
    else if (!stat.isDirectory()) issues.push("is not a directory");

    const owner = userNameFromUid(stat.uid);
    if (owner !== entry.owner) issues.push(`owner=${owner} (expected ${entry.owner})`);
    const group = groupNameFromGid(stat.gid);
    if (group !== entry.group) issues.push(`group=${group} (expected ${entry.group})`);
    // The setgid bit is part of the mode for the gate root, so the comparison
    // covers all four digits rather than the permission bits alone.
    const mode = stat.mode & 0o7777;
    if (mode !== entry.mode) issues.push(`mode=0${mode.toString(8)} (expected 0${entry.mode.toString(8)})`);

    if (issues.length > 0) c.fail(`${full}: ${issues.join(", ")}`);
    else c.pass(`${full} (${owner}:${group} 0${mode.toString(8)})`);
    checks.push(c);
  }
  return checks;
}

function userNameFromUid(uid) {
  try {
    const result = spawnSync("getent", ["passwd", String(uid)], { encoding: "utf8", timeout: 2_000 });
    if (result.status === 0) return result.stdout.split(":")[0];
  } catch { /* fall through */ }
  return String(uid);
}

async function checkCliShim() {
  const check = new Check("runtime.cli_shim");
  const shimPath = sys("/usr/local/bin/infra-cod");

  if (!existsSync(shimPath)) {
    return check.fail(`${shimPath} does not exist — the documented \`infra-cod\` command is not installed`);
  }
  let stat;
  try { stat = lstatSync(shimPath); } catch (error) { return check.fail(`cannot read ${shimPath}: ${error.message}`); }
  const mode = stat.mode & 0o777;

  // Every complaint at once. Reporting only the first means an operator fixes
  // the ownership, re-runs, and learns the shim also names the wrong release.
  const issues = [];
  if (stat.isSymbolicLink()) issues.push("is a symlink");
  else if (!stat.isFile()) issues.push("is not a regular file");
  if (stat.uid !== 0) issues.push(`owner uid=${stat.uid} (expected root)`);
  if (mode !== 0o755) issues.push(`mode=0${mode.toString(8)} (expected 0755)`);

  let body = null;
  try { body = readFileSync(shimPath, "utf8"); } catch (error) { issues.push(`cannot be read: ${error.message}`); }

  if (body !== null) {
    // It has to run the pinned Node against whatever `current` resolves to. A
    // shim naming a release directly would survive a rollback and keep running
    // the release that was rolled back.
    if (!body.includes("/opt/node/bin/node")) {
      issues.push("does not run the pinned Node at /opt/node/bin/node");
    }
    if (!body.includes("/opt/infra-cod/current/services/cli/infra-cod.mjs")) {
      issues.push("does not run the CLI through /opt/infra-cod/current");
    }
  }

  if (issues.length > 0) return check.fail(`${shimPath}: ${issues.join(", ")}`);
  return check.pass(`${shimPath} runs the pinned Node against current`);
}

async function checkNodeModules() {
  const check = new Check("release.node_modules");

  const releaseRoot = resolveReleaseRoot();
  if (!releaseRoot) return check.warn("not in a release — skip");

  // Check critical modules
  for (const mod of ["pg", "hash-wasm"]) {
    const modPath = path.join(releaseRoot, "node_modules", mod);
    if (!existsSync(modPath)) {
      return check.fail(`node_modules/${mod} is missing`);
    }
  }

  return check.pass("pg, hash-wasm available");
}

async function checkWebEndpoint() {
  const check = new Check("network.web_loopback");

  // A GET: the question is whether the panel serves its sign-in page, and a HEAD
  // is a different question that a correct panel is allowed to answer differently.
  const result = spawnSync("curl", [
    "-s", "-o", "/dev/null", "-w", "%{http_code}",
    "http://127.0.0.1:3100/login",
  ], {
    encoding: "utf8",
    timeout: 10_000,
  });

  if (result.error) {
    return check.warn(`cannot reach 127.0.0.1:3100: ${result.error.message}`);
  }
  if (result.status !== 0) {
    return check.warn(`curl to 127.0.0.1:3100 exited ${result.status}`);
  }

  const code = parseInt(result.stdout.trim(), 10);
  if (code >= 200 && code < 400) {
    return check.pass(`127.0.0.1:3100 responds with HTTP ${code}`);
  }
  // A 5xx from the sign-in page is not a note. Nobody can sign in.
  if (code >= 500) return check.fail(`the panel answered HTTP ${code} on /login`);
  return check.warn(`127.0.0.1:3100 returned HTTP ${code}`);
}

async function checkPort3100NotPublic() {
  const check = new Check("network.port_3100_loopback_only");
  // `-H`, because ss prints a column header even when the filter matches
  // nothing — and a check that reads that header as data cannot tell a panel
  // bound to 0.0.0.0 from no panel at all.
  const result = commandOutput("ss", ["-H", "-tlnp", "sport = 3100"], { timeout: 5_000 });
  if (!result.ok) {
    return check.warn("cannot verify the 3100 listener (ss is not available)");
  }
  const lines = result.stdout.split("\n").filter((line) => line.trim().length > 0);
  if (lines.length === 0) {
    // Nothing is listening. The panel being down is another check's finding;
    // what this one must not do is call that a pass.
    return check.warn("nothing is listening on 3100");
  }
  if (lines.some((line) => /(^|\s)(0\.0\.0\.0|\[::\]|\*):3100\b/.test(line))) {
    return check.fail("port 3100 is listening on a public address — it must be 127.0.0.1 only");
  }
  return check.pass("3100 is bound to loopback only");
}

async function checkDiskSpace() {
  const check = new Check("system.disk_space");

  const result = commandOutput("df", ["-B1", "--output=avail,target", sys("/opt"), sys("/var/lib/postgresql")], { timeout: 5_000 });
  if (!result.ok) {
    return check.warn("cannot check disk space");
  }

  const lines = result.stdout.split("\n").filter(Boolean);
  let low = 0;
  for (const line of lines) {
    const parts = line.split(/\s+/);
    if (parts.length >= 2) {
      const bytes = parseInt(parts[0], 10);
      if (!Number.isNaN(bytes) && bytes < 10_737_418_240) low += 1; // < 10GB
    }
  }
  if (low > 0) {
    return check.warn(`${low} filesystem(s) have less than 10GB free`);
  }
  return check.pass("adequate disk space");
}

async function checkBackupFreshness() {
  const check = new Check("backup.freshness");

  // Check for recent backup files in backup root
  const backupDir = sys("/var/lib/infra-cod-backups");
  if (existsSync(backupDir)) {
    let latest = 0;
    try {
      const entries = readdirSync(backupDir);
      for (const entry of entries) {
        const full = path.join(backupDir, entry);
        const stat = lstatSync(full);
        if (stat.isFile() && stat.mtimeMs > latest) latest = stat.mtimeMs;
      }
    } catch { /* ignore read errors */ }

    if (latest > 0) {
      const ageDays = (Date.now() - latest) / (1000 * 60 * 60 * 24);
      if (ageDays > 2) {
        return check.warn(`latest backup file is ${ageDays.toFixed(1)} days old (may be stale)`);
      }
      return check.pass(`latest backup file age: ${ageDays.toFixed(1)} days`);
    }
    return check.warn("backup directory exists but no backup files found");
  }

  // Fallback: systemd timestamp
  const result = commandOutput("systemctl", ["show", "--property=ActiveEnterTimestamp", "infra-cod-backup.service"], { timeout: 5_000 });
  if (result.ok && result.stdout) {
    const timestamp = result.stdout.replace("ActiveEnterTimestamp=", "").trim();
    if (timestamp) return check.warn(`backup service last entered: ${timestamp}`);
  }

  return check.warn("backup not configured");
}

// The one plaintext password this system ever writes down.
//
// Its presence is expected on a fresh install and says nothing by itself. What
// it is — a regular file, owned by root, mode 0600 — is the whole protection,
// and none of it was checked before: the file could have been a symlink into a
// world-readable directory and this check would still have reported a pass.
async function checkInitialCredentials() {
  const check = new Check("secrets.initial_credentials");
  const state = readCredentialsState(sys("/etc/infra-cod"));

  if (state.exists === null) {
    // Unknown is never "absent". A credentials file nobody can stat is a
    // credentials file nobody has ruled out.
    return check.fail(`cannot determine whether ${state.path} exists (${state.error})`);
  }
  if (state.exists === false) {
    return check.pass("absent (already acknowledged, or never created)");
  }

  const issues = [];
  if (state.symlink) issues.push("is a symlink");
  else if (!state.regularFile) issues.push("is not a regular file");
  if (state.uid !== 0) issues.push(`owner uid=${state.uid} (expected root)`);
  if (state.mode !== 0o600) issues.push(`mode=0${state.mode.toString(8)} (expected 0600)`);

  if (issues.length > 0) {
    return check.fail(`${state.path}: ${issues.join(", ")}`);
  }
  return check.pass("present (root:root 0600) — acknowledge via auth login + 'admin ack-credentials'");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const CHECKS = [
  checkReleaseInstallation,
  checkReleasePathPermissions,
  checkInstallManifest,
  checkReleaseIntegrity,
  checkUsageProbe,
  checkLoginIsolation,
  checkNodeVersion,
  checkRuntimeBinaries,
  checkPostgresqlClusters,
  checkDatabaseExtensions,
  checkLedger,
  checkSystemdTarget,
  checkSystemdUnits,
  checkWorkspaceSeeds,
  checkSocketPermissions,
  checkHostLayout,
  checkRuntimeSandboxPaths,
  checkGroupMemberships,
  checkAgentRuntimes,
  checkSecrets,
  checkBrokerKeypair,
  checkCliShim,
  checkNodeModules,
  checkWebEndpoint,
  checkPort3100NotPublic,
  checkDiskSpace,
  checkBackupFreshness,
  checkInitialCredentials,
];

export async function runDoctor(argv = [], { stdout = process.stdout, stderr = process.stderr } = {}) {
  const knownArgs = new Set(["--json"]);
  for (const arg of argv) {
    if (!knownArgs.has(arg)) {
      stderr.write(`doctor: unknown argument: ${arg}\n`);
      return 2;
    }
  }
  const jsonOutput = argv.includes("--json");

  const results = [];
  for (const checkFn of CHECKS) {
    let result;
    try {
      result = await checkFn();
    } catch (error) {
      result = { ok: false, severity: "critical", name: checkFn.name, message: error.message };
    }
    if (Array.isArray(result)) {
      results.push(...result);
    } else {
      results.push(result);
    }
  }

  const criticalCount = results.filter((c) => !c.ok && c.severity === "critical").length;
  const warningCount = results.filter((c) => !c.ok && c.severity === "warning").length;

  const summary = {
    ok: criticalCount === 0,
    critical: criticalCount,
    warnings: warningCount,
    passed: results.filter((c) => c.ok).length,
    checks: results.map((c) => c.toJSON ? c.toJSON() : c),
  };

  if (jsonOutput) {
    stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  } else {
    stdout.write("infra-cod doctor\n");
    stdout.write("─".repeat(60) + "\n");
    for (const check of summary.checks) {
      const icon = check.ok ? "✓" : (check.severity === "critical" ? "✗" : "⚠");
      stdout.write(` ${icon} ${check.check}: ${check.message}\n`);
    }
    stdout.write("─".repeat(60) + "\n");
    if (criticalCount > 0) {
      stdout.write(` ${criticalCount} critical, ${warningCount} warning(s) — degraded\n`);
    } else if (warningCount > 0) {
      stdout.write(` ${warningCount} warning(s) — healthy with notes\n`);
    } else {
      stdout.write(" All checks passed — healthy\n");
    }
  }

  // Exit codes: 0=healthy, 1=degraded (warnings only), 2=critical (broken checks)
  // A warning-only result is degraded but not broken: the operator should review,
  // but the panel and core infrastructure are functional.
  return criticalCount > 0 ? 2 : (warningCount > 0 ? 1 : 0);
}
