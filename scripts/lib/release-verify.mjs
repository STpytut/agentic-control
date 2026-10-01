// Verification of an unpacked release tree, and the checks the builder runs on
// its own output before it signs anything.
//
// Everything in this module answers a question about *bytes on disk*: does every
// file hash to what `FILESUMS.sha256` claims, does every symlink stay inside the
// tree, is every path a systemd unit starts actually present, do the migration
// files hash to the digest the manifest records. Nothing here reads the network,
// nothing runs a package manager, and nothing trusts a filename.
//
// The builder calls exactly these functions on its own staging tree before it
// creates the archive, so a release that does not verify has no signature over it
// — the artifact and the checks cannot disagree, because the checks run first.
//
// The order matters and is enforced by the caller, not by hope:
//
//   pinned public key -> signature over SHA256SUMS -> checksum of the tarball
//     -> safe member list -> extraction -> manifest identity -> FILESUMS
//     -> symlink closure -> required paths -> runtime smoke

import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync, readlinkSync, realpathSync } from "node:fs";
import path from "node:path";

import { COMPATIBILITY_FILENAME, compatibilitySummary, loadCompatibility } from "./release-compatibility.mjs";
import { FILESUMS_FILENAME, MANIFEST_FILENAME, listMigrations, migrationSetDigest, parseFileSums, validateManifest, assertManifestIsHostFree } from "./release-manifest.mjs";
import { checkSymlinkClosure, walkTree, isForbiddenName } from "./release-payload.mjs";
import { declareInstall, entryKey } from "../../services/operations/install-declaration.mjs";

export class VerificationError extends Error {
  constructor(message) {
    super(message);
    this.name = "VerificationError";
  }
}

function fail(message) {
  throw new VerificationError(message);
}

export function sha256File(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

export function readManifest(releaseRoot) {
  const file = path.join(releaseRoot, MANIFEST_FILENAME);
  if (!existsSync(file)) fail(`${MANIFEST_FILENAME} is missing from ${releaseRoot}`);
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    fail(`${MANIFEST_FILENAME} is not valid JSON: ${error.message}`);
  }
  return parsed;
}

// Verifies the manifest's own claims and, when the caller has expectations, that
// the artifact is the one that was asked for. This is what makes the filename
// irrelevant: `infra-cod-9.9.9-linux-x64.tar.gz` containing a manifest that says
// `0.1.0-rc.1` is refused, and so is a manifest that says `linux/arm64`.
export function verifyManifestIdentity(releaseRoot, { version, target, channel } = {}) {
  const manifest = readManifest(releaseRoot);
  // `null` is the CLI's "the caller did not ask for a particular value", and
  // `validateManifest` semantics for "no expectation" is an absent argument.
  const expected = {};
  if (version !== undefined && version !== null) expected.version = version;
  if (target !== undefined && target !== null) expected.target = target;
  validateManifest(manifest, expected);
  if (channel !== undefined && channel !== null && manifest.channel !== channel) {
    fail(`manifest channel is ${JSON.stringify(manifest.channel)}, requested ${JSON.stringify(channel)}`);
  }
  assertManifestIsHostFree(manifest);
  return manifest;
}

// ---------------------------------------------------------------------------
// Internal checksums
// ---------------------------------------------------------------------------

