#!/usr/bin/env node
// Builds a release artifact: `<out>/infra-cod-<version>-linux-x64.tar.gz`, its
// `SHA256SUMS`, and — in publish mode — `SHA256SUMS.minisig`.
//
// The order of operations is the contract, not an implementation detail:
//
//   1. refuse to run on the wrong platform, the wrong Node, a dirty tree, a
//      version that is not SemVer, or a tag that does not point at HEAD;
//   2. build the web standalone tree and the service dependency closure;
//   3. assemble the payload by allowlist;
//   4. verify the assembled tree *completely* — checksums, symlink closure,
//      entry points, migrations, forbidden names, secret sentinels;
//   5. only then create the tarball, in a temporary file, and rename it into
//      place;
//   6. only after the tarball exists, create `SHA256SUMS`;
//   7. only after `SHA256SUMS` exists, sign it.
//
// A step that fails leaves no final-looking artifact, because each artifact is
// created after the thing it describes has been checked and because every write
// is a rename of a temporary file inside the destination directory.
//
// Usage:
//   node scripts/build-release.mjs [--version <semver>] [--publish] [--out <dir>]
//                                  [--work <dir>] [--skip-build] [--copy] [--keep-work]

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { gunzipSync, gzipSync } from "node:zlib";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { assembleDeployRelease, assembleDocsRelease, assembleMigrationsRelease, assembleServiceRelease, assembleTrustedKeysRelease, assembleVerifierScriptsRelease, assembleWebRelease, mergeCounters, normaliseBuildPaths } from "./lib/release-assemble.mjs";
import { ArchiveError, assertSafeMembers, collectMembers, extractTar, listTarMembers, writeTar } from "./lib/release-archive.mjs";
import { DependencyError, dependencyClosure, materializeDependencies, serviceDependencyRoots } from "./lib/release-dependencies.mjs";
import { compatibilitySummary, loadCompatibility } from "./lib/release-compatibility.mjs";
import { FILESUMS_FILENAME, MANIFEST_FILENAME, buildManifest, listMigrations, migrationSetDigest, renderFileSums } from "./lib/release-manifest.mjs";
import { prepareArtifactsDirectory, prepareWorkDirectory, writeFileAtomic } from "./lib/release-output.mjs";
import { CANONICAL_ENTRYPOINTS, RELEASE_DEPLOY_PATH, RELEASE_DOCS, RELEASE_MIGRATIONS_PATH, PayloadError, isForbiddenName, selectServicePayload, walkTree } from "./lib/release-payload.mjs";
import { SignatureError, asPublicKey, createSignatureFile, parseSecretKeyFile, releasedTrustedComment } from "./lib/release-signature.mjs";
import { VerificationError, sha256File, verifyExtractedRelease, verifyFileSums } from "./lib/release-verify.mjs";
import { VersionContractError, artifactName, channelFor, loadVersionSource, releaseDirectoryName, releaseRootName, assertFullCommitSha, assertRunningNode } from "./lib/release-version.mjs";
import { SENTINEL_VARIABLES, assertPublishable, assertTreeIsClean, buildIdFor, resolveBuildTarget, resolveVersion, sentinelValues } from "./lib/release-preconditions.mjs";
import { declareInstall } from "../services/operations/install-declaration.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const started = Date.now();

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

function parseArguments(argv) {
  const options = {
    version: null,
    publish: false,
    out: path.join(repositoryRoot, "dist/releases"),
    work: path.join(repositoryRoot, "dist/release-work"),
    skipBuild: false,
    keepWork: false,
    hardlink: true,
    quiet: false,
    allowOffTarget: false,
    publicKey: null,
    sentinels: [],
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const next = () => {
      const value = argv[index + 1];
      if (value === undefined) throw new VersionContractError(`${argument} needs a value`);
      index += 1;
      return value;
    };
    if (argument === "--version") options.version = next();
    else if (argument === "--publish") options.publish = true;
    else if (argument === "--out") options.out = path.resolve(next());
    else if (argument === "--work") options.work = path.resolve(next());
    else if (argument === "--skip-build") options.skipBuild = true;
    else if (argument === "--allow-off-target") options.allowOffTarget = true;
    else if (argument === "--public-key") options.publicKey = path.resolve(next());
    else if (argument === "--keep-work") options.keepWork = true;
    else if (argument === "--copy") options.hardlink = false;
    else if (argument === "--quiet") options.quiet = true;
    else if (argument === "--sentinel") options.sentinels.push(next());
    else if (argument === "--help" || argument === "-h") {
      process.stdout.write(
        "usage: node scripts/build-release.mjs [--version <semver>] [--publish] [--out <dir>]\n"
          + "                                    [--work <dir>] [--skip-build] [--copy] [--keep-work]\n"
          + "                                    [--allow-off-target] [--public-key <file>]\n"
          + "                                    [--sentinel <name>=<value>] [--quiet]\n",
      );
      process.exit(0);
    } else throw new VersionContractError(`unknown argument: ${argument}`);
  }
  return options;
}

