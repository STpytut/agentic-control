-- The project's own checks, run by the platform (rc.131).
--
-- A review read "the executor reports npm test passed; that check was not
-- platform-run": what the tests said was the executor's word. The owner now
-- names a check command per project; after an implementation or revision
-- finishes, the supervisor runs it in the workspace — as the executor's
-- account, in the executor's sandbox shell with its login covered, without
-- network, bounded in time — and records the outcome as a platform-verified
-- check beside the patch and commit checks (review-evidence.mjs). The reviewer
-- reads it as a fact, and prepare_publish already refuses evidence whose
-- platform checks did not all pass, so failing checks block the pull request.
--
-- The command is the owner's, set in the panel: an executor that could change
-- the command could change what checks its own work.

SET search_path TO control_plane, public, extensions;

INSERT INTO failure_reasons(reason, code, note) VALUES
  ('project_check_invalid','invalid_argument','the check command is one line of at most 500 characters, and the timeout between 30 seconds and 30 minutes')
ON CONFLICT (reason) DO NOTHING;

ALTER TABLE projects
  ADD COLUMN check_command text
    CHECK (check_command IS NULL OR (char_length(check_command) BETWEEN 1 AND 500 AND check_command !~ '[\r\n]')),
  ADD COLUMN check_timeout_seconds integer NOT NULL DEFAULT 600
    CHECK (check_timeout_seconds BETWEEN 30 AND 1800);

CREATE FUNCTION set_project_check(p_project_id uuid, p_owner_id uuid, p_command text, p_timeout_seconds integer)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO control_plane, public, extensions, pg_temp
AS $$
DECLARE v_command text := NULLIF(btrim(COALESCE(p_command,'')), '');
BEGIN
  IF NOT EXISTS (SELECT 1 FROM projects WHERE id=p_project_id AND owner_id=p_owner_id) THEN
    PERFORM refuse('project_unavailable', format('project %s is not one this operator owns', p_project_id));
  END IF;
  BEGIN
    UPDATE projects SET check_command=v_command, check_timeout_seconds=COALESCE(p_timeout_seconds, check_timeout_seconds),
      updated_at=clock_timestamp()
    WHERE id=p_project_id;
  EXCEPTION WHEN check_violation THEN
    PERFORM refuse('project_check_invalid', 'the check command is one line of at most 500 characters, and the timeout between 30 seconds and 30 minutes', '22023');
  END;
  PERFORM write_audit_event(p_project_id,NULL,NULL,'operator',p_owner_id::text,'project.check_set',
    'project',p_project_id::text,'allowed',NULL,
    jsonb_build_object('command',v_command,'timeout_seconds',p_timeout_seconds),'project-check:'||p_project_id);
  RETURN jsonb_build_object('check_command',v_command,
    'check_timeout_seconds',(SELECT check_timeout_seconds FROM projects WHERE id=p_project_id));
END $$;

-- For the supervisor, at the end of an implementation or revision run: the
-- run's project's check, or null when none is set.
CREATE FUNCTION project_check_for_run(p_run_id uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO control_plane, public, extensions, pg_temp
AS $$
  SELECT jsonb_build_object('command',p.check_command,'timeout_seconds',p.check_timeout_seconds)
  FROM task_runs r JOIN tasks t ON t.id=r.task_id JOIN projects p ON p.id=t.project_id
  WHERE r.id=p_run_id AND p.check_command IS NOT NULL;
$$;

REVOKE ALL ON FUNCTION set_project_check(uuid,uuid,text,integer), project_check_for_run(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION set_project_check(uuid,uuid,text,integer) TO infra_web;
GRANT EXECUTE ON FUNCTION project_check_for_run(uuid) TO infra_worker;
