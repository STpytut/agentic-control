-- Neutral names for the orchestrator's workflow functions (Stage 11.2 N3).
--
-- The workers are renamed in this release — codex-chat-worker becomes the
-- orchestrator worker and executor-worker the implementation worker, and the
-- update retires their old units — and the six functions the orchestrator
-- worker calls lose the vendor from their names with them:
--
--   claim_codex_chat_jobs          -> claim_orchestrator_jobs
--   codex_chat_job_context         -> orchestrator_job_context
--   bind_codex_chat_session        -> bind_orchestrator_session
--   complete_codex_chat_job        -> complete_orchestrator_job
--   invoke_codex_delegate_task     -> invoke_delegate_task
--   invoke_codex_request_revision  -> invoke_request_revision
--
-- A rename, not a copy: signatures, grants, owners, SECURITY mode and
-- search_path go with the function. complete_orchestrator_job is redefined
-- because it calls bind_orchestrator_session by name, and its one message that
-- named the vendor no longer does.
--
-- The functions of credentials and connections keep their runtime's name; they
-- are per runtime until 11.4.
--
-- No expand half, unlike 0073: nothing queued refers to a function by name,
-- and 0073 already requires every service stopped for this release, so no
-- worker of the previous release calls the old names after this runs.

SET search_path TO control_plane, public, extensions;

ALTER FUNCTION claim_codex_chat_jobs(text,integer,interval) RENAME TO claim_orchestrator_jobs;
ALTER FUNCTION codex_chat_job_context(bigint,text) RENAME TO orchestrator_job_context;
ALTER FUNCTION bind_codex_chat_session(bigint,text,text) RENAME TO bind_orchestrator_session;
ALTER FUNCTION complete_codex_chat_job(bigint,text,text,text,text) RENAME TO complete_orchestrator_job;
ALTER FUNCTION invoke_codex_delegate_task(bigint,text,text,text,jsonb,jsonb) RENAME TO invoke_delegate_task;
ALTER FUNCTION invoke_codex_request_revision(bigint,text,text,jsonb) RENAME TO invoke_request_revision;

CREATE OR REPLACE FUNCTION complete_orchestrator_job(p_job_id bigint, p_worker_id text, p_native_session_id text, p_turn_id text, p_content text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'control_plane', 'public', 'extensions', 'pg_temp'
AS $function$
DECLARE v_job runtime_jobs%ROWTYPE; v_task tasks%ROWTYPE;
  v_assignment project_agent_assignments%ROWTYPE; v_agent agents%ROWTYPE;
  v_profile runtime_profiles%ROWTYPE; v_session_id uuid;
  v_event domain_events%ROWTYPE; v_result jsonb;
BEGIN
  IF p_turn_id IS NULL OR length(p_turn_id)=0 OR p_content IS NULL OR length(trim(p_content))=0 THEN
    RAISE EXCEPTION 'orchestrator turn id and response content are required' USING ERRCODE='22023', DETAIL=jsonb_build_object('reason','turn_result_invalid')::text;
  END IF;
  SELECT * INTO v_job FROM runtime_jobs j WHERE j.id=p_job_id FOR UPDATE;
  IF NOT FOUND OR v_job.job_type NOT IN ('codex_chat_turn','resume_codex','orchestrator_turn','resume_orchestrator')
     OR v_job.status<>'in_flight' OR v_job.leased_by<>p_worker_id
     OR v_job.leased_until<=clock_timestamp() THEN
    RAISE EXCEPTION 'orchestration job is not actively leased' USING ERRCODE='55000', DETAIL=jsonb_build_object('reason','orchestration_job_not_leased')::text;
  END IF;
  v_session_id:=bind_orchestrator_session(p_job_id,p_worker_id,p_native_session_id);
  SELECT * INTO v_task FROM tasks t WHERE t.id=v_job.task_id FOR UPDATE;
  SELECT * INTO v_assignment FROM project_agent_assignments pa WHERE pa.id=v_task.orchestrator_assignment_id;
  SELECT * INTO v_agent FROM agents a WHERE a.id=v_assignment.agent_id;
  SELECT * INTO v_profile FROM runtime_profiles rp WHERE rp.id=v_assignment.runtime_profile_id;
  UPDATE tasks SET
      status=CASE WHEN v_job.job_type IN ('resume_codex','resume_orchestrator') AND status='reviewing' THEN 'awaiting_review' ELSE status END,
      version=version+1,updated_at=clock_timestamp()
    WHERE id=v_task.id RETURNING * INTO v_task;
  v_event:=append_event('chat.agent_message',v_job.project_id,v_job.task_id,NULL,
    'agent',v_agent.id::text,NULL,COALESCE(v_job.payload->>'correlation_id',v_job.task_id::text),
    'orchestrator-chat-response:' || v_job.source_event_id,'task',v_job.task_id,v_task.version,
    jsonb_build_object('content',p_content,'turn_id',p_turn_id,'agent_name',v_agent.name,
      'runtime_type',v_profile.runtime_type,'provider_type',v_profile.provider_type,'model',v_profile.model,
      'orchestrator_assignment_id',v_assignment.id,'runtime_profile_id',v_assignment.runtime_profile_id,
      'native_session_id',p_native_session_id,'session_id',v_session_id,'job_id',v_job.id,
      'source_job_type',v_job.job_type));
  v_result:=jsonb_build_object('status','completed','event_id',v_event.id,'task_id',v_job.task_id,
    'task_version',v_task.version,'task_status',v_task.status,'session_id',v_session_id,
    'native_session_id',p_native_session_id,'turn_id',p_turn_id,'source_job_type',v_job.job_type);
  PERFORM acknowledge_runtime_job(p_job_id,p_worker_id,v_result);
  RETURN v_result;
END; $function$;