// ---------------------------------------------------------------------------
// Process helpers
// ---------------------------------------------------------------------------

function runNodeScript(script, args, options = {}) {
  return run(process.execPath, [script, ...args], options);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    cwd: repositoryRoot,
    // Locale and timezone are pinned for every child. A build that formats a date
    // or sorts a directory listing differently depending on the operator's locale
    // is not reproducible, and the difference is invisible until two machines
    // disagree.
    env: {
      ...process.env,
      // `PATH` is part of the inherited environment and is re-asserted here because
      // Turbopack treats its absence as fatal — "the PATH environment variable should
      // always be set: NotPresent" aborted the web build outright. A child that
      // cannot find a helper binary, or cannot find anything at all, must fail because
      // the tool is missing, not because the build dropped a variable.
      PATH: options.path ?? process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
      LC_ALL: "C",
      LANG: "C",
      TZ: "UTC",
      SOURCE_DATE_EPOCH: String(options.sourceDateEpoch ?? process.env.SOURCE_DATE_EPOCH ?? ""),
      NEXT_TELEMETRY_DISABLED: "1",
      ...(options.env ?? {}),
    },
    // Everything except the fields consumed above is forwarded to `spawnSync`. The
    // previous version spread `options` *after* `env`, which replaced the whole
    // environment with `options.env` and silently dropped `PATH` — Turbopack aborts
    // with "the PATH environment variable should always be set: NotPresent", and any
    // other child that resolves a helper would fail the same way. Fields this
    // function owns are excluded so a caller cannot overwrite them by accident.
    ...Object.fromEntries(
      Object.entries(options).filter(([key]) => !["env", "sourceDateEpoch", "path"].includes(key)),
    ),
  });
  if (result.error) throw new Error(`${command} could not be started: ${result.error.message}`);
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} exited ${result.status}\n${result.stdout ?? ""}${result.stderr ?? ""}`);
  }
  return (result.stdout ?? "").trim();
}

function git(args) {
  return run("git", args);
}

// The git state the manifest will claim.
//
// `dirty` counts tracked modifications **and** untracked files. Recording only the
// tracked half was a real defect: an artifact that carried an untracked runtime
// file could say `git.dirty: false`, which asserts that its contents are the commit
// it names. They would not be. A publish build refuses either state, so this only
// ever weakens a local artifact's description — but a description that is wrong in
// the reassuring direction is the one worth fixing.
function collectGitState() {
  const headSha = git(["rev-parse", "HEAD"]);
  assertFullCommitSha(headSha);
  const tagsAtHead = git(["tag", "--points-at", "HEAD"]).split("\n").filter((line) => line.length > 0);
  const porcelain = git(["status", "--porcelain", "--untracked-files=all"]).split("\n").filter((line) => line.length > 0);
  const untracked = porcelain.filter((line) => line.startsWith("??")).map((line) => line.slice(3));
  const modified = porcelain.filter((line) => !line.startsWith("??"));
  return {
    headSha,
    tagsAtHead,
    dirty: porcelain.length > 0,
    untracked,
    modified,
    // The lines an operator needs to see why a tree is dirty, without printing the
    // whole working tree.
    summary: { modified: modified.length, untracked: untracked.length },
  };
}

// SOURCE_DATE_EPOCH comes from the commit, never from the clock. A build that uses
// `Date.now()` produces a different tarball every second and makes the
// reproducibility claim untestable.
function commitEpoch(sha) {
  const epoch = Number(git(["show", "-s", "--format=%ct", sha]));
  if (!Number.isInteger(epoch) || epoch <= 0) {
    throw new VersionContractError(`could not read the commit timestamp of ${sha}`);
  }
  return epoch;
}

// ---------------------------------------------------------------------------
// Web build
// ---------------------------------------------------------------------------

function buildWeb({ version, sha, epoch, skipBuild, log, appDirectory }) {
  if (skipBuild) {
    log("skipping the web build (--skip-build); the existing .next output is used as-is");
    return;
  }
  // The web build runs Next's own CLI under *this* Node, with the application
  // directory as the working directory.
  //
  // Two alternatives were tried and rejected, both by running them:
  //
  //   * `pnpm --dir apps/web build` is what the repository documents, and it works
  //     locally. On the tag runner it failed twice — first `ERR_PNPM_ABORTED_REMOVE_
  //     MODULES_DIR_NO_TTY`, then, once `CI=true` was set, a supply-chain check that
  //     spent 70 seconds retrying `registry.npmjs.org` and exited 254. pnpm's
  //     pre-run verification reaches the network, and a release build that needs the
  //     network to *start* cannot be called offline-capable. The check is not about
  //     this project and its settings names are not a stable interface to depend on.
  //   * Running the CLI from the repository root with the app path as an argument
  //     left `import.meta.dirname` pointing at `apps/`, because the Next
  //     configuration derives `outputFileTracingRoot` from it, and produced a traced
  //     tree whose `pg` resolution broke.
  //
  // The application directory as the working directory is what every working build in
  // this repository uses, including the ones this stage measured. Next resolves its
  // own configuration, its trace root and its `.next` directory relative to it.
  const next = findNextCli(appDirectory);
  log(`building apps/web with Node ${process.version} and ${next} (build id ${buildIdFor({ version, sha })})`);
  runNodeScript(next, ["build"], {
    cwd: appDirectory,
    sourceDateEpoch: epoch,
    env: {
      // `CI` keeps Next non-interactive, so a warning can never become a prompt.
      CI: "true",
      NEXT_BUILD_ID: buildIdFor({ version, sha }),
      NEXT_TELEMETRY_DISABLED: "1",
    },
  });
}

