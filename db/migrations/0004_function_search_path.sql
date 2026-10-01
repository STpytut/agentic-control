BEGIN;

ALTER FUNCTION control_plane.reject_append_only_mutation()
  SET search_path = control_plane, public;
ALTER FUNCTION control_plane.submit_command(uuid, uuid, text, text, text, text, jsonb, bigint, text)
  SET search_path = control_plane, public;
ALTER FUNCTION control_plane.append_event(text, uuid, uuid, uuid, text, text, uuid, text, text, text, uuid, bigint, jsonb, text)
  SET search_path = control_plane, public;
ALTER FUNCTION control_plane.acquire_workspace_lock(uuid, uuid, text, interval)
  SET search_path = control_plane, public;
ALTER FUNCTION control_plane.assert_workspace_fence(uuid, uuid, bigint)
  SET search_path = control_plane, public;
ALTER FUNCTION control_plane.heartbeat_workspace_lock(uuid, uuid, bigint, interval)
  SET search_path = control_plane, public;
ALTER FUNCTION control_plane.release_workspace_lock(uuid, uuid, bigint)
  SET search_path = control_plane, public;
ALTER FUNCTION control_plane.claim_outbox(text, integer, interval)
  SET search_path = control_plane, public;
ALTER FUNCTION control_plane.acknowledge_outbox(bigint, text)
  SET search_path = control_plane, public;
ALTER FUNCTION control_plane.reject_terminal_run_regression()
  SET search_path = control_plane, public;

ALTER FUNCTION control_plane.request_implementation(uuid, uuid, uuid, uuid, integer, text, jsonb, jsonb, jsonb, jsonb, text, text, bigint, text)
  SET search_path = control_plane, public;
ALTER FUNCTION control_plane.start_implementation(uuid, uuid, text, interval)
  SET search_path = control_plane, public;
ALTER FUNCTION control_plane.complete_implementation(uuid, uuid, uuid, uuid, uuid, bigint, jsonb, jsonb, text, bigint, text)
  SET search_path = control_plane, public;
ALTER FUNCTION control_plane.claim_outbox_event(uuid, text, interval)
  SET search_path = control_plane, public;

ALTER FUNCTION control_plane.retry_outbox_message(bigint, text, text, interval, integer)
  SET search_path = control_plane, public;
ALTER FUNCTION control_plane.route_outbox_message(bigint, text)
  SET search_path = control_plane, public;
ALTER FUNCTION control_plane.claim_runtime_jobs(text, integer, interval)
  SET search_path = control_plane, public;
ALTER FUNCTION control_plane.claim_runtime_job_for_event(uuid, text, text, interval)
  SET search_path = control_plane, public;
ALTER FUNCTION control_plane.heartbeat_runtime_job(bigint, text, interval)
  SET search_path = control_plane, public;
ALTER FUNCTION control_plane.acknowledge_runtime_job(bigint, text, jsonb)
  SET search_path = control_plane, public;
ALTER FUNCTION control_plane.retry_runtime_job(bigint, text, text, interval, integer)
  SET search_path = control_plane, public;
ALTER FUNCTION control_plane.start_implementation_job(bigint, uuid, text, interval)
  SET search_path = control_plane, public;
ALTER FUNCTION control_plane.reconcile_expired_workspace_locks(text, integer)
  SET search_path = control_plane, public;

COMMIT;
