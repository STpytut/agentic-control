// What is installed, what is running, and which of those two is which.
//
// Every command in the update family asks the same questions — which releases
// are on disk, which one `current` points at, which one the live processes are
// actually executing, where the receipts are — and the answers have to come from
// one place or the commands will disagree about the state of the host they are
// changing.
//
// Two distinctions are load-bearing here, because getting either wrong is how an
// update reports success it did not achieve:
//
//   * A release **directory** is not a release **version**. Two directories can
//     carry the same version (`0.2.0` and `0.2.0.r2`), because the installer
//     stages a re-install of the live version beside the live one rather than
//     writing through the path `current` resolves to. Commands address
//     directories; operators address versions; the translation happens here and
//     refuses to guess when a version names more than one intact directory.
//
//   * `current` pointing somewhere is not the same fact as a process running
//     from there. systemd resolves `WorkingDirectory=/opt/infra-cod/current/...`
//     when it execs, so a running service holds its release directory open as
//     its own cwd — and that cwd, read back from `/proc`, is the only evidence
//     available on the host that the code answering requests is the code the
//     symlink names. An HTTP 200 is not that evidence.

import { existsSync, readFileSync, readdirSync, readlinkSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { LONG_RUNNING_SERVICES } from "./unit-contract.mjs";

const PREFIX = (process.env.INFRA_COD_INSTALL_PREFIX ?? "").trim();
export const sys = (absolute) => `${PREFIX}${absolute}`;

export const APP_ROOT = sys("/opt/infra-cod");
export const RELEASES_DIR = path.join(APP_ROOT, "releases");
export const CURRENT_LINK = path.join(APP_ROOT, "current");
export const CURRENT_TMP = path.join(APP_ROOT, ".current-tmp");
export const ETC_ROOT = sys("/etc/infra-cod");
export const RECEIPTS_DIR = path.join(ETC_ROOT, "release-receipts");
export const UPDATE_STATE_FILE = path.join(ETC_ROOT, ".update-state");
// The installer's lock, deliberately. An update, a rollback, a runtime install
// and a re-run of `install.sh` all mutate the same host in the same places; a
// second lock file would let two of them believe they were alone.
export const LOCK_FILE = sys("/run/lock/infra-cod-install.lock");
export const NODE_BIN = sys("/opt/node/bin/node");
export const PROC_ROOT = sys("/proc");

export const RELEASE_MANIFEST_SCHEMA = "infra-cod/release-manifest/1";

export class InventoryError extends Error {
  constructor(message) {
    super(message);
    this.name = "InventoryError";
  }
}

export function readManifest(releaseDirectory) {
  const file = path.join(releaseDirectory, "manifest.json");
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new InventoryError(`${file} is not readable JSON: ${error.message}`);
  }
  if (manifest.schema !== RELEASE_MANIFEST_SCHEMA) {
    throw new InventoryError(`${file} has schema ${JSON.stringify(manifest.schema)}, expected ${RELEASE_MANIFEST_SCHEMA}`);
  }
  if (typeof manifest.version !== "string" || manifest.version.length === 0) {
    throw new InventoryError(`${file} names no version`);
  }
  return manifest;
}

// An installed tree re-checked against the checksums it shipped with. "The
// directory exists" is what a rollback target looked like the last time this was
// skipped, and a half-deleted tree passes that test.
export function releaseIntact(releaseDirectory) {
  if (!existsSync(path.join(releaseDirectory, "FILESUMS.sha256"))) return false;
  const result = spawnSync("sha256sum", ["--quiet", "-c", "FILESUMS.sha256"], {
    cwd: releaseDirectory,
    encoding: "utf8",
    timeout: 120_000,
  });
  return result.status === 0;
}

export function currentReleaseDirectory() {
  try {
    const target = readlinkSync(CURRENT_LINK);
    return path.isAbsolute(target) ? target : path.resolve(APP_ROOT, target);
  } catch {
    return null;
  }
}

