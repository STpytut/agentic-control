// One request's handle on the work it started, and the one place that decides
// whether "stopped" may be said.
//
// The first version was an object literal with `stop: () => {}` replaced later,
// once the child existed. Two things were wrong with that, and both were
// reported as success:
//
//   * a cancel arriving before the real stopper was bound called the empty one
//     and answered `stopped: true`, after which the work started anyway;
//   * the real stopper signalled the process and returned. A signal is a
//     request. The process may ignore SIGTERM, may be in uninterruptible sleep,
//     may take a second to die — and until it is reaped, "stopped" is a guess.
//
// So cancellation is a state, not a call: once requested it stays requested, a
// stopper bound afterwards is run immediately, and the body refuses to start.
// And `stopped` is only true once the process is gone and has been seen to be
// gone.

export class LaunchControl {
  #stopper = null;
  #cancelRequested = false;
  #stopped = false;
  #stopping = null;

  get cancelRequested() {
    return this.#cancelRequested;
  }

  // Called once the thing that can be stopped exists. If a cancel arrived in the
  // meantime, this is where it takes effect — the window between "the request
  // was accepted" and "there is a child to kill" is exactly where the early
  // cancel lands.
  bind(stopper) {
    this.#stopper = stopper;
    if (this.#cancelRequested) this.#stopping = this.#run();
    return this;
  }

  // Refused by the body before it spawns anything. A request cancelled before it
  // started is genuinely stopped — nothing ever ran — and that is the only case
  // where `stopped` may be true without a process having died.
  assertNotCancelled() {
    if (this.#cancelRequested) {
      const error = new Error("the request was cancelled before it started");
      error.cancelledBeforeStart = true;
      throw error;
    }
  }

  async requestStop() {
    this.#cancelRequested = true;
    if (!this.#stopper) {
      // Nothing has been started. `assertNotCancelled` is what keeps that true,
      // and it runs before every spawn.
      this.#stopped = true;
      return { stopped: true, reason: "the work had not started" };
    }
    this.#stopping = this.#stopping ?? this.#run();
    return this.#stopping;
  }

  async #run() {
    try {
      await this.#stopper();
      this.#stopped = true;
      return { stopped: true };
    } catch (error) {
      return { stopped: false, reason: error.message };
    }
  }

  get stopped() {
    return this.#stopped;
  }
}

// Keeps the last `limit` characters a child wrote, from stdout and stderr both,
// in the order they arrived. A startup failure is explained by whatever the
// process said, and OpenCode says it on stdout: with only stderr kept, the
// account server's "startup timed out:" reached the operator with nothing after
// the colon. Reading both streams to the end also means a chatty server never
// blocks on a full pipe nobody drains.
export function captureOutputTail(child, limit = 4096) {
  let tail = "";
  for (const stream of [child.stdout, child.stderr]) {
    if (!stream) continue;
    stream.setEncoding("utf8");
    stream.on("data", (chunk) => {
      tail = `${tail}${chunk}`.slice(-limit);
    });
  }
  return () => tail;
}

// Ends a run that has already reported. Armed once its terminal report is
// accepted: after `graceMs` for a closing message, `terminate("SIGTERM")`, and
// SIGKILL `killAfterMs` later if it is still there. `ended()` says whether it
// was this that ended the run — so the exit it causes reads as the run ending
// as reported, not as a failure.
export function endAfterReport(terminate, { graceMs, killAfterMs = 5_000 }) {
  let ended = false;
  const timers = [];
  return {
    arm() {
      if (timers.length) return;
      timers.push(setTimeout(() => {
        ended = true;
        terminate("SIGTERM");
        timers.push(setTimeout(() => terminate("SIGKILL"), killAfterMs));
      }, graceMs));
    },
    ended: () => ended,
    clear() { for (const timer of timers) clearTimeout(timer); },
  };
}

// Stops a child and waits until it is actually gone.
//
// SIGTERM, a grace period, then SIGKILL — and then the part that was missing:
// waiting for the process to be reaped, and checking the process group is gone
// too, because a detached runtime leaves children of its own. Until both are
// true, saying "stopped" tells the caller it may hand the work back when the
// work may still be running.
export async function stopProcessGroup(child, { graceMs = 2_000, killWaitMs = 5_000 } = {}) {
  const pid = child.pid;
  const signalGroup = (signal) => {
    try {
      process.kill(-pid, signal);
    } catch {
      try { child.kill(signal); } catch { /* already gone */ }
    }
  };

  const exited = child.exitCode !== null || child.signalCode !== null
    ? Promise.resolve()
    : new Promise((resolve) => child.once("close", resolve));

  // `kill(-pid, 0)` on a group that still has members succeeds, which is the
  // difference between "the leader is gone" and "the work is over".
  const groupGone = () => {
    try {
      process.kill(-pid, 0);
      return false;
    } catch (error) {
      if (error.code === "ESRCH") return true;
      throw error;
    }
  };

  // Polled until a deadline, never probed once. The other members of the group
  // receive the same signal as the leader but finish dying on their own
  // schedule, so the instant the leader is reaped is exactly the instant a
  // member can still be exiting. The single probe that used to stand here
  // reported an ordinary stop as "still has members" — 7-8 runs in 120 under
  // load in the gate, with and without an init reaping orphans.
  const groupGoneBy = async (deadline) => {
    while (!groupGone()) {
      if (Date.now() >= deadline) return false;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return true;
  };

  // One grace period for the whole group, not one for the leader and another
  // for everything it started: a caller who asked for 2 s of grace should not
  // wait 4 s before SIGKILL.
  const graceDeadline = Date.now() + graceMs;

  signalGroup("SIGTERM");
  const died = await Promise.race([
    exited.then(() => true),
    new Promise((resolve) => setTimeout(() => resolve(false), graceMs)),
  ]);

  if (died && await groupGoneBy(graceDeadline)) return;

  // Either the leader outlived its grace, or it went and left members behind
  // that outlived it. Both end the same way.
  signalGroup("SIGKILL");
  const killDeadline = Date.now() + killWaitMs;
  const killed = await Promise.race([
    exited.then(() => true),
    new Promise((resolve) => setTimeout(() => resolve(false), killWaitMs)),
  ]);
  if (!killed) throw new Error(`process ${pid} did not exit after SIGKILL`);
  if (!await groupGoneBy(killDeadline)) {
    throw new Error(`process group ${pid} still has members after SIGKILL`);
  }
}
