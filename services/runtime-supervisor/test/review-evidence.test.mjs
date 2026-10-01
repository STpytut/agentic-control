// The worktree digest is canonical, and each thing the plan says must
// contribute to it does (WP-7, ADR-0015): untracked files, deletions, mode
// bits, symlinks, binary files and submodules, in a defined order.
//
// Each case is a real repository and real git, because the algorithm is defined
// over what git reports, and a fixture of git's output would test the parser
// against the author's idea of git.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile, chmod, symlink, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  collectReviewEvidence,
  headCommit,
  observationOf,
  parseIndexEntries,
  runProcess,
  stashLeftovers,
  worktreeDigest,
  WORKTREE_ALGORITHM,
  EVIDENCE_LIMITS,
} from "../review-evidence.mjs";

const isolated = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid",
  GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid",
  GIT_AUTHOR_DATE: "2026-09-24T00:00:00Z", GIT_COMMITTER_DATE: "2026-09-24T00:00:00Z",
};

async function sh(cwd, ...args) {
  const result = await runProcess("git", ["-c", "protocol.file.allow=always", ...args], { cwd, env: isolated });
  if (result.code !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.toString("utf8").trim();
}

async function repository(t) {
  const root = await mkdtemp(path.join(tmpdir(), "evidence-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const work = path.join(root, "work");
  await mkdir(work);
  await sh(work, "init", "-q", "-b", "main");
  await writeFile(path.join(work, "a.txt"), "one\n");
  await writeFile(path.join(work, "b.txt"), "two\n");
  await writeFile(path.join(work, ".gitignore"), "ignored/\n");
  await sh(work, "add", "-A");
  await sh(work, "commit", "-q", "-m", "base");
  const base = await sh(work, "rev-parse", "HEAD");
  let counter = 0;
  const evidence = async (options = {}) => collectReviewEvidence({
    runGit: (args, { env, input } = {}) => runProcess("git", args, { cwd: work, env: { ...isolated, ...env }, input }),
    indexFile: path.join(root, `index-${counter += 1}`),
    base,
    ...options,
  });
  return { root, work, base, evidence };
}

test("the same tree gives the same four digests, and computing them changes nothing", async (t) => {
  const { work, evidence } = await repository(t);
  await writeFile(path.join(work, "a.txt"), "changed\n");
  const statusBefore = await sh(work, "status", "--porcelain");
  const first = await evidence();
  const second = await evidence();
  assert.deepEqual(observationOf(first), observationOf(second));
  assert.match(first.worktree_digest, /^sha256:[0-9a-f]{64}$/);
  assert.match(first.patch_digest, /^sha256:[0-9a-f]{64}$/);
  // The repository's own index is the runtime's, not ours.
  assert.equal(await sh(work, "status", "--porcelain"), statusBefore);
});

test("an untracked file contributes, and an ignored one does not", async (t) => {
  const { work, evidence } = await repository(t);
  const clean = await evidence();
  await mkdir(path.join(work, "ignored"));
  await writeFile(path.join(work, "ignored", "build.log"), "noise\n");
  assert.equal((await evidence()).worktree_digest, clean.worktree_digest, "an ignored file moved the digest");
  await writeFile(path.join(work, "new.txt"), "new\n");
  const untracked = await evidence();
  assert.notEqual(untracked.worktree_digest, clean.worktree_digest);
  assert.notEqual(untracked.patch_digest, clean.patch_digest);
  assert.deepEqual(untracked.changed_files.map((row) => [row.status, row.path]), [["A", "new.txt"]]);
});

test("a deletion contributes", async (t) => {
  const { work, evidence } = await repository(t);
  const clean = await evidence();
  await unlink(path.join(work, "b.txt"));
  const deleted = await evidence();
  assert.notEqual(deleted.worktree_digest, clean.worktree_digest);
  assert.deepEqual(deleted.changed_files.map((row) => [row.status, row.path]), [["D", "b.txt"]]);
});

test("the executable bit contributes, and nothing else about a file's mode is claimed", async (t) => {
  const { work, evidence } = await repository(t);
  const clean = await evidence();
  await chmod(path.join(work, "a.txt"), 0o755);
  const executable = await evidence();
  assert.notEqual(executable.worktree_digest, clean.worktree_digest);
  assert.match(executable.diff, /new mode 100755/);
  // Group and other bits are not content: git does not record them, and a push
  // does not carry them.
  await chmod(path.join(work, "a.txt"), 0o700);
  assert.equal((await evidence()).worktree_digest, executable.worktree_digest);
});

test("a symlink is its target, not what it points to", async (t) => {
  const { work, evidence } = await repository(t);
  await symlink("a.txt", path.join(work, "link"));
  const first = await evidence();
  assert.ok(first.changed_files.some((row) => row.path === "link"));
  // The target's content changes; the link does not.
  await sh(work, "add", "-A");
  await sh(work, "commit", "-q", "-m", "link");
  const committed = await evidence();
  await writeFile(path.join(work, "a.txt"), "different\n");
  const retargetedContent = await evidence();
  // a.txt moved, so the digest moves — but the link's own entry must not, which
  // is checked by replacing the link with a regular file holding the same text.
  assert.notEqual(retargetedContent.worktree_digest, committed.worktree_digest);
  await writeFile(path.join(work, "a.txt"), "one\n");
  await unlink(path.join(work, "link"));
  await writeFile(path.join(work, "link"), "a.txt");
  const regular = await evidence();
  assert.notEqual(regular.worktree_digest, committed.worktree_digest, "a file and a symlink with the same bytes collided");
  await unlink(path.join(work, "link"));
  await symlink("b.txt", path.join(work, "link"));
  assert.notEqual((await evidence()).worktree_digest, committed.worktree_digest, "a retargeted symlink did not move the digest");
});

test("a binary file contributes by its bytes, and its patch is complete", async (t) => {
  const { work, evidence } = await repository(t);
  await writeFile(path.join(work, "blob.bin"), Buffer.from([0, 1, 2, 255, 0, 10, 13]));
  const first = await evidence();
  assert.equal(first.diffstat.binary_files, 1);
  assert.match(first.diff, /GIT binary patch/);
  assert.equal(first.platform_verified_checks.find((c) => c.name === "patch_reproduces_worktree").status, "passed");
  await writeFile(path.join(work, "blob.bin"), Buffer.from([0, 1, 2, 255, 0, 10, 14]));
  assert.notEqual((await evidence()).worktree_digest, first.worktree_digest);
});

test("a submodule contributes its commit, and is marked when its own tree is dirty", async (t) => {
  const { root, work, evidence } = await repository(t);
  const upstream = path.join(root, "sub-upstream");
  await mkdir(upstream);
  await sh(upstream, "init", "-q", "-b", "main");
  await writeFile(path.join(upstream, "s.txt"), "s\n");
  await sh(upstream, "add", "-A");
  await sh(upstream, "commit", "-q", "-m", "s");
  await sh(work, "submodule", "add", "-q", upstream, "sub");
  await sh(work, "commit", "-q", "-m", "submodule");
  const committed = await evidence();
  const sub = path.join(work, "sub");
  await writeFile(path.join(sub, "s.txt"), "dirty\n");
  const dirty = await evidence();
  assert.notEqual(dirty.worktree_digest, committed.worktree_digest, "a dirty submodule did not move the digest");
  await sh(sub, "commit", "-q", "-am", "moved");
  const moved = await evidence();
  assert.notEqual(moved.worktree_digest, committed.worktree_digest);
  assert.notEqual(moved.worktree_digest, dirty.worktree_digest);
  assert.ok(moved.changed_files.some((row) => row.path === "sub"));
});

test("entries are ordered by path bytes, whatever order they arrive in", () => {
  const entry = (name) => ({ mode: "100644", oid: "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391", path: Buffer.from(name) });
  const forward = worktreeDigest({ objectFormat: "sha1", entries: [entry("B"), entry("a"), entry("a/b")] });
  const reversed = worktreeDigest({ objectFormat: "sha1", entries: [entry("a/b"), entry("a"), entry("B")] });
  assert.equal(forward, reversed);
  // And the algorithm is part of what is hashed: a v2 could never collide with v1.
  assert.equal(WORKTREE_ALGORITHM, "infra-cod-worktree-v1");
  assert.throws(() => parseIndexEntries(Buffer.from("100644 abc 1\tx\0")), /does not define/);
});

test("the head, the base and whether the tree is committed are separate facts", async (t) => {
  const { work, base, evidence } = await repository(t);
  await writeFile(path.join(work, "a.txt"), "committed change\n");
  await sh(work, "commit", "-q", "-am", "work");
  const head = await sh(work, "rev-parse", "HEAD");
  const committed = await evidence();
  assert.equal(committed.base_commit_sha, base);
  assert.equal(committed.head_commit_sha, head);
  assert.equal(committed.worktree_committed, true);
  await writeFile(path.join(work, "a.txt"), "and then more\n");
  const dirty = await evidence();
  assert.equal(dirty.head_commit_sha, head);
  assert.equal(dirty.worktree_committed, false);
  assert.equal(dirty.platform_verified_checks.find((c) => c.name === "worktree_committed").status, "failed");
});

test("a repository with no commit has a null base and head, and a patch against the empty tree", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "evidence-empty-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await sh(root, "init", "-q", "-b", "main");
  await writeFile(path.join(root, "AGENTS.md"), "# seeded\n");
  const result = await collectReviewEvidence({
    runGit: (args, { env, input } = {}) => runProcess("git", args, { cwd: root, env: { ...isolated, ...env }, input }),
    indexFile: path.join(root, ".git", "evidence-index"),
    base: null,
  });
  assert.equal(result.base_commit_sha, "0".repeat(40));
  assert.equal(result.head_commit_sha, "0".repeat(40));
  assert.deepEqual(result.changed_files.map((row) => row.path), ["AGENTS.md"]);
  assert.equal(result.platform_verified_checks.find((c) => c.name === "patch_reproduces_worktree").status, "passed");
});

test("a base that is not in the repository is refused, not diffed against something else", async (t) => {
  const { evidence } = await repository(t);
  await assert.rejects(evidence({ base: "1".repeat(40) }), /is not a commit in this repository/);
});

test("the diff is bounded and says so; the digests still cover all of it", async (t) => {
  const { work, evidence } = await repository(t);
  await writeFile(path.join(work, "big.txt"), "x".repeat(100) .concat("\n").repeat(2000));
  const bounded = await evidence({ limits: { diffBytes: 4096, files: 1 } });
  assert.equal(bounded.truncation.diff_truncated, true);
  assert.ok(bounded.diff.length <= 4096);
  assert.ok(bounded.diff.endsWith("\n"), "the bounded diff ends inside a line");
  assert.ok(bounded.truncation.patch_bytes > 4096);
  const full = await evidence();
  assert.equal(full.patch_digest, bounded.patch_digest, "the bound changed the digest");
  assert.ok(EVIDENCE_LIMITS.diffBytes >= 4096);
});

test("the start commit is HEAD, or the null id before the first commit", async (t) => {
  const { work, base } = await repository(t);
  const runGit = (args) => runProcess("git", args, { cwd: work, env: isolated });
  assert.equal(await headCommit(runGit), base);
  const empty = await mkdtemp(path.join(tmpdir(), "evidence-head-"));
  t.after(() => rm(empty, { recursive: true, force: true }));
  await sh(empty, "init", "-q");
  assert.equal(await headCommit((args) => runProcess("git", args, { cwd: empty, env: isolated })), "0".repeat(40));
});

// On the platform's own repository (2026-09-25) a task's evidence carried changes an earlier task
// had left uncommitted, among them one that broke a file. A task's first run
// sets them aside under a name — without an author in the environment, as on
// the host — and they come back from the stash intact.
test("what an earlier task left uncommitted is stashed under a name, and recoverable", async (t) => {
  const { work } = await repository(t);
  await writeFile(path.join(work, "a.txt"), "one, changed by an earlier task\n");
  await writeFile(path.join(work, "stray.txt"), "left behind\n");
  const bare = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };
  for (const name of ["GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL", "EMAIL"]) delete bare[name];
  const runGit = (args) => runProcess("git", args, { cwd: work, env: bare });

  const stashed = await stashLeftovers({ runGit, taskId: "task-1" });
  assert.deepEqual(stashed, { message: "infra-cod/leftover/task-1", entries: 2 });
  assert.equal(await sh(work, "status", "--porcelain", "--untracked-files=all"), "");
  assert.match(await sh(work, "stash", "list"), /infra-cod\/leftover\/task-1/);

  await sh(work, "stash", "pop", "-q");
  assert.equal(await readFileUtf8(path.join(work, "a.txt")), "one, changed by an earlier task\n");
  assert.equal(await readFileUtf8(path.join(work, "stray.txt")), "left behind\n");
});

test("a clean tree is left alone", async (t) => {
  const { work } = await repository(t);
  const runGit = (args) => runProcess("git", args, { cwd: work, env: isolated });
  assert.equal(await stashLeftovers({ runGit, taskId: "task-2" }), null);
  assert.equal(await sh(work, "stash", "list"), "");
});

async function readFileUtf8(file) {
  const { readFile } = await import("node:fs/promises");
  return readFile(file, "utf8");
}
