// What an analyst's run becomes (consultation-worker.mjs).
import test from "node:test";
import assert from "node:assert/strict";
import { consultationOutcome } from "../consultation-worker.mjs";

const context = { model: "haiku", model_display: "Claude Haiku" };

test("a run that answered is the answer, with the model it ran and the commit it read", () => {
  assert.deepEqual(consultationOutcome({ exit_code: 0, response: "  src/a.js:1  ", resolved_model: "claude-haiku-5", snapshot_sha: "abc" }, context),
    { status: "answered", answer: "src/a.js:1", model: "claude-haiku-5", snapshot_sha: "abc" });
});

test("an empty answer or a failed run is a failure with the runtime's reason", () => {
  assert.deepEqual(consultationOutcome({ exit_code: 0, response: "  " }, context),
    { status: "failed", model: "Claude Haiku", snapshot_sha: null, failure: "the analyst gave no answer" });
  assert.equal(consultationOutcome({ exit_code: 1, response: "partial", failure: "rate limited" }, context).failure,
    "the run ended with code 1: rate limited");
  assert.equal(consultationOutcome({ exit_code: 1, response: "", stderr: "a\nboom" }, context).failure, "the analyst gave no answer: boom");
});
