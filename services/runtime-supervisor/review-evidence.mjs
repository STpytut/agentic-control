// What a review is about, computed so that it can be recomputed (WP-7, ADR-0015).
//
// An approval used to record a summary and a task version, and nothing about the
// tree it approved. §3.5 approved a file that does not parse, said twice to pass
// its tests, and nothing could have shown later that the approved state and the
// published one were the same state. So the evidence names the tree by four
// digests — base commit, head commit, worktree, patch — and `prepare_publish`
// recomputes them from the workspace with this module and refuses a tree that
// has moved.
//
// The algorithm is canonical and versioned; ADR-0015 is its specification and
// this file is its implementation. Change either and the version string
// changes with it, or every stored digest silently stops meaning what it said.
//
// What this module does not do: run anything the project owns. The executor's
// "all tests pass" is carried as executor_reported_checks, labelled as the
// executor's claim. What the platform verifies itself is what it can verify
// without executing project code — that the patch applied to the base
// reproduces exactly the reviewed tree, and whether that tree is committed.
//
// git is the only process this runs, through `runGit`, which the caller binds
// to an account: the supervisor runs it as the account that owns the workspace
// at that moment, never as root, because a repository's own configuration can
// name programs for git to run (filters, fsmonitor) and those must not run with
// more privilege than the runtime that could have written them.

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";

export const WORKTREE_ALGORITHM = "infra-cod-worktree-v1";
export const PATCH_ALGORITHM = "infra-cod-patch-v1";

// What the review turn and the database carry. The digests cover the whole
// patch; only its text is bounded.
export const EVIDENCE_LIMITS = Object.freeze({ diffBytes: 64 * 1024, files: 500 });

// Configuration that would change the bytes of a patch or the set of files
// without changing the tree. Pinned on the command line so that a user's or a
// repository's preference cannot make two computations of one tree disagree.
// What cannot be pinned here — a clean filter or eol conversion named in the
// repository's own .gitattributes — changes the content git would commit, and
// the digest is deliberately of that content (ADR-0015, "What git decides").
const PINNED_CONFIG = [
  "-c", "core.fsmonitor=false",
  "-c", "core.untrackedCache=false",
  "-c", "core.quotePath=true",
  "-c", "core.autocrlf=false",
  "-c", "core.safecrlf=false",
  "-c", "diff.noprefix=false",
  "-c", "diff.mnemonicPrefix=false",
  "-c", "diff.relative=false",
  "-c", "diff.renames=false",
  "-c", "diff.suppressBlankEmpty=false",
  "-c", "color.ui=false",
];

const PATCH_OPTIONS = [
  "--binary", "--full-index", "--no-renames", "--no-ext-diff", "--no-textconv", "--no-color",
  "--src-prefix=a/", "--dst-prefix=b/", "--no-relative", "--unified=3", "--inter-hunk-context=0",
  "--diff-algorithm=myers", "--indent-heuristic", "--ignore-submodules=none", "--submodule=short",
  "-O/dev/null",
];

export function sha256(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

// ------------------------------------------------------------ the worktree

// `git ls-files -s -z`: `<mode> SP <oid> SP <stage> TAB <path> NUL`. The path
// stays bytes: a file name need not be UTF-8, and a digest over a lossy decoding
// of it would give two different trees one digest.
export function parseIndexEntries(buffer) {
  const entries = [];
  let start = 0;
  for (let index = 0; index < buffer.length; index += 1) {
    if (buffer[index] !== 0) continue;
    const record = buffer.subarray(start, index);
    start = index + 1;
    if (record.length === 0) continue;
    const tab = record.indexOf(0x09);
    if (tab < 0) throw new Error("git ls-files returned a record without a path");
    const [mode, oid, stage] = record.subarray(0, tab).toString("latin1").split(" ");
    if (!/^[0-7]{6}$/.test(mode) || !/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(oid) || stage !== "0") {
      throw new Error(`git ls-files returned an entry this algorithm does not define: ${mode} ${oid} ${stage}`);
    }
    entries.push({ mode, oid, path: Buffer.from(record.subarray(tab + 1)) });
  }
  return entries;
}

// `git status --porcelain=v2 -z`: the submodule field of an ordinary (`1`) or
// renamed (`2`) entry is `S<c><m><u>`. A submodule whose checked-out commit is
// recorded but whose own tree has modified (`m`) or untracked (`u`) content is
// dirty, and that content is not in the gitlink — so it is named separately.
export function dirtySubmodules(buffer) {
  const dirty = new Set();
  const records = buffer.toString("latin1").split("\0");
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    const kind = record[0];
    if (kind !== "1" && kind !== "2") continue;
    const fields = record.split(" ");
    const sub = fields[2] ?? "";
    // `1 XY sub mH mI mW hH hI path` — the path is everything after field 8, and
    // for `2` there is a score field before it and the original path follows as
    // its own record.
    const pathStart = kind === "1" ? 8 : 9;
    const pathBytes = Buffer.from(fields.slice(pathStart).join(" "), "latin1");
    if (kind === "2") index += 1;
    if (sub.startsWith("S") && (sub[2] === "M" || sub[3] === "U")) dirty.add(pathBytes.toString("latin1"));
  }
  return dirty;
}