// The Next CLI inside the application's own dependency tree, so the build uses the
// version the lockfile pins rather than whatever is first on `PATH`.
function findNextCli(appDirectory) {
  const candidates = [
    path.join(appDirectory, "node_modules", "next", "dist", "bin", "next"),
    path.join(repositoryRoot, "node_modules", "next", "dist", "bin", "next"),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(
    `next was not found under ${appDirectory}/node_modules. Run "pnpm install --frozen-lockfile" before building a release.`,
  );
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  const options = parseArguments(process.argv.slice(2));
  const log = options.quiet ? () => {} : (message) => process.stdout.write(`${message}\n`);

  const source = loadVersionSource(repositoryRoot);
  assertRunningNode(source);
  const buildTarget = resolveBuildTarget({
    publish: options.publish,
    source,
    allowOffTarget: options.allowOffTarget,
  });
  if (buildTarget.offTarget) {
    log(
      `WARNING: this host is ${buildTarget.hostPlatform}/${buildTarget.hostArch}, not the release target. `
        + `The artifact is named and recorded as ${buildTarget.target.os}/${buildTarget.target.arch} and cannot be published.`,
    );
  }

  const gitState = collectGitState();
  assertTreeIsClean({ publish: options.publish, dirty: gitState.dirty, untracked: gitState.untracked });

  const resolved = resolveVersion({
    requested: options.version,
    publish: options.publish,
    headSha: gitState.headSha,
    tagsAtHead: gitState.tagsAtHead,
  });
  const { version } = resolved;
  const channel = channelFor(version);
  const signed = options.publish;
  assertPublishable({ publish: options.publish, channel, fromTag: resolved.fromTag });
  const epoch = commitEpoch(gitState.headSha);
  const rootName = releaseRootName(version);
  const tarballName = artifactName(version, buildTarget.target);

  log(`release ${version} (channel ${channel}) from ${gitState.headSha.slice(0, 12)}${gitState.dirty ? " (dirty)" : ""}`);
  log(`target ${buildTarget.target.os}/${buildTarget.target.arch}/${buildTarget.target.libc}, SOURCE_DATE_EPOCH ${epoch}`);

  const sentinels = sentinelValues(Object.values(SENTINEL_VARIABLES));
  const sentinelEnv = Object.fromEntries(
    Object.entries(SENTINEL_VARIABLES).map(([variable, name]) => [variable, sentinels.find((entry) => entry.name === name).value]),
  );

  // The work directory is rebuilt from scratch every time. Building into the
  // previous one would let a removed file survive into the next artifact, which is
  // the failure that makes "it worked yesterday" an unreliable statement.
  const work = prepareWorkDirectory(options.work, { repositoryRoot, appDirectory: path.join(repositoryRoot, "apps/web") });
  const treeRoot = path.join(work, rootName);
  mkdirSync(treeRoot, { recursive: true });
  log(`work tree ${path.relative(repositoryRoot, treeRoot)}`);

  // With sentinels in the environment, a build script that interpolates the
  // environment into a shipped file is caught after the fact.
  for (const [variable, value] of Object.entries(sentinelEnv)) process.env[variable] = value;

  buildWeb({ version, sha: gitState.headSha, epoch, skipBuild: options.skipBuild, log, appDirectory: path.join(repositoryRoot, "apps/web") });

  const selection = selectServicePayload({ repositoryRoot });
  log(`services: ${selection.files.length} files, packages ${selection.packages.join(", ") || "(none)"}`);

  const web = assembleWebRelease({ repositoryRoot, releaseRoot: treeRoot, hardlink: options.hardlink });

  // Next embeds the absolute build root in its output. Remove it before anything
  // else looks at the tree: it is a host-identity leak and a reproducibility trap,
  // and the verifier refuses the tree if any is left.
  const normalised = normaliseBuildPaths(treeRoot, {
    buildRoots: [repositoryRoot, path.join(repositoryRoot, "apps/web")],
  });
  if (normalised.filesTouched > 0) {
    log(`removed ${normalised.removed.length} embedded build path(s) from ${normalised.filesTouched} file(s)`);
    for (const removal of normalised.removed.slice(0, 5)) log(`  ${removal.path}: ${removal.value}`);
  }
  if (web.entrypoint !== CANONICAL_ENTRYPOINTS.web) {
    throw new PayloadError(
      `the web entry point is ${web.entrypoint}, but the systemd unit starts ${CANONICAL_ENTRYPOINTS.web}`,
    );
  }
  if (web.dangling.length > 0) {
    log(`dropped ${web.dangling.length} dangling symlink(s) from the traced tree (they resolve to nothing in any install):`);
    for (const link of web.dangling.slice(0, 5)) log(`  ${path.relative(work, link.path)} -> ${link.target}`);
  }
  if (web.rewritten.length > 0) {
    log(`rewrote ${web.rewritten.length} symlink(s) to a shorter relative path that reaches the same directory:`);
    for (const link of web.rewritten) log(`  ${path.relative(work, link.path)}: ${link.from} -> ${link.to}`);
  }
  if (web.materialised.length > 0) {
    log(`materialised ${web.materialised.length} symlink(s) whose target does not fit a tar header and has no shorter alias:`);
    for (const link of web.materialised) log(`  ${path.relative(work, link.path)} -> ${link.target} (${link.bytes} bytes)`);
  }

  const services = assembleServiceRelease({ selection, releaseRoot: treeRoot, hardlink: options.hardlink });
  const migrations = assembleMigrationsRelease({ repositoryRoot, releaseRoot: treeRoot, hardlink: options.hardlink });
  const deploy = assembleDeployRelease({ repositoryRoot, releaseRoot: treeRoot, hardlink: options.hardlink });
  const docs = assembleDocsRelease({ repositoryRoot, releaseRoot: treeRoot, hardlink: options.hardlink, documents: RELEASE_DOCS });
  const verifier = assembleVerifierScriptsRelease({ repositoryRoot, releaseRoot: treeRoot, hardlink: options.hardlink });
  const trustedKeys = assembleTrustedKeysRelease({ repositoryRoot, releaseRoot: treeRoot, hardlink: options.hardlink });

  const dependencyRoots = serviceDependencyRoots(repositoryRoot, selection.packages);
  const closure = dependencyClosure({ nodeModulesRoot: path.join(repositoryRoot, "node_modules"), roots: dependencyRoots });
  const dependencies = materializeDependencies({
    releaseRoot: treeRoot,
    nodeModulesRoot: path.join(repositoryRoot, "node_modules"),
    closure,
    roots: dependencyRoots,
    hardlink: options.hardlink,
  });
  log(`service dependencies: ${dependencies.packages} packages, ${dependencies.files} files, ${dependencies.links.length} links`);

  for (const counters of [web.counters, services, migrations, deploy, docs, verifier, trustedKeys]) {
    if ((counters.dangling ?? []).length > 0) throw new PayloadError("a copied tree contributed dangling symlinks");
  }

  const migrationInfo = migrationSetDigest(path.join(treeRoot, RELEASE_MIGRATIONS_PATH));
  // Read from the assembled tree, not from the checkout: the contract that ends up
  // in the manifest has to be the one the artifact carries, or the verifier would
  // be comparing the manifest against a file no consumer ever sees.
  const compatibility = compatibilitySummary({
    migrationNames: listMigrations(path.join(treeRoot, RELEASE_MIGRATIONS_PATH)),
    compatibility: loadCompatibility(path.join(treeRoot, "db")),
  });
  const manifest = buildManifest({
    version,
    channel,
    signed,
    git: { sha: gitState.headSha, dirty: gitState.dirty, sourceDateEpoch: epoch },
    target: buildTarget.target,
    toolchain: { node: source.node, pnpm: source.pnpm, next: source.next, postgresqlMajor: source.postgresqlMajor },
    migrations: migrationInfo,
    compatibility,
    entrypoints: CANONICAL_ENTRYPOINTS,
    payload: 0,
    payloadBytes: 0,
    omitted: selection.omitted,
    install: declareInstall(treeRoot),
  });

  writeManifestAndFileSums({ treeRoot, manifest, releaseRootName: rootName, epoch, log });

  // The complete check on the assembled tree, before a byte of archive exists.
  const verified = verifyExtractedRelease(treeRoot, {
    version,
    target: buildTarget.target,
    channel,
    sentinels,
  });
  log(
    `verified tree: ${verified.payload.files} payload entries, ${verified.symlinks.count} symlinks, `
      + `${verified.migrations.migrationCount} migrations, ${verified.entrypoints.referenced} unit references`,
  );

  const artifactsRoot = prepareArtifactsDirectory(options.out, { repositoryRoot, appDirectory: path.join(repositoryRoot, "apps/web") });

  // One `version + platform` is one directory, and that directory is published by a
  // single rename.
  //
  // The first version wrote `SHA256SUMS` and `SHA256SUMS.minisig` at the top level
  // and renamed each asset in turn. Two consequences, both real: a stop between
  // renames exposed a final `SHA256SUMS` with no tarball, and building a second
  // version overwrote the shared checksum files while leaving the first version's
  // tarball in place — so the older artifact became unverifiable, because the
  // checksum file beside it now described different bytes.
  //
  // The directory either does not exist or is complete, which is a property a
  // rename gives for free and a sequence of file renames cannot.
  const releaseDirectory = releaseDirectoryName(version, buildTarget.target);
  const artifacts = path.join(artifactsRoot, releaseDirectory);
  if (existsSync(artifacts)) {
    throw new Error(
      `${artifacts} already exists. Remove it deliberately if you mean to replace a published release; `
        + "the builder will not overwrite one by accident.",
    );
  }

  // A flat artifact at the root is either a hand-made file or residue from the older
  // layout, where `SHA256SUMS` and `SHA256SUMS.minisig` were shared by every version.
  // Either way this build does not replace them, so the directory could hold a
  // checksum file describing a different release's bytes — exactly the confusion the
  // versioned layout exists to remove. Refused rather than ignored.
  const legacyRootArtifacts = readdirSync(artifactsRoot).filter(
    (name) => name === "SHA256SUMS" || name === "SHA256SUMS.minisig" || name.endsWith(".tar.gz"),
  );
  if (legacyRootArtifacts.length > 0) {
    throw new Error(
      `${artifactsRoot} holds files from the older flat release layout: ${legacyRootArtifacts.join(", ")}. `
        + "They belong to no version directory, and a consumer could read them as this release's checksums. "
        + "Move them aside before building.",
    );
  }

  const staging = path.join(artifactsRoot, `.staging-${releaseDirectory}-${process.pid}`);
  if (existsSync(staging)) rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });
  let published = [];
  try {
    const archive = createArchive({ treeRoot, tarballName, epoch, artifacts: staging, log });
    const stagedTarball = path.join(staging, tarballName);

    // Prove the artifact that was actually written, before it is renamed and before
    // anything signs it. This is the stage's own rule applied to its own output:
    // `SHA256SUMS` covers the file the consumer will receive, so it is computed from
    // that file and not from the tree it came from.
    verifyStagedArtifact({ tarball: stagedTarball, log });

    writeChecksums({ artifacts: staging, tarballName, tarballPath: stagedTarball, log });
    writeSignatureIfPublishing({
      artifacts: staging,
      publish: options.publish,
      log,
      version,
      publicKeyPath: options.publicKey,
    });

    // The commit point. `rename` of a directory into a name that does not exist is
    // atomic: a reader sees either no directory or the complete set.
    //
    // `INFRA_COD_TEST_COMMIT_MARKER` suspends the build immediately before that
    // rename so a test can inspect the artifacts root at the boundary. It is the
    // only test hook in this file, it is never set in a real build, and it is
    // fail-safe: it releases itself after 60 seconds, so a mis-set variable costs a
    // minute rather than a hung release job.
    pauseAtCommitBoundary();
    renameSync(staging, artifacts);
    published = readdirSync(artifacts).sort();
    log(`published ${releaseDirectory}/ (${published.join(", ")})`);

    const tarballPath = path.join(artifacts, tarballName);
    const files = walkTree(treeRoot).filter(
      (entry) => entry.relativePath !== MANIFEST_FILENAME && entry.relativePath !== FILESUMS_FILENAME,
    );
    const summary = {
      schema: "infra-cod/release-build-summary/1",
      version,
      channel,
      signed,
      gitSha: gitState.headSha,
      dirty: gitState.dirty,
      gitSummary: gitState.summary,
      offTarget: buildTarget.offTarget,
      sourceDateEpoch: epoch,
      target: buildTarget.target,
      toolchain: manifest.toolchain,
      artifacts: {
        releaseDirectory,
        tarball: tarballName,
        tarballBytes: statSync(tarballPath).size,
        tarballSha256: sha256File(tarballPath),
        checksums: "SHA256SUMS",
        signature: options.publish ? "SHA256SUMS.minisig" : null,
        published,
      },
      manifest,
      payload: {
        entries: files.length,
        bytes: files.reduce((total, entry) => total + entry.size, 0),
        symlinks: verified.symlinks.links,
        danglingDropped: web.dangling.map((entry) => ({ path: path.relative(treeRoot, entry.path).split(path.sep).join("/"), target: entry.target })),
        rewrittenLinks: web.rewritten.map((entry) => ({
          path: path.relative(treeRoot, entry.path).split(path.sep).join("/"),
          was: entry.from,
          now: entry.to,
        })),
        materialisedLinks: web.materialised.map((entry) => ({
          path: path.relative(treeRoot, entry.path).split(path.sep).join("/"),
          target: entry.target,
          targetBytes: entry.bytes,
        })),
        archiveMembers: archive.memberCount,
        unexpectedMembers: archive.unexpectedMembers,
      },
      normalised,
      counts: {
        services: services.files,
        migrations: migrations.files,
        deploy: deploy.files,
        docs: docs.files,
        trustedKeys: trustedKeys.files,
        dependencies: dependencies.files,
        web: web.counters.files,
      },
      durationMs: Date.now() - started,
    };
    writeFileAtomic(path.join(artifacts, `${tarballName}.build-summary.json`), `${JSON.stringify(summary, null, 2)}\n`);
    log(`built ${tarballName} (${summary.artifacts.tarballBytes} bytes, sha256 ${summary.artifacts.tarballSha256})`);
    process.stdout.write(`${JSON.stringify(summary)}\n`);
  } catch (error) {
    // Nothing was published: the staging directory is removed and the destination
    // name was never created.
    rmSync(staging, { recursive: true, force: true });
    throw error;
  }

  if (options.keepWork) {
    log(`work tree kept at ${treeRoot}`);
  } else {
    rmSync(work, { recursive: true, force: true });
  }
}