// Recomputes every checksum and compares. `FILESUMS.sha256` covers every payload
// file plus the finished `manifest.json`, and never itself, which is what keeps
// the model free of a cycle.
export function verifyFileSums(releaseRoot) {
  const file = path.join(releaseRoot, FILESUMS_FILENAME);
  if (!existsSync(file)) fail(`${FILESUMS_FILENAME} is missing from ${releaseRoot}`);
  const entries = parseFileSums(readFileSync(file, "utf8"));
  if (entries.length === 0) fail(`${FILESUMS_FILENAME} is empty`);

  const mismatched = [];
  const missing = [];
  const seen = new Set();
  for (const entry of entries) {
    if (seen.has(entry.path)) fail(`${FILESUMS_FILENAME} lists ${entry.path} more than once`);
    seen.add(entry.path);
    const target = path.join(releaseRoot, entry.path);
    const info = lstatSync(target, { throwIfNoEntry: false });
    if (!info) {
      missing.push(entry.path);
      continue;
    }
    if (!info.isFile()) {
      fail(`${FILESUMS_FILENAME} lists ${entry.path}, which is not a regular file`);
    }
    const actual = sha256File(target);
    if (actual !== entry.sha256) mismatched.push({ path: entry.path, expected: entry.sha256, actual });
  }

  if (missing.length > 0) fail(`${FILESUMS_FILENAME} lists ${missing.length} missing file(s): ${missing.slice(0, 10).join(", ")}`);
  if (mismatched.length > 0) {
    fail(
      `${mismatched.length} file(s) do not match ${FILESUMS_FILENAME}:\n  `
        + mismatched.slice(0, 10).map((entry) => `${entry.path} (recorded ${entry.expected.slice(0, 12)}..., actual ${entry.actual.slice(0, 12)}...)`).join("\n  "),
    );
  }

  // The other direction: a file that exists but is not listed is a file nobody
  // signed. `manifest.json` is listed; `FILESUMS.sha256` is the list itself, so it
  // is the one file that cannot be in its own list and is excluded here rather than
  // silently accepted.
  const onDisk = walkTree(releaseRoot)
    .filter((entry) => entry.type === "file" && entry.relativePath !== FILESUMS_FILENAME)
    .map((entry) => entry.relativePath);
  const unlisted = onDisk.filter((relative) => !seen.has(relative));
  if (unlisted.length > 0) {
    fail(
      `${unlisted.length} file(s) are present but not listed in ${FILESUMS_FILENAME}:\n  `
        + unlisted.slice(0, 10).join("\n  "),
    );
  }
  return { entries: entries.length, files: onDisk.length };
}

// ---------------------------------------------------------------------------
// Structure
// ---------------------------------------------------------------------------

const REQUIRED_PAYLOAD_PATHS = [
  "services/cli/infra-cod.mjs",
  "services/control-plane/migrate.mjs",
  "services/runtime-supervisor/server.mjs",
  "db/migrations",
  "deploy/systemd",
  "node_modules/pg/package.json",
  "node_modules/hash-wasm/package.json",
];

// The paths that must exist for the units to start, and the "this is a release and
// not a directory of leftovers" paths. A missing entry here is the failure that
// otherwise appears as `status=203/EXEC` on the target host.
export function verifyRequiredPaths(releaseRoot, { manifest }) {
  const missing = [];
  for (const relative of REQUIRED_PAYLOAD_PATHS) {
    if (!existsSync(path.join(releaseRoot, relative))) missing.push(relative);
  }
  for (const [name, relative] of Object.entries(manifest.entrypoints)) {
    if (!existsSync(path.join(releaseRoot, relative))) missing.push(`${relative} (entrypoints.${name})`);
  }
  if (missing.length > 0) fail(`the release is missing required paths:\n  ${missing.join("\n  ")}`);

  const webEntrypoint = path.join(releaseRoot, manifest.entrypoints.web);
  const appRoot = path.dirname(webEntrypoint);
  const besideServer = [".next/static", "public"];
  const absent = besideServer.filter((relative) => !existsSync(path.join(appRoot, relative)));
  if (absent.length > 0) {
    fail(
      `the web entry point is missing ${absent.join(" and ")} next to it (${path.relative(releaseRoot, appRoot)}); `
        + "the server would start and then 404 every asset the page references",
    );
  }
  return { webAppRoot: appRoot };
}

