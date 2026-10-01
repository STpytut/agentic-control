-- Rename and archive a project (the owner, 2026-09-29): the sidebar's ⋯ menu
-- names what is done to a project itself, as Claude's does — Pin, Open
-- repository, Copy link, Rename, Archive, Delete. Pin is the viewer's own; these
-- two change the project, so they are the database's.
--
-- Rename changes the name only. The slug stays: the workspace path, the deploy
-- key and every link are built from the id or the slug, never the name.
--
-- Archive is the status 0001 already declared and every lifecycle check
-- already refuses work on ('archived': 0017, 0033, 0039, 0041, 0059, 0077), so
-- an archived project cannot start a chat or a run, and deletion asks for it to
-- be restored first (0033). Nothing is cancelled: archiving a project that has
-- work queued or running is refused, and the operator finishes or stops it.
-- Unarchive returns it to 'active'.

SET search_path TO control_plane, public, extensions;

INSERT INTO failure_reasons(reason, code, note) VALUES
  ('project_version_stale','conflict','the project changed since the page was read; reload and try again'),
  ('project_name_invalid','invalid_argument','a project name is 2 to 80 characters, not only spaces'),
  ('project_has_active_work','conflict','the project has queued or running work; finish or stop it before archiving'),
  ('project_not_archived','conflict','only an archived project can be restored')
ON CONFLICT (reason) DO NOTHING;

CREATE FUNCTION lock_owned_project(p_project_id uuid, p_owner_id uuid, p_expected_version bigint)
RETURNS projects
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO control_plane, public, extensions, pg_temp
AS $$
DECLARE v_project projects%ROWTYPE;
BEGIN
  SELECT * INTO v_project FROM projects p WHERE p.id=p_project_id AND p.owner_id=p_owner_id FOR UPDATE;
  IF NOT FOUND OR v_project.status IN ('deleting','deletion_failed','deleted') THEN
    PERFORM refuse('project_unavailable', format('no project %s this operator owns and can change', p_project_id));
  END IF;
  IF v_project.version<>p_expected_version THEN
    PERFORM refuse('project_version_stale', format('project %s is at version %s, not %s', p_project_id, v_project.version, p_expected_version), '40001');
  END IF;
  RETURN v_project;
END $$;

CREATE FUNCTION rename_project(p_project_id uuid, p_owner_id uuid, p_expected_version bigint, p_name text, p_correlation_id text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO control_plane, public, extensions, pg_temp
AS $$
DECLARE v_project projects%ROWTYPE; v_name text := btrim(COALESCE(p_name, ''));
BEGIN
  v_project := lock_owned_project(p_project_id, p_owner_id, p_expected_version);
  IF char_length(v_name) < 2 OR char_length(v_name) > 80 THEN
    PERFORM refuse('project_name_invalid', format('a project name of %s characters', char_length(v_name)), '22023');
  END IF;
  IF v_name = v_project.name THEN
    RETURN jsonb_build_object('project_id',p_project_id,'name',v_name,'version',v_project.version,'status','unchanged');
  END IF;
  UPDATE projects SET name=v_name, updated_at=clock_timestamp(), version=version+1
  WHERE id=p_project_id RETURNING * INTO v_project;
  PERFORM write_audit_event(p_project_id,NULL,NULL,'operator',p_owner_id::text,
    'project.renamed','project',p_project_id::text,'allowed',NULL,
    jsonb_build_object('name',v_name),
    COALESCE(NULLIF(p_correlation_id,''),p_project_id::text));
  RETURN jsonb_build_object('project_id',p_project_id,'name',v_name,'version',v_project.version,'status','renamed');
END $$;

CREATE FUNCTION archive_project(p_project_id uuid, p_owner_id uuid, p_expected_version bigint, p_correlation_id text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO control_plane, public, extensions, pg_temp
AS $$
DECLARE v_project projects%ROWTYPE; v_active integer;
BEGIN
  v_project := lock_owned_project(p_project_id, p_owner_id, p_expected_version);
  IF v_project.status='archived' THEN
    RETURN jsonb_build_object('project_id',p_project_id,'version',v_project.version,'status','archived');
  END IF;
  SELECT count(*) INTO v_active FROM runtime_jobs j
  WHERE j.project_id=p_project_id AND j.status IN ('pending','in_flight');
  IF v_active > 0 THEN
    PERFORM refuse('project_has_active_work', format('project %s has %s queued or running job(s)', p_project_id, v_active));
  END IF;
  UPDATE projects SET status='archived', archived_at=clock_timestamp(), updated_at=clock_timestamp(), version=version+1
  WHERE id=p_project_id RETURNING * INTO v_project;
  PERFORM write_audit_event(p_project_id,NULL,NULL,'operator',p_owner_id::text,
    'project.archived','project',p_project_id::text,'allowed',NULL,'{}'::jsonb,
    COALESCE(NULLIF(p_correlation_id,''),p_project_id::text));
  RETURN jsonb_build_object('project_id',p_project_id,'version',v_project.version,'status','archived');
END $$;

CREATE FUNCTION unarchive_project(p_project_id uuid, p_owner_id uuid, p_expected_version bigint, p_correlation_id text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO control_plane, public, extensions, pg_temp
AS $$
DECLARE v_project projects%ROWTYPE;
BEGIN
  v_project := lock_owned_project(p_project_id, p_owner_id, p_expected_version);
  IF v_project.status<>'archived' THEN
    PERFORM refuse('project_not_archived', format('project %s is %s, not archived', p_project_id, v_project.status));
  END IF;
  UPDATE projects SET status='active', archived_at=NULL, updated_at=clock_timestamp(), version=version+1
  WHERE id=p_project_id RETURNING * INTO v_project;
  PERFORM write_audit_event(p_project_id,NULL,NULL,'operator',p_owner_id::text,
    'project.unarchived','project',p_project_id::text,'allowed',NULL,'{}'::jsonb,
    COALESCE(NULLIF(p_correlation_id,''),p_project_id::text));
  RETURN jsonb_build_object('project_id',p_project_id,'version',v_project.version,'status','active');
END $$;

REVOKE EXECUTE ON FUNCTION lock_owned_project(uuid,uuid,bigint) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION rename_project(uuid,uuid,bigint,text,text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION archive_project(uuid,uuid,bigint,text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION unarchive_project(uuid,uuid,bigint,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION rename_project(uuid,uuid,bigint,text,text) TO infra_web;
GRANT EXECUTE ON FUNCTION archive_project(uuid,uuid,bigint,text) TO infra_web;
GRANT EXECUTE ON FUNCTION unarchive_project(uuid,uuid,bigint,text) TO infra_web;