// Suspends the process immediately before the release directory is committed, when
// and only when `INFRA_COD_TEST_COMMIT_MARKER` names a writable path.
//
// The point it exposes — every asset staged, the final directory not yet created —
// is the boundary `release-artifact.test.mjs` needs to prove the publish is atomic.
// There is no way to observe it from outside the process, and a sleep cannot be
// synchronised with it, so the hook lives here rather than being approximated in the
// test.
function pauseAtCommitBoundary({ timeoutMs = 60_000 } = {}) {
  const marker = process.env.INFRA_COD_TEST_COMMIT_MARKER;
  if (!marker) return;
  writeFileSync(marker, `${JSON.stringify({ pid: process.pid, at: new Date().toISOString() })}\n`);
  const release = process.env.INFRA_COD_TEST_COMMIT_RELEASE;
  const deadline = Date.now() + timeoutMs;
  while (!(release && existsSync(release))) {
    if (Date.now() > deadline) {
      throw new Error(
        `INFRA_COD_TEST_COMMIT_MARKER was set but ${release ?? "INFRA_COD_TEST_COMMIT_RELEASE"} never appeared; `
          + "refusing to hold a release build open longer than a minute",
      );
    }
    // A real sleep, so the test's own process can run while this one waits.
    try {
      spawnSync("sleep", ["0.05"]);
    } catch {
      // `sleep` is absent on some platforms; a short busy loop is an acceptable
      // fallback for a hook that only a test sets.
    }
  }
}

