// The fence, tested where it lives.
//
// The installer's suite can only observe the fence through a socket; these are
// the promises the supervisor itself makes.

import test from "node:test";
import assert from "node:assert/strict";
import {
  RuntimePausedError,
  admit,
  inFlightCount,
  pauseRuntime,
  releaseOwner,
  release,
  resetAdmission,
  resumeRuntime,
  runtimeAdmissionStatus,
  withAdmission,
} from "../runtime-admission.mjs";

test("pausing one runtime says nothing about the other", () => {
  resetAdmission();
  pauseRuntime("codex", "installation");

  assert.throws(() => admit("codex", "a"), RuntimePausedError);
  // The unit is shared; the fence must not be. Stopping the service was the
  // earlier answer, and it would have ended live OpenCode sessions to install
  // Codex.
  assert.doesNotThrow(() => admit("opencode", "b"));
  assert.equal(runtimeAdmissionStatus("opencode").paused, false);

  resumeRuntime("codex");
  assert.doesNotThrow(() => admit("codex", "c"));
});

test("a paused runtime refuses retryably", () => {
  resetAdmission();
  pauseRuntime("codex", "installation");
  try {
    admit("codex", "a");
    assert.fail("it must refuse");
  } catch (error) {
    // "Not now" is a different statement from "this will never work", and the
    // workers park a job on the second one.
    assert.equal(error.retryable, true);
    assert.match(error.message, /will work again/);
  }
});

test("what is already running is counted, and never ended", () => {
  resetAdmission();
  admit("codex", "one");
  admit("codex", "two");
  assert.equal(inFlightCount("codex"), 2);

  // Pausing does not touch them: the installer waits for zero, it does not
  // arrange zero.
  const status = pauseRuntime("codex", "installation");
  assert.equal(status.in_flight, 2);

  release("codex", "one");
  assert.equal(inFlightCount("codex"), 1);
  release("codex", "two");
  assert.equal(inFlightCount("codex"), 0);
});

test("a launch that throws is not left in flight forever", async () => {
  resetAdmission();
  await assert.rejects(withAdmission("opencode", async () => { throw new Error("the launch failed"); }));
  assert.equal(inFlightCount("opencode"), 0, "a failed launch releases its place");
});

test("a launch that fails before it starts gives its place back", async () => {
  resetAdmission();
  // The three Codex paths hold their place until the channel closes, so every
  // way out before the close handler is attached has to release it. Counting a
  // failed preparation as a live launch would make an installer wait for a zero
  // that never arrives — for the life of the supervisor.
  const ticket = admit("codex", "one");
  assert.equal(inFlightCount("codex"), 1);

  const failing = async () => {
    try {
      throw new Error("ownership transfer failed");
    } catch (error) {
      release("codex", ticket);
      throw error;
    }
  };
  await assert.rejects(failing);
  assert.equal(inFlightCount("codex"), 0);
});

test("admission is decided and counted in one step", () => {
  resetAdmission();
  // There is no window between "this is admissible" and "this is counted": if
  // there were, a pause could land in it and the installer would see zero while
  // a launch was on its way to being spawned.
  admit("codex", "one");
  pauseRuntime("codex", "installation");
  assert.equal(runtimeAdmissionStatus("codex").in_flight, 1);
  assert.throws(() => admit("codex", "two"), RuntimePausedError);
  assert.equal(runtimeAdmissionStatus("codex").in_flight, 1);
});

test("a fence belongs to the connection that took it", () => {
  resetAdmission();
  const installer = { id: "installer" };
  const somebodyElse = { id: "else" };

  pauseRuntime("codex", "installation", installer);

  // Nobody else may take it, and nobody else may give it back: releasing
  // somebody else's fence is how the door opens mid-switch.
  assert.throws(() => pauseRuntime("codex", "another installation", somebodyElse), /already held/);
  assert.throws(() => resumeRuntime("codex", somebodyElse), /cannot release it/);
  assert.equal(runtimeAdmissionStatus("codex").paused, true);

  // And whatever became of the holder, its connection closing releases it.
  assert.deepEqual(releaseOwner(installer), ["codex"]);
  assert.equal(runtimeAdmissionStatus("codex").paused, false);
});


