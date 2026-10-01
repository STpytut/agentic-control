-- Limits and consumption, the writes (migration 0113, Stage 12).
--
--   * a reading keeps only named, checked fields, and nothing else;
--   * the same reading seen again moves its time and adds no row; the history
--     keeps 50 per connection; a reading for a repository connection, or from a
--     source that is not on the list, is refused;
--   * a dispatch attempt opens its run's row with the member, the task, the
--     connection, the model and the level its snapshot bound; its end closes it;
--   * a run's usage events add up there — Codex's repeated update once, junk as
--     nothing, a list price as an estimate — and a window event becomes the
--     connection's reading; an event nothing can be made of is still appended;
--   * a model check's usage is its own row, counted once, by the worker that
--     holds the check;
--   * the ChatGPT connections nobody has read for five minutes are due;
--   * infra_web reads none of it directly, and infra_worker calls only the
--     three writes.
\set ON_ERROR_STOP on

BEGIN;
SET search_path TO control_plane, public, extensions;

CREATE FUNCTION pg_temp.failure_of(p_sql text) RETURNS text LANGUAGE plpgsql AS $$
DECLARE v_detail text; v_state text;
BEGIN
  EXECUTE p_sql;
  RETURN NULL;
EXCEPTION WHEN OTHERS THEN
  GET STACKED DIAGNOSTICS v_detail = PG_EXCEPTION_DETAIL, v_state = RETURNED_SQLSTATE;
  RETURN v_state || ' ' || COALESCE(v_detail::jsonb->>'reason', 'NO_DETAIL');
END $$;

CREATE FUNCTION pg_temp.launch(p_runtime text, p_model text) RETURNS jsonb LANGUAGE sql AS $$
  SELECT jsonb_build_object('runtime',p_runtime,'executable',p_runtime,'surface','project','adapter_version','1.0.0',
    'runtime_version','1.0.0','verified_runtime_version','1.0.0','capability_verification','verified',
    'capabilities',jsonb_build_array('events.raw','interrupt','sessions.create','sessions.resume'),'model',p_model);
$$;

CREATE FUNCTION pg_temp.grant_for(p_job runtime_jobs, p_assignment uuid) RETURNS void LANGUAGE sql AS $$
  INSERT INTO workspace_access_grants(token_sha256,project_id,job_id,run_id,assignment_id,mode,fencing_token,issued_to,expires_at)
  VALUES(digest(gen_random_uuid()::text,'sha256'),p_job.project_id,p_job.id,p_job.run_id,p_assignment,'read_only',
    NULL,'usage-test',clock_timestamp()+interval '10 minutes');
$$;

CREATE FUNCTION pg_temp.event(p_job bigint, p_type text, p_details jsonb) RETURNS void LANGUAGE sql AS $$
  SELECT append_runtime_activity_event(p_job,'usage-worker','codex',p_type,'running_turn','usage',p_details);
$$;

CREATE TEMP TABLE usage_fixture(name text PRIMARY KEY, id text);

-- ------------------------------------------------------------ cleaning
DO $$
DECLARE v jsonb;
BEGIN
  v := usage_reading_clean('{"windows":[
      {"key":"primary","used_percent":42.46,"resets_at":1790443800,"window_minutes":300,"token":"sk-secret"},
      {"key":"Bad Key","used_percent":10},
      {"key":"over","used_percent":140},
      {"key":"text","used_percent":"50"},
      {"key":"secondary","used_percent":7,"resets_at":99,"window_minutes":-5}],
    "plan":"plus","credits":{"has_credits":true,"unlimited":"yes","balance":"12.50","owner":"me"},
    "status":"allowed","email":"someone@example.com","error_class":"shell"}');
  IF v <> '{"windows":[{"key":"primary","used_percent":42.5,"resets_at":1790443800,"window_minutes":300},
      {"key":"secondary","used_percent":7,"resets_at":null,"window_minutes":null}],
      "plan":"plus","credits":{"has_credits":true,"unlimited":null,"balance":"12.50"},"status":"allowed","error_class":null}'::jsonb THEN
    RAISE EXCEPTION 'a reading kept what it should not, or lost what it should keep: %', v;
  END IF;
  IF usage_reading_clean('"not an object"')->'windows' <> '[]'::jsonb OR usage_reading_clean(NULL)->'windows' <> '[]'::jsonb THEN
    RAISE EXCEPTION 'a reading that is not an object did not clean to nothing';
  END IF;
  IF usage_count('12') <> 12 OR usage_count('"12"') <> 0 OR usage_count('-1') <> 0 OR usage_count('1.5') <> 0
     OR usage_count('99999999999') <> 0 OR usage_count(NULL) <> 0 THEN
    RAISE EXCEPTION 'a count was read from something that is not one';
  END IF;
