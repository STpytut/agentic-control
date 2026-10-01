#!/usr/bin/env node
// Reconciles a host to a release's install declaration (WP-A).
//
// Used by both installers, so the fresh path and the upgrade path cannot drift
// apart as they once did: `infra-cod update` and rollback call `reconcileInstall`,
// and `deploy/install.sh` runs this file.
//
// Reconciling means two things:
//
//   * every declared file is installed, byte for byte, root-owned, 0644;
//   * every file this product installed before and the release no longer
//     declares is retired — a unit stopped and disabled first, then removed.
//
// "Installed before" is the ledger this writes after every reconcile, together
// with the declaration of the release being left. A file the product never
// recorded is never touched, whatever its name: an operator's own unit that
// happens to start with `infra-cod-` is not this code's to delete.
//
//   node install-reconcile.mjs reconcile --release <dir> [--previous <dir>]
//   node install-reconcile.mjs check --release <dir>

import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync, chownSync, closeSync, constants, existsSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync,
  renameSync, unlinkSync, writeFileSync,
} from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { adapterFor } from "./runtime-adapters.mjs";
import { ETC_ROOT, readManifest, sys } from "./release-inventory.mjs";
import { INSTALL_ROOTS, entryKey, installDeclarationFor } from "./install-declaration.mjs";

const PREFIX = (process.env.INFRA_COD_INSTALL_PREFIX ?? "").trim();
const HARNESS = PREFIX.length > 0;

export const INSTALL_LEDGER = path.join(ETC_ROOT, "install-ledger.json");

export class InstallError extends Error {
  constructor(message, { code = null } = {}) {
    super(message);
    this.name = "InstallError";
    this.code = code;
  }
}
const LEDGER_SCHEMA = "infra-cod/install-ledger/1";

// The roots, resolved here and only here. A manifest names a root; where that
// root is on this host is this code's answer, from the same declarations the
// rest of the installation uses.
export function rootDirectory(entry) {
  switch (entry.root) {
    case "systemd": return sys("/etc/systemd/system");
    case "tmpfiles": return sys("/etc/tmpfiles.d");
    case "sysusers": return sys("/etc/sysusers.d");
    case "apparmor": return sys("/etc/apparmor.d");
    case "caddy": return path.join(ETC_ROOT, "caddy");
    case "runtime-tools": {
      const adapter = adapterFor(entry.runtime);
      return sys(`${adapter.home}/${adapter.toolDefinitions.directory}`);
    }
    default: throw new Error(`unknown install root ${JSON.stringify(entry.root)}`);
  }
}

// A runtime's tool directory, and every directory between its home and it, is
// owned by the runtime user. Root writing there by path would follow whatever
// that user put in the path between the check and the write — a renamed
// `.config/opencode` replaced by a symlink to /etc, say — and write or unlink a
// file somewhere else as root. So the directory is opened one component at a
// time with O_NOFOLLOW, each relative to the descriptor of the one before, and
// everything after that goes through `/proc/self/fd/<fd>`: the path is resolved
// once, by the kernel, to an inode, and nothing the runtime renames afterwards
// changes where the write lands. That is `openat` without a native binding.
//
// `base` is where trust starts — the parent of the runtime's home, root-owned.
// Where /proc is not available (a developer's macOS), each component is still
// refused if it is a symlink; the race stays open there, and only there.
const PROC_FD = existsSync("/proc/self/fd");

