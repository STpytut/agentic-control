-- Probation after a promotion (migration 0104): only a runtime-class failure
-- at the promoted version fails it; three runs and a day pass it.
\set ON_ERROR_STOP on

BEGIN;
SET search_path TO control_plane, public, extensions;

DO $$
DECLARE v_q uuid; v_promoted uuid; v_verdict jsonb; v_row runtime_activations%ROWTYPE;
BEGIN
  -- What counts as the runtime's fault, and what never does.
  IF runtime_dispatch_failure_class('{"status":"exited","exit_code":0}') <> 'none' THEN RAISE EXCEPTION 'a clean exit is a failure'; END IF;
  IF runtime_dispatch_failure_class('{"status":"completed"}') <> 'none' THEN RAISE EXCEPTION 'a completed turn is a failure'; END IF;
  IF runtime_dispatch_failure_class('{"status":"exited","exit_code":1}') <> 'other' THEN RAISE EXCEPTION 'an exit code alone was called the runtime''s'; END IF;
  IF runtime_dispatch_failure_class('{"status":"exited","exit_code":null,"signal":"SIGSEGV"}') <> 'runtime' THEN RAISE EXCEPTION 'a segfault was not the runtime''s'; END IF;
  IF runtime_dispatch_failure_class('{"status":"exited","signal":"SIGTERM","interrupted":true}') <> 'other' THEN RAISE EXCEPTION 'an interrupt was called a crash'; END IF;
  IF runtime_dispatch_failure_class('{"status":"failed","error":"thread panicked at linux-sandbox: filesystem-restricted execution requires bubblewrap"}') <> 'runtime' THEN RAISE EXCEPTION 'a sandbox panic was not the runtime''s'; END IF;
  IF runtime_dispatch_failure_class('{"status":"failed","error":"You have hit your usage limit; try again at 14:20"}') <> 'other' THEN RAISE EXCEPTION 'a usage limit was called the runtime''s'; END IF;
  IF runtime_dispatch_failure_class('{"status":"failed","error":"model_not_found: sandbox error while resolving"}') <> 'other' THEN RAISE EXCEPTION 'a model refusal was called the runtime''s'; END IF;
  IF runtime_dispatch_failure_class('{"status":"not_reported","job_ended":"job_lease_expired"}') <> 'other' THEN RAISE EXCEPTION 'a lost lease was called the runtime''s'; END IF;
  IF runtime_dispatch_failure_class('{"status":"launch_failed","error":"spawn /opt/x ENOEXEC: exec format error"}') <> 'runtime' THEN RAISE EXCEPTION 'an executable that cannot run was not the runtime''s'; END IF;

  -- A promotion opens a probation of three runs and a day.
  v_q := begin_runtime_qualification('opencode','1.18.32','1.0.0','0.4.0-rc.83','root');
  PERFORM record_qualification_check(v_q,'package.signature','','passed','',1,'');
  PERFORM finish_runtime_qualification(v_q, ARRAY['package.signature']);
  v_promoted := record_runtime_activation('opencode','promote','1.18.32','1.18.31', v_q, false, '', 'root');
  SELECT * INTO v_row FROM runtime_activations WHERE id = v_promoted;
  IF v_row.probation_runs <> 3 OR v_row.probation_until <> v_row.activated_at + interval '24 hours' THEN
    RAISE EXCEPTION 'the probation was not opened: %', row_to_json(v_row);
  END IF;
  v_verdict := runtime_probation_verdict('opencode');
  IF v_verdict->>'state' <> 'running' OR (v_verdict->>'runs_seen')::int <> 0 THEN RAISE EXCEPTION 'no runs is not running: %', v_verdict; END IF;
  IF runtime_probation_verdict('claude')->>'state' <> 'none' THEN RAISE EXCEPTION 'a runtime never promoted has a probation'; END IF;
  BEGIN
    PERFORM end_runtime_probation(v_promoted);
    RAISE EXCEPTION 'a running probation was ended as passed';
  EXCEPTION WHEN SQLSTATE '55000' THEN NULL;
  END;
END $$;

-- Dispatch attempts, without the jobs and selections behind them: the verdict
-- reads only the attempts.
SET session_replication_role = replica;
INSERT INTO runtime_dispatch_attempts(job_id, selection_id, attempt_number, runtime_type, executable, adapter_version, runtime_version,
  capability_verification, access_mode, worker_id, surface, started_at, finished_at, native_result)
