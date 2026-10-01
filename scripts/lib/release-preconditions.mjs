// The refusals a release build has to make, as pure functions.
//
// These live in their own module rather than inside `build-release.mjs` because
// they are the rules a test has to be able to exercise directly: "refuse a dirty
// tree", "refuse macOS in publish mode", "refuse a version the tag does not
// name". Importing the builder to reach them would run a build.
//
// Each function takes the state it judges and throws with a message that says what
// was wrong and what to do instead. None of them print, none of them exit, and none
// of them touch the filesystem.

import { VersionContractError, developmentVersion, parseVersion, versionFromTag } from "./release-version.mjs";

// An artifact is built for its target, on its target.
//
// The first version of this check ran only for `--publish`, which made the target
// field decorative: a Darwin/arm64 build produced a file named
// `…-linux-x64.tar.gz` whose manifest said `linux/x64/glibc`, and every structural
// check "passed" because the only thing comparing the two was the manifest itself.
// The filename and the manifest both claimed a platform nothing had verified.
// Next's SWC binaries and sharp's libvips are platform-specific, so that artifact
// could not run on the platform it named.
//
// The rule is therefore unconditional: a build whose host is not its target is
// refused. `--allow-off-target` exists for local diagnostics, and it is not a
// loophole — it changes the artifact's declared identity to the platform that
// actually produced it, so the result can never be mistaken for a target build:
//
//   * the filename carries the real platform (`…-darwin-arm64.tar.gz`);
//   * `manifest.target` records the real platform;
//   * the channel is `dev` and the build is unsigned, which `assertPublishable`
//     already refuses.
//
// A consumer looking for `linux-x64` therefore cannot pick it up, and a verifier
// asking for `linux/x64` refuses it, without either side having to trust a flag.
export function resolveBuildTarget({ publish, source, allowOffTarget = false, platform = process.platform, arch = process.arch }) {
  const hostMatchesTarget = platform === source.target.os && arch === source.target.arch;
  if (hostMatchesTarget) {
    return { target: { ...source.target }, offTarget: false };
  }
  if (publish) {
    throw new VersionContractError(
      `a publishable release must be built on ${source.target.os}/${source.target.arch}, but this is ${platform}/${arch}. `
        + "Build unsigned locally, or run the tag workflow on ubuntu-24.04.",
    );
  }
  if (!allowOffTarget) {
    throw new VersionContractError(
      `this build host is ${platform}/${arch} but the release target is ${source.target.os}/${source.target.arch}. `
        + "Next's SWC and sharp artifacts are platform-specific, so the result would not be the artifact it claims to be. "
        + "Build on the target, or pass --allow-off-target for a diagnostic build that is named after this host and cannot be published.",
    );
  }
  // The declared target becomes the host's, so nothing downstream can be misled.
  return {
    target: { os: platform, arch, libc: source.target.libc },
    offTarget: true,
    hostPlatform: platform,
    hostArch: arch,
  };
}

// A git archive of a dirty tree is not the commit it claims to be. Untracked files
// are refused separately from modified ones because the failure is different: a
// modification means the artifact differs from the commit, an untracked file means
// something is in the tree that the commit does not mention at all — which is how a
// private key or an `.env.local` reaches a payload.
export function assertTreeIsClean({ publish, dirty, untracked = [] }) {
  if (!publish) return;
  if (dirty) {
    throw new VersionContractError("refusing to publish from a dirty working tree; commit or stash the changes first");
  }
  if (untracked.length > 0) {
    throw new VersionContractError(
      `refusing to publish with untracked files present (${untracked.slice(0, 5).join(", ")}`
        + `${untracked.length > 5 ? ", ..." : ""}); the artifact would claim a commit that does not contain everything in it`,
    );
  }
}

// Which version a build produces.
//
// A tagged HEAD builds as its tag in every mode, so an artifact cannot disagree
// with the tag it came from. Publish mode requires such a tag; a local build
// without one falls back to `0.0.0-dev+<sha>`, which `channelFor` classifies as
// `dev` and which therefore can never be published.
export function resolveVersion({ requested, publish, headSha, tagsAtHead }) {
  if (requested !== null && requested !== undefined) parseVersion(requested);
  const releaseTags = tagsAtHead.filter((tag) => /^v\d/.test(tag));

  if (publish) {
    if (!requested) throw new VersionContractError("--publish requires --version <semver>");
    if (releaseTags.length === 0) {
      throw new VersionContractError(
        `--publish requires a v* tag pointing at HEAD (${headSha.slice(0, 12)}); `
          + `found ${tagsAtHead.length === 0 ? "no tags" : tagsAtHead.join(", ")}`,
      );
    }
    const fromTags = new Set(releaseTags.map((tag) => versionFromTag(tag)));
    if (!fromTags.has(requested)) {
      throw new VersionContractError(
        `requested version ${requested} does not match any tag at HEAD (${[...fromTags].join(", ") || "none"})`,
      );
    }
    return { version: requested, fromTag: true, tags: releaseTags };
  }

  if (releaseTags.length > 0) {
    const fromTags = new Set(releaseTags.map((tag) => versionFromTag(tag)));
    if (requested !== null && requested !== undefined && !fromTags.has(requested)) {
      throw new VersionContractError(
        `--version ${requested} does not match the tag at HEAD (${[...fromTags].join(", ") || "none"}). `
          + "A tagged commit builds as its tag, so the artifact cannot disagree with the tag.",
      );
    }
    return { version: requested ?? [...fromTags][0], fromTag: true, tags: releaseTags };
  }

  return { version: requested ?? developmentVersion(headSha), fromTag: false, tags: [] };
}

// The build id Next embeds in chunk names. Derived from the version and the
// commit, so two builds of one commit carry the same ids and therefore the same
// chunk file names — `Date.now()` or a random id would make the tarballs differ
// for no reason a reviewer could see.
export function buildIdFor({ version, sha }) {
  return `infra-cod-${version}-${sha.slice(0, 12)}`.replace(/[^A-Za-z0-9._-]/g, "_");
}

// A version that a release job must refuse to publish: the development channel, and
// anything the tag did not name.
export function assertPublishable({ publish, channel, fromTag }) {
  if (!publish) return;
  if (channel === "dev") {
    throw new VersionContractError("a development version is never a publishable release");
  }
  if (!fromTag) throw new VersionContractError("a publishable release must come from a tag");
}

// Sentinel values for the secret scan. They are random per build so that a value
// found in the payload cannot have come from a previous run's leftovers, and they
// are uppercase alphanumeric so that a text search cannot be confused by encoding.
export function sentinelValues(names, random = () => Math.random().toString(36).slice(2, 12)) {
  return names.map((name) => ({
    name,
    value: `SENTINEL${name.replace(/[^A-Za-z0-9]/g, "")}${random()}${random()}`.toUpperCase(),
  }));
}

// The environment variables the sentinels are planted in. Every one of these is a
// real variable this project reads in production, so a build that interpolates
// production configuration into a shipped file is caught by a value that looks
// exactly like the real thing.
export const SENTINEL_VARIABLES = {
  INFRA_COD_AUTH_PEPPER: "AUTH_PEPPER",
  INFRA_COD_OAUTH_ENCRYPTION_KEY: "OAUTH_KEY",
  GITHUB_APP_CLIENT_SECRET: "GITHUB_SECRET",
  GITHUB_APP_PRIVATE_KEY: "GITHUB_PRIVATE_KEY",
  DATABASE_URL: "DATABASE_URL",
  NPM_TOKEN: "NPM_TOKEN",
  INFRA_COD_SESSION_SECRET: "SESSION_SECRET",
};
