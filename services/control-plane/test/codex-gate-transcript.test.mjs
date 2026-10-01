import test from "node:test";
import assert from "node:assert/strict";
import { parseGateThreadResult, parseGateTurnResult, parseGateTurnCompleted, collectGateAgentText } from "../codex-gate-transcript.mjs";

test("gate transcript parses thread/start and turn/start nested ids", () => {
  assert.equal(parseGateThreadResult({ thread: { id: "thread-1" } }), "thread-1");
  assert.equal(parseGateThreadResult({ threadId: "thread-legacy" }), null);
  assert.equal(parseGateThreadResult(null), null);
  assert.equal(parseGateTurnResult({ turn: { id: "turn-1" } }), "turn-1");
  assert.equal(parseGateTurnResult({ turnId: "turn-legacy" }), null);
  assert.equal(parseGateTurnResult({}), null);
});

test("gate transcript collects bounded agent message deltas for current app-server", () => {
  const messages = [
    { method: "item/agentMessage/delta", params: { threadId: "thread-1", turnId: "turn-1", delta: "PARITY_" } },
    { method: "item/agentMessage/delta", params: { threadId: "thread-other", turnId: "turn-1", delta: "WRONG" } },
    { method: "item/agentMessage/delta", params: { threadId: "thread-1", turnId: "turn-1", delta: "OK" } },
  ];
  assert.equal(collectGateAgentText(messages, "thread-1", "turn-1"), "PARITY_OK");
  assert.equal(collectGateAgentText(messages, "thread-1", "turn-1", 4), "Y_OK");
  assert.equal(collectGateAgentText([
    { method: "item/completed", params: { threadId: "thread-1", turnId: "turn-1", item: { type: "agentMessage", text: "FINAL" } } },
  ], "thread-1", "turn-1"), "FINAL");
});

test("gate transcript parses turn/completed with nested turn.items agentMessage", () => {
  const fixture = {
    method: "turn/completed",
    params: {
      threadId: "thread-1",
      turn: {
        id: "turn-1",
        status: "completed",
        items: [
          { type: "functionCall", name: "ls" },
          { type: "agentMessage", text: "PARITY_OK — everything is fine." },
          { type: "agentMessage", text: "trailing" },
        ],
      },
    },
  };
  const parsed = parseGateTurnCompleted(fixture);
  assert.equal(parsed.threadId, "thread-1");
  assert.equal(parsed.turnId, "turn-1");
  assert.equal(parsed.status, "completed");
  assert.equal(parsed.agentText, "trailing");

  const statusOnly = parseGateTurnCompleted({
    method: "turn/completed",
    params: { threadId: "t", turn: { id: "x", status: "interrupted", items: [] } },
  });
  assert.equal(statusOnly.status, "interrupted");
  assert.equal(statusOnly.agentText, "");

  assert.equal(parseGateTurnCompleted({ method: "turn/completed", params: { items: [] } }), null);
  assert.equal(parseGateTurnCompleted({ method: "other", params: {} }), null);
});
