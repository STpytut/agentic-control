import { test } from "node:test";
import assert from "node:assert/strict";
import { GithubAppError, listLabelledIssues, parseIssue } from "../github-app-client.mjs";

// GitHub issues as chats (0132, docs/ISSUE_INTAKE_DESIGN.md I1): what the
// worker reads and what it records.

const { processIssuePoll, ISSUES_PERMISSION_MESSAGE } = await import("../github-app-worker.mjs");

const ITEM = {
  project_id: "00000000-0000-4000-8000-000000000001", label: "agent",
  repository_full_name: "owner/repo", github_repository_id: 42, installation_id: "7",
};

test("an issue keeps what trust is decided on; a pull request is not an issue", () => {
  const issue = parseIssue({ number: 3, id: 30, html_url: "https://github.com/owner/repo/issues/3", title: "Fix it",
    body: "x".repeat(25000), user: { login: "me" }, author_association: "OWNER" });
  assert.equal(issue.author_association, "OWNER");
  assert.equal(issue.author_login, "me");
  assert.equal(issue.body.length, 20000);
  assert.equal(parseIssue({ number: 4, id: 40, html_url: "https://github.com/owner/repo/pull/4", title: "PR", pull_request: {} }), null);
  assert.equal(parseIssue({ number: 5, id: 50, html_url: "https://github.com/x", title: "no author" }).author_association, "NONE");
});

test("the label is encoded, and pages are read until a short one", async () => {
  const urls = [];
  const fetchImpl = async (url) => {
    urls.push(url);
    const page = Number(new URL(url).searchParams.get("page"));
    const rows = Array.from({ length: page === 1 ? 100 : 2 }, (_, i) => ({
      number: page * 1000 + i, id: page * 1000 + i, html_url: `https://github.com/owner/repo/issues/${i}`,
      title: "t", user: { login: "me" }, author_association: "OWNER",
    }));
    return new Response(JSON.stringify(rows), { status: 200 });
  };
  const issues = await listLabelledIssues({ installationToken: "tok", repository: "owner/repo", label: "good first", fetchImpl });
  assert.equal(issues.length, 102);
  assert.equal(urls.length, 2);
  assert.match(urls[0], /labels=good%20first/);
  assert.match(urls[0], /state=open/);
});

test("a poll records what it read and revokes its token", async () => {
  const calls = [];
  const revoked = [];
  await processIssuePoll(ITEM, {
    mintToken: async () => "tok-1",
    listIssues: async ({ label, repository }) => {
      assert.equal(label, "agent");
      assert.equal(repository, "owner/repo");
      return [{ number: 1, id: 10, title: "a", body: "", html_url: "https://github.com/owner/repo/issues/1", author_login: "me", author_association: "OWNER" }];
    },
    revoke: async ({ installationToken }) => { revoked.push(installationToken); },
    db: async (sql, vars) => { calls.push({ sql, vars }); return { ok: true }; },
  });
  assert.equal(revoked[0], "tok-1");
  assert.match(calls[0].sql, /record_issue_poll/);
  assert.equal(JSON.parse(calls[0].vars.issues).length, 1);
  assert.equal(calls[0].vars.code, "");
});

test("a missing Issues permission is recorded with what to do on GitHub", async () => {
  for (const status of [403, 422]) {
    const calls = [];
    await processIssuePoll(ITEM, {
      mintToken: async () => { throw new GithubAppError("validation_failed", "The permissions requested are not granted", status); },
      revoke: async () => undefined,
      db: async (sql, vars) => { calls.push(vars); return {}; },
    });
    assert.equal(calls[0].code, "issues_permission_missing");
    assert.equal(calls[0].message, ISSUES_PERMISSION_MESSAGE);
    assert.equal(calls[0].issues, "[]");
  }
});

test("any other failure is recorded redacted, and the token never reaches the record", async () => {
  const calls = [];
  await processIssuePoll(ITEM, {
    mintToken: async () => "ghs_secretvalue",
    listIssues: async () => { throw new GithubAppError("github_unavailable", "network down for ghs_secretvalue", 503); },
    revoke: async () => undefined,
    db: async (sql, vars) => { calls.push(vars); return {}; },
  });
  assert.equal(calls[0].code, "github_unavailable");
  assert.doesNotMatch(calls[0].message, /ghs_secretvalue/);
});

// I2 (0133): the loop back to GitHub.
const { processIssueComment, issueCommentBody } = await import("../github-app-worker.mjs");
const { pullRequestBody } = await import("../github-publish.mjs");

test("a chat started from an issue opens a pull request that closes it", () => {
  const base = { objective: "Do it", head_commit_sha: "abc", evidence_digest: "sha256:x" };
  assert.match(pullRequestBody({ ...base, issue_number: 3 }), /\nCloses #3\n/);
  assert.doesNotMatch(pullRequestBody(base), /Closes #/);
});

test("the issue hears that its chat started, then the pull request", async () => {
  assert.match(issueCommentBody({ kind: "started" }), /Started as a chat/);
  assert.match(issueCommentBody({ kind: "pull_request", pr_url: "https://github.com/o/r/pull/9" }), /https:\/\/github.com\/o\/r\/pull\/9/);
  const posted = [];
  const recorded = [];
  await processIssueComment({ id: "l1", kind: "started", issue_number: 3, repository_full_name: "o/r", installation_id: "7", github_repository_id: 1 }, {
    mintToken: async () => "tok",
    comment: async (args) => { posted.push(args); return { id: 1 }; },
    revoke: async () => undefined,
    db: async (sql, vars) => { recorded.push(vars); return {}; },
  });
  assert.equal(posted[0].number, 3);
  assert.equal(posted[0].repository, "o/r");
  assert.equal(recorded[0].error, "");
});

test("a comment GitHub refuses is recorded as an error, with what to do", async () => {
  const recorded = [];
  await processIssueComment({ id: "l1", kind: "started", issue_number: 3, repository_full_name: "o/r" }, {
    mintToken: async () => { throw new GithubAppError("forbidden", "no", 403); },
    revoke: async () => undefined,
    db: async (sql, vars) => { recorded.push(vars); return {}; },
  });
  assert.equal(recorded[0].error, ISSUES_PERMISSION_MESSAGE);
});
