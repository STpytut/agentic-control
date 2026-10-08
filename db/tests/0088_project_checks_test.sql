-- Migration 0143: the project's check command. Only the owner sets it, it is
-- one line, the supervisor reads it per run, and a failed platform check
-- blocks a publish as the other platform checks do.
\set ON_ERROR_STOP on

BEGIN;
SET search_path TO control_plane, public, extensions;

DO $$
DECLARE v_owner uuid; v_project uuid; v_task uuid; v_run uuid; v_agent uuid; v_answer jsonb;
BEGIN
  IF NOT has_function_privilege('infra_web','set_project_check(uuid,uuid,text,integer)','EXECUTE')
     OR has_function_privilege('infra_web','project_check_for_run(uuid)','EXECUTE')
     OR NOT has_function_privilege('infra_worker','project_check_for_run(uuid)','EXECUTE') THEN
    RAISE EXCEPTION 'project check grants are wrong';
  END IF;
  INSERT INTO users(display_name,role) VALUES('Check owner','owner') RETURNING id INTO v_owner;
  INSERT INTO projects(owner_id,name,slug,workspace_path,default_branch,credential_mode)
    VALUES(v_owner,'Check project','check-project','/srv/infra-cod/workspaces/check-project','main','empty') RETURNING id INTO v_project;

  BEGIN
    PERFORM set_project_check(v_project, gen_random_uuid(), 'npm test', 600);
    RAISE EXCEPTION 'a stranger set the check';
  EXCEPTION WHEN SQLSTATE '55000' THEN NULL;
  END;
  BEGIN
    PERFORM set_project_check(v_project, v_owner, E'npm test\nrm -rf /', 600);
    RAISE EXCEPTION 'a two-line command was accepted';
  EXCEPTION WHEN invalid_parameter_value THEN NULL;
  END;
  BEGIN
    PERFORM set_project_check(v_project, v_owner, 'npm test', 5);
    RAISE EXCEPTION 'a five-second timeout was accepted';
  EXCEPTION WHEN invalid_parameter_value THEN NULL;
  END;

  v_answer := set_project_check(v_project, v_owner, '  npm test  ', 300);
  IF v_answer->>'check_command' <> 'npm test' OR (v_answer->>'check_timeout_seconds')::int <> 300 THEN
    RAISE EXCEPTION 'set: %', v_answer;
  END IF;

  INSERT INTO tasks(project_id,title,objective,status,created_by,acceptance_criteria)
    VALUES(v_project,'Check it','Make it.','implementing','test','["done"]') RETURNING id INTO v_task;
  INSERT INTO agents(name, runtime_profile_id) VALUES ('check-probe', (SELECT id FROM runtime_profiles LIMIT 1)) RETURNING id INTO v_agent;
  SET LOCAL session_replication_role = replica;
  INSERT INTO task_runs(task_id, agent_id, phase) VALUES (v_task, v_agent, 'implementation') RETURNING id INTO v_run;
  SET LOCAL session_replication_role = origin;
  v_answer := project_check_for_run(v_run);
  IF v_answer->>'command' <> 'npm test' OR (v_answer->>'timeout_seconds')::int <> 300 THEN
    RAISE EXCEPTION 'for run: %', v_answer;
  END IF;

  PERFORM set_project_check(v_project, v_owner, '', NULL);
  IF project_check_for_run(v_run) IS NOT NULL THEN RAISE EXCEPTION 'an empty command did not turn the check off'; END IF;
  RAISE NOTICE 'project check assertions passed';
END $$;

ROLLBACK;
