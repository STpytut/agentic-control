import test from "node:test";
import assert from "node:assert/strict";
import { antigravityDiscovery, antigravityListedEntries } from "../catalog-antigravity.mjs";

test("the models agy lists are offered as it names them, each to be checked before it is offered", () => {
  const listed = antigravityListedEntries([
    { id: "gemini-3.8-flash-high", display_name: "Gemini 3.8 Flash (high)" },
    { id: "claude-sonnet-4-6", display_name: "Claude Sonnet 4.6" },
    { id: "claude-sonnet-4-6", display_name: "twice" },
    { id: "gpt-oss-120b-medium", display_name: "" },
    { id: "not valid!", display_name: "x" },
  ], { plan_badge: "pro", adapter_version: "1.0.0", runtime_version: "1.3.4" });
  assert.deepEqual(listed.map((entry) => entry.model_id), ["claude-sonnet-4-6", "gemini-3.8-flash-high", "gpt-oss-120b-medium"]);
  const gemini = listed.find((entry) => entry.model_id === "gemini-3.8-flash-high");
  assert.deepEqual(gemini, {
    runtime_type: "antigravity", provider_id: "google", model_id: "gemini-3.8-flash-high", display_name: "Gemini 3.8 Flash (high)",
    provider_badge: "Antigravity", plan_badge: "pro", billing_boundary: "subscription", reasoning_efforts: [], service_tiers: [],
    adapter_version: "1.0.0", runtime_version: "1.3.4", discovery_source: "antigravity_models",
  });
  assert.equal(listed.find((entry) => entry.model_id === "gpt-oss-120b-medium").display_name, "gpt-oss-120b-medium");
  assert.deepEqual(antigravityListedEntries(null, {}), []);
});

test("a list that could not be read names its source as unread and offers nothing new", () => {
  assert.deepEqual(antigravityDiscovery({ error: "exit_1" }, {}), { entries: [], unreadSources: ["antigravity_models"] });
  const read = antigravityDiscovery({ models: [{ id: "gemini-3.8-flash-high", display_name: "Gemini" }] }, {});
  assert.deepEqual(read.unreadSources, []);
  assert.equal(read.entries.length, 1);
});