END $$;

-- ------------------------------------------------------------ fixture
DO $$
DECLARE
  v_user uuid; v_project uuid; v_codex_profile uuid; v_opencode_profile uuid; v_codex uuid; v_worker uuid;
  v_orchestrator uuid; v_executor uuid; v_task uuid; v_chatgpt uuid; v_router uuid; v_github uuid;
BEGIN
  INSERT INTO users(display_name) VALUES('Usage') RETURNING id INTO v_user;
  INSERT INTO projects(owner_id,name,slug,workspace_path)
    VALUES(v_user,'Usage','usage','/srv/infra-cod/workspaces/usage') RETURNING id INTO v_project;
  INSERT INTO workspace_locks(project_id) VALUES(v_project) ON CONFLICT DO NOTHING;
  INSERT INTO runtime_profiles(runtime_type,adapter_version,runtime_version,provider_type,model)
    VALUES('codex','test','test','openai','codex-usage') RETURNING id INTO v_codex_profile;
  INSERT INTO runtime_profiles(runtime_type,adapter_version,runtime_version,provider_type,model)
    VALUES('opencode','test','test','openrouter','opencode-usage') RETURNING id INTO v_opencode_profile;
  INSERT INTO agents(name,role,runtime_profile_id) VALUES('usage-codex','architect',v_codex_profile) RETURNING id INTO v_codex;
  INSERT INTO agents(name,role,runtime_profile_id) VALUES('usage-worker','implementer',v_opencode_profile) RETURNING id INTO v_worker;
  INSERT INTO project_agent_assignments(project_id,agent_id,runtime_profile_id,assignment_role,is_default)
    VALUES(v_project,v_codex,v_codex_profile,'orchestrator',true) RETURNING id INTO v_orchestrator;
  INSERT INTO project_agent_assignments(project_id,agent_id,runtime_profile_id,assignment_role)
    VALUES(v_project,v_worker,v_opencode_profile,'executor') RETURNING id INTO v_executor;
  INSERT INTO tasks(project_id,title,objective,status,active_agent_id,orchestrator_assignment_id,created_by)
    VALUES(v_project,'Usage','test','planning',v_codex,v_orchestrator,'test') RETURNING id INTO v_task;
  INSERT INTO provider_connections(operator_id,provider,auth_method,status)
    VALUES(v_user,'codex','device_code','connected') RETURNING id INTO v_chatgpt;
  INSERT INTO provider_connections(operator_id,provider,auth_method,status,access_gateway,billing_boundary,native_credential_reference)
    VALUES(v_user,'opencode','api_key','connected','openrouter','third_party_metered','opencode-home:opencode-worker')
    RETURNING id INTO v_router;
  INSERT INTO provider_connections(operator_id,provider,auth_method,status,external_installation_id)
    VALUES(v_user,'github','github_app','connected','4242') RETURNING id INTO v_github;
  -- The team as the task's snapshot bound it: the orchestrator on ChatGPT at
  -- "high", the executor on OpenRouter.
  INSERT INTO task_runtime_snapshots(task_id,orchestrator,executors,source) VALUES(v_task,
    jsonb_build_object('runtime_type','codex','connection_id',v_chatgpt,'model_id','gpt-usage','reasoning_effort','high'),
    jsonb_build_array(jsonb_build_object('runtime_type','opencode','connection_id',v_router,'model_id','deepseek/usage',
      'reasoning_effort','','assignment_ids',jsonb_build_array(v_executor::text))),'catalog');
  INSERT INTO usage_fixture VALUES ('user',v_user),('project',v_project),('task',v_task),('orchestrator',v_orchestrator),
    ('executor',v_executor),('chatgpt',v_chatgpt),('router',v_router),('github',v_github);
