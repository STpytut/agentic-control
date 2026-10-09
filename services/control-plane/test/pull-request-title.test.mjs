// A pull request's title (github-publish.mjs pullRequestTitle).
import test from "node:test";
import assert from "node:assert/strict";
import { pullRequestTitle } from "../github-publish.mjs";

test("a pull request is titled by the orchestrator's objective, first sentence, bounded", () => {
  assert.equal(pullRequestTitle({ title: "First ask the analyst…" },
    "Add a confirmed Clear history action to the Stats view. Reset the dependent UI."), "Add a confirmed Clear history action to the Stats view");
  const long = pullRequestTitle({ title: "t" }, "Add a confirmed Clear history action that deletes all recorded days and every session then refreshes stats");
  assert.ok(long.length <= 72 && long.endsWith("…"), long);
  assert.ok(!/\s…$/.test(long));
  assert.equal(pullRequestTitle({ title: "t" }, "Fix   the\ntimer!"), "Fix the timer");
});

test("without an objective the task's own title is kept", () => {
  assert.equal(pullRequestTitle({ title: " Show today's sessions " }, null), "Show today's sessions");
  assert.equal(pullRequestTitle({ title: "Short" }, "Do it"), "Short");
  assert.equal(pullRequestTitle({}, undefined), "Changes from infra-cod");
});

// rc.148: a pull request that carries an earlier one still open says so
// (focus-timer #15 carried #14's commit).
test("a pull request names the earlier ones still open whose commits it carries", async () => {
  const { pullRequestBody } = await import("../github-publish.mjs");
  const base = { objective: "Mention shortcuts", head_commit_sha: "abc", evidence_digest: "sha256:x" };
  assert.doesNotMatch(pullRequestBody(base), /Includes the commits/);
  assert.match(pullRequestBody({ ...base, stacked_on: [{ number: 14, url: "https://github.com/o/r/pull/14" }] }),
    /\nIncludes the commits of #14, not yet merged: merge it first, and this pull request shows only its own change\.\n/);
  assert.match(pullRequestBody({ ...base, stacked_on: [{ number: 14 }, { number: 12 }, { number: "x" }] }),
    /Includes the commits of #14, #12, not yet merged: merge them first/);
});