// The compatibility contract the *incoming* release carries. Absent is not
// "compatible": a release built before the contract existed says nothing about
// whether its migrations can be served through, and this returns that as the
// unknown it is so the caller can fail closed.
export function releaseContract(manifest) {
  const declared = manifest.database?.compatibility;
  if (!declared || declared.contract !== "infra-cod/schema-compatibility/1") {
    return { known: false, reason: "the release manifest carries no schema compatibility contract" };
  }
  return {
    known: true,
    unverifiedThrough: declared.unverifiedThrough,
    unverified: new Set(declared.unverified ?? []),
    backwardIncompatible: new Set(declared.backwardIncompatible ?? []),
    latestMigration: manifest.database.latestMigration,
    migrationCount: manifest.database.migrationCount,
  };
}

export function listReleases({ checkIntegrity = true } = {}) {
  const current = currentReleaseDirectory();
  if (!existsSync(RELEASES_DIR)) return [];
  const entries = readdirSync(RELEASES_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(RELEASES_DIR, entry.name))
    .sort();

  return entries.map((directory) => {
    let manifest = null;
    let problem = null;
    try {
      manifest = readManifest(directory);
    } catch (error) {
      problem = error.message;
    }
    return {
      directory,
      name: path.basename(directory),
      version: manifest?.version ?? null,
      channel: manifest?.channel ?? null,
      gitSha: manifest?.git?.sha ?? null,
      latestMigration: manifest?.database?.latestMigration ?? null,
      current: current !== null && path.resolve(directory) === path.resolve(current),
      intact: problem ? false : (checkIntegrity ? releaseIntact(directory) : null),
      problem,
    };
  });
}

// Turns an operator's `--to <version>` into exactly one directory, or refuses.
//
// Refusing is the point. `0.2.0` may name `releases/0.2.0` and `releases/0.2.0.r2`
// — the second is what a re-install of the live version produces — and rolling
// back to "whichever sorts first" is a coin toss with the live host as the stake.
export function resolveVersionToDirectory(version, { releases = listReleases() } = {}) {
  const matches = releases.filter((release) => release.version === version);
  if (matches.length === 0) {
    const known = releases.map((release) => release.version ?? release.name).join(", ") || "none";
    throw new InventoryError(`no installed release has version ${version}; installed: ${known}`);
  }
  const usable = matches.filter((release) => release.intact !== false);
  if (usable.length === 0) {
    throw new InventoryError(
      `release ${version} is installed at ${matches.map((release) => release.name).join(", ")} `
      + "but no copy matches the checksums it shipped with; it cannot be switched to",
    );
  }
  if (usable.length > 1) {
    throw new InventoryError(
      `version ${version} names more than one intact release directory (${usable.map((release) => release.name).join(", ")}); `
      + "name the directory instead so the choice is yours and not this command's",
    );
  }
  return usable[0];
}

// The first `<path>.rN` that is free, matching install.sh's staging rule: a new
// tree never replaces the directory `current` resolves to, because replacing it
// is two operations with a window in between where the path does not exist.
export function freeReleasePath(base) {
  let n = 2;
  while (existsSync(`${base}.r${n}`)) n += 1;
  return `${base}.r${n}`;
}

// ---------------------------------------------------------------------------
// What the live processes are actually running
// ---------------------------------------------------------------------------

