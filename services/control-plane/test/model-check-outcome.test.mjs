// What a model check found (Stage 12 W6): the verdict and its class from what
// the runtime said, the Codex window that defers an automatic check, and the
// pieces of a turn the worker reads. Pure: no runtime, no database.

import test from "node:test";
import assert from "node:assert/strict";
import {
  CHECK_ANSWER, failureClassOf, judgeError, judgeTurn, parseRateLimits, windowDeferral,
} from "../model-check-outcome.mjs";
import { batchOutcome, codexTurnFailure, resolvedClaudeModel } from "../catalog-gate-worker.mjs";
import { driverFor } from "../../runtime-supervisor/drivers/index.mjs";

test("the model answered: passed", () => {
  assert.deepEqual(judgeTurn({ answer: "PARITY_OK" }), { result: "passed", failureClass: null, detail: CHECK_ANSWER });
  assert.equal(judgeTurn({ answer: "PARITY_OK.", failure: "", exited: false }).result, "passed");
});

test("the provider said no to the model: rejected, class model", () => {
  for (const failure of [
    "Claude Code model not available: claude-x",
    "The 'gpt-5.5' model is not supported when using Codex with a ChatGPT account.",
    "No endpoints found for openai/gpt-6-luna.",
    "ProviderModelNotFoundError: model_not_found",
  ]) {
    const verdict = judgeTurn({ answer: "", failure, exited: true });
    assert.deepEqual([verdict.result, verdict.failureClass], ["rejected", "model"], failure);
  }
  // Answered, but not the word: it runs and does not follow the instruction.
  assert.deepEqual(Object.values(judgeTurn({ answer: "Hello! How can I help?" })).slice(0, 2), ["rejected", "model"]);
});

test("a limit or the network: inconclusive, never a failure of the model", () => {
  for (const failure of ["Codex usage limit reached; try again at 14:20", "429 Too Many Requests", "rate_limit", "Insufficient credits"]) {
    const verdict = judgeTurn({ answer: "", failure, exited: true });
    assert.deepEqual([verdict.result, verdict.failureClass], ["inconclusive", "infrastructure"], failure);
  }
  // A limit outranks a model word in the same sentence.
  assert.equal(failureClassOf("rate limit for model not found lookups"), "infrastructure");
});

test("the runtime fell over or said nothing: failed, class runtime", () => {
  assert.deepEqual(Object.values(judgeTurn({ answer: "", failure: "exit_code=139", exited: true })).slice(0, 2), ["failed", "runtime"]);
  assert.deepEqual(Object.values(judgeTurn({ answer: "", failure: "", exited: false })).slice(0, 2), ["failed", "runtime"]);
});

test("a thrown error is classified by what it was", () => {
  assert.equal(judgeError(Object.assign(new Error("no memory"), { code: "runtime_capacity" })).result, "wait");
  assert.equal(judgeError(Object.assign(new Error("paused"), { code: "runtime_paused" })).result, "wait");
  assert.deepEqual(Object.values(judgeError(Object.assign(new Error("lease"), { outcomeUnknown: true }))).slice(0, 2),
    ["inconclusive", "infrastructure"]);
  assert.equal(judgeError(new Error("Codex gate app-server closed (code=1, signal=null)")).failureClass, "runtime");
  assert.equal(judgeError(new TypeError("Cannot read properties of undefined")).failureClass, "harness");
  assert.equal(judgeError(new Error("model not found")).result, "rejected");
  // The detail is redacted and bounded.
  const detail = judgeError(new Error(`failed for someone@example.com with sk-${"a".repeat(30)} ${"x".repeat(900)}`)).detail;
  assert.ok(!detail.includes("someone@example.com") && !detail.includes("sk-aaaa") && detail.length <= 480);
});

test("the Codex window: read from the app-server's answer, and deferring above 80 %", () => {
  const now = Date.parse("2026-09-28T12:00:00Z");
  const window = parseRateLimits({ rateLimits: { primary: { usedPercent: 83, windowDurationMins: 300, resetsAt: 1791000000 } } });
  assert.equal(window.usedPercent, 83);
  assert.equal(window.resetsAt.toISOString(), new Date(1791000000 * 1000).toISOString());
  const wait = windowDeferral(window, { limitPercent: 80, now });
  assert.match(wait.detail, /83 % used/);
  assert.equal(wait.retryAt, new Date(1791000000 * 1000).toISOString());
  assert.equal(windowDeferral({ usedPercent: 80, resetsAt: null }, { limitPercent: 80, now }), null);
  // A reset already past, or none: half an hour.
  assert.equal(windowDeferral({ usedPercent: 99, resetsAt: new Date(now - 1000) }, { now }).retryAt, new Date(now + 30 * 60_000).toISOString());
  assert.equal(parseRateLimits({ rate_limits: { primary: { used_percent: 12, resets_at: "2026-09-28T13:00:00Z" } } }).usedPercent, 12);
  assert.equal(parseRateLimits({}), null);
  assert.equal(parseRateLimits({ rateLimits: { primary: { usedPercent: "n/a" } } }), null);
});

test("a Codex turn's refusal is read from its error notification or its completion", () => {
  const messages = [
    { method: "error", params: { error: { message: "The model is not supported when using Codex with a ChatGPT account." } } },
    { method: "turn/completed", params: { threadId: "t", turn: { id: "u", status: "failed", error: { message: "The model is not supported when using Codex with a ChatGPT account." } } } },
  ];
  assert.equal(codexTurnFailure(messages, "u", "failed"), "The model is not supported when using Codex with a ChatGPT account.");
  assert.equal(codexTurnFailure([], "u", "completed"), "");
  assert.equal(codexTurnFailure([], "u", "interrupted"), "the turn ended interrupted");
});

test("a Claude check's answer, refusal and resolved model come from its stream", () => {
  const driver = driverFor("claude");
  const init = JSON.stringify({ type: "system", subtype: "init", model: "claude-haiku-4-5", session_id: "s" });
  const ok = batchOutcome(driver, {
    exit_code: 0, memory: { sampled_peak_rss_mb: 210 },
    stdout: [init, JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "PARITY_OK" })].join("\n"),
  });
  assert.deepEqual([ok.answer, ok.resolved, ok.memoryMb, ok.exited], ["PARITY_OK", "claude-haiku-4-5", 210, false]);
  assert.equal(judgeTurn(ok).result, "passed");
  const refused = batchOutcome(driver, {
    exit_code: 1, stderr: "",
    stdout: [init, JSON.stringify({ type: "result", subtype: "success", is_error: true, api_error_status: 404, result: "model: claude-x" })].join("\n"),
  });
  assert.equal(judgeTurn(refused).result, "rejected");
  assert.equal(resolvedClaudeModel("not json\n"), "");
});