// The canonical serialisation (ADR-0015):
//
//   "infra-cod-worktree-v1\n"
//   "object-format <sha1|sha256>\n"
//   then, for every entry in ascending byte order of its path:
//   <mode> SP <oid>[+dirty] SP <path bytes> NUL
//
// Every property the plan names contributes: an untracked file is an entry, a
// deleted one is an absent entry, the executable bit is the mode (100644 or
// 100755), a symlink is mode 120000 with the blob of its target, a binary file
// is a blob like any other, and a submodule is mode 160000 with its checked-out
// commit, marked dirty when its own tree has changes.
export function worktreeDigest({ objectFormat, entries, dirty = new Set() }) {
  const sorted = [...entries].sort((left, right) => Buffer.compare(left.path, right.path));
  const parts = [Buffer.from(`${WORKTREE_ALGORITHM}\nobject-format ${objectFormat}\n`)];
  for (const entry of sorted) {
    const marker = entry.mode === "160000" && dirty.has(entry.path.toString("latin1")) ? "+dirty" : "";
    parts.push(Buffer.from(`${entry.mode} ${entry.oid}${marker} `), entry.path, Buffer.from([0]));
  }
  return sha256(Buffer.concat(parts));
}

// ------------------------------------------------------------ the patch

// `--numstat -z`: `added TAB deleted TAB path NUL`, `-` for a binary file.
function parseNumstat(buffer) {
  const rows = [];
  for (const record of buffer.toString("utf8").split("\0")) {
    if (!record) continue;
    const [added, deleted, ...rest] = record.split("\t");
    const binary = added === "-" && deleted === "-";
    rows.push({ path: rest.join("\t"), added: binary ? null : Number(added), deleted: binary ? null : Number(deleted), binary });
  }
  return rows;
}

// `--name-status -z`: `status NUL path NUL`, renames off.
function parseNameStatus(buffer) {
  const records = buffer.toString("utf8").split("\0");
  const rows = [];
  for (let index = 0; index + 1 < records.length; index += 2) {
    if (!records[index]) break;
    rows.push({ status: records[index][0], path: records[index + 1] });
  }
  return rows;
}

// Cut at a line boundary, so the text the reviewer reads never ends inside a
// line and looks like a different change.
export function boundedText(buffer, limit) {
  if (buffer.length <= limit) return { text: buffer.toString("utf8"), truncated: false, bytes: buffer.length };
  let end = buffer.lastIndexOf(0x0a, limit - 1);
  if (end < 0) end = limit - 1;
  const kept = buffer.subarray(0, end + 1);
  return { text: kept.toString("utf8"), truncated: true, bytes: kept.length };
}

// ------------------------------------------------------------ collection

// One process, its output as bytes. Never rejects on a non-zero exit — git
// answers "no" with exit 1 in several of the calls above — and kills the child
// that outlives `timeout` or prints more than `maxBytes`, which then rejects:
// evidence that cannot be computed is a failure, not an empty answer.
export function runProcess(command, args, { cwd, env, input, timeout = 60_000, maxBytes = 256 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    const stdout = [];
    const stderr = [];
    let size = 0;
    let failure = null;
    const stop = (error) => { failure ??= error; child.kill("SIGKILL"); };
    const timer = setTimeout(() => stop(new Error(`${command} exceeded ${timeout} ms`)), timeout);
    child.stdout.on("data", (chunk) => {
      size += chunk.length;
      if (size > maxBytes) stop(new Error(`${command} printed more than ${maxBytes} bytes`));
      else stdout.push(chunk);
    });
    child.stderr.on("data", (chunk) => { if (stderr.length < 64) stderr.push(chunk); });
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (failure) return reject(failure);
      resolve({ code, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr).toString("utf8") });
    });
    child.stdin.on("error", () => {});
    child.stdin.end(input ?? Buffer.alloc(0));
  });
}

