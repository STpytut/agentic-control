// The release version contract: what a version string may be, what a tag must
// point at, and which toolchain the artifact claims.
//
// This is deliberately one module with no dependencies beyond `node:fs`. The
// builder, the verifier and the tests all have to agree about what
// `0.1.0-rc.1` means and about what a version string is *not* allowed to contain,
// and the cheapest way to guarantee agreement is to have a single implementation
// rather than three opinions.
//
// The version is attacker-adjacent input: it ends up in a filename, in a tar
// member name, in a shell script and in a manifest that a verifier compares
// against. A version containing `../` or `$(...)` would turn "build a release"
// into "write wherever this string points". So the validator is an allowlist of
// characters, not a list of known-bad substrings.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// The pinned toolchain, in exactly one place. `release-version.json` is read by
// the builder before it does anything else, so a build cannot silently run on a
// Node the project has not agreed to.
export const VERSION_SOURCE = "release/release-version.json";

export const RELEASE_MANIFEST_SCHEMA = "infra-cod/release-manifest/1";

// SemVer 2.0.0, as a whole-string match. Build metadata (`+`) is allowed because
// the development channel uses it; the release channel does not.
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

// Rejected explicitly, so the error message can say which rule was broken rather
// than "invalid version". The SemVer regexp already excludes all of these; this
// list exists so that a *weakened* regexp in a later refactor cannot quietly
// reopen the hole without failing a test that names it.
const FORBIDDEN_IN_VERSION = ["/", "\\", "..", "\0", "\n", "\r", "\t", " ", "'", '"', "`", "$", ";", "|", "&", "<", ">", "(", ")", "*", "?", "!", "#", "~"];

export class VersionContractError extends Error {
  constructor(message) {
    super(message);
    this.name = "VersionContractError";
  }
}

// Parses and validates a release version. Returns the parsed parts.
export function parseVersion(version) {
  if (typeof version !== "string" || version.length === 0) {
    throw new VersionContractError("version must be a non-empty string");
  }
  if (version.length > 128) {
    throw new VersionContractError(`version is unreasonably long (${version.length} characters)`);
  }
  for (const forbidden of FORBIDDEN_IN_VERSION) {
    if (version.includes(forbidden)) {
      throw new VersionContractError(
        `version ${JSON.stringify(version)} contains ${JSON.stringify(forbidden)}, which is not allowed in a version`,
      );
    }
  }
  const match = SEMVER.exec(version);
  if (!match) {
    throw new VersionContractError(
      `version ${JSON.stringify(version)} is not SemVer (expected MAJOR.MINOR.PATCH with an optional -prerelease and +build metadata)`,
    );
  }
  const [, major, minor, patch, prerelease = "", build = ""] = match;
  return {
    version,
    major: Number(major),
    minor: Number(minor),
    patch: Number(patch),
    prerelease,
    build,
    // A version with build metadata is a development artifact. SemVer says build
    // metadata is ignored for precedence, so two versions differing only there
    // are "the same release" to every other tool — which is exactly why it can
    // never be published as a distinct release.
    isDevelopment: build.length > 0 || version.startsWith("0.0.0"),
  };
}

// What kind of artifact a version describes. `channel` is recorded in the
// manifest and is what a verifier compares a `--channel rc` request against.
export function channelFor(version) {
  const parsed = parseVersion(version);
  if (parsed.isDevelopment) return "dev";
  if (parsed.prerelease.length > 0) return "rc";
  return "stable";
}

// `v0.1.0-rc.1` -> `0.1.0-rc.1`. A tag without the `v` is refused: the two forms
// existing side by side is how a release job ends up checking a tag that nothing
// points at.
export function versionFromTag(tag) {
  if (typeof tag !== "string" || tag.length === 0) {
    throw new VersionContractError("tag must be a non-empty string");
  }
  if (!tag.startsWith("v")) {
    throw new VersionContractError(`tag ${JSON.stringify(tag)} must start with "v" (for example v0.1.0)`);
  }
  const version = tag.slice(1);
  parseVersion(version);
  return version;
}

