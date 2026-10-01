// One envelope for a failure, from the database to the journal (WP-8a,
// prework B2).
//
// Four times in one stage the system knew the cause and did not say it. What
// reached the operator, and what was true:
//
//   OpenCode account server startup timed out:   EROFS on .config/opencode (86)
//   OpenCode exited with code 1:                 EROFS on the model cache (93)
//   ?github=error                                a function not granted to infra_web (89, 90)
//   run.lost: workspace_lease_expired            column lm.model does not exist (92)
//   complete_task error                          the gateway answered and logged nothing (105)
//
// Each of those is the same shape: a layer caught an error, wrote a sentence of
// its own, and dropped what it was holding. The envelope exists so that a layer
// can say what it was doing without discarding what it was told.
//
// The fields are prework B2's, and `cause` is the one that does the work: an
// outer layer sets it, never replaces the message underneath.

// The closed vocabulary. A code names what went wrong in terms the product
// understands, not the sentence a library happened to produce. `unknown` is
// deliberately in the list: a failure nothing has classified yet is still an
// envelope, and pretending otherwise would put a wrong code on it.
export const FAILURE_CODES = Object.freeze([
  // The caller asked for something that cannot be done as asked.
  "invalid_argument",
  "not_found",
  "conflict",            // a version, an idempotency key, a state that moved
  "permission_denied",
  // The work was refused for now, and asking again later is the right move.
  "unavailable",         // a dependency is down or busy
  "timeout",
  "lease_lost",          // someone else owns the work now
  // The host, rather than the request.
  "filesystem",          // EROFS, EACCES, ENOSPC — 86 and 93 were both this
  "process_failed",      // a spawned runtime exited non-zero
  "protocol",            // a malformed or oversized message
  "database",            // the server refused the statement itself
  // Classified, and not this layer's to fix.
  "internal",
  "unknown",
]);

const RETRYABLE_BY_DEFAULT = new Set(["unavailable", "timeout", "lease_lost"]);

export class InfraError extends Error {
  // `cause` is standard on Error and is used as standard here: the envelope one
  // layer down, kept rather than replaced.
  constructor(safeMessage, {
    code = "unknown",
    retryable,
    cause,
    details,
    correlationId,
    operation,
  } = {}) {
    super(safeMessage, cause === undefined ? undefined : { cause });
    if (!FAILURE_CODES.includes(code)) {
      throw new Error(`${JSON.stringify(code)} is not a failure code; the vocabulary is ${FAILURE_CODES.join(", ")}`);
    }
    this.name = "InfraError";
    this.code = code;
    this.retryable = retryable ?? RETRYABLE_BY_DEFAULT.has(code);
    this.details = details;
    this.correlationId = correlationId;
    this.operation = operation;
  }
}

// What a layer adds when it catches: what it was attempting, and the id the
// database events already carry. Everything else comes from underneath.
//
// A correlation id is *not* written as `trace_id`, here or in the log. A trace
// id belongs to a real tracing context with spans and parents; putting an
// application id in that field would make the first genuine tracing integration
// wrong, and 11.5 is where tracing arrives.
export function wrapFailure(error, { operation, correlationId, code, safeMessage, details, retryable } = {}) {
  const inner = envelopeOf(error);
  return new InfraError(safeMessage ?? inner.safe_message, {
    code: code ?? inner.code,
    retryable: retryable ?? inner.retryable,
    cause: error,
    details,
    correlationId: correlationId ?? inner.correlation_id,
    operation: operation ?? inner.operation,
  });
}

