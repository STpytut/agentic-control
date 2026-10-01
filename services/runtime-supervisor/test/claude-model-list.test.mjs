import test from "node:test";
import assert from "node:assert/strict";
import { checkClaudeModels } from "../claude-model-list.mjs";

test("the probe's answer is passed on as ids and names, and nothing else", () => {
  const out = JSON.stringify({ models: [
    { id: "claude-opus-5-5", display_name: "Claude Opus 5.5", created_at: "2026-09-21T16:24:00Z", token: "sk-ant-oat-secret" },
    { id: "../../etc/passwd", display_name: "x" },
    { id: "claude-sonnet-5-5", display_name: "Claude Sonnet 5.5 <script>", created_at: "yesterday" },
  ] });
  assert.deepEqual(checkClaudeModels(`${out}\n`), { models: [
    { id: "claude-opus-5-5", display_name: "Claude Opus 5.5", created_at: "2026-09-21T16:24:00Z" },
    { id: "claude-sonnet-5-5", display_name: "Claude Sonnet 5.5 script", created_at: "" },
  ] });
  assert.ok(!JSON.stringify(checkClaudeModels(out)).includes("secret"));
});

test("a reason there are no models is passed on; anything else is unparsed", () => {
  assert.deepEqual(checkClaudeModels('{"error":"expired"}'), { error: "expired" });
  assert.deepEqual(checkClaudeModels("not json"), { error: "unparsed" });
  assert.deepEqual(checkClaudeModels('{"data":[]}'), { error: "unparsed" });
});
