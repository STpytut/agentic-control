import test from "node:test";
import assert from "node:assert/strict";
import { claudeListedEntries } from "../catalog-claude.mjs";

test("the subscription's newest model of each family is offered beside the aliases", () => {
  // The list Anthropic returned on the host, 2026-10-01 (abridged).
  const listed = claudeListedEntries([
    { id: "claude-sonnet-5-5", display_name: "Claude Sonnet 5.5", created_at: "2026-09-28T00:00:00Z" },
    { id: "claude-opus-5-5", display_name: "Claude Opus 5.5", created_at: "2026-09-21T16:24:00Z" },
    { id: "claude-fable-5-1", display_name: "Claude Fable 5.1", created_at: "2026-08-28T00:00:00Z" },
    { id: "claude-opus-5", display_name: "Claude Opus 5", created_at: "2026-07-24T00:00:00Z" },
    { id: "claude-haiku-4-5-20251001", display_name: "Claude Haiku 4.5", created_at: "2025-10-15T00:00:00Z" },
  ], { plan_badge: "max" });
  assert.deepEqual(listed.map((entry) => entry.model_id),
    ["claude-fable-5-1", "claude-haiku-4-5-20251001", "claude-opus-5-5", "claude-sonnet-5-5"]);
  const opus = listed.find((entry) => entry.model_id === "claude-opus-5-5");
  assert.equal(opus.display_name, "Claude Opus 5.5");
  assert.equal(opus.discovery_source, "anthropic_models");
  assert.equal(opus.runtime_type, "claude");
  assert.equal(opus.billing_boundary, "subscription");
  assert.deepEqual(claudeListedEntries(null, {}), []);
});