// `runGit(args, { env, input })` resolves to `{ code, stdout: Buffer, stderr }`
// and never rejects on a non-zero exit; the caller binds it to an account and a
// working directory. `indexFile` is a path in a directory the caller created for
// this computation and removes after it — never the repository's own index,
// which belongs to the runtime and is not ours to rewrite.
//
// `base` is the commit the review is relative to, or null when the task began
// in a repository with no commit, in which case the patch is against the empty
// tree and the stored base is the null object id.
export async function collectReviewEvidence({ runGit, indexFile, base = null, limits = EVIDENCE_LIMITS }) {
  const git = async (args, { env = {}, input, allow = [0] } = {}) => {
    const result = await runGit([...PINNED_CONFIG, ...args], { env, input });
    if (!allow.includes(result.code)) {
      const detail = String(result.stderr ?? "").trim().slice(0, 300);
      throw new Error(`git ${args[0]} failed (exit ${result.code})${detail ? `: ${detail}` : ""}`);
    }
    return result;
  };
  const text = async (args, options) => (await git(args, options)).stdout.toString("utf8").trim();
  const withIndex = { GIT_INDEX_FILE: indexFile };

  const objectFormat = await text(["rev-parse", "--show-object-format"]);
  if (objectFormat !== "sha1" && objectFormat !== "sha256") {
    throw new Error(`repository object format ${objectFormat} is not one this algorithm defines`);
  }
  const nullOid = "0".repeat(objectFormat === "sha1" ? 40 : 64);
  const headResult = await git(["rev-parse", "--verify", "-q", "HEAD^{commit}"], { allow: [0, 1] });
  const head = headResult.code === 0 ? headResult.stdout.toString("utf8").trim() : null;
  const emptyTree = await text(["hash-object", "-t", "tree", "--stdin"], { input: Buffer.alloc(0) });

  let baseRef = emptyTree;
  if (base && base !== nullOid) {
    const exists = await git(["cat-file", "-e", `${base}^{commit}`], { allow: [0, 1, 128] });
    if (exists.code !== 0) throw new Error(`review base ${base} is not a commit in this repository`);
    baseRef = base;
  }

  // The worktree as git would commit it, built in an index of our own: HEAD's
  // entries first, so a tracked file that happens to match .gitignore is kept,
  // then everything the worktree holds. An ignored untracked file is not part
  // of what would be published, and is not part of the digest.
  if (head) await git(["read-tree", head], { env: withIndex });
  await git(["add", "-A", "--", "."], { env: withIndex });
  const entries = parseIndexEntries((await git(["ls-files", "-s", "-z"], { env: withIndex })).stdout);
  const dirty = entries.some((entry) => entry.mode === "160000")
    ? dirtySubmodules((await git(
      ["status", "--porcelain=v2", "-z", "--ignore-submodules=none", "--untracked-files=no"],
      { env: withIndex },
    )).stdout)
    : new Set();
  const tree = await text(["write-tree"], { env: withIndex });
  const headTree = head ? await text(["rev-parse", `${head}^{tree}`]) : emptyTree;

  const patch = (await git(["diff", "--cached", ...PATCH_OPTIONS, baseRef], { env: withIndex })).stdout;
  const numstat = parseNumstat((await git(
    ["diff", "--cached", "--numstat", "-z", "--no-renames", "--ignore-submodules=none", baseRef],
    { env: withIndex },
  )).stdout);
  const nameStatus = parseNameStatus((await git(
    ["diff", "--cached", "--name-status", "-z", "--no-renames", "--ignore-submodules=none", baseRef],
    { env: withIndex },
  )).stdout);

  // What the platform checks itself. The patch applied to the base in a second
  // index of our own must give exactly the tree just digested: the diff the
  // reviewer reads is then the whole difference, not a rendering of part of it.
  const replayIndex = `${indexFile}.replay`;
  await git(["read-tree", baseRef], { env: { GIT_INDEX_FILE: replayIndex } });
  const applied = patch.length === 0
    ? { code: 0, stderr: "" }
    : await git(["apply", "--cached", "--binary", "--whitespace=nowarn", "-"],
      { env: { GIT_INDEX_FILE: replayIndex }, input: patch, allow: [0, 1, 128] });
  const replayed = applied.code === 0
    ? await text(["write-tree"], { env: { GIT_INDEX_FILE: replayIndex } })
    : null;
  const platformChecks = [
    {
      name: "patch_reproduces_worktree",
      status: replayed === tree ? "passed" : "failed",
      detail: replayed === tree
        ? "the patch applied to the base gives the reviewed tree"
        : `the patch applied to the base gives ${replayed ?? `nothing (git apply exit ${applied.code})`}, not ${tree}`,
    },
    {
      name: "worktree_committed",
      status: tree === headTree ? "passed" : "failed",
      detail: tree === headTree
        ? "the reviewed tree is the head commit's tree"
        : "the worktree has changes that are not in the head commit",
    },
  ];

  const diff = boundedText(patch, limits.diffBytes);
  const byPath = new Map(numstat.map((row) => [row.path, row]));
  const changed = nameStatus.map(({ status, path }) => {
    const stat = byPath.get(path);
    return { path, status, added: stat?.added ?? null, deleted: stat?.deleted ?? null, binary: stat?.binary ?? false };
  });
  const listed = changed.slice(0, limits.files);

  return {
    algorithm: { worktree: WORKTREE_ALGORITHM, patch: PATCH_ALGORITHM },
    object_format: objectFormat,
    base_commit_sha: baseRef === emptyTree ? nullOid : baseRef,
    head_commit_sha: head ?? nullOid,
    worktree_digest: worktreeDigest({ objectFormat, entries, dirty }),
    patch_digest: sha256(patch),
    worktree_tree: tree,
    worktree_committed: tree === headTree,
    changed_files: listed,
    diffstat: {
      files_changed: changed.length,
      insertions: changed.reduce((sum, row) => sum + (row.added ?? 0), 0),
      deletions: changed.reduce((sum, row) => sum + (row.deleted ?? 0), 0),
      binary_files: changed.filter((row) => row.binary).length,
    },
    diff: diff.text,
    truncation: {
      patch_bytes: patch.length,
      diff_bytes: diff.bytes,
      diff_truncated: diff.truncated,
      files_total: changed.length,
      files_listed: listed.length,
      files_truncated: listed.length < changed.length,
    },
    platform_verified_checks: platformChecks,
  };
}

