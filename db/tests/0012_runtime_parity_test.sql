BEGIN;
SET search_path TO control_plane,public;

DO $$
DECLARE v_user uuid; v_project uuid; v_profile uuid; v_agent uuid; v_assignment uuid; v_task uuid;
  v_domain domain_events%ROWTYPE; v_job runtime_jobs%ROWTYPE; v_id bigint; v_event runtime_activity_events%ROWTYPE;
  v_result jsonb;
BEGIN
  INSERT INTO users(display_name) VALUES('Runtime Parity Test') RETURNING id INTO v_user;
  INSERT INTO projects(owner_id,name,slug,workspace_path) VALUES(v_user,'Runtime Parity Test',
    'runtime-parity-test','/srv/runtime-parity-test') RETURNING id INTO v_project;
  INSERT INTO runtime_profiles(runtime_type,adapter_version,runtime_version,provider_type,model,capabilities)
    VALUES('codex','test','test','test','test','{"interrupt":true}') RETURNING id INTO v_profile;
  INSERT INTO agents(name,role,runtime_profile_id) VALUES('runtime-parity-agent','architect',v_profile) RETURNING id INTO v_agent;
  INSERT INTO project_agent_assignments(project_id,agent_id,runtime_profile_id,assignment_role,is_default)
    VALUES(v_project,v_agent,v_profile,'orchestrator',true) RETURNING id INTO v_assignment;
  INSERT INTO tasks(project_id,title,objective,status,active_agent_id,orchestrator_assignment_id,created_by)
    VALUES(v_project,'Parity','Test bounded activity','planning',v_agent,v_assignment,'test') RETURNING id INTO v_task;
  v_domain:=append_event('chat.user_message',v_project,v_task,NULL,'user','test',NULL,v_task::text,
    'parity-message:'||v_task,'task',v_task,1,'{"content":"test"}');
  INSERT INTO runtime_jobs(source_event_id,job_type,project_id,task_id,status,leased_by,leased_until)
    VALUES(v_domain.id,'orchestrator_turn',v_project,v_task,'in_flight','parity-test',clock_timestamp()+interval '5 minutes')
    RETURNING * INTO v_job;
  v_id:=append_runtime_activity_event(v_job.id,'parity-test','codex','runtime.turn.started','running_turn','Bounded event','{}');
  SELECT * INTO v_event FROM runtime_activity_events WHERE id=v_id;
  IF v_event.summary<>'Bounded event' OR v_event.sequence<1 THEN RAISE EXCEPTION 'normalized event was not persisted'; END IF;
  BEGIN
    PERFORM append_runtime_activity_event(v_job.id,'parity-test','codex','bad-event','running_turn','bad','{}');
    RAISE EXCEPTION 'invalid event unexpectedly accepted';
  EXCEPTION WHEN SQLSTATE '22023' THEN NULL; END;
  v_result:=request_runtime_interrupt(v_project,v_task,'operator-test','Stop parity run',v_task::text);
  IF v_result->>'status'<>'interrupt_requested' OR runtime_interrupt_request(v_job.id,'parity-test') IS NULL THEN
    RAISE EXCEPTION 'interrupt request was not capability-gated and persisted'; END IF;
  v_result:=finalize_runtime_interrupt(v_job.id,'parity-test','codex-test-session');
  IF v_result->>'status'<>'interrupted' OR
     (SELECT status FROM runtime_jobs WHERE id=v_job.id)<>'completed' OR
     NOT EXISTS(SELECT 1 FROM domain_events WHERE task_id=v_task AND event_type='run.interrupted') THEN
    RAISE EXCEPTION 'Codex interrupt was not finalized'; END IF;
END $$;
ROLLBACK;
