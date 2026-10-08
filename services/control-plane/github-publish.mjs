// The push of an approved commit (sprint B P1; ADR-0015 §6, B5).
//
// Runs in the GitHub broker, which alone holds the App's key and therefore the
// installation token. It never runs git in the project's workspace: the
// supervisor exports the approved commit's objects from there as the
// workspace's owner, and this pushes them from a scratch repository it makes
// for the one publish — whose config, hooks and filters are its own, so
// nothing a runtime wrote into the workspace runs here with the token in reach.
//
// What reaches git and what does not:
//   - the token only through a GIT_ASKPASS helper reading a 0600 file in the
//     scratch directory, removed with it; never in argv, a URL or the config;
//   - the commit by its id to `refs/heads/<branch>`, never a force push: a
//     branch holding commits the approved one does not contain is refused by
//     GitHub, and that refusal is the answer, with the ref named;
//   - no hooks, no credential helper, no system or global config, and https as
//     the only protocol (plain http only when a test says so).
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { redactSecrets } from "./github-app-client.mjs";

export class PublishError extends Error {
  constructor(reason, message) {
    super(message);
    this.name = "PublishError";
    this.reason = reason;
  }
}

function run(command, args, { cwd, env, input, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    const out = [];
    const err = [];
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stdout.on("data", (chunk) => { if (out.length < 256) out.push(chunk); });
    child.stderr.on("data", (chunk) => { if (err.length < 256) err.push(chunk); });
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8") });
    });
    child.stdin.on("error", () => {});
    child.stdin.end(input ?? Buffer.alloc(0));
  });
}

const REJECTED = /\[rejected\]|non-fast-forward|fetch first|\[remote rejected\]/;

