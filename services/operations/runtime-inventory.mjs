// What runtimes this host has, written down where root can read it and the web
// tier cannot.
//
// `/etc/infra-cod/runtimes.json` is the only record of which executable is
// active, where it came from, and what was checked about it. Two rules shape the
// file, and both come from ADR-0012:
//
//   * It holds no credentials. Authentication state lives in each runtime user's
//     home and never appears here, in an event, in a log line, or in the health
//     snapshot. What this file records is provenance, not access.
//   * It is schema-versioned and written atomically, because a reader that finds
//     a half-written file must be able to say so rather than guess.
//
// The web tier does not read it. `doctor` records a bounded summary into the
// database, and the panel reads that — a process running as `infra-web` has no
// business opening files under `/etc/infra-cod`.

import { createHash } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ETC_ROOT, sys } from "./release-inventory.mjs";

export const RUNTIMES_FILE = path.join(ETC_ROOT, "runtimes.json");
export const RUNTIMES_SCHEMA = "infra-cod/runtimes/1";
export const RUNTIME_ROOT = sys("/opt/infra-cod/runtimes");
export const RUNTIME_BIN_DIR = sys("/usr/local/bin");

export class RuntimeInventoryError extends Error {
  constructor(message) {
    super(message);
    this.name = "RuntimeInventoryError";
  }
}

// The SHA-256 of an installed executable, read in chunks: Codex's is 286 MB,
// and this runs in `doctor` on a 4 GB host (Stage 12 W1).
export function executableDigest(file) {
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  const descriptor = openSync(file, "r");
  try {
    for (let read = readSync(descriptor, buffer); read > 0; read = readSync(descriptor, buffer)) {
      hash.update(buffer.subarray(0, read));
    }
  } finally {
    closeSync(descriptor);
  }
  return hash.digest("hex");
}

export function readRuntimes() {
  if (!existsSync(RUNTIMES_FILE)) return { schema: RUNTIMES_SCHEMA, runtimes: {} };
  let document;
  try {
    document = JSON.parse(readFileSync(RUNTIMES_FILE, "utf8"));
  } catch (error) {
    throw new RuntimeInventoryError(
      `${RUNTIMES_FILE} is not readable JSON (${error.message}). `
      + "It is the record of which executables this host runs; a corrupt one is not an empty one.",
    );
  }
  if (document.schema !== RUNTIMES_SCHEMA) {
    throw new RuntimeInventoryError(
      `${RUNTIMES_FILE} has schema ${JSON.stringify(document.schema)}, expected ${RUNTIMES_SCHEMA}`,
    );
  }
  return document;
}

// A credential that reaches this file is a credential in a root-readable
// provenance record that nothing scrubs. Cheap to check, and the check is the
// difference between a rule and an intention.
const FORBIDDEN_KEYS = /^(token|secret|password|passphrase|api_?key|credential|authorization)$/i;

function assertNoCredentials(value, trail = "entry") {
  if (value === null || typeof value !== "object") return;
  for (const [key, nested] of Object.entries(value)) {
    if (FORBIDDEN_KEYS.test(key)) {
      throw new RuntimeInventoryError(
        `${trail}.${key} looks like a credential. ${RUNTIMES_FILE} records provenance; `
        + "authentication state belongs in the runtime user's home and nowhere else.",
      );
    }
    assertNoCredentials(nested, `${trail}.${key}`);
  }
}

// Replaces one runtime's record. The whole file is rewritten through a temporary
// file in the same directory, so a reader sees either the previous complete
// document or the new one.
export function recordRuntime(name, entry) {
  assertNoCredentials(entry, name);
  const document = readRuntimes();
  document.runtimes[name] = entry;
  writeRuntimes(document);
  return document;
}

// Records a candidate tree beside the active one (Stage 12 W3). The active
// version is not touched; the tree is kept by directory like any other, so
// `remove --version` and the orphan report know it.
export function recordCandidate(name, installation) {
  assertNoCredentials(installation, name);
  const document = readRuntimes();
  const entry = document.runtimes[name];
  if (!entry?.active) {
    throw new RuntimeInventoryError(`${name} has no active version; a candidate is qualified beside one, so install a version first`);
  }
  const kept = (entry.installed ?? []).filter((installed) => installed.directory !== installation.directory);
  entry.installed = [...kept, installation].sort((left, right) =>
    left.version.localeCompare(right.version) || left.directory.localeCompare(right.directory));
  writeRuntimes(document);
  return document;
}

// Records a passed qualification on the installed tree it was made against
// (Stage 12 W3c). Root writes this file; the database's record is evidence the
// panel reads, and this is what the supervisor and doctor trust.
export function recordQualification(name, version, qualification) {
  const document = readRuntimes();
  const entry = document.runtimes[name];
  const installation = (entry?.installed ?? []).filter((installed) => installed.version === version)
    .sort((left, right) => String(right.installedAt).localeCompare(String(left.installedAt)))[0];
  if (!installation) throw new RuntimeInventoryError(`${name} ${version} is not installed; nothing to record a qualification on`);
  installation.qualification = { ...qualification, version };
  writeRuntimes(document);
  return installation;
}