// Verifies the artifact that was actually written, before it is published.
//
// The tarball is opened and checked here rather than trusted because the archive
// writer produced it: this is the only point at which the bytes a consumer will
// receive exist. Gzip decodes, the member list is proved safe, the archive extracts
// to exactly one top-level directory, and the extracted tree passes the same
// `FILESUMS.sha256` check a verifier runs. A failure here leaves the staging
// directory to be removed and no published asset at all.
function verifyStagedArtifact({ tarball, log }) {
  const compressed = readFileSync(tarball);
  const tar = gunzipSync(compressed);
  const members = listTarMembers(tar);
  const topLevel = assertSafeMembers(members);
  const scratch = mkdtempSync(path.join(os.tmpdir(), "infra-cod-staged-"));
  try {
    extractTar(tar, scratch, { topLevelDirectory: topLevel });
    const releaseRoot = path.join(scratch, topLevel);
    verifyFileSums(releaseRoot);
    log(`staged artifact verified: ${members.length} members under ${topLevel}/, FILESUMS.sha256 checked`);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

// Writes `manifest.json` and then `FILESUMS.sha256`.
//
// The order is forced by the model: `FILESUMS.sha256` covers the finished
// manifest, so the manifest has to be final — including its payload counts —
// before the list is rendered. `manifest.json` never contains its own checksum,
// and `FILESUMS.sha256` never contains its own, which is what keeps the
// description from depending on itself.
function writeManifestAndFileSums({ treeRoot, manifest, releaseRootName: _releaseRootName, epoch: _epoch, log }) {
  // Count the payload without the manifest and without the checksum list. Those
  // two are the description, not the described.
  let entries = walkTree(treeRoot).filter(
    (entry) => entry.relativePath !== MANIFEST_FILENAME && entry.relativePath !== FILESUMS_FILENAME,
  );
  for (const entry of entries) {
    const forbidden = isForbiddenName(entry.relativePath);
    if (forbidden) throw new PayloadError(`assembled payload contains ${entry.relativePath} (${forbidden})`);
  }

  manifest.payload.fileCount = entries.length;
  manifest.payload.bytes = entries.reduce((total, entry) => total + entry.size, 0);
  manifest.payload.symlinks = entries
    .filter((entry) => entry.type === "symlink")
    .map((entry) => ({ path: entry.relativePath, target: readlinkTarget(treeRoot, entry.relativePath) }));

  const manifestPath = path.join(treeRoot, MANIFEST_FILENAME);
  rmSync(manifestPath, { force: true });
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o644 });

  const withManifest = walkTree(treeRoot).filter((entry) => entry.type === "file");
  const listed = withManifest.map((entry) => ({ path: entry.relativePath, sha256: sha256File(path.join(treeRoot, entry.relativePath)) }));
  const checksumPath = path.join(treeRoot, FILESUMS_FILENAME);
  rmSync(checksumPath, { force: true });
  writeFileSync(checksumPath, renderFileSums(listed), { mode: 0o644 });
  log(`manifest written: ${manifest.payload.fileCount} payload entries, ${manifest.payload.bytes} bytes, ${manifest.payload.symlinks.length} symlinks`);
}

