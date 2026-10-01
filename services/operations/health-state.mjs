// The database half of the health snapshot: the statement that reads it, the
// alerts it raises, and the statement that records what the runtimes are.
//
// Kept apart from health-snapshot.mjs, which runs as root and does its work at
// import, so that the gate can ask the same questions of a real database the
// timer asks on the host. Two copies of "is a dead letter still open" — one here
// and one in a test — would be two answers that drift; 0072's way back from
// dead_letter is proven against this one.

export const DATABASE_STATE_SQL = `SELECT jsonb_build_object(
    -- runs_* keep meaning implementation and revision runs, as they did before
    -- 0059 made every Codex turn a run. Turns are counted on their own: a quiet
    -- conversation and a stuck writer are different facts, and one number would
    -- hide which of the two it is.
    'runs_active',(SELECT count(*) FROM task_runs WHERE write_capable AND status IN ('starting','running')),
    'runs_queued',(SELECT count(*) FROM task_runs WHERE write_capable AND status='queued'),
    'runs_waiting',(SELECT count(*) FROM task_runs WHERE write_capable AND status IN ('waiting_for_input','blocked')),
    'runs_failed_24h',(SELECT count(*) FROM task_runs WHERE write_capable AND status IN ('failed','lost') AND updated_at>clock_timestamp()-interval '24 hours'),
    'turns_active',(SELECT count(*) FROM task_runs WHERE NOT write_capable AND status IN ('starting','running')),
    'turns_failed_24h',(SELECT count(*) FROM task_runs WHERE NOT write_capable AND status='failed' AND updated_at>clock_timestamp()-interval '24 hours'),
    'locks_held',(SELECT count(*) FROM workspace_locks WHERE status='held'),
    'locks_expired',(SELECT count(*) FROM workspace_locks WHERE status='held' AND lease_expires_at<=clock_timestamp()),
    'outbox_pending',(SELECT count(*) FROM outbox_messages WHERE status IN ('pending','in_flight')),
    'outbox_dead_letter',(SELECT count(*) FROM outbox_messages WHERE status='dead_letter'),
    'outbox_lag_seconds',COALESCE((SELECT extract(epoch FROM clock_timestamp()-min(available_at)) FROM outbox_messages WHERE status IN ('pending','in_flight')),0),
    'runtime_jobs_pending',(SELECT count(*) FROM runtime_jobs WHERE status IN ('pending','in_flight')),
    'runtime_jobs_dead_letter',(SELECT count(*) FROM runtime_jobs WHERE status='dead_letter' AND resolved_at IS NULL),
    'oldest_runtime_job_seconds',COALESCE((SELECT extract(epoch FROM clock_timestamp()-min(available_at)) FROM runtime_jobs WHERE status IN ('pending','in_flight')),0),
    'catalog_refresh_in_progress',(SELECT count(*) FROM catalog_refresh_jobs j
      JOIN provider_connections c ON c.id=j.connection_id
      WHERE c.provider IN ('codex','opencode') AND j.status IN ('pending','in_progress')),
    'catalog_refresh_failed',(SELECT count(*) FROM (
      SELECT DISTINCT ON (j.connection_id) j.status
      FROM catalog_refresh_jobs j
      JOIN provider_connections c ON c.id=j.connection_id
      WHERE c.provider IN ('codex','opencode')
      ORDER BY j.connection_id,j.created_at DESC
    ) latest WHERE latest.status='failed'),
    -- A superseded row (0098) is history, not a model its list stopped naming;
    -- 'stale' and 'verifying' are no longer statuses (0106).
    'catalog_unavailable_entries',(SELECT count(*) FROM provider_model_catalog WHERE status='unavailable' AND superseded_by IS NULL),
    'catalog_verified_entries',(SELECT count(*) FROM provider_model_catalog WHERE status='verified'),
    'catalog_refresh_stuck_seconds',COALESCE((SELECT extract(epoch FROM clock_timestamp()-min(created_at)) FROM catalog_refresh_jobs WHERE status='in_progress' AND leased_until<=clock_timestamp()),0)
  )::text;`;

// The one row the dispatch gate reads (0054, 0072). Removing a runtime reaches
// the database through this statement and no other.
export const RUNTIME_HEALTH_UPSERT_SQL = `INSERT INTO runtime_health(singleton,status,snapshot,observed_at)
   VALUES (true,:'status',:'snapshot'::jsonb,:'observed_at'::timestamptz)
   ON CONFLICT (singleton) DO UPDATE SET
     status=EXCLUDED.status,snapshot=EXCLUDED.snapshot,observed_at=EXCLUDED.observed_at
   RETURNING jsonb_build_object('status',status,'observed_at',observed_at)::text;`;

export function databaseAlerts(state, { eventLagWarn = 60 } = {}) {
  const alerts = [];
  const add = (severity, code, message) => alerts.push({ severity, code, message });
  if (Number(state.locks_expired) > 0) add("critical", "workspace_lock_expired", `${state.locks_expired} held locks are expired`);
  if (Number(state.outbox_dead_letter) + Number(state.runtime_jobs_dead_letter) > 0) add("warning", "dead_letters_present", "dead-letter work requires operator review");
  if (Number(state.catalog_refresh_failed) > 0) add("warning", "catalog_refresh_failed", `${state.catalog_refresh_failed} catalog refreshes failed`);
  if (Number(state.catalog_refresh_stuck_seconds) > 0) add("warning", "catalog_refresh_stuck", "a catalog refresh lease is stuck");
  if (Number(state.outbox_lag_seconds) > eventLagWarn) add("warning", "event_dispatch_lag", `outbox lag is ${state.outbox_lag_seconds}s`);
  return alerts;
}

// 0 healthy, 1 degraded, 2 critical.
export function healthStatusOf(alerts) {
  return alerts.some((item) => item.severity === "critical") ? 2 : alerts.length ? 1 : 0;
}

export const HEALTH_STATUS_NAMES = ["healthy", "degraded", "critical"];
