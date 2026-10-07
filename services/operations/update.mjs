// `infra-cod update`, `rollback` and `releases` — the one update coordinator.
//
// The clean install is proven; the live update was not, and it is not the same
// operation. Re-running the installer on a running host gets five things wrong,
// and each of them is a way to report a success that did not happen:
//
//   * migrations can run while the old workers are still reading the schema;
//   * moving `current` does not replace an already running Node process;
//   * `systemctl start` on an active target is a no-op, so nothing restarts;
//   * the HTTP 200 that follows can therefore come from the old process;
//   * and switching the symlink back is not a rollback when the old release
//     cannot read the schema the migrations left behind.
//
// So this file owns the sequence, and owns it explicitly: verify, record, back
// up, drain, stage, decide compatibility, stop if the schema is about to move
// past the running release, migrate, switch, restart, and then *prove* — from
// the processes themselves, not from a status code — that the release now
// serving is the release that was installed. From the moment anything durable
// exists, each step records its phase in `/etc/infra-cod/.update-state` before
// the next one starts, so a machine that loses power mid-update comes back able
// to say where it stopped and to be resumed from there.
//
// What this file deliberately does not do is reimplement anything the installer
// already proved. Artifact verification is `deploy/verify-release.sh` plus the
// in-artifact deep verifier; migrations are `deploy/run-production-migrations.sh`;
// the unit list is `unit-contract.mjs`. This is a coordinator, not a second
// installer.
//
// It runs as root, from the release `current` points at — the release it is
// about to replace. That is safe only because every module it needs is imported
// here, at load time, before anything moves: a lazy `import()` after the switch
// would resolve through `current` and load the *new* release's code halfway
// through the old release's update.

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import { randomBytes } from "node:crypto";
import path from "node:path";

import { applyApparmor, applyTmpfiles, declarationOf, readLedger, reconcileInstall } from "./install-reconcile.mjs";
import { fileURLToPath } from "node:url";
import {
  CURRENT_LINK,
  PROC_ROOT,
  RELEASE_TREE_PREFIX,
  CURRENT_TMP,
  ETC_ROOT,
  InventoryError,
  NODE_BIN,
  RELEASES_DIR,
  UPDATE_STATE_FILE,
  currentReleaseDirectory,
  freeReleasePath,
  listReceipts,
  listReleases,
  readManifest,
  releaseContract,
  releaseIntact,
  resolveVersionToDirectory,
  runningReleases,
  sys,
  unitWorkingDirectories,
  writeReceiptAtomically,
} from "./release-inventory.mjs";
import { withHostLock } from "./update-lock.mjs";
import { releasesToPrune } from "./retention.mjs";
import { LONG_RUNNING_SERVICES, ONESHOT_SERVICES, TIMERS } from "./unit-contract.mjs";

const PREFIX = (process.env.INFRA_COD_INSTALL_PREFIX ?? "").trim();
const HARNESS = PREFIX.length > 0;
const COMMAND_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));

const PG_BIN = sys("/usr/lib/postgresql/17/bin");
const PG_SOCKET = sys("/var/run/postgresql");
const PG_DATABASE = "infra_cod";
const BACKUP_ROOT = sys("/var/lib/infra-cod-backups");
const WEB_ORIGIN = "http://127.0.0.1:3100";
const LOGIN_PATH = "/login";
const WEB_PROBE_URL = `${WEB_ORIGIN}${LOGIN_PATH}`;
const SELFTEST_PATH = "/api/control-plane/selftest";
const SELFTEST_TOKEN = sys("/run/infra-cod-selftest.token");

const UPDATE_STATE_SCHEMA = "infra-cod/update-state/1";

// The ordered phases. The name in the state file is one of these, and it always
// means "this phase completed": a crash is therefore always described by the
// last thing that finished, never by something that may or may not have started.
// Nothing before `staged` is durable, so nothing before `staged` is written
// down: an update that refuses at the drain step, or dies before the new tree
// exists, has changed nothing a later run would want to skip — and a state file
// left behind by a clean refusal would make the next legitimate update stop and
// ask about an "interrupted run" that never touched the host.
export const PHASES = [
  "verified",      // the incoming artifact passed the gate and the deep verifier
  "recorded",      // the pre-update state of the host is captured
  "backed_up",     // a fresh backup and a successful restore drill exist
  "drained",       // no new work is dispatched and in-flight work is bounded
  "staged",        // FIRST DURABLE PHASE: the new tree is on disk beside the live one
  "decided",       // the release contract answered the compatibility question
  "stopped",       // the application target is down (incompatible schema only)
  "migrated",      // new migrations are applied by the new release's runner
  "units_installed", // the release's units are in /etc/systemd/system
  "symlink_switched", // `current` resolves to the new release
  "switched",      // the target has been restarted onto it
  "verified_live", // the running processes are the new release, and healthy
  "complete",      // the receipt is written
];

class UpdateError extends Error {
  constructor(message, { recoverable = true } = {}) {
    super(message);
    this.name = "UpdateError";
    this.recoverable = recoverable;
  }
}

// ---------------------------------------------------------------------------
// Small host helpers
// ---------------------------------------------------------------------------

function run(binary, args, options = {}) {
  const result = spawnSync(binary, args, { encoding: "utf8", timeout: 600_000, ...options });
  if (result.error) return { ok: false, code: null, stdout: "", stderr: result.error.message };
  return {
    ok: result.status === 0,
    code: result.status,
    stdout: (result.stdout ?? "").trim(),
    stderr: (result.stderr ?? "").trim(),
  };
}

function systemctl(...args) {
  return run("systemctl", args, { timeout: 120_000 });
}

function psql(sql) {
  const binary = existsSync(path.join(PG_BIN, "psql")) ? path.join(PG_BIN, "psql") : "psql";
  const result = run(binary, [
    "-h", PG_SOCKET, "-p", "5432", "-U", "infra_migrator", "-d", PG_DATABASE,
    "-X", "-qAt", "-v", "ON_ERROR_STOP=1", "-c", sql,
  ], { timeout: 60_000 });
  if (!result.ok) throw new UpdateError(`the database could not be queried: ${result.stderr || result.stdout}`);
  return result.stdout;
}

// A GET, not a HEAD. The installer learned this the hard way: the panel answered
// a GET correctly and a HEAD with a 500, and the probe called a healthy server
// dead.
function probeWeb({ attempts = probeAttempts(), delayMs = probeDelay() } = {}) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const result = run("curl", ["-s", "-o", "/dev/null", "-w", "%{http_code}", WEB_PROBE_URL], { timeout: 15_000 });
    if (/^[23]/.test(result.stdout)) return { ok: true, status: result.stdout };
    sleepSync(delayMs);
  }
  return { ok: false, status: null };
}

// One request, one status code, no retries: by the time these run the panel has
// already answered `/login`, so a route that does not answer is a broken route
// rather than a slow boot.
function probePath(pathname) {
  const result = run("curl", ["-s", "-o", "/dev/null", "-w", "%{http_code}", `${WEB_ORIGIN}${pathname}`], { timeout: 15_000 });
  const status = Number.parseInt(result.stdout, 10);
  return Number.isInteger(status) && status > 0 ? status : null;
}

// The panel's own data self-test (rc.128): the loaders every page runs, as
// infra_web, for every owner's projects and latest chats. rc.127 answered
// /login and failed every chat with a review on "permission denied"; this is
// what would have caught it, without this command holding an operator
// credential. A one-time token in a file only root and infra-web can read
// authorises the one call; the file is gone when it returns.
//
// A release older than rc.128 has no self-test and answers 404: that is said,
// and is not a failure, so a rollback to one still verifies.
function selfTest() {
  const token = randomBytes(32).toString("hex");
  const body = path.join(os.tmpdir(), `infra-cod-selftest-${process.pid}.json`);
  try {
    mkdirSync(path.dirname(SELFTEST_TOKEN), { recursive: true });
    writeFileSync(SELFTEST_TOKEN, `${token}\n`, { mode: 0o640 });
    if (!HARNESS) run("chown", ["root:infra-web", SELFTEST_TOKEN], { timeout: 10_000 });
    const result = run("curl", ["-s", "-o", body, "-w", "%{http_code}", "-X", "POST",
      "-H", `x-infra-cod-selftest: ${token}`, `${WEB_ORIGIN}${SELFTEST_PATH}`], { timeout: 120_000 });
    const status = Number.parseInt(result.stdout, 10);
    if (status === 200) return { ok: true, supported: true };
    if (status === 404) return { ok: true, supported: false };
    let failures = [];
    try { failures = JSON.parse(readFileSync(body, "utf8")).failures ?? []; } catch { /* no body */ }
    return { ok: false, supported: true, status: Number.isInteger(status) ? status : null,
      failures: failures.slice(0, 5).map((failure) => `${failure.loader}: ${failure.error}`) };
  } finally {
    rmSync(SELFTEST_TOKEN, { force: true });
    rmSync(body, { force: true });
  }
}

// Sixty seconds of patience is right for a host whose panel is still booting and
// wrong for a suite that starts a dozen of them; the sandbox, and only the
// sandbox, may say otherwise.
function probeAttempts() {
  const override = Number.parseInt(process.env.INFRA_COD_UPDATE_PROBE_ATTEMPTS ?? "", 10);
  return HARNESS && Number.isInteger(override) ? override : 30;
}

function probeDelay() {
  const override = Number.parseInt(process.env.INFRA_COD_UPDATE_PROBE_DELAY_MS ?? "", 10);
  return HARNESS && Number.isInteger(override) ? override : 2_000;
}