// The name of the tarball for a version.
//
// The platform segment is a parameter rather than a constant read from
// `process.platform`. It is part of the published contract — a release is
// `linux-x64` — and it must not change with the machine that built it, but it must
// also not *claim* a platform the build did not run on. `resolveBuildTarget` decides
// which platform a build may declare, and this function renders whatever it
// decided: a diagnostic build on Darwin produces `…-darwin-arm64.tar.gz`, so a
// consumer looking for `linux-x64` cannot pick it up by accident.
export function platformSlug(target) {
  return `${target.os}-${target.arch}`;
}

// The directory a release is published into. One `version + platform` is one
// directory, which is what lets `SHA256SUMS` be version-specific: the checksum file
// names exactly one tarball, so a directory holding several versions would let one
// release's checksums describe another's bytes.
export function releaseDirectoryName(version, target = null) {
  parseVersion(version);
  return `${version}-${platformSlug(target ?? { os: "linux", arch: "x64" })}`;
}

export function artifactName(version, target = null) {
  parseVersion(version);
  return `infra-cod-${version}-${target ? platformSlug(target) : "linux-x64"}.tar.gz`;
}

// The single top-level directory inside the tarball.
export function releaseRootName(version) {
  parseVersion(version);
  return `infra-cod-${version}`;
}

// A full 40-hex commit id. Abbreviated SHAs are refused everywhere except the
// development version's build metadata, where the short form is the whole point.
export function assertFullCommitSha(sha, label = "commit SHA") {
  if (typeof sha !== "string" || !/^[0-9a-f]{40}$/.test(sha)) {
    throw new VersionContractError(`${label} must be 40 lowercase hex characters, got ${JSON.stringify(sha)}`);
  }
  return sha;
}

export function shortSha(sha) {
  assertFullCommitSha(sha);
  return sha.slice(0, 12);
}

// The version a PR/local build uses: never mistakable for a released one, and
// carrying the commit it was built from so a reviewer can find it.
export function developmentVersion(sha) {
  return `0.0.0-dev+${shortSha(sha)}`;
}

// ---------------------------------------------------------------------------
// Pinned toolchain
// ---------------------------------------------------------------------------

let cachedSource = null;

export function loadVersionSource(root) {
  if (cachedSource && cachedSource.root === root) return cachedSource.value;
  const file = path.join(root, VERSION_SOURCE);
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new VersionContractError(`cannot read ${VERSION_SOURCE}: ${error.message}`);
  }
  for (const key of ["product", "node", "pnpm", "next", "postgresqlMajor", "target"]) {
    if (parsed[key] === undefined) throw new VersionContractError(`${VERSION_SOURCE} has no ${key}`);
  }
  if (!/^\d+\.\d+\.\d+$/.test(parsed.node)) {
    throw new VersionContractError(`${VERSION_SOURCE} node must be an exact x.y.z patch version, got ${JSON.stringify(parsed.node)}`);
  }
  for (const key of ["os", "arch", "libc"]) {
    if (!parsed.target[key]) throw new VersionContractError(`${VERSION_SOURCE} target has no ${key}`);
  }
  cachedSource = { root, value: parsed };
  return parsed;
}

// Compares the running interpreter against the pinned patch version.
//
// A mismatch is a hard failure rather than a warning: Next's native and WASM
// artifacts, `pg`'s optional bindings and Node's own module resolution all vary
// across majors, and "it built on 26" is not evidence about the 24 the plan
// installs. `process.version` is what actually executes the build; `--version`
// output from a spawn could be a different binary.
export function assertRunningNode(source, runningVersion = process.version) {
  const actual = runningVersion.startsWith("v") ? runningVersion.slice(1) : runningVersion;
  if (actual !== source.node) {
    throw new VersionContractError(
      `this build requires Node ${source.node} exactly, but it is running on Node ${actual}. `
        + `Install ${source.node} and put it first on PATH; do not build with a different patch version.`,
    );
  }
  return actual;
}

export function repositoryRootFrom(moduleUrl) {
  return path.resolve(path.dirname(fileURLToPath(moduleUrl)), "..");
}
