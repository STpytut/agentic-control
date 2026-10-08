// A snapshot of a workspace's last commit, for an analyst to read (0147).
//
// An analyst reads while the coder may be writing, so it is never given the
// live workspace: it is given the files of HEAD, written fresh into a scratch
// directory. Not `git archive | tar -x` as the analyst's user: a tree can hold
// a symlink and then a file "through" it, and the runtime's user owns its own
// login. Not `git worktree add`: that writes into the repository the writer
// holds. Instead the blobs are read in one `git cat-file --batch`, as the
// workspace's owner (`runGit`, like workspace-sync.mjs), and written here as
// regular files only — no symlink, no submodule, no path that is not plainly
// inside the directory. The caller hands the directory to the analyst's user.
//
// `runGit(args, { input })` resolves to { code, stdout: Buffer, stderr }.

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseTree } from "./repository-map.mjs";

const SHA = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
export const SNAPSHOT_LIMITS = Object.freeze({ fileBytes: 2 * 1024 * 1024, totalBytes: 192 * 1024 * 1024, files: 50_000 });

// A path the snapshot may write: relative, plain segments, nothing of git's.
export function safeSnapshotPath(file) {
  if (typeof file !== "string" || !file || file.length > 4096 || file.includes("\0") || file.startsWith("/")) return false;
  return file.split("/").every((part) => part && part !== "." && part !== ".." && part.toLowerCase() !== ".git");
}

// `git cat-file --batch` output: "<oid> blob <size>\n<content>\n" per object.
export function parseBatch(buffer) {
  const objects = new Map();
  let offset = 0;
  while (offset < buffer.length) {
    const lineEnd = buffer.indexOf(0x0a, offset);
    if (lineEnd < 0) break;
    const [oid, type, size] = buffer.subarray(offset, lineEnd).toString("utf8").split(" ");
    if (type === "missing" || !size) { offset = lineEnd + 1; continue; }
    const start = lineEnd + 1;
    const end = start + Number(size);
    objects.set(oid, buffer.subarray(start, end));
    offset = end + 1;
  }
  return objects;
}

export async function buildSnapshot({ runGit, directory, limits = SNAPSHOT_LIMITS }) {
  const git = (args, options) => runGit(["-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", ...args], options);
  const headAnswer = await git(["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]);
  const head = headAnswer.code === 0 ? String(headAnswer.stdout).trim() : "";
  if (!SHA.test(head)) return { head: null, files: 0, skipped: [] };
  const listed = await git(["ls-tree", "-r", "-l", "-z", "--full-tree", head]);
  if (listed.code !== 0) throw new Error(`listing ${head}: ${String(listed.stderr).slice(0, 200)}`);

  const skipped = [];
  const chosen = [];
  let total = 0;
  for (const file of parseTree(listed.stdout)) {
    if (file.mode === "120000") { skipped.push({ path: file.path, why: "symlink" }); continue; }
    if (!safeSnapshotPath(file.path)) { skipped.push({ path: file.path, why: "path" }); continue; }
    if (file.size > limits.fileBytes) { skipped.push({ path: file.path, why: "size" }); continue; }
    if (chosen.length >= limits.files || total + file.size > limits.totalBytes) { skipped.push({ path: file.path, why: "budget" }); continue; }
    total += file.size;
    chosen.push(file);
  }
  const unique = [...new Set(chosen.map((file) => file.oid))];
  const batch = unique.length
    // Up to the total budget in one read: more time than a single git call gets.
    ? await git(["cat-file", "--batch"], { input: `${unique.join("\n")}\n`, timeout: 10 * 60_000 })
    : { code: 0, stdout: Buffer.alloc(0) };
  if (batch.code !== 0) throw new Error(`reading ${head}'s files: ${String(batch.stderr).slice(0, 200)}`);
  const objects = parseBatch(Buffer.isBuffer(batch.stdout) ? batch.stdout : Buffer.from(batch.stdout));

  const root = path.resolve(directory);
  let written = 0;
  for (const file of chosen) {
    const content = objects.get(file.oid);
    if (!content) { skipped.push({ path: file.path, why: "missing" }); continue; }
    const target = path.resolve(root, file.path);
    if (!target.startsWith(`${root}${path.sep}`)) { skipped.push({ path: file.path, why: "path" }); continue; }
    await mkdir(path.dirname(target), { recursive: true, mode: 0o755 });
    // `wx`: the directory is new and only this writes into it, so a file that
    // is already there is a path written twice — refused, not followed.
    await writeFile(target, content, { flag: "wx", mode: file.mode === "100755" ? 0o755 : 0o644 });
    written += 1;
  }
  return { head, files: written, skipped };
}
