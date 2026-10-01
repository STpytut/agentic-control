// One log line, with a stable field set (WP-8a, prework B2).
//
// What exists is good — domain_events, audit_events, runtime_activity_events,
// runtime_health. What was missing is connection: about fifty event-type
// prefixes, each worker inventing its own JSON, and `correlation_id` reaching
// the log in two files out of eleven. So one operation could not be followed
// across services even when every service had logged it.
//
// Field names follow the OpenTelemetry convention **where the meaning matches**
// — `service.name`, severity, timestamp — and without the SDK. An application
// correlation id stays `correlation_id` and is **not** written as `trace_id`: a
// trace id belongs to a real tracing context with spans and parents, and an
// arbitrary id in that field would make the first genuine tracing integration
// wrong. Explicitly not now: Prometheus, Grafana, Loki, a collector. The host
// is 4 GB and sits at 1380 MB under load, and none of the five causes B2 lists
// would have been prevented by a graph.
//
// `type` is kept as the first-class name of the line because every existing
// reader — journal greps, the acceptance runs — already reads it.

import { envelopeOf, failureChain } from "./failure.mjs";

// The service this process is. Taken from the unit's own name where systemd
// provides it, so the field is not one more thing to keep in step by hand.
const serviceName = process.env.INFRA_COD_SERVICE
  ?? ((process.env.SYSTEMD_UNIT ?? "").replace(/^infra-cod-/, "").replace(/\.service$/, "") || "infra-cod");

// The id that ties a line to the operation the database recorded. A worker sets
// it once per job; everything that layer logs afterwards carries it.
let currentCorrelationId = null;

export function setCorrelationId(id) {
  currentCorrelationId = id ?? null;
}

export function correlationId() {
  return currentCorrelationId;
}

// Runs `work` with `id` as the correlation id, and restores whatever was there
// before — a worker handling one job inside a loop that has its own.
export async function withCorrelationId(id, work) {
  const previous = currentCorrelationId;
  currentCorrelationId = id ?? null;
  try {
    return await work();
  } finally {
    currentCorrelationId = previous;
  }
}

function line(severity, type, fields, stream) {
  stream.write(`${JSON.stringify({
    timestamp: new Date().toISOString(),
    severity,
    "service.name": serviceName,
    type,
    ...(currentCorrelationId ? { correlation_id: currentCorrelationId } : {}),
    ...fields,
  })}\n`);
}

export function logInfo(type, fields = {}, out = process.stdout) {
  line("info", type, fields, out);
}

export function logWarn(type, fields = {}, err = process.stderr) {
  line("warn", type, fields, err);
}

// A failure is logged as the envelope, not as one sentence. `failure` carries
// the code and what this layer was attempting; `cause` carries the chain down
// to the thing that actually refused — which is the half that was being dropped.
export function logFailure(type, error, fields = {}, err = process.stderr) {
  const envelope = envelopeOf(error);
  const chain = failureChain(error);
  line("error", type, {
    ...fields,
    code: envelope.code,
    retryable: envelope.retryable,
    error: envelope.safe_message,
    ...(envelope.operation ? { operation: envelope.operation } : {}),
    ...(envelope.details && Object.keys(envelope.details).length ? { details: envelope.details } : {}),
    ...(chain.length > 1 ? { cause: chain.slice(1) } : {}),
    ...(envelope.correlation_id && !currentCorrelationId ? { correlation_id: envelope.correlation_id } : {}),
  }, err);
}
