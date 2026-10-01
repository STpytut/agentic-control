// Cancellation, against real processes.
//
// The registry tests use stoppers that flip a boolean, which proves the
// bookkeeping and nothing about whether anything died. These start actual
// children — including one that ignores SIGTERM — because "stopped" is a claim
// about a process, and the previous version made that claim after sending a
// signal it never waited on.

import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { LaunchControl, captureOutputTail, endAfterReport, stopProcessGroup } from "../launch-control.mjs";

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

test("a cancel before the work starts stops it, and the work refuses to start", async () => {
  const control = new LaunchControl();

  // The window the empty stopper turned into a false confirmation: the request
  // is accepted, nothing has spawned yet, and a cancel arrives.
  const outcome = await control.requestStop();
  assert.deepEqual(
    { stopped: outcome.stopped, reason: outcome.reason },
    { stopped: true, reason: "the work had not started" },
  );

  // And the body must actually refuse, or "stopped" was a lie by one line.
  assert.throws(() => control.assertNotCancelled(), /cancelled before it started/);
});

test("a cancel racing the bind takes effect the moment there is something to stop", async () => {
  const control = new LaunchControl();
  await control.requestStop();

  // Bound after the cancel — the ordering that produced
  // `cancelReportedStopped: true` alongside `workStartedAfterCancel: true`.
  let stopped = false;
  control.bind(async () => { stopped = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(stopped, true, "a stopper bound after a cancel runs immediately");
});

test("a process that ignores SIGTERM is still gone before we say stopped", async () => {
  // `trap '' TERM` is the case a signal-and-return implementation gets wrong: it
  // reports stopped, and the process keeps running.
  const child = spawn("/bin/sh", ["-c", "trap '' TERM; sleep 30"], { detached: true, stdio: "ignore" });
  await new Promise((resolve) => child.once("spawn", resolve));
  const pid = child.pid;
  assert.equal(alive(pid), true);

  await stopProcessGroup(child, { graceMs: 300 });

  assert.equal(alive(pid), false, "the process is actually gone when this returns");
});

test("a child that exits on SIGTERM is reaped without escalation", async () => {
  const child = spawn("/bin/sh", ["-c", "sleep 30"], { detached: true, stdio: "ignore" });
  await new Promise((resolve) => child.once("spawn", resolve));
  const pid = child.pid;

  await stopProcessGroup(child, { graceMs: 2_000 });
  assert.equal(alive(pid), false);
});

test("the whole process group goes, not just the leader", async () => {
  // A runtime spawns children of its own. Killing the leader and declaring
  // victory leaves them running against a workspace nobody is watching.
  const child = spawn("/bin/sh", ["-c", "sleep 30 & sleep 30"], { detached: true, stdio: "ignore" });
  await new Promise((resolve) => child.once("spawn", resolve));
  const pid = child.pid;

  await stopProcessGroup(child, { graceMs: 300 });

  // `kill(-pid, 0)` succeeds while any member of the group is left, and
  // stopProcessGroup refuses to return until it does not.
  let groupAlive = true;
  try {
    process.kill(-pid, 0);
  } catch {
    groupAlive = false;
  }
  assert.equal(groupAlive, false, "no member of the group is left behind");
});

test("a group member still exiting is waited for, not reported as left behind", async () => {
  // The leader exits at once; the other member of its group takes a moment to
  // finish dying from the same SIGTERM. That is an ordinary stop, and it
  // succeeds a few hundred milliseconds later. A single probe taken the instant
  // the leader is reaped sees the member and reports "still has members".
  //
  // Under load this happened by itself: the gate failed "the whole process group
  // goes" in 7-8 runs of 120 with twelve in parallel, with and without an init
  // reaping orphans — so it was the probe, not a zombie. The member here makes
  // the window wide enough that the race is not a matter of luck.
  const child = spawn(
    "/bin/sh",
    ["-c", "sh -c 'trap \"sleep 0.4; exit 0\" TERM; while :; do sleep 0.05; done' & trap 'exit 0' TERM; wait"],
    { detached: true, stdio: "ignore" },
  );
  await new Promise((resolve) => child.once("spawn", resolve));
  // Let the member install its trap before the signal arrives.
  await new Promise((resolve) => setTimeout(resolve, 200));
  const pid = child.pid;

  await stopProcessGroup(child, { graceMs: 2_000 });

  let groupAlive = true;
  try {
    process.kill(-pid, 0);
  } catch {
    groupAlive = false;
  }
  assert.equal(groupAlive, false, "the member finished exiting before stopProcessGroup returned");
});

test("a member that ignores SIGTERM after its leader has gone is killed, not waited on forever", async () => {
  // The leader obeys SIGTERM; a member of its group does not. Waiting for the
  // group is only safe if the wait ends in SIGKILL — otherwise the fix for the
  // probe would turn a stubborn child into a stop that never returns.
  const child = spawn(
    "/bin/sh",
    ["-c", "sh -c 'trap \"\" TERM; while :; do sleep 0.05; done' & trap 'exit 0' TERM; wait"],
    { detached: true, stdio: "ignore" },
  );
  await new Promise((resolve) => child.once("spawn", resolve));
  await new Promise((resolve) => setTimeout(resolve, 200));
  const pid = child.pid;

  const started = Date.now();
  await stopProcessGroup(child, { graceMs: 300, killWaitMs: 2_000 });

  let groupAlive = true;
  try {
    process.kill(-pid, 0);
  } catch {
    groupAlive = false;
  }
  assert.equal(groupAlive, false, "the stubborn member is gone");
  assert.ok(Date.now() - started < 2_000, "and it took SIGKILL, not the whole kill budget");
});

test("a stop that cannot finish is reported as not stopped", async () => {
  const control = new LaunchControl();
  control.bind(async () => { throw new Error("the child would not exit"); });

  const outcome = await control.requestStop();
  assert.equal(outcome.stopped, false);
  assert.match(outcome.reason, /would not exit/);
  assert.equal(control.stopped, false, "and it does not remember a stop that did not happen");
});

// OpenCode's account server explains a failed start on stdout. The supervisor
// kept only stderr, and "startup timed out:" reached the operator empty.
test("a startup failure keeps what the child said on stdout as well as stderr, bounded", async () => {
  // The bound, on one stream: across two, which chunk lands last is up to the OS.
  const child = spawn(process.execPath, ["-e", `
    process.stdout.write("listening failed: EADDRINUSE\\n");
    process.stdout.write("x".repeat(100));
  `], { stdio: ["ignore", "pipe", "pipe"] });
  const output = captureOutputTail(child, 64);
  await new Promise((resolve) => child.once("close", resolve));
  const tail = output();
  assert.equal(tail.length, 64);
  assert.ok(tail.endsWith("x".repeat(40)));

  const whole = spawn(process.execPath, ["-e", `
    process.stdout.write("listening failed: EADDRINUSE\\n");
    process.stderr.write("warn: retrying\\n");
  `], { stdio: ["ignore", "pipe", "pipe"] });
  const all = captureOutputTail(whole);
  await new Promise((resolve) => whole.once("close", resolve));
  assert.match(all(), /listening failed: EADDRINUSE/);
  assert.match(all(), /warn: retrying/);
});

// On rc.39 the free model kept its process alive for minutes after its
// `complete_task` was accepted, and the executor waited for it. Once armed by an
// accepted report, the run ends after the grace — and says it was this.
test("a run that has reported is ended after the grace, and knows it was ended as reported", async () => {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  const closed = new Promise((resolve) => child.once("close", (code, signal) => resolve({ code, signal })));
  const end = endAfterReport((signal) => child.kill(signal), { graceMs: 100, killAfterMs: 2_000 });
  assert.equal(end.ended(), false);
  end.arm();
  end.arm(); // a second accepted call does not re-arm or shorten it
  // So a helper that never fires fails here instead of hanging the suite.
  const backstop = setTimeout(() => child.kill("SIGKILL"), 3_000);
  const { signal } = await closed;
  clearTimeout(backstop);
  end.clear();
  assert.equal(signal, "SIGTERM");
  assert.equal(end.ended(), true);
});

test("a run that never reports is not ended by the report grace", async () => {
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 400)"], { stdio: "ignore" });
  const closed = new Promise((resolve) => child.once("close", (code, signal) => resolve({ code, signal })));
  const end = endAfterReport((signal) => child.kill(signal), { graceMs: 50 });
  const { code, signal } = await closed;
  end.clear();
  assert.equal(code, 0);
  assert.equal(signal, null);
  assert.equal(end.ended(), false);
});
