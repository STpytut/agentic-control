// The loop every service runs, and the frame the leased ones claim work in
// (WP-6, prework B1).
//
// Why a primitive rather than eleven copies: defect 101 was one bug in twelve
// identical loops, and defect 106 was the copy the fix did not reach. The loops
// had drifted apart in ways nobody chose — three isolated an error from the tick
// and eight let it end the process, three announced themselves on start and
// eight did not, and five carried a private copy of the redaction,
// one of which redacted two things the other four did not. None of that was a decision; it was eleven
// authors.
//
// Two layers, not one framework. The terminal semantics of a dispatcher, a
// leased runtime worker, an account broker, the reconciler and the destructive
// deprovision worker are genuinely different, and a single claim/handle/report
// frame would make four of the five pretend. So:
//
// * `runPollLoop` is the part they all share — the wait that a SIGTERM can
//   interrupt, error isolation, and one shape of log line.
// * `runLeasedJob` is for the ones that claim leased work, and owns only the
//   vocabulary and the reporting around one job.
//
// Not in scope: the runtime supervisor. It is not a poll-loop worker.

import { envelopeOf, failureChain } from "./failure.mjs";
import { logFailure, withCorrelationId } from "./log.mjs";
import { waitForPoll } from "./poll-wait.mjs";

// A message that leaves the process. Secrets reach errors by accident — a token
// in a URL, a key in a spawned command's stderr — and a log line is the one
// place they are kept forever, so the redaction is here rather than in five
// private copies.
//
// Those copies had drifted, and this is the widest of them, not the common
// part: only the OpenCode broker's redacted `rk-` keys and email addresses, and
// narrowing to what all five shared would have started writing an operator's
// address into the journal.
// Bounded at 500 characters from the front, because that is the shape of a
// message: what it was, first. A tail of a runtime's own output is not a
// message — it is evidence, and WP-8b attaches it to the failure — so that
// caller asks for a longer bound and for the *end* of it, where the thing that
// went wrong is.
export function redactError(error, fallback = "The operation failed.", transientValues = [],
  { maxLength = 500, keep = "head" } = {}) {
  let value = error instanceof Error ? error.message : String(error ?? fallback);
  for (const transient of transientValues) {
    if (transient) value = value.replaceAll(String(transient), "[REDACTED]");
  }
  return value
    .replace(/\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, "[REDACTED]")
    .replace(/\b(sk|sess|key|rk)-[A-Za-z0-9_-]{16,}\b/g, "[REDACTED]")
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[REDACTED_EMAIL]")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .slice(...(keep === "tail" ? [-maxLength] : [0, maxLength])) || fallback;
}

function write(stream, payload) {
  stream.write(`${JSON.stringify(payload)}\n`);
}

// `tick` runs one cycle and returns what it did. A cycle that did nothing
// returns nothing, an empty array or an empty object, and is not logged: a
// worker polling every 15 seconds would otherwise fill the journal with proof
// that it had no work.
function didSomething(result) {
  if (result === undefined || result === null || result === false) return false;
  if (Array.isArray(result)) return result.length > 0;
  if (typeof result === "object") return Object.keys(result).length > 0;
  return true;
}

// The loop.
//
// `signal` is the process's shutdown. The wait is interruptible because the
// alternative was measured: systemd sets TimeoutStopSec=20, and a worker asleep
// in a 60-second timer is SIGKILLed mid-tick, which leaves the lease it holds
// and the terminal status it owes unwritten (see poll-wait.mjs).
//
// An error from `tick` ends the cycle, not the loop. Before this, three services
// isolated it and eight did not, so a transient database error restarted those
// eight — and a restart is not free: it takes the shutdown path, which is where
// the leases are released.
export async function runPollLoop({
  name,
  pollMs,
  signal,
  tick,
  once = false,
  ready = true,
  // Ends the wait early (poll-wait.mjs, createWake); the poll stays the fallback.
  wake = null,
  fallbackMessage,
  out = process.stdout,
  err = process.stderr,
}) {
  if (!name) throw new Error("a poll loop needs a name: it is the log line's type");
  if (typeof tick !== "function") throw new Error(`${name}: a poll loop needs a tick`);
  if (ready && !once) write(out, { type: `${name}.ready`, pid: process.pid });
  let cycles = 0;
  let failures = 0;
  do {
    cycles += 1;
    try {
      const result = await tick();
      if (didSomething(result)) write(out, { type: name, ...(Array.isArray(result) ? { results: result } : result) });
    } catch (error) {
      failures += 1;
      // The whole envelope, not one sentence: a cycle that failed because a
      // column does not exist and one that failed because the server went away
      // are the same line otherwise, and only one of them is worth retrying
      // (defects 92 and 101).
      logFailure(`${name}.failed`, error,
        { error: redactError(error, fallbackMessage ?? `${name} failed.`) }, err);
    }
    if (!once && !signal?.aborted) await waitForPoll(pollMs, signal, wake);
  } while (!once && !signal?.aborted);
  return { name, cycles, failures };
}

