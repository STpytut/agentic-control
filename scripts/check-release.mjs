#!/usr/bin/env node
// The full release gate: the fast release tests, a build, the artifact tests,
// verification, and a determinism check.
//
// This is what `check:release` runs and what the tag workflow runs before it signs
// anything. It is a driver rather than a shell one-liner because the steps have to
// pass information to each other — the artifact name comes from the build summary,
// and the determinism check needs two builds in two directories — and doing that in
// shell means parsing JSON with `node -e` inside nested quotes, which is a bug
// waiting to be written.
//
// Usage:
//   node scripts/check-release.mjs [--artifacts <dir>] [--determinism] [--skip-build]
//                                  [--artifact <tarball>] [--keep-determinism-trees] [--json]
//
// `--artifact` verifies an artifact that already exists instead of building one. The
// CI candidate job builds once and then needs the artifact verified, and asking this
// driver to build again would fail on the builder's own "refusing to overwrite a
// published artifact" guard — which is what the first version of the workflow did.

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, statSync } from "node:fs";
import { gunzipSync } from "node:zlib";

import { assertSafeMembers, extractTar, listTarMembers } from "./lib/release-archive.mjs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { resolveBuildTarget } from "./lib/release-preconditions.mjs";
import { loadVersionSource } from "./lib/release-version.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// A diagnostic build on a host that is not the release target is refused by
// default, which is the correct default and is what the integration tests assert.
// This driver is a local check: on macOS it has to be able to build *something* to
// exercise verification and the artifact tests. It passes `--allow-off-target` only
// when the host genuinely differs, and the resulting artifact is named after the
// host and marked `offTarget`, so it can never be published. On the target platform
// the flag is not passed and the stricter default applies.
const OFF_TARGET = (() => {
  const source = loadVersionSource(repositoryRoot);
  const resolved = resolveBuildTarget({ publish: false, source, allowOffTarget: true });
  return resolved.offTarget ? ["--allow-off-target"] : [];
})();

function parseArguments(argv) {
  const options = {
    artifacts: path.join(repositoryRoot, "dist/releases"),
    determinism: true,
    keepDeterminismTrees: process.env.INFRA_COD_KEEP_DETERMINISM_TREES === "1",
    // `--skip-build` means "do not rebuild the web app"; `--artifact` means "do not
    // build an artifact at all". They are different questions and the first version
    // of this driver conflated them, which is why `INFRA_COD_RELEASE_SKIP_BUILD=1`
    // had no effect on the build.
    skipBuild: process.env.INFRA_COD_RELEASE_SKIP_BUILD === "1",
    existingArtifact: null,
    json: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--artifacts") options.artifacts = path.resolve(argv[++index]);
    else if (argument === "--determinism") options.determinism = true;
    else if (argument === "--no-determinism") options.determinism = false;
    else if (argument === "--keep-determinism-trees") options.keepDeterminismTrees = true;
    else if (argument === "--skip-build") options.skipBuild = true;
    else if (argument === "--artifact") options.existingArtifact = path.resolve(argv[++index]);
    else if (argument === "--json") options.json = true;
    else throw new Error(`unknown argument: ${argument}`);
  }
  return options;
}

function step(label, command, args, options = {}) {
  process.stdout.write(`\n=== ${label} ===\n`);
  const result = spawnSync(command, args, {
    cwd: repositoryRoot,
    stdio: "inherit",
    env: { ...process.env, ...(options.env ?? {}) },
  });
  if (result.error) throw new Error(`${label} could not start: ${result.error.message}`);
  if (result.status !== 0) {
    throw new Error(`${label} failed with exit code ${result.status}`);
  }
}