// Forgets installations by *directory*, not by version.
//
// A version number does not identify an installation. Two builds of the same
// version — a rebuilt package, a republished tarball — are two immutable trees
// with two directories, and only one of them is on the end of the symlink.
// Forgetting "0.154.0" threw away the record of both, which left the inactive
// tree on disk with nothing in the file that knew it was there.
export function forgetRuntimeDirectories(name, directories) {
  const gone = new Set(directories);
  const document = readRuntimes();
  const entry = document.runtimes[name];
  if (!entry) return document;
  entry.installed = (entry.installed ?? []).filter((installed) => !gone.has(installed.directory));
  if (entry.active && gone.has(entry.active.directory)) entry.active = null;
  if (entry.installed.length === 0 && !entry.active) delete document.runtimes[name];
  writeRuntimes(document);
  return document;
}

function writeRuntimes(document) {
  // A fault-injection seam, and a deliberately narrow one.
  //
  // The failure that matters here — the inventory write failing *after* the
  // symlink has moved — cannot be produced by breaking the filesystem, because
  // the switch intent is written to the same directory and would fail first.
  // Nor by permissions: the container gate runs as root, and root walks through
  // a 0555 directory, so that test passed on macOS and proved nothing on Linux.
  //
  // It is honoured only inside a sandbox, which a production host never has:
  // without INFRA_COD_INSTALL_PREFIX this variable does nothing at all.
  if ((process.env.INFRA_COD_INSTALL_PREFIX ?? "").trim().length > 0
      && process.env.INFRA_COD_HARNESS_FAIL_INVENTORY_WRITE === "1") {
    throw new Error("harness: the inventory write was made to fail");
  }
  mkdirSync(ETC_ROOT, { recursive: true });
  const temporary = `${RUNTIMES_FILE}.tmp-${process.pid}`;
  const handle = openSync(temporary, "w", 0o644);
  try {
    writeFileSync(handle, `${JSON.stringify({ ...document, schema: RUNTIMES_SCHEMA }, null, 2)}\n`);
    // The same durability boundary the switch intent uses, for the same reason:
    // a rename is atomic against a process dying and says nothing about a power
    // cut, where the directory entry can reach the disk before the bytes.
    fsyncSync(handle);
  } finally {
    closeSync(handle);
  }
  renameSync(temporary, RUNTIMES_FILE);
  const directory = openSync(ETC_ROOT, "r");
  try {
    fsyncSync(directory);
  } finally {
    closeSync(directory);
  }
}

export function versionDirectory(name, version) {
  return path.join(RUNTIME_ROOT, name, version);
}

export function activeLink(executable) {
  return path.join(RUNTIME_BIN_DIR, executable);
}

// One entry, in the shape the file stores it, merged with what was already
// recorded.
//
// The first version rebuilt `installed` from the version being installed, so a
// host with two versions on disk had a record that knew about one. That matters
// beyond tidiness: `runtime remove --version` and any future audit read this
// file, and a version the record has forgotten is a tree nobody will ever be
// asked to clean up.
export function runtimeEntry({ name, adapter, version, source, digest, directory, verification, actor, previous = null, executableSha256 = null, rollbackTo = undefined }) {
  // A qualification passed on this very tree stays with it (Stage 12 W4): a
  // promotion re-records the installation it activates, and dropping the
  // qualification there would call the version it just vouched for unverified.
  const prior = (previous?.installed ?? []).find((entry) => entry.directory === directory);
  const qualification = prior?.qualification && executableSha256 && prior.executableSha256 === executableSha256
    ? prior.qualification : null;
  const installation = {
    version, directory, digest, source, installedAt: new Date().toISOString(), actor,
    // The executable as unpacked from the signed package (Stage 12 W1), which
    // `doctor` compares with what is on disk: whoever changes it, it shows.
    ...(executableSha256 ? { executableSha256 } : {}),
    ...(qualification ? { qualification } : {}),
  };

  // Kept by directory, not by version. The earlier version dropped every prior
  // entry with the same version number, so re-installing 0.154.0 from a rebuilt
  // package — a different tree, in a different directory, because installed
  // trees are immutable — erased the record of the tree that was there. It stayed
  // on disk, and `remove --version` no longer knew its name.
  const kept = (previous?.installed ?? []).filter((entry) => entry.directory !== directory);
  // Where `rollback` goes (Stage 12 W4, R12): the version active before the
  // last promotion. A promotion names it; any other activation carries it
  // forward, unless it is the tree being activated or no longer on record.
  const back = rollbackTo === undefined ? previous?.rollbackTo ?? null : rollbackTo;
  const keepBack = back && back.directory !== directory && kept.some((entry) => entry.directory === back.directory);
  return {
    runtime: name,
    user: adapter.user,
    executable: adapter.executable,
    active: { version, directory, path: activeLink(adapter.executable) },
    installed: [...kept, installation].sort((left, right) =>
      left.version.localeCompare(right.version) || left.directory.localeCompare(right.directory)),
    verification,
    ...(keepBack ? { rollbackTo: { version: back.version, directory: back.directory } } : {}),
  };
}