// Aborting the loop on SIGINT and SIGTERM, which every service did identically
// and by hand.
export function shutdownSignal(signals = ["SIGINT", "SIGTERM"]) {
  const controller = new AbortController();
  for (const name of signals) process.once(name, () => controller.abort());
  return controller.signal;
}

// ------------------------------------------------------- one leased job
//
// The vocabulary is not invented here. Each word was established the hard way
// in 11.1, and collapsing any two of them cost something:
//
// * `deferred` — letting a lease lapse silently lost the work for three of four
//   paths (defect 35). A deferral gives the attempt back.
// * `outcome_unknown` — recording a failure for something that may have
//   succeeded is a lie about the operator's account (49).
// * `cancelled` — treating an interruption as a failure recorded a rejected
//   model (53).
// * `needs_attention` — work that no retry will fix, and that must reach an
//   operator rather than a dead-letter queue nobody reads.
export const JOB_OUTCOMES = Object.freeze([
  "completed", "retryable", "deferred", "cancelled", "outcome_unknown", "needs_attention",
]);

// A claimed job carries the id in its payload, where route_outbox_message put
// the source event's; `to_jsonb(j)` of the row is what a worker holds.
function correlationIdOf(job) {
  const value = job?.correlation_id ?? job?.payload?.correlation_id;
  return typeof value === "string" && value ? value : null;
}

function outcomeOf(value, where) {
  const outcome = typeof value === "string" ? { outcome: value } : value ?? {};
  if (!JOB_OUTCOMES.includes(outcome.outcome)) {
    throw new Error(`${where} answered ${JSON.stringify(outcome.outcome)}, which is not one of ${JOB_OUTCOMES.join(", ")}`);
  }
  return outcome;
}

// One job, from a claim that already happened to the row that records how it
// ended.
//
// `handle` does the work and returns an outcome; a throw is classified by
// `classify`, which defaults to `retryable` because that is what a worker
// meeting an unexpected error should do with a lease it still holds. `report`
// writes the outcome where the database expects it — that part cannot be shared,
// because a chat turn, an account operation and a project deletion are recorded
// by three different functions.
//
// A failing `report` never ends the loop and is never reported as a failure of
// the job: the job's outcome is what it is, and the loss of the report is its
// own line. That is the shape the workers already used — `catch {}` around the
// retry call, with the status defaulting to `lease_lost` — made explicit.
export async function runLeasedJob({
  name,
  job,
  handle,
  report,
  classify,
  out = process.stdout,
  err = process.stderr,
}) {
  // The handler's own throw is caught; the vocabulary check is not, so a handler
  // that answers a word nobody implements is a defect in the worker rather than
  // one more retry.
  let answer;
  let thrown;
  try {
    // Everything this job logs carries the id the database events already
    // carry, so one operation can be followed across services — which is what
    // `correlation_id` reaching the log in two files out of eleven prevented.
    // The handler learns the id from the job's context and hands it back, so a
    // job whose context has not been read yet simply logs without one.
    answer = await withCorrelationId(correlationIdOf(job), () => handle(job));
  } catch (error) {
    thrown = error;
  }
  const result = thrown
    ? { ...outcomeOf(classify ? classify(thrown) : "retryable", `${name}: classify`), error: thrown }
    : outcomeOf(answer, `${name}: handle`);
  let reported;
  let reportError;
  if (report) {
    try {
      reported = await report(result, job);
    } catch (error) {
      reportError = error;
    }
  }
  const failure = result.error ? envelopeOf(result.error) : null;
  const chain = result.error ? failureChain(result.error) : [];
  const line = {
    type: `${name}.${result.outcome}`,
    jobId: job?.id,
    // The reason the worker classified by, or the one the database named. The
    // second is why 0067 exists: six conditions shared one sentence, and a
    // worker resubmitted an accepted completion five times (defect 104).
    ...(result.reason ?? failure?.details?.reason ? { reason: result.reason ?? failure.details.reason } : {}),
    ...(result.detail !== undefined ? { detail: result.detail } : {}),
    ...(reported !== undefined ? { reported } : {}),
    ...(failure ? { code: failure.code, error: redactError(result.error) } : {}),
    ...(chain.length > 1 ? { cause: chain.slice(1) } : {}),
  };
  write(result.outcome === "completed" ? out : err, line);
  if (reportError) {
    write(err, { type: `${name}.unreported`, jobId: job?.id, outcome: result.outcome, error: redactError(reportError) });
  }
  return { ...result, reported };
}