function sleepSync(milliseconds) {
  if (milliseconds <= 0) return;
  // A synchronous wait on purpose: the whole coordinator is a sequence, and an
  // await here would let nothing else usefully happen anyway.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function migrationVersionsIn(releaseDirectory) {
  const directory = path.join(releaseDirectory, "db/migrations");
  if (!existsSync(directory)) throw new UpdateError(`${directory} is missing from the release`);
  return readdirSync(directory)
    .filter((name) => /^\d{4}_.+\.sql$/.test(name))
    .sort()
    .map((name) => ({ name, version: name.slice(0, 4) }));
}

function ledgerVersions() {
  const rows = psql("SELECT version FROM control_plane.schema_migrations ORDER BY version;");
  return new Set(rows.split("\n").map((line) => line.trim()).filter(Boolean));
}

// ---------------------------------------------------------------------------
// Update state: where an interrupted run stopped
// ---------------------------------------------------------------------------

// Exported for the console, which reports an interrupted update and prints the
// `--resume` / `--abandon` it calls for; the decision stays here.
export function readUpdateState() {
  if (!existsSync(UPDATE_STATE_FILE)) return null;
  try {
    const state = JSON.parse(readFileSync(UPDATE_STATE_FILE, "utf8"));
    if (state.schema !== UPDATE_STATE_SCHEMA) return null;
    return state;
  } catch {
    return null;
  }
}

function writeUpdateState(state) {
  mkdirSync(ETC_ROOT, { recursive: true });
  const temporary = `${UPDATE_STATE_FILE}.tmp-${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify({ schema: UPDATE_STATE_SCHEMA, ...state }, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, UPDATE_STATE_FILE);
}

function clearUpdateState() {
  rmSync(UPDATE_STATE_FILE, { force: true });
}

// The fault-injection seam, and the reason it cannot fire on a real host.
//
// Proving that every state-changing step has a defined outcome requires killing
// the coordinator after each one, and a test that kills it from outside cannot
// choose the instant. So the phase name may be named in an environment variable
// — but only in the sandbox, where `INFRA_COD_INSTALL_PREFIX` says by
// construction that this is not somebody's machine.
function injectFault(phase) {
  if (!HARNESS) return;
  const requested = (process.env.INFRA_COD_UPDATE_FAULT ?? "").trim();
  if (requested && requested === phase) {
    throw new UpdateError(`fault injection: simulated failure after phase ${phase}`);
  }
  if ((process.env.INFRA_COD_UPDATE_FAULT_KILL ?? "").trim() === phase) {
    process.kill(process.pid, "SIGKILL");
  }
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

class Reporter {
  constructor({ stdout, stderr, json }) {
    this.stdout = stdout;
    this.stderr = stderr;
    this.json = json;
    this.steps = [];
  }

  step(phase, message) {
    this.steps.push({ phase, message, at: new Date().toISOString() });
    this.log(`[${phase}] ${message}`);
  }

  log(message) {
    // In `--json` mode the receipt is the only thing on stdout, so progress goes
    // to stderr and `infra-cod update --json | jq .` stays a contract.
    (this.json ? this.stderr : this.stdout).write(`infra-cod update: ${message}\n`);
  }

  warn(message) {
    this.stderr.write(`infra-cod update: WARNING: ${message}\n`);
  }
}

// Nothing else may be rearranging this host while it is being updated.
//
// The host lock keeps two infra-cod operations apart and says nothing about the
// distribution's own automation. On the first rehearsal that automation was what
// broke an update: `unattended-upgrades` woke up mid-run, upgraded packages,
// restarted PostgreSQL and restarted `ssh.service` — killing the session the
// update was running in.
//
// The first attempt at a guard was wrong twice over, and both mistakes are the
// same shape as the ones this file has already been bitten by:
//
//   * it asked `flock(1)`, which takes a BSD `flock(2)` lock. apt and dpkg take
//     POSIX `fcntl` locks, and on Linux the two do not exclude each other at
//     all — so the check could never have seen a held dpkg lock, and reported
//     "free" while apt was working.
//   * it asked once, at the start, and let go immediately. A check that is true
//     for an instant says nothing about the minutes that follow, which is
//     exactly the window unattended-upgrades started in.
//
// So the lock is taken the way apt takes it, and held for the whole run. Holding
// the frontend lock is not a trick: it is the documented way one package
// operation keeps another out, and an update that restarts every service on the
// host is a package operation in all but name.
const DPKG_FRONTEND_LOCK = sys("/var/lib/dpkg/lock-frontend");
const DPKG_LOCKS = [DPKG_FRONTEND_LOCK, sys("/var/lib/dpkg/lock"), sys("/var/cache/apt/archives/lock")];

// Who holds a POSIX lock on one of dpkg's files, read from the kernel rather
// than inferred from a tool's exit code.
export function packageLockHolders({ procLocks = path.join(PROC_ROOT, "locks"), lockFiles = DPKG_LOCKS } = {}) {
  let table;
  try {
    table = readFileSync(procLocks, "utf8");
  } catch {
    return [];
  }
  const inodes = new Map();
  for (const file of lockFiles) {
    try {
      inodes.set(String(statSync(file).ino), file);
    } catch {
      // A lock file that does not exist is not a lock anybody holds.
    }
  }
  if (inodes.size === 0) return [];

  const holders = [];
  for (const line of table.split("\n")) {
    // `1: POSIX  ADVISORY  WRITE 1234 08:01:36173 0 EOF`
    const fields = line.trim().split(/\s+/);
    if (fields.length < 6) continue;
    const inode = fields[5].split(":").pop();
    const file = inodes.get(inode);
    if (!file) continue;
    holders.push({ file, pid: fields[4], kind: fields[1] });
  }
  return holders;
}

function describeHolder(holder) {
  const command = readFileSync(path.join(PROC_ROOT, String(holder.pid), "comm"), "utf8").trim();
  return `${command} (pid ${holder.pid})`;
}

// Takes dpkg's frontend lock the way apt does — an exclusive `fcntl` write lock
// — and holds it until `release()` is called. The child process is what holds
// it, so a coordinator that dies releases it, which is the property a PID file
// does not have.
export async function holdPackageManagerLock(reporter, { lockFile = DPKG_FRONTEND_LOCK } = {}) {
  const holders = packageLockHolders();
  if (holders.length > 0) {
    const who = holders.map((holder) => {
      try {
        return `${describeHolder(holder)} on ${holder.file}`;
      } catch {
        return `pid ${holder.pid} on ${holder.file}`;
      }
    });
    throw new UpdateError(
      `a package operation holds ${who.join(", ")}. It can restart services — including sshd — `
      + "underneath this update. Wait for it to finish.",
    );
  }
  // The periodic upgrade jobs, and deliberately not `unattended-upgrades.service`.
  //
  // That unit is "Unattended Upgrades Shutdown": it runs
  // `unattended-upgrade-shutdown --wait-for-signal` and sits `active (running)`
  // for the life of the machine, waiting for a shutdown to hold up. Treating
  // that as "a package operation is in progress" refused an update on the first
  // stock Ubuntu host it met, and would have refused every update on every such
  // host forever. A fail-closed check that is always closed is not a safety
  // property; it is an outage with a rationale.
  //
  // `apt-daily.service` and `apt-daily-upgrade.service` are the periodic runs.
  // They are oneshots, so they are active only while they are actually working —
  // which is the question being asked.
  for (const unit of ["apt-daily-upgrade.service", "apt-daily.service"]) {
    const state = (run("systemctl", ["show", "-p", "ActiveState", "--value", unit], { timeout: 10_000 }).stdout ?? "").trim();
    if (state === "active" || state === "activating" || state === "reloading") {
      throw new UpdateError(
        `${unit} is ${state}. Unattended upgrades restart services, including sshd, and one of them `
        + "interrupted an update on this host. Wait for it to finish, or stop it for the maintenance window.",
      );
    }
  }

  const holder = spawn("python3", ["-c", [
    "import fcntl, sys",
    "f = open(sys.argv[1], 'a+')",
    "fcntl.lockf(f, fcntl.LOCK_EX | fcntl.LOCK_NB)",
    "sys.stdout.write('locked\\n'); sys.stdout.flush()",
    "sys.stdin.read()",
  ].join("\n"), lockFile], { stdio: ["pipe", "pipe", "pipe"] });

  const taken = await new Promise((resolve, reject) => {
    let out = "";
    let error = "";
    holder.stdout.on("data", (chunk) => {
      out += chunk;
      if (out.includes("locked")) resolve(true);
    });
    holder.stderr.on("data", (chunk) => { error += chunk; });
    holder.on("error", () => reject(new UpdateError(
      "python3 is required to take dpkg's frontend lock the way apt takes it, and is not available. "
      + "Without it this update cannot keep package management out of its own maintenance window.",
    )));
    holder.on("exit", () => {
      if (out.includes("locked")) return;
      resolve(error.includes("BlockingIOError") || error.includes("Resource temporarily unavailable") ? false : false);
    });
  });

  if (!taken) {
    throw new UpdateError(
      `${lockFile} could not be locked, so a package operation is either running or about to. `
      + "Wait for it to finish, or stop unattended upgrades for the maintenance window.",
    );
  }

  reporter.log("dpkg's frontend lock is held for the duration of this run; apt will wait");
  let released = false;
  return {
    async release() {
      if (released) return;
      released = true;
      holder.stdin.end();
      await new Promise((resolve) => {
        const timer = setTimeout(() => { holder.kill("SIGKILL"); resolve(); }, 5_000);
        holder.on("exit", () => { clearTimeout(timer); resolve(); });
      });
    },
  };
}

// ---------------------------------------------------------------------------
// Verification of the incoming artifact
// ---------------------------------------------------------------------------

// Verified by the release that is running, not by the release being installed.
//
// The gate is a trust boundary: the shell script and the pinned public key come
// from the installation the operator already trusts, and only once the signature
// and checksums pass does anything inside the new artifact get executed — and
// then only its own deep verifier, on its own extracted tree.
function verifyArtifact({ artifact, checksums, signature, publicKey, reporter }) {
  const selfRelease = path.resolve(COMMAND_DIRECTORY, "../..");
  const gate = path.join(selfRelease, "deploy/verify-release.sh");
  if (!existsSync(gate)) {
    throw new UpdateError(
      `the trusted verification gate is missing at ${gate}. `
      + "This command must run from an installed release, which ships it.",
    );
  }

  const staging = mkdtempSync(path.join(os.tmpdir(), "infra-cod-update-"));
  reporter.step("verified", `running the trusted gate ${gate}`);
  const gateResult = run(gate, [
    "--artifact", artifact,
    "--checksums", checksums,
    "--signature", signature,
    "--public-key", publicKey,
    "--require-signature",
    "--extract", staging,
  ]);
  if (!gateResult.ok) {
    rmSync(staging, { recursive: true, force: true });
    throw new UpdateError(`the artifact failed verification: ${gateResult.stderr || gateResult.stdout}`);
  }

  const top = readdirSync(staging).filter((name) => name.startsWith("infra-cod-"));
  if (top.length !== 1) {
    rmSync(staging, { recursive: true, force: true });
    throw new UpdateError(`the verified artifact unpacked to ${top.length} top-level directories, expected exactly one`);
  }
  const tree = path.join(staging, top[0]);
  const manifest = readManifest(tree);

  // Whether this coordinator can install it at all, asked before anything is
  // durable: an install declaration from a later contract, or one that needs a
  // newer coordinator, is refused here rather than half-applied after the
  // migrations have run.
  try {
    declarationOf(tree, { coordinatorVersion: coordinatorVersion() });
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    throw new UpdateError(`the artifact cannot be installed by this coordinator: ${error.message}`, { recoverable: false });
  }

  // The deep verifier comes from inside the artifact, which is legitimate only
  // now: the gate has already bound these bytes to the signed checksums.
  const deep = path.join(tree, "scripts/verify-release.mjs");
  if (!existsSync(deep)) {
    rmSync(staging, { recursive: true, force: true });
    throw new UpdateError(`the artifact carries no deep verifier at scripts/verify-release.mjs`);
  }
  const nodeBinary = existsSync(NODE_BIN) ? NODE_BIN : process.execPath;
  const scratch = mkdtempSync(path.join(os.tmpdir(), "infra-cod-deep-"));
  reporter.step("verified", `running the artifact's deep verifier for ${manifest.version}`);
  const deepResult = run(nodeBinary, [
    deep,
    "--artifact", artifact,
    "--checksums", checksums,
    "--signature", signature,
    "--public-key", publicKey,
    "--require-signature",
    "--extract", scratch,
    "--version", manifest.version,
  ]);
  rmSync(scratch, { recursive: true, force: true });
  if (!deepResult.ok) {
    rmSync(staging, { recursive: true, force: true });
    throw new UpdateError(`deep verification of ${manifest.version} failed: ${deepResult.stderr || deepResult.stdout}`);
  }

  return { staging, tree, manifest };
}

