-- Limits and consumption, the panel's reads (migration 0114, Stage 12).
--
--   * Settings: every model connection of the operator, with its latest windows
--     and when and how they were read, today's use and the current window's,
--     checks apart; a connection whose limits need ADR-0019's probe says so and
--     has none; another operator's connections are not in it, and an unknown
--     operator is refused;
--   * the task view: each member of the task's team with what its runs used,
--     running while its attempt is open; the connections they ran on with their
--     windows; nothing for a task that is not the operator's;
--   * infra_web executes the two reads and none of the helpers.
\set ON_ERROR_STOP on

BEGIN;
SET search_path TO control_plane, public, extensions;

CREATE TEMP TABLE reads_fixture(name text PRIMARY KEY, id text);

DO $$
DECLARE
  v_user uuid; v_other uuid; v_project uuid; v_codex_profile uuid; v_opencode_profile uuid; v_codex uuid; v_worker uuid;
  v_orchestrator uuid; v_executor uuid; v_task uuid; v_chatgpt uuid; v_router uuid; v_other_chatgpt uuid;
  v_event domain_events; v_job runtime_jobs; v_entry uuid; v_check uuid; v_go uuid;
BEGIN
  INSERT INTO users(display_name) VALUES('Reads') RETURNING id INTO v_user;
  INSERT INTO users(display_name) VALUES('Someone else') RETURNING id INTO v_other;
  INSERT INTO projects(owner_id,name,slug,workspace_path)
    VALUES(v_user,'Reads','reads','/srv/infra-cod/workspaces/reads') RETURNING id INTO v_project;
  INSERT INTO workspace_locks(project_id) VALUES(v_project) ON CONFLICT DO NOTHING;
  INSERT INTO runtime_profiles(runtime_type,adapter_version,runtime_version,provider_type,model)
    VALUES('codex','test','test','openai','codex-reads') RETURNING id INTO v_codex_profile;
  INSERT INTO runtime_profiles(runtime_type,adapter_version,runtime_version,provider_type,model)
    VALUES('opencode','test','test','openrouter','opencode-reads') RETURNING id INTO v_opencode_profile;
  INSERT INTO agents(name,role,runtime_profile_id) VALUES('reads-codex','architect',v_codex_profile) RETURNING id INTO v_codex;
  INSERT INTO agents(name,role,runtime_profile_id) VALUES('reads-worker','implementer',v_opencode_profile) RETURNING id INTO v_worker;
  INSERT INTO project_agent_assignments(project_id,agent_id,runtime_profile_id,assignment_role,is_default)
    VALUES(v_project,v_codex,v_codex_profile,'orchestrator',true) RETURNING id INTO v_orchestrator;
  INSERT INTO project_agent_assignments(project_id,agent_id,runtime_profile_id,assignment_role)
    VALUES(v_project,v_worker,v_opencode_profile,'executor') RETURNING id INTO v_executor;
  INSERT INTO tasks(project_id,title,objective,status,active_agent_id,orchestrator_assignment_id,created_by)
    VALUES(v_project,'Reads','test','planning',v_codex,v_orchestrator,'test') RETURNING id INTO v_task;
  INSERT INTO task_executor_assignments(task_id,project_agent_assignment_id) VALUES(v_task,v_executor);
  INSERT INTO provider_connections(operator_id,provider,auth_method,status)
    VALUES(v_user,'codex','device_code','connected') RETURNING id INTO v_chatgpt;
  INSERT INTO provider_connections(operator_id,provider,auth_method,status,access_gateway,billing_boundary,native_credential_reference)
    VALUES(v_user,'opencode','api_key','connected','openrouter','third_party_metered','opencode-home:opencode-worker')
    RETURNING id INTO v_router;
  INSERT INTO provider_connections(operator_id,provider,auth_method,status)
    VALUES(v_other,'codex','device_code','connected') RETURNING id INTO v_other_chatgpt;
  INSERT INTO task_runtime_snapshots(task_id,orchestrator,executors,source) VALUES(v_task,
    jsonb_build_object('runtime_type','codex','connection_id',v_chatgpt,'model_id','gpt-reads','reasoning_effort','medium'),
    jsonb_build_array(jsonb_build_object('runtime_type','opencode','connection_id',v_router,'model_id','deepseek/reads',
      'assignment_ids',jsonb_build_array(v_executor::text))),'catalog');

  -- A running orchestrator turn: its attempt opens its row, and its events add up.
  v_event := append_event('chat.user_message',v_project,v_task,NULL,'user','operator',NULL,'reads-1','reads-1',
    'task',v_task,1,'{"content":"hello"}');
  INSERT INTO runtime_jobs(source_event_id,job_type,project_id,task_id,payload)
    VALUES(v_event.id,'orchestrator_turn',v_project,v_task,'{}');
  SELECT * INTO v_job FROM claim_orchestrator_jobs('reads-worker',1,interval '5 minutes');
  INSERT INTO workspace_access_grants(token_sha256,project_id,job_id,run_id,assignment_id,mode,fencing_token,issued_to,expires_at)
    VALUES(digest(gen_random_uuid()::text,'sha256'),v_job.project_id,v_job.id,v_job.run_id,v_orchestrator,'read_only',
      NULL,'reads-test',clock_timestamp()+interval '10 minutes');
  PERFORM record_runtime_dispatch(v_job.id,'reads-worker',jsonb_build_object('runtime','codex','executable','codex',
    'surface','project','adapter_version','1.0.0','runtime_version','1.0.0','verified_runtime_version','1.0.0',
    'capability_verification','verified','capabilities',jsonb_build_array('events.raw','interrupt'),'model','gpt-reads'));
  PERFORM append_runtime_activity_event(v_job.id,'reads-worker','codex','runtime.usage.updated','running_turn','usage',
    '{"tokens":{"input":900,"output":80,"reasoning":20,"cache":{"read":0,"write":0},"total":1000},"thread_total":1000}');
  PERFORM append_runtime_activity_event(v_job.id,'reads-worker','codex','runtime.limits.updated','running_turn','limits',
    jsonb_build_object('rate_limits',jsonb_build_object('plan','pro','windows',jsonb_build_array(
      jsonb_build_object('key','primary','used_percent',61,'resets_at',extract(epoch FROM clock_timestamp()+interval '1 hour')::bigint,'window_minutes',300),
      jsonb_build_object('key','secondary','used_percent',20,'resets_at',extract(epoch FROM clock_timestamp()+interval '3 days')::bigint,'window_minutes',10080),
      jsonb_build_object('key','stale','used_percent',99,'resets_at',extract(epoch FROM clock_timestamp()-interval '1 minute')::bigint,'window_minutes',60)))));

  -- Earlier use: the executor's finished run on OpenRouter, priced by OpenCode
  -- at list price; a run two days ago, in neither today nor the window; a check.
  v_event := append_event('chat.user_message',v_project,v_task,NULL,'user','operator',NULL,'reads-2','reads-2',
    'task',v_task,2,'{"content":"earlier"}');
  INSERT INTO runtime_jobs(source_event_id,job_type,project_id,task_id,payload,status,completed_at)
    VALUES(v_event.id,'orchestrator_turn',v_project,v_task,'{}','completed',clock_timestamp()) RETURNING * INTO v_job;
  INSERT INTO run_usage(kind,job_id,operator_id,project_id,task_id,assignment_id,agent_id,connection_id,runtime_type,model,
      input_tokens,output_tokens,total_tokens,model_steps,cost_usd,cost_basis,started_at,finished_at)
    VALUES('run',v_job.id,v_user,v_project,v_task,v_executor,v_worker,v_router,'opencode','deepseek/reads',
      400,100,500,3,0.02,'list_estimate',clock_timestamp()-interval '1 minute',clock_timestamp());
  v_event := append_event('chat.user_message',v_project,v_task,NULL,'user','operator',NULL,'reads-3','reads-3',
    'task',v_task,3,'{"content":"long ago"}');
  INSERT INTO runtime_jobs(source_event_id,job_type,project_id,task_id,payload,status,completed_at)
    VALUES(v_event.id,'orchestrator_turn',v_project,v_task,'{}','completed',clock_timestamp()) RETURNING * INTO v_job;
  INSERT INTO run_usage(kind,job_id,operator_id,project_id,task_id,assignment_id,connection_id,runtime_type,model,
      input_tokens,total_tokens,started_at,finished_at)
    VALUES('run',v_job.id,v_user,v_project,v_task,v_orchestrator,v_chatgpt,'codex','gpt-reads',7000,7000,
      clock_timestamp()-interval '2 days',clock_timestamp()-interval '2 days');
  INSERT INTO provider_model_catalog(operator_id,connection_id,runtime_type,provider_id,model_id,discovery_source)
    VALUES(v_user,v_chatgpt,'codex','openai','gpt-reads','codex_model_list') RETURNING id INTO v_entry;
  INSERT INTO model_checks(entry_id,operator_id,connection_id,runtime_type,credential_generation,trigger,automatic,priority,
      root_id,result,model_called,started_at,finished_at)
    VALUES(v_entry,v_user,v_chatgpt,'codex',1,'pick',false,0,gen_random_uuid(),'passed',true,clock_timestamp(),clock_timestamp())
    RETURNING id INTO v_check;
  INSERT INTO run_usage(kind,check_id,operator_id,connection_id,runtime_type,model,input_tokens,total_tokens,started_at,finished_at)
    VALUES('check',v_check,v_user,v_chatgpt,'codex','gpt-reads',40,40,clock_timestamp()-interval '1 minute',clock_timestamp());
  -- OpenCode Go: no reading (its probe is not installed), and requests per
  -- model in the last five hours — a run's steps and a check's — beside one
  -- from six hours ago that is not counted.
  INSERT INTO provider_connections(operator_id,provider,auth_method,status,access_gateway,billing_boundary,native_credential_reference)
    VALUES(v_user,'opencode','api_key','connected','opencode_go','subscription','opencode-home:opencode-worker')
    RETURNING id INTO v_go;
  v_event := append_event('chat.user_message',v_project,v_task,NULL,'user','operator',NULL,'reads-4','reads-4',
    'task',v_task,4,'{"content":"on Go"}');
  INSERT INTO runtime_jobs(source_event_id,job_type,project_id,task_id,payload,status,completed_at)
    VALUES(v_event.id,'orchestrator_turn',v_project,v_task,'{}','completed',clock_timestamp()) RETURNING * INTO v_job;
  INSERT INTO run_usage(kind,job_id,operator_id,project_id,task_id,connection_id,runtime_type,model,total_tokens,model_steps,
      started_at,finished_at)
    VALUES('run',v_job.id,v_user,v_project,v_task,v_go,'opencode','kimi-k3',900,7,clock_timestamp()-interval '2 hours',clock_timestamp());
  INSERT INTO provider_model_catalog(operator_id,connection_id,runtime_type,provider_id,model_id,discovery_source)
    VALUES(v_user,v_go,'opencode','opencode-go','glm-5.3-flash','opencode_provider_api') RETURNING id INTO v_entry;
  INSERT INTO model_checks(entry_id,operator_id,connection_id,runtime_type,credential_generation,trigger,automatic,priority,
      root_id,result,model_called,started_at,finished_at)
    VALUES(v_entry,v_user,v_go,'opencode',1,'pick',false,0,gen_random_uuid(),'passed',true,clock_timestamp(),clock_timestamp())
    RETURNING id INTO v_check;
  INSERT INTO run_usage(kind,check_id,operator_id,connection_id,runtime_type,model,total_tokens,model_steps,started_at,finished_at)
    VALUES('check',v_check,v_user,v_go,'opencode','glm-5.3-flash',30,1,clock_timestamp()-interval '1 minute',clock_timestamp());
  INSERT INTO model_checks(entry_id,operator_id,connection_id,runtime_type,credential_generation,trigger,automatic,priority,
      root_id,result,model_called,started_at,finished_at)
    VALUES(v_entry,v_user,v_go,'opencode',1,'pick',false,0,gen_random_uuid(),'passed',true,clock_timestamp()-interval '6 hours',
      clock_timestamp()-interval '6 hours') RETURNING id INTO v_check;
  INSERT INTO run_usage(kind,check_id,operator_id,connection_id,runtime_type,model,total_tokens,model_steps,started_at,finished_at)
    VALUES('check',v_check,v_user,v_go,'opencode','glm-5.3-flash',30,1,clock_timestamp()-interval '6 hours',clock_timestamp()-interval '6 hours');
  INSERT INTO reads_fixture VALUES ('user',v_user),('other',v_other),('project',v_project),('task',v_task),
    ('orchestrator',v_orchestrator),('executor',v_executor),('chatgpt',v_chatgpt),('router',v_router),('go',v_go);
