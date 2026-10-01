import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// The guards around the one destructive operation in the staging script.
//
// `rmSync(recursive: true)` on a path that came from `--out` or an environment
// variable has no undo, so the refusals are the part of the staging flow that
// most needs a test rather than a comment. Every case below operates on a real
// temporary directory: the point is what happens to the filesystem, not what a
// predicate returns.

const { assertStagingDirectory, canonicalPath, finalComponentIsSymlink, prepareStagingDirectory, STAGING_MARKER, protectedDirectories } =
  await import("../../../scripts/lib/staging-directory.mjs");

const root = path.resolve(import.meta.dirname, "../../..");
const appDirectory = path.join(root, "apps/web");
const context = { repositoryRoot: root, appDirectory };

const scratch = mkdtempSync(path.join(os.tmpdir(), "infra-cod-staging-test-"));
test.after(() => rmSync(scratch, { recursive: true, force: true }));

function lstatSyncSafe(target) {
  try {
    return lstatSync(target);
  } catch {
    return null;
  }
}

function fresh(name) {
  const directory = path.join(scratch, name);
  rmSync(directory, { recursive: true, force: true });
  return directory;
}

test("refuses a path that is, or contains, something that must not be deleted", () => {
  // Every one of these is a plausible typo or an unset variable, and each would
  // take a directory that matters.
  const refused = [
    "/",
    os.homedir(),
    root,
    appDirectory,
    path.join(appDirectory, ".next"),
    "/opt/infra-cod",
    "/opt/infra-cod/current",
    // An ancestor of a protected path is protected too: deleting /opt would take
    // /opt/infra-cod with it.
    "/opt",
  ];
  for (const target of refused) {
    // The property is that it is refused, not the sentence it is refused with.
    // On a host where these paths actually exist, `/opt/infra-cod/current` is a
    // symlink and the symlink guard speaks first — so a test that insisted on
    // one wording passed only where the protected path was absent, which is the
    // one place refusing it proves nothing.
    assert.throws(
      () => assertStagingDirectory(target, context),
      /refusing to (stage there|use it)/,
      `${target} was not refused`,
    );
  }
});

test("protects the installation root and the live release by name", () => {
  const guards = protectedDirectories(context);
  assert.ok(guards.has("/opt/infra-cod"));
  assert.ok(guards.has("/opt/infra-cod/current"));
  assert.ok(guards.has(root));
  assert.ok(guards.has(appDirectory));
});

test("an ordinary temporary directory is accepted and prepared", () => {
  const target = fresh("plain");
  const prepared = prepareStagingDirectory(target, context);
  // The canonical path, not the lexical one: on macOS the temporary directory is
  // reached through /tmp, which is itself a symlink to /private/tmp, and the guard
  // compares canonical paths on purpose.
  assert.equal(prepared, canonicalPath(target));
  assert.ok(existsSync(path.join(target, STAGING_MARKER)), "the marker was not written");
});

test("a directory this script created is replaced on a rerun", () => {
  const target = fresh("rerun");
  prepareStagingDirectory(target, context);
  writeFileSync(path.join(target, "leftover.txt"), "from the previous run\n");

  prepareStagingDirectory(target, context);
  // A stale file surviving would mean an older build's artifact could pass for
  // the current one, which is the reason the tree is rebuilt rather than reused.
  assert.ok(!existsSync(path.join(target, "leftover.txt")), "the previous run's file survived");
  assert.ok(existsSync(path.join(target, STAGING_MARKER)));
});

test("a non-empty directory without the marker is refused, and left untouched", () => {
  const target = fresh("precious");
  mkdirSync(target, { recursive: true });
  writeFileSync(path.join(target, "important.txt"), "do not delete\n");

  assert.throws(
    () => prepareStagingDirectory(target, context),
    /does not carry the .infra-cod-staging marker/,
  );
  assert.equal(readFileSync(path.join(target, "important.txt"), "utf8"), "do not delete\n");
});

test("an empty directory is accepted, so a first run can use an existing mount point", () => {
  const target = fresh("empty");
  mkdirSync(target, { recursive: true });
  assert.doesNotThrow(() => prepareStagingDirectory(target, context));
  assert.ok(existsSync(path.join(target, STAGING_MARKER)));
});

test("a symlink at the staging path is refused rather than followed", () => {
  const real = fresh("real");
  mkdirSync(real, { recursive: true });
  writeFileSync(path.join(real, "important.txt"), "do not delete\n");
  const link = fresh("link");
  symlinkSync(real, link);

  assert.ok(finalComponentIsSymlink(link), "the final component was not recognised as a symlink");
  assert.throws(() => prepareStagingDirectory(link, context), /is a symlink/);
  // The target must be intact: following the link is exactly the failure this
  // guard exists for.
  assert.equal(readFileSync(path.join(real, "important.txt"), "utf8"), "do not delete\n");
});

