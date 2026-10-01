-- Neutral job names, expand half (Stage 11.2 N1; decision D3).
--
-- The three job types name a vendor: `codex_chat_turn`, `resume_codex`,
-- `start_implementation`. 11.2 replaces them with `orchestrator_turn`,
-- `resume_orchestrator` and `implementation_run`, over two releases rather
-- than one, because a rename in one step strands whatever is queued under the
-- old name when the update runs.
--
-- This release, the expand:
--
--   * the CHECK admits both vocabularies;
--   * the one writer, route_outbox_message, writes only the new names;
--   * every reader accepts both — each comparison that named an old type now
--     names the pair — so a job queued, in flight or dead-lettered under an old
--     name before the update is claimed, run, retried and finished after it;
--   * the orchestrator-turn run trigger fires for both.
--
-- The contract half (N6, one release after this one reaches the host) drops
-- the old names from the CHECK and from every list below.
--
-- The 26 functions are their effective definitions (the latest migration that
-- defined each, 0059-0072) with only the job-type comparisons changed; nothing
-- else in them moved. Function names that still say `codex` are N3's, and the
-- `runtime_type='codex'` in route_outbox_message is N2's: this migration
-- renames what a job is, not who may run it.
--
-- Copying a body forward brings its refusals with it, and 29 of them predate
-- 0067 and name no reason. Each now carries one in DETAIL — an existing reason
-- where one fits, else one of the eleven declared below — with its sentence
-- and ERRCODE unchanged, so a caller matching on either sees what it saw.

SET search_path TO control_plane, public, extensions;

ALTER TABLE runtime_jobs DROP CONSTRAINT runtime_jobs_job_type_check;
ALTER TABLE runtime_jobs ADD CONSTRAINT runtime_jobs_job_type_check CHECK (job_type IN (
  'start_implementation','resume_codex','codex_chat_turn',
  'implementation_run','resume_orchestrator','orchestrator_turn'));

ALTER TABLE runtime_jobs DROP CONSTRAINT runtime_jobs_orchestrator_turn_has_run;
ALTER TABLE runtime_jobs ADD CONSTRAINT runtime_jobs_orchestrator_turn_has_run CHECK (
  job_type NOT IN ('codex_chat_turn','resume_codex','orchestrator_turn','resume_orchestrator')
  OR attempt_count=0 OR run_id IS NOT NULL);

INSERT INTO failure_reasons(reason, code, note) VALUES
  ('outbox_message_not_leased','lease_lost','the outbox message is not leased by this dispatcher, or its lease ran out'),
  ('orchestrator_unavailable','conflict','the task has no enabled orchestrator assignment, agent or runtime to own the turn'),
  ('turn_result_invalid','invalid_argument','a finished turn names no turn id or carries no response'),
  ('defer_delay_invalid','invalid_argument','a deferral is between one second and ten minutes'),
  ('delegation_arguments_invalid','invalid_argument','delegate_task needs an objective and its lists as JSON arrays'),
  ('task_not_delegable','conflict','the task is not in a state that takes its first delegation'),
  ('launch_reservation_invalid','invalid_argument','the launch reservation names a lifetime, run or job that does not fit'),
  ('launch_reservation_exists','conflict','a launch reservation for this run already exists'),
  ('project_unavailable','conflict','the project is missing, archived, being deleted or not operable'),
  ('workspace_operation_invalid','conflict','the workspace operation is unknown, or the lock is not in the state it needs'),
  ('runtime_job_unavailable','conflict','no claimable job for that event and type');

DROP TRIGGER runtime_jobs_orchestrator_turn_run ON runtime_jobs;
CREATE TRIGGER runtime_jobs_orchestrator_turn_run BEFORE UPDATE OF status, attempt_count ON runtime_jobs
  FOR EACH ROW WHEN (NEW.job_type IN ('codex_chat_turn','resume_codex','orchestrator_turn','resume_orchestrator'))
  EXECUTE FUNCTION record_orchestrator_turn_run();

CREATE OR REPLACE FUNCTION assert_supervised_implementation(p_job_id bigint, p_supervisor_id text, p_run_id uuid, p_fencing_token bigint)
 RETURNS control_plane.runtime_jobs
 LANGUAGE plpgsql
 SET search_path TO 'control_plane', 'public', 'extensions', 'pg_temp'
AS $function$
DECLARE v_job runtime_jobs%ROWTYPE; v_run task_runs%ROWTYPE;
BEGIN
  SELECT * INTO v_job FROM runtime_jobs j WHERE j.id=p_job_id FOR UPDATE;
  IF NOT FOUND THEN
    PERFORM refuse('job_not_found', format('no runtime job %s', p_job_id));
  END IF;
  IF v_job.job_type NOT IN ('start_implementation','implementation_run') THEN
    PERFORM refuse('job_type_mismatch', format('job %s is %s, not start_implementation', p_job_id, v_job.job_type));
  END IF;
  IF v_job.status<>'in_flight' THEN
    PERFORM refuse('job_not_in_flight', format('job %s is %s', p_job_id, v_job.status));
  END IF;
  IF v_job.leased_by IS DISTINCT FROM p_supervisor_id THEN
    PERFORM refuse('job_lease_held_by_another', format('job %s is leased by another worker', p_job_id));
  END IF;
  IF v_job.leased_until<=clock_timestamp() THEN
    PERFORM refuse('job_lease_expired', format('the lease of job %s expired', p_job_id));
  END IF;
  IF v_job.run_id IS DISTINCT FROM p_run_id THEN
    PERFORM refuse('completion_job_mismatch', format('job %s is not the job of run %s', p_job_id, p_run_id));
  END IF;
  SELECT * INTO v_run FROM task_runs r WHERE r.id=p_run_id FOR UPDATE;
  IF NOT FOUND THEN
    PERFORM refuse('run_not_found', format('no run %s', p_run_id), '55000');
  END IF;
  IF NOT v_run.write_capable THEN
    PERFORM refuse('run_not_write_capable', format('run %s is a turn', p_run_id));
  END IF;
  IF v_run.status<>'running' THEN
    PERFORM refuse('run_not_running', format('run %s is %s, not running', p_run_id, v_run.status));
  END IF;
  PERFORM assert_workspace_fence(v_job.project_id, p_run_id, p_fencing_token);
  RETURN v_job;
END $function$;

CREATE OR REPLACE FUNCTION active_run_of_job(p_job control_plane.runtime_jobs)
 RETURNS uuid
 LANGUAGE sql
 STABLE
 SET search_path TO 'control_plane', 'public', 'extensions', 'pg_temp'
AS $function$
  SELECT r.id FROM task_runs r
  WHERE r.id=p_job.run_id
    AND r.status IN ('starting','running','waiting_for_input','blocked')
    AND ((p_job.job_type IN ('codex_chat_turn','resume_codex','orchestrator_turn','resume_orchestrator') AND NOT r.write_capable)
      OR (p_job.job_type IN ('start_implementation','implementation_run') AND r.write_capable));
$function$;

CREATE OR REPLACE FUNCTION runtime_job_runtime(p_job control_plane.runtime_jobs)
 RETURNS text
 LANGUAGE sql
 STABLE
 SET search_path TO 'control_plane', 'public', 'extensions', 'pg_temp'
AS $function$
  SELECT COALESCE(
    (current_runtime_job_selection(p_job.id)).runtime_type,
    (SELECT rp.runtime_type FROM workspace_access_grants g
       JOIN project_agent_assignments pa ON pa.id=g.assignment_id
       JOIN runtime_profiles rp ON rp.id=pa.runtime_profile_id
     WHERE g.job_id=p_job.id ORDER BY g.issued_at DESC LIMIT 1),
    CASE WHEN p_job.job_type IN ('codex_chat_turn','resume_codex','orchestrator_turn','resume_orchestrator') THEN
      (SELECT rp.runtime_type FROM tasks t
         JOIN project_agent_assignments pa ON pa.id=t.orchestrator_assignment_id
         JOIN runtime_profiles rp ON rp.id=pa.runtime_profile_id WHERE t.id=p_job.task_id)
    ELSE
      (SELECT rp.runtime_type FROM domain_events e
         JOIN handoffs h ON h.id=NULLIF(e.payload->>'handoff_id','')::uuid
         JOIN agents a ON a.id=h.to_agent_id
         JOIN runtime_profiles rp ON rp.id=a.runtime_profile_id WHERE e.id=p_job.source_event_id)
    END);
$function$;