// ---------------------------------------------------------------------------
// The compatibility decision
// ---------------------------------------------------------------------------

// Which migrations this update would apply, and what the incoming release says
// about serving through them.
//
// Fail-closed in three distinct ways, because they are three different
// situations an operator has to be able to tell apart: the release carries no
// contract at all, a pending migration predates the contract, or a pending
// migration says outright that the previous release cannot read what it leaves
// behind.
export function decideCompatibility({ contract, pending }) {
  if (pending.length === 0) {
    return {
      pending: [],
      applicationRollbackSafe: true,
      mustStopBeforeMigrating: false,
      reason: "no migrations are pending; the schema does not move",
    };
  }
  if (!contract.known) {
    return {
      pending,
      applicationRollbackSafe: false,
      mustStopBeforeMigrating: true,
      reason: `${contract.reason}, so whether the running release survives these migrations is unknown`,
    };
  }

  const incompatible = pending.filter((entry) => contract.backwardIncompatible.has(entry.version));
  // The contract lists only the exceptions, so "past the boundary and in neither
  // list" means declared compatible. At or below the boundary it means the
  // opposite: nobody ever derived an answer for that migration.
  const unknown = pending.filter(
    (entry) => !contract.backwardIncompatible.has(entry.version)
      && (contract.unverified.has(entry.version) || entry.version <= contract.unverifiedThrough),
  );

  if (incompatible.length > 0) {
    return {
      pending,
      applicationRollbackSafe: false,
      mustStopBeforeMigrating: true,
      reason: `${incompatible.map((entry) => entry.name).join(", ")} declare that the previous release cannot read the resulting schema`,
    };
  }
  if (unknown.length > 0) {
    const named = unknown.map((entry) => entry.name).join(", ");
    return {
      pending,
      applicationRollbackSafe: false,
      mustStopBeforeMigrating: true,
      reason: `${named} declare no compatibility, and unknown compatibility is treated as incompatible`,
    };
  }
  return {
    pending,
    applicationRollbackSafe: true,
    mustStopBeforeMigrating: false,
    reason: `${pending.length} additive migration(s) the previous release can still read`,
  };
}

// Can `targetDirectory` read the schema that is applied *right now*?
//
// This is the only question a rollback may be decided by, and it has to be asked
// at the moment of the rollback rather than before the migration ran. Deciding
// it in advance got both cases wrong in opposite directions: a migration that
// failed before applying anything left the ledger untouched and was still
// reported as requiring a database restore, and a run resumed after its
// migration had already landed recomputed "nothing pending" and cheerfully
// offered to start the old release on the new schema.
//
// So the boundary is read from the ledger and compared against the migrations
// the target release actually carries. A ledger that cannot be read is not an
// empty ledger: it fails closed, because "the schema is unknown" and "the schema
// is fine" are the two answers that must never be confused.
export function schemaCompatibleWith({ targetDirectory, contract }) {
  let applied;
  try {
    applied = ledgerVersions();
  } catch (error) {
    return {
      applicationRollbackSafe: false,
      beyond: null,
      reason: `the migration ledger could not be read (${error.message}), so the schema the target release would face is unknown`,
    };
  }
  const carried = new Set(migrationVersionsIn(targetDirectory).map((entry) => entry.version));
  const beyond = [...applied].filter((version) => !carried.has(version)).sort();
  const decision = decideCompatibility({
    contract,
    pending: beyond.map((version) => ({ version, name: `${version} (applied)` })),
  });
  return { applicationRollbackSafe: decision.applicationRollbackSafe, beyond, reason: decision.reason };
}

// ---------------------------------------------------------------------------
// Drain
// ---------------------------------------------------------------------------

// New work stops being handed out, in-flight work is given a bounded chance to
// finish, and what remains needs an operator's explicit word.
//
// The dispatcher is what turns events into runtime jobs, so stopping it is what
// makes the queue stop growing; the workers keep their leases and finish. This
// is a drain and not a kill: `--interrupt-active` is the only way past work that
// is still running, and it has to be typed.
function drain({ reporter, timeoutSeconds, interruptActive }) {
  reporter.step("drained", "stopping the dispatcher so no new work is handed out");
  const stopped = systemctl("stop", "infra-cod-dispatcher.service");
  if (!stopped.ok) throw new UpdateError(`the dispatcher could not be stopped: ${stopped.stderr}`);

  const deadline = Date.now() + timeoutSeconds * 1_000;
  let inFlight = countInFlight();
  while (inFlight > 0 && Date.now() < deadline) {
    reporter.log(`waiting for ${inFlight} in-flight job(s)`);
    sleepSync(2_000);
    inFlight = countInFlight();
  }

  if (inFlight > 0 && !interruptActive) {
    // Restarting the dispatcher here is what makes an aborted update a no-op
    // rather than a host left half-drained.
    systemctl("start", "infra-cod-dispatcher.service");
    throw new UpdateError(
      `${inFlight} job(s) are still in flight after ${timeoutSeconds}s. `
      + "Re-run with --interrupt-active to interrupt them deliberately, or wait for them to finish.",
    );
  }
  if (inFlight > 0) {
    reporter.warn(`interrupting ${inFlight} in-flight job(s) at the operator's explicit request`);
  }
  return { inFlight, interrupted: inFlight > 0 };
}

function countInFlight() {
  try {
    const value = psql("SELECT count(*) FROM control_plane.runtime_jobs WHERE status = 'in_flight';");
    const count = Number.parseInt(value, 10);
    return Number.isInteger(count) ? count : 0;
  } catch {
    // A database that cannot be asked is not a database with no work in it.
    throw new UpdateError("in-flight work could not be counted, so the host cannot be shown to be drained");
  }
}

// ---------------------------------------------------------------------------
// Units, symlink and restart
// ---------------------------------------------------------------------------