END $$;

-- ------------------------------------------------------------ readings
DO $$
DECLARE
  v_chatgpt uuid := (SELECT id::uuid FROM usage_fixture WHERE name='chatgpt');
  v_github uuid := (SELECT id::uuid FROM usage_fixture WHERE name='github');
  v_result jsonb; v_again jsonb; v_count integer; v_i integer;
BEGIN
  v_result := record_provider_usage_reading(v_chatgpt,'runtime_read',
    '{"windows":[{"key":"primary","used_percent":10,"resets_at":4000000000,"window_minutes":300}],"plan":"plus"}');
  v_again := record_provider_usage_reading(v_chatgpt,'runtime_read',
    '{"windows":[{"key":"primary","used_percent":10,"resets_at":4000000000,"window_minutes":300}],"plan":"plus"}');
  IF NOT (v_again->>'repeat')::boolean OR v_again->>'reading_id' <> v_result->>'reading_id' THEN
    RAISE EXCEPTION 'the same reading again was not a repeat: % then %', v_result, v_again;
  END IF;
  IF (SELECT count(*) FROM provider_usage_readings WHERE connection_id=v_chatgpt) <> 1 THEN
    RAISE EXCEPTION 'a repeated reading added a row';
  END IF;
  IF (record_provider_usage_reading(v_chatgpt,'runtime_read','{"windows":[],"secret":"x"}'))->>'recorded' <> 'false' THEN
    RAISE EXCEPTION 'a reading with nothing usable was recorded';
  END IF;
  IF pg_temp.failure_of(format($q$SELECT record_provider_usage_reading(%L,'probe_of_my_own','{"plan":"x"}')$q$, v_chatgpt))
     <> '22023 usage_reading_invalid' THEN
    RAISE EXCEPTION 'a source off the list was accepted';
  END IF;
  IF pg_temp.failure_of(format($q$SELECT record_provider_usage_reading(%L,'runtime_read','{"plan":"x"}')$q$, v_github))
     <> '22023 usage_reading_invalid' THEN
    RAISE EXCEPTION 'a reading for a repository connection was accepted';
  END IF;
  -- The probe's source already fits (ADR-0019), error class and all.
  IF (record_provider_usage_reading(v_chatgpt,'probe','{"error_class":"timeout"}'))->>'recorded' <> 'true' THEN
    RAISE EXCEPTION 'a probe''s error reading was not recorded';
  END IF;
  -- A short history: 50 per connection.
  FOR v_i IN 1..60 LOOP
    PERFORM record_provider_usage_reading(v_chatgpt,'runtime_read',
      jsonb_build_object('windows',jsonb_build_array(jsonb_build_object('key','primary','used_percent',v_i))));
  END LOOP;
  SELECT count(*) INTO v_count FROM provider_usage_readings WHERE connection_id=v_chatgpt;
  IF v_count <> 50 THEN RAISE EXCEPTION 'the history kept % readings, not 50', v_count; END IF;
  IF (SELECT windows->0->>'used_percent' FROM provider_usage_readings WHERE connection_id=v_chatgpt
      ORDER BY read_at DESC, id DESC LIMIT 1) <> '60' THEN
    RAISE EXCEPTION 'the history did not keep the latest';
  END IF;
  -- Read a minute ago: not due; ten minutes ago: due.
  IF codex_usage_reads_due(interval '5 minutes') @> jsonb_build_array(jsonb_build_object('connection_id',v_chatgpt)) THEN
    RAISE EXCEPTION 'a connection read just now is due';
  END IF;
  UPDATE provider_usage_readings SET first_read_at = first_read_at - interval '10 minutes', read_at = read_at - interval '10 minutes'
  WHERE connection_id=v_chatgpt;
  IF NOT codex_usage_reads_due(interval '5 minutes') @> jsonb_build_array(jsonb_build_object('connection_id',v_chatgpt)) THEN
    RAISE EXCEPTION 'a connection unread for ten minutes is not due';
  END IF;
  DELETE FROM provider_usage_readings WHERE connection_id=v_chatgpt;
