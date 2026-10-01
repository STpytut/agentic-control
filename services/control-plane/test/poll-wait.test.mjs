import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { waitForPoll } from "../poll-wait.mjs";

const controlPlane = path.resolve(import.meta.dirname, "..");
const systemdDir = path.resolve(import.meta.dirname, "../../../deploy/systemd");

test("an abort ends the wait instead of running it out", async () => {
  const controller = new AbortController();
  const started = Date.now();
  const waiting = waitForPoll(60_000, controller.signal);
  controller.abort();
  await waiting;
  assert.ok(Date.now() - started < 1_000, "the wait outlived the abort");
});

test("a signal already aborted does not start a wait at all", async () => {
  const controller = new AbortController();
  controller.abort();
  const started = Date.now();
  await waitForPoll(60_000, controller.signal);
  assert.ok(Date.now() - started < 1_000);
});

test("without a signal it still waits", async () => {
  const started = Date.now();
  await waitForPoll(30);
  assert.ok(Date.now() - started >= 25);
});

// One tick must not leave a listener behind on a signal the process holds for
// its whole life.
test("the ordinary path leaves no listener on the signal", async () => {
  const controller = new AbortController();
  for (let i = 0; i < 50; i += 1) await waitForPoll(1, controller.signal);
  const count = typeof controller.signal.listenerCount === "function"
    ? controller.signal.listenerCount("abort")
    : 0;
  assert.ok(count <= 1, `abort listeners accumulated: ${count}`);
});

// The defect this replaced was not in any one worker. Every worker installed a
// SIGTERM handler, aborted a controller, and then slept through the abort in a
// bare `setTimeout` — so the loop condition was only read once the full poll
// interval had passed. With `TimeoutStopSec=20` on every unit, the eight
// workers polling every 60 seconds were SIGKILLed on every restart, and a
// worker killed mid-tick releases no lease and writes no terminal status.
//
// Checking each worker individually would let the next one be written the old
// way. This checks the shape across the whole directory.
test("no worker waits in a way a signal cannot interrupt", () => {
  const offenders = [];
  const unsignalled = [];
  for (const name of readdirSync(controlPlane)) {
    if (!name.endsWith(".mjs") || name === "poll-wait.mjs") continue;
    const source = readFileSync(path.join(controlPlane, name), "utf8");
    if (/setTimeout\(\s*resolve/.test(source)) offenders.push(name);
    // A `waitForPoll(ms)` with no signal is the same defect wearing the new
    // helper's name. The project provisioner had one: the poll between ticks was
    // fixed and its inner wait for a supervisor operation was not, so that one
    // service was still SIGKILLed on every restart while the rest stopped
    // cleanly. Its five-minute ceiling against TimeoutStopSec=20 is the whole
    // story.
    for (const call of source.matchAll(/waitForPoll\(([^)]*)\)/g)) {
      if (!call[1].includes(",")) unsignalled.push(`${name}: waitForPoll(${call[1]})`);
    }
  }
  assert.deepEqual(offenders, [], "these wait in a bare timer that SIGTERM cannot cut short");
  assert.deepEqual(unsignalled, [], "these wait without a signal, so SIGTERM cannot cut them short either");
});

// The pairing that made the defect visible on some units and not others: a
// worker whose poll interval exceeds its unit's stop timeout is killed rather
// than stopped. The wait is interruptible now, so this is no longer load-bearing
// — it is here so that a future unit with a shorter timeout, or a worker with a
// longer interval, is a test failure rather than another SIGKILL in the journal.
test("every unit's stop timeout is stated, and no unit relies on the default", () => {
  const missing = [];
  for (const name of readdirSync(systemdDir)) {
    if (!name.endsWith(".service")) continue;
    const unit = readFileSync(path.join(systemdDir, name), "utf8");
    // Oneshot units run to completion; the timeout that matters is for the
    // long-running ones.
    if (/Type\s*=\s*oneshot/.test(unit)) continue;
    if (!/TimeoutStopSec\s*=/.test(unit)) missing.push(name);
  }
  assert.deepEqual(missing, [], "these long-running units fall back to systemd's 90s default");
});

// Stage 12 W6: the check lane is woken by a NOTIFY, not only by the clock.
test("a wake ends the wait, and one that came between waits is kept", async () => {
  const { createWake } = await import("../poll-wait.mjs");
  const wake = createWake();
  let started = Date.now();
  const waiting = waitForPoll(60_000, null, wake);
  wake.notify();
  await waiting;
  assert.ok(Date.now() - started < 1_000, "the wait outlived the wake");
  // Nobody waiting: the wake is kept for the next wait, and used once.
  wake.notify();
  started = Date.now();
  await waitForPoll(60_000, null, wake);
  assert.ok(Date.now() - started < 1_000, "a wake between waits was lost");
  started = Date.now();
  await waitForPoll(30, null, wake);
  assert.ok(Date.now() - started >= 25, "one wake ended two waits");
});
