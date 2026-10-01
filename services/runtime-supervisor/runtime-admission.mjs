// Whether a runtime may be launched right now, and how many launches are in
// flight.
//
// This exists because of what the alternative turned out to be. Fencing a
// runtime switch by stopping `infra-cod-runtime-supervisor.service` looked like
// a fence and was a blunt instrument: the unit is shared by both runtimes, and
// its shutdown terminates every child channel. Installing Codex would have
// killed a live OpenCode session — the exact harm the rule against replacing a
// tree under running work exists to prevent. Stopping the surface also cannot
// close the race it was meant to close: a session admitted a moment before the
// stop is killed by the stop rather than protected from it.
//
// So the fence is here, where admission is decided, and it is per runtime:
//
//   * `pause(name)` — new launches of that runtime are refused from this moment.
//     Launches of the *other* runtime, and everything already running, continue
//     untouched.
//   * `inFlight(name)` — how many launches of that runtime are open. The caller
//     waits for zero; nothing is killed to get there.
//   * `resume(name)` — admissions accepted again.
//
// A paused runtime refuses with a retryable error: "not now" is a different
// statement from "this will never work", and the workers already distinguish
// them.

// A fence is owned by the connection that asked for it.
//
// Holding it in a plain map, asked for and released over separate short-lived
// connections, gets both failure directions wrong. If the installer is killed,
// nothing ever resumes the runtime and it stays fenced until somebody notices.
// If the supervisor restarts, the fence silently disappears while a live
// installer carries on believing it holds one — and switches the tree with no
// fence at all.
//
// Tying it to a connection fixes both at once, because a socket has exactly the
// lifetime that matters: it dies when either end dies. The installer keeps one
// open for the whole switch; its close resumes the runtime, and its loss tells
// the installer the supervisor is gone.
import { FenceUnavailableError, holdRuntimeFence } from "./runtime-fence.mjs";

const paused = new Map();
const live = new Map();

export class RuntimePausedError extends Error {
  constructor(name, reason) {
    super(
      `${name} is not accepting launches: ${reason}. `
      + "A runtime installation is in progress; this will work again when it finishes.",
    );
    this.name = "RuntimePausedError";
    // The workers retry a retryable failure instead of parking the job.
    this.retryable = true;
    // Named, not merely "retryable". Other refusals carry that flag too — a
    // project that is busy, a lock that is held — and retrying one of those can
    // repeat work that already had an effect. This one is raised at admission,
    // before anything is spawned or owned, so nothing has happened yet: that is
    // what makes it safe to repeat, and the name is how a caller can tell.
    this.code = "runtime_paused";
  }
}

export function pauseRuntime(name, reason = "maintenance", owner = null) {
  const held = paused.get(name);
  if (held && held.owner !== owner) {
    // Two installers at once would each believe they had the fence, and the
    // first to release it would open the door under the second.
    throw new Error(`${name} is already held by another installation (${held.reason})`);
  }
  paused.set(name, { reason, since: new Date().toISOString(), owner });
  return runtimeAdmissionStatus(name);
}

export function resumeRuntime(name, owner = null) {
  const held = paused.get(name);
  // Releasing somebody else's fence is how the door opens mid-switch.
  if (held && owner !== null && held.owner !== owner) {
    throw new Error(`${name} is held by another installation; this connection cannot release it`);
  }
  paused.delete(name);
  return runtimeAdmissionStatus(name);
}

// Called when a connection goes away, for whatever reason — the installer
// finished, crashed, or was killed. Anything it was holding is released.
export function releaseOwner(owner) {
  const released = [];
  for (const [name, held] of paused) {
    if (held.owner === owner) {
      paused.delete(name);
      released.push(name);
    }
  }
  return released;
}

export function runtimeAdmissionStatus(name) {
  const state = paused.get(name) ?? null;
  return {
    runtime: name,
    paused: state !== null,
    reason: state?.reason ?? null,
    since: state?.since ?? null,
    in_flight: inFlightCount(name),
  };
}

export function inFlightCount(name) {
  return live.get(name)?.size ?? 0;
}

// Called at the top of every launch path, before anything is spawned, owned or
// reserved. The check and the registration happen together: Node runs this
// function to completion without interleaving, so there is no window between
// deciding a launch is admissible and counting it.
export function admit(name, token) {
  const state = paused.get(name);
  if (state) throw new RuntimePausedError(name, state.reason);
  if (!live.has(name)) live.set(name, new Set());
  live.get(name).add(token);
  return token;
}

// Admission, and the kernel lock that makes it mean something across processes.
//
// The in-process check is still first, because it gives the caller a useful
// sentence rather than "the lock was busy". But the guarantee is the shared
// lock: an installation holds the file exclusively, so a supervisor that started
// a second ago — knowing nothing of any pause — cannot take this and cannot
// launch. That is the case no amount of in-process bookkeeping could reach.
// The memory gate (runtime-capacity.mjs), set by the supervisor at startup.
// Asked before the fence, so a launch refused for memory holds nothing.
let capacityGate = null;
export function setCapacityGate(gate) {
  capacityGate = gate;
}

// `background` marks a run no task waits for — a model check, a qualification
// — which the memory gate admits only with room left for a task run after it.
export async function takeLaunchPlace(name, { hold = holdRuntimeFence, capacity = capacityGate, background = false } = {}) {
  const state = paused.get(name);
  if (state) throw new RuntimePausedError(name, state.reason);
  if (capacity) await capacity.check(name, { background });
  const token = `${name}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  admit(name, token);

  let fence;
  try {
    fence = await hold(name, { mode: "shared" });
  } catch (error) {
    release(name, token);
    if (error instanceof FenceUnavailableError) throw new RuntimePausedError(name, "a runtime installation holds the fence");
    throw error;
  }

  let done = false;
  return {
    release() {
      if (done) return;
      done = true;
      fence.release();
      release(name, token);
    },
  };
}

export function release(name, token) {
  live.get(name)?.delete(token);
}

// For the launch paths that run to completion inside one call rather than
// living as a channel.
export async function withAdmission(name, body, { hold = holdRuntimeFence, capacity = capacityGate, background = false } = {}) {
  const place = await takeLaunchPlace(name, { hold, capacity, background });
  try {
    return await body();
  } finally {
    place.release();
  }
}

export function resetAdmission() {
  paused.clear();
  live.clear();
}