// What a release installs outside its tree is its manifest's declaration, and
// the host is reconciled to it (WP-A, install-reconcile.mjs): declared files are
// installed, and files this product installed before and the release no longer
// declares are retired — a unit stopped and disabled first. The declaration read
// is the *target* release's, so what a release installs is decided by that
// release even though the code applying it is the coordinator's.
//
// `leaving`: the release being replaced, whose declaration says what may have
// been installed before, alongside the ledger.
function coordinatorVersion() {
  return readManifest(path.resolve(COMMAND_DIRECTORY, "../..")).version;
}

function installUnits(releaseDirectory, reporter, { leaving = null } = {}) {
  const version = coordinatorVersion();
  let declaration;
  try {
    declaration = declarationOf(releaseDirectory, { coordinatorVersion: version });
  } catch (error) {
    throw new UpdateError(error.message, { recoverable: false });
  }
  const previous = [...readLedger()];
  if (leaving && leaving !== releaseDirectory && existsSync(leaving)) {
    try {
      previous.push(...declarationOf(leaving, { coordinatorVersion: version }).files);
    } catch (error) {
      reporter.warn(`the release being left has no readable install declaration (${error.message}); only the install record is used`);
    }
  }
  const result = reconcileInstall({
    declaration,
    releaseRoot: releaseDirectory,
    previous,
    reporter,
    // The tmpfiles rules this release just installed create the runtime
    // directories its tool definitions go into.
    beforeRuntimeRoots: () => { applyTmpfiles(declaration); applyApparmor(declaration); },
  });
  if (!declaration.files.some((entry) => entry.root === "runtime-tools")) {
    throw new UpdateError("the release installs no runtime tool definitions; the executor would have nothing to call");
  }
  reporter.log(`installed ${path.basename(releaseDirectory)}: ${result.installed.length} file(s), ${result.changed.length} changed`
    + (result.retired.length ? `, retired ${result.retired.join(", ")}` : ""));

  const reload = systemctl("daemon-reload");
  if (!reload.ok) throw new UpdateError(`systemctl daemon-reload failed: ${reload.stderr}`);
  return result;
}

// `mv -T` semantics: the symlink itself is replaced in one operation, so
// `current` resolves to a complete release at every instant, before and after.
function switchCurrent(releaseDirectory) {
  rmSync(CURRENT_TMP, { force: true });
  symlinkSync(releaseDirectory, CURRENT_TMP);
  renameSync(CURRENT_TMP, CURRENT_LINK);
}

// `restart`, never `start`.
//
// `systemctl start` on an already active target is a no-op, which is precisely
// how a host can serve the old code from the new symlink and pass every check
// that only asks for a 200.
function restartTarget(reporter, releaseDirectory) {
  reporter.log("restarting infra-cod.target");
  const restart = systemctl("restart", "infra-cod.target");
  if (!restart.ok) throw new UpdateError(`infra-cod.target could not be restarted: ${restart.stderr}`);
  waitForServices(reporter, { units: servicesOf(releaseDirectory, reporter) });
}

// The long-running services a release runs: what its own infra-cod.target
// wants. Timers are wanted too and arm the oneshots; a service is what stays up.
//
// Which services must be up after the switch is the *target* release's answer,
// not this code's. The coordinator is the release being left, so its own
// LONG_RUNNING_SERVICES name the units that release had. rc.43 renamed two
// workers; the rc.42 coordinator installed and started the new ones, retired
// the old ones, and then waited 120 s for the old ones to come back, and failed
// an update that had worked. The target file is found through the release's
// install declaration, which install-reconcile already reads for the same
// reason.
export function longRunningServicesOf(targetUnitText) {
  return String(targetUnitText ?? "").split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("Wants="))
    .flatMap((line) => line.slice("Wants=".length).trim().split(/\s+/))
    .filter((unit) => /^infra-cod-[a-z0-9-]+\.service$/.test(unit))
    .map((unit) => unit.slice(0, -".service".length))
    .sort();
}

function servicesOf(releaseDirectory, reporter) {
  if (!releaseDirectory) return LONG_RUNNING_SERVICES;
  try {
    const declaration = declarationOf(releaseDirectory, { coordinatorVersion: coordinatorVersion() });
    const target = declaration.files.find((entry) => entry.root === "systemd" && entry.name === "infra-cod.target");
    if (!target) throw new Error("it installs no infra-cod.target");
    const services = longRunningServicesOf(readFileSync(path.join(releaseDirectory, target.source), "utf8"));
    if (services.length) return services;
    reporter?.warn?.(`${path.basename(releaseDirectory)}'s infra-cod.target wants no service; checking this coordinator's own list`);
  } catch (error) {
    reporter?.warn?.(`the services of ${path.basename(releaseDirectory)} could not be read (${error.message}); checking this coordinator's own list`);
  }
  return LONG_RUNNING_SERVICES;
}

// Restarting a target is not the same thing as its services having restarted.
//
// `systemctl restart infra-cod.target` returns when the *target's* job is done,
// and the member units it pulls in are restarted by jobs of their own that may
// still be in flight. Measuring immediately after it returns is how a correct
// update was reported as a failure on the first real host: two workers were
// still mid-restart, systemd still named their previous MainPID, and reading
// `/proc/<pid>/cwd` for a process that no longer existed produced "could not be
// shown to run this release" — for services that were, a second later, running
// exactly the release that had just been installed.
//
// The installer has waited for this since Stage 10. The coordinator now does too.
function waitForServices(reporter, { units = LONG_RUNNING_SERVICES, timeoutSeconds = 120 } = {}) {
  const deadline = Date.now() + timeoutSeconds * 1_000;
  const pending = new Set(units);
  while (pending.size > 0 && Date.now() < deadline) {
    for (const unit of [...pending]) {
      if (systemctl("is-active", `${unit}.service`).ok) pending.delete(unit);
    }
    if (pending.size > 0) sleepSync(1_000);
  }
  if (pending.size > 0) {
    throw new UpdateError(`these services did not become active within ${timeoutSeconds}s: ${[...pending].join(", ")}`);
  }
  reporter.log(`all ${units.length} services are active`);
}

// ---------------------------------------------------------------------------
// Post-switch verification
// ---------------------------------------------------------------------------

// The check that separates "the symlink moved" from "the new code is serving".
//
// Every long-running service is asked which release directory its own process is
// executing in. A service that is not running, and a service running the old
// tree, are different failures and are reported as different failures.
export function verifyRunningRelease(expectedDirectory, {
  units = LONG_RUNNING_SERVICES,
  before = null,
  workingDirectories = null,
} = {}) {
  const directories = workingDirectories ?? unitWorkingDirectories(expectedDirectory, { units });
  const observed = runningReleases({ units });
  const notRunning = [];
  const wrongRelease = [];
  const notRestarted = [];
  const unknown = [];
  const evidence = [];

  for (const status of observed) {
    const declared = directories.get(status.unit) ?? null;
    const runsFromRelease = declared !== null && declared.startsWith(RELEASE_TREE_PREFIX);

    if (status.pid === 0) {
      notRunning.push(status.unit);
      evidence.push({ unit: status.unit, pid: 0, evidence: "not running", release: null });
      continue;
    }

    if (runsFromRelease) {
      // The strong evidence: the process's own working directory is inside a
      // release tree, because systemd resolved the symlink when it exec'd.
      if (status.directory === null) {
        unknown.push(status.unit);
        evidence.push({ unit: status.unit, pid: status.pid, evidence: "cwd is not inside a release", release: null });
      } else if (path.resolve(status.directory) !== path.resolve(expectedDirectory)) {
        wrongRelease.push(`${status.unit} (${path.basename(status.directory)})`);
        evidence.push({ unit: status.unit, pid: status.pid, evidence: "cwd", release: path.basename(status.directory) });
      } else {
        evidence.push({ unit: status.unit, pid: status.pid, evidence: "cwd", release: path.basename(status.directory) });
      }
      continue;
    }

    // The dispatcher and the reconciler run from `/var/lib/infra-control`, so
    // their cwd says nothing about their code. What does say something is that
    // they exec'd *again, after the symlink moved*: the switch and the restart
    // both happen inside the host lock, so a process whose start timestamp is
    // newer than the one recorded before the switch resolved
    // `/opt/infra-cod/current` to the release that is current now.
    //
    // Without a `before` snapshot there is no such comparison to make, and this
    // says so rather than passing the unit silently.
    const previous = before?.get?.(status.unit) ?? null;
    const execsThroughCurrent = status.execStart.includes(RELEASE_TREE_PREFIX);
    if (!execsThroughCurrent) {
      unknown.push(status.unit);
      evidence.push({ unit: status.unit, pid: status.pid, evidence: "ExecStart does not go through current", release: null });
    } else if (previous === null) {
      unknown.push(status.unit);
      evidence.push({ unit: status.unit, pid: status.pid, evidence: "no pre-switch snapshot to compare against", release: null });
    } else if (status.startedMonotonic <= previous.startedMonotonic || status.pid === previous.pid) {
      notRestarted.push(status.unit);
      evidence.push({ unit: status.unit, pid: status.pid, evidence: "did not re-exec after the switch", release: null });
    } else {
      evidence.push({ unit: status.unit, pid: status.pid, evidence: "re-exec after the switch", release: path.basename(expectedDirectory) });
    }
  }

  return {
    ok: notRunning.length === 0 && wrongRelease.length === 0 && unknown.length === 0 && notRestarted.length === 0,
    observed: evidence,
    notRunning,
    wrongRelease,
    notRestarted,
    unknown,
  };
}