function readlinkTarget(treeRoot, relativePath) {
  return readlinkSync(path.join(treeRoot, relativePath));
}

// The archive is written to a temporary file in the *destination* directory, so
// the final rename is a same-filesystem operation, and renamed only once the
// whole archive exists. An interruption therefore leaves a `.partial` file that no
// consumer looks for, never a valid-looking tarball that is half written.
function createArchive({ treeRoot, tarballName, epoch, artifacts, log }) {
  const chunks = [];
  writeTar(treeRoot, {
    prefix: path.basename(treeRoot),
    sourceDateEpoch: epoch,
    write: (chunk) => chunks.push(Buffer.from(chunk)),
  });
  const tar = Buffer.concat(chunks);

  // gzip is written with an explicit, constant header rather than by spawning
  // `gzip`, so the container does not depend on the version installed on the build
  // host. `mtime` is zeroed for the same reason the tar members use
  // SOURCE_DATE_EPOCH: the archive's own metadata must not carry the build clock.
  const gzip = gzipSync(tar, { level: 9, mtime: 0 });

  const partial = path.join(artifacts, `.${tarballName}.partial-${process.pid}`);
  writeFileSync(partial, gzip, { mode: 0o644 });
  renameSync(partial, path.join(artifacts, tarballName));

  // The member list is the archive's own table of contents, and it is checked here
  // as well as inside the archive writer: a member that is not a file, a directory
  // or a symlink would mean the release tree gained something the payload rules do
  // not describe.
  const members = collectMembers(treeRoot, { prefix: path.basename(treeRoot), sourceDateEpoch: epoch });
  const unexpected = members.filter((member) => !["file", "directory", "symlink"].includes(member.type));

  log(`archive written: ${gzip.length} bytes from ${tar.length} bytes of tar (${Math.round((tar.length / gzip.length) * 100) / 100}:1)`);
  return { tarBytes: tar.length, gzipBytes: gzip.length, memberCount: members.length, unexpectedMembers: unexpected.length };
}

