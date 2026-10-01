-- Roles are permission sets, contract half (Stage 11.3, sprint B R4; ADR-0017).
--
-- 0079 gave every assignment a role definition; 0080 made the workflow's
-- questions of an assignment ask a permission. What still spoke the two old
-- vocabularies was:
--
--   * four questions asked of an *agent's* own word, `agents.role` —
--     approve_task_review and request_revision (the reviewer), request_implementation
--     and invoke_delegate_task (the implementer). An agent may now do what an
--     enabled assignment of it permits: agent_holds(agent, permission);
--   * the writer, create_project_with_roster, which wrote both words. It now
--     writes the built-in definitions and no agent word;
--   * validate_project_agent_assignment, which matched the agent's word to the
--     assignment's. The runtime check stays; the word check goes;
--   * guard_assignment_role, which asked runtime_plays() by the assignment's
--     word. It asks by the definition's permissions.
--
-- The refusals of the four functions carried forward from before 0067 gain a
-- DETAIL reason from the vocabulary, with their sentence and ERRCODE unchanged.
--
-- `agents.role` loses its CHECK and NOT NULL: it is history, nothing reads it
-- and nothing writes it. `assignment_role` stays, as what it has been since
-- 0079 — a projection of the definition that its trigger keeps, for the
-- one-default index and the assignment's unique key; nothing decides on it, and
-- the trigger still maps a word written by an older writer to its built-in.

SET search_path TO control_plane, public, extensions;

CREATE FUNCTION agent_holds(p_agent_id uuid, p_permission text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=control_plane,public,extensions,pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM project_agent_assignments pa
                 WHERE pa.agent_id=p_agent_id AND pa.enabled
                   AND role_holds(pa.role_definition_id, p_permission));