// The evidence, re-read until it stops changing.
//
// Even with every unit active, a single `systemctl show` and the `/proc` read
// that follows it are two observations of a moving system: a service that
// restarts between them names a PID that is already gone. A verdict is only
// taken once the evidence agrees with itself, or once the attempts run out — and
// then it is taken on the last reading, so a genuine failure still fails.
function settledRunningRelease(expectedDirectory, { before = null, reporter = null, attempts = 15, delayMs = 2_000 } = {}) {
  const units = servicesOf(expectedDirectory, reporter);
  let result = verifyRunningRelease(expectedDirectory, { before, units });
  for (let attempt = 1; !result.ok && attempt < attempts; attempt += 1) {
    sleepSync(delayMs);
    result = verifyRunningRelease(expectedDirectory, { before, units });
  }
  if (reporter && result.ok) reporter.log(`all ${result.observed.length} services execute ${path.basename(expectedDirectory)}`);
  return result;
}

// The pre-switch snapshot the restart evidence is compared against.
export function unitSnapshot({ units = LONG_RUNNING_SERVICES } = {}) {
  return new Map(runningReleases({ units }).map((status) => [status.unit, {
    pid: status.pid,
    startedMonotonic: status.startedMonotonic,
    release: status.directory ? path.basename(status.directory) : null,
  }]));
}

function verifyLive({ releaseDirectory, reporter, expectVersion, before = null }) {
  const problems = [];

  const processes = settledRunningRelease(releaseDirectory, { before, reporter });
  if (!processes.ok) {
    if (processes.notRunning.length > 0) problems.push(`not running: ${processes.notRunning.join(", ")}`);
    if (processes.wrongRelease.length > 0) problems.push(`still running the previous release: ${processes.wrongRelease.join(", ")}`);
    if (processes.notRestarted.length > 0) problems.push(`did not re-exec after the switch: ${processes.notRestarted.join(", ")}`);
    if (processes.unknown.length > 0) problems.push(`could not be shown to run this release: ${processes.unknown.join(", ")}`);
  }

  const web = probeWeb();
  if (!web.ok) problems.push(`the panel did not answer ${LOGIN_PATH}`);
  else reporter.log(`the panel answered ${LOGIN_PATH} with ${web.status}`);

  // The authenticated surface, checked as far as a command that holds no
  // credentials honestly can: that it is served by this release and that it
  // still refuses an anonymous caller. A signed-in page returning 200 here would
  // be an authorization regression, and a 404 would be a panel whose routes did
  // not survive the update — both are failures, and neither is visible from
  // `/login` alone.
  //
  // It is deliberately not a login. Minting a session would mean this command
  // holding an operator credential, and the receipt would claim more than was
  // checked. The real signed-in pass belongs to the operator rehearsal, and
  // OPERATIONS §22 says so.
  for (const [path_, acceptable, description] of [
    ["/projects", [301, 302, 303, 307, 308], "redirects an anonymous caller to the login page"],
    ["/api/control-plane/snapshot", [401], "refuses an anonymous API caller"],
  ]) {
    const status = probePath(path_);
    if (status === null) {
      problems.push(`${path_} did not answer`);
    } else if (!acceptable.includes(status)) {
      problems.push(`${path_} answered ${status}; the authenticated surface no longer ${description}`);
    }
  }

  if (web.ok) {
    const test = selfTest();
    if (!test.ok) {
      problems.push(`the panel's self-test failed${test.status ? ` (${test.status})` : ""}: ${test.failures?.join("; ") || "no answer"}`);
    } else if (test.supported) {
      reporter.log("the panel's self-test passed: every page's data loads");
    } else {
      reporter.log("this release has no panel self-test (before rc.128)");
    }
  }

  const version = run(sys("/usr/local/bin/infra-cod"), ["version"], { timeout: 30_000 });
  if (version.ok) {
    try {
      const reported = JSON.parse(version.stdout).version;
      if (reported !== expectVersion) problems.push(`the installed command reports version ${reported}, expected ${expectVersion}`);
    } catch {
      problems.push(`\`infra-cod version\` did not answer with JSON: ${version.stdout}`);
    }
  } else {
    problems.push(`\`infra-cod version\` failed: ${version.stderr || version.stdout}`);
  }

  // The health snapshot, run *now* rather than remembered.
  //
  // A oneshot's `Result` is the verdict of whenever it last ran, and after a
  // failed update that is the failure being recovered from: on the first real
  // rollback, `infra-cod-health.service` had failed mid-outage because a worker
  // was inactive, and a rollback that had just brought everything back was
  // reported unhealthy on the strength of that stale record. A minute later the
  // timer ran it again and it passed.
  //
  // So it is started, and its fresh exit is the answer. The other two oneshots
  // are not judged by their unit state at all: the backup and the restore drill
  // prove themselves with receipts, which this update required before it touched
  // anything.
  systemctl("reset-failed", "infra-cod-health.service");
  const health = systemctl("start", "infra-cod-health.service");
  if (!health.ok) {
    problems.push(`the health snapshot failed after the switch: ${health.stderr || `systemctl exited ${health.code}`}`);
  } else {
    reporter.log("the health snapshot passed");
  }

  for (const timer of TIMERS) {
    const active = systemctl("is-active", `${timer}.timer`);
    if (!active.ok) problems.push(`${timer}.timer is not active`);
  }
  // Sockets are checked by their absence from the contract: this installation
  // has no `.socket` units, so there is nothing here to verify. If one is ever
  // added it goes into `unit-contract.mjs`, which is where this loop would read
  // it from — rather than into a list kept privately here, which is how the five
  // hand-kept unit lists drifted apart in the first place.

  const backup = latestBackupReceipt();
  if (!backup) problems.push("no backup receipt is present after the update");

  const doctor = run(sys("/usr/local/bin/infra-cod"), ["doctor", "--json"], { timeout: 300_000 });
  let critical = null;
  try {
    critical = JSON.parse(doctor.stdout).critical;
  } catch {
    critical = null;
  }
  if (critical === null) problems.push("doctor did not produce a readable report");
  else if (critical > 0) problems.push(`doctor reports ${critical} critical issue(s)`);
  else reporter.log("doctor reports no critical issues");

  return { ok: problems.length === 0, problems, processes: processes.observed, doctorCritical: critical };
}

// The ledger tip for a receipt. A receipt is written on the failure path too,
// where a database that cannot be reached must not turn into a second error on
// top of the first one.
function readLedgerTip() {
  try {
    return [...ledgerVersions()].at(-1) ?? null;
  } catch {
    return null;
  }
}