// Everything systemd will say about a unit that bears on which code it is
// running. Parsed from `KEY=VALUE` rather than `--value`, because several
// properties are asked for at once and the mapping has to stay unambiguous.
export function unitStatus(unit, { run = spawnSync } = {}) {
  const result = run("systemctl", [
    "show",
    "-p", "MainPID",
    "-p", "ExecMainStartTimestampMonotonic",
    "-p", "ExecStart",
    `${unit}.service`,
  ], { encoding: "utf8", timeout: 10_000 });

  const properties = new Map();
  for (const line of (result.stdout ?? "").split("\n")) {
    const index = line.indexOf("=");
    if (index > 0) properties.set(line.slice(0, index), line.slice(index + 1));
  }
  const pid = Number.parseInt(properties.get("MainPID") ?? "0", 10);
  const started = Number.parseInt(properties.get("ExecMainStartTimestampMonotonic") ?? "0", 10);
  return {
    unit,
    available: result.status === 0,
    pid: Number.isInteger(pid) && pid > 0 ? pid : 0,
    startedMonotonic: Number.isInteger(started) ? started : 0,
    execStart: properties.get("ExecStart") ?? "",
    directory: Number.isInteger(pid) && pid > 0 ? processReleaseDirectory(pid) : null,
  };
}

export function unitMainPid(unit, { run = spawnSync } = {}) {
  return unitStatus(unit, { run }).pid;
}

// The release directory a running process is executing from, read from its own
// working directory. systemd resolved `/opt/infra-cod/current/...` when it
// exec'd, so this answers "which tree is this process in" even after the symlink
// has moved — which is exactly the question a switch has to ask afterwards.
export function processReleaseDirectory(pid) {
  try {
    const cwd = readlinkSync(path.join(PROC_ROOT, String(pid), "cwd"));
    const resolved = path.resolve(cwd);
    const releases = path.resolve(RELEASES_DIR);
    if (!resolved.startsWith(`${releases}${path.sep}`)) return null;
    const relative = path.relative(releases, resolved).split(path.sep)[0];
    return path.join(releases, relative);
  } catch {
    return null;
  }
}

export function runningReleases({ units = LONG_RUNNING_SERVICES, run = spawnSync } = {}) {
  return units.map((unit) => unitStatus(unit, { run }));
}

// Where each unit says it will run, read from the unit files a release ships.
//
// This is not decoration and it is not a list kept here: two of the fourteen
// services — the dispatcher and the reconciler — deliberately run from
// `/var/lib/infra-control` and not from the release tree, so their working
// directory says nothing about which code they execute. A verification that
// assumed every service runs from `/opt/infra-cod/current/...` would have
// reported those two as "running from an unidentifiable directory" and failed
// every update on a real host. Reading the unit files means a future unit that
// changes its WorkingDirectory needs no change here.
export function unitWorkingDirectories(releaseDirectory, { units = LONG_RUNNING_SERVICES } = {}) {
  const directories = new Map();
  for (const unit of units) {
    const file = path.join(releaseDirectory, "deploy/systemd", `${unit}.service`);
    let text = "";
    try {
      text = readFileSync(file, "utf8");
    } catch {
      directories.set(unit, null);
      continue;
    }
    const match = /^WorkingDirectory=(.+)$/m.exec(text);
    directories.set(unit, match ? match[1].trim() : null);
  }
  return directories;
}

export const RELEASE_TREE_PREFIX = "/opt/infra-cod/current";

// ---------------------------------------------------------------------------
// Receipts
// ---------------------------------------------------------------------------

export function writeReceiptAtomically(receipt) {
  mkdirSync(RECEIPTS_DIR, { recursive: true, mode: 0o700 });
  const name = `${receipt.startedAt.replace(/[:.]/g, "-")}-${receipt.action}.json`;
  const file = path.join(RECEIPTS_DIR, name);
  const temporary = `${file}.tmp-${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, file);
  return file;
}

export function listReceipts({ limit = 20 } = {}) {
  if (!existsSync(RECEIPTS_DIR)) return [];
  return readdirSync(RECEIPTS_DIR)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .slice(-limit)
    .map((name) => {
      const file = path.join(RECEIPTS_DIR, name);
      try {
        return { file, ...JSON.parse(readFileSync(file, "utf8")) };
      } catch (error) {
        return { file, unreadable: error.message };
      }
    });
}
