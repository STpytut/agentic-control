// The failure envelope and the log line it produces (WP-8a).
//
// The five rows of prework B2 are five layers that caught an error, wrote a
// sentence of their own and dropped what they were holding. These tests are
// about the half that was dropped: that a cause survives being wrapped, that a
// reason the database named is readable without matching on a sentence, and
// that a PostgreSQL error is classified by its SQLSTATE rather than guessed at.

import test from "node:test";
import assert from "node:assert/strict";

import {
  FAILURE_CODES, InfraError, envelopeOf, failureChain, failureReason, wrapFailure,
} from "../failure.mjs";
import { logFailure, logInfo, setCorrelationId, withCorrelationId } from "../log.mjs";

function recorder() {
  const lines = [];
  return { lines, write: (text) => lines.push(JSON.parse(text)) };
}

test("a code outside the vocabulary is refused where it is written", () => {
  assert.throws(() => new InfraError("x", { code: "oops" }), /is not a failure code/);
  assert.ok(FAILURE_CODES.includes("unknown"), "a failure nothing has classified is still an envelope");
});

test("wrapping says what this layer was doing and keeps what it was told", () => {
  // Defect 86's shape: the account server timed out, and the truth was EROFS on
  // a path inside the runtime's home.
  const eroFs = Object.assign(new Error("EROFS: read-only file system, open '/home/codex-worker/.config/opencode/.gitignore'"),
    { code: "EROFS", syscall: "open", path: "/home/codex-worker/.config/opencode/.gitignore" });
  const inner = envelopeOf(eroFs);
  assert.equal(inner.code, "filesystem");
  assert.equal(inner.details.syscall, "open");

  const outer = wrapFailure(eroFs, { operation: "start the OpenCode account server", correlationId: "corr-1" });
  assert.equal(outer.correlationId, "corr-1");
  assert.equal(outer.cause, eroFs, "the cause was replaced rather than kept");
  const chain = failureChain(outer);
  assert.equal(chain.length, 2);
  assert.match(chain[1].message, /EROFS/);
  assert.equal(chain[0].operation, "start the OpenCode account server");
});

test("a PostgreSQL error is classified by its SQLSTATE, not by its sentence", () => {
  // Defect 92: `column lm.model does not exist` was retried twice and cost a
  // lease. A statement the server will not parse is not going to parse later.
  const undefinedColumn = Object.assign(new Error('column lm.model does not exist'), { code: "42703" });
  assert.equal(envelopeOf(undefinedColumn).code, "database");
  assert.equal(envelopeOf(undefinedColumn).retryable, false);

  assert.equal(envelopeOf(Object.assign(new Error("deadlock"), { code: "40P01" })).code, "unavailable");
  assert.equal(envelopeOf(Object.assign(new Error("deadlock"), { code: "40P01" })).retryable, true);
  assert.equal(envelopeOf(Object.assign(new Error("bad input"), { code: "22023" })).code, "invalid_argument");
  assert.equal(envelopeOf(Object.assign(new Error("no grant"), { code: "42501" })).code, "permission_denied");
  assert.equal(envelopeOf(Object.assign(new Error("server closed"), { code: "08006" })).code, "unavailable");
});

test("the reason a database function named is readable without matching a sentence", () => {
  // Defect 104: six conditions, one sentence. The reason travels in DETAIL.
  const refusal = Object.assign(new Error("run 7 is completed, not running"),
    { code: "55000", detail: JSON.stringify({ reason: "run_not_running" }) });
  assert.equal(failureReason(refusal), "run_not_running");
  assert.equal(envelopeOf(refusal).details.reason, "run_not_running");

  // And through a wrap, which is where it used to be lost.
  const wrapped = wrapFailure(refusal, { operation: "report the completion" });
  assert.equal(failureReason(wrapped), "run_not_running");

  // A DETAIL that is a human sentence is not misread as a reason.
  assert.equal(failureReason(Object.assign(new Error("x"), { code: "55000", detail: "try again later" })), null);
});

test("a log line carries the stable field set and the correlation id", () => {
  const out = recorder();
  setCorrelationId("corr-42");
  logInfo("executor.claimed", { jobId: 9 }, out);
  setCorrelationId(null);
  const line = out.lines[0];
  assert.equal(line.type, "executor.claimed");
  assert.equal(line.correlation_id, "corr-42");
  assert.equal(line.severity, "info");
  assert.ok(line["service.name"], "the line does not say which service wrote it");
  assert.ok(Date.parse(line.timestamp), "the line has no timestamp");
  // Not `trace_id`: that belongs to a real tracing context, and 11.5 is where
  // tracing arrives.
  assert.equal(line.trace_id, undefined);
});

test("a correlation id is restored after the work it belonged to", async () => {
  const out = recorder();
  setCorrelationId("outer");
  await withCorrelationId("inner", async () => logInfo("a", {}, out));
  logInfo("b", {}, out);
  setCorrelationId(null);
  assert.deepEqual(out.lines.map((line) => line.correlation_id), ["inner", "outer"]);
});

test("a failure is logged as the chain, not as one sentence", () => {
  const err = recorder();
  const refusal = Object.assign(new Error("run 7 is completed, not running"),
    { code: "55000", detail: JSON.stringify({ reason: "run_not_running" }) });
  logFailure("executor.failed", wrapFailure(refusal, { operation: "report the completion" }), { jobId: 7 }, err);
  const line = err.lines[0];
  assert.equal(line.severity, "error");
  assert.equal(line.jobId, 7);
  assert.equal(line.code, "conflict");
  assert.equal(line.operation, "report the completion");
  assert.equal(line.cause.length, 1);
  assert.match(line.cause[0].message, /completed, not running/);
});
