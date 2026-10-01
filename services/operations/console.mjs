// `infra-cod console` — the local operator's read-only view of the host (11.7).
//
// An SSH command, not a web route. The panel runs as `infra-web` and must never
// receive systemctl, journal or `/etc/infra-cod` authority; this command runs as
// the operator over SSH, where all of that is already theirs. Nothing it does
// reaches Caddy, and the web service gains nothing by its existence.
//
// It shows, and it does not change. Every fact here is read from the place that
// already records it — the unit contract, `doctor`, the release tree and its
// receipts, the runtime inventory, the credentials file and the database's own
// verdict on it — because a second derivation is a second opinion that drifts.
// Where a fact asks for action, the console prints the exact command that does
// it. The mutations stay in `update`, `rollback`, `runtime` and `admin`, with
// the locks, confirmations and receipts they already have.
//
// The only two host commands it spawns are `systemctl show` and `journalctl`,
// both through one injectable runner, so the tests can prove that those are the
// only two.
//
// Usage:
//   infra-cod console [--json]                            everything below, except logs
//   infra-cod console units [--json]                      allowlisted units with their systemd state
//   infra-cod console doctor [--json]                     the doctor report
//   infra-cod console logs --unit <u> [--lines N] [--json]  bounded, redacted journal of one allowlisted unit
//   infra-cod console releases [--json]                   installed and running release ids
//   infra-cod console runtimes [--json]                   runtime versions and readiness
//   infra-cod console credentials [--json]                whether the initial credentials still need retiring

import { spawnSync } from "node:child_process";
import path from "node:path";

import { redactError } from "../control-plane/worker-loop.mjs";
import { hasDatabaseConnection, queryJson } from "../control-plane/db.mjs";
import { runDoctor } from "./doctor.mjs";
import { credentialsRetirement, readCredentialsState } from "./initial-credentials.mjs";
import {
  RELEASES_DIR,
  currentReleaseDirectory,
  listReceipts,
  listReleases,
  runningReleases,
} from "./release-inventory.mjs";
import { runtimeNames } from "./runtime-adapters.mjs";
import { RUNTIMES_FILE, readRuntimes } from "./runtime-inventory.mjs";
import { readinessOf } from "./runtime.mjs";
import { readUpdateState } from "./update.mjs";
import { LONG_RUNNING_SERVICES, ONESHOT_SERVICES, POSTGRESQL_UNIT, TIMERS } from "./unit-contract.mjs";

export class ConsoleError extends Error {
  constructor(message) {
    super(message);
    this.name = "ConsoleError";
  }
}

// ---------------------------------------------------------------------------
// The allowlist
// ---------------------------------------------------------------------------

// Every unit the console may name, from the contract and nowhere else.
//
// `journalctl -u` will happily print any unit on the box, and an operator view
// that takes a free-form unit name is a journal reader for `ssh.service` and
// whatever else is there. The database unit is included because the contract
// exports it and `doctor` watches it; `infra-cod.target` because that is what
// `systemctl start` is aimed at. There are no `.socket` units: the supervisor
// opens its own sockets, and `doctor` checks those as files.
export function allowlistedUnits() {
  return [
    ...LONG_RUNNING_SERVICES.map((name) => ({ unit: `${name}.service`, kind: "service" })),
    ...ONESHOT_SERVICES.map((name) => ({ unit: `${name}.service`, kind: "oneshot" })),
    ...TIMERS.map((name) => ({ unit: `${name}.timer`, kind: "timer" })),
    { unit: "infra-cod.target", kind: "target" },
    { unit: POSTGRESQL_UNIT, kind: "service" },
  ];
}

// A name the operator typed, resolved to one allowlisted unit or refused.
//
// A bare name means the service: `infra-cod-backup` is the oneshot, and its
// timer has to be asked for as `infra-cod-backup.timer`. Anything the contract
// does not name is refused with the list, so the refusal is also the help.
export function resolveAllowlistedUnit(name) {
  if (typeof name !== "string" || name.trim().length === 0) {
    throw new ConsoleError("--unit names which unit to read; it is required");
  }
  const wanted = name.trim();
  const allowed = allowlistedUnits();
  const found = allowed.find(({ unit }) => unit === wanted)
    ?? allowed.find(({ unit }) => unit === `${wanted}.service`);
  if (!found) {
    throw new ConsoleError(
      `${JSON.stringify(wanted)} is not a unit of this installation; the console reads only: `
      + allowed.map(({ unit }) => unit).join(", "),
    );
  }
  return found;
}

