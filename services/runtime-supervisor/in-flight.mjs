// The requests this supervisor is executing right now, and how to stop them.
//
// `channels` covers the long-lived ones: a Codex app-server channel is in that
// map, bound to the socket that opened it, and the socket's close handler kills
// it. The OpenCode paths are not. `run_opencode_gate`, `opencode_account` and
// `run_opencode` are ordinary awaited promises that spawn a child and return a
// result — nothing records them, so nothing could stop them. Closing the
// connection ended the client's *waiting* and the work carried on to completion,
// which is precisely the guarantee the client was told it had.
//
// So every request that spawns anything registers here, with the means to stop
// it and the socket that asked for it. Two things then become possible that were
// not before: a client can cancel a request it has run out of lease for and be
// told whether the work actually stopped, and a socket closing takes its
// in-flight work with it instead of orphaning it.

const inFlight = new Map();

export function registerInFlight(requestId, socket, { stop, describe = "request" }) {
  if (!requestId) return () => {};
  inFlight.set(requestId, { socket, stop, describe, stopped: false });
  return () => inFlight.delete(requestId);
}

// Stops one request and reports whether it can be said to have stopped.
//
// "Stopped" here means the means of stopping it ran without throwing — the
// child was signalled. It does not mean nothing happened: a `login` that
// completed a millisecond before the signal stays completed, and no amount of
// signalling reaches back before that. The caller is told which of the two it
// has, and must not record a failure for the second.
export async function cancelInFlight(requestId, socket) {
  const entry = inFlight.get(requestId);
  if (!entry) return { known: false, stopped: false };
  if (entry.socket !== socket) return { known: true, stopped: false, reason: "another connection owns this request" };
  try {
    // The control answers whether it stopped; this does not decide for it. The
    // first version called the stopper and reported success because the call
    // returned — which was true of an empty function, and of a signal nobody
    // had waited on.
    const outcome = await entry.stop();
    entry.stopped = outcome?.stopped === true;
    return {
      known: true,
      stopped: entry.stopped,
      reason: outcome?.reason,
      describe: entry.describe,
    };
  } catch (error) {
    return { known: true, stopped: false, reason: error.message };
  }
}

// Everything a closing socket was waiting on. A client that has gone is a client
// whose work nobody will read the result of.
export async function cancelInFlightFor(socket) {
  const stopped = [];
  for (const [requestId, entry] of inFlight) {
    if (entry.socket !== socket) continue;
    try {
      const outcome = await entry.stop();
      if (outcome?.stopped === true) stopped.push(entry.describe);
    } catch { /* best effort: the socket is already gone */ }
    inFlight.delete(requestId);
  }
  return stopped;
}

export function inFlightRequestCount() {
  return inFlight.size;
}

export function resetInFlight() {
  inFlight.clear();
}
