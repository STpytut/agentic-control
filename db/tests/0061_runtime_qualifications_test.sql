-- Qualifications of runtime versions (migration 0096): the result is derived,
-- never asserted by the caller.
\set ON_ERROR_STOP on

BEGIN;
SET search_path TO control_plane, public, extensions;

DO $$
DECLARE v_id uuid; v_result jsonb; v_view jsonb;
BEGIN
  -- Complete and green: passed.
  v_id := begin_runtime_qualification('opencode','1.18.32','1.0.0','0.4.0-rc.78','root','{"lsm":"landlock"}');
  PERFORM record_qualification_check(v_id,'package.signature','',  'passed','',120,'signed by the pinned key');
  PERFORM record_qualification_check(v_id,'version.reports','',   'passed','',40,'opencode 1.18.32');
  v_result := finish_runtime_qualification(v_id, ARRAY['package.signature','version.reports']);
  IF v_result->>'result' <> 'passed' THEN RAISE EXCEPTION 'complete and green did not pass: %', v_result; END IF;

  -- A check of the suite that never ran: incomplete, not passed.
  v_id := begin_runtime_qualification('opencode','1.18.33','1.0.0','0.4.0-rc.78','root');
  PERFORM record_qualification_check(v_id,'package.signature','','passed','',100,'');
  v_result := finish_runtime_qualification(v_id, ARRAY['package.signature','read_only.shell']);
  IF v_result->>'result' <> 'incomplete' THEN RAISE EXCEPTION 'a missing check did not leave it incomplete: %', v_result; END IF;

  -- A skipped check (not yet built) is incomplete too; a failed one fails.
  v_id := begin_runtime_qualification('codex','0.157.1','1.0.0','0.4.0-rc.78','root');
  PERFORM record_qualification_check(v_id,'read_only.shell','run.read_only','failed','runtime',9000,'filesystem-restricted execution requires bubblewrap');
  PERFORM record_qualification_check(v_id,'interrupt','interrupt','skipped','',0,'W3b');
  v_result := finish_runtime_qualification(v_id, ARRAY['read_only.shell','interrupt']);
  IF v_result->>'result' <> 'failed' THEN RAISE EXCEPTION 'a failed check did not fail it: %', v_result; END IF;

  -- Refused before anything was installed.
  v_id := begin_runtime_qualification('codex','0.158.0','1.0.0','0.4.0-rc.78','root');
  PERFORM record_qualification_check(v_id,'host.requirements','','failed','host',5,'bwrap.userns not met');
  v_result := finish_runtime_qualification(v_id, ARRAY['host.requirements'], true, 'host requirement bwrap.userns not met');
  IF v_result->>'result' <> 'refused' THEN RAISE EXCEPTION 'a refusal was not recorded as one: %', v_result; END IF;

  -- One running at a time per runtime; a finished one cannot take more checks.
  v_id := begin_runtime_qualification('claude','2.1.283','1.0.0','0.4.0-rc.78','root');
  BEGIN
    PERFORM begin_runtime_qualification('claude','2.1.282','1.0.0','0.4.0-rc.78','root');
    RAISE EXCEPTION 'two qualifications of one runtime ran at once';
  EXCEPTION WHEN SQLSTATE '55006' THEN NULL;
  END;
  PERFORM finish_runtime_qualification(v_id, ARRAY['package.signature']);
  BEGIN
    PERFORM record_qualification_check(v_id,'late','','passed','',0,'');
    RAISE EXCEPTION 'a finished qualification took a check';
  EXCEPTION WHEN SQLSTATE '55000' THEN NULL;
  END;
  -- A failed check must say what kind of thing failed.
  v_id := begin_runtime_qualification('claude','2.1.282','1.0.0','0.4.0-rc.78','root');
  BEGIN
    PERFORM record_qualification_check(v_id,'x.y','','failed','',0,'');
    RAISE EXCEPTION 'a failure without a class was stored';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  v_view := get_runtime_qualifications();
  IF (SELECT count(*) FROM jsonb_array_elements(v_view) e WHERE e->>'runtime'='codex' AND e->>'version'='0.158.0' AND e->>'result'='refused') <> 1 THEN
    RAISE EXCEPTION 'the panel view lost the refusal: %', v_view;
  END IF;
  RAISE NOTICE 'a runtime qualification passes only when complete and green';
END $$;

ROLLBACK;