// The commit a run starts from, or the null object id in a repository with no
// commit yet — a fresh project is `git init` and a seeded AGENTS.md.
export async function headCommit(runGit) {
  const format = await runGit(["rev-parse", "--show-object-format"]);
  if (format.code !== 0) throw new Error(`git rev-parse failed: ${String(format.stderr).trim().slice(0, 300)}`);
  const objectFormat = format.stdout.toString("utf8").trim();
  const head = await runGit(["rev-parse", "--verify", "-q", "HEAD^{commit}"]);
  if (head.code === 0) return head.stdout.toString("utf8").trim();
  if (head.code === 1) return "0".repeat(objectFormat === "sha256" ? 64 : 40);
  throw new Error(`git rev-parse HEAD failed: ${String(head.stderr).trim().slice(0, 300)}`);
}

// The four fields `prepare_publish` compares. Everything else in the evidence
// is for the reader.
export function observationOf(evidence) {
  return {
    base_commit_sha: evidence.base_commit_sha,
    head_commit_sha: evidence.head_commit_sha,
    worktree_digest: evidence.worktree_digest,
    patch_digest: evidence.patch_digest,
  };
}

// A task's first run starts on the tree it will be judged against. Changes left
// uncommitted by an earlier task — one approved only to close it, on
// the platform's own repository on 2026-09-25 — were carried into the next task's evidence and
// broke a file it never touched. They are set aside, not discarded: a named
// stash, recoverable with `git stash list`. Returns what was stashed, or null
// when the tree is clean or has no commit to stash against.
export async function stashLeftovers({ runGit, taskId }) {
  const git = (args) => runGit([...PINNED_CONFIG, "-c", "user.name=infra-cod", "-c", "user.email=infra-cod@localhost", ...args]);
  const head = await git(["rev-parse", "--verify", "-q", "HEAD^{commit}"]);
  if (head.code !== 0) return null;
  const status = await git(["status", "--porcelain=v1", "--untracked-files=all", "-z"]);
  if (status.code !== 0) throw new Error(`git status failed (exit ${status.code}): ${String(status.stderr).trim().slice(0, 300)}`);
  const paths = status.stdout.toString("utf8").split("\0").filter(Boolean);
  if (paths.length === 0) return null;
  const message = `infra-cod/leftover/${taskId}`;
  const stash = await git(["stash", "push", "--include-untracked", "-m", message]);
  if (stash.code !== 0) throw new Error(`git stash failed (exit ${stash.code}): ${String(stash.stderr).trim().slice(0, 300)}`);
  const after = await git(["status", "--porcelain=v1", "--untracked-files=all", "-z"]);
  if (after.stdout.length !== 0) throw new Error("the workspace is still not clean after stashing what an earlier task left");
  return { message, entries: paths.length };
}
