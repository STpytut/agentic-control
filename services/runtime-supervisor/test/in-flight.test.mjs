// The requests a supervisor is executing, and stopping them.
//
// `channels` only ever covered the long-lived Codex paths. The OpenCode ones
// were ordinary awaited promises that nothing recorded — so closing the
// connection ended the client's waiting and the work carried on to completion,
// which is the opposite of what the client had been told.

import test from "node:test";
import assert from "node:assert/strict";
import {
  cancelInFlight,
  cancelInFlightFor,
  inFlightRequestCount,
  registerInFlight,
  resetInFlight,
} from "../in-flight.mjs";

test("a registered request can be stopped, and says so", async () => {
  resetInFlight();
  const socket = { id: "a" };
  let stopped = false;
  registerInFlight("req-1", socket, { stop: () => { stopped = true; return { stopped: true }; }, describe: "run_opencode" });

  const outcome = await cancelInFlight("req-1", socket);
  assert.deepEqual(
    { known: outcome.known, stopped: outcome.stopped },
    { known: true, stopped: true },
  );
  assert.equal(stopped, true);
});

test("only the connection that asked may cancel", async () => {
  resetInFlight();
  const mine = { id: "mine" };
  let stopped = false;
  registerInFlight("req-1", mine, { stop: () => { stopped = true; return { stopped: true }; } });

  const outcome = await cancelInFlight("req-1", { id: "somebody else" });
  assert.equal(outcome.stopped, false);
  assert.equal(stopped, false, "one client must not be able to end another's work");
});

test("a stop that fails is reported as not stopped", async () => {
  resetInFlight();
  const socket = { id: "a" };
  registerInFlight("req-1", socket, { stop: () => { throw new Error("the child would not die"); } });

  const outcome = await cancelInFlight("req-1", socket);
  // "Nobody knows" must never be dressed up as "stopped": the caller decides
  // whether to hand the work back on exactly this answer.
  assert.equal(outcome.stopped, false);
  assert.match(outcome.reason, /would not die/);
});

test("an unknown request is not claimed to have stopped", async () => {
  resetInFlight();
  const outcome = await cancelInFlight("never-registered", { id: "a" });
  assert.deepEqual(outcome, { known: false, stopped: false });
});

test("a closing connection takes its work with it", async () => {
  resetInFlight();
  const going = { id: "going" };
  const staying = { id: "staying" };
  const stopped = [];
  registerInFlight("req-1", going, { stop: () => { stopped.push("req-1"); return { stopped: true }; }, describe: "run_opencode" });
  registerInFlight("req-2", going, { stop: () => { stopped.push("req-2"); return { stopped: true }; }, describe: "opencode_account" });
  registerInFlight("req-3", staying, { stop: () => { stopped.push("req-3"); return { stopped: true }; } });

  const describes = await cancelInFlightFor(going);
  assert.deepEqual(stopped.sort(), ["req-1", "req-2"]);
  assert.deepEqual(describes.sort(), ["opencode_account", "run_opencode"]);
  assert.equal(inFlightRequestCount(), 1, "the other connection's work is untouched");
});


test("a stopper that reports it did not stop is not upgraded to stopped", async () => {
  resetInFlight();
  const socket = { id: "a" };
  // The registry reports what the control says. The first version reported
  // success because the call returned — true of an empty function, and of a
  // signal nobody waited on.
  registerInFlight("req-1", socket, { stop: () => ({ stopped: false, reason: "still running" }) });
  const outcome = await cancelInFlight("req-1", socket);
  assert.equal(outcome.stopped, false);
  assert.match(outcome.reason, /still running/);
});
