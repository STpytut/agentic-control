// The wait between polls, and the reason it is not `setTimeout` on its own.
//
// Every worker installs a SIGTERM handler that aborts a controller, and every
// worker's loop condition reads `signal.aborted` — which is correct and did
// nothing, because the process spends almost all of its life inside the wait,
// and an abort does not wake a sleeping timer. The loop condition is only
// consulted once the timer fires.
//
// systemd sets `TimeoutStopSec=20` on every unit. A worker polling every 15
// seconds happened to wake in time; a worker polling every 60 seconds did not,
// so eight of the fourteen services were SIGKILLed on every restart:
//
//   infra-cod-reconciler.service: State 'stop-sigterm' timed out. Killing.
//
// That is not tidiness. A worker killed mid-tick never releases the lease it
// holds or writes the terminal status it owes, which is how a workspace lock is
// left in `lease_expired` / `reconciliation_required` and a run is later
// reported `lost`. `infra-cod update` restarts the target, so this ran on every
// single update.
//
// Resolving on abort rather than rejecting: the caller's next act is to check
// `signal.aborted` and leave the loop. An `AbortError` would make every one of
// those call sites grow a catch to express the same thing.
export function waitForPoll(milliseconds, signal, wake = null) {
  if (signal?.aborted) return Promise.resolve();
  if (wake?.take()) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(finish, milliseconds);
    const unsubscribe = wake ? wake.subscribe(finish) : () => {};
    function finish() {
      clearTimeout(timer);
      signal?.removeEventListener?.("abort", finish);
      unsubscribe();
      resolve();
    }
    // `once` so a signal that aborts twice does not resolve twice, and the
    // listener is removed on the ordinary path so a long-lived signal does not
    // accumulate one listener per tick.
    signal?.addEventListener?.("abort", finish, { once: true });
  });
}

// A wake for the wait: something other than the clock saying there is work —
// a PostgreSQL NOTIFY, for the model check lane (Stage 12 W6), which should
// start a check within a second of it being asked for, not at the next poll.
// A wake that arrives while nobody waits is kept, so a request made during a
// tick is not lost to the wait that follows it.
export function createWake() {
  const waiting = new Set();
  let pending = false;
  return {
    notify() {
      if (waiting.size === 0) { pending = true; return; }
      for (const resolve of [...waiting]) resolve();
    },
    take() {
      const was = pending;
      pending = false;
      return was;
    },
    subscribe(resolve) {
      waiting.add(resolve);
      return () => waiting.delete(resolve);
    },
  };
}
