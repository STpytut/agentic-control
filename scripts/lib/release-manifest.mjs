// The release manifest, the internal checksum file, and the migration set digest.
//
// The manifest is the artifact's own claim about itself, and the verifier's job is
// to distrust it until it agrees with the bytes. That shapes two decisions that
// are easy to get wrong:
//
//   * **No cycles.** `manifest.json` describes the payload, so it cannot include
//     its own checksum; `FILESUMS.sha256` covers every payload file *and* the
//     finished manifest, but not itself. The tarball's checksum lives outside the
//     tarball, in `SHA256SUMS`, because putting it inside would make the file
//     depend on its own hash.
//   * **No host identity.** Absolute build paths, the account that ran the build
//     and the branch name are all absent, not merely "usually absent". A path that
//     leaks the build host is both an information leak and a reproducibility trap:
//     two machines would produce different manifests for the same source.
//
// Everything numeric in the manifest is computed from the payload. The migration
// count is not a constant in a test, and the latest migration name is not written
// down anywhere outside the file that happens to sort last.

import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { COMPATIBILITY_SCHEMA } from "./release-compatibility.mjs";
import { RELEASE_MANIFEST_SCHEMA } from "./release-version.mjs";
import { installSectionProblems } from "../../services/operations/install-declaration.mjs";

export const MANIFEST_FILENAME = "manifest.json";
export const FILESUMS_FILENAME = "FILESUMS.sha256";

export class ManifestError extends Error {
  constructor(message) {
    super(message);
    this.name = "ManifestError";
  }
}

const CHANNELS = new Set(["dev", "rc", "stable"]);
const HEX64 = /^[0-9a-f]{64}$/;
const HEX40 = /^[0-9a-f]{40}$/;

// ---------------------------------------------------------------------------
// Migrations
// ---------------------------------------------------------------------------

export function listMigrations(migrationsDirectory) {
  const names = readdirSync(migrationsDirectory)
    .filter((name) => name.endsWith(".sql"))
    .sort();
  if (names.length === 0) {
    throw new ManifestError(`no migrations found in ${migrationsDirectory}`);
  }
  return names;
}

// The digest of the migration *set*, as the stage requires: the ordered list of
// `filename + file sha256`, not the concatenated SQL. Concatenating the bodies
// would let two different sets collide by moving a boundary, and would miss a
// rename entirely — a rename is exactly the change that breaks a ledger.
export function migrationSetDigest(migrationsDirectory) {
  const names = listMigrations(migrationsDirectory);
  const hash = createHash("sha256");
  for (const name of names) {
    const contents = readFileSync(path.join(migrationsDirectory, name));
    const fileHash = createHash("sha256").update(contents).digest("hex");
    hash.update(`${name}\n${fileHash}\n`);
  }
  return {
    migrationCount: names.length,
    latestMigration: names[names.length - 1],
    migrationSetSha256: hash.digest("hex"),
  };
}

// ---------------------------------------------------------------------------
// Manifest construction
// ---------------------------------------------------------------------------

export function buildManifest({
  version,
  channel,
  signed,
  git,
  target,
  toolchain,
  migrations,
  compatibility,
  entrypoints,
  payload,
  payloadBytes,
  omitted = [],
  install,
}) {
  const manifest = {
    schema: RELEASE_MANIFEST_SCHEMA,
    product: "infra-cod",
    version,
    channel,
    release: { signed: Boolean(signed) },
    git: {
      sha: git.sha,
      dirty: Boolean(git.dirty),
      sourceDateEpoch: git.sourceDateEpoch,
    },
    target: { os: target.os, arch: target.arch, libc: target.libc },
    toolchain: {
      node: toolchain.node,
      pnpm: toolchain.pnpm,
      next: toolchain.next,
      postgresqlMajor: toolchain.postgresqlMajor,
    },
    database: {
      migrationCount: migrations.migrationCount,
      latestMigration: migrations.latestMigration,
      migrationSetSha256: migrations.migrationSetSha256,
      // The update coordinator's release contract: which of these migrations the
      // previous release cannot read past, and which ones predate the contract and
      // are therefore treated as if it could not. `infra-cod update` reads this to
      // decide whether the old application may keep serving through the migration
      // and whether an application-only rollback is still a rollback.
      compatibility,
    },
    entrypoints,
    // What the release installs outside its tree, as data the coordinator
    // reconciles the host to (WP-A, services/operations/install-declaration.mjs).
    install,
    payload: {
      fileCount: payload,
      bytes: payloadBytes,
      checksums: FILESUMS_FILENAME,
      symlinks: [],
    },
  };

  // Omissions are recorded because an artifact whose manifest lists what is *not*
  // in it is checkable in a way a manifest that only lists what is cannot be. A
  // reviewer can ask "why is there no client.mjs?" and get an answer from the
  // artifact rather than from a chat log.
  if (omitted.length > 0) {
    manifest.source = { omitted: omitted.map((entry) => ({ path: entry.path, reason: entry.reason })) };
  }

  return manifest;
}