// The migrations the manifest records must be the migrations that are present.
// A count is what the manifest advertises; the digest is what makes the
// advertisement checkable.
// The install declaration names files inside the release; each must be a file
// that is really there, and the declaration must be exactly what the tree
// implies — a hand-edited manifest that drops a unit would otherwise retire it
// from every host it is installed on.
export function verifyInstallDeclaration(releaseRoot, { manifest }) {
  if (manifest.install === undefined) fail("the manifest has no install declaration; every release since WP-A carries one");
  for (const entry of manifest.install.files) {
    const file = path.join(releaseRoot, entry.source);
    if (!existsSync(file) || !lstatSync(file).isFile()) fail(`the install declaration names ${entry.source}, which is not a file in the release`);
  }
  const derived = declareInstall(releaseRoot, { minCoordinatorVersion: manifest.install.minCoordinatorVersion });
  const key = (entry) => `${entryKey(entry)} <- ${entry.source}`;
  const declared = manifest.install.files.map(key).sort();
  const expected = derived.files.map(key).sort();
  if (JSON.stringify(declared) !== JSON.stringify(expected)) {
    const missing = expected.filter((entry) => !declared.includes(entry));
    const extra = declared.filter((entry) => !expected.includes(entry));
    fail(`the install declaration does not match the release tree: missing [${missing.join(", ")}], extra [${extra.join(", ")}]`);
  }
}

export function verifyMigrations(releaseRoot, { manifest }) {
  const directory = path.join(releaseRoot, "db/migrations");
  let actual;
  try {
    actual = migrationSetDigest(directory);
  } catch (error) {
    fail(`cannot digest db/migrations: ${error.message}`);
  }
  if (actual.migrationCount !== manifest.database.migrationCount) {
    fail(`db/migrations holds ${actual.migrationCount} migrations but the manifest records ${manifest.database.migrationCount}`);
  }
  if (actual.latestMigration !== manifest.database.latestMigration) {
    fail(`the latest migration is ${actual.latestMigration} but the manifest records ${manifest.database.latestMigration}`);
  }
  if (actual.migrationSetSha256 !== manifest.database.migrationSetSha256) {
    fail(
      `the migration set digest is ${actual.migrationSetSha256.slice(0, 16)}... but the manifest records `
        + `${manifest.database.migrationSetSha256.slice(0, 16)}...; a migration was changed after the artifact was built`,
    );
  }

  // The compatibility contract is recomputed from the shipped declaration for the
  // same reason the digest is: a manifest that summarises a file the artifact does
  // not contain, or contains in another form, is a claim with nothing behind it —
  // and this is the claim `infra-cod update` uses to decide whether an old worker
  // may keep running against a new schema.
  let summary;
  try {
    summary = compatibilitySummary({
      migrationNames: listMigrations(directory),
      compatibility: loadCompatibility(path.join(releaseRoot, "db")),
    });
  } catch (error) {
    fail(`the schema compatibility contract is unusable: ${error.message}`);
  }
  const declared = manifest.database.compatibility;
  const asText = (value) => JSON.stringify(value ?? null);
  if (asText(summary) !== asText(declared)) {
    fail(
      `the manifest's schema compatibility contract ${asText(declared)} is not the one db/${COMPATIBILITY_FILENAME} `
        + `and db/migrations produce, ${asText(summary)}`,
    );
  }

  return actual;
}

// ---------------------------------------------------------------------------
// systemd entry points
// ---------------------------------------------------------------------------