export function openTrustedDirectory(base, relative) {
  const components = relative.split("/").filter(Boolean);
  if (!PROC_FD) {
    let current = realpathSync(base);
    for (const component of components) {
      current = path.join(current, component);
      let stat;
      try { stat = lstatSync(current); } catch (error) {
        throw new InstallError(`${current} is not a plain directory (${error.code}); refusing to install through it`, { code: error.code });
      }
      if (!stat.isDirectory()) {
        throw new InstallError(`${current} is not a plain directory; refusing to install through it`, { code: "ENOTDIR" });
      }
    }
    return { directory: current, close() {} };
  }
  let fd = openSync(realpathSync(base), constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    for (const component of components) {
      let next;
      try {
        next = openSync(`/proc/self/fd/${fd}/${component}`, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      } catch (error) {
        throw new InstallError(`${path.join(base, ...components.slice(0, components.indexOf(component) + 1))} `
          + `is not a plain directory (${error.code}); refusing to install through it`, { code: error.code });
      }
      closeSync(fd);
      fd = next;
    }
  } catch (error) {
    closeSync(fd);
    throw error;
  }
  return { directory: `/proc/self/fd/${fd}`, close() { closeSync(fd); } };
}

// Where an entry is written, and how to let go of it.
function openRoot(entry) {
  if (entry.root !== "runtime-tools") return { directory: rootDirectory(entry), close() {} };
  const adapter = adapterFor(entry.runtime);
  const home = sys(adapter.home);
  return openTrustedDirectory(path.dirname(home), `${path.basename(home)}/${adapter.toolDefinitions.directory}`);
}

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

export function readLedger() {
  if (!existsSync(INSTALL_LEDGER)) return [];
  const ledger = JSON.parse(readFileSync(INSTALL_LEDGER, "utf8"));
  if (ledger.schema !== LEDGER_SCHEMA || !Array.isArray(ledger.files)) {
    throw new Error(`${INSTALL_LEDGER} is not an install ledger this code reads`);
  }
  return ledger.files;
}

function writeLedger(files, release) {
  mkdirSync(path.dirname(INSTALL_LEDGER), { recursive: true });
  const temporary = `${INSTALL_LEDGER}.${randomBytes(6).toString("hex")}`;
  writeFileSync(temporary, `${JSON.stringify({ schema: LEDGER_SCHEMA, release, files }, null, 2)}\n`, { mode: 0o644 });
  renameSync(temporary, INSTALL_LEDGER);
}

// Written beside the target and renamed over it. A rename replaces whatever is at
// the name — a symlink included — instead of writing through it, which is what
// `copyFile` onto an existing name would do.
function installFile(source, target) {
  const content = readFileSync(source);
  const temporary = path.join(path.dirname(target), `.${path.basename(target)}.${randomBytes(6).toString("hex")}`);
  writeFileSync(temporary, content, { mode: 0o644 });
  chmodSync(temporary, 0o644);
  if (!HARNESS) chownSync(temporary, 0, 0);
  renameSync(temporary, target);
  return sha256(content);
}

function present(target) {
  try { lstatSync(target); return true; } catch { return false; }
}

function systemctl(...args) {
  const result = spawnSync("systemctl", args, { encoding: "utf8" });
  return { ok: result.status === 0, stderr: (result.stderr ?? "").trim() };
}

// The declaration of a release directory, as a coordinator of
// `coordinatorVersion` reads it.
export function declarationOf(releaseRoot, { coordinatorVersion }) {
  return installDeclarationFor(readManifest(releaseRoot), releaseRoot, { coordinatorVersion });
}

// `previous`: the entries this product may have installed before — the ledger,
// plus the declaration of the release being left. Returns what changed.
// `beforeRuntimeRoots` runs after the platform's own files are in place and
// before anything goes into a runtime's home: the caller runs systemd-tmpfiles
// there, so the tmpfiles rules this release just installed create the runtime
// directories first.
export function reconcileInstall({ declaration, releaseRoot, previous = [], reporter = null, beforeRuntimeRoots = null }) {
  const desired = new Map(declaration.files.map((entry) => [entryKey(entry), entry]));
  const installed = [];
  const changed = [];

  // Directories this product owns are created if missing. A runtime's own
  // directory is not: tmpfiles creates it, with the protections a runtime-owned
  // path needs, and the caller runs tmpfiles before the runtime roots.
  const install = (entry) => {
    if (entry.root === "runtime-tools") {
      // A sandbox has no tmpfiles to do it; a host that lacks it is refused.
      const expected = rootDirectory(entry);
      if (!existsSync(expected) && HARNESS) mkdirSync(expected, { recursive: true });
      if (!existsSync(expected)) {
        throw new InstallError(`${expected} does not exist; systemd-tmpfiles creates it, and has not`);
      }
    } else {
      mkdirSync(rootDirectory(entry), { recursive: true });
    }
    const root = openRoot(entry);
    try {
      const target = path.join(root.directory, entry.name);
      const before = present(target) ? sha256(readFileSync(target)) : null;
      const after = installFile(path.join(releaseRoot, entry.source), target);
      installed.push({ ...entry, sha256: after });
      if (before !== after) changed.push(entryKey(entry));
    } finally {
      root.close();
    }
  };
  const entries = [...desired.values()];
  entries.filter((entry) => entry.root !== "runtime-tools").forEach(install);
  // The platform's files are in place, its tmpfiles rules among them; the
  // caller applies them now, before anything goes into a runtime's home.
  beforeRuntimeRoots?.();
  entries.filter((entry) => entry.root === "runtime-tools").forEach(install);

  // Retire what was installed before and is no longer declared.
  const retired = [];
  const unretired = [];
  const seen = new Set();
  for (const entry of previous) {
    const key = entryKey(entry);
    if (desired.has(key) || seen.has(key)) continue;
    seen.add(key);
    // The ledger is a file on disk: an entry outside the vocabulary — a name with
    // a slash in it, a root that does not exist — is ignored, not followed.
    if (!INSTALL_ROOTS[entry.root]?.match.test(entry.name ?? "")) {
      reporter?.warn?.(`ignoring ${key} in the install record: not a name this product installs`);
      continue;
    }
    // A directory that is gone holds nothing to retire; one that is not a plain
    // directory any more is refused like an install into it would be.
    let root;
    try { root = openRoot(entry); } catch (error) {
      if (error instanceof InstallError && error.code !== "ENOENT") throw error;
      continue;
    }
    try {
      const target = path.join(root.directory, entry.name);
      if (!present(target)) continue;
      if (entry.root === "systemd") {
        // Stopped and disabled before its file goes: a unit removed while running
        // keeps running with no file behind it, and one removed while enabled
        // leaves a dangling wants-link that fails the next boot's ordering.
        //
        // Both are attempted even when the first fails, so the error names every
        // step that did not happen. Either failing keeps the file and keeps the
        // unit in the ledger — the record of what this product still has to
        // retire — and fails the reconcile, which an update answers with its
        // rollback. Warning and deleting anyway was the rc.25 behaviour, and it
        // left a running or enabled unit that nothing remembered owning.
        const failures = [["stop", systemctl("stop", entry.name)], ["disable", systemctl("disable", entry.name)]]
          .filter(([, result]) => !result.ok)
          .map(([step, result]) => `${step} failed${result.stderr ? `: ${result.stderr}` : ""}`);
        if (failures.length) {
          unretired.push({ entry, failures });
          continue;
        }
      }
      if (entry.root === "apparmor") {
        // Unloaded before its file goes, or the kernel keeps enforcing a profile
        // nothing on disk describes. A profile that is not loaded is not a
        // failure: there is nothing to unload.
        const unloaded = apparmorParser(["-R", target]);
        if (!unloaded.ok && !/not found|does not exist/i.test(unloaded.stderr)) {
          reporter?.warn?.(`apparmor_parser -R ${entry.name}: ${unloaded.stderr || "failed"}`);
        }
      }
      unlinkSync(target);
      retired.push(key);
    } finally {
      root.close();
    }
  }

  // What could not be retired stays recorded, so the next reconcile tries again.
  const kept = unretired.map(({ entry }) => ({ root: entry.root, ...(entry.runtime ? { runtime: entry.runtime } : {}), name: entry.name }));
  writeLedger([...installed, ...kept], path.basename(releaseRoot));
  if (unretired.length) {
    throw new InstallError(`could not retire ${unretired.map(({ entry, failures }) => `${entry.name} (${failures.join("; ")})`).join(", ")}; `
      + "the unit file and its record are kept, and the next reconcile retries");
  }
  reporter?.log?.(`installed ${installed.length} file(s), ${changed.length} changed${retired.length ? `; retired ${retired.join(", ")}` : ""}`);
  return { installed: installed.map(entryKey), changed, retired };
}

// systemd-tmpfiles, on this product's declared rules only, failing closed.
//
// Scoped because `--create` alone applies every rule on the host, and a broken
// rule someone else installed would then stop this product's update. Failing
// closed because tmpfiles is what creates the runtime homes with their owners
// and modes: a tool definition written into a directory that exists for some
// other reason, after tmpfiles refused, is written on the wrong assumption. Both
// paths — update and install.sh — failed open before this.
//
// The accounts come first: a rule names its owner, and a runtime added by an
// update brings a user the host does not have yet. systemd-sysusers on this
// product's declared files only, failing closed for the same reason; a user
// that exists is left as it is.
export function applyTmpfiles(declaration) {
  const accounts = declaration.files
    .filter((entry) => entry.root === "sysusers")
    .map((entry) => path.join(rootDirectory(entry), entry.name));
  if (accounts.length) {
    const made = spawnSync("systemd-sysusers", accounts, { encoding: "utf8", timeout: 60_000 });
    if (made.error || made.status !== 0) {
      throw new InstallError(`systemd-sysusers failed (${made.error?.message ?? `exit ${made.status}`}): ${(made.stderr ?? "").trim()}`);
    }
  }
  const rules = declaration.files
    .filter((entry) => entry.root === "tmpfiles")
    .map((entry) => path.join(rootDirectory(entry), entry.name));
  if (!rules.length) return;
  const result = spawnSync("systemd-tmpfiles", ["--create", ...rules], { encoding: "utf8", timeout: 60_000 });
  if (result.error || result.status !== 0) {
    throw new InstallError(`systemd-tmpfiles --create failed (${result.error?.message ?? `exit ${result.status}`}): ${(result.stderr ?? "").trim()}`);
  }
}

// Where the host differs from a declaration. Empty means it matches.
function apparmorParser(args) {
  if (HARNESS) return { ok: true, stderr: "" };
  const result = spawnSync("apparmor_parser", args, { encoding: "utf8", timeout: 60_000 });
  return { ok: !result.error && result.status === 0, stderr: (result.stderr ?? result.error?.message ?? "").trim() };
}

// The declared AppArmor profiles, (re)loaded. A host without AppArmor has no
// user-namespace restriction to lift, so there is nothing to load and `doctor`
// reports the requirement from what the host actually does. A profile that
// fails to load fails the reconcile: a declared host requirement silently
// absent is what `doctor` would then call a runtime failure.
export function applyApparmor(declaration, { enabled = () => !HARNESS && existsSync("/sys/kernel/security/apparmor"), parse = apparmorParser } = {}) {
  const profiles = declaration.files
    .filter((entry) => entry.root === "apparmor")
    .map((entry) => path.join(rootDirectory(entry), entry.name));
  if (!profiles.length || !enabled()) return { loaded: [] };
  const result = parse(["-r", ...profiles]);
  if (!result.ok) throw new InstallError(`apparmor_parser -r failed: ${result.stderr}`);
  return { loaded: profiles.map((profile) => path.basename(profile)) };
}

export function installDifferences({ declaration, releaseRoot }) {
  const differences = [];
  for (const entry of declaration.files) {
    const target = path.join(rootDirectory(entry), entry.name);
    if (!present(target)) { differences.push(`${entryKey(entry)} is not installed`); continue; }
    const expected = sha256(readFileSync(path.join(releaseRoot, entry.source)));
    if (sha256(readFileSync(target)) !== expected) differences.push(`${entryKey(entry)} differs from the release`);
  }
  return differences;
}

// ------------------------------------------------------------------- CLI

function argument(argv, name) {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

async function main(argv) {
  const [command] = argv;
  const releaseRoot = argument(argv, "--release");
  if (!releaseRoot || !["reconcile", "check"].includes(command)) {
    process.stderr.write("usage: install-reconcile.mjs reconcile|check --release <dir> [--previous <dir>]\n");
    return 2;
  }
  // The release applies its own declaration here, so it is its own coordinator.
  const coordinatorVersion = readManifest(releaseRoot).version;
  const declaration = declarationOf(releaseRoot, { coordinatorVersion });
  if (command === "check") {
    const differences = installDifferences({ declaration, releaseRoot });
    for (const difference of differences) process.stdout.write(`${difference}\n`);
    return differences.length ? 1 : 0;
  }
  const previousRoot = argument(argv, "--previous");
  const previous = [
    ...readLedger(),
    ...(previousRoot && existsSync(previousRoot) ? declarationOf(previousRoot, { coordinatorVersion }).files : []),
  ];
  const reporter = { log: (line) => process.stdout.write(`${line}\n`), warn: (line) => process.stderr.write(`warning: ${line}\n`) };
  reconcileInstall({
    declaration, releaseRoot, previous, reporter,
    beforeRuntimeRoots: () => { applyTmpfiles(declaration); applyApparmor(declaration); },
  });
  return 0;
}

// Compared by real path: a release reached through a symlinked directory
// (`/var` is one on macOS, `current` is one on every host) is still this file.
function invokedDirectly() {
  if (!process.argv[1]) return false;
  try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
}

if (invokedDirectly()) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (error) => {
    process.stderr.write(`install-reconcile: ${error.message}\n`);
    process.exitCode = 1;
  });
}
