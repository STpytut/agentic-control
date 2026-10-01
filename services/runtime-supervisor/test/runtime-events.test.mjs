// What a runtime's own stdout is allowed to put into the activity feed, and
// what it must not lose on the way (WP-8a).
//
// `complete_task error` reached the panel as `{"tool":"complete_task","status":
// "error"}` with no reason (defect 105). The runtime had said why; the
// normaliser dropped it, because `error` was not on the allowed list.
//
// The list stays closed, though. These rows are written from a process the
// product does not control and are read in the panel: passing the object
// through would carry whatever the runtime decided to print, including the
// contents of a file it had just read.

import test from "node:test";
import assert from "node:assert/strict";

import { normalizeCodexEvent, normalizeOpenCodeEvent } from "../runtime-events.mjs";

test("a tool that failed carries its reason, wherever the runtime put it", () => {
  const cases = [
    { error: "complete_task refused: the run is not running" },
    { output: { error: "complete_task refused: the run is not running" } },
    { output: { message: "complete_task refused: the run is not running" } },
    { message: "complete_task refused: the run is not running" },
    { error: { message: "complete_task refused: the run is not running" } },
  ];
  for (const state of cases) {
    const event = normalizeOpenCodeEvent({ type: "tool_use",
      part: { tool: "complete_task", state: { status: "error", ...state } } });
    assert.equal(event.details.error, "complete_task refused: the run is not running",
      `the reason was dropped for ${JSON.stringify(state)}`);
    assert.equal(event.details.tool, "complete_task");
    assert.equal(event.details.status, "error");
  }
});

test("a tool that succeeded carries no error field at all", () => {
  const event = normalizeOpenCodeEvent({ type: "tool_use",
    part: { tool: "bash", state: { status: "completed", output: "ok" } } });
  assert.deepEqual(event.details, { tool: "bash", status: "completed" });
});

test("the details list stays closed, and long values are bounded", () => {
  const event = normalizeOpenCodeEvent({ type: "tool_use",
    part: { tool: "read", secret: "a token the runtime printed",
      state: { status: "error", error: "x".repeat(500), stack: "…", file_contents: "…" } } });
  assert.deepEqual(Object.keys(event.details).sort(), ["error", "status", "tool"]);
  assert.equal(event.details.error.length, 200);
});

test("the Codex normaliser is unchanged by this", () => {
  assert.equal(normalizeCodexEvent({ method: "turn/started" }).eventType, "runtime.turn.started");
  assert.deepEqual(normalizeCodexEvent({ method: "turn/completed", params: { turn: { status: "completed" } } }).details,
    { status: "completed" });
  assert.equal(normalizeCodexEvent({ method: "something/else" }), null);
});