// ---------------------------------------------------------------------------
// Bounds and redaction
// ---------------------------------------------------------------------------

export const DEFAULT_LOG_LINES = 200;
export const MAX_LOG_LINES = 2000;
export const MAX_LOG_BYTES = 256 * 1024;
// A journal line has no natural length: a runtime that dumps a JSON document
// on one line dumps it into the journal on one line too.
const MAX_LINE_CHARACTERS = 4096;

// Assignments and headers whose value is a secret whatever the value looks like.
//
// `redactError` knows the shapes that reach an error message — JWTs, `sk-`/`rk-`
// keys, e-mail addresses — and is reused for those. A journal also carries what
// a process printed on purpose: a `PGPASSWORD=` from a shell trace, an
// `Authorization: Bearer` from a debug line, a `token=` in a URL. Those are
// recognised by their name, the same names `runtime-inventory.mjs` refuses to
// record, so a value of any shape after them is dropped. No word boundary in
// front of the name on purpose: `PGPASSWORD=` and `OPENAI_API_KEY=` are the
// shapes an environment dump has, and the name is the suffix.
const NAMED_SECRET = /(token|secret|password|passphrase|passwd|api[_-]?key|credential|authorization|private[_-]?key|access[_-]?key|client[_-]?secret)(s?)(["']?\s*[=:]\s*)(["']?)([^\s"',;&]+)/gi;
const BEARER = /\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi;
// GitHub's prefixed tokens, which the broker mints and a failed push may echo.
const GITHUB_TOKEN = /\b(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g;
const PEM_BLOCK = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)/g;

export function redactLine(line) {
  const named = String(line ?? "")
    .replace(PEM_BLOCK, "[REDACTED_PRIVATE_KEY]")
    .replace(GITHUB_TOKEN, "[REDACTED]")
    .replace(BEARER, "$1 [REDACTED]")
    .replace(NAMED_SECRET, "$1$2$3$4[REDACTED]");
  // The shared redaction last, so an e-mail inside a value that was already
  // dropped is not a second thing to get wrong. The fallback is empty on
  // purpose: an empty journal line is an empty line, not "The operation failed."
  return redactError(named, "", [], { maxLength: MAX_LINE_CHARACTERS });
}

// Keeps the newest lines within both caps.
//
// The byte cap is measured after redaction, and it is applied from the end:
// when a journal is bigger than the console will show, what went wrong is at
// the bottom, and the top is what was fine an hour ago.
export function boundLines(lines, { maxLines = DEFAULT_LOG_LINES, maxBytes = MAX_LOG_BYTES } = {}) {
  const kept = [];
  let bytes = 0;
  let truncated = lines.length > maxLines;
  for (let index = lines.length - 1; index >= 0 && kept.length < maxLines; index -= 1) {
    const line = lines[index];
    const size = Buffer.byteLength(line, "utf8") + 1;
    if (bytes + size > maxBytes) {
      truncated = true;
      break;
    }
    bytes += size;
    kept.push(line);
  }
  return { lines: kept.reverse(), bytes, truncated };
}

function parseLineCount(value) {
  const count = Number.parseInt(value ?? "", 10);
  if (!Number.isInteger(count) || count < 1) throw new ConsoleError("--lines takes a positive number");
  return Math.min(count, MAX_LOG_LINES);
}

// ---------------------------------------------------------------------------
// Host commands
// ---------------------------------------------------------------------------

// The one seam every host command goes through. `spawnSync`'s shape, so a test
// can hand in a function that records what was asked and answers from fixtures.
function defaultRun(command, args, options = {}) {
  return spawnSync(command, args, { encoding: "utf8", timeout: 10_000, ...options });
}

