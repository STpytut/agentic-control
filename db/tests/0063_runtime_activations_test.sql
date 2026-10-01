-- Runtime activations (migration 0097): a promotion names a passed
-- qualification of that exact version, or carries a reason.
\set ON_ERROR_STOP on

BEGIN;
SET search_path TO control_plane, public, extensions;

DO $$
DECLARE v_passed uuid; v_failed uuid; v_view jsonb;
BEGIN
  v_passed := begin_runtime_qualification('opencode','1.18.32','1.0.0','0.4.0-rc.82','root');
  PERFORM record_qualification_check(v_passed,'package.signature','','passed','',1,'');
  PERFORM finish_runtime_qualification(v_passed, ARRAY['package.signature']);
  v_failed := begin_runtime_qualification('opencode','1.18.33','1.0.0','0.4.0-rc.82','root');
  PERFORM record_qualification_check(v_failed,'read_only.shell','','failed','runtime',1,'');
  PERFORM finish_runtime_qualification(v_failed, ARRAY['read_only.shell']);

  PERFORM record_runtime_activation('opencode','promote','1.18.32','1.18.31', v_passed, false, '', 'root');

  -- A failed qualification, or one of another version, earns nothing.
  BEGIN
    PERFORM record_runtime_activation('opencode','promote','1.18.33','1.18.32', v_failed, false, '', 'root');
    RAISE EXCEPTION 'a failed qualification promoted a version';
  EXCEPTION WHEN SQLSTATE '23514' THEN NULL;
  END;
  BEGIN
    PERFORM record_runtime_activation('opencode','promote','1.18.34','1.18.32', v_passed, false, '', 'root');
    RAISE EXCEPTION 'a qualification of another version promoted this one';
  EXCEPTION WHEN SQLSTATE '23514' THEN NULL;
  END;
  -- Without a qualification, only with a reason.
  BEGIN
    PERFORM record_runtime_activation('codex','promote','0.158.0','0.154.0', NULL, true, '', 'root');
    RAISE EXCEPTION 'an unqualified promotion without a reason was stored';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  PERFORM record_runtime_activation('codex','promote','0.158.0','0.154.0', NULL, true, 'gpt-6 needed today, qualification pending', 'root');
  -- A rollback needs neither.
  PERFORM record_runtime_activation('opencode','rollback','1.18.31','1.18.32', NULL, false, '', 'root');

  v_view := get_runtime_activations();
  IF jsonb_array_length(v_view) <> 3 OR v_view->0->>'kind' <> 'rollback' THEN
    RAISE EXCEPTION 'the panel view is not newest first, or lost a row: %', v_view;
  END IF;
  RAISE NOTICE 'a runtime is promoted on a passed qualification of that version, or with a reason';
END $$;

ROLLBACK;
