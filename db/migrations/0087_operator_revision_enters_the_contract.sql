-- An operator's revision enters the task contract (Stage 11.4, sprint C, C0).
--
-- Found on rc.58 (task 61d0aebb in «тест-r4»): the operator pressed "Request
-- changes" in the panel and asked for a second line in a file; the executor
-- added it; the orchestrator's review turn then rejected the work because it
-- "does not match the original requirement" and asked for the line to be
-- removed. The review was right about what it had been told. A review turn is
-- given the task's stored objective and acceptance criteria, and the operator's
-- request lived only in the revision handoff's instructions — which the
-- executor reads and the reviewer never sees. The operator's word was the
-- contract, and nothing recorded it as such.
--
-- What changes:
--
--   * `tasks.operator_change_requests` — the operator's change requests, in
--     order, each with the revision it started and the task version it was
--     written at. They are written on the task row in the same UPDATE that
--     bumps the task's version, so a version names one contract, as it does
--     for the objective and the acceptance criteria.
--
--     A separate list rather than an append to `acceptance_criteria`, for two
--     reasons. The review has to tell the operator's later requests apart from
--     the original objective — that distinction is the sentence the turn got
--     wrong. And `acceptance_criteria` is one list on the task and on every
--     handoff: the panel sends the task's copy, and `request_revision` refuses
--     a copy that differs from the previous handoff's, so a task whose criteria
--     grew could never be revised from the panel again.
--
--   * `request_revision` records the request when it is the operator's. Its
--     body moves to `request_revision_from(…, p_requested_by)`, which both
--     paths call: the panel's `request_revision` (signature, grant and result
--     unchanged) as 'operator', the model's `invoke_request_revision` as
--     'agent'. A revision the orchestrator asks for is its reading of the
--     contract, not a change to it, and records nothing: only the operator
--     writes the contract. The `changes.requested` event says which it was.
--
--   * `orchestrator_job_context` carries the list to the turn as
--     `task_operator_change_requests`; the worker states it under the stored
--     objective as part of the task (turn-prompts.mjs).
--
-- A task without an operator request is unchanged: an empty list, the same
-- prompt, the same events but for one key in the payload.

SET search_path TO control_plane, public, extensions;

ALTER TABLE tasks ADD COLUMN operator_change_requests jsonb NOT NULL DEFAULT '[]'::jsonb
  CONSTRAINT tasks_operator_change_requests_is_list CHECK (jsonb_typeof(operator_change_requests) = 'array');

