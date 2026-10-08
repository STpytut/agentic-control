-- Migration 0146: repository maps. The supervisor records one per project (the
-- newest replaces the last, a malformed one is not recorded), the orchestrator
-- reads it with the project's earlier tasks under its turn's lease, and only
-- the owner reads it from the panel.
\set ON_ERROR_STOP on

BEGIN;
SET search_path TO control_plane, public, extensions;

DO $$
DECLARE v_owner uuid; v_project uuid; v_other uuid; v_task uuid; v_done uuid; v_plain uuid; v_agent uuid; v_run uuid;
  v_event uuid; v_job bigint; v_context jsonb; v_sha text := repeat('a',40);
BEGIN
  IF NOT has_function_privilege('infra_web','get_repository_map(uuid,uuid)','EXECUTE')
     OR has_function_privilege('infra_web','record_repository_map(uuid,text,jsonb)','EXECUTE')
     OR has_function_privilege('infra_web','orchestrator_repository_context(bigint,text)','EXECUTE')
     OR NOT has_function_privilege('infra_worker','record_repository_map(uuid,text,jsonb)','EXECUTE')
     OR NOT has_function_privilege('infra_worker','orchestrator_repository_context(bigint,text)','EXECUTE')
     OR has_table_privilege('infra_web','project_repository_maps','SELECT') THEN
    RAISE EXCEPTION 'repository map grants are wrong';
  END IF;
  INSERT INTO users(display_name,role) VALUES('Map owner','owner') RETURNING id INTO v_owner;
  INSERT INTO projects(owner_id,name,slug,workspace_path,default_branch,credential_mode,check_command)
    VALUES(v_owner,'Map project','map-project','/srv/infra-cod/workspaces/map','main','empty','npm test') RETURNING id INTO v_project;
  INSERT INTO projects(owner_id,name,slug,workspace_path,default_branch,credential_mode)
    VALUES(v_owner,'Other project','other-project','/srv/infra-cod/workspaces/other','main','empty') RETURNING id INTO v_other;

  -- Recorded, then replaced; a map naming no commit, or too large, is not.
  IF record_repository_map(v_project,'provision',jsonb_build_object('head_sha',v_sha,'tree','a/')) IS NULL THEN RAISE EXCEPTION 'not recorded'; END IF;
  PERFORM record_repository_map(v_project,'implementation',jsonb_build_object('head_sha',repeat('b',40),'tree','b/'));
  IF (SELECT count(*) FROM project_repository_maps WHERE project_id=v_project) <> 1
     OR (SELECT map->>'tree' FROM project_repository_maps WHERE project_id=v_project) <> 'b/'
     OR (SELECT source FROM project_repository_maps WHERE project_id=v_project) <> 'implementation' THEN
    RAISE EXCEPTION 'the newest map does not replace the last';
  END IF;
  IF record_repository_map(v_project,'sync','{"head_sha":"HEAD"}') IS NOT NULL
     OR record_repository_map(v_project,'sync','[]') IS NOT NULL
     OR record_repository_map(v_project,'manual',jsonb_build_object('head_sha',v_sha)) IS NOT NULL
     OR record_repository_map(gen_random_uuid(),'sync',jsonb_build_object('head_sha',v_sha)) IS NOT NULL
     OR record_repository_map(v_project,'sync',jsonb_build_object('head_sha',v_sha,'tree',repeat('x',70000))) IS NOT NULL THEN
    RAISE EXCEPTION 'a malformed map was recorded';
  END IF;
  IF (SELECT head_sha FROM project_repository_maps WHERE project_id=v_project) <> repeat('b',40) THEN
    RAISE EXCEPTION 'a refused map changed the recorded one';
  END IF;

  -- The panel: the owner reads it, nobody else does.
  IF get_repository_map(v_project, v_owner)->>'head_sha' <> repeat('b',40)
     OR get_repository_map(v_project, gen_random_uuid()) IS NOT NULL
     OR get_repository_map(v_other, v_owner) IS NOT NULL THEN
    RAISE EXCEPTION 'panel read: %', get_repository_map(v_project, v_owner);
  END IF;

  -- The orchestrator: the map, the check, and the earlier tasks that were
  -- implemented — not this one, not one never implemented, not another project's.
  INSERT INTO tasks(project_id,title,objective,status,created_by) VALUES(v_project,'This chat','x','planning','test') RETURNING id INTO v_task;
  INSERT INTO tasks(project_id,title,objective,status,created_by) VALUES(v_project,'Pause button','x','approved','test') RETURNING id INTO v_done;
  INSERT INTO tasks(project_id,title,objective,status,created_by) VALUES(v_project,'Only talked','x','cancelled','test') RETURNING id INTO v_plain;
  SET LOCAL session_replication_role = replica;
  INSERT INTO agents(name, runtime_profile_id) VALUES ('map-probe', gen_random_uuid()) RETURNING id INTO v_agent;
  INSERT INTO task_runs(task_id, agent_id, phase) VALUES (v_done, v_agent, 'implementation') RETURNING id INTO v_run;
  INSERT INTO review_evidence(project_id,task_id,run_id,fencing_token,base_commit_sha,head_commit_sha,
    worktree_digest,patch_digest,evidence_digest,algorithm,object_format,worktree_committed,changed_files,
    diffstat,diff,truncation,executor_reported_checks,platform_verified_checks,recorded_by)
  VALUES(v_project,v_done,v_run,1,repeat('a',40),repeat('b',40),'sha256:'||repeat('c',64),'sha256:'||repeat('d',64),
    'sha256:'||repeat('e',64),'{"worktree":"infra-cod-worktree-v1","patch":"infra-cod-patch-v1"}','sha1',true,
    (SELECT jsonb_agg(jsonb_build_object('path','src/f'||n||'.ts','status','M')) FROM generate_series(1,10) n),
    '{}','','{}','{}','[]','map-test');
  INSERT INTO domain_events(event_type,project_id,task_id,conversation_id,conversation_sequence,actor_type,actor_id,correlation_id,aggregate_type,aggregate_id,aggregate_version,payload)
    VALUES('chat.user_message',v_project,v_task,(SELECT conversation_id FROM tasks WHERE id=v_task),9001,'system','map-test','map-test','task',v_task,1,'{}') RETURNING id INTO v_event;
  INSERT INTO runtime_jobs(source_event_id,job_type,project_id,task_id,status,leased_by,leased_until)
    VALUES(v_event,'orchestrator_turn',v_project,v_task,'in_flight','map-worker',clock_timestamp()+interval '5 minutes') RETURNING id INTO v_job;
  SET LOCAL session_replication_role = origin;

  v_context := orchestrator_repository_context(v_job,'map-worker');
  IF v_context->'map'->>'tree' <> 'b/' OR v_context->>'check_command' <> 'npm test'
     OR jsonb_array_length(v_context->'recent_tasks') <> 1
     OR v_context->'recent_tasks'->0->>'title' <> 'Pause button'
     OR (v_context->'recent_tasks'->0->'changed_files'->>'total')::int <> 10
     OR jsonb_array_length(v_context->'recent_tasks'->0->'changed_files'->'paths') <> 8 THEN
    RAISE EXCEPTION 'orchestrator context: %', v_context;
  END IF;
  BEGIN
    PERFORM orchestrator_repository_context(v_job,'another-worker');
    RAISE EXCEPTION 'a worker without the lease read the context';
  EXCEPTION WHEN SQLSTATE '55000' THEN NULL;
  END;
  RAISE NOTICE 'repository map assertions passed';
END $$;

ROLLBACK;