// Every path a unit names under `/opt/infra-cod/current/` must exist in the
// payload. This is the check that turns "the units reference the release" from a
// claim about text into a statement about files: a worker whose module was
// renamed is caught here instead of at `systemctl start`.
export function verifySystemdEntrypoints(releaseRoot) {
  const unitsDirectory = path.join(releaseRoot, "deploy/systemd");
  if (!existsSync(unitsDirectory)) fail("deploy/systemd is missing from the release");

  const referenced = [];
  const missing = [];
  const skipped = [];
  const pattern = /\/opt\/infra-cod\/current\/([A-Za-z0-9._/-]+)/g;

  for (const name of readdirSync(unitsDirectory).sort()) {
    const source = readFileSync(path.join(unitsDirectory, name), "utf8");
    let match;
    while ((match = pattern.exec(source)) !== null) {
      const relative = match[1];
      referenced.push({ unit: name, relative });
      if (existsSync(path.join(releaseRoot, relative))) continue;
      // `web` is a directory the unit uses as its WorkingDirectory, and
      // `docs/OPERATIONS.md` is a Documentation= target. A missing working
      // directory is a real failure; a missing documentation target is not.
      if (relative === "docs/OPERATIONS.md") {
        skipped.push({ unit: name, relative, reason: "Documentation= target, advisory" });
        continue;
      }
      missing.push(`${name} references ${relative}`);
    }
  }

  if (referenced.length === 0) fail("no unit references a release-relative path; the unit files were not found or were rewritten");
  if (missing.length > 0) fail(`systemd units reference paths that are not in the release:\n  ${missing.join("\n  ")}`);

  // Node itself is installed by Stage 10, so the interpreter's absence is not a
  // release defect; it is recorded so the handoff is explicit rather than silent.
  const nodeInterpreters = new Set();
  for (const name of readdirSync(unitsDirectory).sort()) {
    const source = readFileSync(path.join(unitsDirectory, name), "utf8");
    for (const [, program] of source.matchAll(/^ExecStart=(?:\S+\s+)?(\/\S+)/gm)) {
      nodeInterpreters.add(program);
    }
  }

  return { referenced: referenced.length, skipped, nodeInterpreters: [...nodeInterpreters].sort() };
}

// ---------------------------------------------------------------------------
// Secret scan
// ---------------------------------------------------------------------------

// The forbidden-name rules, applied to the *extracted* tree rather than to the
// plan. A build that copied something the allowlist did not describe is caught
// here even if the manifest was written from a different list.
export function verifyNoForbiddenFiles(releaseRoot) {
  const offenders = [];
  for (const entry of walkTree(releaseRoot)) {
    if (entry.type === "directory") continue;
    const reason = isForbiddenName(entry.relativePath);
    if (reason) offenders.push(`${entry.relativePath} (${reason})`);
  }
  if (offenders.length > 0) fail(`the payload contains files it must not:\n  ${offenders.slice(0, 20).join("\n  ")}`);
  return true;
}

// Sentinel scanning: the builder plants unique strings in the environment before
// it builds, and the verifier proves none of them reached a byte of the payload.
//
// This is stronger than pattern matching for known formats, because it tests the
// actual build rather than a list of shapes somebody thought of. The real check is
// the build-side one (the values never exist in the source); this is the
// independent confirmation that the packaging step did not smuggle one in.
export function verifyNoSentinels(releaseRoot, sentinels) {
  if (sentinels.length === 0) return { scanned: 0 };
  const found = [];
  for (const entry of walkTree(releaseRoot)) {
    if (entry.type !== "file") continue;
    const file = path.join(releaseRoot, entry.relativePath);
    for (const { name, value } of sentinels) {
      if (readFileSync(file).includes(value)) found.push({ path: entry.relativePath, name });
    }
  }
  if (found.length > 0) {
    fail(
      `build-time sentinel secrets reached the payload (paths only; the values are not printed):\n  `
        + found.slice(0, 20).map((entry) => `${entry.path} contains ${entry.name}`).join("\n  "),
    );
  }
  return { scanned: sentinels.length };
}

// Common secret shapes, checked over small text files only. A PEM block or a
// GitHub token in a shipped `.mjs` file is a defect regardless of how it got
// there; binary files are skipped because a false positive there costs more than
// it finds.
const SECRET_PATTERNS = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, "a PEM private key block"],
  [/\bghp_[A-Za-z0-9]{36}\b/, "a GitHub personal access token"],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/, "a GitHub fine-grained token"],
  [/\bglpat-[A-Za-z0-9_-]{20,}\b/, "a GitLab token"],
  [/\bsk-[A-Za-z0-9]{32,}\b/, "an API key"],
];

