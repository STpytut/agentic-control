\set ON_ERROR_STOP on
BEGIN;
SET search_path TO control_plane,public;

DO $$
DECLARE
  v_user uuid;
  v_project uuid:=gen_random_uuid();
  v_codex_profile uuid;
  v_executor_profile uuid;
  v_result jsonb;
  v_count bigint;
BEGIN
  INSERT INTO users(display_name) VALUES('Project Creation Test') RETURNING id INTO v_user;
  INSERT INTO runtime_profiles(runtime_type,adapter_version,runtime_version,provider_type,model)
    VALUES('codex','test','test','openai','project-creation-test') RETURNING id INTO v_codex_profile;
  INSERT INTO runtime_profiles(runtime_type,adapter_version,runtime_version,provider_type,model)
    VALUES('opencode','test','test','test','project-creation-test') RETURNING id INTO v_executor_profile;

  WITH created AS (
    INSERT INTO projects(id,owner_id,name,slug,workspace_path,repository_url,default_branch,status,settings)
    VALUES(v_project,v_user,'Project Creation Test','project-creation-test-'||left(v_project::text,8),
      '/srv/project-creation-test/'||v_project,NULL,'main','needs_attention',
      '{"provisioning_status":"pending","provisioning_source":"empty","agent_roster_configured":true}')
    RETURNING *
  ), orchestrator_agent AS (
    INSERT INTO agents(name,role,runtime_profile_id)
    SELECT 'orchestrator-codex-'||c.id,'architect',op.id
    FROM created c JOIN runtime_profiles op ON op.id=v_codex_profile
    WHERE op.enabled AND op.runtime_type='codex'
    RETURNING *
  ), orchestrator_assignment AS (
    INSERT INTO project_agent_assignments(project_id,agent_id,runtime_profile_id,assignment_role,is_default)
    SELECT c.id,a.id,a.runtime_profile_id,'orchestrator',true
    FROM created c CROSS JOIN orchestrator_agent a
    RETURNING id
  ), executor_profiles AS (
    SELECT rp.*,row_number() OVER(ORDER BY rp.runtime_type,rp.provider_type,rp.model,rp.id) ordinal
    FROM runtime_profiles rp WHERE rp.id=v_executor_profile AND rp.enabled AND rp.runtime_type='opencode'
  ), executor_agents AS (
    INSERT INTO agents(name,role,runtime_profile_id)
    SELECT 'executor-'||ep.runtime_type||'-'||ep.ordinal||'-'||c.id,'implementer',ep.id
    FROM created c CROSS JOIN executor_profiles ep
    RETURNING *
  ), executor_assignments AS (
    INSERT INTO project_agent_assignments(project_id,agent_id,runtime_profile_id,assignment_role)
    SELECT c.id,a.id,a.runtime_profile_id,'executor'
    FROM created c CROSS JOIN executor_agents a
    RETURNING id
  ), lock_row AS (
    INSERT INTO workspace_locks(project_id) SELECT c.id FROM created c RETURNING project_id
  ), event_row AS (
    SELECT append_event('project.created',c.id,NULL,NULL,'user','project-creation-test',NULL,v_project::text,
      'project-created:'||c.id,'project',c.id,c.version,
      jsonb_build_object('name',c.name,'slug',c.slug,'provisioning_status','pending',
        'orchestrator_profile_id',v_codex_profile,'executor_profile_ids',jsonb_build_array(v_executor_profile)))
    FROM created c
  )
  SELECT jsonb_build_object('project_id',c.id,'slug',c.slug,'status',c.status,
    'workspace_path',c.workspace_path,'orchestrator_profile_id',v_codex_profile,
    'executor_count',(SELECT count(*) FROM executor_assignments))
  INTO v_result
  FROM created c CROSS JOIN event_row CROSS JOIN orchestrator_assignment;

  IF v_result->>'project_id'<>v_project::text OR (v_result->>'executor_count')::integer<>1 THEN
    RAISE EXCEPTION 'project creation receipt is invalid: %',v_result;
  END IF;
  SELECT count(*) INTO v_count FROM project_agent_assignments WHERE project_id=v_project;
  IF v_count<>2 THEN RAISE EXCEPTION 'project roster is incomplete: %',v_count; END IF;
  IF NOT EXISTS(SELECT 1 FROM workspace_locks WHERE project_id=v_project) THEN
    RAISE EXCEPTION 'workspace lock row is missing';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM domain_events WHERE project_id=v_project AND event_type='project.created') THEN
    RAISE EXCEPTION 'project.created event is missing';
  END IF;
  RAISE NOTICE 'project creation action assertions passed';
END $$;

ROLLBACK;