const UNIT_PROPERTIES = [
  "ActiveState", "SubState", "Result", "UnitFileState", "MainPID",
  "ActiveEnterTimestamp", "NextElapseUSecRealtime", "LastTriggerUSec",
];

function showUnit(unit, run) {
  const result = run("systemctl", ["show", ...UNIT_PROPERTIES.flatMap((property) => ["-p", property]), unit]);
  const properties = new Map();
  for (const line of (result?.stdout ?? "").split("\n")) {
    const index = line.indexOf("=");
    if (index > 0) properties.set(line.slice(0, index), line.slice(index + 1));
  }
  const pid = Number.parseInt(properties.get("MainPID") ?? "0", 10);
  return {
    available: result?.status === 0,
    activeState: properties.get("ActiveState") ?? null,
    subState: properties.get("SubState") ?? null,
    result: properties.get("Result") ?? null,
    unitFileState: properties.get("UnitFileState") ?? null,
    pid: Number.isInteger(pid) && pid > 0 ? pid : null,
    activeSince: properties.get("ActiveEnterTimestamp") || null,
    nextElapse: properties.get("NextElapseUSecRealtime") || null,
    lastTrigger: properties.get("LastTriggerUSec") || null,
  };
}

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

// Each section returns plain data; rendering is separate, so `--json` prints
// exactly what the text view was rendered from.

export function unitsSection({ run = defaultRun } = {}) {
  const units = allowlistedUnits().map((entry) => ({ ...entry, ...showUnit(entry.unit, run) }));
  return {
    units,
    // What the contract expects of each kind, so the summary does not call a
    // finished oneshot dead: `doctor` asks the same questions the same way.
    attention: units.filter((unit) => {
      if (!unit.available) return true;
      if (unit.kind === "oneshot") return unit.result !== "success";
      return unit.activeState !== "active";
    }).map((unit) => unit.unit),
  };
}

export async function doctorSection({ doctor = defaultDoctor } = {}) {
  return doctor();
}

// `doctor` already has a JSON mode and its own exit code; it is run as itself
// and its report is parsed, so the console cannot disagree with it.
async function defaultDoctor() {
  let out = "";
  const stdout = { write: (chunk) => { out += chunk; } };
  const stderr = { write: () => {} };
  const exitCode = await runDoctor(["--json"], { stdout, stderr });
  const report = JSON.parse(out);
  return { exitCode, ...report };
}

export function logsSection({ unit, lines = DEFAULT_LOG_LINES, maxBytes = MAX_LOG_BYTES, run = defaultRun } = {}) {
  const resolved = resolveAllowlistedUnit(unit);
  const requested = Math.min(lines, MAX_LOG_LINES);
  const result = run("journalctl", ["-u", resolved.unit, "-n", String(requested), "--no-pager", "-o", "short-iso"]);
  if (result?.status !== 0) {
    throw new ConsoleError(
      `journalctl could not read ${resolved.unit}: ${redactLine(result?.stderr ?? result?.error?.message ?? `exit ${result?.status}`).trim() || "no reason given"}`,
    );
  }
  const raw = (result.stdout ?? "").split("\n");
  if (raw.at(-1) === "") raw.pop();
  const bounded = boundLines(raw.map(redactLine), { maxLines: requested, maxBytes });
  return {
    unit: resolved.unit,
    kind: resolved.kind,
    requestedLines: requested,
    maxBytes,
    ...bounded,
    redacted: true,
  };
}