END $$;

-- ------------------------------------------------------------ a run
DO $$
DECLARE
  v_user uuid := (SELECT id::uuid FROM usage_fixture WHERE name='user');
  v_project uuid := (SELECT id::uuid FROM usage_fixture WHERE name='project');
  v_task uuid := (SELECT id::uuid FROM usage_fixture WHERE name='task');
  v_orchestrator uuid := (SELECT id::uuid FROM usage_fixture WHERE name='orchestrator');
  v_chatgpt uuid := (SELECT id::uuid FROM usage_fixture WHERE name='chatgpt');
  v_event domain_events; v_job runtime_jobs; v_dispatch jsonb; v_row run_usage; v_reading provider_usage_readings;
  v_retry jsonb;
BEGIN
  v_event := append_event('chat.user_message',v_project,v_task,NULL,'user','operator',NULL,'usage-1','usage-1',
    'task',v_task,1,'{"content":"hello"}');
  INSERT INTO runtime_jobs(source_event_id,job_type,project_id,task_id,payload)
    VALUES(v_event.id,'orchestrator_turn',v_project,v_task,'{}');
  SELECT * INTO v_job FROM claim_orchestrator_jobs('usage-worker',1,interval '5 minutes');
  IF v_job.id IS NULL THEN RAISE EXCEPTION 'fixture: the turn was not claimed'; END IF;
  PERFORM pg_temp.grant_for(v_job, v_orchestrator);
  v_dispatch := record_runtime_dispatch(v_job.id,'usage-worker',pg_temp.launch('codex','gpt-usage'));

  SELECT * INTO v_row FROM run_usage WHERE attempt_id=(v_dispatch->>'attempt_id')::bigint;
  IF v_row.id IS NULL OR v_row.kind <> 'run' OR v_row.task_id <> v_task OR v_row.project_id <> v_project
     OR v_row.operator_id <> v_user OR v_row.assignment_id <> v_orchestrator OR v_row.connection_id <> v_chatgpt
     OR v_row.model <> 'gpt-usage' OR v_row.reasoning_effort <> 'high' OR v_row.runtime_type <> 'codex'
     OR v_row.finished_at IS NOT NULL OR v_row.cost_basis <> 'none' THEN
    RAISE EXCEPTION 'the attempt did not open its row with what ran: %', to_jsonb(v_row);
  END IF;

  -- Codex: a model call, the same update again, the next call.
  PERFORM pg_temp.event(v_job.id,'runtime.usage.updated',
    '{"tokens":{"input":100,"output":20,"reasoning":5,"cache":{"read":50,"write":0},"total":175},"thread_total":175}');
  PERFORM pg_temp.event(v_job.id,'runtime.usage.updated',
    '{"tokens":{"input":100,"output":20,"reasoning":5,"cache":{"read":50,"write":0},"total":175},"thread_total":175}');
  PERFORM pg_temp.event(v_job.id,'runtime.usage.updated',
    '{"tokens":{"input":10,"output":2,"reasoning":0,"cache":{"read":100,"write":13},"total":125},"thread_total":300}');
  -- Junk from a runtime is nothing, not a failure.
  PERFORM pg_temp.event(v_job.id,'runtime.turn.usage',
    '{"tokens":{"input":"1000","output":-5,"reasoning":1.5,"cache":"lots"},"cost":"free"}');
  SELECT * INTO v_row FROM run_usage WHERE attempt_id=(v_dispatch->>'attempt_id')::bigint;
  IF v_row.input_tokens <> 110 OR v_row.output_tokens <> 22 OR v_row.reasoning_tokens <> 5
     OR v_row.cache_read_tokens <> 150 OR v_row.cache_write_tokens <> 13 OR v_row.total_tokens <> 300
     OR v_row.model_steps <> 3 OR v_row.native_total <> 300 OR v_row.cost_usd IS NOT NULL OR v_row.cost_basis <> 'none' THEN
    RAISE EXCEPTION 'the run''s events did not add up (a repeat counted, or junk): %', to_jsonb(v_row);
  END IF;

  -- The windows the run's stream reported become the connection's reading.
  PERFORM pg_temp.event(v_job.id,'runtime.limits.updated', jsonb_build_object('rate_limits', jsonb_build_object(
    'windows', jsonb_build_array(
      jsonb_build_object('key','primary','used_percent',42,'resets_at',extract(epoch FROM clock_timestamp() + interval '1 hour')::bigint,'window_minutes',300),
      jsonb_build_object('key','secondary','used_percent',12.5,'resets_at',extract(epoch FROM clock_timestamp() + interval '3 days')::bigint,'window_minutes',10080)),
    'plan','plus','credits',jsonb_build_object('has_credits',false,'unlimited',false,'balance','0'),'account','me@example.com')));
  SELECT * INTO v_reading FROM provider_usage_readings WHERE connection_id=v_chatgpt ORDER BY read_at DESC, id DESC LIMIT 1;
  IF v_reading.id IS NULL OR v_reading.source <> 'runtime_stream' OR v_reading.plan <> 'plus' OR v_reading.runtime_type <> 'codex'
     OR jsonb_array_length(v_reading.windows) <> 2 OR v_reading.windows->0->>'used_percent' <> '42'
     OR v_reading.windows::text LIKE '%example.com%' OR v_reading.operator_id <> v_user THEN
    RAISE EXCEPTION 'the stream''s windows were not recorded as the connection''s reading: %', to_jsonb(v_reading);
  END IF;
  -- A window event nothing can be made of is still appended, and records nothing.
  PERFORM pg_temp.event(v_job.id,'runtime.limits.updated','{"rate_limits":{"windows":"full"}}');
  IF (SELECT count(*) FROM provider_usage_readings WHERE connection_id=v_chatgpt) <> 1 THEN
    RAISE EXCEPTION 'an unusable window event was recorded';
  END IF;
  IF (SELECT count(*) FROM runtime_activity_events WHERE job_id=v_job.id) <> 6 THEN
    RAISE EXCEPTION 'an accounting event was not appended to the activity';
  END IF;

  -- The attempt ends: the row closes.
  PERFORM finish_runtime_dispatch_attempt((v_dispatch->>'attempt_id')::bigint,'usage-worker','{"status":"failed"}','thread-1');
  IF (SELECT finished_at FROM run_usage WHERE attempt_id=(v_dispatch->>'attempt_id')::bigint) IS NULL THEN
    RAISE EXCEPTION 'the attempt''s end did not close its row';
  END IF;

  -- The retry is a run of its own; a list price is an estimate.
  PERFORM retry_runtime_job(v_job.id,'usage-worker','test',interval '0 seconds',5);
  SELECT * INTO v_job FROM claim_orchestrator_jobs('usage-worker',1,interval '5 minutes');
  PERFORM pg_temp.grant_for(v_job, v_orchestrator);
  v_retry := record_runtime_dispatch(v_job.id,'usage-worker',pg_temp.launch('codex','gpt-usage'));
  PERFORM append_runtime_activity_event(v_job.id,'usage-worker','codex','runtime.turn.usage','finalizing','usage',
    '{"tokens":{"input":7,"output":3,"reasoning":1,"cache":{"read":0,"write":0},"total":11},"cost":0.0125,"cost_basis":"list_estimate"}');
  PERFORM append_runtime_activity_event(v_job.id,'usage-worker','codex','runtime.turn.usage','finalizing','usage',
    '{"tokens":{"input":1,"output":1,"reasoning":0,"cache":{"read":0,"write":0},"total":2},"cost":0.0005,"cost_basis":"list_estimate"}');
  SELECT * INTO v_row FROM run_usage WHERE attempt_id=(v_retry->>'attempt_id')::bigint;
  IF v_row.total_tokens <> 13 OR v_row.cost_usd <> 0.013 OR v_row.cost_basis <> 'list_estimate' OR v_row.model_steps <> 2 THEN
    RAISE EXCEPTION 'the retry''s run did not add up on its own: %', to_jsonb(v_row);
  END IF;
  IF (SELECT count(*) FROM run_usage WHERE job_id=v_job.id) <> 2 THEN
    RAISE EXCEPTION 'two attempts did not make two runs';
  END IF;
  INSERT INTO usage_fixture VALUES ('job', v_job.id::text);