-- ------------------------------------------------------- request_revision_from
--
-- The body of 0081's request_revision, with one more argument and two more
-- statements: the operator's request is appended to the task's list in the
-- UPDATE that bumps the version, and the event names who asked. Everything
-- else — the command, the checks, the delegation, the inherited executor — is
-- as it was.
CREATE FUNCTION request_revision_from(p_project_id uuid, p_task_id uuid, p_reviewer_agent_id uuid, p_changes_required jsonb, p_acceptance_criteria jsonb, p_idempotency_key text, p_expected_version bigint, p_correlation_id text, p_requested_by text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'control_plane', 'public', 'extensions', 'pg_temp'
AS $function$
DECLARE
  v_command commands%ROWTYPE;
  v_task tasks%ROWTYPE;
  v_previous handoffs%ROWTYPE;
  v_change_event domain_events%ROWTYPE;
  v_delegate jsonb;
  v_result jsonb;
BEGIN
  -- Two callers, two words. Anything else is a call site that does not know
  -- whose request it carries, and a request of unknown origin must not be
  -- silently treated as the model's (recorded nowhere) or the operator's
  -- (written into the contract).
  IF p_requested_by IS NULL OR p_requested_by NOT IN ('operator','agent') THEN
    PERFORM refuse('revision_arguments_invalid','requested_by must be operator or agent','22023');
  END IF;

  v_command := submit_command(
    p_project_id, p_task_id, 'RequestRevision', 'agent', p_reviewer_agent_id::text,
    p_idempotency_key,
    jsonb_build_object('changes_required', p_changes_required, 'acceptance_criteria', p_acceptance_criteria),
    p_expected_version, p_correlation_id
  );
  IF v_command.status = 'completed' THEN RETURN v_command.result; END IF;

  SELECT * INTO v_task FROM tasks t
  WHERE t.id = p_task_id AND t.project_id = p_project_id FOR UPDATE;
  IF v_task.version <> p_expected_version OR v_task.status NOT IN ('awaiting_review','reviewing')
     OR v_task.active_agent_id <> p_reviewer_agent_id THEN
    RAISE EXCEPTION 'task is not reviewable at the expected version' USING ERRCODE = '40001', DETAIL=jsonb_build_object('reason','task_not_reviewable')::text;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM agents a WHERE a.id = p_reviewer_agent_id AND a.enabled
      AND agent_holds(a.id,'review.perform')
  ) THEN
    RAISE EXCEPTION 'reviewer agent is unavailable' USING ERRCODE = '55000', DETAIL=jsonb_build_object('reason','reviewer_unavailable')::text;
  END IF;
  SELECT * INTO v_previous FROM handoffs h
  WHERE h.task_id = p_task_id ORDER BY h.revision_number DESC LIMIT 1 FOR UPDATE;
  IF NOT FOUND OR v_previous.acceptance_criteria <> p_acceptance_criteria THEN
    RAISE EXCEPTION 'revision cannot alter acceptance criteria' USING ERRCODE = '22023', DETAIL=jsonb_build_object('reason','revision_arguments_invalid')::text;
  END IF;
  IF jsonb_typeof(p_changes_required) <> 'array' OR jsonb_array_length(p_changes_required) = 0 THEN
    RAISE EXCEPTION 'changes_required must be a non-empty array' USING ERRCODE = '22023', DETAIL=jsonb_build_object('reason','revision_arguments_invalid')::text;
  END IF;

  -- The operator's request joins the contract here, in the write that gives
  -- the task the version the request is recorded at. The model's does not: it
  -- is the reviewer reading the contract, and the executor gets it through the
  -- handoff's instructions as before.
  UPDATE tasks SET status = 'changes_requested', version = version + 1,
    updated_at = clock_timestamp(),
    operator_change_requests = CASE WHEN p_requested_by = 'operator'
      THEN operator_change_requests || jsonb_build_array(jsonb_build_object(
        'revision_number', v_previous.revision_number + 1,
        'changes_required', p_changes_required,
        'task_version', version + 1,
        'command_id', v_command.id,
        'requested_at', clock_timestamp()))
      ELSE operator_change_requests END
    WHERE id = p_task_id RETURNING * INTO v_task;
  v_change_event := append_event(
    'changes.requested', p_project_id, p_task_id, NULL,
    'agent', p_reviewer_agent_id::text, v_command.id, p_correlation_id,
    'changes:' || p_idempotency_key, 'task', p_task_id, v_task.version,
    jsonb_build_object('previous_handoff_id', v_previous.id, 'changes_required', p_changes_required,
      'requested_by', p_requested_by)
  );

  v_delegate := request_implementation(
    p_project_id, p_task_id, p_reviewer_agent_id, v_previous.to_agent_id,
    v_previous.revision_number + 1, v_previous.objective,
    v_previous.instructions || jsonb_build_object('changes_required', p_changes_required),
    v_previous.constraints, v_previous.acceptance_criteria, v_previous.relevant_paths,
    v_previous.workspace_ref, 'delegate-revision:' || p_idempotency_key,
    v_task.version, p_correlation_id
  );

  -- The seventh inherited field. Without it the new handoff names no executor,
  -- `resolve_executor_launch_model` matches no snapshot entry, and the launch is
  -- refused as a snapshot mismatch — which is what every revision requested from
  -- the panel did.
  UPDATE handoffs SET executor_assignment_id = v_previous.executor_assignment_id
  WHERE id = (v_delegate->>'handoff_id')::uuid AND executor_assignment_id IS NULL;

  v_result := jsonb_build_object(
    'status', 'revision_requested', 'command_id', v_command.id,
    'changes_event_id', v_change_event.id, 'revision_number', v_previous.revision_number + 1,
    'delegation', v_delegate
  );
  UPDATE commands SET status = 'completed', result = v_result, completed_at = clock_timestamp()
  WHERE id = v_command.id;
  RETURN v_result;
