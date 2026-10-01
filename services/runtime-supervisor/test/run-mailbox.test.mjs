// The run mailbox's delivery rules (WP-9a), against a stand-in for the
// database: what a command needs from the driver, how a delivery ends, and that
// stopping waits for a delivery in progress. The database's half —
// ordering, idempotency, the state machine — is db/tests/0046.
import assert from "node:assert/strict";
import test from "node:test";

import { codexDriver } from "../drivers/codex.mjs";
import { opencodeDriver } from "../drivers/opencode.mjs";
import { hasCapability } from "../drivers/capabilities.mjs";
import { COMMAND_CAPABILITY, DeliveryOutcomeUnknown, startMailbox } from "../run-mailbox.mjs";

// A mailbox holding `commands`, recording what the worker reported.
function fakeDatabase(commands) {
  const queue = [...commands];
  const calls = [];
  return {
    calls,
    query: async (sql, variables) => {
      if (sql.includes("claim_run_command")) {
        calls.push(["claim", variables.worker_id]);
        return queue.shift() ?? null;
      }
      if (sql.includes("acknowledge_run_command")) {
        calls.push(["acknowledged", Number(variables.command_id), JSON.parse(variables.receipt)]);
        return {};
      }
      if (sql.includes("finish_run_command")) {
        calls.push([variables.status, Number(variables.command_id), variables.reason, JSON.parse(variables.detail)]);
        return {};
      }
      throw new Error(`unexpected query ${sql}`);
    },
  };
}

async function drain(mailbox, db, count) {
  for (let i = 0; i < 200 && db.calls.filter(([kind]) => kind !== "claim").length < count; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  await mailbox.stop();
}

const quiet = () => {};

test("every command kind needs a capability from the closed vocabulary", () => {
  assert.deepEqual(Object.keys(COMMAND_CAPABILITY).sort(), ["input_response", "interrupt", "steer"]);
  // Throws for a capability outside the vocabulary; that it does not is the check.
  for (const capability of Object.values(COMMAND_CAPABILITY)) hasCapability(codexDriver, capability);
  // Both runtimes this product ships can be interrupted, and neither takes input
  // into a running turn: a steer to either is unsupported, not simulated.
  for (const driver of [codexDriver, opencodeDriver]) {
    assert.equal(hasCapability(driver, "interrupt"), true, driver.name);
    assert.equal(hasCapability(driver, "input.steer"), false, driver.name);
    assert.equal(hasCapability(driver, "input.respond"), false, driver.name);
  }
});

test("an interrupt is delivered and acknowledged with the runtime's receipt", async () => {
  const db = fakeDatabase([{ command_id: 7, command_kind: "interrupt", sequence: 1, payload: {} }]);
  const seen = [];
  const mailbox = startMailbox({
    jobId: 1, workerId: "w", driver: codexDriver, query: db.query, pollMs: 1, log: quiet,
    onCommand: (command) => seen.push(command.command_kind),
    deliver: { interrupt: async () => ({ method: "turn/interrupt", response: {} }) },
  });
  await drain(mailbox, db, 1);
  assert.deepEqual(seen, ["interrupt"]);
  assert.deepEqual(db.calls.find(([kind]) => kind === "acknowledged"), ["acknowledged", 7, { method: "turn/interrupt", response: {} }]);
  assert.equal(mailbox.delivered[0].status, "acknowledged");
});

test("a kind the driver does not declare fails as unsupported and never reaches deliver", async () => {
  const db = fakeDatabase([
    { command_id: 8, command_kind: "steer", sequence: 1, payload: { text: "focus" } },
    { command_id: 9, command_kind: "input_response", sequence: 2, payload: { answer: "yes" } },
  ]);
  let delivered = 0;
  const mailbox = startMailbox({
    jobId: 1, workerId: "w", driver: opencodeDriver, query: db.query, pollMs: 1, log: quiet,
    // Present, to show the refusal comes from the declaration, not a missing function.
    deliver: { steer: async () => { delivered += 1; return { x: 1 }; }, input_response: async () => { delivered += 1; return { x: 1 }; } },
  });
  await drain(mailbox, db, 2);
  assert.equal(delivered, 0);
  assert.deepEqual(db.calls.filter(([kind]) => kind === "failed").map(([, id, reason, detail]) => [id, reason, detail.capability]),
    [[8, "run_command_unsupported", "input.steer"], [9, "run_command_unsupported", "input.respond"]]);
});

test("a delivery that may have happened is outcome_unknown; a refusal is failed", async () => {
  const db = fakeDatabase([
    { command_id: 10, command_kind: "interrupt", sequence: 1, payload: {} },
  ]);
  const mailbox = startMailbox({
    jobId: 1, workerId: "w", driver: codexDriver, query: db.query, pollMs: 1, log: quiet,
    deliver: { interrupt: async () => { throw new DeliveryOutcomeUnknown("Timed out waiting for turn/interrupt"); } },
  });
  await drain(mailbox, db, 1);
  assert.deepEqual(db.calls.find(([kind]) => kind === "outcome_unknown").slice(0, 3), ["outcome_unknown", 10, "run_command_delivery_lost"]);

  const refused = fakeDatabase([{ command_id: 11, command_kind: "interrupt", sequence: 1, payload: {} }]);
  const second = startMailbox({
    jobId: 1, workerId: "w", driver: codexDriver, query: refused.query, pollMs: 1, log: quiet,
    deliver: { interrupt: async () => { throw new Error('{"code":-32600,"message":"no active turn"}'); } },
  });
  await drain(second, refused, 1);
  assert.deepEqual(refused.calls.find(([kind]) => kind === "failed").slice(0, 3), ["failed", 11, "run_command_delivery_failed"]);
});

test("stop waits for the delivery in progress, so the receipt is written before the run ends", async () => {
  const db = fakeDatabase([{ command_id: 12, command_kind: "interrupt", sequence: 1, payload: {} }]);
  let release;
  const mailbox = startMailbox({
    jobId: 1, workerId: "w", driver: opencodeDriver, query: db.query, pollMs: 1, log: quiet,
    deliver: { interrupt: () => new Promise((resolve) => { release = () => resolve({ exit_signal: "SIGTERM" }); }) },
  });
  while (!release) await new Promise((resolve) => setTimeout(resolve, 2));
  const stopped = mailbox.stop();
  let done = false;
  void stopped.then(() => { done = true; });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(done, false, "stop returned while the interrupt was still being delivered");
  release();
  await stopped;
  assert.deepEqual(db.calls.find(([kind]) => kind === "acknowledged"), ["acknowledged", 12, { exit_signal: "SIGTERM" }]);
});