END $$;

-- ------------------------------------------------------------ a model check
DO $$
DECLARE
  v_user uuid := (SELECT id::uuid FROM usage_fixture WHERE name='user');
  v_router uuid := (SELECT id::uuid FROM usage_fixture WHERE name='router');
  v_entry uuid; v_check uuid; v_row run_usage;
BEGIN
  INSERT INTO provider_model_catalog(operator_id,connection_id,runtime_type,provider_id,model_id,discovery_source)
    VALUES(v_user,v_router,'opencode','openrouter','deepseek/usage','opencode_provider_api') RETURNING id INTO v_entry;
  INSERT INTO model_checks(entry_id,operator_id,connection_id,runtime_type,credential_generation,trigger,automatic,priority,
      root_id,leased_by,lease_until,started_at)
    VALUES(v_entry,v_user,v_router,'opencode',1,'pick',false,0,gen_random_uuid(),'usage-lane',clock_timestamp()+interval '5 minutes',
      clock_timestamp()) RETURNING id INTO v_check;
  IF pg_temp.failure_of(format($q$SELECT record_model_check_usage(%L,'another-lane','{}')$q$, v_check))
     <> '55000 model_check_not_leased' THEN
    RAISE EXCEPTION 'a worker that does not hold the check reported its usage';
  END IF;
  PERFORM record_model_check_usage(v_check,'usage-lane',
    '{"tokens":{"input":30,"output":4,"reasoning":2,"cache":{"read":0,"write":0},"total":36},"cost":0.001,"cost_basis":"list_estimate","steps":1}',
    '{"windows":[{"key":"rolling","used_percent":3}]}');
  PERFORM record_model_check_usage(v_check,'usage-lane',
    '{"tokens":{"input":30,"output":4,"reasoning":2,"cache":{"read":0,"write":0},"total":36},"cost":0.001,"steps":1}');
  SELECT * INTO v_row FROM run_usage WHERE check_id=v_check;
  IF v_row.kind <> 'check' OR v_row.total_tokens <> 36 OR v_row.cost_usd <> 0.001 OR v_row.connection_id <> v_router
     OR v_row.model <> 'deepseek/usage' OR v_row.job_id IS NOT NULL OR v_row.finished_at IS NULL THEN
    RAISE EXCEPTION 'the check''s usage was not recorded once, as a check: %', to_jsonb(v_row);
  END IF;
  IF (SELECT source FROM provider_usage_readings WHERE connection_id=v_router) <> 'runtime_stream' THEN
    RAISE EXCEPTION 'the check''s windows were not recorded';
  END IF;