export function verifyNoSecretPatterns(releaseRoot, { maxBytes = 512 * 1024 } = {}) {
  const found = [];
  for (const entry of walkTree(releaseRoot)) {
    if (entry.type !== "file" || entry.size > maxBytes) continue;
    const file = path.join(releaseRoot, entry.relativePath);
    let contents;
    try {
      contents = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    for (const [pattern, label] of SECRET_PATTERNS) {
      const match = pattern.exec(contents);
      if (match) {
        // The matched value is never printed: a scanner that echoes the secret it
        // found has moved it into a build log.
        found.push(`${entry.relativePath} contains ${label}`);
      }
    }
  }
  if (found.length > 0) fail(`the payload contains secret material:\n  ${found.slice(0, 20).join("\n  ")}`);
  return true;
}

// ---------------------------------------------------------------------------
// Composite
// ---------------------------------------------------------------------------

// Everything that can be checked about an unpacked tree, in the order the stage
// requires. Callers that need a subset call the pieces directly.
export function verifyExtractedRelease(releaseRoot, { version, target, channel, sentinels = [] } = {}) {
  if (!lstatSync(releaseRoot, { throwIfNoEntry: false })?.isDirectory()) {
    fail(`${releaseRoot} is not a directory`);
  }
  const manifest = verifyManifestIdentity(releaseRoot, { version, target, channel });
  const fileSums = verifyFileSums(releaseRoot);
  const migrations = verifyMigrations(releaseRoot, { manifest });
  const entrypoints = verifySystemdEntrypoints(releaseRoot);
  const structure = verifyRequiredPaths(releaseRoot, { manifest });
  verifyInstallDeclaration(releaseRoot, { manifest });
  verifyNoForbiddenFiles(releaseRoot);
  verifyNoSecretPatterns(releaseRoot);
  const symlinks = verifySymlinkClosure(releaseRoot);
  verifyNoSentinels(releaseRoot, sentinels);

  // The counts the manifest advertises have to match what is on disk, or the
  // manifest is a description of a different tree.
  const payloadEntries = walkTree(releaseRoot).filter((entry) => entry.relativePath !== MANIFEST_FILENAME && entry.relativePath !== FILESUMS_FILENAME);
  const payloadBytes = payloadEntries.reduce((total, entry) => total + entry.size, 0);
  if (manifest.payload.fileCount !== payloadEntries.length) {
    fail(`the manifest records ${manifest.payload.fileCount} payload entries but the tree has ${payloadEntries.length}`);
  }
  if (manifest.payload.bytes !== payloadBytes) {
    fail(`the manifest records ${manifest.payload.bytes} payload bytes but the tree has ${payloadBytes}`);
  }

  return { manifest, fileSums, migrations, entrypoints, structure, symlinks, payload: { files: payloadEntries.length, bytes: payloadBytes } };
}

// Symlink closure as a standalone check, with the release's own accounting.
export function verifySymlinkClosure(releaseRoot) {
  const entries = walkTree(releaseRoot);
  const { links, escaping, dangling } = checkSymlinkClosure(releaseRoot, entries);
  if (escaping.length > 0) {
    fail(
      `${escaping.length} symlink(s) point outside the release tree:\n  `
        + escaping.slice(0, 10).map((entry) => `${entry.path} -> ${entry.target} (${entry.reason})`).join("\n  "),
    );
  }
  if (dangling.length > 0) {
    fail(
      `${dangling.length} symlink(s) are dangling:\n  `
        + dangling.slice(0, 10).map((entry) => `${entry.path} -> ${entry.target}`).join("\n  "),
    );
  }
  return { count: links.length, links };
}

// The realpath of the tree, for the relocation check: a release that only works
// where it was built will pass every other test and fail the first time somebody
// moves it.
export function relocationFingerprint(releaseRoot) {
  return realpathSync(releaseRoot);
}

// Reads a symlink without following it. Exposed so a test can print the exact
// target text rather than the resolved path.
export function readLink(linkPath) {
  return readlinkSync(linkPath);
}
