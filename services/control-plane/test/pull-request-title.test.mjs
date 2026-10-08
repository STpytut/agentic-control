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