CREATE OR REPLACE FUNCTION route_outbox_message(p_message_id bigint, p_dispatcher_id text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'control_plane', 'public', 'extensions', 'pg_temp'
AS $function$
DECLARE v_message outbox_messages%ROWTYPE; v_event domain_events%ROWTYPE;
  v_job runtime_jobs%ROWTYPE; v_job_type text;
BEGIN
  SELECT * INTO v_message FROM outbox_messages o WHERE o.id=p_message_id FOR UPDATE;
  IF NOT FOUND OR v_message.status<>'in_flight' OR v_message.leased_by<>p_dispatcher_id
     OR v_message.leased_until<=clock_timestamp() THEN
    RAISE EXCEPTION 'outbox message is not actively leased' USING ERRCODE='55000', DETAIL=jsonb_build_object('reason','outbox_message_not_leased')::text;
  END IF;
  SELECT * INTO v_event FROM domain_events e WHERE e.id=v_message.event_id;
  v_job_type:=CASE
    WHEN v_event.event_type='implementation.requested' THEN 'implementation_run'
    WHEN v_event.event_type IN ('implementation.completed','revision.completed') THEN 'resume_orchestrator'
    WHEN v_event.event_type='chat.user_message' AND EXISTS(
      SELECT 1 FROM tasks t
      JOIN project_agent_assignments pa ON pa.id=t.orchestrator_assignment_id
        AND pa.enabled AND pa.assignment_role='orchestrator'
      JOIN agents a ON a.id=pa.agent_id AND a.enabled
      JOIN runtime_profiles rp ON rp.id=pa.runtime_profile_id AND rp.enabled
      WHERE t.id=v_event.task_id AND rp.runtime_type='codex'
    ) THEN 'orchestrator_turn'
  END;
  IF v_job_type IS NOT NULL THEN
    INSERT INTO runtime_jobs(source_event_id,job_type,project_id,task_id,run_id,payload)
    VALUES(v_event.id,v_job_type,v_event.project_id,v_event.task_id,v_event.run_id,
      jsonb_build_object('event_id',v_event.id,'event_type',v_event.event_type,
        'correlation_id',v_event.correlation_id,'event_payload',v_event.payload))
    ON CONFLICT(source_event_id,job_type) DO UPDATE SET source_event_id=EXCLUDED.source_event_id
    RETURNING * INTO v_job;
  END IF;
  PERFORM acknowledge_outbox(p_message_id,p_dispatcher_id);
  RETURN jsonb_build_object('message_id',p_message_id,'event_id',v_event.id,
    'event_type',v_event.event_type,'job_id',v_job.id,'job_type',v_job.job_type,
    'routed',v_job_type IS NOT NULL);
END; $function$;

CREATE OR REPLACE FUNCTION claim_codex_chat_jobs(p_worker_id text, p_limit integer DEFAULT 1, p_lease interval DEFAULT '00:05:00'::interval)
 RETURNS SETOF control_plane.runtime_jobs
 LANGUAGE sql
 SET search_path TO 'control_plane', 'public', 'extensions', 'pg_temp'
AS $function$
  WITH candidates AS (
    SELECT j.id FROM runtime_jobs j
    WHERE j.job_type IN ('codex_chat_turn','resume_codex','orchestrator_turn','resume_orchestrator')
      AND j.available_at<=clock_timestamp()
      AND (j.status='pending' OR (j.status='in_flight' AND j.leased_until<=clock_timestamp()))
      AND NOT EXISTS (
        SELECT 1 FROM runtime_jobs earlier
        WHERE earlier.job_type IN ('codex_chat_turn','resume_codex','orchestrator_turn','resume_orchestrator')
          AND earlier.task_id=j.task_id AND earlier.id<j.id
          AND earlier.status IN ('pending','in_flight')
      )
      AND NOT workspace_has_foreign_writer(j.project_id, NULL)
      -- 0070: a run of this conversation is live, or an earlier message has not
      -- run yet. The job waits, in order, and becomes a run after it.
      AND ingress_blocker(j.id) IS NULL
    ORDER BY j.available_at,j.id FOR UPDATE SKIP LOCKED
    LIMIT GREATEST(p_limit,0)
  ), claimed AS (
    UPDATE runtime_jobs j
    SET status='in_flight',attempt_count=j.attempt_count+1,leased_by=p_worker_id,
        leased_until=clock_timestamp()+p_lease,last_error=NULL,
        activity_phase='starting_runtime',activity_detail='Preparing the Codex runtime',
        started_at=COALESCE(j.started_at,clock_timestamp()),heartbeat_at=clock_timestamp()
    FROM candidates c WHERE j.id=c.id RETURNING j.*
  ), reviewing AS (
    UPDATE tasks t SET status='reviewing',version=t.version+1,updated_at=clock_timestamp()
    FROM claimed j
    WHERE j.job_type IN ('resume_codex','resume_orchestrator') AND t.id=j.task_id AND t.status='awaiting_review'
    RETURNING t.id
  )
  SELECT j.* FROM claimed j LEFT JOIN reviewing r ON r.id=j.task_id;
$function$;

CREATE OR REPLACE FUNCTION codex_chat_job_context(p_job_id bigint, p_worker_id text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'control_plane', 'public', 'extensions', 'pg_temp'
AS $function$
DECLARE v_context jsonb; v_snapshot jsonb; v_snapshot_model text;
BEGIN
  SELECT get_task_runtime_snapshot(t.id) INTO v_snapshot
  FROM runtime_jobs j JOIN tasks t ON t.id=j.task_id
  WHERE j.id=p_job_id AND j.job_type IN ('codex_chat_turn','resume_codex','orchestrator_turn','resume_orchestrator');
  IF v_snapshot IS NULL OR v_snapshot->>'source'<>'catalog' THEN
    v_snapshot := '{}'::jsonb;
  END IF;
  v_snapshot_model := v_snapshot->'orchestrator'->>'model_id';

  SELECT jsonb_build_object(
    'job_id',j.id,'job_type',j.job_type,'source_event_id',j.source_event_id,
    'project_id',j.project_id,'task_id',j.task_id,'task_status',t.status,
    'task_version',t.version,'task_title',t.title,'task_objective',t.objective,
    'task_constraints',t.constraints,'task_acceptance_criteria',t.acceptance_criteria,
    'followup_of_task_id',t.followup_of_task_id,
    'content',CASE WHEN j.job_type IN ('codex_chat_turn','orchestrator_turn')
      THEN j.payload#>>'{event_payload,content}'
      ELSE concat(
        'A durable ',j.payload->>'event_type',' event is ready for review. ',
        'Inspect the implementation and the review evidence above. The workspace is not read-only, ',
        'and a change to it makes an approval of this evidence stale. ',
        'If changes are required, call platform.request_revision. ',
        'Otherwise summarize the review result for the operator.',E'\n',
        jsonb_pretty(j.payload->'event_payload')) END,
    'correlation_id',j.payload->>'correlation_id','workspace_path',p.workspace_path,
    'agent_id',a.id,'agent_name',a.name,'orchestrator_assignment_id',pa.id,
    'runtime_profile_id',COALESCE(v_snapshot->'orchestrator'->>'entry_id',rp.id::text),
    'runtime_type',COALESCE(v_snapshot->'orchestrator'->>'runtime_type',rp.runtime_type),
    'provider_type',COALESCE(v_snapshot->'orchestrator'->>'provider_id',rp.provider_type),
    'model',COALESCE(v_snapshot_model,rp.model),
    'snapshot_entry_id',v_snapshot->'orchestrator'->>'entry_id',
    'snapshot_verification_id',v_snapshot->'orchestrator'->>'verification_id',
    'reasoning_effort',v_snapshot->'orchestrator'->>'reasoning_effort',
    'service_tier',v_snapshot->'orchestrator'->>'service_tier',
    'native_session_id',s.native_session_id,
    'executor',COALESCE((
      SELECT jsonb_build_object(
        'assignment_id',epa.id,'agent_id',ea.id,'agent_name',ea.name,
        'runtime_profile_id',COALESCE(esnap.e->>'entry_id',erp.id::text),
        'runtime_type',COALESCE(esnap.e->>'runtime_type',erp.runtime_type),
        'provider_type',COALESCE(esnap.e->>'provider_id',erp.provider_type),
        'model',COALESCE(esnap.e->>'model_id',erp.model),
        'reasoning_effort',esnap.e->>'reasoning_effort','service_tier',esnap.e->>'service_tier',
        'priority',tea.priority)
      FROM task_executor_assignments tea
      JOIN project_agent_assignments epa ON epa.id=tea.project_agent_assignment_id
        AND epa.enabled AND epa.assignment_role='executor'
      JOIN agents ea ON ea.id=epa.agent_id AND ea.enabled
      JOIN runtime_profiles erp ON erp.id=epa.runtime_profile_id
        AND erp.enabled AND erp.runtime_type='opencode'
      LEFT JOIN LATERAL (
        SELECT e FROM jsonb_array_elements(v_snapshot->'executors') e
        LIMIT 1
      ) esnap ON true
      WHERE tea.task_id=t.id AND tea.enabled
      ORDER BY tea.priority,tea.created_at LIMIT 1
    ),'null'::jsonb)
  ) INTO v_context
  FROM runtime_jobs j
  JOIN projects p ON p.id=j.project_id
  JOIN tasks t ON t.id=j.task_id
  JOIN project_agent_assignments pa ON pa.id=t.orchestrator_assignment_id
    AND pa.enabled AND pa.assignment_role='orchestrator'
  JOIN agents a ON a.id=pa.agent_id AND a.enabled
  JOIN runtime_profiles rp ON rp.id=pa.runtime_profile_id
    AND rp.enabled AND rp.runtime_type='codex'
  -- 0063: the conversation's chat session for this agent, in this runtime's
  -- namespace. A model change inside the runtime resumes the same native session.
  LEFT JOIN agent_sessions s ON s.conversation_id=t.conversation_id AND s.role='chat'
    AND s.agent_id=a.id AND s.session_namespace=rp.runtime_type AND s.active
  WHERE j.id=p_job_id AND j.job_type IN ('codex_chat_turn','resume_codex','orchestrator_turn','resume_orchestrator')
    AND j.status='in_flight' AND j.leased_by=p_worker_id
    AND j.leased_until>clock_timestamp();
  IF v_context IS NULL THEN
    PERFORM refuse('orchestration_job_not_leased',
      format('Codex orchestration job %s is not actively leased by worker %s',p_job_id,p_worker_id));
  END IF;
  RETURN v_context;
END; $function$;

CREATE OR REPLACE FUNCTION bind_codex_chat_session(p_job_id bigint, p_worker_id text, p_native_session_id text)
 RETURNS uuid
 LANGUAGE plpgsql
 SET search_path TO 'control_plane', 'public', 'extensions', 'pg_temp'
AS $function$
DECLARE v_job runtime_jobs%ROWTYPE; v_task tasks%ROWTYPE;
  v_assignment project_agent_assignments%ROWTYPE; v_session agent_sessions%ROWTYPE; v_purpose text;
  v_conversation uuid;
BEGIN
  IF p_native_session_id IS NULL OR length(p_native_session_id)=0 THEN
    RAISE EXCEPTION 'native Codex session id is required' USING ERRCODE='22023', DETAIL=jsonb_build_object('reason','native_session_id_missing')::text;
  END IF;
  SELECT * INTO v_job FROM runtime_jobs j WHERE j.id=p_job_id FOR UPDATE;
  IF NOT FOUND OR v_job.job_type NOT IN ('codex_chat_turn','resume_codex','orchestrator_turn','resume_orchestrator')
     OR v_job.status<>'in_flight' OR v_job.leased_by<>p_worker_id
     OR v_job.leased_until<=clock_timestamp() THEN
    RAISE EXCEPTION 'Codex orchestration job is not actively leased' USING ERRCODE='55000', DETAIL=jsonb_build_object('reason','orchestration_job_not_leased')::text;
  END IF;
  SELECT * INTO v_task FROM tasks t WHERE t.id=v_job.task_id;
  SELECT * INTO v_assignment FROM project_agent_assignments pa
  WHERE pa.id=v_task.orchestrator_assignment_id AND pa.enabled
    AND pa.assignment_role='orchestrator';
  IF NOT FOUND OR NOT EXISTS(
    SELECT 1 FROM agents a JOIN runtime_profiles rp ON rp.id=v_assignment.runtime_profile_id
    WHERE a.id=v_assignment.agent_id AND a.enabled AND rp.enabled AND rp.runtime_type='codex'
  ) THEN RAISE EXCEPTION 'task orchestrator is not an enabled Codex runtime' USING ERRCODE='55000', DETAIL=jsonb_build_object('reason','orchestrator_unavailable')::text; END IF;
  -- 0063: the session belongs to the conversation (ADR-0014). A follow-up task
  -- finds the same row by these columns, so there is nothing to copy. purpose
  -- is description only.
  v_conversation:=v_task.conversation_id;
  v_purpose:='conversation_chat:' || v_conversation::text;
  -- A session in another runtime's namespace cannot be resumed by this one; it
  -- is closed rather than overwritten, and stays in the history.
  UPDATE agent_sessions SET active=false,status='closed',updated_at=clock_timestamp(),version=version+1,
    metadata=metadata||jsonb_build_object('closed_reason','runtime_changed')
  WHERE conversation_id=v_conversation AND role='chat' AND agent_id=v_assignment.agent_id AND active
    AND session_namespace<>(SELECT rp.runtime_type FROM runtime_profiles rp WHERE rp.id=v_assignment.runtime_profile_id);
  INSERT INTO agent_sessions(project_id,agent_id,runtime_profile_id,native_session_id,purpose,
    status,active,last_resumed_at,metadata,conversation_id,role)
  VALUES(v_job.project_id,v_assignment.agent_id,v_assignment.runtime_profile_id,
    p_native_session_id,v_purpose,'active',true,clock_timestamp(),
    jsonb_build_object('task_id',v_job.task_id,'orchestrator_assignment_id',v_assignment.id),
    v_conversation,'chat')
  ON CONFLICT(conversation_id,role,agent_id) WHERE active AND conversation_id IS NOT NULL DO UPDATE
  SET native_session_id=CASE WHEN agent_sessions.native_session_id IS NULL
        THEN EXCLUDED.native_session_id ELSE agent_sessions.native_session_id END,
      runtime_profile_id=EXCLUDED.runtime_profile_id,status='active',
      last_resumed_at=clock_timestamp(),updated_at=clock_timestamp(),
      version=agent_sessions.version+1
  RETURNING * INTO v_session;
  IF v_session.native_session_id<>p_native_session_id
     OR v_session.runtime_profile_id<>v_assignment.runtime_profile_id THEN
    RAISE EXCEPTION 'orchestrator session continuity validation failed' USING ERRCODE='55000', DETAIL=jsonb_build_object('reason','session_continuity_mismatch')::text;
  END IF;
  RETURN v_session.id;
END; $function$;

CREATE OR REPLACE FUNCTION complete_codex_chat_job(p_job_id bigint, p_worker_id text, p_native_session_id text, p_turn_id text, p_content text)
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
    RAISE EXCEPTION 'Codex orchestration job is not actively leased' USING ERRCODE='55000', DETAIL=jsonb_build_object('reason','orchestration_job_not_leased')::text;
  END IF;
  v_session_id:=bind_codex_chat_session(p_job_id,p_worker_id,p_native_session_id);
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

CREATE OR REPLACE FUNCTION defer_runtime_job(p_job_id bigint, p_worker_id text, p_reason text, p_delay interval DEFAULT '00:00:30'::interval)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'control_plane', 'public', 'extensions', 'pg_temp'
AS $function$
DECLARE v_job runtime_jobs%ROWTYPE;
BEGIN
  IF p_reason IS NULL OR p_reason NOT IN ('grant_writer_active','runtime_paused') THEN
    RAISE EXCEPTION 'a job may be deferred only for a reason that clears on its own'
      USING ERRCODE='22023', DETAIL='defer_reason_not_transient';
  END IF;
  IF p_delay IS NULL OR p_delay < interval '1 second' OR p_delay > interval '10 minutes' THEN
    RAISE EXCEPTION 'defer delay must be between one second and ten minutes' USING ERRCODE='22023', DETAIL=jsonb_build_object('reason','defer_delay_invalid')::text;
  END IF;

  SELECT * INTO v_job FROM runtime_jobs WHERE id=p_job_id FOR UPDATE;
  IF NOT FOUND OR v_job.status<>'in_flight' OR v_job.leased_by IS DISTINCT FROM p_worker_id
     OR v_job.leased_until<=clock_timestamp() THEN
    RAISE EXCEPTION 'the job is not actively leased by this worker' USING ERRCODE='55000',
      DETAIL='defer_job_not_leased';
  END IF;
  IF v_job.job_type NOT IN ('codex_chat_turn','resume_codex','orchestrator_turn','resume_orchestrator') THEN
    RAISE EXCEPTION 'only an orchestrator job can be deferred' USING ERRCODE='55000',
      DETAIL='defer_job_type';
  END IF;

  UPDATE runtime_jobs SET
    status='pending', leased_by=NULL, leased_until=NULL,
    available_at=clock_timestamp()+p_delay,
    attempt_count=GREATEST(attempt_count-1,0),
    last_error=left('deferred: '||p_reason,4000),
    -- As a freshly queued job: the next claim writes its own phase and detail.
    activity_phase='queued', activity_detail='Waiting for an available runtime worker'
  WHERE id=p_job_id RETURNING * INTO v_job;

  RETURN jsonb_build_object('job_id',v_job.id,'status','deferred','reason',p_reason,
    'available_at',v_job.available_at,'attempt_count',v_job.attempt_count);
END $function$;

CREATE OR REPLACE FUNCTION invoke_codex_delegate_task(p_job_id bigint, p_worker_id text, p_call_id text, p_objective text, p_instructions jsonb, p_relevant_paths jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'control_plane', 'public', 'extensions', 'pg_temp'
AS $function$
DECLARE v_job runtime_jobs%ROWTYPE; v_task tasks%ROWTYPE;
  v_orchestrator project_agent_assignments%ROWTYPE;
  v_executor project_agent_assignments%ROWTYPE; v_project projects%ROWTYPE;
  v_existing commands%ROWTYPE; v_ready_event domain_events%ROWTYPE;
  v_key text; v_result jsonb;
BEGIN
  IF p_call_id IS NULL OR length(trim(p_call_id))<4 OR length(trim(p_objective))<4
     OR jsonb_typeof(p_instructions)<>'array' OR jsonb_typeof(p_relevant_paths)<>'array' THEN
    RAISE EXCEPTION 'invalid delegate_task arguments' USING ERRCODE='22023', DETAIL=jsonb_build_object('reason','delegation_arguments_invalid')::text;
  END IF;
  SELECT * INTO v_job FROM runtime_jobs j WHERE j.id=p_job_id FOR UPDATE;
  IF NOT FOUND OR v_job.job_type NOT IN ('codex_chat_turn','orchestrator_turn') OR v_job.status<>'in_flight'
     OR v_job.leased_by<>p_worker_id OR v_job.leased_until<=clock_timestamp() THEN
    RAISE EXCEPTION 'delegate_task is not bound to an active Codex chat turn' USING ERRCODE='55000', DETAIL=jsonb_build_object('reason','orchestration_job_not_leased')::text;
  END IF;
  v_key:='codex-tool:' || p_job_id || ':' || p_call_id;
  SELECT * INTO v_existing FROM commands c
    WHERE c.project_id=v_job.project_id AND c.idempotency_key=v_key;
  IF FOUND AND v_existing.status='completed' THEN RETURN v_existing.result; END IF;

  SELECT * INTO v_task FROM tasks t
    WHERE t.id=v_job.task_id AND t.project_id=v_job.project_id FOR UPDATE;
  IF NOT FOUND OR v_task.status NOT IN ('planning','ready') THEN
    RAISE EXCEPTION 'task is not available for initial delegation' USING ERRCODE='55000', DETAIL=jsonb_build_object('reason','task_not_delegable')::text;
  END IF;
  SELECT * INTO v_orchestrator FROM project_agent_assignments pa
    WHERE pa.id=v_task.orchestrator_assignment_id AND pa.enabled
      AND pa.assignment_role='orchestrator';
  SELECT pa.* INTO v_executor
  FROM task_executor_assignments tea
  JOIN project_agent_assignments pa ON pa.id=tea.project_agent_assignment_id
  JOIN agents a ON a.id=pa.agent_id AND a.enabled AND a.role='implementer'
  JOIN runtime_profiles rp ON rp.id=pa.runtime_profile_id
    AND rp.enabled AND rp.runtime_type='opencode'
  WHERE tea.task_id=v_task.id AND tea.enabled AND pa.enabled
    AND pa.project_id=v_task.project_id AND pa.assignment_role='executor'
  ORDER BY tea.priority,tea.created_at LIMIT 1;
  IF v_orchestrator.id IS NULL OR v_executor.id IS NULL THEN
    RAISE EXCEPTION 'task orchestration assignments are unavailable' USING ERRCODE='55000', DETAIL=jsonb_build_object('reason','orchestrator_unavailable')::text;
  END IF;

  IF v_task.status='planning' THEN
    UPDATE tasks SET status='ready',version=version+1,updated_at=clock_timestamp()
      WHERE id=v_task.id RETURNING * INTO v_task;
    v_ready_event:=append_event(
      'task.ready',v_task.project_id,v_task.id,NULL,'agent',v_orchestrator.agent_id::text,
      NULL,COALESCE(v_job.payload->>'correlation_id',v_task.id::text),
      'task-ready:' || v_key,'task',v_task.id,v_task.version,
      jsonb_build_object('source_job_id',v_job.id,'executor_assignment_id',v_executor.id)
    );
  END IF;

  SELECT * INTO v_project FROM projects p WHERE p.id=v_task.project_id;
  v_result:=request_implementation(
    v_task.project_id,v_task.id,v_orchestrator.agent_id,v_executor.agent_id,1,
    p_objective,p_instructions,v_task.constraints,v_task.acceptance_criteria,
    p_relevant_paths,v_project.workspace_path,v_key,v_task.version,
    COALESCE(v_job.payload->>'correlation_id',v_task.id::text)
  );
  UPDATE handoffs SET executor_assignment_id=v_executor.id
    WHERE id=(v_result->>'handoff_id')::uuid AND executor_assignment_id IS NULL;
  RETURN v_result;
END; $function$;

CREATE OR REPLACE FUNCTION invoke_codex_request_revision(p_job_id bigint, p_worker_id text, p_call_id text, p_changes_required jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'control_plane', 'public', 'extensions', 'pg_temp'
AS $function$
DECLARE v_job runtime_jobs%ROWTYPE; v_task tasks%ROWTYPE;
  v_orchestrator project_agent_assignments%ROWTYPE; v_handoff handoffs%ROWTYPE;
  v_existing commands%ROWTYPE; v_key text; v_result jsonb;
  v_delivery review_evidence_deliveries%ROWTYPE; v_current uuid; v_version bigint;
BEGIN
  IF p_call_id IS NULL OR length(trim(p_call_id))<4 OR p_changes_required IS NULL
     OR jsonb_typeof(p_changes_required)<>'array' OR jsonb_array_length(p_changes_required)=0 THEN
    PERFORM refuse('revision_arguments_invalid','invalid request_revision arguments','22023');
  END IF;
  SELECT * INTO v_job FROM runtime_jobs j WHERE j.id=p_job_id FOR UPDATE;
  IF NOT FOUND OR v_job.job_type NOT IN ('resume_codex','resume_orchestrator') THEN
    PERFORM refuse('job_type_mismatch','request_revision is not bound to an active Codex review turn');
  END IF;
  IF v_job.status<>'in_flight' THEN
    PERFORM refuse('job_not_in_flight','request_revision is not bound to an active Codex review turn');
  END IF;
  IF v_job.leased_by IS DISTINCT FROM p_worker_id THEN
    PERFORM refuse('job_lease_held_by_another','request_revision is not bound to an active Codex review turn');
  END IF;
  IF v_job.leased_until<=clock_timestamp() THEN
    PERFORM refuse('job_lease_expired','request_revision is not bound to an active Codex review turn');
  END IF;
  v_key:='codex-tool:' || p_job_id || ':' || p_call_id;
  SELECT * INTO v_existing FROM commands c
    WHERE c.project_id=v_job.project_id AND c.idempotency_key=v_key;
  IF FOUND AND v_existing.status='completed' THEN RETURN v_existing.result; END IF;
  SELECT * INTO v_task FROM tasks t WHERE t.id=v_job.task_id AND t.project_id=v_job.project_id FOR UPDATE;
  SELECT * INTO v_orchestrator FROM project_agent_assignments pa
    WHERE pa.id=v_task.orchestrator_assignment_id AND pa.enabled
      AND pa.assignment_role='orchestrator';
  SELECT * INTO v_handoff FROM handoffs h WHERE h.task_id=v_task.id
    ORDER BY h.revision_number DESC LIMIT 1;
  IF v_orchestrator.id IS NULL OR v_handoff.id IS NULL OR v_handoff.executor_assignment_id IS NULL
     OR NOT EXISTS(
       SELECT 1 FROM task_executor_assignments tea
       JOIN project_agent_assignments pa ON pa.id=tea.project_agent_assignment_id
       JOIN runtime_profiles rp ON rp.id=pa.runtime_profile_id
       WHERE tea.task_id=v_task.id AND tea.project_agent_assignment_id=v_handoff.executor_assignment_id
         AND tea.enabled AND pa.enabled AND pa.assignment_role='executor'
         AND rp.enabled AND rp.runtime_type='opencode'
     ) THEN
    PERFORM refuse('review_context_unavailable','review context is unavailable');
  END IF;
  SELECT * INTO v_delivery FROM review_evidence_deliveries d WHERE d.turn_run_id=v_job.run_id;
  IF FOUND THEN
    SELECT e.id INTO v_current FROM current_review_evidence(v_task.id) e;
    IF v_current IS DISTINCT FROM v_delivery.evidence_id THEN
      PERFORM refuse('review_evidence_stale',
        format('this turn reviewed evidence %s, which is no longer the task''s current evidence', v_delivery.evidence_digest));
    END IF;
  END IF;
  v_version:=v_task.version;
  v_result:=request_revision(
    v_task.project_id,v_task.id,v_orchestrator.agent_id,p_changes_required,
    v_handoff.acceptance_criteria,v_key,
    v_task.version,COALESCE(v_job.payload->>'correlation_id',v_task.id::text)
  );
  UPDATE handoffs SET executor_assignment_id=v_handoff.executor_assignment_id
    WHERE id=(v_result#>>'{delegation,handoff_id}')::uuid AND executor_assignment_id IS NULL;
  IF v_delivery.turn_run_id IS NOT NULL THEN
    INSERT INTO review_verdicts(project_id, task_id, evidence_id, evidence_digest, verdict, actor_type, actor_id,
      turn_run_id, command_id, task_version)
    VALUES (v_task.project_id, v_task.id, v_delivery.evidence_id, v_delivery.evidence_digest, 'changes_requested',
      'agent', v_orchestrator.agent_id::text, v_job.run_id, (v_result->>'command_id')::uuid, v_version);
    v_result:=v_result || jsonb_build_object('evidence_digest', v_delivery.evidence_digest);
  END IF;
  RETURN v_result;
END; $function$;

CREATE OR REPLACE FUNCTION deliver_review_evidence(p_job_id bigint, p_worker_id text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'control_plane', 'public', 'extensions', 'pg_temp'
AS $function$
DECLARE v_job runtime_jobs%ROWTYPE; v_run uuid; v_evidence review_evidence%ROWTYPE;
BEGIN
  SELECT * INTO v_job FROM runtime_jobs j WHERE j.id=p_job_id FOR UPDATE;
  IF NOT FOUND THEN
    PERFORM refuse('job_not_found', format('no runtime job %s', p_job_id));
  END IF;
  IF v_job.job_type NOT IN ('resume_codex','resume_orchestrator') THEN
    PERFORM refuse('job_type_mismatch', format('job %s is %s, not a review turn', p_job_id, v_job.job_type));
  END IF;
  IF v_job.status<>'in_flight' THEN
    PERFORM refuse('job_not_in_flight', format('job %s is %s', p_job_id, v_job.status));
  END IF;
  IF v_job.leased_by IS DISTINCT FROM p_worker_id THEN
    PERFORM refuse('job_lease_held_by_another', format('job %s is leased by another worker', p_job_id));
  END IF;
  IF v_job.leased_until<=clock_timestamp() THEN
    PERFORM refuse('job_lease_expired', format('the lease of job %s expired', p_job_id));
  END IF;
  -- The implementation this turn reviews is the source event's run; the job's
  -- own run is the turn (0059).
  SELECT e.run_id INTO v_run FROM domain_events e WHERE e.id=v_job.source_event_id;
  SELECT * INTO v_evidence FROM review_evidence e WHERE e.run_id=v_run;
  IF NOT FOUND THEN RETURN NULL; END IF;
  INSERT INTO review_evidence_deliveries(turn_run_id, job_id, evidence_id, evidence_digest)
  VALUES (v_job.run_id, v_job.id, v_evidence.id, v_evidence.evidence_digest)
  ON CONFLICT (turn_run_id) DO NOTHING;
  RETURN to_jsonb(v_evidence) - 'executor_reported_checks' - 'platform_verified_checks'
    || jsonb_build_object(
      'evidence_id', v_evidence.id,
      'executor_reported_checks', v_evidence.executor_reported_checks,
      'platform_verified_checks', v_evidence.platform_verified_checks);
END $function$;

CREATE OR REPLACE FUNCTION record_orchestrator_turn_run()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'control_plane', 'public', 'extensions', 'pg_temp'
AS $function$
DECLARE
  v_agent uuid;
  v_run uuid;
BEGIN
  -- An attempt begins: the job enters in_flight with a higher attempt count.
  -- That is a claim, of a pending job or of one whose lease ran out.
  IF NEW.status='in_flight' AND NEW.attempt_count>OLD.attempt_count THEN
    IF OLD.run_id IS NOT NULL THEN
      -- The attempt this one replaces. Failed, never lost — see the header.
      UPDATE task_runs SET status='failed',failure_code='turn_lease_expired',
        finished_at=clock_timestamp(),updated_at=clock_timestamp(),version=version+1
      -- `NOT write_capable`: a review job is routed pointing at the implementation
      -- it reviews, and that run is not an earlier attempt of this turn.
      WHERE id=OLD.run_id AND NOT write_capable
        AND status IN ('queued','starting','running','waiting_for_input','blocked');
    END IF;

    v_agent:=orchestrator_turn_agent(NEW.task_id);
    IF v_agent IS NULL THEN
      -- Refused rather than claimed without a run: the invariant this migration
      -- introduces is that no orchestrator attempt exists without one.
      RAISE EXCEPTION 'task % has no orchestrator agent to own the turn of job %',NEW.task_id,NEW.id
        USING ERRCODE='55000', DETAIL=jsonb_build_object('reason','orchestrator_unavailable')::text;
    END IF;

    INSERT INTO task_runs(task_id,session_id,agent_id,phase,status,write_capable,started_at)
    VALUES(NEW.task_id,orchestrator_turn_session(NEW.project_id,NEW.task_id,v_agent),v_agent,
      CASE WHEN NEW.job_type IN ('resume_codex','resume_orchestrator') THEN 'review_turn' ELSE 'orchestrator_turn' END,
      'running',false,clock_timestamp())
    RETURNING id INTO v_run;
    NEW.run_id:=v_run;
    RETURN NEW;
  END IF;

  -- An attempt ends. Only a run that is still active is closed: an interrupt
  -- has already said `interrupted`, and that is the truer answer.
  --
  -- 0061: an attempt handed back by defer_runtime_job gives its attempt back,
  -- and that is how it is told apart. It never ran against the workspace — a
  -- writer was there first — so it is `cancelled` with `turn_deferred`, not a
  -- failure that would count against anything.
  IF OLD.status='in_flight' AND NEW.status<>'in_flight' AND NEW.run_id IS NOT NULL THEN
    UPDATE task_runs r SET
      status=CASE
        WHEN NEW.status='completed' THEN 'completed'
        WHEN NEW.status='pending' AND NEW.attempt_count<OLD.attempt_count THEN 'cancelled'
        ELSE 'failed' END,
      failure_code=CASE
        WHEN NEW.status='completed' THEN NULL
        WHEN NEW.status='pending' AND NEW.attempt_count<OLD.attempt_count THEN 'turn_deferred'
        WHEN NEW.status='dead_letter' THEN 'turn_dead_lettered'
        ELSE 'turn_retried' END,
      -- The session is bound when the turn completes (complete_codex_chat_job
      -- binds it before acknowledging), so a first turn learns it here.
      session_id=COALESCE(r.session_id,orchestrator_turn_session(NEW.project_id,NEW.task_id,r.agent_id)),
      finished_at=clock_timestamp(),updated_at=clock_timestamp(),version=r.version+1
    WHERE r.id=NEW.run_id AND NOT r.write_capable
      AND r.status IN ('queued','starting','running','waiting_for_input','blocked');
  END IF;
  RETURN NEW;
END $function$;

CREATE OR REPLACE FUNCTION backfill_orchestrator_turn_runs()
 RETURNS integer
 LANGUAGE plpgsql
 SET search_path TO 'control_plane', 'public', 'extensions', 'pg_temp'
AS $function$
DECLARE
  v_job runtime_jobs%ROWTYPE;
  v_agent uuid;
  v_run uuid;
  v_status text;
  v_count integer:=0;
  v_orphans text;
BEGIN
  -- Checked before anything is written, so a host that cannot be backfilled is
  -- refused with the rows named, not half-migrated. The repair for a listed job
  -- is to give its task an orchestrator assignment (or an active agent) and run
  -- the update again; nothing here guesses an owner.
  SELECT string_agg(j.id::text,', ' ORDER BY j.id) INTO v_orphans
  FROM runtime_jobs j
  WHERE j.job_type IN ('codex_chat_turn','resume_codex','orchestrator_turn','resume_orchestrator') AND j.attempt_count>0
    AND NOT EXISTS(SELECT 1 FROM task_runs r WHERE r.id=j.run_id AND NOT r.write_capable)
    AND orchestrator_turn_agent(j.task_id) IS NULL;
  IF v_orphans IS NOT NULL THEN
    RAISE EXCEPTION 'orchestrator jobs without an agent to own their turn: %',v_orphans
      USING ERRCODE='55000',
      DETAIL='backfill_orchestrator_turn_runs: each task needs an orchestrator assignment or an active agent';
  END IF;

  FOR v_job IN
    -- No turn run of its own: either no run at all, or — for a review job — the
    -- implementation run it was routed with.
    SELECT * FROM runtime_jobs j
    WHERE j.job_type IN ('codex_chat_turn','resume_codex','orchestrator_turn','resume_orchestrator') AND j.attempt_count>0
      AND NOT EXISTS(SELECT 1 FROM task_runs r WHERE r.id=j.run_id AND NOT r.write_capable)
    ORDER BY j.id FOR UPDATE
  LOOP
    v_agent:=orchestrator_turn_agent(v_job.task_id);
    v_status:=CASE
      WHEN v_job.status='completed' THEN 'completed'
      WHEN v_job.status='in_flight' AND v_job.leased_until>clock_timestamp() THEN 'running'
      ELSE 'failed' END;
    INSERT INTO task_runs(task_id,session_id,agent_id,phase,status,write_capable,
      started_at,finished_at,failure_code,created_at,updated_at)
    VALUES(v_job.task_id,orchestrator_turn_session(v_job.project_id,v_job.task_id,v_agent),v_agent,
      CASE WHEN v_job.job_type IN ('resume_codex','resume_orchestrator') THEN 'review_turn' ELSE 'orchestrator_turn' END,
      v_status,false,
      COALESCE(v_job.started_at,v_job.created_at),
      CASE WHEN v_status='running' THEN NULL
        ELSE COALESCE(v_job.completed_at,v_job.heartbeat_at,v_job.started_at,v_job.created_at) END,
      CASE WHEN v_status='failed' THEN 'backfilled_'||v_job.status END,
      -- Ordered by when the turn happened, not by when this migration ran:
      -- readers pick "the latest run" by created_at.
      COALESCE(v_job.started_at,v_job.created_at),
      clock_timestamp())
    RETURNING id INTO v_run;
    -- run_id alone: the trigger watches status and attempt_count, so the
    -- backfill does not open a second turn for the job it is recording.
    UPDATE runtime_jobs SET run_id=v_run WHERE id=v_job.id;
    v_count:=v_count+1;
  END LOOP;
  RETURN v_count;
END $function$;

CREATE OR REPLACE FUNCTION claim_executor_jobs(p_worker_id text, p_limit integer DEFAULT 1, p_lease interval DEFAULT '00:05:00'::interval)
 RETURNS SETOF control_plane.runtime_jobs
 LANGUAGE sql
 SET search_path TO 'control_plane', 'public', 'extensions', 'pg_temp'
AS $function$
  WITH candidates AS (
    SELECT j.id FROM runtime_jobs j
    WHERE j.job_type IN ('start_implementation','implementation_run') AND j.available_at<=clock_timestamp()
      AND (j.status='pending' OR (j.status='in_flight' AND j.leased_until<=clock_timestamp()))
      AND ingress_blocker(j.id) IS NULL
    ORDER BY j.available_at,j.id FOR UPDATE SKIP LOCKED LIMIT GREATEST(p_limit,0)
  )
  UPDATE runtime_jobs j
  SET status='in_flight',attempt_count=j.attempt_count+1,leased_by=p_worker_id,
      leased_until=clock_timestamp()+p_lease,last_error=NULL,
      activity_phase='starting_runtime',activity_detail='Preparing the selected executor runtime',
      started_at=COALESCE(j.started_at,clock_timestamp()),heartbeat_at=clock_timestamp()
  FROM candidates c WHERE j.id=c.id RETURNING j.*;
$function$;

CREATE OR REPLACE FUNCTION executor_job_context(p_job_id bigint, p_worker_id text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'control_plane', 'public', 'extensions', 'pg_temp'
AS $function$
DECLARE
  v_context jsonb; v_session agent_sessions%ROWTYPE; v_snapshot jsonb;
  v_task_snapshot jsonb; v_snapshot_model text; v_snapshot_runtime text;
BEGIN
  SELECT get_task_runtime_snapshot(t.id) INTO v_task_snapshot
  FROM runtime_jobs j JOIN tasks t ON t.id=j.task_id
  WHERE j.id=p_job_id AND j.job_type IN ('start_implementation','implementation_run');
  IF v_task_snapshot->>'source'='catalog' THEN
    -- Bind the snapshot executor to the exact project agent assignment that
    -- owns this job's handoff. A catalog snapshot carries assignment_ids
    -- provenance; if no entry matches the handoff assignment the snapshot is
    -- inconsistent and the launch must fail closed rather than silently use
    -- another executor's model. The generic first-executor fallback applies
    -- only to fully legacy snapshots (no assignment_ids at all).
    SELECT e INTO v_snapshot
    FROM runtime_jobs j
    JOIN domain_events ev ON ev.id=j.source_event_id AND ev.event_type='implementation.requested'
    JOIN handoffs h ON h.id=(ev.payload->>'handoff_id')::uuid
    CROSS JOIN LATERAL (
      SELECT e FROM jsonb_array_elements(v_task_snapshot->'executors') e
      WHERE e->>'model_id' IS NOT NULL
        AND e->'assignment_ids' @> to_jsonb(h.executor_assignment_id::text)
      LIMIT 1
    ) t1(e)
    WHERE j.id=p_job_id AND j.job_type IN ('start_implementation','implementation_run');
    IF v_snapshot IS NULL THEN
      IF NOT EXISTS (
        SELECT 1 FROM jsonb_array_elements(v_task_snapshot->'executors') e
        WHERE e->>'model_id' IS NOT NULL AND jsonb_typeof(e->'assignment_ids')='array'
          AND jsonb_array_length(e->'assignment_ids')>0
      ) THEN
        -- Fully legacy provenance-free snapshot: first entry fallback.
        SELECT e INTO v_snapshot
        FROM jsonb_array_elements(v_task_snapshot->'executors') e
        WHERE e->>'model_id' IS NOT NULL
        ORDER BY e->>'model_id' LIMIT 1;
      ELSE
        RAISE EXCEPTION 'task runtime snapshot does not match the executor assignment' USING ERRCODE='55000', DETAIL=jsonb_build_object('reason','runtime_selection_mismatch')::text;
      END IF;
    END IF;
  ELSE
    v_snapshot := '{}'::jsonb;
  END IF;
  v_snapshot_model := v_snapshot->>'model_id';
  v_snapshot_runtime := v_snapshot->>'runtime_type';

  SELECT s.* INTO v_session
  FROM runtime_jobs j
  JOIN domain_events e ON e.id=j.source_event_id AND e.event_type='implementation.requested'
  JOIN handoffs h ON h.id=(e.payload->>'handoff_id')::uuid
  JOIN project_agent_assignments pa ON pa.id=h.executor_assignment_id
    AND pa.project_id=j.project_id AND pa.agent_id=h.to_agent_id
    AND pa.assignment_role='executor' AND pa.enabled
  JOIN task_executor_assignments tea ON tea.task_id=j.task_id
    AND tea.project_agent_assignment_id=pa.id AND tea.enabled
  JOIN runtime_profiles rp ON rp.id=pa.runtime_profile_id AND rp.enabled AND rp.runtime_type='opencode'
  JOIN tasks session_task ON session_task.id=j.task_id
  -- 0063: the conversation's executor session for this agent (ADR-0014).
  LEFT JOIN agent_sessions s ON s.conversation_id=session_task.conversation_id AND s.role='executor'
    AND s.agent_id=pa.agent_id AND s.session_namespace=rp.runtime_type AND s.active
  WHERE j.id=p_job_id AND j.job_type IN ('start_implementation','implementation_run') AND j.status='in_flight'
    AND j.leased_by=p_worker_id AND j.leased_until>clock_timestamp();

  IF v_session.id IS NULL THEN
    -- A session in another runtime's namespace is closed, not taken over: the
    -- upsert below would otherwise move it into this namespace with its foreign
    -- native id still on it.
    UPDATE agent_sessions s SET active=false,status='closed',updated_at=clock_timestamp(),version=s.version+1,
      metadata=s.metadata||jsonb_build_object('closed_reason','runtime_changed')
    FROM runtime_jobs j
    JOIN tasks session_task ON session_task.id=j.task_id
    JOIN domain_events e ON e.id=j.source_event_id AND e.event_type='implementation.requested'
    JOIN handoffs h ON h.id=(e.payload->>'handoff_id')::uuid
    WHERE j.id=p_job_id AND j.job_type IN ('start_implementation','implementation_run') AND j.status='in_flight'
      AND j.leased_by=p_worker_id AND j.leased_until>clock_timestamp()
      AND s.conversation_id=session_task.conversation_id AND s.role='executor'
      AND s.agent_id=h.to_agent_id AND s.active AND s.session_namespace<>'opencode';
    INSERT INTO agent_sessions(project_id,agent_id,runtime_profile_id,purpose,status,active,metadata,
      conversation_id,role)
    SELECT j.project_id,pa.agent_id,pa.runtime_profile_id,'conversation_executor:' || session_task.conversation_id::text,
      'active',true,jsonb_build_object('task_id',j.task_id,'executor_assignment_id',pa.id),
      session_task.conversation_id,'executor'
    FROM runtime_jobs j
    JOIN tasks session_task ON session_task.id=j.task_id
    JOIN domain_events e ON e.id=j.source_event_id AND e.event_type='implementation.requested'
    JOIN handoffs h ON h.id=(e.payload->>'handoff_id')::uuid
    JOIN project_agent_assignments pa ON pa.id=h.executor_assignment_id
      AND pa.project_id=j.project_id AND pa.agent_id=h.to_agent_id
      AND pa.assignment_role='executor' AND pa.enabled
    JOIN task_executor_assignments tea ON tea.task_id=j.task_id
      AND tea.project_agent_assignment_id=pa.id AND tea.enabled
    JOIN runtime_profiles rp ON rp.id=pa.runtime_profile_id AND rp.enabled AND rp.runtime_type='opencode'
    WHERE j.id=p_job_id AND j.job_type IN ('start_implementation','implementation_run') AND j.status='in_flight'
      AND j.leased_by=p_worker_id AND j.leased_until>clock_timestamp()
    ON CONFLICT(conversation_id,role,agent_id) WHERE active AND conversation_id IS NOT NULL DO UPDATE
      SET runtime_profile_id=EXCLUDED.runtime_profile_id,updated_at=clock_timestamp(),
          version=agent_sessions.version+1
    RETURNING * INTO v_session;
  END IF;

  SELECT jsonb_build_object(
    'job_id',j.id,'project_id',j.project_id,'task_id',j.task_id,
    'source_event_id',j.source_event_id,'correlation_id',j.payload->>'correlation_id',
    'workspace_path',p.workspace_path,'handoff_id',h.id,'revision_number',h.revision_number,
    'objective',h.objective,'instructions',h.instructions,'constraints',h.constraints,
    'acceptance_criteria',h.acceptance_criteria,'relevant_paths',h.relevant_paths,
    'agent_id',a.id,'agent_name',a.name,'runtime_profile_id',rp.id,
    'runtime_type',COALESCE(v_snapshot_runtime,rp.runtime_type),
    'provider_type',COALESCE(v_snapshot->>'provider_id',rp.provider_type),
    'model',COALESCE(v_snapshot_model,rp.model),
    'snapshot_entry_id',v_snapshot->>'entry_id',
    'snapshot_verification_id',v_snapshot->>'verification_id',
    'reasoning_effort',v_snapshot->>'reasoning_effort',
    'service_tier',v_snapshot->>'service_tier',
    'session_id',v_session.id,'native_session_id',v_session.native_session_id
  ) INTO v_context
  FROM runtime_jobs j
  JOIN projects p ON p.id=j.project_id
  JOIN domain_events e ON e.id=j.source_event_id AND e.event_type='implementation.requested'
  JOIN handoffs h ON h.id=(e.payload->>'handoff_id')::uuid
  JOIN project_agent_assignments pa ON pa.id=h.executor_assignment_id
    AND pa.project_id=j.project_id AND pa.agent_id=h.to_agent_id
    AND pa.assignment_role='executor' AND pa.enabled
  JOIN task_executor_assignments tea ON tea.task_id=j.task_id
    AND tea.project_agent_assignment_id=pa.id AND tea.enabled
  JOIN agents a ON a.id=pa.agent_id AND a.enabled
  JOIN runtime_profiles rp ON rp.id=pa.runtime_profile_id AND rp.enabled AND rp.runtime_type='opencode'
  WHERE j.id=p_job_id AND j.job_type IN ('start_implementation','implementation_run') AND j.status='in_flight'
    AND j.leased_by=p_worker_id AND j.leased_until>clock_timestamp();
  IF v_context IS NULL THEN
    RAISE EXCEPTION 'executor job % is not actively leased or assigned',p_job_id USING ERRCODE='55000', DETAIL=jsonb_build_object('reason','job_not_in_flight')::text;
  END IF;
  RETURN v_context;
END; $function$;

CREATE OR REPLACE FUNCTION resolve_executor_launch_model(p_job_id bigint)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET search_path TO 'control_plane', 'public', 'extensions', 'pg_temp'
AS $function$
  WITH task AS (
    SELECT t.id AS task_id,get_task_runtime_snapshot(t.id) AS snapshot
    FROM runtime_jobs j JOIN tasks t ON t.id=j.task_id
    WHERE j.id=p_job_id AND j.job_type IN ('start_implementation','implementation_run')
  ), handoff_assignment AS (
    SELECT h.executor_assignment_id AS assignment_id
    FROM runtime_jobs j
    JOIN domain_events e ON e.id=j.source_event_id AND e.event_type='implementation.requested'
    JOIN handoffs h ON h.id=(e.payload->>'handoff_id')::uuid
    WHERE j.id=p_job_id AND j.job_type IN ('start_implementation','implementation_run')
  ), snapshot_model AS (
    SELECT e->>'model_id' AS model,e->>'entry_id' AS entry_id,
      e->>'verification_id' AS verification_id
    FROM task, handoff_assignment ha,
      jsonb_array_elements(task.snapshot->'executors') e
    WHERE task.snapshot->>'source'='catalog' AND e->>'model_id' IS NOT NULL
      AND e->'assignment_ids' @> to_jsonb(ha.assignment_id::text)
    LIMIT 1
  ), snapshot_has_provenance AS (
    SELECT EXISTS (
      SELECT 1 FROM task, jsonb_array_elements(task.snapshot->'executors') e
      WHERE task.snapshot->>'source'='catalog' AND e->>'model_id' IS NOT NULL
        AND jsonb_typeof(e->'assignment_ids')='array' AND jsonb_array_length(e->'assignment_ids')>0
    ) AS has
  ), snapshot_model_fallback AS (
    SELECT e->>'model_id' AS model,e->>'entry_id' AS entry_id,
      e->>'verification_id' AS verification_id
    FROM task, jsonb_array_elements(task.snapshot->'executors') e
    WHERE task.snapshot->>'source'='catalog' AND e->>'model_id' IS NOT NULL
      AND NOT (SELECT has FROM snapshot_has_provenance)
    ORDER BY e->>'model_id' LIMIT 1
  )
  SELECT COALESCE((
    SELECT jsonb_build_object(
      'model',sm.model,'snapshot_entry_id',sm.entry_id,
      'snapshot_verification_id',sm.verification_id,'snapshot_authorized',true
    ) FROM snapshot_model sm
  ),(
    SELECT jsonb_build_object(
      'model',smf.model,'snapshot_entry_id',smf.entry_id,
      'snapshot_verification_id',smf.verification_id,'snapshot_authorized',true
    ) FROM snapshot_model_fallback smf
  ),(
    SELECT jsonb_build_object('snapshot_mismatch',true)
    FROM task WHERE task.snapshot->>'source'='catalog'
  ),(
    SELECT jsonb_build_object(
      'model',rp.model,'snapshot_authorized',false
    )
    FROM runtime_jobs j
    JOIN domain_events e ON e.id=j.source_event_id AND e.event_type='implementation.requested'
    JOIN handoffs h ON h.id=(e.payload->>'handoff_id')::uuid
    JOIN project_agent_assignments pa ON pa.id=h.executor_assignment_id
      AND pa.project_id=j.project_id AND pa.agent_id=h.to_agent_id
      AND pa.assignment_role='executor' AND pa.enabled
    JOIN task_executor_assignments tea ON tea.task_id=j.task_id
      AND tea.project_agent_assignment_id=pa.id AND tea.enabled
    JOIN runtime_profiles rp ON rp.id=pa.runtime_profile_id AND rp.enabled AND rp.runtime_type='opencode'
    WHERE j.id=p_job_id AND j.job_type IN ('start_implementation','implementation_run')
  ),'null'::jsonb);
$function$;

CREATE OR REPLACE FUNCTION reserve_runtime_launch(p_run_id uuid, p_project_id uuid, p_job_id bigint, p_supervisor_id text, p_ttl interval DEFAULT '00:01:30'::interval)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'control_plane', 'public', 'extensions', 'pg_temp'
AS $function$
DECLARE v_project projects%ROWTYPE; v_token text;
  v_reservation runtime_launch_reservations%ROWTYPE;
  v_lease_valid boolean;
BEGIN
  IF p_ttl <= interval '0 seconds' OR p_ttl > interval '10 minutes' THEN
    RAISE EXCEPTION 'invalid launch reservation lifetime' USING ERRCODE='22023', DETAIL=jsonb_build_object('reason','launch_reservation_invalid')::text;
  END IF;
  SELECT * INTO v_project FROM projects WHERE id=p_project_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'project is unavailable' USING ERRCODE='55000', DETAIL=jsonb_build_object('reason','project_unavailable')::text; END IF;
  IF v_project.status IN ('deleting','deletion_failed','deleted') THEN
    RAISE EXCEPTION 'project is being deleted' USING ERRCODE='55000', DETAIL=jsonb_build_object('reason','project_unavailable')::text;
  ELSIF v_project.status NOT IN ('active','needs_attention') THEN
    RAISE EXCEPTION 'project is not operable' USING ERRCODE='55000', DETAIL=jsonb_build_object('reason','project_unavailable')::text;
  END IF;
  SELECT (
    r.id IS NOT NULL
    AND j.id IS NOT NULL
    AND j.status='in_flight'
    AND j.leased_by=p_supervisor_id
    AND j.leased_until>clock_timestamp()
  ) INTO v_lease_valid
  FROM task_runs r
  JOIN tasks t ON t.id=r.task_id
  LEFT JOIN runtime_jobs j ON j.id=p_job_id
    AND j.project_id=p_project_id
    AND j.task_id=t.id
    AND j.run_id=p_run_id
    AND j.job_type IN ('start_implementation','implementation_run')
  WHERE r.id=p_run_id AND t.project_id=p_project_id AND r.status='running';
  IF v_lease_valid IS NOT TRUE THEN
    RAISE EXCEPTION 'runtime launch binding is invalid' USING ERRCODE='55000', DETAIL=jsonb_build_object('reason','launch_reservation_invalid')::text;
  END IF;
  v_token := encode(gen_random_bytes(32),'hex');
  INSERT INTO runtime_launch_reservations(run_id,project_id,job_id,supervisor_id,token,expires_at)
  VALUES(p_run_id,p_project_id,p_job_id,p_supervisor_id,v_token,clock_timestamp()+p_ttl)
  ON CONFLICT (run_id) DO UPDATE SET
    project_id=EXCLUDED.project_id, job_id=EXCLUDED.job_id,
    supervisor_id=EXCLUDED.supervisor_id, token=EXCLUDED.token,
    state='reserved', process_ref=NULL,
    created_at=clock_timestamp(), updated_at=clock_timestamp(),
    expires_at=EXCLUDED.expires_at
  WHERE runtime_launch_reservations.state IN ('cancelled','released')
  RETURNING * INTO v_reservation;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'runtime launch reservation already exists' USING ERRCODE='55000', DETAIL=jsonb_build_object('reason','launch_reservation_exists')::text;
  END IF;
  RETURN jsonb_build_object(
    'run_id',v_reservation.run_id,'status','reserved',
    'token',v_reservation.token,'expires_at',v_reservation.expires_at
  );
END $function$;

CREATE OR REPLACE FUNCTION start_implementation_job(p_job_id bigint, p_session_id uuid, p_supervisor_id text, p_lock_ttl interval DEFAULT '00:05:00'::interval)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'control_plane', 'public', 'extensions', 'pg_temp'
AS $function$
DECLARE
  v_job runtime_jobs%ROWTYPE; v_event domain_events%ROWTYPE; v_task tasks%ROWTYPE;
  v_handoff handoffs%ROWTYPE; v_run task_runs%ROWTYPE; v_started_event domain_events%ROWTYPE;
  v_token bigint; v_result jsonb; v_event_type text;
BEGIN
  SELECT * INTO v_job FROM runtime_jobs j WHERE j.id=p_job_id FOR UPDATE;
  IF NOT FOUND THEN PERFORM refuse('job_not_found', format('no runtime job %s', p_job_id)); END IF;
  IF v_job.job_type NOT IN ('start_implementation','implementation_run') THEN
    PERFORM refuse('job_type_mismatch', format('job %s is a %s, not a start_implementation', p_job_id, v_job.job_type));
  END IF;
  IF v_job.status<>'in_flight' THEN
    PERFORM refuse('job_not_in_flight', format('job %s is %s, not claimed', p_job_id, v_job.status));
  END IF;
  IF v_job.leased_by<>p_supervisor_id THEN
    PERFORM refuse('job_lease_held_by_another', format('job %s is leased by %s', p_job_id, v_job.leased_by));
  END IF;
  IF v_job.leased_until<=clock_timestamp() THEN
    PERFORM refuse('job_lease_expired', format('the lease on job %s expired at %s', p_job_id, v_job.leased_until));
  END IF;
  IF v_job.result IS NOT NULL THEN RETURN v_job.result; END IF;
  SELECT * INTO v_event FROM domain_events e WHERE e.id=v_job.source_event_id AND e.event_type='implementation.requested';
  SELECT * INTO v_task FROM tasks t WHERE t.id=v_event.task_id FOR UPDATE;
  IF v_task.status<>'implementation_requested' THEN
    PERFORM refuse('task_not_implementation_requested',
      format('task %s is %s, not waiting for an implementation', v_task.id, v_task.status));
  END IF;
  SELECT * INTO v_handoff FROM handoffs h WHERE h.id=(v_event.payload->>'handoff_id')::uuid FOR UPDATE;
  IF v_handoff.to_agent_id<>v_task.active_agent_id THEN
    PERFORM refuse('handoff_assignee_mismatch',
      format('handoff %s names agent %s; the task assigns %s', v_handoff.id, v_handoff.to_agent_id, v_task.active_agent_id));
  END IF;
  IF NOT EXISTS(SELECT 1 FROM agent_sessions s WHERE s.id=p_session_id AND s.project_id=v_event.project_id
    AND s.agent_id=v_handoff.to_agent_id AND s.active) THEN
    PERFORM refuse('worker_session_not_active',
      format('session %s is not active for agent %s', p_session_id, v_handoff.to_agent_id));
  END IF;
  INSERT INTO task_runs(task_id,session_id,agent_id,phase,status,write_capable)
    VALUES(v_task.id,p_session_id,v_handoff.to_agent_id,
      CASE WHEN v_handoff.revision_number>1 THEN 'revision' ELSE 'implementation' END,'starting',true)
    RETURNING * INTO v_run;
  v_token:=acquire_workspace_lock(v_event.project_id,v_run.id,'implementation',p_lock_ttl);
  UPDATE task_runs SET status='running',started_at=clock_timestamp(),updated_at=clock_timestamp(),version=version+1
    WHERE id=v_run.id RETURNING * INTO v_run;
  UPDATE handoffs SET target_run_id=v_run.id WHERE id=v_handoff.id;
  UPDATE tasks SET status=CASE WHEN v_handoff.revision_number>1 THEN 'revising' ELSE 'implementing' END,
    version=version+1,updated_at=clock_timestamp() WHERE id=v_task.id RETURNING * INTO v_task;
  v_event_type:=CASE WHEN v_handoff.revision_number>1 THEN 'revision.started' ELSE 'implementation.started' END;
  v_started_event:=append_event(v_event_type,v_event.project_id,v_task.id,v_run.id,'system',p_supervisor_id,
    v_event.causation_id,v_event.correlation_id,
    -- 0072: a retry from dead_letter starts again, and its start is a new
    -- event; the first start keeps the key it always had.
    'start:'||v_event.id||CASE WHEN v_job.attempt_base>0 THEN ':retry:'||v_job.attempt_base ELSE '' END,
    'task',v_task.id,v_task.version,
    jsonb_build_object('handoff_id',v_handoff.id,'revision_number',v_handoff.revision_number,'fencing_token',v_token));
  v_result:=jsonb_build_object('status','running','run_id',v_run.id,'task_id',v_task.id,'task_version',v_task.version,
    'handoff_id',v_handoff.id,'revision_number',v_handoff.revision_number,'fencing_token',v_token,
    'started_event_id',v_started_event.id,'started_event_type',v_event_type);
  UPDATE runtime_jobs SET run_id=v_run.id,result=v_result WHERE id=p_job_id;
  RETURN v_result;
END; $function$;

CREATE OR REPLACE FUNCTION finalize_worker_completion(p_report_id uuid, p_job_id bigint, p_supervisor_id text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'control_plane', 'public', 'extensions', 'pg_temp'
AS $function$
DECLARE
  v_report worker_completion_reports%ROWTYPE;
  v_job runtime_jobs%ROWTYPE;
  v_task tasks%ROWTYPE;
  v_handoff handoffs%ROWTYPE;
  v_result jsonb;
BEGIN
  SELECT * INTO v_report FROM worker_completion_reports r WHERE r.id = p_report_id FOR UPDATE;
  IF NOT FOUND THEN
    PERFORM refuse('completion_report_not_found',
      format('worker completion report %s not found', p_report_id), '23503');
  END IF;
  IF v_report.status = 'accepted' THEN RETURN v_report.completion_result; END IF;
  IF v_report.status <> 'submitted' THEN
    PERFORM refuse('completion_report_not_finalizable',
      format('worker completion report %s is not finalizable', p_report_id));
  END IF;

  SELECT * INTO v_job FROM runtime_jobs j WHERE j.id = p_job_id FOR UPDATE;
  IF NOT FOUND THEN
    PERFORM refuse('job_not_found', 'runtime supervisor does not own the completion run');
  END IF;
  IF v_job.run_id IS DISTINCT FROM v_report.run_id OR v_job.job_type NOT IN ('start_implementation','implementation_run') THEN
    PERFORM refuse('completion_job_mismatch', 'runtime supervisor does not own the completion run');
  END IF;
  IF v_job.status <> 'in_flight' THEN
    PERFORM refuse('job_not_in_flight', 'runtime supervisor does not own the completion run');
  END IF;
  IF v_job.leased_by IS DISTINCT FROM p_supervisor_id THEN
    PERFORM refuse('job_lease_held_by_another', 'runtime supervisor does not own the completion run');
  END IF;
  IF v_job.leased_until <= clock_timestamp() THEN
    PERFORM refuse('job_lease_expired', 'runtime supervisor does not own the completion run');
  END IF;
  IF EXISTS (SELECT 1 FROM review_evidence_bases b WHERE b.run_id = v_report.run_id)
     AND NOT EXISTS (SELECT 1 FROM review_evidence e WHERE e.run_id = v_report.run_id) THEN
    PERFORM refuse('review_evidence_missing',
      format('run %s cannot complete before its review evidence is recorded', v_report.run_id));
  END IF;
  SELECT * INTO v_task FROM tasks t WHERE t.id = v_report.task_id FOR UPDATE;
  SELECT * INTO v_handoff FROM handoffs h WHERE h.target_run_id = v_report.run_id;

  v_result := complete_implementation(
    v_report.project_id, v_report.task_id, v_report.run_id, v_report.agent_id,
    v_handoff.from_agent_id, v_report.fencing_token,
    v_report.result_summary, v_report.checks_summary,
    'complete:' || v_report.run_id, v_task.version, v_report.task_id::text
  );
  UPDATE worker_completion_reports
  SET status = 'accepted', completion_result = v_result, finalized_at = clock_timestamp()
  WHERE id = p_report_id;
  RETURN v_result;
END;
$function$;

CREATE OR REPLACE FUNCTION finalize_unreported_run(p_job_id bigint, p_worker_id text, p_native_session_id text DEFAULT NULL::text, p_detail text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'control_plane', 'public', 'extensions', 'pg_temp'
AS $function$
DECLARE v_job runtime_jobs%ROWTYPE; v_task tasks%ROWTYPE; v_run task_runs%ROWTYPE;
  v_report worker_interaction_reports%ROWTYPE; v_event domain_events%ROWTYPE; v_token bigint; v_result jsonb;
BEGIN
  SELECT * INTO v_job FROM runtime_jobs WHERE id=p_job_id FOR UPDATE;
  IF NOT FOUND OR v_job.status<>'in_flight' OR v_job.leased_by IS DISTINCT FROM p_worker_id
     OR v_job.job_type NOT IN ('start_implementation','implementation_run') OR v_job.run_id IS NULL THEN
    RAISE EXCEPTION 'the implementation job is not in flight for this worker' USING ERRCODE='55000', DETAIL=jsonb_build_object('reason','job_not_in_flight')::text;
  END IF;
  SELECT * INTO v_run FROM task_runs WHERE id=v_job.run_id FOR UPDATE;
  IF NOT v_run.write_capable OR v_run.status NOT IN ('starting','running') THEN
    RAISE EXCEPTION 'the run is not an active implementation' USING ERRCODE='55000', DETAIL=jsonb_build_object('reason','run_not_running')::text;
  END IF;
  SELECT * INTO v_task FROM tasks WHERE id=v_job.task_id FOR UPDATE;

  UPDATE agent_sessions SET native_session_id=COALESCE(native_session_id,NULLIF(p_native_session_id,'')),
    updated_at=clock_timestamp(),version=version+1 WHERE id=v_run.session_id;
  UPDATE task_runs SET status='failed',finished_at=clock_timestamp(),failure_code='terminal_report_missing',
    exit_code=0,updated_at=clock_timestamp(),version=version+1 WHERE id=v_run.id;
  SELECT fencing_token INTO v_token FROM workspace_locks
  WHERE project_id=v_job.project_id AND status='held' AND owner_run_id=v_run.id;
  IF v_token IS NOT NULL THEN PERFORM release_workspace_lock(v_job.project_id,v_run.id,v_token); END IF;
  UPDATE tasks SET status='needs_attention',version=version+1,updated_at=clock_timestamp()
  WHERE id=v_task.id RETURNING * INTO v_task;

  INSERT INTO worker_interaction_reports(project_id,task_id,run_id,agent_id,fencing_token,native_session_id,
    report_type,payload,idempotency_key,status,result,finalized_at)
  VALUES(v_job.project_id,v_job.task_id,v_run.id,v_run.agent_id,COALESCE(v_run.workspace_fencing_token,v_token),
    COALESCE(NULLIF(p_native_session_id,''),'unreported:'||v_run.id),'input_request',
    jsonb_build_object(
      'question','The executor stopped without submitting its report. Anything it changed is in the workspace. '
        || 'Tell it how to continue — for example, to report what it did and finish.',
      'reason','terminal_report_missing',
      'context',left(COALESCE(p_detail,''),2000)),
    'unreported:'||v_job.id,'finalized',jsonb_build_object('status','needs_attention'),clock_timestamp())
  ON CONFLICT(run_id,idempotency_key) DO UPDATE SET idempotency_key=EXCLUDED.idempotency_key
  RETURNING * INTO v_report;

  v_event:=append_event('run.unreported',v_job.project_id,v_job.task_id,v_run.id,'system',p_worker_id,NULL,
    v_job.task_id::text,'unreported:'||v_job.id,'task',v_job.task_id,v_task.version,
    jsonb_build_object('job_id',v_job.id,'report_id',v_report.id,'question',v_report.payload->>'question'));
  v_result:=jsonb_build_object('project_id',v_job.project_id,'task_id',v_job.task_id,'job_id',v_job.id,
    'status','unreported','event_id',v_event.id,'report_id',v_report.id);
  UPDATE runtime_jobs SET status='completed',result=v_result,leased_by=NULL,leased_until=NULL,
    last_error='terminal_report_missing',completed_at=clock_timestamp(),activity_phase='completed',
    activity_detail='The executor ended without its report; the operator was asked how to continue'
  WHERE id=v_job.id;
  RETURN v_result;
END $function$;

CREATE OR REPLACE FUNCTION request_workspace_operation(p_project_id uuid, p_operation_type text, p_actor_id text, p_reason text, p_correlation_id text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'control_plane', 'public', 'extensions', 'pg_temp'
AS $function$
DECLARE v_lock workspace_locks%ROWTYPE; v_operation workspace_operations%ROWTYPE;
BEGIN
  IF p_operation_type NOT IN ('recover_lock','restore_owner') OR length(trim(p_actor_id))<2
     OR length(trim(p_reason))<3 OR length(p_reason)>500 THEN
    RAISE EXCEPTION 'invalid workspace operation request' USING ERRCODE='22023', DETAIL=jsonb_build_object('reason','workspace_operation_invalid')::text; END IF;
  PERFORM 1 FROM projects WHERE id=p_project_id AND status<>'archived' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'project is unavailable' USING ERRCODE='55000', DETAIL=jsonb_build_object('reason','project_unavailable')::text; END IF;
  SELECT * INTO v_lock FROM workspace_locks WHERE project_id=p_project_id FOR UPDATE;
  IF p_operation_type='recover_lock' AND v_lock.status<>'reconciliation_required' THEN
    RAISE EXCEPTION 'workspace lock does not require reconciliation' USING ERRCODE='55000', DETAIL=jsonb_build_object('reason','workspace_operation_invalid')::text; END IF;
  IF p_operation_type='restore_owner' AND v_lock.status<>'released' THEN
    RAISE EXCEPTION 'workspace ownership can only be restored while the lock is released' USING ERRCODE='55000', DETAIL=jsonb_build_object('reason','workspace_operation_invalid')::text; END IF;
  IF EXISTS(
    SELECT 1 FROM runtime_jobs j
    WHERE j.project_id=p_project_id
      AND (j.status='in_flight'
           OR (j.status='pending' AND (p_operation_type<>'recover_lock' OR j.job_type IN ('start_implementation','implementation_run'))))
  ) THEN
    RAISE EXCEPTION 'workspace has active or pending runtime work' USING ERRCODE='55000',
      DETAIL=CASE WHEN p_operation_type='recover_lock'
        THEN 'recover_lock waits for work in flight and for a pending implementation; a pending read-only turn does not block it'
        ELSE 'restore_owner waits for all pending and in-flight work' END;
  END IF;
  INSERT INTO workspace_operations(project_id,operation_type,requested_by,reason,correlation_id)
  VALUES(p_project_id,p_operation_type,p_actor_id,trim(p_reason),p_correlation_id) RETURNING * INTO v_operation;
  PERFORM write_audit_event(p_project_id,NULL,NULL,'user',p_actor_id,'workspace.operation_requested',
    'workspace_operation',v_operation.id::text,'allowed',NULL,
    jsonb_build_object('operation_type',p_operation_type,'reason',trim(p_reason)),p_correlation_id);
  RETURN jsonb_build_object('operation_id',v_operation.id,'status',v_operation.status,
    'operation_type',v_operation.operation_type);
END; $function$;

CREATE OR REPLACE FUNCTION end_runtime_job(p_job_id bigint, p_actor text, p_reason text, p_error text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'control_plane', 'public', 'extensions', 'pg_temp'
AS $function$
DECLARE v_job runtime_jobs%ROWTYPE; v_run task_runs%ROWTYPE; v_task tasks%ROWTYPE; v_lock workspace_locks%ROWTYPE;
  v_note text; v_event domain_events%ROWTYPE; v_aggregate text; v_aggregate_id uuid; v_version bigint;
BEGIN
  SELECT note INTO v_note FROM failure_reasons WHERE reason=p_reason;
  IF v_note IS NULL THEN PERFORM refuse(p_reason, 'a job ends with a reason from the vocabulary'); END IF;
  UPDATE runtime_jobs SET status='dead_letter',failure_reason=p_reason,leased_by=NULL,leased_until=NULL,
    last_error=left(COALESCE(p_error,p_reason),4000),completed_at=clock_timestamp(),
    activity_detail=left(v_note,500)
  WHERE id=p_job_id RETURNING * INTO v_job;

  -- A turn's run is closed by its own trigger (0059/0061) when the job leaves
  -- in_flight. An implementation's run is this function's.
  IF v_job.run_id IS NOT NULL THEN
    SELECT * INTO v_run FROM task_runs WHERE id=v_job.run_id FOR UPDATE;
    IF v_run.write_capable AND v_run.status IN ('queued','starting','running','waiting_for_input','blocked') THEN
      SELECT * INTO v_lock FROM workspace_locks
      WHERE project_id=v_job.project_id AND status='held' AND owner_run_id=v_run.id FOR UPDATE;
      IF v_lock.project_id IS NOT NULL AND v_lock.lease_expires_at<=clock_timestamp() THEN
        -- The lease ran out before the job ended — a job reclaimed after its
        -- worker died carries such a run. Whoever held it may still be writing,
        -- so the lock is not released: it is left exactly as the reconciler
        -- leaves an expired lease, and the run is lost, not failed, because the
        -- reconciler cannot move a failed run to lost and would stop on it.
        UPDATE task_runs SET status='lost',failure_code='workspace_lease_expired',finished_at=clock_timestamp(),
          updated_at=clock_timestamp(),version=version+1 WHERE id=v_run.id RETURNING * INTO v_run;
        UPDATE workspace_locks SET owner_run_id=NULL,lease_expires_at=NULL,status='reconciliation_required',
          reason='lease_expired',version=version+1 WHERE project_id=v_job.project_id;
      ELSE
        UPDATE task_runs SET status='failed',failure_code=p_reason,finished_at=clock_timestamp(),
          updated_at=clock_timestamp(),version=version+1 WHERE id=v_run.id RETURNING * INTO v_run;
        IF v_lock.project_id IS NOT NULL THEN
          PERFORM release_workspace_lock(v_job.project_id,v_run.id,v_lock.fencing_token);
        END IF;
      END IF;
    END IF;
  END IF;
  -- What the supervisor started and never said how it ended.
  UPDATE runtime_dispatch_attempts SET finished_at=clock_timestamp(),
    native_result=jsonb_build_object('status','not_reported','job_ended',p_reason)
  WHERE job_id=v_job.id AND finished_at IS NULL;

  IF v_job.job_type IN ('start_implementation','implementation_run') THEN
    UPDATE tasks SET status='needs_attention',version=version+1,updated_at=clock_timestamp()
    WHERE id=v_job.task_id AND status IN ('implementation_requested','implementing','revising')
    RETURNING * INTO v_task;
  END IF;
  IF v_task.id IS NOT NULL THEN
    v_aggregate:='task'; v_aggregate_id:=v_task.id; v_version:=v_task.version;
  ELSIF v_job.run_id IS NOT NULL THEN
    SELECT 'run',id,version INTO v_aggregate,v_aggregate_id,v_version FROM task_runs WHERE id=v_job.run_id;
  END IF;
  IF v_aggregate IS NOT NULL THEN
    v_event:=append_event('runtime_job.dead_lettered',v_job.project_id,v_job.task_id,v_job.run_id,'system',p_actor,
      NULL,v_job.task_id::text,'dead-letter:'||v_job.id||':'||v_job.attempt_count,v_aggregate,v_aggregate_id,v_version,
      jsonb_build_object('job_id',v_job.id,'job_type',v_job.job_type,'reason',p_reason,
        'message','This work stopped: '||v_note||'.','error',left(COALESCE(p_error,''),500)));
  END IF;
  RETURN jsonb_build_object('job_id',v_job.id,'status','dead_letter','failure_reason',p_reason,
    'run_id',v_job.run_id,'event_id',v_event.id);
END $function$;

CREATE OR REPLACE FUNCTION retry_dead_letter_job(p_job_id bigint, p_attempt integer, p_owner_id uuid, p_actor text, p_note text, p_correlation_id text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'control_plane', 'public', 'extensions', 'pg_temp'
AS $function$
DECLARE v_job runtime_jobs%ROWTYPE; v_recovery runtime_job_recoveries%ROWTYPE; v_task tasks%ROWTYPE;
  v_blocked text; v_runtime text; v_handoff handoffs%ROWTYPE; v_lock workspace_locks%ROWTYPE;
  v_selection runtime_job_selections%ROWTYPE; v_reported text; v_superseded boolean := false; v_audit uuid;
  v_event domain_events%ROWTYPE; v_locked record;
BEGIN
  IF p_note IS NULL OR length(trim(p_note)) < 3 OR length(p_note) > 2000 THEN
    PERFORM refuse('dead_letter_note_invalid', 'a retry says why, in 3 to 2000 characters', '22023');
  END IF;
  SELECT * INTO v_locked FROM locked_dead_letter(p_job_id, p_attempt, p_owner_id, 'retry');
  v_job:=v_locked.o_job; v_recovery:=v_locked.o_recovery;
  IF v_recovery.id IS NOT NULL THEN
    -- The same click again: the answer it already had.
    RETURN jsonb_build_object('job_id',v_job.id,'recovery_id',v_recovery.id,'action','retry','repeat',true,
      'status',v_job.status,'selection_id',v_recovery.selection_id,'selection_superseded',v_recovery.selection_superseded);
  END IF;

  SELECT * INTO v_task FROM tasks WHERE id=v_job.task_id FOR UPDATE;
  IF v_task.status IN ('approved','publishing','deployed','completed','cancelled','failed') THEN
    PERFORM refuse('dead_letter_task_closed', format('task %s is %s', v_task.id, v_task.status));
  END IF;
  -- Nothing to retry into while the runtime is still gone: restore it first.
  v_runtime:=runtime_job_runtime(v_job);
  v_blocked:=runtime_undispatchable_reason(v_runtime);
  IF v_blocked IS NOT NULL THEN
    PERFORM refuse(v_blocked, format('job %s runs on %s: %s; restore it, then retry',
      p_job_id, v_runtime, (SELECT note FROM failure_reasons WHERE reason=v_blocked)));
  END IF;

  IF v_job.job_type IN ('start_implementation','implementation_run') THEN
    SELECT h.* INTO v_handoff FROM domain_events e JOIN handoffs h ON h.id=NULLIF(e.payload->>'handoff_id','')::uuid
    WHERE e.id=v_job.source_event_id;
    IF v_task.status NOT IN ('needs_attention','implementation_requested','implementing','revising')
       OR EXISTS (SELECT 1 FROM handoffs h WHERE h.task_id=v_task.id AND h.revision_number>v_handoff.revision_number)
       OR v_handoff.to_agent_id IS DISTINCT FROM v_task.active_agent_id
       OR EXISTS (SELECT 1 FROM runtime_jobs o WHERE o.task_id=v_task.id AND o.id<>v_job.id
                  AND o.job_type IN ('start_implementation','implementation_run') AND o.status IN ('pending','in_flight')) THEN
      PERFORM refuse('dead_letter_superseded',
        format('task %s is %s and has moved past handoff %s', v_task.id, v_task.status, v_handoff.revision_number));
    END IF;
    -- Released is the only state a new run can start from. Held is another
    -- run's; reconciliation_required and expired are the operator's to recover
    -- first (request_workspace_operation), not something a retry steps over.
    SELECT * INTO v_lock FROM workspace_locks WHERE project_id=v_job.project_id FOR UPDATE;
    IF v_lock.status IS DISTINCT FROM 'released' AND v_lock.project_id IS NOT NULL THEN
      PERFORM refuse('dead_letter_workspace_busy',
        format('the workspace is %s%s', v_lock.status,
          CASE WHEN v_lock.owner_run_id IS NOT NULL THEN ' by run '||v_lock.owner_run_id ELSE '' END));
    END IF;
  ELSIF v_job.job_type IN ('resume_codex','resume_orchestrator') AND v_task.status<>'reviewing' THEN
    PERFORM refuse('dead_letter_superseded', format('task %s is %s, no longer waiting for this review', v_task.id, v_task.status));
  ELSIF EXISTS (SELECT 1 FROM runtime_jobs o WHERE o.task_id=v_task.id AND o.id>v_job.id
                AND o.job_type IN ('codex_chat_turn','resume_codex','orchestrator_turn','resume_orchestrator') AND o.status='completed') THEN
    PERFORM refuse('dead_letter_superseded', format('a later turn of task %s has already answered', v_task.id));
  END IF;

  -- The selection (0071): reused when the host reports the version it
  -- recorded; superseded, saying from what to what, when it reports another.
  v_selection:=current_runtime_job_selection(v_job.id);
  IF v_selection.id IS NOT NULL AND v_selection.source<>'backfill' THEN
    SELECT e->>'version' INTO v_reported FROM runtime_health h, jsonb_array_elements(h.snapshot->'runtimes') e
    WHERE h.singleton AND e->>'runtime'=v_selection.runtime_type;
    IF v_reported IS NOT NULL AND v_reported IS DISTINCT FROM v_selection.runtime_version THEN
      PERFORM supersede_runtime_job_selection(v_job.id, p_actor,
        format('retried from dead letter (%s): the host reports %s %s, the selection recorded %s',
          v_job.failure_reason, v_selection.runtime_type, v_reported, COALESCE(v_selection.runtime_version,'no version')),
        jsonb_build_object('runtime_version', v_reported));
      v_selection:=current_runtime_job_selection(v_job.id);
      v_superseded:=true;
    END IF;
  END IF;

  INSERT INTO runtime_job_recoveries(job_id,project_id,task_id,action,dead_letter_attempt,recovered_from,last_error,
    actor,note,selection_id,selection_superseded,correlation_id)
  VALUES(v_job.id,v_job.project_id,v_job.task_id,'retry',v_job.attempt_count,v_job.failure_reason,left(v_job.last_error,2000),
    p_actor,trim(p_note),v_selection.id,v_superseded,p_correlation_id)
  RETURNING * INTO v_recovery;

  -- The same job, back in the queue with the worker's whole budget. An
  -- implementation starts a new run under a new lock: its old run ended with
  -- the dead letter, and the start result that named it is cleared so
  -- start_implementation_job does not hand it back.
  UPDATE runtime_jobs SET status='pending',available_at=clock_timestamp(),attempt_base=attempt_count,
    last_error=NULL,completed_at=NULL,
    run_id=CASE WHEN job_type IN ('start_implementation','implementation_run') THEN NULL ELSE run_id END,
    result=CASE WHEN job_type IN ('start_implementation','implementation_run') THEN NULL ELSE result END,
    activity_detail='Retried by the operator'
  WHERE id=v_job.id RETURNING * INTO v_job;
  IF v_job.job_type IN ('start_implementation','implementation_run') AND v_task.status<>'implementation_requested' THEN
    UPDATE tasks SET status='implementation_requested',version=version+1,updated_at=clock_timestamp()
    WHERE id=v_task.id RETURNING * INTO v_task;
    v_event:=append_event('runtime_job.retried',v_job.project_id,v_job.task_id,NULL,'user',p_actor,NULL,
      COALESCE(p_correlation_id,v_task.id::text),'dead-letter-retry:'||v_recovery.id,'task',v_task.id,v_task.version,
      jsonb_build_object('job_id',v_job.id,'recovery_id',v_recovery.id,'recovered_from',v_recovery.recovered_from,
        'message','You retried the work that had stopped ('||v_recovery.recovered_from||').'));
  END IF;
  v_audit:=write_audit_event(v_job.project_id,v_job.task_id,NULL,'operator',p_actor,'runtime_job.retried',
    'runtime_job',v_job.id::text,'allowed',NULL,
    jsonb_build_object('recovery_id',v_recovery.id,'recovered_from',v_recovery.recovered_from,'note',v_recovery.note,
      'selection_id',v_selection.id,'selection_superseded',v_superseded),p_correlation_id);
  RETURN jsonb_build_object('job_id',v_job.id,'recovery_id',v_recovery.id,'action','retry','repeat',false,
    'status',v_job.status,'selection_id',v_selection.id,'selection_superseded',v_superseded,
    'audit_event_id',v_audit,'event_id',v_event.id);
END $function$;

CREATE OR REPLACE FUNCTION dismiss_dead_letter_job(p_job_id bigint, p_attempt integer, p_owner_id uuid, p_actor text, p_note text, p_correlation_id text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'control_plane', 'public', 'extensions', 'pg_temp'
AS $function$
DECLARE v_job runtime_jobs%ROWTYPE; v_recovery runtime_job_recoveries%ROWTYPE; v_task tasks%ROWTYPE; v_audit uuid;
  v_locked record;
BEGIN
  IF p_note IS NULL OR length(trim(p_note)) < 8 OR length(p_note) > 2000 THEN
    PERFORM refuse('dead_letter_note_invalid', 'a dismissal says why, in 8 to 2000 characters', '22023');
  END IF;
  SELECT * INTO v_locked FROM locked_dead_letter(p_job_id, p_attempt, p_owner_id, 'dismiss');
  v_job:=v_locked.o_job; v_recovery:=v_locked.o_recovery;
  IF v_recovery.id IS NOT NULL THEN
    RETURN jsonb_build_object('job_id',v_job.id,'recovery_id',v_recovery.id,'action','dismiss','repeat',true,
      'resolved_at',v_job.resolved_at);
  END IF;
  INSERT INTO runtime_job_recoveries(job_id,project_id,task_id,action,dead_letter_attempt,recovered_from,last_error,
    actor,note,correlation_id)
  VALUES(v_job.id,v_job.project_id,v_job.task_id,'dismiss',v_job.attempt_count,v_job.failure_reason,
    left(v_job.last_error,2000),p_actor,trim(p_note),p_correlation_id)
  RETURNING * INTO v_recovery;
  UPDATE runtime_jobs SET resolved_at=clock_timestamp(),resolved_by=p_actor,resolution=trim(p_note)
  WHERE id=v_job.id RETURNING * INTO v_job;
  -- What resolve_runtime_job_incident did for a review that will not come.
  IF v_job.job_type IN ('resume_codex','resume_orchestrator') THEN
    UPDATE tasks SET status='awaiting_review',version=version+1,updated_at=clock_timestamp()
    WHERE id=v_job.task_id AND status='reviewing' RETURNING * INTO v_task;
  END IF;
  v_audit:=write_audit_event(v_job.project_id,v_job.task_id,NULL,'operator',p_actor,'runtime_job.dismissed',
    'runtime_job',v_job.id::text,'allowed',NULL,
    jsonb_build_object('recovery_id',v_recovery.id,'recovered_from',v_recovery.recovered_from,'note',v_recovery.note,
      'task_status',v_task.status),p_correlation_id);
  RETURN jsonb_build_object('job_id',v_job.id,'recovery_id',v_recovery.id,'action','dismiss','repeat',false,
    'resolved_at',v_job.resolved_at,'task_status',v_task.status,'audit_event_id',v_audit);
END $function$;

CREATE OR REPLACE FUNCTION resolve_runtime_job_incident(p_job_id bigint, p_actor_id text, p_resolution text, p_correlation_id text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'control_plane', 'public', 'extensions', 'pg_temp'
AS $function$
DECLARE v runtime_jobs%ROWTYPE; v_audit uuid; v_task tasks%ROWTYPE;
BEGIN
  SELECT * INTO v FROM runtime_jobs WHERE id=p_job_id FOR UPDATE;
  IF NOT FOUND OR v.status<>'dead_letter' OR v.resolved_at IS NOT NULL OR length(trim(p_resolution))<8 THEN
    RAISE EXCEPTION 'dead-letter incident is not resolvable' USING ERRCODE='55000', DETAIL=jsonb_build_object('reason','dead_letter_already_handled')::text;
  END IF;
  UPDATE runtime_jobs SET resolved_at=clock_timestamp(),resolved_by=p_actor_id,resolution=p_resolution
    WHERE id=p_job_id RETURNING * INTO v;
  IF v.job_type IN ('resume_codex','resume_orchestrator') THEN
    UPDATE tasks SET status='awaiting_review',version=version+1,updated_at=clock_timestamp()
      WHERE id=v.task_id AND status='reviewing' RETURNING * INTO v_task;
  END IF;
  v_audit:=write_audit_event(v.project_id,v.task_id,v.run_id,'operator',p_actor_id,
    'runtime_job.incident_resolved','runtime_job',v.id::text,'allowed',NULL,
    jsonb_build_object('resolution',p_resolution,'task_status',v_task.status),p_correlation_id);
  RETURN jsonb_build_object('job_id',v.id,'resolved_at',v.resolved_at,'audit_event_id',v_audit,
    'task_status',v_task.status);
END; $function$;

-- The one reader that takes the type as an argument. Its callers name a type
-- in either vocabulary and get the job whichever name it was queued under.
CREATE OR REPLACE FUNCTION claim_runtime_job_for_event(p_source_event_id uuid, p_job_type text, p_supervisor_id text, p_lease interval DEFAULT '00:01:00'::interval)
 RETURNS control_plane.runtime_jobs
 LANGUAGE plpgsql
 SET search_path TO 'control_plane', 'public'
AS $function$
DECLARE
  v_job runtime_jobs%ROWTYPE;
BEGIN
  UPDATE runtime_jobs
  SET status = 'in_flight',
      attempt_count = attempt_count + 1,
      leased_by = p_supervisor_id,
      leased_until = clock_timestamp() + p_lease,
      last_error = NULL
  WHERE source_event_id = p_source_event_id
    AND job_type IN (p_job_type, CASE p_job_type
      WHEN 'codex_chat_turn' THEN 'orchestrator_turn' WHEN 'orchestrator_turn' THEN 'codex_chat_turn'
      WHEN 'resume_codex' THEN 'resume_orchestrator' WHEN 'resume_orchestrator' THEN 'resume_codex'
      WHEN 'start_implementation' THEN 'implementation_run' WHEN 'implementation_run' THEN 'start_implementation' END)
    AND available_at <= clock_timestamp()
    AND (status = 'pending' OR (status = 'in_flight' AND leased_until <= clock_timestamp()))
  RETURNING * INTO v_job;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'runtime job for event % and type % is unavailable', p_source_event_id, p_job_type
      USING ERRCODE = '55P03', DETAIL=jsonb_build_object('reason','runtime_job_unavailable')::text;
  END IF;
  RETURN v_job;
END;
$function$;