test("admission is taken before anything else happens in a launch", async () => {
  // `runtime_paused` is classified as safe to repeat because it is raised before
  // anything is spawned, owned or reserved. That is a property of how the launch
  // paths are written, not something the type system enforces — so it is pinned
  // here: if a future path admits after doing work, this fails and the retry
  // classification has to be revisited with it.
  const { readFileSync } = await import("node:fs");
  const server = readFileSync(new URL("../server.mjs", import.meta.url), "utf8");

  // Since WP-5b every channel — each surface of each driver — opens through
  // one function, so there is one body to hold to the rule.
  const launchPaths = [
    "async function openChannel(socket, request, driver, surface, control = new LaunchControl()) {",
  ];
  for (const signature of launchPaths) {
    const start = server.indexOf(signature);
    assert.notEqual(start, -1, `${signature} still exists`);
    const body = server.slice(start + signature.length, server.indexOf("\n}\n", start));
    const admitAt = body.indexOf("takeLaunchPlace(");
    assert.notEqual(admitAt, -1, `${signature} takes an admission place`);

    // Nothing that spawns, transfers ownership or reserves may come first.
    for (const effect of ["spawn(", "transferOwnership(", "reserve_runtime_launch"]) {
      const effectAt = body.indexOf(effect);
      if (effectAt !== -1) {
        assert.ok(admitAt < effectAt, `${signature} admits before ${effect}`);
      }
    }
  }

  // Runs and account operations go through `withAdmission`, which takes the
  // place before it calls the body at all — for whichever driver the request
  // names. Registering the request for cancellation happens first, and is
  // allowed to: it records how to stop the work, it does not start any.
  for (const dispatch of ['request.type === "runtime_run" || request.type === "runtime_account"']) {
    const at = server.indexOf(dispatch);
    assert.notEqual(at, -1, `${dispatch} still exists`);
    const block = server.slice(at, at + 1600);
    const admitAt = block.indexOf("withAdmission(driver.name,");
    assert.notEqual(admitAt, -1, `${dispatch} goes through withAdmission`);
    for (const effect of ["spawn(", "transferOwnership(", "reserve_runtime_launch"]) {
      const effectAt = block.indexOf(effect);
      if (effectAt !== -1) assert.ok(admitAt < effectAt, `${dispatch} admits before ${effect}`);
    }
  }
});

test("a fence lock on a replaced file is not reported as held", async () => {
  const { mkdtempSync, rmSync, mkdirSync } = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");

  const base = mkdtempSync(path.join(os.tmpdir(), "fence-inode-"));
  const directory = path.join(base, "runtime-fence");
  mkdirSync(directory, { recursive: true });
  const { holdRuntimeFence } = await import("../runtime-fence.mjs");

  const holder = await holdRuntimeFence("codex", { mode: "exclusive", fenceDir: directory });
  assert.equal(holder.held(), true);

  // What systemd does to a RuntimeDirectory when its unit stops. The lock
  // survives on the unlinked inode, so the old holder would go on believing it
  // excluded everybody while a new process took a lock on a brand-new file at
  // the same path — two holders, no exclusion, and the fence missing at exactly
  // the moment a restart made it matter.
  rmSync(directory, { recursive: true, force: true });
  mkdirSync(directory, { recursive: true });

  assert.equal(holder.held(), false, "a lock on a file that is no longer at this path excludes nobody");

  const newcomer = await holdRuntimeFence("codex", { mode: "shared", fenceDir: directory });
  assert.equal(newcomer.held(), true, "and the new file is genuinely free, which is why the old answer had to change");

  holder.release();
  newcomer.release();
  rmSync(base, { recursive: true, force: true });
});