// ---------------------------------------------------------------------------
// Manifest validation, shared by the verifier and the tests
// ---------------------------------------------------------------------------

export function validateManifest(manifest, { version, target } = {}) {
  const problems = [];
  const expect = (condition, message) => { if (!condition) problems.push(message); };

  expect(manifest && typeof manifest === "object", "manifest is not an object");
  if (problems.length > 0) throw new ManifestError(problems.join("; "));

  expect(manifest.schema === RELEASE_MANIFEST_SCHEMA, `schema is ${JSON.stringify(manifest.schema)}, expected ${RELEASE_MANIFEST_SCHEMA}`);
  expect(manifest.product === "infra-cod", `product is ${JSON.stringify(manifest.product)}`);
  expect(typeof manifest.version === "string" && manifest.version.length > 0, "version is missing");
  expect(CHANNELS.has(manifest.channel), `channel ${JSON.stringify(manifest.channel)} is not one of ${[...CHANNELS].join(", ")}`);
  expect(typeof manifest.release?.signed === "boolean", "release.signed is not a boolean");
  expect(HEX40.test(manifest.git?.sha ?? ""), `git.sha is not 40 hex characters: ${JSON.stringify(manifest.git?.sha)}`);
  expect(typeof manifest.git?.dirty === "boolean", "git.dirty is not a boolean");
  expect(Number.isInteger(manifest.git?.sourceDateEpoch) && manifest.git.sourceDateEpoch >= 0, "git.sourceDateEpoch is not a non-negative integer");
  for (const key of ["os", "arch", "libc"]) {
    expect(typeof manifest.target?.[key] === "string" && manifest.target[key].length > 0, `target.${key} is missing`);
  }
  for (const key of ["node", "pnpm", "next"]) {
    expect(typeof manifest.toolchain?.[key] === "string" && manifest.toolchain[key].length > 0, `toolchain.${key} is missing`);
  }
  expect(Number.isInteger(manifest.toolchain?.postgresqlMajor), "toolchain.postgresqlMajor is not an integer");
  expect(Number.isInteger(manifest.database?.migrationCount) && manifest.database.migrationCount > 0, "database.migrationCount is not a positive integer");
  expect(typeof manifest.database?.latestMigration === "string" && manifest.database.latestMigration.endsWith(".sql"), "database.latestMigration is not a .sql filename");
  expect(HEX64.test(manifest.database?.migrationSetSha256 ?? ""), "database.migrationSetSha256 is not a sha256");
  const compatibility = manifest.database?.compatibility;
  expect(compatibility?.contract === COMPATIBILITY_SCHEMA, `database.compatibility.contract is ${JSON.stringify(compatibility?.contract)}, expected ${COMPATIBILITY_SCHEMA}`);
  expect(/^\d{4}$/.test(compatibility?.unverifiedThrough ?? ""), "database.compatibility.unverifiedThrough is not a four-digit migration version");
  for (const key of ["unverified", "backwardIncompatible"]) {
    const list = compatibility?.[key];
    expect(Array.isArray(list) && list.every((entry) => /^\d{4}$/.test(entry)), `database.compatibility.${key} is not a list of four-digit migration versions`);
  }
  for (const key of ["web", "cli", "migrate", "runtimeSupervisor"]) {
    const value = manifest.entrypoints?.[key];
    expect(typeof value === "string" && value.length > 0 && !value.startsWith("/"), `entrypoints.${key} is missing or absolute`);
  }
  expect(Number.isInteger(manifest.payload?.fileCount) && manifest.payload.fileCount > 0, "payload.fileCount is not a positive integer");
  expect(Number.isInteger(manifest.payload?.bytes) && manifest.payload.bytes > 0, "payload.bytes is not a positive integer");
  expect(manifest.payload?.checksums === FILESUMS_FILENAME, `payload.checksums is not ${FILESUMS_FILENAME}`);
  expect(Array.isArray(manifest.payload?.symlinks), "payload.symlinks is not an array");
  // Required of every release built since WP-A. A release built before it has
  // none, and a coordinator derives the same declaration from its tree; the
  // builder never writes a manifest without one.
  if (manifest.install !== undefined) {
    for (const problem of installSectionProblems(manifest.install)) problems.push(problem);
  }

  if (version !== undefined) {
    expect(manifest.version === version, `manifest version is ${JSON.stringify(manifest.version)}, requested ${JSON.stringify(version)}`);
  }
  if (target !== undefined) {
    for (const key of ["os", "arch", "libc"]) {
      expect(manifest.target?.[key] === target[key], `manifest target.${key} is ${JSON.stringify(manifest.target?.[key])}, requested ${JSON.stringify(target[key])}`);
    }
  }

  if (problems.length > 0) throw new ManifestError(`manifest is not valid:\n  ${problems.join("\n  ")}`);
  return manifest;
}

