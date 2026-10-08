-- Migration 0145: workspace syncs. A new chat asks for one (GitHub App
-- projects only), one is open per project, a run holding the workspace keeps
-- it waiting, and only the owner asks from the panel.
\set ON_ERROR_STOP on

BEGIN;
SET search_path TO control_plane, public, extensions;

DO $$
DECLARE v_conn uuid; v_owner uuid; v_project uuid; v_plain uuid; v_task uuid; v_claim jsonb; v_id uuid; v_run uuid; v_agent uuid;
BEGIN
  IF NOT has_function_privilege('infra_web','request_workspace_sync(uuid,uuid,text)','EXECUTE')
     OR has_function_privilege('infra_web','claim_workspace_sync(text,interval)','EXECUTE')
     OR NOT has_function_privilege('infra_worker','finish_workspace_sync(uuid,jsonb)','EXECUTE') THEN
    RAISE EXCEPTION 'workspace sync grants are wrong';
  END IF;
  UPDATE workspace_syncs SET status='failed', finished_at=clock_timestamp() WHERE status IN ('requested','claimed');
  INSERT INTO users(display_name,role) VALUES('Sync owner','owner') RETURNING id INTO v_owner;
  INSERT INTO provider_connections(operator_id,provider,auth_method,status,external_installation_id)
    VALUES(v_owner,'github','github_app','connected','4242') RETURNING id INTO v_conn;
  INSERT INTO projects(owner_id,name,slug,workspace_path,repository_url,default_branch,credential_mode,
      provider_connection_id,github_repository_id,repository_full_name)
    VALUES(v_owner,'Sync project','sync-project','/srv/infra-cod/workspaces/sync','https://github.com/acme/widget.git','main','github_app',
      v_conn,99,'acme/widget') RETURNING id INTO v_project;
  INSERT INTO projects(owner_id,name,slug,workspace_path,default_branch,credential_mode)
    VALUES(v_owner,'Plain project','plain-project','/srv/infra-cod/workspaces/plain','main','empty') RETURNING id INTO v_plain;

  -- A new chat in a GitHub App project asks for a sync; in another, not.
  INSERT INTO tasks(project_id,title,objective,status,created_by,acceptance_criteria)
    VALUES(v_project,'Chat','Do it.','planning','test','["done"]') RETURNING id INTO v_task;
  INSERT INTO tasks(project_id,title,objective,status,created_by,acceptance_criteria)
    VALUES(v_plain,'Chat','Do it.','planning','test','["done"]');
  IF (SELECT count(*) FROM workspace_syncs WHERE project_id=v_project AND status='requested') <> 1
     OR EXISTS (SELECT 1 FROM workspace_syncs WHERE project_id=v_plain) THEN
    RAISE EXCEPTION 'chat-start syncs: %', (SELECT jsonb_agg(to_jsonb(s)) FROM workspace_syncs s);
  END IF;
  -- A second chat while one is open is the same sync; the owner's reset turns it into a reset.
  INSERT INTO tasks(project_id,title,objective,status,created_by,acceptance_criteria)
    VALUES(v_project,'Chat 2','Do it.','planning','test','["done"]');
  v_id := (request_workspace_sync(v_project, v_owner, 'reset')->>'sync_id')::uuid;
  IF (SELECT count(*) FROM workspace_syncs WHERE project_id=v_project) <> 1
     OR (SELECT mode FROM workspace_syncs WHERE id=v_id) <> 'reset' THEN
    RAISE EXCEPTION 'one open sync per project';
  END IF;
  BEGIN
    PERFORM request_workspace_sync(v_project, gen_random_uuid(), 'sync');
    RAISE EXCEPTION 'a stranger asked for a sync';
  EXCEPTION WHEN SQLSTATE '55000' THEN NULL;
  END;
  BEGIN
    PERFORM request_workspace_sync(v_plain, v_owner, 'sync');
    RAISE EXCEPTION 'a project without the GitHub App was synced';
  EXCEPTION WHEN SQLSTATE '55000' THEN NULL;
  END;

  -- A run holding the workspace keeps the sync waiting.
  SET LOCAL session_replication_role = replica;
  INSERT INTO agents(name, runtime_profile_id) VALUES ('sync-probe', gen_random_uuid()) RETURNING id INTO v_agent;
  INSERT INTO task_runs(task_id, agent_id, phase) VALUES (v_task, v_agent, 'implementation') RETURNING id INTO v_run;
  INSERT INTO workspace_locks(project_id, owner_run_id, status, lease_expires_at) VALUES (v_project, v_run, 'held', clock_timestamp()+interval '5 minutes')
    ON CONFLICT (project_id) DO UPDATE SET owner_run_id=EXCLUDED.owner_run_id, status='held', lease_expires_at=EXCLUDED.lease_expires_at;
  SET LOCAL session_replication_role = origin;
  IF claim_workspace_sync('sync-test') IS NOT NULL THEN RAISE EXCEPTION 'a sync was claimed under a run'; END IF;
  UPDATE workspace_locks SET status='released', owner_run_id=NULL, lease_expires_at=NULL WHERE project_id=v_project;

  v_claim := claim_workspace_sync('sync-test');
  IF (v_claim->>'sync_id')::uuid <> v_id OR v_claim->>'mode' <> 'reset' OR v_claim->>'base_branch' <> 'main' THEN
    RAISE EXCEPTION 'claim: %', v_claim;
  END IF;
  IF (workspace_sync_target(v_id)->>'workspace_path') <> '/srv/infra-cod/workspaces/sync' THEN RAISE EXCEPTION 'target'; END IF;
  PERFORM finish_workspace_sync(v_id, '{"status":"synced","outcome":"reset to GitHub","backup_ref":"infra-cod/backup/x","after_sha":"abc"}');
  IF (get_workspace_sync(v_project, v_owner)->>'status') <> 'synced' OR (get_workspace_sync(v_project, v_owner)->>'backup_ref') <> 'infra-cod/backup/x' THEN
    RAISE EXCEPTION 'finished: %', get_workspace_sync(v_project, v_owner);
  END IF;
  IF workspace_sync_target(v_id) IS NOT NULL THEN RAISE EXCEPTION 'a finished sync is still a target'; END IF;
  BEGIN
    PERFORM finish_workspace_sync(v_id, '{"status":"synced"}');
    RAISE EXCEPTION 'a sync finished twice';
  EXCEPTION WHEN SQLSTATE '55000' THEN NULL;
  END;
  RAISE NOTICE 'workspace sync assertions passed';
END $$;

ROLLBACK;
