\set ON_ERROR_STOP on
BEGIN;
SET search_path TO control_plane,public,extensions;

DO $$
DECLARE
  v_owner uuid;
  v_project uuid;
  v_task uuid;
  v_orchestrator_entry uuid;
  v_executor_entry uuid;
  v_other_executor uuid;
  v_selected_executor_assignment uuid;
  v_orchestrator_assignment uuid;
  v_defaults jsonb;
  v_snapshot jsonb;
  v_receipt jsonb;
  v_claim jsonb;
  v_result jsonb;
  v_version bigint;
BEGIN
  -- 0054 made binding a task to a runtime conditional on the host reporting that
  -- runtime as installed and authenticated, and a host that has reported nothing
  -- refuses rather than assumes. This file is about which entries a snapshot
  -- selects, not about provisioning, so it states the precondition outright
  -- instead of depending on whatever the database happened to contain.
  INSERT INTO runtime_health(singleton,status,snapshot,observed_at)
  VALUES (true,'healthy',jsonb_build_object('type','health.snapshot','status','healthy',
    'runtimes',jsonb_build_array(
      jsonb_build_object('runtime','codex','installed',true,'authenticated',true),
      jsonb_build_object('runtime','opencode','installed',true,'authenticated',true))),
    clock_timestamp())
  ON CONFLICT (singleton) DO UPDATE SET
    status=EXCLUDED.status, snapshot=EXCLUDED.snapshot, observed_at=EXCLUDED.observed_at;

  INSERT INTO users(display_name) VALUES('Runtime defaults owner') RETURNING id INTO v_owner;

  -- Build the catalog: one verified Codex orchestrator, two verified OpenCode executors.
  SELECT id INTO v_orchestrator_entry FROM provider_model_catalog
  WHERE operator_id=v_owner AND provider_id='chatgpt' AND runtime_type='codex' LIMIT 1;
  IF v_orchestrator_entry IS NULL THEN
    INSERT INTO provider_model_catalog(
      operator_id,connection_id,billing_boundary,runtime_type,provider_id,model_id,
      display_name,provider_badge,plan_badge,reasoning_efforts,service_tiers,
      capabilities,adapter_version,runtime_version,discovery_source,status,
      last_verified_at,verification_id
    )
    SELECT v_owner,c.id,'subscription','codex','chatgpt','gpt-5.6-sol',
      'GPT-5.6 Sol','ChatGPT','Plus','["low","high"]'::jsonb,'["standard"]'::jsonb,
      '{"streaming":true,"interrupt":true}'::jsonb,'0.5.0','0.5.0',
      'codex_model_list','verified',clock_timestamp(),gen_random_uuid()
    FROM provider_connections c
    WHERE c.operator_id=v_owner AND c.provider='codex' AND c.status='connected'
    LIMIT 1;
    IF NOT FOUND THEN
      INSERT INTO provider_connections(operator_id,provider,auth_method,status,
        billing_boundary,native_credential_reference)
      VALUES(v_owner,'codex','device_code','connected','','codex-home:codex-worker');
      INSERT INTO provider_model_catalog(
        operator_id,connection_id,billing_boundary,runtime_type,provider_id,model_id,
        display_name,provider_badge,plan_badge,reasoning_efforts,service_tiers,
        capabilities,adapter_version,runtime_version,discovery_source,status,
        last_verified_at,verification_id
      )
      SELECT v_owner,c.id,'subscription','codex','chatgpt','gpt-5.6-sol',
        'GPT-5.6 Sol','ChatGPT','Plus','["low","high"]'::jsonb,'["standard"]'::jsonb,
        '{"streaming":true,"interrupt":true}'::jsonb,'0.5.0','0.5.0',
        'codex_model_list','verified',clock_timestamp(),gen_random_uuid()
      FROM provider_connections c
      WHERE c.operator_id=v_owner AND c.provider='codex' LIMIT 1;
    END IF;
    SELECT id INTO v_orchestrator_entry FROM provider_model_catalog
    WHERE operator_id=v_owner AND provider_id='chatgpt' AND runtime_type='codex' LIMIT 1;
  END IF;

  SELECT id INTO v_executor_entry FROM provider_model_catalog
  WHERE operator_id=v_owner AND provider_id='opencode' AND runtime_type='opencode' AND status='verified' LIMIT 1;
  IF v_executor_entry IS NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM provider_connections c
      WHERE c.operator_id=v_owner AND c.provider='opencode' AND c.billing_boundary='free'
    ) THEN
      INSERT INTO provider_connections(operator_id,provider,auth_method,status,billing_boundary,
        native_credential_reference)
      VALUES(v_owner,'opencode','native','connected','free','opencode-home:opencode-worker');
    END IF;
    INSERT INTO provider_model_catalog(
      operator_id,connection_id,billing_boundary,runtime_type,provider_id,model_id,
      display_name,provider_badge,plan_badge,service_tiers,
      capabilities,adapter_version,runtime_version,discovery_source,status,
      last_verified_at,verification_id
    )
    SELECT v_owner,c.id,c.billing_boundary,'opencode','opencode','opencode-free',
      'OpenCode Free','OpenCode','Free','["free"]'::jsonb,
      '{"streaming":true,"interrupt":true}'::jsonb,'1.18.3','1.18.3',
      'opencode_provider_api','verified',clock_timestamp(),gen_random_uuid()
    FROM provider_connections c
    WHERE c.operator_id=v_owner AND c.provider='opencode' AND c.billing_boundary='free'
    LIMIT 1;
    SELECT id INTO v_executor_entry FROM provider_model_catalog
    WHERE operator_id=v_owner AND provider_id='opencode' AND runtime_type='opencode' AND status='verified' LIMIT 1;
  END IF;

  INSERT INTO provider_model_catalog(
    operator_id,connection_id,billing_boundary,runtime_type,provider_id,model_id,
    display_name,provider_badge,plan_badge,service_tiers,
    capabilities,adapter_version,runtime_version,discovery_source,status,
    last_verified_at,verification_id
  )
  SELECT v_owner,c.id,c.billing_boundary,'opencode','opencode','opencode-plus',
    'OpenCode Plus','OpenCode','Plus','["plus"]'::jsonb,
    '{"streaming":true,"interrupt":true}'::jsonb,'1.18.3','1.18.3',
    'opencode_provider_api','verified',clock_timestamp(),gen_random_uuid()
  FROM provider_connections c
  WHERE c.operator_id=v_owner AND c.provider='opencode' AND c.billing_boundary='free'
  ON CONFLICT (connection_id,provider_id,model_id) WHERE superseded_by IS NULL DO NOTHING;
  SELECT id INTO v_other_executor FROM provider_model_catalog
  WHERE operator_id=v_owner AND provider_id='opencode' AND model_id='opencode-plus' AND status='verified' LIMIT 1;

  IF v_orchestrator_entry IS NULL OR v_executor_entry IS NULL OR v_other_executor IS NULL THEN
    RAISE EXCEPTION 'catalog fixtures are incomplete';
  END IF;

  INSERT INTO projects(owner_id,name,slug,workspace_path,default_branch)
  VALUES(v_owner,'Snapshot fixture','snapshot-fixture','/fixture/workspaces/snapshot-fixture','main')
  RETURNING id INTO v_project;

  -- Owner/version-fenced defaults; stale version rejected.
  BEGIN
    PERFORM set_project_runtime_defaults(v_project,v_owner,99,v_orchestrator_entry,
      ARRAY[v_executor_entry,v_other_executor],'high','standard','owner','corr-1');
    RAISE EXCEPTION 'stale project version was accepted';
  EXCEPTION WHEN others THEN
    IF SQLERRM NOT ILIKE '%stale%' THEN RAISE; END IF;
  END;
  BEGIN
    PERFORM set_project_runtime_defaults(v_project,gen_random_uuid(),1,v_orchestrator_entry,
      ARRAY[v_executor_entry],'high','standard','owner','corr-2');
    RAISE EXCEPTION 'foreign owner set project defaults';
  EXCEPTION WHEN others THEN
    IF SQLERRM NOT ILIKE '%unavailable%' THEN RAISE; END IF;
  END;

  v_result := set_project_runtime_defaults(v_project,v_owner,1,v_orchestrator_entry,
    ARRAY[v_executor_entry,v_other_executor],'high','standard','owner','corr-3');
  IF v_result->>'status'<>'saved' THEN RAISE EXCEPTION 'defaults were not saved'; END IF;

  -- Unsupported reasoning effort for the orchestrator is rejected.
  BEGIN
    PERFORM set_project_runtime_defaults(v_project,v_owner,1,v_orchestrator_entry,
      ARRAY[v_executor_entry],'ultra','standard','owner','corr-4');
    RAISE EXCEPTION 'unsupported reasoning effort was accepted';
  EXCEPTION WHEN others THEN
    IF SQLERRM NOT ILIKE '%reasoning effort%' THEN RAISE; END IF;
  END;


  v_defaults := get_project_runtime_defaults(v_project,v_owner);
  IF v_defaults->>'version'<>'1' OR (v_defaults->'orchestrator'->>'model_id')<>'gpt-5.6-sol'
     OR jsonb_array_length(v_defaults->'executors')<>2 THEN
    RAISE EXCEPTION 'project defaults read model is incorrect';
  END IF;

  -- Task snapshot is captured immutably and never re-reads live defaults.
  INSERT INTO tasks(project_id,title,objective,status,created_by)
  VALUES(v_project,'Snapshot task','Objective','draft','owner')
  RETURNING id INTO v_task;
  v_snapshot := capture_task_runtime_snapshot(v_task,v_project);
  IF v_snapshot->>'source'<>'catalog' OR (v_snapshot->'orchestrator'->>'model_id')<>'gpt-5.6-sol'
     OR (v_snapshot->'orchestrator'->>'reasoning_effort')<>'high'
     OR (v_snapshot->'orchestrator'->>'service_tier')<>'standard'
     OR (v_snapshot->'orchestrator'->>'verification_id') IS NULL
     OR jsonb_array_length(v_snapshot->'executors')<>2 THEN
    RAISE EXCEPTION 'task snapshot content is incorrect';
  END IF;
  v_snapshot := capture_task_runtime_snapshot(v_task,v_project);
  IF v_snapshot->>'status'<>'already_captured' THEN
    RAISE EXCEPTION 'task snapshot was overwritten';
  END IF;

  -- Changing defaults does not change the already-captured task.
  PERFORM set_project_runtime_defaults(v_project,v_owner,1,v_orchestrator_entry,
    ARRAY[v_executor_entry],'low','standard','owner','corr-5');
  v_snapshot := get_task_runtime_snapshot(v_task);
  IF (v_snapshot->'orchestrator'->>'reasoning_effort')<>'high'
     OR jsonb_array_length(v_snapshot->'executors')<>2 THEN
    RAISE EXCEPTION 'defaults change leaked into the existing task snapshot';
  END IF;

  -- A new task after the change captures the new defaults.
  INSERT INTO tasks(project_id,title,objective,status,created_by)
  VALUES(v_project,'Second task','Objective 2','draft','owner')
  RETURNING id INTO v_task;
  v_snapshot := capture_task_runtime_snapshot(v_task,v_project);
  IF (v_snapshot->'orchestrator'->>'reasoning_effort')<>'low'
     OR jsonb_array_length(v_snapshot->'executors')<>1 THEN
    RAISE EXCEPTION 'new task did not capture the updated defaults';
  END IF;

  -- Foreign owner cannot read defaults or snapshots.
  IF get_project_runtime_defaults(v_project,gen_random_uuid())<>'null'::jsonb THEN
    RAISE EXCEPTION 'foreign owner read project defaults';
  END IF;

  -- Executor snapshot is bound to the exact project agent assignment: two
  -- executors with different models resolve to their own runtime profile, not
  -- the first snapshot entry.
  PERFORM set_project_runtime_defaults(v_project,v_owner,2,v_orchestrator_entry,
    ARRAY[v_executor_entry,v_other_executor],'high','standard','owner','corr-6');
  INSERT INTO runtime_profiles(runtime_type,adapter_version,runtime_version,provider_type,model,capabilities,enabled)
  VALUES('opencode','1.18.3','1.18.3','opencode','opencode-free','{}'::jsonb,true),
         ('opencode','1.18.3','1.18.3','opencode','opencode-plus','{}'::jsonb,true)
  ON CONFLICT DO NOTHING;
  INSERT INTO agents(name,role,runtime_profile_id)
  SELECT 'executor-free-' || gen_random_uuid()::text,'implementer',rp.id
  FROM runtime_profiles rp WHERE rp.model='opencode-free' AND rp.enabled LIMIT 1;
  INSERT INTO agents(name,role,runtime_profile_id)
  SELECT 'executor-plus-' || gen_random_uuid()::text,'implementer',rp.id
  FROM runtime_profiles rp WHERE rp.model='opencode-plus' AND rp.enabled LIMIT 1;
  INSERT INTO project_agent_assignments(project_id,agent_id,runtime_profile_id,assignment_role)
  SELECT v_project,a.id,a.runtime_profile_id,'executor'
  FROM agents a WHERE a.role='implementer' AND a.name LIKE 'executor-%' AND a.enabled
    AND a.runtime_profile_id IN (SELECT id FROM runtime_profiles WHERE model IN ('opencode-free','opencode-plus') AND enabled);

  INSERT INTO tasks(project_id,title,objective,status,created_by)
  VALUES(v_project,'Binding task','Binding objective','draft','owner')
  RETURNING id INTO v_task;
  v_snapshot := capture_task_runtime_snapshot(v_task,v_project);
  IF jsonb_array_length(v_snapshot->'executors')<>2 THEN
    RAISE EXCEPTION 'binding snapshot did not capture two executors';
  END IF;
  IF (
    SELECT count(*) FROM jsonb_array_elements(v_snapshot->'executors') e
    WHERE jsonb_typeof(e->'assignment_ids')='array' AND jsonb_array_length(e->'assignment_ids')>=1
  )<>2 THEN
    RAISE EXCEPTION 'snapshot executors are not bound to their assignments';
  END IF;
  IF (
    SELECT count(*) FROM jsonb_array_elements(v_snapshot->'executors') e,
      jsonb_array_elements_text(e->'assignment_ids') aid
    JOIN project_agent_assignments pa ON pa.id=aid::uuid
    JOIN runtime_profiles rp ON rp.id=pa.runtime_profile_id
    WHERE rp.model<>e->>'model_id'
  )<>0 THEN
    RAISE EXCEPTION 'snapshot executor binding resolved to a mismatched model';
  END IF;

  -- A task may select one executor from a project with two. The explicit
  -- capture argument must win even when task assignments are inserted by a
  -- sibling data-modifying CTE in the web action.
  SELECT pa.id INTO v_selected_executor_assignment
  FROM project_agent_assignments pa
  WHERE pa.project_id=v_project AND pa.assignment_role='executor' AND pa.enabled
  ORDER BY pa.created_at,pa.id LIMIT 1;
  INSERT INTO tasks(project_id,title,objective,status,created_by)
  VALUES(v_project,'Partial roster task','Partial roster objective','draft','owner')
  RETURNING id INTO v_task;
  INSERT INTO task_executor_assignments(task_id,project_agent_assignment_id,priority)
  VALUES(v_task,v_selected_executor_assignment,100);
  v_snapshot := capture_task_runtime_snapshot(
    v_task,v_project,ARRAY[v_selected_executor_assignment]
  );
  IF jsonb_array_length(v_snapshot->'executors')<>1
     OR NOT EXISTS (
       SELECT 1
       FROM jsonb_array_elements(v_snapshot->'executors') entry,
            jsonb_array_elements_text(entry->'assignment_ids') assignment_id
       WHERE assignment_id=v_selected_executor_assignment::text
     ) THEN
    RAISE EXCEPTION 'partial executor selection was not preserved in snapshot';
  END IF;

  -- Fail-closed: a catalog snapshot with provenance that does not cover the
  -- handoff assignment must reject the launch instead of falling back to
  -- another executor's model.
  INSERT INTO agents(name,role,runtime_profile_id)
  SELECT 'executor-rogue-' || gen_random_uuid()::text,'implementer',rp.id
  FROM runtime_profiles rp WHERE rp.model='opencode-free' AND rp.enabled LIMIT 1;
  INSERT INTO project_agent_assignments(project_id,agent_id,runtime_profile_id,assignment_role)
  SELECT v_project,a.id,a.runtime_profile_id,'executor'
  FROM agents a WHERE a.role='implementer' AND a.name LIKE 'executor-rogue-%' AND a.enabled
    AND a.runtime_profile_id IN (SELECT id FROM runtime_profiles WHERE model='opencode-free' AND enabled);
  INSERT INTO runtime_profiles(runtime_type,adapter_version,runtime_version,provider_type,model,capabilities,enabled)
  VALUES('codex','0.5.0','0.5.0','openai','codex-orchestrator','{}'::jsonb,true)
  ON CONFLICT DO NOTHING;
  INSERT INTO agents(name,role,runtime_profile_id)
  SELECT 'orchestrator-rogue-' || gen_random_uuid()::text,'architect',rp.id
  FROM runtime_profiles rp WHERE rp.model='codex-orchestrator' AND rp.enabled LIMIT 1;
  INSERT INTO project_agent_assignments(project_id,agent_id,runtime_profile_id,assignment_role,is_default)
  SELECT v_project,a.id,a.runtime_profile_id,'orchestrator',true
  FROM agents a WHERE a.role='architect' AND a.name LIKE 'orchestrator-rogue-%' AND a.enabled
   AND a.runtime_profile_id IN (SELECT id FROM runtime_profiles WHERE model='codex-orchestrator' AND enabled)
   ON CONFLICT DO NOTHING;

  -- Follow-up capture must happen after its source executor roster is copied.
  SELECT pa.id INTO v_orchestrator_assignment
  FROM project_agent_assignments pa
  JOIN agents a ON a.id=pa.agent_id
  WHERE pa.project_id=v_project AND pa.assignment_role='orchestrator'
    AND a.name LIKE 'orchestrator-rogue-%'
  ORDER BY pa.created_at DESC LIMIT 1;
  UPDATE tasks SET status='completed',orchestrator_assignment_id=v_orchestrator_assignment
  WHERE id=v_task;
  v_result := create_followup_task(
    v_project,v_task,gen_random_uuid(),'owner','Partial follow-up',
    'Continue the partial roster task','partial-followup',1,'partial-followup-correlation'
  );
  v_snapshot := get_task_runtime_snapshot((v_result->>'task_id')::uuid);
  IF jsonb_array_length(v_snapshot->'executors')<>1
     OR NOT EXISTS (
       SELECT 1
       FROM jsonb_array_elements(v_snapshot->'executors') entry,
            jsonb_array_elements_text(entry->'assignment_ids') assignment_id
       WHERE assignment_id=v_selected_executor_assignment::text
     ) THEN
    RAISE EXCEPTION 'follow-up snapshot did not preserve the source executor roster';
  END IF;

  -- 0078: the project's orchestrator is Codex now, so a default of OpenCode's
  -- model — OpenCode plays the role since 0076 — is refused: the turn would
  -- have run on Codex with it (rc.47). Nothing is saved.
  BEGIN
    PERFORM set_project_runtime_defaults(v_project,v_owner,3,v_executor_entry,
      ARRAY[v_executor_entry],'','','owner','corr-mismatch');
    RAISE EXCEPTION 'a default of another runtime than the orchestrator''s was accepted';
  EXCEPTION WHEN others THEN
    IF SQLERRM NOT ILIKE '%runtime the project''s orchestrator runs on%' THEN RAISE; END IF;
  END;

  PERFORM set_project_runtime_defaults(v_project,v_owner,3,v_orchestrator_entry,
    ARRAY[v_executor_entry,v_other_executor],'high','standard','owner','corr-7');
  INSERT INTO tasks(project_id,title,objective,status,created_by)
  VALUES(v_project,'Rogue task','Rogue objective','ready','owner')
  RETURNING id INTO v_task;
  PERFORM capture_task_runtime_snapshot(v_task,v_project);
  WITH rogue_handoff AS (
    INSERT INTO handoffs(
      task_id,from_agent_id,to_agent_id,revision_number,objective,instructions,
      constraints,acceptance_criteria,relevant_paths,workspace_ref,
      executor_assignment_id
    )
    SELECT v_task,
      (SELECT agent_id FROM project_agent_assignments pa2
        WHERE pa2.project_id=v_project AND pa2.assignment_role='orchestrator'
        ORDER BY pa2.created_at LIMIT 1),
      pa.agent_id,1,'Rogue handoff','[]'::jsonb,'[]'::jsonb,'[]'::jsonb,'[]'::jsonb,
      '/fixture/workspaces/snapshot-fixture',pa.id
    FROM project_agent_assignments pa
    JOIN agents a ON a.id=pa.agent_id AND a.enabled
    WHERE pa.project_id=v_project AND pa.assignment_role='executor' AND a.name LIKE 'executor-rogue-%'
    LIMIT 1
    RETURNING id
  ), rogue_event AS (
    INSERT INTO domain_events(
      event_type,project_id,task_id,actor_type,actor_id,
      correlation_id,aggregate_type,aggregate_id,aggregate_version,payload
    )
    SELECT 'implementation.requested',v_project,v_task,'system','rogue',
      'rogue-correlation','task',v_task,1,jsonb_build_object('handoff_id',h.id)
    FROM rogue_handoff h
    RETURNING id
  )
  INSERT INTO runtime_jobs(source_event_id,job_type,project_id,task_id,payload)
  SELECT id,'implementation_run',v_project,v_task,'{}'::jsonb
  FROM rogue_event;
  IF resolve_executor_launch_model(
    (SELECT id FROM runtime_jobs WHERE project_id=v_project AND job_type='implementation_run' ORDER BY id DESC LIMIT 1)
  )->>'snapshot_mismatch'<>'true' THEN
    RAISE EXCEPTION 'launch resolver did not fail closed on a mismatched executor';
  END IF;

  RAISE NOTICE 'runtime selection snapshot assertions passed';
END $$;

ROLLBACK;