$$;
REVOKE EXECUTE ON FUNCTION agent_holds(uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION agent_holds(uuid,text) TO infra_worker;

ALTER TABLE agents DROP CONSTRAINT agents_role_check;
ALTER TABLE agents ALTER COLUMN role DROP NOT NULL;

CREATE OR REPLACE FUNCTION validate_project_agent_assignment()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'control_plane', 'public', 'extensions', 'pg_temp'
AS $function$
DECLARE v_agent_runtime text; v_profile_runtime text;
BEGIN
  SELECT base.runtime_type INTO v_agent_runtime
  FROM agents a JOIN runtime_profiles base ON base.id=a.runtime_profile_id
  WHERE a.id=NEW.agent_id AND a.enabled;
  SELECT rp.runtime_type INTO v_profile_runtime FROM runtime_profiles rp
  WHERE rp.id=NEW.runtime_profile_id AND rp.enabled;
  IF v_agent_runtime IS NULL OR v_profile_runtime IS NULL OR v_agent_runtime<>v_profile_runtime THEN
    RAISE EXCEPTION 'agent assignment runtime is incompatible' USING ERRCODE='23514',
      DETAIL=jsonb_build_object('reason','runtime_cannot_play_role')::text;
  END IF;
  RETURN NEW;
END; $function$;

CREATE OR REPLACE FUNCTION guard_assignment_role() RETURNS trigger LANGUAGE plpgsql
SET search_path TO control_plane, public, extensions, pg_temp AS $$
DECLARE v_runtime text;
BEGIN
  IF NOT NEW.enabled THEN RETURN NEW; END IF;
  SELECT runtime_type INTO v_runtime FROM runtime_profiles WHERE id=NEW.runtime_profile_id;
  -- The registry's registration for what the definition holds.
  IF (role_holds(NEW.role_definition_id,'conversation.hold') AND NOT runtime_plays(v_runtime,'orchestrator'))
     OR (role_holds(NEW.role_definition_id,'implementation.execute') AND NOT runtime_plays(v_runtime,'executor')) THEN
    PERFORM refuse('runtime_cannot_play_role',
      format('runtime %s is not registered for what the role holds', COALESCE(v_runtime,'(none)')));
  END IF;
  IF NOT assignment_may(v_runtime, NEW.role_definition_id) THEN
    PERFORM refuse('role_permission_unsupported',
      format('runtime %s lacks a capability the role''s permissions need', COALESCE(v_runtime,'(none)')));
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION approve_task_review(p_project_id uuid, p_task_id uuid, p_actor_id text, p_summary text, p_idempotency_key text, p_expected_version bigint, p_correlation_id text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'control_plane', 'pg_temp'
AS $function$
DECLARE
  v_command commands%ROWTYPE;
  v_task tasks%ROWTYPE;
  v_event domain_events%ROWTYPE;
  v_evidence review_evidence%ROWTYPE;
  v_verdict review_verdicts%ROWTYPE;
  v_preparation publish_preparations%ROWTYPE;
  v_result jsonb;
BEGIN
  IF p_actor_id IS NULL OR p_summary IS NULL
     OR length(trim(p_actor_id)) < 2 OR length(trim(p_summary)) < 3 THEN
    PERFORM refuse('review_approval_invalid', 'review actor and summary are required', '22023');
  END IF;
  v_command := submit_command(
    p_project_id,p_task_id,'ApproveTaskReview','user',p_actor_id,p_idempotency_key,
    jsonb_build_object('summary',p_summary),p_expected_version,p_correlation_id
  );
  IF v_command.status='completed' THEN RETURN v_command.result; END IF;

  SELECT * INTO v_task FROM tasks
  WHERE id=p_task_id AND project_id=p_project_id FOR UPDATE;
  IF NOT FOUND OR v_task.status<>'awaiting_review' OR v_task.version<>p_expected_version THEN
    PERFORM refuse('task_not_reviewable', 'task is not reviewable at the expected version', '40001');
  END IF;
  IF NOT EXISTS(
    SELECT 1 FROM agents a
    WHERE a.id=v_task.active_agent_id AND a.enabled AND agent_holds(a.id,'review.perform')
  ) THEN
    PERFORM refuse('reviewer_unavailable', 'active reviewer is unavailable', '55000');
  END IF;
  SELECT * INTO v_evidence FROM current_review_evidence(p_task_id);
  IF NOT FOUND THEN
    PERFORM refuse('review_evidence_missing',
      format('task %s has no review evidence for its latest implementation; request a revision to record it', p_task_id),
      '55000');
  END IF;

  UPDATE tasks SET status='approved',version=version+1,updated_at=clock_timestamp()
  WHERE id=p_task_id RETURNING * INTO v_task;
  INSERT INTO review_verdicts(project_id, task_id, evidence_id, evidence_digest, verdict, actor_type, actor_id,
    command_id, task_version)
  VALUES (p_project_id, p_task_id, v_evidence.id, v_evidence.evidence_digest, 'approved', 'user', p_actor_id,
    v_command.id, p_expected_version)
  RETURNING * INTO v_verdict;
  v_event:=append_event(
    'review.approved',p_project_id,p_task_id,NULL,'user',p_actor_id,v_command.id,p_correlation_id,
    'review-approved:'||p_idempotency_key,'task',p_task_id,v_task.version,
    jsonb_build_object('summary',p_summary,'reviewer_agent_id',v_task.active_agent_id,
      'evidence_id',v_evidence.id,'evidence_digest',v_evidence.evidence_digest,
      'head_commit_sha',v_evidence.head_commit_sha,'verdict_id',v_verdict.id)
  );
  PERFORM write_audit_event(
    p_project_id,p_task_id,NULL,'user',p_actor_id,'task.review_approved','task',p_task_id::text,
    'allowed',NULL,jsonb_build_object('summary',p_summary,'evidence_digest',v_evidence.evidence_digest),
    p_correlation_id
  );
  -- The approval asks for its own publish preparation, so that the first
  -- recomputation of the digests happens while the reviewed tree is certainly
  -- still there. The operator can ask again before pushing
  -- (request_publish_preparation).
  INSERT INTO publish_preparations(project_id, task_id, verdict_id, evidence_id, evidence_digest,
    requested_by, idempotency_key, correlation_id)
  VALUES (p_project_id, p_task_id, v_verdict.id, v_evidence.id, v_evidence.evidence_digest,
    p_actor_id, 'approval:'||p_idempotency_key, p_correlation_id)
  RETURNING * INTO v_preparation;
  v_result:=jsonb_build_object(
    'status','approved','task_id',p_task_id,'task_version',v_task.version,
    'command_id',v_command.id,'event_id',v_event.id,
    'evidence_digest',v_evidence.evidence_digest,'publish_preparation_id',v_preparation.id
  );
  UPDATE commands SET status='completed',result=v_result,completed_at=clock_timestamp()
  WHERE id=v_command.id;
  RETURN v_result;
END;
$function$;

CREATE OR REPLACE FUNCTION request_revision(p_project_id uuid, p_task_id uuid, p_reviewer_agent_id uuid, p_changes_required jsonb, p_acceptance_criteria jsonb, p_idempotency_key text, p_expected_version bigint, p_correlation_id text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
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

  UPDATE tasks SET status = 'changes_requested', version = version + 1,
    updated_at = clock_timestamp() WHERE id = p_task_id RETURNING * INTO v_task;
  v_change_event := append_event(
    'changes.requested', p_project_id, p_task_id, NULL,
    'agent', p_reviewer_agent_id::text, v_command.id, p_correlation_id,
    'changes:' || p_idempotency_key, 'task', p_task_id, v_task.version,
    jsonb_build_object('previous_handoff_id', v_previous.id, 'changes_required', p_changes_required)
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

CREATE OR REPLACE FUNCTION request_implementation(p_project_id uuid, p_task_id uuid, p_from_agent_id uuid, p_to_agent_id uuid, p_revision_number integer, p_objective text, p_instructions jsonb, p_constraints jsonb, p_acceptance_criteria jsonb, p_relevant_paths jsonb, p_workspace_ref text, p_idempotency_key text, p_expected_version bigint, p_correlation_id text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'control_plane', 'public'
AS $function$
DECLARE
  v_command commands%ROWTYPE;
  v_task tasks%ROWTYPE;
  v_handoff handoffs%ROWTYPE;
  v_event domain_events%ROWTYPE;
  v_payload jsonb;
  v_result jsonb;
BEGIN
  v_payload := jsonb_build_object(
    'task_id', p_task_id,
    'from_agent_id', p_from_agent_id,
    'to_agent_id', p_to_agent_id,
    'revision_number', p_revision_number,
    'objective', p_objective,
    'instructions', p_instructions,
    'constraints', p_constraints,
    'acceptance_criteria', p_acceptance_criteria,
    'relevant_paths', p_relevant_paths,
    'workspace_ref', p_workspace_ref
  );

  v_command := submit_command(
    p_project_id, p_task_id, 'DelegateTask', 'agent', p_from_agent_id::text,
    p_idempotency_key, v_payload, p_expected_version, p_correlation_id
  );

  IF v_command.status = 'completed' THEN
    RETURN v_command.result;
  END IF;

  SELECT * INTO v_task
  FROM tasks t
  WHERE t.id = p_task_id AND t.project_id = p_project_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'task % does not belong to project %', p_task_id, p_project_id
      USING ERRCODE = '23503', DETAIL=jsonb_build_object('reason','task_unavailable')::text;
  END IF;
  IF v_task.version <> p_expected_version THEN
    RAISE EXCEPTION 'stale task version: expected %, actual %', p_expected_version, v_task.version
      USING ERRCODE = '40001', DETAIL=jsonb_build_object('reason','task_version_stale')::text;
  END IF;
  IF v_task.status NOT IN ('ready', 'changes_requested') THEN
    RAISE EXCEPTION 'task % cannot be delegated from state %', p_task_id, v_task.status
      USING ERRCODE = '55000', DETAIL=jsonb_build_object('reason','task_not_delegable')::text;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM agents a
    WHERE a.id = p_to_agent_id AND a.enabled AND agent_holds(a.id,'implementation.execute')
  ) THEN
    RAISE EXCEPTION 'implementer agent % is unavailable', p_to_agent_id
      USING ERRCODE = '55000', DETAIL=jsonb_build_object('reason','executor_unavailable')::text;
  END IF;

  INSERT INTO handoffs (
    task_id, from_agent_id, to_agent_id, revision_number, objective,
    instructions, constraints, acceptance_criteria, relevant_paths, workspace_ref
  ) VALUES (
    p_task_id, p_from_agent_id, p_to_agent_id, p_revision_number, p_objective,
    p_instructions, p_constraints, p_acceptance_criteria, p_relevant_paths, p_workspace_ref
  )
  RETURNING * INTO v_handoff;

  UPDATE tasks
  SET status = 'implementation_requested',
      active_agent_id = p_to_agent_id,
      version = version + 1,
      updated_at = clock_timestamp()
  WHERE id = p_task_id
  RETURNING * INTO v_task;

  v_event := append_event(
    'implementation.requested', p_project_id, p_task_id, NULL,
    'agent', p_from_agent_id::text, v_command.id, p_correlation_id,
    'event:' || p_idempotency_key, 'task', p_task_id, v_task.version,
    jsonb_build_object('handoff_id', v_handoff.id, 'revision_number', p_revision_number)
  );

  v_result := jsonb_build_object(
    'status', 'accepted',
    'command_id', v_command.id,
    'event_id', v_event.id,
    'handoff_id', v_handoff.id,
    'task_id', p_task_id,
    'task_version', v_task.version,
    'idempotency_key', p_idempotency_key
  );

  UPDATE commands
  SET status = 'completed', result = v_result, completed_at = clock_timestamp()
  WHERE id = v_command.id;

  RETURN v_result;
END;
$function$;

CREATE OR REPLACE FUNCTION invoke_delegate_task(p_job_id bigint, p_worker_id text, p_call_id text, p_objective text, p_instructions jsonb, p_relevant_paths jsonb)
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
  IF NOT FOUND OR v_job.job_type <> 'orchestrator_turn' OR v_job.status<>'in_flight'
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
      AND role_holds(pa.role_definition_id,'conversation.hold');
  SELECT pa.* INTO v_executor
  FROM task_executor_assignments tea
  JOIN project_agent_assignments pa ON pa.id=tea.project_agent_assignment_id
  JOIN agents a ON a.id=pa.agent_id AND a.enabled AND agent_holds(a.id,'implementation.execute')
  JOIN runtime_profiles rp ON rp.id=pa.runtime_profile_id
    AND rp.enabled AND runtime_plays(rp.runtime_type,'executor')
  WHERE tea.task_id=v_task.id AND tea.enabled AND pa.enabled
    AND pa.project_id=v_task.project_id AND role_holds(pa.role_definition_id,'implementation.execute')
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

CREATE OR REPLACE FUNCTION create_project_with_roster(p_project_id uuid, p_owner_id uuid, p_name text, p_slug text, p_workspace_path text, p_repository text, p_branch text, p_settings jsonb, p_credential_mode text, p_orchestrator_profile_id uuid, p_executor_profile_ids jsonb, p_actor text, p_correlation text DEFAULT ''::text, p_provider_connection_id uuid DEFAULT NULL::uuid, p_github_repository_id bigint DEFAULT NULL::bigint)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'control_plane', 'public', 'extensions', 'pg_temp'
AS $function$
DECLARE
  -- Scalars rather than a record: with no GitHub selection there is nothing to
  -- assign, and an unassigned record raises on first field reference.
  v_repo_full_name text;
  v_repo_clone_url text;
  v_repo_default_branch text;
  v_repo_archived boolean;
  v_project projects%ROWTYPE;
  v_orchestrator_agent agents%ROWTYPE;
  v_orchestrator_profile runtime_profiles%ROWTYPE;
  v_executor_count integer := 0;
  v_requested uuid[];
BEGIN
  -- Resolve the GitHub selection first: nothing should be created if it is stale.
  IF p_provider_connection_id IS NOT NULL THEN
    SELECT r.full_name, r.clone_url, r.default_branch, r.archived
    INTO v_repo_full_name, v_repo_clone_url, v_repo_default_branch, v_repo_archived
    FROM provider_installation_repositories r
    JOIN provider_connections c ON c.id=r.connection_id
    WHERE r.connection_id=p_provider_connection_id
      AND r.github_repository_id=p_github_repository_id
      AND c.operator_id=p_owner_id
      AND c.provider='github' AND c.status='connected';

    IF NOT FOUND THEN
      RAISE EXCEPTION 'the selected GitHub repository is no longer available to the GitHub App'
        USING ERRCODE='55000', DETAIL=jsonb_build_object('reason','repository_unavailable')::text;
    END IF;
    IF v_repo_archived THEN
      RAISE EXCEPTION 'the selected GitHub repository is archived' USING ERRCODE='55000', DETAIL=jsonb_build_object('reason','repository_unavailable')::text;
    END IF;
  END IF;

  -- The orchestrator runtime must be enabled, verified and a Codex runtime.
  SELECT * INTO v_orchestrator_profile FROM runtime_profiles rp
  WHERE rp.id=p_orchestrator_profile_id
    AND rp.enabled AND rp.last_verified_at IS NOT NULL AND runtime_plays(rp.runtime_type,'orchestrator');
  IF NOT FOUND THEN RETURN NULL; END IF;

  SELECT array_agg(value::uuid) INTO v_requested
  FROM jsonb_array_elements_text(p_executor_profile_ids) AS t(value);
  v_requested := COALESCE(v_requested, ARRAY[]::uuid[]);

  INSERT INTO projects(id,owner_id,name,slug,workspace_path,repository_url,default_branch,
                       status,settings,credential_mode,provider_connection_id,
                       github_repository_id,repository_full_name)
  VALUES (p_project_id,p_owner_id,p_name,p_slug,p_workspace_path,
          COALESCE(v_repo_clone_url, NULLIF(p_repository,'')),
          COALESCE(v_repo_default_branch, p_branch),
          'needs_attention',p_settings,p_credential_mode,
          p_provider_connection_id,p_github_repository_id,v_repo_full_name)
  RETURNING * INTO v_project;

  INSERT INTO agents(name,runtime_profile_id)
  VALUES ('orchestrator-'||v_orchestrator_profile.runtime_type||'-'||v_project.id,
          v_orchestrator_profile.id)
  RETURNING * INTO v_orchestrator_agent;

  INSERT INTO project_agent_assignments(project_id,agent_id,runtime_profile_id,
                                        role_definition_id,is_default)
  VALUES (v_project.id,v_orchestrator_agent.id,v_orchestrator_agent.runtime_profile_id,
          (SELECT id FROM role_definitions WHERE builtin_key='orchestrator'),true);

  WITH executor_profiles AS (
    SELECT rp.*, row_number() OVER(ORDER BY rp.runtime_type,rp.provider_type,rp.model,rp.id) AS ordinal
    FROM runtime_profiles rp
    WHERE rp.id=ANY(v_requested)
      AND rp.enabled AND rp.last_verified_at IS NOT NULL
      AND runtime_plays(rp.runtime_type,'executor')
  ), executor_agents AS (
    INSERT INTO agents(name,runtime_profile_id)
    SELECT 'executor-'||ep.runtime_type||'-'||ep.ordinal||'-'||v_project.id,ep.id
    FROM executor_profiles ep
    RETURNING *
  ), executor_assignments AS (
    INSERT INTO project_agent_assignments(project_id,agent_id,runtime_profile_id,role_definition_id)
    SELECT v_project.id,a.id,a.runtime_profile_id,(SELECT id FROM role_definitions WHERE builtin_key='executor')
    FROM executor_agents a
    RETURNING id
  ) SELECT count(*) INTO v_executor_count FROM executor_assignments;

  INSERT INTO workspace_locks(project_id) VALUES (v_project.id);

  PERFORM append_event('project.created',v_project.id,NULL,NULL,'user',p_actor,NULL,p_correlation,
    'project-created:'||v_project.id,'project',v_project.id,v_project.version,
    jsonb_build_object('name',v_project.name,'slug',v_project.slug,
      'provisioning_status','pending','credential_mode',p_credential_mode,
      'repository_full_name',v_project.repository_full_name,
      'orchestrator_profile_id',p_orchestrator_profile_id,
      'executor_profile_ids',p_executor_profile_ids));

  RETURN jsonb_build_object('project_id',v_project.id,'slug',v_project.slug,
    'status',v_project.status,'workspace_path',v_project.workspace_path,
    'orchestrator_profile_id',p_orchestrator_profile_id,
    'credential_mode',v_project.credential_mode,
    'repository_full_name',v_project.repository_full_name,
    'executor_count',v_executor_count);
END $function$;