function build({ out, work, extra = [] }) {
  const args = [
    path.join(repositoryRoot, "scripts/build-release.mjs"),
    "--out", out,
    "--work", work,
    "--quiet",
    ...OFF_TARGET,
    ...(extra),
  ];
  const result = spawnSync(process.execPath, args, { cwd: repositoryRoot, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`release build failed:\n${result.stdout}\n${result.stderr}`);
  const summary = JSON.parse(result.stdout.trim().split("\n").pop());
  return summary;
}

// Compares two release directories file by file and returns the differences as
// readable lines. The binaries inside them are large, so it compares hashes rather
// than contents.
function compareReleaseTrees(left, right) {
  const walk = (directory, prefix = "") => {
    const found = new Map();
    for (const name of readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, name.name);
      const relative = prefix ? `${prefix}/${name.name}` : name.name;
      if (name.isDirectory()) {
        for (const [key, value] of walk(full, relative)) found.set(key, value);
        continue;
      }
      // A symlink is recorded by its target text, not by reading through it: reading
      // a link that names a directory raises EISDIR, which is what this diagnostic
      // hit before it could report anything.
      found.set(relative, name.isSymbolicLink() ? `link:${readlinkSync(full)}` : sha256(full));
    }
    return found;
  };
  const first = walk(left);
  const second = walk(right);
  const differences = [];
  for (const [relative, digest] of first) {
    if (!second.has(relative)) differences.push(`only in first: ${relative}`);
    else if (second.get(relative) !== digest) differences.push(`content differs: ${relative}`);
  }
  for (const relative of second.keys()) {
    if (!first.has(relative)) differences.push(`only in second: ${relative}`);
  }
  return differences.sort();
}

// Extracts two tarballs into `scratch` and compares their members file by file.
function compareArchives(first, second, scratch) {
  const roots = [];
  for (const [index, archive] of [first, second].entries()) {
    const tar = gunzipSync(readFileSync(archive));
    const members = listTarMembers(tar);
    const topLevel = assertSafeMembers(members);
    const destination = path.join(scratch, `extracted-${index === 0 ? "a" : "b"}`);
    extractTar(tar, destination, { topLevelDirectory: topLevel });
    roots.push(path.join(destination, topLevel));
  }
  return compareReleaseTrees(roots[0], roots[1]).map((entry) => `payload: ${entry}`);
}

function sha256(file) {
  const result = spawnSync("sha256sum", [file], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`sha256sum failed for ${file}`);
  return result.stdout.split(/\s+/)[0];
}

