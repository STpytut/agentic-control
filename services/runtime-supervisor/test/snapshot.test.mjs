// A snapshot of HEAD for an analyst (snapshot.mjs), against real repositories.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildSnapshot, parseBatch, safeSnapshotPath } from "../snapshot.mjs";

const ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t", GIT_CONFIG_NOSYSTEM: "1" };
const git = (cwd, ...args) => {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", env: ENV });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
};
const runGitIn = (cwd) => async (args, { input } = {}) => {
  const r = spawnSync("git", args, { cwd, env: ENV, input });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr.toString() };
};

test("a snapshot is HEAD's regular files, never the working tree, a symlink or an oversized file", async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "snap-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const repo = path.join(dir, "repo");
  mkdirSync(path.join(repo, "src"), { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  writeFileSync(path.join(repo, "src/app.js"), "export const x = 1;\n");
  writeFileSync(path.join(repo, "run.sh"), "#!/bin/sh\n", { mode: 0o755 });
  writeFileSync(path.join(repo, "big.bin"), Buffer.alloc(3 * 1024 * 1024, 1));
  symlinkSync("/etc/passwd", path.join(repo, "link"));
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "first");
  writeFileSync(path.join(repo, "src/app.js"), "uncommitted\n");

  const out = path.join(dir, "snapshot");
  mkdirSync(out);
  const result = await buildSnapshot({ runGit: runGitIn(repo), directory: out });
  assert.equal(result.head, git(repo, "rev-parse", "HEAD"));
  assert.equal(result.files, 2);
  assert.equal(readFileSync(path.join(out, "src/app.js"), "utf8"), "export const x = 1;\n");
  assert.equal(lstatSync(path.join(out, "run.sh")).mode & 0o777, 0o755);
  assert.ok(!existsSync(path.join(out, "link")), "a symlink is not written");
  assert.ok(!existsSync(path.join(out, "big.bin")), "a file over the limit is not written");
  assert.ok(!existsSync(path.join(out, ".git")));
  assert.deepEqual(result.skipped.map((entry) => `${entry.path}:${entry.why}`).sort(), ["big.bin:size", "link:symlink"]);
});

test("an empty repository has no snapshot", async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "snap-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  git(dir, "init", "-q", "-b", "main");
  assert.deepEqual(await buildSnapshot({ runGit: runGitIn(dir), directory: dir }), { head: null, files: 0, skipped: [] });
});

test("only plain relative paths are written", () => {
  for (const bad of ["", "/etc/x", "../x", "a/../b", "a//b", "./a", ".git/config", "a/.GIT/b", "a\0b"]) {
    assert.equal(safeSnapshotPath(bad), false, bad);
  }
  for (const good of ["a", "src/app.js", ".github/workflows/ci.yml", "a b/c.md"]) assert.equal(safeSnapshotPath(good), true, good);
});

test("the batch output is split into objects by their sizes", () => {
  const body = Buffer.from("aaa 1 blob 3\nab\n\nbbb blob 0\n\nccc missing\n");
  const objects = parseBatch(Buffer.from(body.toString().replace("aaa 1 blob 3", "aaa blob 3")));
  assert.equal(objects.get("aaa").toString(), "ab\n");
  assert.equal(objects.get("bbb").length, 0);
  assert.equal(objects.has("ccc"), false);
});
