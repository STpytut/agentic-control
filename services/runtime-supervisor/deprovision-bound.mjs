// The bound on deprovision_project (WP-B, shipped with WP-5c, which moves the
// layout it deletes from).
//
// Before this, the client gave up after ten minutes and the supervisor carried
// on: the request was not registered in flight, so neither a cancel nor a closed
// socket reached it, and nothing stopped a second request for the same project
// from starting beside it — two deletions of one tree, on the destructive path.
//
// Three things now hold:
//   * one deprovision per project at a time, the second refused while the
//     first runs;
//   * a deadline, checked between phases and before any tree is removed;
//   * a cancel (or the client's socket closing) stops it at the next check,
//     and never between the check and the removal it guards.

export class DeprovisionRefused extends Error {
  constructor(message, code) {
    super(message);
    this.name = "DeprovisionRefused";
    this.code = code;
  }
}

export function createProjectSingleFlight() {
  const running = new Set();
  return async function once(projectId, body) {
    if (running.has(projectId)) {
      throw new DeprovisionRefused(`a deprovision of project ${projectId} is already running`, "deprovision_already_running");
    }
    running.add(projectId);
    try {
      return await body();
    } finally {
      running.delete(projectId);
    }
  };
}

// `control`: the request's LaunchControl; `now` for tests.
export function createDeprovisionDeadline({ control, ms, now = () => Date.now() }) {
  const deadline = now() + ms;
  return {
    get remainingMs() { return Math.max(0, deadline - now()); },
    // Throws when the work must stop here: cancelled, or out of time. Called
    // between phases and immediately before a tree is removed.
    check(stage) {
      if (control?.cancelRequested) {
        throw new DeprovisionRefused(`the deprovision was cancelled at ${stage}, before anything further was removed`, "deprovision_cancelled");
      }
      if (now() > deadline) {
        throw new DeprovisionRefused(`the deprovision ran past its ${Math.round(ms / 1000)}s bound at ${stage}, before anything further was removed`, "deprovision_deadline");
      }
    },
  };
}