function main() {
  const options = parseArguments(process.argv.slice(2));
  const skipBuild = options.skipBuild ? ["--skip-build"] : [];
  const report = { schema: "infra-cod/check-release/1", steps: [] };

  step("release structural tests", process.execPath, ["--test", "services/control-plane/test/release-structure.test.mjs"]);
  report.steps.push({ name: "test:release", ok: true, kind: "fast" });

  let artifact;
  if (options.existingArtifact !== null) {
    if (!existsSync(options.existingArtifact)) {
      throw new Error(`--artifact names a file that does not exist: ${options.existingArtifact}`);
    }
    artifact = options.existingArtifact;
    report.artifact = { name: path.basename(artifact), bytes: statSync(artifact).size, sha256: sha256(artifact) };
    process.stdout.write(`\n=== verifying an existing artifact: ${path.basename(artifact)} ===\n`);
  } else {
    const summary = build({ out: options.artifacts, work: path.join(os.tmpdir(), `infra-cod-check-work-${process.pid}`), extra: skipBuild });
    // One `version + platform` is one directory; the tarball lives inside it
    // alongside its checksum file and signature.
    artifact = path.join(options.artifacts, summary.artifacts.releaseDirectory, summary.artifacts.tarball);
    if (!existsSync(artifact)) throw new Error(`the build reported ${artifact}, which does not exist`);
    report.artifact = {
      name: summary.artifacts.tarball,
      bytes: summary.artifacts.tarballBytes,
      sha256: summary.artifacts.tarballSha256,
    };

    // The artifact tests build their own artifact in a scratch directory, so they
    // always run; the flag tells them to reuse the checkout's existing `.next`
    // output rather than rebuilding the web app.
    step("release artifact tests", process.execPath, [
      "--test", "--test-concurrency=1", "services/control-plane/test/release-artifact.test.mjs",
    ], { env: { ...process.env, INFRA_COD_RELEASE_SKIP_BUILD: "1" } });
    report.steps.push({ name: "test:release:artifact", ok: true });
  }

  step("verify the artifact", process.execPath, [path.join(repositoryRoot, "scripts/verify-release.mjs"), "--artifact", artifact, "--smoke"]);

  step("pre-install gate", "sh", [path.join(repositoryRoot, "release/verify-release.sh"), "--artifact", artifact]);
  report.steps.push({ name: "verify-release.sh", ok: true });

  // Set when the two builds disagree, so the `finally` below keeps the evidence
  // instead of deleting it.
  let keepDeterminismTrees = false;

  if (options.determinism) {
    // Two builds of the same input, in two different directories, must produce the
    // same bytes. This is the stage's whole reproducibility claim, and it is checked
    // by building rather than by asserting.
    process.stdout.write("\n=== determinism: two builds in two directories ===\n");
    const scratch = mkdtempSync(path.join(os.tmpdir(), "infra-cod-determinism-"));
    try {
      const first = build({ out: path.join(scratch, "a"), work: path.join(scratch, "work-a"), extra: skipBuild });
      const second = build({ out: path.join(scratch, "b"), work: path.join(scratch, "work-b"), extra: skipBuild });
      // Each build publishes into its own `version + platform` directory, so the
      // digest is taken from where the artifact actually is. The first version of
      // this check looked for the tarball at the artifacts root and reported
      // "sha256sum failed" after a build that had succeeded.
      const firstArtifact = path.join(scratch, "a", first.artifacts.releaseDirectory, first.artifacts.tarball);
      const secondArtifact = path.join(scratch, "b", second.artifacts.releaseDirectory, second.artifacts.tarball);
      for (const file of [firstArtifact, secondArtifact]) {
        if (!existsSync(file)) throw new Error(`the build reported an artifact that does not exist: ${file}`);
      }
      const firstHash = sha256(firstArtifact);
      const secondHash = sha256(secondArtifact);
      if (firstHash !== secondHash) {
        // Report *which* files differ, not just the two digests. "The hashes are
        // different" is the start of an investigation, and a check that discards the
        // trees before anyone can look at them wastes a full build to say only that.
        // The release directory only holds the tarball, its checksum and the summary,
        // and the tarball is what differs — so comparing those three files says only
        // "the archives differ". Both archives are extracted and compared member by
        // member, which names the file inside the payload that actually varies.
        const differences = [
          ...compareReleaseTrees(
            path.join(scratch, "a", first.artifacts.releaseDirectory),
            path.join(scratch, "b", second.artifacts.releaseDirectory),
          ),
          ...compareArchives(firstArtifact, secondArtifact, scratch),
        ];
        keepDeterminismTrees = true;
        throw new Error(
          `two builds of one commit produced different artifacts:\n  ${firstArtifact} ${firstHash}\n  ${secondArtifact} ${secondHash}\n`
            + `  ${differences.length} differing file(s) between the two release directories:\n`
            + differences.slice(0, 25).map((entry) => `    ${entry}`).join("\n")
            + "\n  Fix the source of the difference, or change the contract explicitly and say so.",
        );
      }
      process.stdout.write(`both builds produced ${firstHash}\n`);
      report.determinism = { identical: true, sha256: firstHash, bytes: first.artifacts.tarballBytes };
    } finally {
      // Retain the trees only when the caller asked for them. The earlier version
      // assigned the keep-flag on *success*, so every passing run left two full
      // release trees behind, and a mismatch — the one case where the trees are the
      // evidence — threw before the assignment and had them deleted. Clean up on
      // success; keep them on mismatch (set before the throw) or on request.
      if (options.keepDeterminismTrees || keepDeterminismTrees) {
        process.stdout.write(`the two trees were kept at ${scratch} for inspection\n`);
      } else {
        rmSync(scratch, { recursive: true, force: true });
      }
    }
  }

  if (options.json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`\ncheck:release passed: ${report.artifact.name} (${report.artifact.sha256})\n`);
}

try {
  main();
} catch (error) {
  process.stderr.write(`check:release failed: ${error.message}\n`);
  process.exitCode = 1;
}