SELECT 900000 + n, 900000 + n, 1, 'opencode', 'opencode', '1.0.0', v, 'verified', 'read_only', 'test', 'project',
  clock_timestamp() + interval '1 second', clock_timestamp() + interval '2 seconds', r::jsonb
FROM (VALUES
  (1, '1.18.32', '{"status":"exited","exit_code":0}'),
  (2, '1.18.32', '{"status":"exited","exit_code":1}'),
  (3, '1.18.32', '{"status":"failed","error":"You have hit your usage limit"}'),
  (4, '1.18.31', '{"status":"exited","signal":"SIGSEGV"}')
) AS s(n, v, r);
SET session_replication_role = origin;

DO $$
DECLARE v_verdict jsonb; v_id uuid;
BEGIN
  -- Three runs at the version, none the runtime's fault, but not yet a day: still running.
  -- A crash of the *previous* version is not this version's.
  v_verdict := runtime_probation_verdict('opencode');
  IF v_verdict->>'state' <> 'running' OR (v_verdict->>'runs_seen')::int <> 3 OR jsonb_array_length(v_verdict->'failures') <> 0 THEN
    RAISE EXCEPTION 'three harmless runs within the day: %', v_verdict;
  END IF;
  -- A day later, it passes, and ends once.
  v_id := (v_verdict->>'activation_id')::uuid;
  UPDATE runtime_activations SET probation_until = clock_timestamp() - interval '1 minute' WHERE id = v_id;
  IF runtime_probation_verdict('opencode')->>'state' <> 'passed' THEN RAISE EXCEPTION 'three runs and a day did not pass'; END IF;
  PERFORM end_runtime_probation(v_id, 'probation timer');
  IF runtime_probation_verdict('opencode')->>'state' <> 'none' THEN RAISE EXCEPTION 'an ended probation is still open'; END IF;
END $$;

-- A runtime-class failure fails the next probation, and the rollback closes it.
DO $$
DECLARE v_q uuid; v_verdict jsonb; v_view jsonb;
BEGIN
  v_q := begin_runtime_qualification('opencode','1.18.33','1.0.0','0.4.0-rc.83','root');
  PERFORM record_qualification_check(v_q,'package.signature','','passed','',1,'');
  PERFORM finish_runtime_qualification(v_q, ARRAY['package.signature']);
  PERFORM record_runtime_activation('opencode','promote','1.18.33','1.18.32', v_q, false, '', 'root');
END $$;
SET session_replication_role = replica;
INSERT INTO runtime_dispatch_attempts(job_id, selection_id, attempt_number, runtime_type, executable, adapter_version, runtime_version,
  capability_verification, access_mode, worker_id, surface, started_at, finished_at, native_result)
VALUES (900010, 900010, 1, 'opencode', 'opencode', '1.0.0', '1.18.33', 'verified', 'read_only', 'test', 'project',
  clock_timestamp() + interval '1 second', clock_timestamp() + interval '2 seconds', '{"status":"exited","signal":"SIGABRT"}');
SET session_replication_role = origin;
DO $$
DECLARE v_verdict jsonb; v_view jsonb;
BEGIN
  v_verdict := runtime_probation_verdict('opencode');
  IF v_verdict->>'state' <> 'failing' OR v_verdict->'failures'->0->>'signal' <> 'SIGABRT' THEN RAISE EXCEPTION 'a crash did not fail the probation: %', v_verdict; END IF;
  PERFORM record_runtime_activation('opencode','rollback','1.18.32','1.18.33', NULL, false, 'probation: SIGABRT', 'probation');
  IF runtime_probation_verdict('opencode')->>'state' <> 'none' THEN RAISE EXCEPTION 'the rollback left the probation open'; END IF;
  v_view := get_runtime_activations();
  IF v_view->1->'probation'->>'result' <> 'rolled_back' OR v_view->1->'probation'->>'detail' <> 'probation: SIGABRT' THEN
    RAISE EXCEPTION 'the panel does not show the rollback of the probation: %', v_view->1;
  END IF;
  IF v_view->2->'probation'->>'result' <> 'passed' THEN RAISE EXCEPTION 'the passed probation is not shown: %', v_view->2; END IF;
  RAISE NOTICE 'probation fails only on the runtime''s own failures, and a rollback closes it';
END $$;

ROLLBACK;