END $$;

-- ------------------------------------------------------------ Settings
DO $$
DECLARE
  v_user uuid := (SELECT id::uuid FROM reads_fixture WHERE name='user');
  v_other uuid := (SELECT id::uuid FROM reads_fixture WHERE name='other');
  v_chatgpt uuid := (SELECT id::uuid FROM reads_fixture WHERE name='chatgpt');
  v_router uuid := (SELECT id::uuid FROM reads_fixture WHERE name='router');
  v_go uuid := (SELECT id::uuid FROM reads_fixture WHERE name='go');
  v_all jsonb; v_codex jsonb; v_or jsonb; v_gojson jsonb;
BEGIN
  v_all := get_operator_usage_limits(v_user);
  IF jsonb_array_length(v_all->'connections') <> 3 THEN
    RAISE EXCEPTION 'the operator''s three model connections, and only those: %', v_all->'connections';
  END IF;
  SELECT c INTO v_codex FROM jsonb_array_elements(v_all->'connections') c WHERE c->>'connection_id' = v_chatgpt::text;
  SELECT c INTO v_or FROM jsonb_array_elements(v_all->'connections') c WHERE c->>'connection_id' = v_router::text;
  IF v_codex->>'label' <> 'ChatGPT' OR v_codex->>'limits_mode' <> 'read' OR v_codex->'limits'->>'source' <> 'runtime_stream'
     OR v_codex->'limits'->>'plan' <> 'pro' OR jsonb_array_length(v_codex->'limits'->'windows') <> 3
     OR (v_codex->'limits'->'windows'->0->>'reset_passed')::boolean OR NOT (v_codex->'limits'->'windows'->2->>'reset_passed')::boolean
     OR v_codex->'limits'->'windows'->0->>'resets_at' IS NULL THEN
    RAISE EXCEPTION 'the ChatGPT connection''s windows are not as read: %', v_codex->'limits';
  END IF;
  -- Today: the running turn's 1000 tokens (the run two days ago is not today's);
  -- the check apart.
  IF (v_codex->'today'->>'total_tokens')::bigint <> 1000 OR (v_codex->'today'->>'runs')::int <> 1
     OR (v_codex->'today'->'checks'->>'count')::int <> 1 OR (v_codex->'today'->'checks'->>'total_tokens')::int <> 40
     OR v_codex->'today'->>'cost_basis' <> 'none' OR v_codex->'today'->'cost_usd' <> 'null'::jsonb THEN
    RAISE EXCEPTION 'today''s use of ChatGPT: %', v_codex->'today';
  END IF;
  -- The current window is the 5 h one (the shortest that has not reset).
  IF v_codex->'window'->>'key' <> 'primary' OR (v_codex->'window'->'usage'->>'total_tokens')::bigint <> 1000
     OR (v_codex->'window'->>'until')::timestamptz - (v_codex->'window'->>'since')::timestamptz <> interval '300 minutes' THEN
    RAISE EXCEPTION 'the current window of ChatGPT: %', v_codex->'window';
  END IF;
  -- OpenRouter has no limits, and its balance is not read (ADR-0019, accepted).
  IF v_or->>'label' <> 'OpenRouter' OR v_or->>'limits_mode' <> 'none' OR v_or->'limits' <> 'null'::jsonb
     OR v_or->'requests_5h' <> 'null'::jsonb
     OR v_or->'window' <> 'null'::jsonb OR (v_or->'today'->>'cost_usd')::numeric <> 0.02
     OR v_or->'today'->>'cost_basis' <> 'list_estimate' OR (v_or->'today'->>'total_tokens')::int <> 500 THEN
    RAISE EXCEPTION 'OpenRouter: consumption shown as an estimate, limits not available: %', v_or;
  END IF;
  SELECT c INTO v_gojson FROM jsonb_array_elements(v_all->'connections') c WHERE c->>'connection_id' = v_go::text;
  IF v_gojson->>'label' <> 'OpenCode Go' OR v_gojson->>'limits_mode' <> 'probe' OR v_gojson->'limits' <> 'null'::jsonb
     OR v_gojson->'requests_5h'->'models' <> '[{"model":"kimi-k3","requests":7,"total_tokens":900},
                                               {"model":"glm-5.3-flash","requests":1,"total_tokens":30}]'::jsonb THEN
    RAISE EXCEPTION 'OpenCode Go: requests per model in the last five hours: %', v_gojson;
  END IF;
  IF get_operator_usage_limits(v_other)->'connections'->0->>'connection_id' = v_chatgpt::text THEN
    RAISE EXCEPTION 'another operator saw this operator''s connection';
  END IF;
  BEGIN
    PERFORM get_operator_usage_limits(gen_random_uuid());
    RAISE EXCEPTION 'an unknown operator was answered';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END $$;

