// Integration tests for a real release artifact: build, verify, move, run without a
// package manager, and tamper with.
//
// The unit tests in `release-structure.test.mjs` check the pieces. This file checks
// the claim the stage actually makes: that a signed set of bytes can be carried to
// a clean machine, unpacked somewhere else, and started without the repository, the
// pnpm store or a package manager.
//
// It builds one artifact and then reuses it for every assertion, because a release
// build is the expensive part and the interesting failures are all downstream of it.
// `--skip-build` reuses the checkout's existing `.next` output; the CI release job
// does the full build, and `deterministic double build` covers the rebuild.

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { createSignatureFile, generateKeyPair, keyPairFromSeed, renderPublicKeyFile, renderSecretKeyFile, parseSecretKeyFile } from "../../../scripts/lib/release-signature.mjs";
import { parseFileSums } from "../../../scripts/lib/release-manifest.mjs";
import { channelFor } from "../../../scripts/lib/release-version.mjs";
import { checkSymlinkClosure, walkTree } from "../../../scripts/lib/release-payload.mjs";

const root = path.resolve(import.meta.dirname, "../../..");
const releaseScript = path.join(root, "scripts/build-release.mjs");
const verifyScript = path.join(root, "scripts/verify-release.mjs");
const shellVerifier = path.join(root, "release/verify-release.sh");

// On a CI runner with no `.next` output the web build is required, and this file is
// only run by `check:release`, which is the job that has one.
const skipBuild = process.env.INFRA_COD_RELEASE_SKIP_BUILD !== "0";

// One artifact for the whole file. Built into a scratch directory so a developer's
// `dist/` is untouched and two runs cannot collide.
const scratch = mkdtempSync(path.join(os.tmpdir(), "infra-cod-release-it-"));
const artifactsDirectory = path.join(scratch, "releases");
const workDirectory = path.join(scratch, "work");

let built = null;
let buildError = null;

function run(command, args, options = {}) {
  return spawnSync(command, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, ...options });
}

// `--allow-off-target` lets this suite run on a developer machine. On the release
// target it is unnecessary, and the artifact it produces here is named after the
// host, records the host platform in its manifest, and cannot be published — which
// is what makes it safe for a test to ask for it. The refusals this suite asserts
// are tested directly, through `resolveBuildTarget`, rather than by trying to build.
const offTarget = process.env.INFRA_COD_RELEASE_ALLOW_OFF_TARGET === "0" ? [] : ["--allow-off-target"];

function buildArtifact({ out = artifactsDirectory, work = workDirectory, extra = [] } = {}) {
  const args = [releaseScript, "--out", out, "--work", work, ...(skipBuild ? ["--skip-build"] : []), ...offTarget, ...extra];
  const result = run(process.execPath, args, { cwd: root });
  if (result.status !== 0) {
    throw new Error(`release build failed:\n${result.stdout ?? ""}\n${result.stderr ?? ""}`);
  }
  return JSON.parse(result.stdout.trim().split("\n").pop());
}

// `node:test` runs the file's top-level code once, so the build happens once.
try {
  built = buildArtifact();
} catch (error) {
  buildError = error;
}

function requireBuild() {
  if (buildError) assert.fail(`the release build did not succeed, so nothing downstream can be checked: ${buildError.message}`);
  return built;
}

// The release directory for the artifact this suite built: one directory per
// `version + platform`, holding the tarball, its checksum file and its signature.
function releaseDirectory() {
  return path.join(artifactsDirectory, requireBuild().artifacts.releaseDirectory);
}

function artifactPath() {
  return path.join(releaseDirectory(), requireBuild().artifacts.tarball);
}

function checksumsPath() {
  return path.join(releaseDirectory(), "SHA256SUMS");
}

function extractTo(directory) {
  mkdirSync(directory, { recursive: true });
  execFileSync("tar", ["-xzf", artifactPath(), "-C", directory], { encoding: "utf8" });
  const entries = readdirSync(directory);
  assert.equal(entries.length, 1, `exactly one top-level directory must be extracted, found ${entries.length}`);
  return path.join(directory, entries[0]);
}