END;
$function$;
REVOKE EXECUTE ON FUNCTION request_revision_from(uuid,uuid,uuid,jsonb,jsonb,text,bigint,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION request_revision_from(uuid,uuid,uuid,jsonb,jsonb,text,bigint,text,text) TO infra_worker;

-- ------------------------------------------------------------ request_revision
--
-- The panel's entry point, and the only caller that is not the model. It runs
-- as its definer for the web tier (0062), and its signature, grant and result
-- stay what the panel and the infra_web allowlist expect.
CREATE OR REPLACE FUNCTION request_revision(p_project_id uuid, p_task_id uuid, p_reviewer_agent_id uuid, p_changes_required jsonb, p_acceptance_criteria jsonb, p_idempotency_key text, p_expected_version bigint, p_correlation_id text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'control_plane', 'public', 'extensions', 'pg_temp'
AS $function$
BEGIN
  RETURN request_revision_from(
    p_project_id, p_task_id, p_reviewer_agent_id, p_changes_required, p_acceptance_criteria,
    p_idempotency_key, p_expected_version, p_correlation_id, 'operator'
  );
END;
$function$;

-- ----------------------------------------------------- invoke_request_revision
--
-- 0080's definition; the one change is the call, which now says whose request
-- this is.
CREATE OR REPLACE FUNCTION invoke_request_revision(p_job_id bigint, p_worker_id text, p_call_id text, p_changes_required jsonb)
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
  IF NOT FOUND OR v_job.job_type <> 'resume_orchestrator' THEN
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
      AND role_holds(pa.role_definition_id,'conversation.hold');
  SELECT * INTO v_handoff FROM handoffs h WHERE h.task_id=v_task.id
    ORDER BY h.revision_number DESC LIMIT 1;
  IF v_orchestrator.id IS NULL OR v_handoff.id IS NULL OR v_handoff.executor_assignment_id IS NULL
     OR NOT EXISTS(
       SELECT 1 FROM task_executor_assignments tea
       JOIN project_agent_assignments pa ON pa.id=tea.project_agent_assignment_id
       JOIN runtime_profiles rp ON rp.id=pa.runtime_profile_id
       WHERE tea.task_id=v_task.id AND tea.project_agent_assignment_id=v_handoff.executor_assignment_id
         AND tea.enabled AND pa.enabled AND role_holds(pa.role_definition_id,'implementation.execute')
         AND rp.enabled AND runtime_plays(rp.runtime_type,'executor')
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
  v_result:=request_revision_from(
    v_task.project_id,v_task.id,v_orchestrator.agent_id,p_changes_required,
    v_handoff.acceptance_criteria,v_key,
    v_task.version,COALESCE(v_job.payload->>'correlation_id',v_task.id::text),'agent'
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

-- ------------------------------------------------------ orchestrator_job_context
--
-- 0080's definition plus one key: the operator's change requests, next to the
-- objective and the acceptance criteria they extend.
CREATE OR REPLACE FUNCTION orchestrator_job_context(p_job_id bigint, p_worker_id text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'control_plane', 'public', 'extensions', 'pg_temp'
AS $function$
DECLARE v_context jsonb; v_snapshot jsonb; v_snapshot_model text;
BEGIN
  SELECT get_task_runtime_snapshot(t.id) INTO v_snapshot
  FROM runtime_jobs j JOIN tasks t ON t.id=j.task_id
  WHERE j.id=p_job_id AND j.job_type IN ('orchestrator_turn','resume_orchestrator');
  IF v_snapshot IS NULL OR v_snapshot->>'source'<>'catalog' THEN
    v_snapshot := '{}'::jsonb;
  END IF;
  v_snapshot_model := v_snapshot->'orchestrator'->>'model_id';

  SELECT jsonb_build_object(
    'job_id',j.id,'job_type',j.job_type,'source_event_id',j.source_event_id,
    'project_id',j.project_id,'task_id',j.task_id,'task_status',t.status,
    'task_version',t.version,'task_title',t.title,'task_objective',t.objective,
    'task_constraints',t.constraints,'task_acceptance_criteria',t.acceptance_criteria,
    'task_operator_change_requests',t.operator_change_requests,
    'followup_of_task_id',t.followup_of_task_id,
    'content',CASE WHEN j.job_type = 'orchestrator_turn'
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
        AND epa.enabled AND role_holds(epa.role_definition_id,'implementation.execute')
      JOIN agents ea ON ea.id=epa.agent_id AND ea.enabled
      JOIN runtime_profiles erp ON erp.id=epa.runtime_profile_id
        AND erp.enabled AND runtime_plays(erp.runtime_type,'executor')
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
    AND pa.enabled AND role_holds(pa.role_definition_id,'conversation.hold')
  JOIN agents a ON a.id=pa.agent_id AND a.enabled
  JOIN runtime_profiles rp ON rp.id=pa.runtime_profile_id
    AND rp.enabled AND runtime_plays(rp.runtime_type,'orchestrator')
  -- 0063: the conversation's chat session for this agent, in this runtime's
  -- namespace. A model change inside the runtime resumes the same native session.
  LEFT JOIN agent_sessions s ON s.conversation_id=t.conversation_id AND s.role='chat'
    AND s.agent_id=a.id AND s.session_namespace=rp.runtime_type AND s.active
  WHERE j.id=p_job_id AND j.job_type IN ('orchestrator_turn','resume_orchestrator')
    AND j.status='in_flight' AND j.leased_by=p_worker_id
    AND j.leased_until>clock_timestamp();
  IF v_context IS NULL THEN
    PERFORM refuse('orchestration_job_not_leased',
      format('Codex orchestration job %s is not actively leased by worker %s',p_job_id,p_worker_id));
  END IF;
  RETURN v_context;
END; $function$;
