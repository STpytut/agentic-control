// The repository map against real repositories (repository-map.mjs).
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildRepositoryMap, excerpt, languageSummary, parseTree, renderTree, summarizePackageJson } from "../repository-map.mjs";

const ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t", GIT_CONFIG_NOSYSTEM: "1" };
const git = (cwd, ...args) => {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", env: ENV });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
};
const runGitIn = (cwd) => async (args) => {
  const r = spawnSync("git", args, { cwd, env: ENV });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr.toString() };
};
const write = (root, file, content) => {
  mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  writeFileSync(path.join(root, file), content);
};

function repository(files) {
  const dir = mkdtempSync(path.join(tmpdir(), "repo-map-"));
  git(dir, "init", "-q", "-b", "main");
  for (const [file, content] of Object.entries(files)) write(dir, file, content);
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "first");
  return dir;
}

test("a repository's map names its commit, layout, languages, manifests, README and history", async (t) => {
  const dir = repository({
    "package.json": JSON.stringify({ name: "focus-timer", description: "A timer", type: "module",
      scripts: { dev: "vite", test: "vitest run" }, dependencies: { react: "^19" }, devDependencies: { vitest: "^3" } }),
    "README.md": "\n\n# Focus Timer\n\nA pomodoro timer.\n",
    "AGENTS.md": "Use pnpm.\n",
    "src/App.tsx": "export default 1;\n",
    "src/timer/clock.ts": "export const x = 1;\n",
    "src/timer/clock.test.ts": "test;\n",
    "apps/web/package.json": JSON.stringify({ name: "web", scripts: { build: "next build" }, dependencies: { next: "1" } }),
    "node_modules/left-pad/index.js": "module.exports = 1;\n",
    ".env.example": "SECRET=\n",
  });
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  write(dir, "src/uncommitted.ts", "not in HEAD\n");
  git(dir, "commit", "-q", "--allow-empty", "-m", "Add the pause button");

  const map = await buildRepositoryMap({ runGit: runGitIn(dir) });
  assert.equal(map.head_sha, git(dir, "rev-parse", "HEAD"));
  assert.equal(map.branch, "main");
  assert.equal(map.files_total, 9);
  assert.deepEqual(map.languages.slice(0, 2), [{ name: "TypeScript", files: 3 }, { name: "JSON", files: 2 }]);
  assert.match(map.tree, /^src\/ \(3 files\)$/m);
  assert.match(map.tree, /^  timer\/ \(2 files\)$/m);
  assert.match(map.tree, /^node_modules\/ \(1 file, not listed\)$/m);
  assert.doesNotMatch(map.tree, /left-pad/);
  assert.doesNotMatch(map.tree, /uncommitted/, "the map is the commit, not the working tree");
  assert.match(map.tree, /^apps\/web\/ \(1 file\)$/m, "a directory holding only a directory reads as one path");
  assert.equal(map.tree_truncated, false);
  const root = map.manifests.find((entry) => entry.path === "package.json");
  assert.match(root.summary, /name: focus-timer/);
  assert.match(root.summary, /test: vitest run/);
  assert.match(root.summary, /dependencies: react/);
  assert.match(root.summary, /devDependencies: vitest/);
  const nested = map.manifests.find((entry) => entry.path === "apps/web/package.json");
  assert.match(nested.summary, /build: next build/);
  assert.doesNotMatch(nested.summary, /dependencies/, "a nested package says how it runs, not what it is built on");
  assert.equal(map.readme.path, "README.md");
  assert.equal(map.readme.excerpt, "# Focus Timer\n\nA pomodoro timer.");
  assert.deepEqual(map.instructions, ["AGENTS.md"]);
  assert.deepEqual(map.commits.map((commit) => commit.subject), ["Add the pause button", "first"]);
  assert.ok(map.manifests.every((entry) => !entry.path.includes(".env")));
});

test("a repository with no commit has no map", async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "repo-map-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  git(dir, "init", "-q", "-b", "main");
  assert.equal(await buildRepositoryMap({ runGit: runGitIn(dir) }), null);
});

test("names cannot break a line, binary and oversized files are not read, and a hook never runs", async (t) => {
  const dir = repository({
    "weird\nname.txt": "x\n",
    "README.md": Buffer.concat([Buffer.from("# a\n"), Buffer.alloc(4), Buffer.from("b\n")]),
    "package.json": `{"name":"x","scripts":{"a":"${"y".repeat(300 * 1024)}"}}`,
  });
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  git(dir, "config", "core.fsmonitor", "touch fsmonitor-ran");
  const map = await buildRepositoryMap({ runGit: runGitIn(dir) });
  assert.ok(map.tree.split("\n").every((line) => !line.startsWith("name.txt")));
  assert.match(map.tree, /weird\?name\.txt/);
  assert.equal(map.readme, null, "a binary README is not quoted");
  assert.deepEqual(map.manifests, [], "a manifest over the read limit is skipped");
  assert.equal(spawnSync("test", ["-e", path.join(dir, "fsmonitor-ran")]).status, 1);
});

test("a large tree is rendered as deep as the budget allows", () => {
  const paths = [];
  for (let a = 0; a < 30; a += 1) for (let b = 0; b < 30; b += 1) paths.push(`pkg${a}/mod${b}/file.ts`);
  const { tree, depth, truncated } = renderTree(paths);
  assert.equal(truncated, true, "directories left unexpanded are said to be");
  assert.ok(tree.split("\n").length <= 140);
  assert.ok(tree.length <= 6000);
  assert.equal(depth, 0);
  assert.match(tree, /^pkg0\/ \(30 files\)$/m);
});

test("file names in a directory are listed on one line, the rest counted", () => {
  const { tree } = renderTree(Array.from({ length: 14 }, (_, index) => `f${String(index).padStart(2, "0")}.js`));
  assert.equal(tree, "f00.js, f01.js, f02.js, f03.js, f04.js, f05.js, f06.js, f07.js, f08.js, f09.js, … (+4)");
});

test("parsing ls-tree keeps blobs, with their sizes", () => {
  const out = ["100644 blob aaa      12\tsrc/a.ts", "160000 commit bbb       -\tlib/sub", "100644 blob ccc 3\tb c.md", ""].join("\u0000");
  assert.deepEqual(parseTree(out), [
    { mode: "100644", oid: "aaa", size: 12, path: "src/a.ts" },
    { mode: "100644", oid: "ccc", size: 3, path: "b c.md" },
  ]);
  assert.deepEqual(languageSummary(parseTree(out)), [{ name: "Markdown", files: 1 }, { name: "TypeScript", files: 1 }]);
});

test("package.json summaries survive what a repository may hold", () => {
  assert.equal(summarizePackageJson("{"), "not valid JSON");
  assert.equal(summarizePackageJson("[]"), "not a JSON object");
  assert.equal(summarizePackageJson("{}"), "(empty)");
  assert.match(summarizePackageJson(JSON.stringify({ scripts: { "a\nb": "c\nd" } })), /a\?b: c\?d/);
});

test("an excerpt ends on a whole line", () => {
  assert.equal(excerpt("one\ntwo\nthree\n", 100), "one\ntwo\nthree");
  assert.equal(excerpt("line one here\nline two here\n", 20), "line one here\n…");
});

test("a cut inside an emoji leaves no half character", () => {
  const cutReadme = excerpt(`${"a".repeat(19)}\u{1F600}rest`, 20);
  assert.ok(cutReadme.isWellFormed());
  assert.ok(summarizePackageJson(JSON.stringify({ description: `${"d".repeat(199)}\u{1F600}` })).isWellFormed());
});
