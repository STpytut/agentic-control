// Workspace sync against real repositories: a "GitHub" repository, a
// workspace cloned from it, and the bundle the broker would hand over.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { applyWorkspaceSync } from "../workspace-sync.mjs";

const ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t", GIT_CONFIG_NOSYSTEM: "1" };
const git = (cwd, ...args) => {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", env: ENV });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
};
const commit = (cwd, file, content, message = `change ${file}`) => {
  writeFileSync(path.join(cwd, file), content);
  git(cwd, "add", file);
  git(cwd, "commit", "-q", "-m", message);
  return git(cwd, "rev-parse", "HEAD");
};
const runGitIn = (cwd) => async (args) => {
  const r = spawnSync("git", args, { cwd, env: ENV });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr.toString() };
};

function setup() {
  const dir = mkdtempSync(path.join(tmpdir(), "ws-sync-"));
  const github = path.join(dir, "github");
  const workspace = path.join(dir, "workspace");
  git(dir, "init", "-q", "-b", "main", github);
  commit(github, "README.md", "one\n");
  git(dir, "clone", "-q", github, workspace);
  const bundle = () => {
    const file = path.join(dir, `origin-${Math.random().toString(36).slice(2)}.bundle`);
    git(github, "bundle", "create", "-q", file, "refs/heads/main");
    return file;
  };
  const sync = (mode) => applyWorkspaceSync({ runGit: runGitIn(workspace), bundlePath: bundle(), baseBranch: "main", mode,
    now: new Date("2026-10-08T07:30:00Z") });
  return { dir, github, workspace, sync, done: () => rmSync(dir, { recursive: true, force: true }) };
}

test("up to date, then behind: fast-forwarded", async () => {
  const s = setup();
  try {
    assert.equal((await s.sync()).status, "synced");
    const upstream = commit(s.github, "b.txt", "b\n");
    const result = await s.sync();
    assert.equal(result.status, "synced");
    assert.match(result.outcome, /1 new commit/);
    assert.equal(git(s.workspace, "rev-parse", "HEAD"), upstream);
  } finally { s.done(); }
});

test("ahead (a pull request not merged): kept, nothing moved", async () => {
  const s = setup();
  try {
    const local = commit(s.workspace, "feature.txt", "f\n");
    const result = await s.sync();
    assert.equal(result.status, "kept");
    assert.match(result.outcome, /1 local commit is not on GitHub yet/);
    assert.equal(git(s.workspace, "rev-parse", "HEAD"), local);
  } finally { s.done(); }
});

test("a squash merge on GitHub (same tree, other history): reset to GitHub, no backup needed", async () => {
  const s = setup();
  try {
    commit(s.workspace, "a.txt", "a\n");
    commit(s.workspace, "b.txt", "b\n");
    writeFileSync(path.join(s.github, "a.txt"), "a\n");
    writeFileSync(path.join(s.github, "b.txt"), "b\n");
    git(s.github, "add", ".");
    git(s.github, "commit", "-q", "-m", "Squashed (#9)");
    const squashed = git(s.github, "rev-parse", "HEAD");
    const result = await s.sync();
    assert.equal(result.status, "synced");
    assert.match(result.outcome, /same tree/);
    assert.equal(result.backup_ref, null);
    assert.equal(git(s.workspace, "rev-parse", "HEAD"), squashed);
  } finally { s.done(); }
});

test("diverged: kept unless the owner asks; a reset keeps the local commits on a backup branch", async () => {
  const s = setup();
  try {
    const local = commit(s.workspace, "mine.txt", "mine\n");
    const theirs = commit(s.github, "theirs.txt", "theirs\n");
    const kept = await s.sync();
    assert.equal(kept.status, "kept");
    assert.match(kept.outcome, /diverged/);
    assert.equal(git(s.workspace, "rev-parse", "HEAD"), local);

    const reset = await s.sync("reset");
    assert.equal(reset.status, "synced");
    assert.equal(reset.backup_ref, "infra-cod/backup/2026-10-08-07-30-00");
    assert.equal(git(s.workspace, "rev-parse", "HEAD"), theirs);
    assert.equal(git(s.workspace, "rev-parse", reset.backup_ref), local, "the local commit is not on the backup branch");
  } finally { s.done(); }
});

test("uncommitted changes or another branch: left as it is", async () => {
  const s = setup();
  try {
    commit(s.github, "b.txt", "b\n");
    writeFileSync(path.join(s.workspace, "README.md"), "edited\n");
    assert.equal((await s.sync()).status, "kept");
    git(s.workspace, "checkout", "-q", "--", "README.md");
    git(s.workspace, "checkout", "-q", "-b", "side");
    const side = await s.sync();
    assert.equal(side.status, "kept");
    assert.match(side.outcome, /on side, not main/);
    assert.equal(existsSync(path.join(s.workspace, "b.txt")), false);
  } finally { s.done(); }
});
