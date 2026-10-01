-- Rename and archive a project (migration 0120): only the owner, only at the
-- version the page read, a name of 2–80 characters; archiving is refused while
-- work is queued or running, an archived project takes no new work and cannot
-- be deleted until restored, and every change is audited.
\set ON_ERROR_STOP on

BEGIN;
SET search_path TO control_plane, public, extensions;

DO $$
DECLARE
  v_owner uuid; v_other uuid; v_project uuid; v_task uuid; v_event uuid; v_job bigint;
  v jsonb; v_slug text;
BEGIN
  INSERT INTO users(display_name) VALUES('Rename owner') RETURNING id INTO v_owner;
  INSERT INTO users(display_name) VALUES('Rename outsider') RETURNING id INTO v_other;
  INSERT INTO projects(owner_id,name,slug,workspace_path,default_branch)
  VALUES(v_owner,'Old name','old-name-0120','/fixture/workspaces/old-name-0120','main')
  RETURNING id INTO v_project;

  -- Rename: another operator, a stale version and a bad name are refused.
  BEGIN
    PERFORM rename_project(v_project,v_other,1,'Stolen','c1');
    RAISE EXCEPTION 'a foreign operator renamed the project';
  EXCEPTION WHEN others THEN IF SQLERRM NOT ILIKE '%no project%' THEN RAISE; END IF;
  END;
  BEGIN
    PERFORM rename_project(v_project,v_owner,7,'Late','c2');
    RAISE EXCEPTION 'a stale version renamed the project';
  EXCEPTION WHEN others THEN IF SQLERRM NOT ILIKE '%version%' THEN RAISE; END IF;
  END;
  BEGIN
    PERFORM rename_project(v_project,v_owner,1,'   x  ','c3');
    RAISE EXCEPTION 'a one-character name was accepted';
  EXCEPTION WHEN others THEN IF SQLERRM NOT ILIKE '%characters%' THEN RAISE; END IF;
  END;

  -- The owner renames it; the slug stays and the version moves.
  v := rename_project(v_project,v_owner,1,'  New name  ','c4');
  SELECT slug INTO v_slug FROM projects WHERE id=v_project;
  IF v->>'status' <> 'renamed' OR (SELECT name FROM projects WHERE id=v_project) <> 'New name'
     OR v_slug <> 'old-name-0120' OR (v->>'version')::bigint <> 2 THEN
    RAISE EXCEPTION 'rename did not rename only the name: %', v;
  END IF;
  -- The same name again changes nothing.
  v := rename_project(v_project,v_owner,2,'New name','c5');
  IF v->>'status' <> 'unchanged' OR (v->>'version')::bigint <> 2 THEN RAISE EXCEPTION 'a no-op rename moved the version: %', v; END IF;
  IF NOT EXISTS (SELECT 1 FROM audit_events WHERE target_id=v_project::text AND action='project.renamed') THEN
    RAISE EXCEPTION 'the rename was not audited';
  END IF;

  -- Archive is refused while work is queued.
  INSERT INTO tasks(project_id,title,objective,status,created_by)
  VALUES(v_project,'Queued task','Queued objective','planning',v_owner::text) RETURNING id INTO v_task;
  INSERT INTO domain_events(event_type,project_id,task_id,actor_type,actor_id,correlation_id,aggregate_type,aggregate_id,aggregate_version,payload)
  VALUES('implementation.requested',v_project,v_task,'system','rename-test','rename-correlation','task',v_task,1,'{}'::jsonb)
  RETURNING id INTO v_event;
  INSERT INTO runtime_jobs(source_event_id,job_type,project_id,task_id,payload)
  VALUES(v_event,'implementation_run',v_project,v_task,'{}'::jsonb) RETURNING id INTO v_job;
  BEGIN
    PERFORM archive_project(v_project,v_owner,2,'c6');
    RAISE EXCEPTION 'a project with queued work was archived';
  EXCEPTION WHEN others THEN IF SQLERRM NOT ILIKE '%queued or running%' THEN RAISE; END IF;
  END;
  UPDATE runtime_jobs SET status='dead_letter', last_error='settled for the test' WHERE id=v_job;

  -- Archived: the status the lifecycle checks already refuse.
  v := archive_project(v_project,v_owner,2,'c7');
  IF v->>'status' <> 'archived' OR (SELECT status FROM projects WHERE id=v_project) <> 'archived'
     OR (SELECT archived_at FROM projects WHERE id=v_project) IS NULL THEN
    RAISE EXCEPTION 'archive did not archive: %', v;
  END IF;
  BEGIN
    PERFORM request_project_deletion(v_project,v_owner,3,'c8',false);
    RAISE EXCEPTION 'an archived project was deleted without being restored';
  EXCEPTION WHEN others THEN IF SQLERRM NOT ILIKE '%restored%' THEN RAISE; END IF;
  END;
  BEGIN
    PERFORM unarchive_project(v_project,v_other,3,'c9');
    RAISE EXCEPTION 'a foreign operator restored the project';
  EXCEPTION WHEN others THEN IF SQLERRM NOT ILIKE '%no project%' THEN RAISE; END IF;
  END;

  -- Restored: active again, and archiving an active project twice is a no-op.
  v := unarchive_project(v_project,v_owner,3,'c10');
  IF v->>'status' <> 'active' OR (SELECT archived_at FROM projects WHERE id=v_project) IS NOT NULL THEN
    RAISE EXCEPTION 'unarchive did not restore: %', v;
  END IF;
  BEGIN
    PERFORM unarchive_project(v_project,v_owner,4,'c11');
    RAISE EXCEPTION 'an active project was restored';
  EXCEPTION WHEN others THEN IF SQLERRM NOT ILIKE '%not archived%' THEN RAISE; END IF;
  END;
  IF (SELECT count(*) FROM audit_events WHERE target_id=v_project::text AND action IN ('project.archived','project.unarchived')) <> 2 THEN
    RAISE EXCEPTION 'archive and restore were not both audited';
  END IF;
  RAISE NOTICE 'rename and archive are owner-, version- and work-fenced';
END $$;

-- The web may call the three; nobody else may.
DO $$
BEGIN
  IF NOT has_function_privilege('infra_web','rename_project(uuid,uuid,bigint,text,text)','EXECUTE')
     OR NOT has_function_privilege('infra_web','archive_project(uuid,uuid,bigint,text)','EXECUTE')
     OR NOT has_function_privilege('infra_web','unarchive_project(uuid,uuid,bigint,text)','EXECUTE') THEN
    RAISE EXCEPTION 'infra_web cannot call rename or archive';
  END IF;
  IF has_function_privilege('infra_worker','archive_project(uuid,uuid,bigint,text)','EXECUTE')
     OR has_function_privilege('infra_web','lock_owned_project(uuid,uuid,bigint)','EXECUTE') THEN
    RAISE EXCEPTION 'rename or archive is open beyond the web';
  END IF;
END $$;

ROLLBACK;