// Installed and running, from the same functions `infra-cod releases list` and
// the update's own post-switch check use. A release is identified by its
// manifest's version and git sha — the two fields the release build records
// and signs — never by the name of a directory, which is a staging accident
// (`0.2.0.r2` is a second install of `0.2.0`).
export function releasesSection({
  releases = () => listReleases({ checkIntegrity: false }),
  current = currentReleaseDirectory,
  running = runningReleases,
  receipts = () => listReceipts({ limit: 5 }),
  updateState = readUpdateState,
} = {}) {
  const installed = releases();
  const currentDirectory = current();
  const byDirectory = new Map(installed.map((release) => [path.resolve(release.directory), release]));
  const identify = (directory) => {
    if (!directory) return null;
    const release = byDirectory.get(path.resolve(directory));
    return {
      directory: path.basename(directory),
      version: release?.version ?? null,
      gitSha: release?.gitSha ?? null,
    };
  };
  const currentRelease = identify(currentDirectory);
  const services = running().map((status) => ({
    unit: status.unit,
    pid: status.pid || null,
    running: identify(status.directory),
    // Two services deliberately run outside the release tree (see
    // `unitWorkingDirectories`), so "unknown" is not "wrong".
    matchesCurrent: status.directory ? path.resolve(status.directory) === path.resolve(currentDirectory ?? "") : null,
  }));
  const pending = updateState();
  return {
    releasesDirectory: RELEASES_DIR,
    current: currentRelease,
    installed: installed.map((release) => ({
      directory: release.name,
      version: release.version,
      channel: release.channel,
      gitSha: release.gitSha,
      latestMigration: release.latestMigration,
      current: release.current,
      problem: release.problem,
    })),
    running: services,
    notCurrent: services.filter((service) => service.matchesCurrent === false).map((service) => service.unit),
    receipts: receipts().map((receipt) => ({
      action: receipt.action ?? null,
      from: receipt.from?.version ?? null,
      to: receipt.to?.version ?? null,
      outcome: receipt.outcome ?? null,
      finishedAt: receipt.finishedAt ?? null,
      unreadable: receipt.unreadable ?? null,
    })),
    interruptedUpdate: pending ? {
      action: pending.action ?? null,
      phase: pending.phase ?? null,
      from: pending.from?.version ?? null,
      to: pending.to?.version ?? null,
      startedAt: pending.startedAt ?? null,
    } : null,
  };
}

// The readiness `infra-cod runtime list` reports, from the inventory file and
// the runtime's own answer, plus every installed tree the record knows about.
// The inventory records provenance and never a credential, so passing it
// through is safe by construction; readiness carries the probe's verdict and
// never its output.
export function runtimesSection({ inventory = readRuntimes, readiness = readinessOf, names = runtimeNames } = {}) {
  let document;
  let problem = null;
  try {
    document = inventory();
  } catch (error) {
    document = { runtimes: {} };
    problem = error.message;
  }
  return {
    inventoryFile: RUNTIMES_FILE,
    problem,
    runtimes: names().map((name) => {
      const entry = document.runtimes?.[name] ?? null;
      let state;
      try {
        state = readiness(name);
      } catch (error) {
        state = { runtime: name, installed: false, authenticated: false, capabilityVerified: false, ready: false, error: error.message };
      }
      return {
        ...state,
        installedVersions: (entry?.installed ?? []).map((installation) => ({
          version: installation.version,
          directory: installation.directory,
          source: installation.source ?? null,
          installedAt: installation.installedAt ?? null,
        })),
      };
    }),
  };
}

