// The supervisor's side of a workspace access grant (migration 0060, WP-3c).
//
// The supervisor runs as root and changes who owns a project's tree. Until 11.1b
// the only thing it was told before doing that was a project id, and opening a
// Codex channel chowned the whole workspace away from an implementation that was
// writing in it (A1). Now every launch carries an opaque grant token, and the
// supervisor believes nothing the request says about access: it resolves the
// token against the database immediately before it acts, and checks that what
// the grant allows is what this launch is about to do.
//
// Kept apart from server.mjs, like runtime-admission and launch-control, so the
// rules can be tested without a socket, a database or the runtime accounts.

import { adapterFor } from "../operations/runtime-adapters.mjs";

// The refusals that clear on their own. A caller defers the work for these — no
// retry is spent — and fails for every other: a grant that is expired, revoked,
// for another project or for a run that has ended will not become valid by
// waiting. The database's own list for defer_runtime_job (0061) is the same.
export const TRANSIENT_GRANT_REFUSALS = new Set(["grant_writer_active"]);

export class GrantRefusedError extends Error {
  constructor(reason, message) {
    super(message ?? `workspace access grant refused: ${reason}`);
    this.name = "GrantRefusedError";
    // The reason travels as the error code, over the supervisor protocol, so the
    // worker can tell "a writer is busy" from "this grant is wrong" without
    // parsing a sentence.
    this.code = reason;
    this.retryable = TRANSIENT_GRANT_REFUSALS.has(reason);
  }
}

const TOKEN = /^[0-9a-f]{64}$/;

// Resolves a grant and checks it against the launch in hand.
//
//   token       what the worker was issued, opaque to it and to us
//   projectId   the project the request names
//   expect      what this launch needs: runtimeType and mode, and for a writer
//               the run and fencing token the request carries
//   queryJson   the database call, injected
//
// Returns the resolved grant with the Unix account the runtime runs as. The
// account comes from the adapter registry, never from the database and never
// from the request: a grant names a runtime type, and which account that is
// belongs to the registry (ADR-0012), where the PoC account names will be
// renamed once rather than wherever a literal happened to be written.
export async function resolveWorkspaceGrant({ token, projectId, expect }, queryJson) {
  if (typeof token !== "string" || !TOKEN.test(token)) {
    throw new GrantRefusedError("grant_malformed", "a launch must carry a workspace access grant token");
  }
  let grant;
  try {
    grant = await queryJson(
      "SELECT resolve_workspace_access_grant(:'token', :'project_id'::uuid)::text;",
      { token, project_id: projectId },
    );
  } catch (error) {
    // The migration puts a stable reason in DETAIL. Anything without one is a
    // failure of the check itself, and is not dressed up as a refusal.
    if (typeof error?.detail === "string" && /^grant_[a-z_]+$/.test(error.detail)) {
      throw new GrantRefusedError(error.detail, `workspace access grant refused: ${error.detail}`);
    }
    throw error;
  }
  if (!grant) throw new GrantRefusedError("grant_unknown");

  const mismatch = (what) => new GrantRefusedError("grant_launch_mismatch",
    `the workspace access grant does not cover this launch: ${what}`);
  if (grant.project_id !== projectId) throw mismatch("project");
  if (grant.runtime_type !== expect.runtimeType) throw mismatch("runtime");
  if (grant.mode !== expect.mode) throw mismatch("mode");
  if (expect.mode === "read_write") {
    if (grant.run_id !== expect.runId) throw mismatch("run");
    if (Number(grant.fencing_token) !== Number(expect.fencingToken)) throw mismatch("fencing token");
  }
  return { ...grant, account: adapterFor(grant.runtime_type).user };
}

// The worker's side: ask for a grant on a job it has claimed.
//
// The mode is not an argument — the database derives it from what the run is —
// and the token comes back once. A refusal is rethrown with its reason as the
// code, the same shape the supervisor sends, so a worker handles "a writer is
// busy" identically whether the database said it at issue or the supervisor said
// it at spawn.
export async function issueWorkspaceGrant(jobId, workerId, queryJson, { ttl = "10 minutes" } = {}) {
  try {
    const grant = await queryJson(
      "SELECT issue_workspace_access_grant(:'job_id'::bigint, :'worker_id', :'ttl'::interval)::text;",
      { job_id: jobId, worker_id: workerId, ttl },
    );
    if (typeof grant?.token !== "string") throw new Error("the database issued no grant token");
    return grant;
  } catch (error) {
    if (typeof error?.detail === "string" && /^grant_[a-z_]+$/.test(error.detail)) {
      throw new GrantRefusedError(error.detail);
    }
    throw error;
  }
}

// Which failures a worker defers instead of retrying. The same reasons
// defer_runtime_job (0061) accepts, and nothing else: a closed fence reopens and
// a writer finishes, while every other failure either will not clear by waiting
// or may already have had an effect.
// Since sprint C K3 also a host without memory for the run: it frees itself
// when a run ends (runtime-capacity.mjs).
const DEFERRABLE = new Set(["grant_writer_active", "runtime_paused", "runtime_capacity"]);
export function deferReasonFor(error) {
  return typeof error?.code === "string" && DEFERRABLE.has(error.code) ? error.code : null;
}

// Ownership changes of one workspace, one at a time.
//
// A grant is resolved and then the tree is chowned. Between those two steps a
// second launch in this same process could do the same for another runtime, and
// the two chowns would land in whichever order the event loop chose — which is
// the A1 race, moved from the database into the supervisor. Each launch resolves
// its grant and changes ownership while holding its workspace's turn, so the
// check and the act it justifies cannot be interleaved with another's.
export function createWorkspaceSerializer() {
  const tails = new Map();
  return async function inWorkspaceTurn(workspace, body) {
    const previous = tails.get(workspace) ?? Promise.resolve();
    let release;
    const mine = new Promise((resolve) => { release = resolve; });
    const tail = previous.then(() => mine);
    tails.set(workspace, tail);
    try {
      await previous;
      return await body();
    } finally {
      release();
      if (tails.get(workspace) === tail) tails.delete(workspace);
    }
  };
}