test("a symlink pointing into another directory is refused without creating anything", () => {
  // The reported defect. `canonicalPath` reports the real target, and the refusal
  // has to come from the original path, because a formula that tried to recover
  // the link's name from the resolved path produced `targets/requested-output` —
  // neither the link nor the target — and staging then created that directory.
  const targets = path.join(scratch, "targets");
  const actualTarget = path.join(targets, "actual-target");
  mkdirSync(actualTarget, { recursive: true });
  const links = path.join(scratch, "links");
  mkdirSync(links, { recursive: true });
  const requested = path.join(links, "requested-output");
  symlinkSync(actualTarget, requested);

  // `canonicalPath` answers "where does this go", and that is the real target.
  assert.equal(canonicalPath(requested), canonicalPath(actualTarget));
  assert.ok(finalComponentIsSymlink(requested));

  assert.throws(
    () => prepareStagingDirectory(requested, { repositoryRoot: scratch, appDirectory: scratch }),
    /is a symlink/,
  );

  // No third directory, nothing staged in the target, and the link still points
  // where it pointed.
  assert.ok(!existsSync(path.join(targets, "requested-output")), "a stray directory was created");
  assert.ok(!existsSync(path.join(actualTarget, STAGING_MARKER)), "the real target was staged into");
  const stillALink = lstatSyncSafe(requested);
  assert.ok(stillALink?.isSymbolicLink(), "the symlink was replaced");
});

test("a symlink in an ancestor component cannot smuggle a protected path past the guard", () => {
  // The reported bypass: `path.resolve` is lexical, so `alias/.next` looked like an
  // ordinary path even though `alias` pointed straight at the protected directory.
  // The write then landed inside the real `.next`, and the marker was created
  // there. The guarded comparison now happens on canonical paths, so the name the
  // path was reached by does not matter.
  const protectedDirectory = path.join(scratch, "guarded", "apps-web");
  mkdirSync(path.join(protectedDirectory, ".next"), { recursive: true });
  writeFileSync(path.join(protectedDirectory, ".next", "keep.txt"), "do not touch\n");

  const alias = path.join(scratch, "alias");
  symlinkSync(protectedDirectory, alias);

  assert.throws(
    () => prepareStagingDirectory(path.join(alias, ".next"), {
      repositoryRoot: path.join(scratch, "guarded"),
      appDirectory: protectedDirectory,
    }),
    /refusing to stage there/,
  );
  // Byte-for-byte untouched: no marker, and the file that was there is unchanged.
  assert.ok(!existsSync(path.join(protectedDirectory, ".next", STAGING_MARKER)), "the marker landed in the protected directory");
  assert.equal(readFileSync(path.join(protectedDirectory, ".next", "keep.txt"), "utf8"), "do not touch\n");
});

test("a symlink in an ancestor is also caught when the protected path is further down", () => {
  // The same trick aimed at the repository root rather than a direct child.
  const repository = path.join(scratch, "guarded", "repo");
  mkdirSync(path.join(repository, "apps", "web"), { recursive: true });
  const linkToRepo = path.join(scratch, "repo-alias");
  symlinkSync(repository, linkToRepo);

  assert.throws(
    () => prepareStagingDirectory(path.join(linkToRepo, "apps", "web"), {
      repositoryRoot: repository,
      appDirectory: path.join(repository, "apps", "web"),
    }),
    /refusing to stage there/,
  );
});

test("a path through a symlinked ancestor that leads somewhere safe is still allowed, but resolved", () => {
  // Canonicalising must not turn into refusing every symlink: an operator whose
  // scratch space is a symlinked mount still gets a working staging directory. The
  // symlink is an ancestor here, not the final component, so nothing is refused —
  // but the tree is created at the resolved location.
  const real = path.join(scratch, "scratch-real");
  mkdirSync(real, { recursive: true });
  const link = path.join(scratch, "scratch-link");
  symlinkSync(real, link);
  assert.ok(!finalComponentIsSymlink(path.join(link, "run")), "a missing final component is not a symlink");

  const prepared = prepareStagingDirectory(path.join(link, "run"), context);
  assert.equal(prepared, canonicalPath(path.join(link, "run")));
  assert.ok(prepared.startsWith(canonicalPath(real)), `staged outside the real scratch space: ${prepared}`);
  assert.ok(existsSync(path.join(prepared, STAGING_MARKER)));
});

test("a regular file at the staging path is refused", () => {
  const target = fresh("file");
  writeFileSync(target, "not a directory\n");
  assert.throws(() => prepareStagingDirectory(target, context), /is not a directory/);
  assert.ok(existsSync(target));
});
