import test from "node:test";
import assert from "node:assert/strict";

import { createDeprovisionDeadline, createProjectSingleFlight } from "../deprovision-bound.mjs";
import { LaunchControl } from "../launch-control.mjs";

test("a second deprovision of the same project is refused while the first runs", async () => {
  const once = createProjectSingleFlight();
  let release;
  const first = once("p1", () => new Promise((resolve) => { release = resolve; }));
  await assert.rejects(once("p1", async () => "second"), (error) => error.code === "deprovision_already_running");
  assert.equal(await once("p2", async () => "other project"), "other project");
  release("first");
  assert.equal(await first, "first");
  assert.equal(await once("p1", async () => "after"), "after", "the project was not released after the first finished");
});

test("a failed deprovision releases its project", async () => {
  const once = createProjectSingleFlight();
  await assert.rejects(once("p1", async () => { throw new Error("boom"); }), /boom/);
  assert.equal(await once("p1", async () => "again"), "again");
});

test("the deadline and a cancel stop the work at the next check", async () => {
  let clock = 0;
  const control = new LaunchControl();
  const deadline = createDeprovisionDeadline({ control, ms: 1_000, now: () => clock });
  deadline.check("start");
  clock = 1_001;
  assert.throws(() => deadline.check("before removal"), (error) => error.code === "deprovision_deadline" && /before removal/.test(error.message));

  const cancelled = createDeprovisionDeadline({ control, ms: 60_000, now: () => clock });
  await control.requestStop();
  assert.throws(() => cancelled.check("phase 2"), (error) => error.code === "deprovision_cancelled");
});
