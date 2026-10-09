// A pull request's review (rc.145, 0153): Codex's answer read into findings,
// the review run's argv, the broker's fetch and post, and the worker's outcome.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { parseReview, reviewComment } from "../../runtime-supervisor/pr-review-findings.mjs";
import { driverFor, surfaceOf } from "../../runtime-supervisor/drivers/index.mjs";
import { githubReviewRequest, githubWorkspaceAction, isReviewAction } from "../../runtime-supervisor/github-workspace-protocol.mjs";
import { GithubAppError } from "../github-app-client.mjs";
import { reviewOutcome } from "../pr-review-worker.mjs";

const { processPrReviewFetch, processPrReviewPublish } = await import("../github-app-worker.mjs");

// As Codex 0.160 answered on the host, in the scratch repository it read.
const ROOT = "/srv/infra-cod/gate-workspaces/review-1/repo";
const ANSWER = `The loop now adds an out-of-bounds array element, causing ordinary non-empty inputs to produce \`NaN\`.

Review comment:

- [P1] Stop before the array's length — ${ROOT}/avg.js:3-3
  When \`xs\` is a normal array, the \`<=\` condition includes \`i === xs.length\`, where \`xs[i]\` is \`undefined\`.
  Use a strict \`<\` bound.
- [P2] Name the empty case — ${ROOT}/src/stats/mean.js:10-14
  An empty array divides by zero.`;

test("Codex's review is read into findings, its paths made relative to the repository it read", () => {
  const { review, findings } = parseReview(ANSWER, { root: ROOT });
  assert.equal(findings.length, 2);
  assert.deepEqual({ ...findings[0], body: undefined }, { priority: "P1", title: "Stop before the array's length", file: "avg.js", line: 3, end_line: 3, body: undefined });
  assert.match(findings[0].body, /^When `xs` is a normal array.*Use a strict `<` bound\.$/);
  assert.deepEqual([findings[1].file, findings[1].line, findings[1].end_line], ["src/stats/mean.js", 10, 14]);
  assert.doesNotMatch(review, /srv\/infra-cod/, "the scratch path never reaches the chat");
  assert.match(review, /— avg\.js:3-3/);
  const prose = parseReview("No issues found: the change is a rename.", { root: ROOT });
  assert.deepEqual(prose.findings, []);
  assert.equal(prose.review, "No issues found: the change is a rename.");
});

test("a review posted on GitHub says whose it is and which commit it read", () => {
  const body = reviewComment({ review: "Looks fine.", model: "gpt-6-luna", headSha: "0123456789abcdef0123456789abcdef01234567" });
  assert.match(body, /^Looks fine\.\n\n<sub>Review by Codex \(gpt-6-luna\) through Agentic Control, at 0123456789ab\. Posted by the project's owner\.<\/sub>$/);
  assert.doesNotMatch(reviewComment({ review: "x", headSha: "not a sha" }), /at not/);
});

test("the review run is Codex's review mode against the base, read-only, without the pull request's AGENTS.md", () => {
  const codex = driverFor("codex");
  assert.deepEqual(surfaceOf(codex, "review"), { transport: "batch", workspace: "review", capability: "run.read_only" });
  const argv = codex.run.argv({ surface: "review", model: "gpt-6-luna", baseBranch: "main", version: "0.160.0" });
  assert.deepEqual(argv.slice(argv.indexOf("exec")), ["exec", "review", "--json", "-m", "gpt-6-luna", "--base", "main"]);
  const config = argv.filter((_, index) => argv[index - 1] === "-c");
  assert.ok(config.includes('default_permissions="infra_cod_read_only"'), "the read-only profile, the login denied");
  assert.ok(config.includes("project_doc_max_bytes=0"), "the pull request's own instructions are not read");
  assert.ok(config.includes("features.multi_agent=false"));
  for (const bad of ["", "--output=x", "a..b", "x:refs/heads/y", "-main", "has space"]) {
    assert.throws(() => codex.run.argv({ surface: "review", model: "m", baseBranch: bad, version: "0.160.0" }), /names the branch/, bad);
  }
  assert.ok(isReviewAction(githubWorkspaceAction("prepare_pr_review")));
  assert.deepEqual(githubReviewRequest("release_pr_review", "r1"), { type: "release_pr_review", review_id: "r1" });
  assert.throws(() => githubReviewRequest("prepare_workspace_sync", "r1"));
});

test("the worker's outcome: a review with its findings, or why there is none", () => {
  assert.deepEqual(reviewOutcome({ exit_code: 0, review: "ok", findings: [{ title: "t" }] }, "m"),
    { status: "reviewed", review: "ok", findings: [{ title: "t" }], model: "m" });
  assert.match(reviewOutcome({ exit_code: 0, review: "  " }, "m").failure, /^Codex gave no review$/);
  assert.match(reviewOutcome({ exit_code: 1, review: "", failure: "Codex rate limited: try later" }, "m").failure, /rate limited/);
});

// The broker against a real repository standing in for GitHub: its pull
// request ref and its base branch, bundled for the review.
function remoteWithPullRequest(dir) {
  const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8",
    env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t", GIT_CONFIG_NOSYSTEM: "1" } }).trim();
  const work = path.join(dir, "work");
  mkdirSync(work);
  git(work, "init", "-q", "-b", "main");
  writeFileSync(path.join(work, "a.js"), "export const a = 1;\n");
  git(work, "add", "."); git(work, "commit", "-q", "-m", "base");
  const base = git(work, "rev-parse", "HEAD");
  git(work, "checkout", "-q", "-b", "feature");
  writeFileSync(path.join(work, "a.js"), "export const a = 2;\n");
  git(work, "commit", "-q", "-am", "change");
  const head = git(work, "rev-parse", "HEAD");
  const remote = path.join(dir, "remote.git");
  git(dir, "init", "-q", "--bare", remote);
  git(work, "push", "-q", remote, "main", "feature:refs/pull/7/head");
  return { remote, base, head, git };
}

test("the broker bundles the pull request's head and base into the review's inbox, and says which commits", async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "pr-review-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const { remote, base, head, git } = remoteWithPullRequest(dir);
  const inbox = path.join(dir, "inbox");
  mkdirSync(inbox);
  const recorded = [];
  const supervisor = { connect: async () => {}, close: () => {}, preparePrReview: async () => ({ inbox }), releasePrReview: async () => ({}) };
  const result = await processPrReviewFetch({ review_id: "r1", pr_number: 7, repository_full_name: "o/r", repository_url: "x",
    installation_id: "1", github_repository_id: 2 }, {
    worker: "broker", mintToken: async () => "ghs_token", revokeToken: async () => {}, supervisor, remoteUrlFor: () => remote,
    readPullRequest: async () => ({ number: 7, url: "https://github.com/o/r/pull/7", state: "open", title: "Change a", base_ref: "main" }),
    db: async (sql, vars) => { recorded.push(JSON.parse(vars.result)); return {}; },
  });
  assert.equal(result.status, "fetched");
  assert.deepEqual(recorded[0], { status: "fetched", title: "Change a", pr_url: "https://github.com/o/r/pull/7", base_ref: "main", base_sha: base, head_sha: head });
  const heads = git(dir, "bundle", "list-heads", path.join(inbox, "review.bundle"));
  assert.match(heads, new RegExp(`${head} refs/heads/infra-review-head`));
  assert.match(heads, new RegExp(`${base} refs/heads/infra-review-base`));
});