// PostgreSQL's own classes, mapped once. A statement the server refuses to parse
// is `database`, not `internal`: defect 92 spent three retries and a lease on a
// column that did not exist, and no number of attempts was going to create it.
function codeForSqlState(sqlState) {
  if (!sqlState) return null;
  switch (sqlState) {
    case "22023": return "invalid_argument";
    case "23505": return "conflict";
    // Class 23 is an integrity violation, and every one of them is something
    // the caller sent: a null into a NOT NULL column, a key that does not
    // exist, a CHECK it does not satisfy. Read as `unknown` on the host after
    // rc.36, when a missing `checks_summary` reached the table.
    case "23502": case "23503": case "23514": return "invalid_argument";
    case "40001": case "40P01": return "unavailable";   // serialization, deadlock
    case "55000": return "conflict";                    // object not in prerequisite state
    case "57014": return "timeout";                     // query cancelled
    case "42501": return "permission_denied";
    default: break;
  }
  // 08xxx connection, 53xxx insufficient resources, 57Pxx admin shutdown.
  if (/^(08|53|57P)/.test(sqlState)) return "unavailable";
  // 42xxx syntax or access rule: the statement itself is wrong.
  if (/^42/.test(sqlState)) return "database";
  return null;
}

const FILESYSTEM_ERRNO = new Set(["EROFS", "EACCES", "EPERM", "ENOSPC", "ENOENT", "EEXIST", "EISDIR", "ENOTDIR"]);

// The reason a database function put in `DETAIL`, as JSON beside the human
// sentence. `submit_worker_completion` distinguished six conditions and raised
// one sentence for all of them, which is why a worker resubmitted an accepted
// completion five times (defect 104).
function detailReason(error) {
  const detail = error?.detail;
  if (typeof detail !== "string" || !detail.startsWith("{")) return null;
  try {
    const parsed = JSON.parse(detail);
    return typeof parsed?.reason === "string" ? parsed : null;
  } catch {
    return null;
  }
}

// Read any error as an envelope. A plain Error becomes one with what can be
// established and `unknown` for what cannot — never a guess.
export function envelopeOf(error) {
  if (error instanceof InfraError) {
    return {
      code: error.code, retryable: error.retryable, safe_message: error.message,
      details: error.details, correlation_id: error.correlationId, operation: error.operation,
      cause: error.cause === undefined ? undefined : envelopeOf(error.cause),
    };
  }
  const reason = detailReason(error);
  const code = codeForSqlState(error?.code)
    ?? (FILESYSTEM_ERRNO.has(error?.code) ? "filesystem" : null)
    ?? (error?.code === "ETIMEDOUT" ? "timeout" : null)
    ?? (error?.code === "ECONNREFUSED" || error?.code === "ECONNRESET" ? "unavailable" : null)
    ?? "unknown";
  return {
    code,
    retryable: error?.retryable === true || RETRYABLE_BY_DEFAULT.has(code),
    safe_message: typeof error?.message === "string" ? error.message : String(error),
    details: {
      ...(reason ? { reason: reason.reason, ...reason } : {}),
      ...(error?.code && !FAILURE_CODES.includes(error.code) ? { sqlstate_or_errno: error.code } : {}),
      ...(error?.path ? { path: error.path } : {}),
      ...(error?.syscall ? { syscall: error.syscall } : {}),
    },
    correlation_id: error?.correlationId,
    operation: error?.operation,
  };
}

// The chain, outermost first, for a log line or a receipt. The whole point is
// that this is not one sentence: `["starting the account server", "EROFS on
// /home/codex-worker/.config/opencode"]` is the answer defect 86 never gave.
export function failureChain(error) {
  const chain = [];
  for (let envelope = envelopeOf(error); envelope; envelope = envelope.cause) {
    chain.push({ code: envelope.code, message: envelope.safe_message,
      ...(envelope.operation ? { operation: envelope.operation } : {}) });
    if (chain.length >= 8) break;   // a cycle, or a chain nobody will read
  }
  return chain;
}

// The reason a database function named, if it named one. Callers branch on this
// instead of matching on a sentence — the six conditions of defect 104 are six
// reasons, and a sentence is not one of them.
export function failureReason(error) {
  for (let envelope = envelopeOf(error); envelope; envelope = envelope.cause) {
    if (typeof envelope.details?.reason === "string") return envelope.details.reason;
  }
  return null;
}
