// A role's instructions as the supervisor takes them (rc.143).
import test from "node:test";
import assert from "node:assert/strict";

import { SYSTEM_PROMPT_MAX, systemPromptOf } from "../system-prompt.mjs";

test("a system prompt is optional, trimmed, bounded and never taken for a flag", () => {
  assert.equal(systemPromptOf({}), null);
  assert.equal(systemPromptOf({ system_prompt: null }), null);
  assert.equal(systemPromptOf({ system_prompt: "   " }), null);
  assert.equal(systemPromptOf({ system_prompt: "  You are the worker.\n" }), "You are the worker.");
  assert.equal(systemPromptOf({ system_prompt: "x".repeat(SYSTEM_PROMPT_MAX) }).length, SYSTEM_PROMPT_MAX);
  assert.throws(() => systemPromptOf({ system_prompt: "x".repeat(SYSTEM_PROMPT_MAX + 1) }), /length is invalid/);
  assert.throws(() => systemPromptOf({ system_prompt: 42 }), /length is invalid/);
  assert.throws(() => systemPromptOf({ system_prompt: "--tools Bash" }), /may not begin with a dash/);
  assert.throws(() => systemPromptOf({ system_prompt: "  -x" }), /may not begin with a dash/);
});