// Pushes `sha` — whose objects are in the pack at `packPath` — to
// `refs/heads/<branch>` of `remoteUrl`. Resolves to the ref and the commit;
// rejects with a PublishError naming the reason from the vocabulary.
export async function pushApprovedCommit({
  packPath, sha, branch, remoteUrl, token, base = null,
  gitBin = "/usr/bin/git", tmpRoot = tmpdir(), timeoutMs = 180_000, allowHttp = false,
}) {
  if (!/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(String(sha))) throw new PublishError("publish_export_failed", "the commit id is malformed");
  if (!/^infra-cod\/[0-9a-f-]{36}$/.test(String(branch))) throw new PublishError("publish_push_failed", "the branch name is malformed");
  if (!token) throw new PublishError("publish_token_unavailable", "no installation token");
  const secrets = [token];
  const scratch = await mkdtemp(path.join(tmpRoot, "infra-cod-publish-"));
  const ref = `refs/heads/${branch}`;
  try {
    const tokenFile = path.join(scratch, "token");
    const askpass = path.join(scratch, "askpass.sh");
    await writeFile(tokenFile, token, { mode: 0o600 });
    await writeFile(askpass, `#!/bin/sh\ncase "$1" in\n  Username*) echo "x-access-token";;\n  Password*) cat "${tokenFile}";;\n  *) exit 1;;\nesac\n`, { mode: 0o700 });
    const repo = path.join(scratch, "repo.git");
    const env = {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: scratch,
      GIT_TERMINAL_PROMPT: "0",
      GIT_ASKPASS: askpass,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
    };
    const git = (args, options = {}) => run(gitBin, args, { cwd: scratch, env, timeoutMs, ...options });
    const hardened = [
      "-c", "core.hooksPath=/dev/null", "-c", "credential.helper=", "-c", "protocol.allow=never",
      "-c", "protocol.https.allow=always", ...(allowHttp ? ["-c", "protocol.http.allow=always"] : []),
    ];

    let result = await git(["init", "--bare", "--quiet", repo]);
    if (result.code !== 0) throw new PublishError("publish_export_failed", `git init: ${result.stderr.trim()}`);
    let pack;
    try { pack = await readFile(packPath); }
    catch (error) { throw new PublishError("publish_export_failed", `the exported pack cannot be read: ${error.code ?? error.message}`); }
    result = await git(["--git-dir", repo, "index-pack", "--stdin"], { input: pack });
    if (result.code !== 0) throw new PublishError("publish_export_failed", `the exported pack is not valid: ${result.stderr.trim().slice(0, 300)}`);
    result = await git(["--git-dir", repo, "cat-file", "-e", `${sha}^{commit}`]);
    if (result.code !== 0) throw new PublishError("publish_export_failed", `the exported pack does not hold commit ${sha}`);

    // An empty repository has no base to open a pull request against, and a
    // root commit shares no history with any branch it could get: the approved
    // commit becomes the base branch itself, which is how any first push to an
    // empty repository goes (battle test: the push made the only branch, GitHub
    // took it as the default, and the pull request was refused for its base).
    if (base) {
      if (!/^(?!.*\.\.)[A-Za-z0-9._][A-Za-z0-9._/-]{0,199}$/.test(String(base))) throw new PublishError("publish_push_failed", "the base branch name is malformed");
      const listed = await git([...hardened, "--git-dir", repo, "ls-remote", "--heads", remoteUrl]);
      if (listed.code !== 0) throw new PublishError("publish_push_failed", `git ls-remote failed: ${redactSecrets(listed.stderr, secrets).trim().slice(-300)}`);
      const heads = listed.stdout.split("\n").map((line) => line.split("\t")[1]).filter(Boolean);
      if (!heads.includes(`refs/heads/${base}`) && heads.every((head) => head.startsWith("refs/heads/infra-cod/"))) {
        const baseRef = `refs/heads/${base}`;
        result = await git([...hardened, "--git-dir", repo, "push", "--porcelain", "--no-verify", remoteUrl, `${sha}:${baseRef}`]);
        const said = redactSecrets(`${result.stdout}\n${result.stderr}`, secrets).trim();
        if (result.code !== 0) throw new PublishError("publish_push_failed", `git push to ${baseRef} failed: ${said.slice(-400)}`);
        return { ref: baseRef, sha, upToDate: /\[up to date\]/.test(said), initialisedBase: true };
      }
    }

    result = await git([...hardened, "--git-dir", repo, "push", "--porcelain", "--no-verify", remoteUrl, `${sha}:${ref}`]);
    const said = redactSecrets(`${result.stdout}\n${result.stderr}`, secrets).trim();
    if (result.code !== 0) {
      if (REJECTED.test(said)) {
        throw new PublishError("publish_push_rejected", `GitHub refused ${ref}: it holds commits ${sha.slice(0, 12)} does not contain`);
      }
      throw new PublishError("publish_push_failed", `git push to ${ref} failed: ${said.slice(-400)}`);
    }
    return { ref, sha, upToDate: /\[up to date\]/.test(said) };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

// The pull request's text: the task as the operator stated it, what the
// executor said it did, and the evidence the approval was bound to.
// The executor's `result_summary` is JSON: a sentence, or an object that
// carries one.
function summaryText(summary) {
  if (typeof summary === "string") return summary;
  if (summary && typeof summary === "object") {
    for (const key of ["summary", "text", "message"]) if (typeof summary[key] === "string") return summary[key];
    return JSON.stringify(summary);
  }
  return "";
}

// A pull request's title: what the work is, in the orchestrator's words when it
// delegated — its handoff's objective, first sentence, at most 72 characters on
// a word — and the task's own title otherwise. The task's title is the
// operator's first message cut short, and focus-timer#11 was titled "First ask
// the analyst (Code reader) to find where and how the session history…".
export function pullRequestTitle(intent, objective) {
  const sentence = String(objective ?? "").replace(/\s+/g, " ").trim().split(/(?<=[.!?])\s/)[0].replace(/[.!]$/, "");
  if (sentence.length >= 8) {
    if (sentence.length <= 72) return sentence;
    const cut = sentence.slice(0, 71);
    return `${cut.slice(0, cut.lastIndexOf(" ") > 40 ? cut.lastIndexOf(" ") : 71)}…`;
  }
  return String(intent.title ?? "").trim() || "Changes from infra-cod";
}

export function pullRequestBody(intent) {
  const criteria = Array.isArray(intent.acceptance_criteria) ? intent.acceptance_criteria : [];
  const summary = summaryText(intent.summary).trim();
  const lines = [
    String(intent.objective ?? "").trim(),
    "",
    ...(criteria.length ? ["**Acceptance criteria**", ...criteria.map((item) => `- ${typeof item === "string" ? item : JSON.stringify(item)}`), ""] : []),
    ...(summary ? ["**What was done**", summary, ""] : []),
    // A chat started from an issue (0132): merging closes it (0133).
    ...(Number.isInteger(intent.issue_number) && intent.issue_number > 0 ? [`Closes #${intent.issue_number}`, ""] : []),
    "---",
    `Published by Agentic Control after the owner's approval. Commit \`${intent.head_commit_sha}\`, review evidence \`${intent.evidence_digest}\`.`,
  ];
  return lines.join("\n").slice(0, 60_000);
}