function latestBackupReceipt() {
  const file = path.join(BACKUP_ROOT, "latest.json");
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Backup and restore drill
// ---------------------------------------------------------------------------

// A backup taken before this update, and a restore that was actually performed
// from it. The units are the ones the timers run, so what is rehearsed here is
// the same path recovery would take — and the receipt is read back rather than
// inferred from the exit code.
function requireFreshBackup(reporter) {
  const startedAt = Date.now();
  reporter.step("backed_up", "taking a pre-update backup");
  systemctl("reset-failed", "infra-cod-backup.service");
  const backup = systemctl("start", "infra-cod-backup.service");
  if (!backup.ok) throw new UpdateError(`the pre-update backup failed: ${backup.stderr}`);

  const receipt = latestBackupReceipt();
  if (!receipt) throw new UpdateError("the backup unit reported success but wrote no receipt");
  const createdAt = Date.parse(receipt.created_at ?? "");
  if (!Number.isFinite(createdAt) || createdAt < startedAt - 60_000) {
    throw new UpdateError(
      `the newest backup receipt is from ${receipt.created_at}, which predates this update. `
      + "The update refuses to proceed on a backup it did not just take.",
    );
  }

  reporter.step("backed_up", "rehearsing a restore from that backup");
  systemctl("reset-failed", "infra-cod-restore-drill.service");
  const drill = systemctl("start", "infra-cod-restore-drill.service");
  if (!drill.ok) throw new UpdateError(`the restore drill failed: ${drill.stderr}`);

  const drillReceipt = path.join(BACKUP_ROOT, `${receipt.encrypted_file}.restore.json`);
  if (!existsSync(drillReceipt)) {
    throw new UpdateError(`the restore drill wrote no receipt for ${receipt.encrypted_file}; the backup is not proven restorable`);
  }
  return { backup: receipt.encrypted_file, backupId: receipt.backup_id, createdAt: receipt.created_at, drillReceipt };
}

// ---------------------------------------------------------------------------
// Rollback of a failed update
// ---------------------------------------------------------------------------

function rollbackTo({ directory, reporter, applicationRollbackSafe, before = null, leaving = null }) {
  if (!applicationRollbackSafe) {
    return {
      performed: false,
      outcome: "database_restore_required",
      detail:
        "the schema has moved past what the previous release can read, so switching back would not be a rollback. "
        + "Restore the pre-update backup before starting the previous release.",
    };
  }
  reporter.step("switched", `rolling back to ${path.basename(directory)}`);
  systemctl("stop", "infra-cod.target");
  // Back to the old release's declaration: what the failed one added is retired.
  installUnits(directory, reporter, { leaving });
  switchCurrent(directory);
  const reload = systemctl("daemon-reload");
  if (!reload.ok) reporter.warn(`daemon-reload during rollback failed: ${reload.stderr}`);
  restartTarget(reporter, directory);

  const manifest = readManifest(directory);
  const live = verifyLive({ releaseDirectory: directory, reporter, expectVersion: manifest.version, before: before?.units ?? null });
  return {
    performed: true,
    outcome: live.ok ? "rolled_back" : "rollback_unhealthy",
    version: manifest.version,
    detail: live.ok ? null : live.problems.join("; "),
  };
}

// ---------------------------------------------------------------------------
// `infra-cod releases list`
// ---------------------------------------------------------------------------

export async function runReleases(argv = [], { stdout = process.stdout, stderr = process.stderr } = {}) {
  const [subcommand = "list", ...rest] = argv;
  if (subcommand !== "list") {
    stderr.write(`infra-cod releases: unknown subcommand ${JSON.stringify(subcommand)}; the only one is \`list\`\n`);
    return 2;
  }
  const json = rest.includes("--json");
  const releases = listReleases();
  const running = runningReleases();
  const report = {
    current: currentReleaseDirectory(),
    releases,
    running: running.map((entry) => ({
      unit: entry.unit,
      pid: entry.pid,
      release: entry.directory ? path.basename(entry.directory) : null,
    })),
    receipts: listReceipts({ limit: 5 }).map((receipt) => ({
      action: receipt.action,
      from: receipt.from?.version ?? null,
      to: receipt.to?.version ?? null,
      outcome: receipt.outcome,
      finishedAt: receipt.finishedAt,
    })),
  };

  if (json) {
    stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return 0;
  }

  if (releases.length === 0) {
    stdout.write(`no releases are installed under ${RELEASES_DIR}\n`);
    return 0;
  }
  for (const release of releases) {
    const marks = [
      release.current ? "current" : null,
      release.intact === false ? "CHECKSUM MISMATCH" : null,
      release.problem ? release.problem : null,
    ].filter(Boolean);
    stdout.write(`${release.current ? "*" : " "} ${release.name.padEnd(24)} ${String(release.version ?? "?").padEnd(16)} ${marks.join(", ")}\n`);
  }
  const mismatched = report.running.filter((entry) => entry.release && entry.release !== path.basename(report.current ?? ""));
  if (mismatched.length > 0) {
    stdout.write(`\nservices not executing the current release: ${mismatched.map((entry) => `${entry.unit} (${entry.release})`).join(", ")}\n`);
  }
  return 0;
}

// ---------------------------------------------------------------------------
// `infra-cod update`
// ---------------------------------------------------------------------------

function parseUpdateArguments(argv) {
  const options = {
    artifact: null, checksums: null, signature: null, publicKey: null,
    json: false, yes: false, resume: false, abandon: false,
    drainTimeout: 300, interruptActive: false,
  };
  const rest = [...argv];
  while (rest.length > 0) {
    const argument = rest.shift();
    const value = () => {
      const next = rest.shift();
      if (next === undefined) throw new UpdateError(`${argument} needs a value`);
      return next;
    };
    switch (argument) {
      case "--artifact": options.artifact = value(); break;
      case "--checksums": options.checksums = value(); break;
      case "--signature": options.signature = value(); break;
      case "--public-key": options.publicKey = value(); break;
      case "--drain-timeout": options.drainTimeout = Number.parseInt(value(), 10); break;
      case "--interrupt-active": options.interruptActive = true; break;
      case "--json": options.json = true; break;
      case "--yes": options.yes = true; break;
      case "--resume": options.resume = true; break;
      case "--abandon": options.abandon = true; break;
      default: throw new UpdateError(`unknown argument ${JSON.stringify(argument)}`);
    }
  }
  return options;
}

export async function runUpdate(argv = [], { stdout = process.stdout, stderr = process.stderr } = {}) {
  let options;
  try {
    options = parseUpdateArguments(argv);
  } catch (error) {
    stderr.write(`infra-cod update: ${error.message}\n`);
    return 2;
  }

  if (options.abandon) {
    const state = readUpdateState();
    clearUpdateState();
    stdout.write(state
      ? `abandoned the interrupted update recorded at phase ${state.phase}; the staged tree at ${state.stagedDirectory ?? "none"} was left in place\n`
      : "there was no interrupted update to abandon\n");
    return 0;
  }

  for (const [flag, value] of [["--artifact", options.artifact], ["--checksums", options.checksums], ["--signature", options.signature], ["--public-key", options.publicKey]]) {
    if (!value) {
      stderr.write(`infra-cod update: ${flag} is required\n`);
      return 2;
    }
  }

  const reporter = new Reporter({ stdout, stderr, json: options.json });
  const startedAt = new Date().toISOString();

  try {
    return await withHostLock(async () => {
      // Held for the whole run, and for a resumed one: a check that was true at
      // the start says nothing about the minutes that follow, and those minutes
      // are what unattended-upgrades interrupted.
      const packageLock = await holdPackageManagerLock(reporter);
      try {
        return await execute({ options, reporter, stdout, startedAt });
      } finally {
        await packageLock.release();
      }
    });
  } catch (error) {
    stderr.write(`infra-cod update: ${error.message}\n`);
    return 1;
  }
}

async function execute({ options, reporter, stdout, startedAt }) {
  const interrupted = readUpdateState();
  if (interrupted && interrupted.phase !== "complete" && !options.resume) {
    reporter.warn(
      `an earlier update stopped after phase ${interrupted.phase} (${interrupted.from?.version ?? "?"} -> ${interrupted.to?.version ?? "?"}). `
      + "Re-run with --resume to continue it, or --abandon to discard the record.",
    );
    return 1;
  }

  const fromDirectory = currentReleaseDirectory();
  if (!fromDirectory || !existsSync(fromDirectory)) {
    throw new UpdateError(`${CURRENT_LINK} does not resolve to an installed release; this host has nothing to update`);
  }
  const fromManifest = readManifest(fromDirectory);

  // A resume that can reuse the staged tree, or a run that starts over.
  //
  // Reuse is allowed only when the recorded tree is still on disk *and* still
  // matches the checksums it shipped with — a half-written release directory is
  // exactly what a power loss during staging leaves behind, and "the directory
  // exists" would accept it. Everything before staging is redone, because
  // nothing before staging left anything worth keeping: the backup is retaken
  // and the drain re-established, which is what resuming an update on a host
  // that has been running in the meantime ought to mean.
  if (options.resume && interrupted?.action === "rollback") {
    // A rollback that was interrupted is finished by running the rollback again,
    // not by resuming an update into it: the two commands end in different
    // places, and `--resume` guessing between them is how a host gets the
    // opposite of what the operator asked for.
    throw new UpdateError(
      `the interrupted run was a rollback to ${interrupted.to?.version ?? "an installed release"}, not an update. `
      + `Re-run \`infra-cod rollback --to ${interrupted.to?.version ?? "<version>"}\`, which is idempotent, `
      + "or discard the record with `infra-cod update --abandon`.",
    );
  }
  const resumable = options.resume ? interrupted : null;
  const reusable = resumable?.stagedDirectory
    && existsSync(resumable.stagedDirectory)
    && releaseIntact(resumable.stagedDirectory)
    ? resumable
    : null;
  if (resumable && !reusable) {
    reporter.warn(
      `the interrupted run recorded a staged release at ${resumable.stagedDirectory ?? "no directory"}, `
      + "which is missing or does not match its own checksums; starting over from the artifact instead",
    );
    clearUpdateState();
  }
  if (reusable) {
    return resumeFromStaged({ options, reporter, stdout, startedAt, fromDirectory, fromManifest, state: reusable });
  }

  // Phase 1 — verification, before the manifest of the new artifact is believed.
  const { staging, tree, manifest } = verifyArtifact({ ...options, reporter });
  const to = { version: manifest.version, channel: manifest.channel, gitSha: manifest.git?.sha ?? null };
  const from = { version: fromManifest.version, directory: fromDirectory };
  injectFault("verified");

  if (!options.yes && stdout.isTTY) {
    reporter.warn(`this will update ${from.version} to ${to.version} on this host; re-run with --yes to confirm`);
    rmSync(staging, { recursive: true, force: true });
    return 1;
  }

  // Phase 2 — what the host looks like before anything changes.
  //
  // The unit snapshot is not diagnostics: it is the evidence the post-switch
  // check compares against for the two services that do not run from the release
  // tree, and the unit contract is recorded so a receipt says which set of units
  // this host was verified against rather than which set the reader assumes.
  const before = {
    release: from.version,
    directory: fromDirectory,
    ledger: [...ledgerVersions()],
    unitContract: { longRunning: [...LONG_RUNNING_SERVICES], oneshots: [...ONESHOT_SERVICES], timers: [...TIMERS] },
    units: unitSnapshot(),
    running: verifyRunningRelease(fromDirectory).observed,
  };
  reporter.step("recorded", `current release ${from.version}, ${before.ledger.length} migrations applied`);
  injectFault("recorded");

  // Phase 3 — a backup taken now, and proven restorable now.
  const backup = requireFreshBackup(reporter);
  injectFault("backed_up");

  // Phase 4 — drain.
  const drained = drain({
    reporter,
    timeoutSeconds: Number.isInteger(options.drainTimeout) ? options.drainTimeout : 300,
    interruptActive: options.interruptActive,
  });
  injectFault("drained");

  // Phase 5 — stage beside the live tree. The live tree is never written through.
  const wanted = path.join(RELEASES_DIR, manifest.version);
  const stagedDirectory = existsSync(wanted) ? freeReleasePath(wanted) : wanted;
  mkdirSync(RELEASES_DIR, { recursive: true });
  renameSync(tree, stagedDirectory);
  rmSync(staging, { recursive: true, force: true });
  reporter.step("staged", `new release staged at ${path.basename(stagedDirectory)}, ${path.basename(fromDirectory)} untouched`);
  // The ledger as it stood *before* this update touched it. Recorded here
  // because it is the one fact a resumed run cannot recover by looking: after
  // the migration has landed, "what was applied before" is no longer visible
  // anywhere on the host.
  const origin = { ledger: before.ledger, schemaFrom: before.ledger.at(-1) ?? null };
  writeUpdateState({ phase: "staged", action: "update", from, to, startedAt, stagedDirectory, backup, origin });
  injectFault("staged");

  return applyStagedRelease({
    options, reporter, stdout, startedAt,
    from, to, fromDirectory, stagedDirectory, manifest, before, backup, drained, origin,
    resumedFrom: null,
  });
}

// Continuing a run that was interrupted after its tree was already staged.
//
// What is reused is exactly one thing: the staged release, and only after it is
// re-checked against the checksums it shipped with. Everything else is redone —
// the host has been running in the meantime, so the drain has to be
// re-established and the ledger re-read. The rollback target is the release the
// interrupted run recorded, not whatever `current` happens to point at now: a
// crash after the switch leaves `current` on the new tree, and rolling "back" to
// it would be rolling back to the release that failed.
async function resumeFromStaged({ options, reporter, stdout, startedAt, fromDirectory, fromManifest, state }) {
  const stagedDirectory = state.stagedDirectory;
  const manifest = readManifest(stagedDirectory);
  reporter.step(state.phase, `resuming a run that stopped after ${state.phase}; reusing the staged ${path.basename(stagedDirectory)}`);

  const recordedPrevious = state.from?.directory ?? null;
  const previousDirectory = recordedPrevious && existsSync(recordedPrevious) && releaseIntact(recordedPrevious)
    ? recordedPrevious
    : fromDirectory;
  if (previousDirectory !== fromDirectory) {
    reporter.log(`the interrupted run had already switched; ${path.basename(previousDirectory)} remains the rollback target`);
  }
  const previousManifest = readManifest(previousDirectory);

  const drained = drain({
    reporter,
    timeoutSeconds: Number.isInteger(options.drainTimeout) ? options.drainTimeout : 300,
    interruptActive: options.interruptActive,
  });

  // The origin the interrupted run recorded, which is the only place the
  // pre-update schema boundary still exists once its migration has landed. A
  // state file from a build that did not record one leaves the boundary unknown,
  // and the receipt says `null` rather than inventing today's ledger as
  // yesterday's starting point.
  const origin = state.origin ?? null;
  if (!origin) {
    reporter.warn("the interrupted run recorded no schema boundary; the receipt will not claim one");
  }

  const before = {
    release: previousManifest.version,
    directory: previousDirectory,
    ledger: [...ledgerVersions()],
    unitContract: { longRunning: [...LONG_RUNNING_SERVICES], oneshots: [...ONESHOT_SERVICES], timers: [...TIMERS] },
    units: unitSnapshot(),
    running: verifyRunningRelease(previousDirectory).observed,
  };

  return applyStagedRelease({
    options, reporter, stdout, startedAt,
    from: { version: previousManifest.version, directory: previousDirectory },
    to: { version: manifest.version, channel: manifest.channel, gitSha: manifest.git?.sha ?? null },
    fromDirectory: previousDirectory,
    stagedDirectory, manifest, before,
    backup: state.backup ?? null,
    drained,
    origin,
    resumedFrom: state.phase,
  });
}

// Everything that happens once a verified release is on disk beside the live
// one. The fresh path and the resumed path both end up here, because a resume
// that re-implemented any of it would be a second update coordinator with a
// smaller test suite.
async function applyStagedRelease({
  options, reporter, stdout, startedAt,
  from, to, fromDirectory, stagedDirectory, manifest, before, backup, drained, origin, resumedFrom,
}) {
  // Phase 6 — the compatibility decision, from the incoming release's contract.
  const contract = releaseContract(manifest);
  const applied = ledgerVersions();
  const pending = migrationVersionsIn(stagedDirectory).filter((entry) => !applied.has(entry.version));
  const decision = decideCompatibility({ contract, pending });
  reporter.step("decided", `${pending.length} pending migration(s): ${decision.reason}`);
  // Migration versions named the way a reviewer reads them — `0051_additive.sql`
  // rather than `0051`. The ledger stores versions, so the names come from the
  // release that shipped them, and a version this release does not carry stays a
  // bare version rather than being dropped from the receipt.
  const namesByVersion = new Map(migrationVersionsIn(stagedDirectory).map((entry) => [entry.version, entry.name]));
  const named = (version) => namesByVersion.get(version) ?? version;
  writeUpdateState({ phase: "decided", action: "update", from, to, startedAt, stagedDirectory, backup, decision, origin });
  injectFault("decided");

  const failure = async (error) => {
    reporter.warn(`the update failed: ${error.message}`);
    // Asked now, not before the migration ran. `decision` answered "may the old
    // release keep serving *through* this migration"; what a rollback needs is
    // "can it read the schema that is on disk at this moment", and the two differ
    // in both directions — a migration that failed before applying anything
    // leaves the old release perfectly able to read the schema, and a run
    // resumed after its migration landed must not be told there is nothing
    // pending.
    const safety = schemaCompatibleWith({ targetDirectory: fromDirectory, contract });
    reporter.log(`rollback to ${from.version}: ${safety.reason}`);
    const outcome = rollbackTo({
      directory: fromDirectory,
      reporter,
      applicationRollbackSafe: safety.applicationRollbackSafe,
      before,
      leaving: stagedDirectory,
    });
    const receipt = writeReceiptAtomically({
      schema: "infra-cod/release-receipt/1",
      action: "update",
      // The rollback's own verdict, including the one that says a rollback was
      // not possible. Collapsing that into "failed" would lose the only sentence
      // the operator needs: that the database, not the symlink, is what has to
      // be put back.
      outcome: outcome.outcome,
      actor: actorName(),
      startedAt,
      finishedAt: new Date().toISOString(),
      from: { version: from.version, directory: path.basename(fromDirectory) },
      to: { version: to.version, directory: path.basename(stagedDirectory) },
      schemaBoundary: {
        from: origin?.schemaFrom ?? null,
        to: readLedgerTip(),
        pending: pending.map((entry) => entry.name),
        beyondRollbackTarget: (safety.beyond ?? []).map(named),
        applicationRollbackSafe: safety.applicationRollbackSafe,
      },
      artifact: { digest: sha256Of(options.artifact), file: path.basename(options.artifact) },
      backup,
      resumedFrom,
      error: error.message,
      rollback: outcome,
      steps: reporter.steps,
    });
    clearUpdateState();
    reporter.warn(`receipt: ${receipt}`);
    if (options.json) stdout.write(`${readFileSync(receipt, "utf8")}`);
    return 1;
  };

  try {
    // Phase 7 — the application target comes down before a schema it cannot read.
    if (decision.mustStopBeforeMigrating && pending.length > 0) {
      reporter.step("stopped", "stopping infra-cod.target before an incompatible migration");
      const stop = systemctl("stop", "infra-cod.target");
      if (!stop.ok) throw new UpdateError(`infra-cod.target could not be stopped: ${stop.stderr}`);
      writeUpdateState({ phase: "stopped", action: "update", from, to, startedAt, stagedDirectory, backup, decision, origin });
      injectFault("stopped");
    }

    // Phase 8 — migrate with the new release's runner, never by editing a
    // deployed migration.
    if (pending.length > 0) {
      reporter.step("migrated", `applying ${pending.map((entry) => entry.name).join(", ")}`);
      const runner = path.join(stagedDirectory, "deploy/run-production-migrations.sh");
      if (!existsSync(runner)) throw new UpdateError(`the staged release carries no migration runner at ${runner}`);
      const migrated = run(runner, [stagedDirectory], { timeout: 1_800_000 });
      if (!migrated.ok) throw new UpdateError(`migrations failed: ${migrated.stderr || migrated.stdout}`);
    } else {
      reporter.step("migrated", "no migrations to apply");
    }
    writeUpdateState({ phase: "migrated", action: "update", from, to, startedAt, stagedDirectory, backup, decision, origin });
    injectFault("migrated");

    // Phase 9 — units, symlink, reload, restart. Each of the three mutations is
    // its own injection point: "the units were installed but the symlink did not
    // move" and "the symlink moved but nothing restarted" are different hosts to
    // come back to, and the second one is the state this whole command exists
    // because of.
    installUnits(stagedDirectory, reporter, { leaving: fromDirectory });
    writeUpdateState({ phase: "units_installed", action: "update", from, to, startedAt, stagedDirectory, backup, decision, origin });
    injectFault("units_installed");
    switchCurrent(stagedDirectory);
    reporter.step("switched", `current -> ${path.basename(stagedDirectory)}`);
    writeUpdateState({ phase: "symlink_switched", action: "update", from, to, startedAt, stagedDirectory, backup, decision, origin });
    injectFault("symlink_switched");
    restartTarget(reporter, stagedDirectory);
    writeUpdateState({ phase: "switched", action: "update", from, to, startedAt, stagedDirectory, backup, decision, origin });
    injectFault("switched");

    // Phase 10 — proof, from the processes themselves.
    const live = verifyLive({ releaseDirectory: stagedDirectory, reporter, expectVersion: to.version, before: before.units });
    if (!live.ok) throw new UpdateError(`the updated host did not verify: ${live.problems.join("; ")}`);
    reporter.step("verified_live", "the running services are the new release and the stack is healthy");
    writeUpdateState({ phase: "verified_live", action: "update", from, to, startedAt, stagedDirectory, backup, decision, origin });
    injectFault("verified_live");

    // The dispatcher comes back only now: the drain is over when the host it
    // drained is proven.
    systemctl("start", "infra-cod-dispatcher.service");

    const afterLedger = [...ledgerVersions()];
    // The boundary this update crossed, measured against the ledger recorded
    // before it started — not against the ledger as it looks now.
    //
    // A resumed run re-reads the ledger after its migration has already landed,
    // so "what is pending" is empty and the schema looks as if it never moved.
    // The receipt said so: `0051 -> 0051, applied: [], rollbackSafe: true` for an
    // update that had in fact applied an incompatible 0051 over 0050. Every field
    // here now comes either from the recorded origin or from the same question
    // the failure path asks — can the previous release read the schema that is
    // there now — so a receipt cannot authorise a rollback the coordinator would
    // itself refuse.
    const originLedger = new Set(origin?.ledger ?? []);
      const appliedNow = afterLedger.filter((version) => !originLedger.has(version)).map(named);
    const safety = schemaCompatibleWith({ targetDirectory: fromDirectory, contract });
    const receipt = writeReceiptAtomically({
      schema: "infra-cod/release-receipt/1",
      action: "update",
      outcome: "updated",
      actor: actorName(),
      startedAt,
      finishedAt: new Date().toISOString(),
      from: { version: from.version, directory: path.basename(fromDirectory) },
      to: { version: to.version, directory: path.basename(stagedDirectory), channel: to.channel, gitSha: to.gitSha },
      schemaBoundary: {
        from: origin?.schemaFrom ?? null,
        to: afterLedger.at(-1) ?? null,
        applied: appliedNow,
        beyondRollbackTarget: (safety.beyond ?? []).map(named),
        applicationRollbackSafe: safety.applicationRollbackSafe,
        rollbackReason: safety.reason,
      },
      artifact: { digest: sha256Of(options.artifact), file: path.basename(options.artifact) },
      backup,
      drained,
      resumedFrom,
      unitContract: before.unitContract,
      processes: live.processes,
      doctorCritical: live.doctorCritical,
      steps: reporter.steps,
    });
    writeUpdateState({ phase: "complete", action: "update", from, to, startedAt, stagedDirectory });
    clearUpdateState();

    // Both releases are kept. A rollback target that was deleted to save disk is
    // not a rollback target. Older ones go, past a count: nothing removed them
    // before rc.121, and on rc.120 they and the backups had filled the disk.
    reporter.log(`updated ${from.version} -> ${to.version}; ${path.basename(fromDirectory)} is retained for rollback`);
    pruneReleases({ protect: [stagedDirectory, fromDirectory], reporter });
    reporter.log(`receipt: ${receipt}`);
    if (options.json) stdout.write(`${readFileSync(receipt, "utf8")}`);
    return 0;
  } catch (error) {
    return failure(error);
  }
}

// After the update is complete and its receipt written, so a failure here can
// only leave an extra directory behind — it is reported, never fatal.
function pruneReleases({ protect, reporter }) {
  try {
    const keep = Number(process.env.INFRA_RELEASES_KEEP ?? 5);
    const installed = readdirSync(RELEASES_DIR, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => ({ name: entry.name, installedAt: statSync(path.join(RELEASES_DIR, entry.name)).mtimeMs }));
    const removed = releasesToPrune(installed, { keep, protect: protect.map((directory) => path.basename(directory)) });
    for (const name of removed) rmSync(path.join(RELEASES_DIR, name), { recursive: true, force: true });
    if (removed.length > 0) reporter.log(`removed ${removed.length} older release(s), keeping the newest ${keep}: ${removed.join(", ")}`);
  } catch (error) {
    reporter.warn(`older releases were not removed: ${error.message}`);
  }
}

function sha256Of(file) {
  const result = run("sha256sum", [file], { timeout: 120_000 });
  if (!result.ok) return null;
  return result.stdout.split(/\s+/)[0] ?? null;
}

function actorName() {
  return process.env.INFRA_COD_ACTOR ?? process.env.SUDO_USER ?? process.env.USER ?? "root";
}

// ---------------------------------------------------------------------------
// `infra-cod rollback`
// ---------------------------------------------------------------------------

export async function runRollback(argv = [], { stdout = process.stdout, stderr = process.stderr } = {}) {
  let target = null;
  let json = false;
  let yes = false;
  const rest = [...argv];
  while (rest.length > 0) {
    const argument = rest.shift();
    if (argument === "--to") target = rest.shift() ?? null;
    else if (argument === "--json") json = true;
    else if (argument === "--yes") yes = true;
    else {
      stderr.write(`infra-cod rollback: unknown argument ${JSON.stringify(argument)}\n`);
      return 2;
    }
  }
  if (!target) {
    stderr.write("infra-cod rollback: --to <installed-version> is required; `infra-cod releases list` names them\n");
    return 2;
  }

  const reporter = new Reporter({ stdout, stderr, json });
  const startedAt = new Date().toISOString();

  try {
    return await withHostLock(async () => {
      // A rollback stops and restarts every service too. An apt run in the middle
      // of it is the same hazard as one in the middle of an update.
      const packageLock = await holdPackageManagerLock(reporter);
      try {
        return await performRollback();
      } finally {
        await packageLock.release();
      }
    });

    async function performRollback() {
      const currentDirectory = currentReleaseDirectory();
      if (!currentDirectory) throw new UpdateError(`${CURRENT_LINK} resolves to nothing; there is no release to roll back from`);
      const currentManifest = readManifest(currentDirectory);
      const destination = resolveVersionToDirectory(target);
      // `current` already pointing at the target is not the same fact as the
      // target running. An interrupted rollback leaves exactly that: the symlink
      // moved, the services stopped or still on the old tree. Re-running the
      // command has to finish the job — that is what makes `rollback` its own
      // recovery path — and has to be a no-op when there is nothing left to do.
      const alreadyCurrent = path.resolve(destination.directory) === path.resolve(currentDirectory);
      if (alreadyCurrent) {
        const settled = verifyRunningRelease(destination.directory);
        if (settled.notRunning.length === 0 && settled.wrongRelease.length === 0) {
          reporter.log(`${target} is already current and running; nothing to do`);
          clearUpdateState();
          return 0;
        }
        reporter.warn(
          `${target} is already current but ${[...settled.notRunning, ...settled.wrongRelease].join(", ")} `
          + "is not running it; finishing the interrupted rollback",
        );
      }
      if (!releaseIntact(destination.directory)) {
        throw new UpdateError(`${destination.name} does not match the checksums it shipped with and will not be started`);
      }

      // Can the release being rolled *to* read the schema that is there now?
      //
      // The same question, asked by the same function, as the one a failed
      // update asks before it rolls back — and answered from the contract of the
      // release that installed those migrations, which is the one running now.
      // Anything it does not vouch for is incompatible. This is the check that
      // stops a symlink move from being called a rollback.
      const destinationManifest = readManifest(destination.directory);
      const contract = releaseContract(currentManifest);
      const safety = schemaCompatibleWith({ targetDirectory: destination.directory, contract });

      if (!safety.applicationRollbackSafe) {
        throw new UpdateError(
          `the database has moved past ${destinationManifest.version}: ${safety.reason}. `
          + "An application-only rollback would point old code at a schema it cannot read. "
          + "Restore the pre-update backup instead; `infra-cod releases list` names the receipts that say which one.",
          { recoverable: false },
        );
      }

      if (!yes && stdout.isTTY) {
        reporter.warn(`this will roll ${currentManifest.version} back to ${destinationManifest.version}; re-run with --yes to confirm`);
        return 1;
      }

      reporter.step("switched", `rolling back ${currentManifest.version} -> ${destinationManifest.version}`);
      writeUpdateState({
        phase: "switched", action: "rollback", startedAt,
        from: { version: currentManifest.version }, to: { version: destinationManifest.version },
        stagedDirectory: destination.directory,
      });

      const beforeUnits = unitSnapshot();
      systemctl("stop", "infra-cod.target");
      installUnits(destination.directory, reporter, { leaving: currentDirectory });
      switchCurrent(destination.directory);
      injectFault("rollback_switched");
      restartTarget(reporter, destination.directory);

      const live = verifyLive({
        releaseDirectory: destination.directory,
        reporter,
        expectVersion: destinationManifest.version,
        before: beforeUnits,
      });
      const receipt = writeReceiptAtomically({
        schema: "infra-cod/release-receipt/1",
        action: "rollback",
        outcome: live.ok ? "rolled_back" : "rollback_unhealthy",
        actor: actorName(),
        startedAt,
        finishedAt: new Date().toISOString(),
        from: { version: currentManifest.version, directory: path.basename(currentDirectory) },
        to: { version: destinationManifest.version, directory: destination.name },
        schemaBoundary: { applied: readLedgerTip(), beyondTarget: safety.beyond, applicationRollbackSafe: true },
        processes: live.processes,
        doctorCritical: live.doctorCritical,
        problems: live.problems,
        steps: reporter.steps,
      });
      clearUpdateState();
      reporter.log(`receipt: ${receipt}`);
      if (json) stdout.write(`${readFileSync(receipt, "utf8")}`);
      if (!live.ok) {
        reporter.warn(`the rollback completed but the host did not verify: ${live.problems.join("; ")}`);
        return 1;
      }
      return 0;
    }
  } catch (error) {
    stderr.write(`infra-cod rollback: ${error.message}\n`);
    return error instanceof InventoryError || error instanceof UpdateError ? 1 : 1;
  }
}