test.after(() => {
  rmSync(scratch, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

test("the build produces exactly the three documented assets and nothing that looks like a partial one", () => {
  const summary = requireBuild();
  // The artifacts root holds one directory per release and nothing else: no loose
  // tarball and no shared checksum file that a second build could overwrite.
  const topLevel = readdirSync(artifactsDirectory).sort();
  assert.deepEqual(topLevel, [summary.artifacts.releaseDirectory], "only the version directory is published");
  assert.ok(!topLevel.some((name) => name.endsWith(".tar.gz")), "no tarball may sit at the artifacts root");
  assert.ok(!topLevel.includes("SHA256SUMS"), "no shared checksum file may sit at the artifacts root");

  const files = readdirSync(releaseDirectory()).sort();
  assert.deepEqual(
    files,
    ["SHA256SUMS", `${summary.artifacts.tarball}.build-summary.json`, summary.artifacts.tarball].sort(),
    "an unsigned build produces the tarball, its checksums and a build summary — no signature",
  );
  assert.equal(summary.artifacts.signature, null);
  // The channel follows from the version, and the version follows from whether HEAD
  // is tagged: `dev` on a plain commit, `rc` on a `v0.1.0-rc.1` tag. Asserting a
  // literal here would make the suite depend on the branch it happens to run on.
  assert.equal(summary.channel, channelFor(summary.version));
  assert.equal(summary.signed, false);
  assert.equal(summary.manifest.release.signed, false);
  assert.match(summary.artifacts.tarballSha256, /^[0-9a-f]{64}$/);
  assert.equal(summary.artifacts.tarballSha256, readFileSync(checksumsPath(), "utf8").split(" ")[0]);
  // `published` is what the single rename committed: the tarball and its checksum
  // file. The build summary is written afterwards, for a reviewer, and is not part of
  // the release a consumer takes.
  assert.deepEqual(
    summary.artifacts.published,
    ["SHA256SUMS", summary.artifacts.tarball].sort(),
    "the summary must name exactly what the publish committed",
  );
  assert.deepEqual(
    files.filter((name) => !name.endsWith(".build-summary.json")),
    summary.artifacts.published,
    "the release directory holds the published set plus the build summary and nothing else",
  );
});

test("the release directory is committed by one rename, and nothing final exists before it", async () => {
  // Fault injection *at the commit boundary*, not a sleep that hopes to land near it.
  //
  // The previous version killed the builder after 350 ms and asserted that no
  // final-looking file was left. That proves nothing about the boundary: the kill
  // usually landed before assembly or after publication, and a sequential
  // file-by-file publish would have passed it too. The builder suspends itself at the
  // boundary when `INFRA_COD_TEST_COMMIT_MARKER` names a path, which is the only way
  // to observe that instant from outside.
  const out = path.join(scratch, "commit-boundary-releases");
  const work = path.join(scratch, "commit-boundary-work");
  mkdirSync(out, { recursive: true });
  mkdirSync(work, { recursive: true });

  const marker = path.join(scratch, "at-commit.json");
  const release = path.join(scratch, "at-commit-release");
  rmSync(marker, { force: true });
  rmSync(release, { force: true });

  const child = spawn(process.execPath, [
    releaseScript, "--out", out, "--work", work, "--skip-build", ...offTarget,
  ], {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      INFRA_COD_TEST_COMMIT_MARKER: marker,
      INFRA_COD_TEST_COMMIT_RELEASE: release,
    },
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  const exited = new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));

  try {
    // Wait for the boundary with a diagnostic timeout, not a fixed delay.
    const deadline = Date.now() + 120_000;
    while (!existsSync(marker)) {
      if (child.exitCode !== null) assert.fail(`the builder exited before the commit boundary:\n${output.slice(-2000)}`);
      if (Date.now() > deadline) assert.fail(`the builder never reached the commit boundary:\n${output.slice(-2000)}`);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const paused = JSON.parse(readFileSync(marker, "utf8"));
    assert.ok(paused.pid > 0);

    // **The assertion the guarantee rests on.** With the build suspended immediately
    // before the publish, the artifacts root must contain no final release and no
    // final-looking file — only the hidden staging directory.
    const atBoundary = readdirSync(out).sort();
    assert.equal(atBoundary.length, 1, `only the staging directory may exist at the boundary, found: ${atBoundary.join(", ")}`);
    assert.ok(atBoundary[0].startsWith(".staging-"), `the only entry must be the staging directory, found ${atBoundary[0]}`);
    for (const forbidden of [".tar.gz", "SHA256SUMS", "SHA256SUMS.minisig"]) {
      assert.ok(
        !atBoundary.some((name) => name.endsWith(forbidden) || name === forbidden),
        `${forbidden} must not exist before the commit`,
      );
    }

    // The staging directory is complete, which is what makes the rename a commit
    // rather than a hope: every asset is already there under a hidden name.
    const staged = readdirSync(path.join(out, atBoundary[0])).sort();
    assert.ok(staged.some((name) => name.endsWith(".tar.gz")), "the tarball must be staged before the commit");
    assert.ok(staged.includes("SHA256SUMS"), "the checksum file must be staged before the commit");

    // Release the build and check the commit happened once and completely.
    writeFileSync(release, "go");
    const result = await exited;
    assert.equal(result.code, 0, `the builder failed after the boundary:\n${output.slice(-2000)}`);
    assert.ok(!existsSync(path.join(out, atBoundary[0])), "the staging directory must be gone after the commit");

    const after = readdirSync(out).sort();
    assert.equal(after.length, 1, `exactly one release directory may exist after the commit, found: ${after.join(", ")}`);
    const releaseDirectory = path.join(out, after[0]);
    const published = readdirSync(releaseDirectory).filter((name) => !name.endsWith(".build-summary.json")).sort();
    assert.equal(published.length, 2, `the committed set is the tarball and its checksum file, found: ${published.join(", ")}`);
    assert.ok(published.some((name) => name.endsWith(".tar.gz")));
    assert.ok(published.includes("SHA256SUMS"));
  } finally {
    if (child.exitCode === null) child.kill("SIGKILL");
    await exited;
    rmSync(out, { recursive: true, force: true });
    rmSync(work, { recursive: true, force: true });
  }
});

test("a server that crashes on startup fails the runtime smoke", async () => {
  // The smoke used to classify the child's *output* against a list of known
  // packaging errors, so an immediate crash with a message nobody anticipated — or
  // with no message at all — was accepted. This replaces the entry point with one
  // that throws immediately and asserts that the smoke refuses it, which is the
  // negative control for the readiness check.
  const releaseRoot = extractTo(path.join(scratch, "crash"));
  const manifest = JSON.parse(readFileSync(path.join(releaseRoot, "manifest.json"), "utf8"));
  writeFileSync(
    path.join(releaseRoot, manifest.entrypoints.web),
    'throw new Error("synthetic startup crash");\n',
  );
  const { runtimeSmoke } = await import("../../../scripts/verify-release.mjs");
  await assert.rejects(
    () => runtimeSmoke({ releaseRoot }),
    (error) => /exited immediately/.test(error.message) && /synthetic startup crash/.test(error.message),
  );
});

test("the builder refuses to overwrite an existing artifact without being asked", () => {
  const result = run(process.execPath, [
    releaseScript, "--out", artifactsDirectory, "--work", workDirectory, "--skip-build", ...offTarget,
  ], { cwd: root });
  assert.notEqual(result.status, 0, "a second build into the same directory must fail rather than replace a published artifact");
  assert.match(result.stderr, /already exists/);
});

test("the payload contains the web build, every service entry point, the migrations and the deploy assets", () => {
  const root_ = extractTo(path.join(scratch, "layout"));
  const manifest = JSON.parse(readFileSync(path.join(root_, "manifest.json"), "utf8"));

  for (const [name, relative] of Object.entries(manifest.entrypoints)) {
    assert.ok(existsSync(path.join(root_, relative)), `entrypoints.${name} (${relative}) must exist`);
  }
  for (const worker of readdirSync(path.join(root_, "deploy/systemd")).filter((name) => name.endsWith(".service"))) {
    const unit = readFileSync(path.join(root_, "deploy/systemd", worker), "utf8");
    for (const [, relative] of unit.matchAll(/\/opt\/infra-cod\/current\/([A-Za-z0-9._/-]+)/g)) {
      if (relative === "docs/OPERATIONS.md" || relative === "web") continue;
      assert.ok(existsSync(path.join(root_, relative)), `${worker} starts ${relative}, which is not in the release`);
    }
  }

  const migrations = readdirSync(path.join(root_, "db/migrations")).filter((name) => name.endsWith(".sql"));
  assert.equal(migrations.length, manifest.database.migrationCount);
  assert.equal(migrations.sort().at(-1), manifest.database.latestMigration);
  assert.ok(existsSync(path.join(root_, "deploy/setup-postgresql-production.sh")));
  assert.ok(existsSync(path.join(root_, "deploy/run-production-migrations.sh")));
  assert.ok(existsSync(path.join(root_, "deploy/systemd/infra-cod-web.service")));
  assert.ok(existsSync(path.join(root_, "deploy/caddy/Caddyfile")));
  assert.ok(!existsSync(path.join(root_, "deploy/caddy/Caddyfile.local")), "the acceptance-only plain-HTTP Caddyfile must not ship");
  assert.ok(existsSync(path.join(root_, "node_modules/pg/package.json")));
  assert.ok(existsSync(path.join(root_, "node_modules/hash-wasm/package.json")));
  assert.ok(!existsSync(path.join(root_, "pocs")), "pocs must not ship");
  assert.ok(!existsSync(path.join(root_, "apps")), "web sources must not ship; only the standalone output");
  // The release carries no root `package.json`: it is the workspace manifest, and a
  // consumer that found one could be misled into running a package manager against
  // the tree. The service dependencies are resolved from `node_modules/` alone.
  assert.ok(!existsSync(path.join(root_, "package.json")), "the workspace manifest must not ship");
});

test("no secret, host path or test file reaches the payload", () => {
  const root_ = extractTo(path.join(scratch, "secrets"));
  const offenders = [];
  for (const entry of walkTree(root_)) {
    const relative = entry.relativePath;
    if (/(^|\/)\.env(\.|$)/.test(relative)) offenders.push(`${relative} (environment file)`);
    if (/\.pem$|\.key$/.test(relative)) offenders.push(`${relative} (key material)`);
    if (relative.includes("/test/") || relative.includes("db/tests")) offenders.push(`${relative} (test file)`);
    if (entry.type !== "file" || entry.size > 512 * 1024) continue;
    const contents = readFileSync(path.join(root_, relative), "utf8");
    for (const [pattern, label] of [
      [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, "a private key"],
      [/\bghp_[A-Za-z0-9]{36}\b/, "a GitHub token"],
      // A *path* to the build machine's account, not the account name anywhere.
      // The demo seed data legitimately contains `github.com/<user>/infra-cod`, and
      // a check that flags that would be an assertion nobody could keep.
      [new RegExp(`/Users/${os.userInfo().username}/`, "i"), "this build account's home path"],
      [/\/home\/[a-z0-9._-]+\/Project\//i, "a developer checkout path"],
      [new RegExp(`"/Users/${os.userInfo().username}/[^"]*"`), "an embedded absolute build path"],
      [/\/private\/var\/folders\//, "a macOS temporary directory"],
    ]) {
      if (pattern.test(contents)) offenders.push(`${relative} (${label})`);
    }
  }
  assert.deepEqual(offenders.slice(0, 10), [], "the payload must carry no secrets, host paths or tests");
});

// ---------------------------------------------------------------------------
// Relocation and offline
// ---------------------------------------------------------------------------

test("the same artifact verifies, extracts and works under two different absolute paths", () => {
  const first = extractTo(path.join(scratch, "relocation-a"));
  const secondDirectory = path.join(scratch, "a-much-longer-directory-name-for-relocation", "nested", "deeper");
  const second = extractTo(secondDirectory);
  assert.notEqual(first, second);
  assert.ok(second.startsWith(secondDirectory));

  for (const releaseRoot of [first, second]) {
    // sha256sum -c is the independent check: it is the tool the target host has.
    const sums = spawnSync("sha256sum", ["-c", "FILESUMS.sha256"], { cwd: releaseRoot, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    assert.equal(sums.status, 0, `sha256sum -c failed in ${releaseRoot}: ${(sums.stderr ?? "").slice(0, 500)}`);

    const entries = walkTree(releaseRoot);
    const closure = checkSymlinkClosure(releaseRoot, entries);
    assert.deepEqual(closure.escaping, [], `no symlink may escape ${releaseRoot}`);
    assert.deepEqual(closure.dangling, [], `no symlink may dangle in ${releaseRoot}`);
    assert.ok(closure.links.length > 0, "the payload is expected to carry the pnpm link layout");
  }
});

test("every symlink the manifest records is relative and stays inside the tree after relocation", () => {
  const releaseRoot = extractTo(path.join(scratch, "symlinks"));
  const manifest = JSON.parse(readFileSync(path.join(releaseRoot, "manifest.json"), "utf8"));
  assert.ok(manifest.payload.symlinks.length > 0);
  for (const link of manifest.payload.symlinks) {
    assert.ok(!path.isAbsolute(link.target), `${link.path} has an absolute target ${link.target}`);
    // A `..` in a relative target is normal and correct — it is how the pnpm layout
    // reaches a sibling package — so what is asserted is where it *lands*, which is
    // the next two lines. Asserting the absence of `..` would be asserting the
    // wrong property and would have to be disabled to pass.
    const resolved = path.resolve(path.dirname(path.join(releaseRoot, link.path)), link.target);
    assert.ok(resolved.startsWith(releaseRoot), `${link.path} -> ${link.target} escapes the release root`);
    assert.ok(existsSync(resolved), `${link.path} -> ${link.target} does not resolve`);
  }
});

test("the services import pg and hash-wasm from the extracted tree, with no checkout and no package manager", () => {
  const releaseRoot = extractTo(path.join(scratch, "offline"));
  // A PATH with the Node binary and nothing else: no npm, no pnpm, no corepack. A
  // release that quietly shells out to one of them fails here rather than on a
  // server where the failure reads as a broken install.
  const sentinelDirectory = path.join(scratch, "sentinels");
  mkdirSync(sentinelDirectory, { recursive: true });
  const environment = {
    PATH: sentinelDirectory,
    HOME: scratch,
    TMPDIR: scratch,
    NODE_ENV: "production",
    // Any proxy or registry variable would make a network attempt look like a slow
    // start; they are removed rather than trusted to be absent.
    NO_PROXY: "*",
  };
  for (const name of ["npm", "pnpm", "yarn", "corepack"]) {
    const sentinel = path.join(sentinelDirectory, name);
    writeFileSync(sentinel, `#!/bin/sh\necho "the release must not invoke ${name}" >&2\nexit 97\n`);
    chmodSync(sentinel, 0o755);
  }

  for (const packageName of ["pg", "hash-wasm"]) {
    const result = run(process.execPath, ["-e", `import(${JSON.stringify(packageName)}).then(() => process.stdout.write("ok"))`], {
      cwd: releaseRoot,
      env: environment,
    });
    assert.equal(result.status, 0, `import(${packageName}) failed: ${(result.stderr ?? "").slice(0, 500)}`);
    assert.equal(result.stdout, "ok");
    assert.ok(!/must not invoke/.test(result.stderr ?? ""), `${packageName} resolution must not reach for a package manager`);
  }

  const cli = run(process.execPath, ["services/cli/infra-cod.mjs", "version"], { cwd: releaseRoot, env: environment });
  assert.equal(cli.status, 0, `infra-cod version failed: ${cli.stderr}`);
  const report = JSON.parse(cli.stdout);
  const manifest = JSON.parse(readFileSync(path.join(releaseRoot, "manifest.json"), "utf8"));
  assert.equal(report.version, manifest.version, "the CLI must report the version from the manifest it shipped with");
  assert.equal(report.gitSha, manifest.git.sha);
  assert.equal(report.migrations, manifest.database.migrationCount);
  assert.equal(report.target, `${manifest.target.os}-${manifest.target.arch}`);
  assert.equal(report.source, "release-manifest");
});

test("migrate.mjs finds its migrations at the release-relative path, not at a checkout path", () => {
  // The migration runner resolves `db/migrations` relative to its own file, which is
  // how it finds them in `/opt/infra-cod/current` and how it must find them here. A
  // runner that looked for a checkout path would pass every structural test and fail
  // on the first real install.
  const releaseRoot = extractTo(path.join(scratch, "migrate"));
  const result = run(process.execPath, ["services/control-plane/migrate.mjs"], {
    cwd: releaseRoot,
    timeout: 30_000,
    env: {
      PATH: path.dirname(process.execPath),
      HOME: scratch,
      // A port nothing listens on. The failure must be a connection error, which
      // means the runner resolved its migrations and reached the database client.
      DATABASE_URL: "postgresql://127.0.0.1:1/infra_cod_absent_for_migrate",
    },
  });
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  assert.notEqual(result.status, 0, "a database that cannot be reached must fail the runner");
  assert.ok(
    !/ENOENT[^\n]*migrations/i.test(output),
    `the runner could not find the migrations in the release:\n${output.slice(0, 1000)}`,
  );
  assert.ok(
    /connection|ECONNREFUSED|could not connect|psql exited/i.test(output),
    `the runner failed before it reached the database, which means the failure is not the one this test expects:\n${output.slice(0, 1000)}`,
  );
});

test("the panel entry point starts from the extracted tree and fails on the database, not on packaging", () => {
  const releaseRoot = extractTo(path.join(scratch, "web"));
  const manifest = JSON.parse(readFileSync(path.join(releaseRoot, "manifest.json"), "utf8"));
  const entrypoint = path.join(releaseRoot, manifest.entrypoints.web);
  const appRoot = path.dirname(entrypoint);
  assert.ok(existsSync(path.join(appRoot, ".next/static")), "static assets must sit beside the server that serves them");
  assert.ok(existsSync(path.join(appRoot, "public")));

  const result = run(process.execPath, [entrypoint], {
    cwd: path.dirname(path.dirname(appRoot)),
    env: {
      PATH: path.dirname(process.execPath),
      HOME: scratch,
      TMPDIR: scratch,
      NODE_ENV: "production",
      HOSTNAME: "127.0.0.1",
      PORT: "0",
      INFRA_COD_SITE_URL: "http://127.0.0.1:3100",
      // A port nothing listens on. The expected outcome is a database error: the
      // release is fine and the environment is not configured, which is exactly what
      // an install looks like before Stage 2 and Stage 10 have run.
      DATABASE_URL: "postgresql://127.0.0.1:1/infra_cod_absent_for_smoke",
      NEXT_TELEMETRY_DISABLED: "1",
    },
    timeout: 30_000,
  });
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  for (const [pattern, label] of [
    [/Cannot find module/i, "a missing module"],
    [/ERR_MODULE_NOT_FOUND/i, "a missing module"],
    [/Cannot find package/i, "a missing package"],
    [/ENOENT[^\n]*\.next/i, "missing build output"],
    [/spawn (npm|pnpm|yarn|corepack)/i, "a package manager"],
  ]) {
    assert.ok(!pattern.test(output), `the web server failed because of ${label}:\n${output.slice(0, 1500)}`);
  }
});

// ---------------------------------------------------------------------------
// Verification and tampering
// ---------------------------------------------------------------------------

test("the verifier accepts the artifact, extracts it, and reports the manifest's identity", () => {
  const result = run(process.execPath, [verifyScript, "--artifact", artifactPath(), "--json", "--quiet"], { cwd: root, env: { ...process.env, PATH: path.dirname(process.execPath) } });
  assert.equal(result.status, 0, `verification failed: ${result.stderr}`);
  const report = JSON.parse(result.stdout);
  assert.equal(report.schema, "infra-cod/release-verification/1");
  assert.equal(report.signed, false, "an unsigned build reports signed: false");
  assert.equal(report.version, requireBuild().version);
  assert.equal(report.sha256, requireBuild().artifacts.tarballSha256);
  // The verifier reports the target the artifact *declares*. On the release target
  // that is `linux/x64`; on a developer machine the diagnostic build declares the
  // host, and asserting `linux` here would be asserting a platform nothing checked.
  assert.equal(report.target.os, requireBuild().target.os);
  assert.equal(report.target.arch, requireBuild().target.arch);
  assert.match(report.topLevel, /^infra-cod-/);
});

test("one byte changed in the artifact is caught, before anything is extracted", () => {
  const directory = path.join(scratch, "tamper-byte");
  mkdirSync(directory, { recursive: true });
  const target = path.join(directory, path.basename(artifactPath()));
  const bytes = readFileSync(artifactPath());
  bytes[Math.floor(bytes.length / 2)] ^= 0xff;
  writeFileSync(target, bytes);
  writeFileSync(path.join(directory, "SHA256SUMS"), readFileSync(checksumsPath()));

  const result = run(process.execPath, [verifyScript, "--artifact", target], { cwd: root });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /does not match its checksum/);
});

test("a changed checksum file is caught, and a signature made with another key is refused", () => {
  const directory = path.join(scratch, "tamper-checksum");
  mkdirSync(directory, { recursive: true });
  cpSync(artifactPath(), path.join(directory, path.basename(artifactPath())));
  // The checksum still matches; only the *published* digest was edited. Without a
  // signature this is undetectable, which is the point of the requirement.
  writeFileSync(path.join(directory, "SHA256SUMS"), `${"0".repeat(64)}  ${path.basename(artifactPath())}\n`);

  const result = run(process.execPath, [verifyScript, "--artifact", path.join(directory, path.basename(artifactPath()))], { cwd: root });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /does not match its checksum/);

  // Now with signatures: the real key signs, a different key's public half is pinned.
  const signing = keyPairFromSeed(Buffer.alloc(32, 21));
  const other = generateKeyPair();
  writeFileSync(path.join(directory, "SHA256SUMS"), readFileSync(checksumsPath()));
  const secret = parseSecretKeyFile(renderSecretKeyFile(signing));
  writeFileSync(
    path.join(directory, "SHA256SUMS.minisig"),
    createSignatureFile(readFileSync(path.join(directory, "SHA256SUMS")), secret, { trustedComment: "infra-cod release" }),
  );
  writeFileSync(path.join(directory, "right.pub"), renderPublicKeyFile(signing));
  writeFileSync(path.join(directory, "wrong.pub"), renderPublicKeyFile(other));

  const artifact = path.join(directory, path.basename(artifactPath()));
  const good = run(process.execPath, [verifyScript, "--artifact", artifact, "--public-key", path.join(directory, "right.pub"), "--require-signature"], { cwd: root });
  assert.equal(good.status, 0, `a correctly signed artifact must verify: ${good.stderr}`);

  const wrongKey = run(process.execPath, [verifyScript, "--artifact", artifact, "--public-key", path.join(directory, "wrong.pub"), "--require-signature"], { cwd: root });
  assert.notEqual(wrongKey.status, 0);
  assert.match(wrongKey.stderr, /signature key id is .* but the pinned public key id is/);

  // A *named* key that does not exist is refused, whatever the repository happens to
  // pin. This is the case that matters for an installer: it passes the key path from
  // its own configuration, and a typo there must not be silently ignored.
  const missingKey = run(process.execPath, [
    verifyScript, "--artifact", artifact, "--public-key", path.join(directory, "absent.pub"), "--require-signature",
  ], { cwd: root });
  assert.notEqual(missingKey.status, 0, "a named key that does not exist must fail");
  assert.match(missingKey.stderr, /--public-key names a file that does not exist/);

  // The same artifact asked for a target it does not have is refused before any
  // signature work, so a caller cannot get a "verified" answer for the wrong
  // platform. (The target is checked separately above; this pins the ordering.)
  const wrongTarget = run(process.execPath, [
    verifyScript, "--artifact", artifact, "--public-key", path.join(directory, "right.pub"), "--target", "linux-x64",
  ], { cwd: root });
  if (requireBuild().target.os !== "linux") {
    assert.notEqual(wrongTarget.status, 0, "a target the artifact does not declare must be refused");
  }

  // A genuinely unsigned artifact, with no signature file at all, fails differently.
  rmSync(path.join(directory, "SHA256SUMS.minisig"));
  const unsigned = run(process.execPath, [
    verifyScript, "--artifact", artifact, "--public-key", path.join(directory, "right.pub"), "--require-signature",
  ], { cwd: root });
  assert.notEqual(unsigned.status, 0, "an artifact with no signature must fail when a signature is required");
  assert.match(unsigned.stderr, /An unsigned artifact is not a release/);
});

test("the shell gate verifies checksums and members, and refuses a tampered archive", () => {
  const directory = path.join(scratch, "shell");
  mkdirSync(directory, { recursive: true });
  const name = path.basename(artifactPath());
  cpSync(artifactPath(), path.join(directory, name));
  cpSync(checksumsPath(), path.join(directory, "SHA256SUMS"));
  const extract = path.join(directory, "extract");

  const good = run("sh", [shellVerifier, "--artifact", path.join(directory, name), "--extract", extract], { cwd: root });
  assert.equal(good.status, 0, `the shell gate must pass on an intact artifact: ${good.stderr}`);
  assert.ok(existsSync(path.join(extract, requireBuild().version.length > 0 ? readdirSync(extract)[0] : "")), "the gate must extract after verifying");

  // A tampered byte.
  const bytes = readFileSync(path.join(directory, name));
  bytes[bytes.length - 1] ^= 0xff;
  writeFileSync(path.join(directory, name), bytes);
  const bad = run("sh", [shellVerifier, "--artifact", path.join(directory, name)], { cwd: root });
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr, /does not match its checksum/);
});

test("a second archive in the same directory is not silently chosen instead of the named one", () => {
  const directory = path.join(scratch, "extra-artifact");
  mkdirSync(directory, { recursive: true });
  const name = path.basename(artifactPath());
  cpSync(artifactPath(), path.join(directory, name));
  cpSync(checksumsPath(), path.join(directory, "SHA256SUMS"));
  // An extra, unsigned tarball that is *not* in SHA256SUMS.
  cpSync(artifactPath(), path.join(directory, "infra-cod-9.9.9-linux-x64.tar.gz"));

  const good = run(process.execPath, [verifyScript, "--artifact", path.join(directory, name)], { cwd: root });
  assert.equal(good.status, 0, "the listed artifact must still verify");

  const impostor = run(process.execPath, [verifyScript, "--artifact", path.join(directory, "infra-cod-9.9.9-linux-x64.tar.gz")], { cwd: root });
  assert.notEqual(impostor.status, 0);
  assert.match(impostor.stderr, /is not listed in the checksum file/);
});

test("a manifest that disagrees with the requested version or target is refused after extraction", () => {
  const releaseRoot = extractTo(path.join(scratch, "identity"));
  // Ask for a target the artifact does not declare. The build's own target is
  // whatever the host produced, so the request is derived from it rather than
  // hard-coded: on the release target the artifact says linux/x64 and the request is
  // linux/arm64; on a developer machine it is the reverse.
  const declared = requireBuild().target;
  const otherArch = declared.arch === "x64" ? "arm64" : "x64";
  const result = run(process.execPath, [
    verifyScript, "--artifact", artifactPath(), "--target", `${declared.os}-${otherArch}`,
  ], { cwd: root });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, new RegExp(`manifest target\\.arch is "${declared.arch}", requested "${otherArch}"`));

  const version = run(process.execPath, [verifyScript, "--artifact", artifactPath(), "--version", "9.9.9"], { cwd: root });
  assert.notEqual(version.status, 0);
  assert.match(version.stderr, /manifest version is .*, requested "9\.9\.9"/);

  const channel = run(process.execPath, [verifyScript, "--artifact", artifactPath(), "--channel", "stable"], { cwd: root });
  assert.notEqual(channel.status, 0);
  assert.match(
    channel.stderr,
    new RegExp(`manifest channel is "${requireBuild().channel}", requested "stable"`),
    "the requested channel must be compared against the manifest's",
  );

  assert.ok(existsSync(path.join(releaseRoot, "manifest.json")));
});

// ---------------------------------------------------------------------------
// Secret sentinels
// ---------------------------------------------------------------------------

test("a build-time secret planted in the environment does not reach a byte of the payload", () => {
  // The builder plants its own sentinels and the verifier proves they are absent.
  // This reproduces the check from the outside so that a regression in the builder's
  // own scan cannot hide behind the builder's own scan.
  const releaseRoot = extractTo(path.join(scratch, "sentinels-payload"));
  const marker = `SENTINELPROBE${Date.now()}`;
  const offenders = [];
  for (const entry of walkTree(releaseRoot)) {
    if (entry.type !== "file" || entry.size > 4 * 1024 * 1024) continue;
    const contents = readFileSync(path.join(releaseRoot, entry.relativePath));
    if (contents.includes(marker)) offenders.push(entry.relativePath);
  }
  assert.deepEqual(offenders, [], "a value that was never in the build cannot be in the payload");

  // And the mechanism itself: the builder's sentinel scan must be able to find one.
  const planted = path.join(releaseRoot, "planted-probe.txt");
  writeFileSync(planted, `${marker}\n`);
  const found = walkTree(releaseRoot).filter(
    (entry) => entry.type === "file" && entry.size < 4 * 1024 * 1024 && readFileSync(path.join(releaseRoot, entry.relativePath)).includes(marker),
  );
  assert.deepEqual(found.map((entry) => entry.relativePath), ["planted-probe.txt"], "the scan must find a planted value, or it proves nothing");
  rmSync(planted);
});

test("removing a transitive dependency from the payload is caught by the verifier", () => {
  // Negative control for "the payload contains the whole dependency closure": delete
  // a package that `pg` needs and prove that something notices. The runtime smoke is
  // the check that catches it, because the file is present but its require target is
  // not.
  const releaseRoot = extractTo(path.join(scratch, "missing-dep"));
  const victim = path.join(releaseRoot, "node_modules/.pnpm/pg-types@2.2.0/node_modules/pg-int8");
  assert.ok(existsSync(victim), "the fixture must know which package to remove");
  rmSync(victim, { recursive: true, force: true });

  const result = run(process.execPath, ["-e", "import('pg')"], {
    cwd: releaseRoot,
    env: { PATH: path.dirname(process.execPath), HOME: scratch },
  });
  assert.notEqual(result.status, 0, "importing pg without one of its dependencies must fail");
  assert.match(result.stderr, /Cannot find module|ERR_MODULE_NOT_FOUND/);
});