// A payload the manifest must not describe. These strings are the ones that would
// turn up if the allowlist were ever bypassed; checking the serialised manifest is
// cheap and catches a regression in the builder that a structural test might miss.
//
// The path patterns are anchored so that a URL which merely contains `/home/` —
// `https://github.com/...` is the common case — is not mistaken for one.
const FORBIDDEN_MANIFEST_PATTERNS = [
  [/"\/(?:Users|home|root|opt|private|var\/folders|tmp)\//, "an absolute host path"],
  [/(?:^|[^\w./-])\/(?:Users|home)\/[A-Za-z0-9._-]+\//, "a home directory path"],
  [/[A-Za-z]:\\\\/, "a Windows absolute path"],
  [/BEGIN [A-Z ]*PRIVATE KEY/, "a private key"],
  [/registry\.npmjs\.org|_authToken|NODE_AUTH_TOKEN|npm_[A-Za-z0-9]{36}/, "a registry credential"],
  [/"branch"\s*:/, "a branch name used as release identity"],
];

export function assertManifestIsHostFree(manifest) {
  const text = JSON.stringify(manifest);
  for (const [pattern, label] of FORBIDDEN_MANIFEST_PATTERNS) {
    if (pattern.test(text)) {
      const match = pattern.exec(text);
      throw new ManifestError(`manifest contains ${label}: ${JSON.stringify(match[0].slice(0, 120))}`);
    }
  }
  return manifest;
}

// ---------------------------------------------------------------------------
// FILESUMS.sha256
// ---------------------------------------------------------------------------

// The `sha256sum -c` format: "<hex>  <path>\n", with the path relative to the
// directory the file sits in and using `/`. Two spaces, as coreutils writes and
// expects; one space makes `sha256sum -c` read the name as binary-mode input.
//
// The order is the payload's sorted member order followed by `manifest.json`, so
// the file itself is reproducible.
export function renderFileSums(entries) {
  const lines = entries.map((entry) => `${entry.sha256}  ${entry.path}`);
  return `${lines.join("\n")}\n`;
}

export function parseFileSums(text) {
  const entries = [];
  for (const rawLine of text.split("\n")) {
    if (rawLine.length === 0) continue;
    const match = /^([0-9a-f]{64}) {2}(.+)$/.exec(rawLine);
    if (!match) throw new ManifestError(`FILESUMS line is not in sha256sum format: ${JSON.stringify(rawLine)}`);
    const [, sha256, entryPath] = match;
    if (entryPath.startsWith("/") || entryPath.split("/").includes("..")) {
      throw new ManifestError(`FILESUMS contains a non-relative path: ${JSON.stringify(entryPath)}`);
    }
    entries.push({ sha256, path: entryPath });
  }
  return entries;
}