// Whether the generated password is still somebody's way in.
//
// Two sources and neither is read for its contents: the file is `lstat`ed, and
// the database is asked the one predicate it owns (0046). The password is in
// the file and its hash is in the database, and this section holds neither —
// `readCredentialsState` never opens the file, and `initial_credentials_status()`
// returns no column that carries a hash.
export async function credentialsSection({
  fileState = () => readCredentialsState(undefined),
  databaseAvailable = hasDatabaseConnection,
  query = queryJson,
} = {}) {
  const file = fileState();
  let status = null;
  let database = "unavailable";
  if (databaseAvailable()) {
    try {
      status = await query("SELECT initial_credentials_status()::text;");
      database = status ? "answered" : "no answer";
    } catch (error) {
      database = `error: ${redactLine(error.message)}`;
    }
  }
  const reason = credentialsRetirement(status);
  const retired = status?.generated_password_retired === true;

  let verdict;
  let command = null;
  if (file.exists === null) {
    verdict = `cannot tell whether ${file.path} exists (${file.error}); a plaintext password may still be on disk`;
  } else if (!file.exists && retired) {
    verdict = "retired: the file is gone and the generated password no longer signs anyone in";
  } else if (!file.exists) {
    verdict = `no credentials file at ${file.path}; ${reason ?? "the database has not confirmed retirement"}`;
  } else if (retired) {
    verdict = `${file.path} is still on disk although the generated password is retired`;
    command = "infra-cod admin ack-credentials --if-retired";
  } else {
    verdict = `${file.path} still holds a plaintext password: ${reason}`;
    command = "sign in with the generated password, replace it, then: infra-cod admin ack-credentials --if-retired";
  }

  return {
    file: {
      path: file.path,
      exists: file.exists,
      error: file.error,
      regularFile: file.regularFile,
      symlink: file.symlink,
      mode: file.mode === null ? null : `0${file.mode.toString(8)}`,
      ownedByRoot: file.uid === null ? null : file.uid === 0,
    },
    database,
    operatorExists: status?.operator_exists ?? null,
    mustChangePassword: status?.must_change_password ?? null,
    lastLoginAt: status?.last_login_at ?? null,
    retired: status ? retired : null,
    requiresRetirement: file.exists === true || (status !== null && !retired),
    reason,
    verdict,
    command,
  };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

const RULE = "─".repeat(60);

function heading(stdout, title) {
  stdout.write(`${title}\n${RULE}\n`);
}

function renderUnits(stdout, section) {
  heading(stdout, "units");
  for (const unit of section.units) {
    const state = unit.available ? `${unit.activeState} (${unit.subState})` : "unavailable";
    const extra = unit.kind === "oneshot" ? `result=${unit.result ?? "?"}`
      // A monotonic timer (OnUnitActiveSec, as the health timer is) has no
      // wall-clock next elapse; systemd leaves NextElapseUSecRealtime empty and
      // `next=-` read as a timer that would never fire. Its last run says more.
      : unit.kind === "timer" ? (unit.nextElapse ? `next=${unit.nextElapse}` : `last=${unit.lastTrigger ?? "-"}`)
        : unit.pid ? `pid ${unit.pid}` : "";
    const mark = section.attention.includes(unit.unit) ? "!" : " ";
    stdout.write(` ${mark} ${unit.unit.padEnd(46)} ${unit.kind.padEnd(8)} ${state.padEnd(20)} ${extra}\n`);
  }
  if (section.attention.length > 0) {
    stdout.write(`\n needs attention: ${section.attention.join(", ")}\n`);
    stdout.write(" to read a unit's journal: infra-cod console logs --unit <unit>\n");
  }
  stdout.write("\n");
}

function renderDoctor(stdout, section) {
  heading(stdout, "doctor");
  for (const check of section.checks ?? []) {
    const icon = check.ok ? "✓" : (check.severity === "critical" ? "✗" : "⚠");
    stdout.write(` ${icon} ${check.check}: ${check.message}\n`);
  }
  stdout.write(` ${section.critical} critical, ${section.warnings} warning(s), ${section.passed} passed\n\n`);
}

function renderLogs(stdout, section) {
  heading(stdout, `logs ${section.unit}`);
  for (const line of section.lines) stdout.write(`${line}\n`);
  const note = section.truncated ? " (truncated to the newest lines within the caps)" : "";
  stdout.write(`${RULE}\n ${section.lines.length} line(s), ${section.bytes} bytes, redacted${note}\n\n`);
}

function renderReleases(stdout, section) {
  heading(stdout, "releases");
  if (section.installed.length === 0) {
    stdout.write(` no releases are installed under ${section.releasesDirectory}\n\n`);
    return;
  }
  for (const release of section.installed) {
    const marks = [release.current ? "current" : null, release.problem].filter(Boolean).join(", ");
    stdout.write(` ${release.current ? "*" : " "} ${release.directory.padEnd(24)} ${String(release.version ?? "?").padEnd(16)} ${(release.gitSha ?? "").slice(0, 12).padEnd(13)} ${marks}\n`);
  }
  const current = section.current
    ? `${section.current.version ?? "?"} (${section.current.gitSha?.slice(0, 12) ?? "no sha"}, ${section.current.directory})`
    : "none";
  stdout.write(` current: ${current}\n`);
  for (const service of section.running) {
    const where = service.running ? `${service.running.version ?? "?"} (${service.running.directory})` : "outside the release tree";
    const mark = service.matchesCurrent === false ? "!" : " ";
    stdout.write(` ${mark} ${service.unit.padEnd(40)} ${service.pid ? `pid ${service.pid}`.padEnd(10) : "not running".padEnd(10)} ${where}\n`);
  }
  if (section.notCurrent.length > 0) {
    stdout.write(`\n services not executing the current release: ${section.notCurrent.join(", ")}\n`);
  }
  if (section.interruptedUpdate) {
    const pending = section.interruptedUpdate;
    stdout.write(`\n an ${pending.action ?? "update"} from ${pending.from ?? "?"} to ${pending.to ?? "?"} stopped at phase ${pending.phase ?? "?"} (started ${pending.startedAt ?? "?"})\n`);
    stdout.write(" to continue: infra-cod update --resume ...   to drop it: infra-cod update --abandon\n");
  }
  if (section.receipts.length > 0) {
    stdout.write(" recent receipts:\n");
    for (const receipt of section.receipts) {
      stdout.write(`   ${receipt.finishedAt ?? "?"}  ${receipt.action ?? "?"} ${receipt.from ?? "?"} -> ${receipt.to ?? "?"}: ${receipt.outcome ?? receipt.unreadable ?? "?"}\n`);
    }
  }
  stdout.write(" to change what is installed: infra-cod update ... | infra-cod rollback --to <version>\n\n");
}

function renderRuntimes(stdout, section) {
  heading(stdout, "runtimes");
  if (section.problem) stdout.write(` ! ${section.inventoryFile}: ${section.problem}\n`);
  for (const runtime of section.runtimes) {
    const states = [
      runtime.installed ? "installed" : "not installed",
      runtime.authenticated ? "authenticated" : "not authenticated",
      runtime.capabilityVerified ? "capability verified" : "capability not verified",
      runtime.selfUpdateManaged ? "self-update managed" : "SELF-UPDATE UNMANAGED",
    ];
    stdout.write(` ${runtime.runtime.padEnd(10)} ${String(runtime.version ?? "-").padEnd(16)} ${states.join(", ")}\n`);
    if (runtime.error) stdout.write(`   ! ${runtime.error}\n`);
    const others = runtime.installedVersions.filter((installation) => installation.version !== runtime.version);
    if (others.length > 0) {
      stdout.write(`   also installed: ${others.map((installation) => installation.version).join(", ")}\n`);
    }
    if (!runtime.installed) {
      stdout.write(`   to install: infra-cod runtime install ${runtime.runtime} --version <version>\n`);
    } else if (!runtime.authenticated) {
      stdout.write(`   to sign in: connect the ${runtime.runtime} account from the panel\n`);
    }
  }
  stdout.write("\n");
}

function renderCredentials(stdout, section) {
  heading(stdout, "initial credentials");
  const file = section.file.exists === null ? `unreadable (${section.file.error})`
    : section.file.exists ? `present${section.file.mode ? `, mode ${section.file.mode}` : ""}${section.file.ownedByRoot === false ? ", NOT owned by root" : ""}${section.file.symlink ? ", a symlink" : ""}`
      : "absent";
  stdout.write(` file:      ${section.file.path}: ${file}\n`);
  stdout.write(` database:  ${section.database}${section.retired === null ? "" : section.retired ? ", generated password retired" : `, ${section.reason}`}\n`);
  stdout.write(` verdict:   ${section.verdict}\n`);
  if (section.command) stdout.write(` next:      ${section.command}\n`);
  stdout.write("\n");
}

const RENDERERS = {
  units: renderUnits,
  doctor: renderDoctor,
  logs: renderLogs,
  releases: renderReleases,
  runtimes: renderRuntimes,
  credentials: renderCredentials,
};

// ---------------------------------------------------------------------------
// The command
// ---------------------------------------------------------------------------

const SECTIONS = ["units", "doctor", "logs", "releases", "runtimes", "credentials"];
// The overview is everything that needs no argument. Logs need a unit.
const OVERVIEW = ["units", "doctor", "releases", "runtimes", "credentials"];

export const USAGE = `infra-cod console [section] [--json]

  (no section)                    units, doctor, releases, runtimes and credentials
  units                           allowlisted units with their systemd state
  doctor                          the doctor report
  logs --unit <unit> [--lines N]  bounded, redacted journal of one allowlisted unit
  releases                        installed and running release ids
  runtimes                        runtime versions and readiness
  credentials                     whether the initial credentials still need retiring

Read-only. Changes are made with \`infra-cod update\`, \`rollback\`, \`runtime\` and \`admin\`.
`;

function parseArguments(argv) {
  const options = { section: null, json: false, unit: null, lines: DEFAULT_LOG_LINES };
  const rest = [...argv];
  while (rest.length > 0) {
    const argument = rest.shift();
    const value = () => {
      const next = rest.shift();
      if (next === undefined) throw new ConsoleError(`${argument} needs a value`);
      return next;
    };
    switch (argument) {
      case "--json": options.json = true; break;
      case "--unit": options.unit = value(); break;
      case "--lines": options.lines = parseLineCount(value()); break;
      case "help": case "--help": case "-h": options.section = "help"; break;
      default:
        if (argument.startsWith("-")) throw new ConsoleError(`unknown argument ${JSON.stringify(argument)}`);
        if (options.section !== null) throw new ConsoleError(`one section at a time; got ${JSON.stringify(options.section)} and ${JSON.stringify(argument)}`);
        if (!SECTIONS.includes(argument)) throw new ConsoleError(`unknown section ${JSON.stringify(argument)}; one of ${SECTIONS.join(", ")}`);
        options.section = argument;
    }
  }
  return options;
}

// Everything the console reads, behind one object, so a test can run the whole
// command against fixtures and a recording runner and prove that no host
// command other than `systemctl show` and `journalctl` was ever spawned.
export async function collect(sections, { options = {}, deps = {} } = {}) {
  const report = {};
  for (const section of sections) {
    switch (section) {
      case "units": report.units = unitsSection(deps); break;
      case "doctor": report.doctor = await doctorSection(deps); break;
      case "logs": report.logs = logsSection({ unit: options.unit, lines: options.lines, ...deps }); break;
      case "releases": report.releases = releasesSection(deps); break;
      case "runtimes": report.runtimes = runtimesSection(deps); break;
      case "credentials": report.credentials = await credentialsSection(deps); break;
      default: throw new ConsoleError(`unknown section ${JSON.stringify(section)}`);
    }
  }
  return report;
}

// The role the console reads the database as, when the operator's shell names
// none: root reaches PostgreSQL by peer, mapped to the product's roles
// (setup-postgresql-production.sh), and without PGUSER the driver asked for a
// role called "root" — so the credentials section said "database unavailable"
// on the host (sprint C backlog). infra_worker, because it is the unit role
// already granted initial_credentials_status() and nothing the console calls
// writes. A URL or a role the operator set is theirs.
export function consoleDatabaseRole(env = process.env, uid = process.getuid?.()) {
  if (env.DATABASE_URL || env.PGUSER || uid !== 0) return null;
  return "infra_worker";
}

export async function runConsole(argv = [], { stdout = process.stdout, stderr = process.stderr, deps = {} } = {}) {
  const role = consoleDatabaseRole();
  if (role) process.env.PGUSER = role;
  let options;
  try {
    options = parseArguments(argv);
  } catch (error) {
    stderr.write(`infra-cod console: ${error.message}\n`);
    return 2;
  }
  if (options.section === "help") {
    stdout.write(USAGE);
    return 0;
  }
  const sections = options.section === null ? OVERVIEW : [options.section];

  let report;
  try {
    report = await collect(sections, { options, deps });
  } catch (error) {
    if (error instanceof ConsoleError) {
      stderr.write(`infra-cod console: ${error.message}\n`);
      return 2;
    }
    throw error;
  }

  if (options.json) {
    stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return 0;
  }
  stdout.write(`infra-cod console — read-only\n\n`);
  for (const section of sections) RENDERERS[section](stdout, report[section]);
  return 0;
}