-- ------------------------------------------------------------ the task view
DO $$
DECLARE
  v_user uuid := (SELECT id::uuid FROM reads_fixture WHERE name='user');
  v_other uuid := (SELECT id::uuid FROM reads_fixture WHERE name='other');
  v_project uuid := (SELECT id::uuid FROM reads_fixture WHERE name='project');
  v_task uuid := (SELECT id::uuid FROM reads_fixture WHERE name='task');
  v_orchestrator uuid := (SELECT id::uuid FROM reads_fixture WHERE name='orchestrator');
  v_executor uuid := (SELECT id::uuid FROM reads_fixture WHERE name='executor');
  v_usage jsonb; v_lead jsonb; v_exec jsonb;
BEGIN
  v_usage := get_task_usage(v_project, v_task, v_user);
  IF NOT (v_usage->>'active')::boolean OR jsonb_array_length(v_usage->'members') <> 2 THEN
    RAISE EXCEPTION 'the task''s team, live: %', v_usage;
  END IF;
  v_lead := v_usage->'members'->0;
  v_exec := v_usage->'members'->1;
  IF v_lead->>'assignment_id' <> v_orchestrator::text OR v_lead->>'role_key' <> 'orchestrator'
     OR NOT (v_lead->>'running')::boolean OR (v_lead->'usage'->>'total_tokens')::bigint <> 8000
     OR (v_lead->'usage'->>'runs')::int <> 2 OR v_lead->>'model' <> 'gpt-reads' OR v_lead->>'reasoning_effort' <> 'medium' THEN
    RAISE EXCEPTION 'the orchestrator''s line: %', v_lead;
  END IF;
  IF v_exec->>'assignment_id' <> v_executor::text OR (v_exec->>'running')::boolean
     OR (v_exec->'usage'->>'cost_usd')::numeric <> 0.02 OR v_exec->'usage'->>'cost_basis' <> 'list_estimate' THEN
    RAISE EXCEPTION 'the executor''s line: %', v_exec;
  END IF;
  IF (v_usage->'totals'->>'total_tokens')::bigint <> 9400 OR (v_usage->'totals'->'checks'->>'count')::int <> 0 THEN
    RAISE EXCEPTION 'the task''s totals (checks are not a task''s): %', v_usage->'totals';
  END IF;
  IF jsonb_array_length(v_usage->'connections') <> 3
     OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_usage->'connections') c
                    WHERE c->>'label' = 'ChatGPT' AND c->'limits'->>'plan' = 'pro') THEN
    RAISE EXCEPTION 'the connections the team ran on: %', v_usage->'connections';
  END IF;
  IF get_task_usage(v_project, v_task, v_other) IS NOT NULL THEN
    RAISE EXCEPTION 'another operator read this task''s usage';
  END IF;
END $$;

-- ------------------------------------------------------------ who may
DO $$
BEGIN
  IF NOT has_function_privilege('infra_web','control_plane.get_operator_usage_limits(uuid)','EXECUTE')
     OR NOT has_function_privilege('infra_web','control_plane.get_task_usage(uuid,uuid,uuid)','EXECUTE')
     OR has_function_privilege('infra_web','control_plane.latest_usage_reading(uuid)','EXECUTE')
     OR has_function_privilege('infra_web','control_plane.usage_totals(control_plane.run_usage[])','EXECUTE') THEN
    RAISE EXCEPTION 'the panel''s reads are not granted as intended';
  END IF;
  RAISE NOTICE 'usage reads: connections with windows, today and the window, checks apart, probe connections without limits; the task''s members live; only the operator''s';
END $$;

ROLLBACK;