test("a closed, missing or oddly based pull request fails the review with the reason, and nothing is fetched", async () => {
  const cases = [
    [async () => ({ state: "closed", base_ref: "main" }), /#7 is closed; only an open one is reviewed/],
    [async () => { throw new GithubAppError("not_found", "no", 404); }, /#7 was not found in o\/r/],
    [async () => ({ state: "open", base_ref: "main:refs/heads/x" }), /base branch .* name the platform does not handle/],
  ];
  for (const [readPullRequest, reason] of cases) {
    const recorded = [];
    let prepared = false;
    await processPrReviewFetch({ review_id: "r1", pr_number: 7, repository_full_name: "o/r", repository_url: "x", installation_id: "1", github_repository_id: 2 }, {
      mintToken: async () => "tok", revokeToken: async () => {}, remoteUrlFor: () => "https://github.com/o/r.git", readPullRequest,
      supervisor: { connect: async () => {}, close: () => {}, preparePrReview: async () => { prepared = true; return { inbox: "/x" }; } },
      db: async (sql, vars) => { recorded.push(JSON.parse(vars.result)); return {}; },
    });
    assert.equal(recorded[0].status, "failed");
    assert.match(recorded[0].failure, reason);
    assert.equal(prepared, false);
  }
});

test("a review is posted as one comment on its pull request, and a refusal is recorded with what to do", async () => {
  const posted = [];
  const recorded = [];
  const item = { review_id: "r1", pr_number: 7, review: "Looks fine.", model: "m", head_sha: "a".repeat(40),
    repository_full_name: "o/r", installation_id: "1", github_repository_id: 2 };
  await processPrReviewPublish(item, {
    mintToken: async () => "tok", revoke: async () => {},
    comment: async (args) => { posted.push(args); return { id: 1, url: "https://github.com/o/r/pull/7#issuecomment-1" }; },
    db: async (sql, vars) => { recorded.push(vars); return {}; },
  });
  assert.equal(posted[0].number, 7);
  assert.match(posted[0].body, /^Looks fine\.\n\n<sub>Review by Codex/);
  assert.deepEqual(recorded[0], { id: "r1", url: "https://github.com/o/r/pull/7#issuecomment-1", error: "" });
  await processPrReviewPublish(item, {
    mintToken: async () => { throw new GithubAppError("forbidden", "no", 403); }, revoke: async () => {},
    db: async (sql, vars) => { recorded.push(vars); return {}; },
  });
  assert.match(recorded[1].error, /needs Pull requests: write/);
});
