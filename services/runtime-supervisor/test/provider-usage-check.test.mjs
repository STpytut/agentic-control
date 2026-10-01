// ADR-0019: what the supervisor keeps of the OpenCode Go usage probe's output.

import test from "node:test";
import assert from "node:assert/strict";

import { checkProbeOutput } from "../provider-usage-check.mjs";
import { usageReading } from "../provider-usage.mjs";

const good = { windows: [
  { key: "rolling", used_percent: 12.34, window_minutes: 300, resets_at: 1_790_700_000 },
  { key: "weekly", used_percent: 40, window_minutes: 10_080 },
], status: "allowed" };

test("a reading in the schema is kept, rounded, and nothing else is", () => {
  assert.deepEqual(checkProbeOutput(`${JSON.stringify(good)}\n`), { windows: [
    { key: "rolling", used_percent: 12.3, window_minutes: 300, resets_at: 1_790_700_000 },
    { key: "weekly", used_percent: 40, window_minutes: 10_080 },
  ], status: "allowed" });
  assert.deepEqual(checkProbeOutput('{"error_class":"not_subscribed"}'), { error_class: "not_subscribed" });
});

test("anything outside the schema rejects the whole line", () => {
  const bad = [
    { ...good, key: "sk-live-secret" },                                     // an extra field
    { ...good, status: "sk-live-secret" },                                  // a string outside the list
    { windows: [{ ...good.windows[0], key: "hourly" }], status: "allowed" }, // an unknown window
    { windows: [{ ...good.windows[0], used_percent: 101 }], status: "allowed" },
    { windows: [{ ...good.windows[0], window_minutes: 60 }], status: "allowed" },
    { windows: [{ ...good.windows[0], resets_at: 12 }], status: "allowed" },
    { windows: [{ ...good.windows[0], note: "x" }], status: "allowed" },
    { windows: [good.windows[0], good.windows[0]], status: "allowed" },     // the same window twice
    { windows: [], status: "allowed" },
    { error_class: "unauthorized", detail: "Bearer sk-…" },
    { error_class: "leaked sk-live-secret" },
  ];
  for (const value of bad) assert.equal(checkProbeOutput(JSON.stringify(value)), null, JSON.stringify(value));
  assert.equal(checkProbeOutput(`${JSON.stringify(good)}\n${JSON.stringify(good)}`), null, "two lines");
  assert.equal(checkProbeOutput("not json"), null);
  assert.equal(checkProbeOutput(JSON.stringify({ ...good, windows: [{ ...good.windows[0] }], pad: "x".repeat(5000) })), null, "too long");
});

test("the probe turns the endpoint's answer into numbers and words only", () => {
  const reading = usageReading({ usage: {
    rolling: { status: "ok", percent: 12.345, resetsAt: "2026-09-29T12:00:00Z" },
    weekly: { status: "rate-limited", percent: 100, resetsAt: "2026-10-02T00:00:00Z" },
    monthly: { status: "ok", percent: "n/a" },
    secret: { percent: 1 },
  } });
  assert.deepEqual(reading, { windows: [
    { key: "rolling", used_percent: 12.3, window_minutes: 300, resets_at: 1_790_683_200 },
    { key: "weekly", used_percent: 100, window_minutes: 10_080, resets_at: 1_790_899_200 },
  ], status: "rejected" });
  assert.deepEqual(checkProbeOutput(JSON.stringify(reading)), reading, "what the probe prints is what the supervisor keeps");
  assert.deepEqual(usageReading({ nothing: true }), { error_class: "malformed" });
});