function writeChecksums({ artifacts, tarballName, tarballPath, log }) {
  const digest = sha256File(tarballPath);
  const text = `${digest}  ${tarballName}\n`;
  writeFileAtomic(path.join(artifacts, "SHA256SUMS"), text);
  log(`SHA256SUMS written (${digest})`);
  return digest;
}

// Signing is the last step and the only one that needs a secret. A publish build
// without a key fails here, before anything is uploaded, and an unsigned local
// build simply does not produce the file.
function writeSignatureIfPublishing({ artifacts, publish, log, version, publicKeyPath }) {
  if (!publish) return null;

  const keyFile = process.env.INFRA_COD_RELEASE_KEY_FILE;
  if (!keyFile) {
    throw new SignatureError(
      "publish mode needs INFRA_COD_RELEASE_KEY_FILE pointing at the minisign secret key. "
        + "The key is never committed and never printed; the release job supplies it from a secret store.",
    );
  }
  if (!existsSync(keyFile)) throw new SignatureError(`the signing key file does not exist: ${keyFile}`);

  // The pinned public key is named by the caller, not inherited from the environment.
  //
  // An environment variable for this was a convenience that made the trust root
  // implicit: a release could be signed under a key that happened to be exported in
  // the shell rather than the one committed to the repository. `--public-key` is
  // required in publish mode, and the signature is checked against the secret key's
  // id, so the key that signs and the key that verifies have to be the same key.
  const pinnedKeyPath = publicKeyPath ?? path.resolve(repositoryRoot, loadVersionSource(repositoryRoot).signing.publicKey);
  if (!existsSync(pinnedKeyPath)) {
    throw new SignatureError(
      `${path.relative(repositoryRoot, pinnedKeyPath)} does not exist, so the key that would sign this release is not pinned anywhere. `
        + "Provision the release signing key (see release/keys/README.md) before publishing.",
    );
  }
  const publicKeyText = readFileSync(pinnedKeyPath, "utf8");
  const publicKey = asPublicKey(publicKeyText);
  const configuredKeyId = loadVersionSource(repositoryRoot).signing.keyId;
  if (configuredKeyId && publicKey.keyId !== configuredKeyId) {
    throw new SignatureError(
      `the pinned public key has id ${publicKey.keyId} but release-version.json pins ${configuredKeyId}`,
    );
  }

  const secret = parseSecretKeyFile(readFileSync(keyFile, "utf8"));
  const sumsPath = path.join(artifacts, "SHA256SUMS");
  const sums = readFileSync(sumsPath);
  // The version is passed in, not recovered from the tarball name. The recovery
  // regex was greedy — `infra-cod-0.1.0-linux-x64.tar.gz` yielded `0.1.0-linux-x64` —
  // so the signed comment named a platform as part of the version. A value that is
  // already validated needs no parsing.
  const signature = createSignatureFile(sums, secret, {
    trustedComment: releasedTrustedComment(version),
    publicKey,
  });
  writeFileAtomic(path.join(artifacts, "SHA256SUMS.minisig"), signature);
  log(`SHA256SUMS signed with key ${publicKey.keyId}`);
  return publicKey.keyId;
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

try {
  main();
} catch (error) {
  const expected = [VersionContractError, PayloadError, DependencyError, ArchiveError, SignatureError, VerificationError];
  const label = expected.some((type) => error instanceof type) ? error.name : "error";
  process.stderr.write(`release build failed (${label}): ${error.message}\n`);
  process.exitCode = 1;
}
