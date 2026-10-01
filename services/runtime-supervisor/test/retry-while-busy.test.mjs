// The retry that waits out a runtime installation.
//
// Two things make it safe, and both are worth a test: it stays inside the
// shortest lease any caller holds, and it repeats only the refusal that is
// raised before anything has happened.

import test from "node:test";
import assert from "node:assert/strict";
import { SHORTEST_WORKER_LEASE_MS, retryWhileRuntimeBusy } from "../client.mjs";

const paused = () => Object.assign(new Error("codex is not accepting launches"), {
  retryable: true,
  code: "runtime_paused",
});

// A clock the test moves, so the budget can be checked without waiting for it.
function fakeClock() {
  let now = 1_000_000;
  return { now: () => now, advance: (ms) => { now += ms; } };
}

test("it returns as soon as the fence is released", async () => {
  let calls = 0;
  const result = await retryWhileRuntimeBusy(async () => {
    calls += 1;
    if (calls < 3) throw paused();
    return "launched";
  }, { delayMs: 1 });
  assert.equal(result, "launched");
  assert.equal(calls, 3);
});

test("it gives up well inside the shortest lease", async () => {
  const clock = fakeClock();
  let calls = 0;
  await assert.rejects(retryWhileRuntimeBusy(async () => {
    calls += 1;
    clock.advance(10_000);
    throw paused();
  }, { delayMs: 1, now: clock.now }), /not accepting launches/);

  // A budget longer than the lease is not a retry, it is a way of losing the
  // work twice: the enrollment loses the right to complete itself, and a second
  // worker can claim the action while the first is still waiting.
  const waited = clock.now() - 1_000_000;
  assert.ok(waited < SHORTEST_WORKER_LEASE_MS, `waited ${waited}ms, which must stay inside ${SHORTEST_WORKER_LEASE_MS}ms`);
});

test("a caller's own lease shortens the budget further", async () => {
  const clock = fakeClock();
  const leaseExpiresAt = new Date(clock.now() + 40_000).toISOString();
  let calls = 0;
  await assert.rejects(retryWhileRuntimeBusy(async () => {
    calls += 1;
    clock.advance(5_000);
    throw paused();
  }, { delayMs: 1, leaseExpiresAt, now: clock.now }));

  // A 40s lease leaves 10s of budget once the margin for finishing the work and
  // recording it is taken out — so it may try again inside that, and must stop
  // before the lease somebody else can claim.
  const started = 1_000_000;
  assert.ok(clock.now() - started <= 40_000 - 30_000 + 5_000, `stopped after ${clock.now() - started}ms`);
  assert.ok(calls >= 1 && calls <= 3, `made ${calls} attempts`);
});

test("it repeats only the refusal that happened before anything else did", async () => {
  // `runtime_paused` is raised at admission: nothing was spawned, owned or
  // reserved, so calling again repeats nothing. Every other retryable refusal
  // may already have had an effect — a login, a logout — and repeating those is
  // how one becomes two.
  let calls = 0;
  await assert.rejects(retryWhileRuntimeBusy(async () => {
    calls += 1;
    throw Object.assign(new Error("project is busy"), { retryable: true });
  }, { delayMs: 1 }), /project is busy/);
  assert.equal(calls, 1, "a different retryable failure is not repeated");

  calls = 0;
  await assert.rejects(retryWhileRuntimeBusy(async () => {
    calls += 1;
    throw new Error("the runtime could not be launched");
  }, { delayMs: 1 }), /could not be launched/);
  assert.equal(calls, 1, "and neither is an ordinary failure");
});

test("an exhausted lease is refused before the call, not after it", async () => {
  const clock = fakeClock();
  let called = false;
  // Calling first and noticing afterwards is how a side effect happens outside
  // the claim that authorised it — the reproduction that found this returned
  // "side-effect-completed" against a lease that had already run out.
  await assert.rejects(retryWhileRuntimeBusy(async () => {
    called = true;
    return "side-effect-completed";
  }, { leaseExpiresAt: new Date(clock.now() - 1_000).toISOString(), now: clock.now }), /no time left/);
  assert.equal(called, false, "the body must not run at all");
});

test("a call that outlasts the lease is not waited on", async () => {
  const clock = fakeClock();
  // A supervisor request may take two minutes against a margin of thirty
  // seconds. The work is not cancellable from here; what this prevents is
  // waiting for it and then acting on a result that is no longer ours to act on.
  const leaseExpiresAt = new Date(clock.now() + 30_050).toISOString();
  await assert.rejects(
    retryWhileRuntimeBusy(() => new Promise((resolve) => setTimeout(resolve, 5_000)), {
      leaseExpiresAt,
      now: clock.now,
      onExpiry: async () => ({ stopped: false, reason: "the test does not cancel" }),
    }),
    /did not answer within the remaining lease/,
  );
});

test("an expired lease tears the connection down rather than only giving up on it", async () => {
  const clock = fakeClock();
  let torn = false;
  // `Promise.race` alone ends only this side's waiting: the request goes on
  // executing in the supervisor and the side effect lands after the caller has
  // given up. Closing the connection is what reaches the other end — the
  // supervisor kills every channel bound to a socket when that socket closes.
  await assert.rejects(
    retryWhileRuntimeBusy(() => new Promise((resolve) => setTimeout(resolve, 5_000)), {
      leaseExpiresAt: new Date(clock.now() + 30_050).toISOString(),
      now: clock.now,
      onExpiry: async () => { torn = true; return { stopped: false, reason: "not confirmed" }; },
    }),
    (error) => {
      assert.equal(error.leaseExpired, true);
      // Unknown, not failed. An operation that completed inside the supervisor
      // a moment before the connection dropped stays completed, and recording a
      // failure for it would be its own kind of wrong.
      assert.equal(error.outcomeUnknown, true);
      return true;
    },
  );
  assert.equal(torn, true, "the connection is closed when the lease runs out mid-call");
});

test("a confirmed cancellation is not an unknown outcome", async () => {
  const clock = fakeClock();
  // "Stopped" and "nobody knows" are different answers and the caller acts on
  // them differently: only the first lets the work be handed back. Reporting
  // both as unknown would make every lease overrun poison its job.
  await assert.rejects(
    retryWhileRuntimeBusy(() => new Promise((resolve) => setTimeout(resolve, 5_000)), {
      leaseExpiresAt: new Date(clock.now() + 30_050).toISOString(),
      now: clock.now,
      onExpiry: async () => ({ stopped: true }),
    }),
    (error) => {
      assert.equal(error.cancelled, true);
      assert.equal(error.outcomeUnknown, false);
      assert.match(error.message, /confirmed stopped/);
      return true;
    },
  );
});