END $$;

-- ------------------------------------------------------------ who may
DO $$
BEGIN
  IF has_table_privilege('infra_web','control_plane.run_usage','SELECT')
     OR has_table_privilege('infra_web','control_plane.provider_usage_readings','SELECT')
     OR has_table_privilege('infra_worker','control_plane.run_usage','INSERT')
     OR has_table_privilege('infra_worker','control_plane.provider_usage_readings','INSERT') THEN
    RAISE EXCEPTION 'a role reads or writes the usage tables directly';
  END IF;
  IF NOT has_function_privilege('infra_worker','control_plane.record_provider_usage_reading(uuid,text,jsonb,timestamptz)','EXECUTE')
     OR NOT has_function_privilege('infra_worker','control_plane.record_model_check_usage(uuid,text,jsonb,jsonb)','EXECUTE')
     OR NOT has_function_privilege('infra_worker','control_plane.codex_usage_reads_due(interval)','EXECUTE')
     OR has_function_privilege('infra_worker','control_plane.run_usage_add(bigint,jsonb)','EXECUTE')
     OR has_function_privilege('infra_web','control_plane.record_provider_usage_reading(uuid,text,jsonb,timestamptz)','EXECUTE') THEN
    RAISE EXCEPTION 'the usage functions are not granted as intended';
  END IF;
  RAISE NOTICE 'usage and limits: readings cleaned, deduplicated and bounded; a run adds up from its events; a check on its own; nothing granted beyond the writes';
END $$;

ROLLBACK;
