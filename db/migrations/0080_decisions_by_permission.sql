-- Decisions by permission (Stage 11.3, sprint B R3; ADR-0017).
--
-- 0079 gave every assignment a role definition and kept the word beside it.
-- The workflow functions still decided on the word — a message went to the
-- assignment whose `assignment_role` was 'orchestrator', an implementation to
-- 'executor', a review was approved by an agent whose `agents.role` was
-- 'architect' or 'reviewer'. Each of those questions now asks the permission
-- instead, for every question asked of an assignment:
--
--   * who holds the conversation, routes a message, delegates → conversation.hold;
--   * who implements, and whose model an implementation runs → implementation.execute.
--
-- The 13 functions (14 definitions: capture_task_runtime_snapshot has two
-- overloads) are their effective definitions with only those comparisons
-- replaced — generated from a migrated database, nothing else in them moved.
-- Three refusals carried forward from before 0067 gain a DETAIL reason, with
-- their sentence and ERRCODE unchanged.
-- `runtime_plays()` stays beside them: it asks whether the runtime is
-- registered for the role, which a permission does not replace.
--
-- Not here, and R4's (0081):
--   * the questions asked of an *agent's* own word, `agents.role` —
--     approve_task_review, request_revision, request_implementation and
--     invoke_delegate_task's join. They go with that column's CHECK, and the
--     oldest db/tests fixtures, which make agents with no assignment at all, move
--     to assignments then;
--   * the writer that still writes the words (create_project_with_roster);
--   * the two guards that keep the words and the definitions in step
--     (validate_project_agent_assignment, fill_assignment_role_definition).

SET search_path TO control_plane, public, extensions;

-- Refusals carried forward from before 0067 gain a reason, as 0073's did.
INSERT INTO failure_reasons(reason, code, note) VALUES
  ('task_unavailable','conflict','the task is missing, or is not in the project named');

CREATE FUNCTION role_holds(p_role_definition_id uuid, p_permission text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=control_plane,public,extensions,pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM role_permissions
                 WHERE role_definition_id=p_role_definition_id AND permission=p_permission);
$$;
-- As runtime_plays (0074): the worker's functions run as the worker; the
-- panel's are SECURITY DEFINER and run as their owner.
REVOKE EXECUTE ON FUNCTION role_holds(uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION role_holds(uuid,text) TO infra_worker;

CREATE OR REPLACE FUNCTION backfill_legacy_runtime_snapshots()
 RETURNS integer
 LANGUAGE plpgsql
 SET search_path TO 'control_plane', 'public', 'extensions', 'pg_temp'
AS $function$
DECLARE v_count integer := 0; v_task record; v_orchestrator jsonb; v_executors jsonb; v_rows integer;
BEGIN
  FOR v_task IN
    SELECT t.id AS task_id,t.project_id,pa.runtime_profile_id AS orchestrator_profile_id,
      rp.model AS orchestrator_model,rp.provider_type AS orchestrator_provider,
      rp.runtime_version AS orchestrator_runtime_version,
      rp.adapter_version AS orchestrator_adapter_version
    FROM tasks t
    JOIN project_agent_assignments pa ON pa.id=t.orchestrator_assignment_id
      AND pa.enabled AND role_holds(pa.role_definition_id,'conversation.hold')
    JOIN runtime_profiles rp ON rp.id=pa.runtime_profile_id AND rp.enabled
    WHERE NOT EXISTS (SELECT 1 FROM task_runtime_snapshots s WHERE s.task_id=t.id)
  LOOP
    v_orchestrator := jsonb_build_object(
      'runtime_type','codex','provider_id',v_task.orchestrator_provider,
      'model_id',v_task.orchestrator_model,
      'adapter_version',v_task.orchestrator_adapter_version,
      'runtime_version',v_task.orchestrator_runtime_version
    );
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'runtime_type',rp.runtime_type,'provider_id',rp.provider_type,'model_id',rp.model,
      'adapter_version',rp.adapter_version,'runtime_version',rp.runtime_version)
      ORDER BY tea.priority),'[]'::jsonb) INTO v_executors
    FROM task_executor_assignments tea
    JOIN project_agent_assignments pa ON pa.id=tea.project_agent_assignment_id
      AND pa.enabled AND role_holds(pa.role_definition_id,'implementation.execute')
    JOIN runtime_profiles rp ON rp.id=pa.runtime_profile_id AND rp.enabled
    WHERE tea.task_id=v_task.task_id AND tea.enabled;
    INSERT INTO task_runtime_snapshots(task_id,orchestrator,executors,source)
    VALUES(v_task.task_id,v_orchestrator,v_executors,'legacy_backfill')
    ON CONFLICT (task_id) DO NOTHING;
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    v_count := v_count + v_rows;
  END LOOP;
  RETURN v_count;
END; $function$;

CREATE OR REPLACE FUNCTION bind_orchestrator_session(p_job_id bigint, p_worker_id text, p_native_session_id text)
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
  IF NOT FOUND OR v_job.job_type NOT IN ('orchestrator_turn','resume_orchestrator')
     OR v_job.status<>'in_flight' OR v_job.leased_by<>p_worker_id
     OR v_job.leased_until<=clock_timestamp() THEN
    RAISE EXCEPTION 'Codex orchestration job is not actively leased' USING ERRCODE='55000', DETAIL=jsonb_build_object('reason','orchestration_job_not_leased')::text;
  END IF;
  SELECT * INTO v_task FROM tasks t WHERE t.id=v_job.task_id;
  SELECT * INTO v_assignment FROM project_agent_assignments pa
  WHERE pa.id=v_task.orchestrator_assignment_id AND pa.enabled
    AND role_holds(pa.role_definition_id,'conversation.hold');
  IF NOT FOUND OR NOT EXISTS(
    SELECT 1 FROM agents a JOIN runtime_profiles rp ON rp.id=v_assignment.runtime_profile_id
    WHERE a.id=v_assignment.agent_id AND a.enabled AND rp.enabled AND runtime_plays(rp.runtime_type,'orchestrator')
  ) THEN RAISE EXCEPTION 'task orchestrator is not an enabled runtime that plays the orchestrator' USING ERRCODE='55000', DETAIL=jsonb_build_object('reason','orchestrator_unavailable')::text; END IF;
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

CREATE OR REPLACE FUNCTION capture_task_runtime_snapshot(p_task_id uuid, p_project_id uuid)
 RETURNS jsonb
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'control_plane', 'public', 'extensions', 'pg_temp'
AS $function$
  SELECT capture_task_runtime_snapshot($1,$2,NULL::uuid[]);
$function$;

CREATE OR REPLACE FUNCTION capture_task_runtime_snapshot(p_task_id uuid, p_project_id uuid, p_executor_assignment_ids uuid[])
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'control_plane', 'public', 'extensions', 'pg_temp'
AS $function$
DECLARE
  v_defaults project_runtime_defaults%ROWTYPE;
  v_task tasks%ROWTYPE;
  v_orchestrator jsonb;
  v_executors jsonb := '[]'::jsonb;
  v_entry_id uuid;
  v_assignment_id uuid;
  v_captured jsonb;
  v_required text[];
BEGIN
  SELECT * INTO v_task FROM tasks
  WHERE id=p_task_id AND project_id=p_project_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'task is unavailable' USING ERRCODE='55000', DETAIL=jsonb_build_object('reason','task_unavailable')::text;
  END IF;
  IF EXISTS (SELECT 1 FROM task_runtime_snapshots WHERE task_id=p_task_id) THEN
    RETURN jsonb_build_object('task_id',p_task_id,'status','already_captured');
  END IF;

  SELECT * INTO v_defaults FROM project_runtime_defaults
  WHERE project_id=p_project_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('task_id',p_task_id,'status','skipped_no_defaults');
  END IF;

  v_orchestrator := resolve_catalog_snapshot_entry(
    v_defaults.orchestrator_entry_id,
    v_defaults.reasoning_effort,
    v_defaults.service_tier
  );

  IF p_executor_assignment_ids IS NOT NULL AND EXISTS (
    SELECT 1
    FROM unnest(p_executor_assignment_ids) requested(id)
    WHERE NOT EXISTS (
      SELECT 1 FROM project_agent_assignments pa
      WHERE pa.id=requested.id AND pa.project_id=p_project_id
        AND pa.enabled AND role_holds(pa.role_definition_id,'implementation.execute')
    )
  ) THEN
    RAISE EXCEPTION 'task executor assignment is unavailable' USING ERRCODE='55000', DETAIL=jsonb_build_object('reason','executor_unavailable')::text;
  END IF;

  FOR v_entry_id, v_assignment_id IN
    WITH all_assignments AS (
      SELECT pa.id,
        row_number() OVER (ORDER BY pa.created_at,pa.id) AS ordinal
      FROM project_agent_assignments pa
      WHERE pa.project_id=p_project_id
        AND pa.enabled
        AND role_holds(pa.role_definition_id,'implementation.execute')
    ), selected_assignments AS (
      SELECT requested.id AS assignment_id,aa.ordinal,
        requested.ordinality * 100 AS priority
      FROM unnest(p_executor_assignment_ids) WITH ORDINALITY requested(id,ordinality)
      JOIN all_assignments aa ON aa.id=requested.id
    ), effective_assignments AS (
      SELECT s.assignment_id,s.ordinal,s.priority
      FROM selected_assignments s
      UNION ALL
      SELECT aa.id,aa.ordinal,aa.ordinal * 100
      FROM all_assignments aa
      WHERE p_executor_assignment_ids IS NULL
    ), defaults AS (
      SELECT d.catalog_entry_id,
        row_number() OVER (ORDER BY d.priority,d.catalog_entry_id) AS ordinal
      FROM project_runtime_default_executors d
      WHERE d.project_id=p_project_id
    )
    SELECT d.catalog_entry_id,e.assignment_id
    FROM defaults d
    LEFT JOIN effective_assignments e ON e.ordinal=d.ordinal
    WHERE e.assignment_id IS NOT NULL
       OR NOT EXISTS (SELECT 1 FROM all_assignments)
    ORDER BY d.ordinal,e.priority NULLS LAST
  LOOP
    v_executors := v_executors || jsonb_build_array(
      resolve_catalog_snapshot_entry(v_entry_id) || jsonb_build_object(
        'assignment_ids',CASE WHEN v_assignment_id IS NULL
          THEN '[]'::jsonb ELSE jsonb_build_array(v_assignment_id::text) END
      )
    );
  END LOOP;

  -- The runtimes this task has just been bound to, asked of the host before the
  -- binding is written. Read from the snapshot being captured rather than from
  -- the project's defaults, so what is checked is what will actually be launched.
  SELECT array_agg(DISTINCT runtime_type) INTO v_required
  FROM (
    SELECT v_orchestrator->>'runtime_type' AS runtime_type
    UNION ALL
    SELECT executor->>'runtime_type' FROM jsonb_array_elements(v_executors) AS executor
  ) AS required
  WHERE runtime_type IS NOT NULL AND runtime_type<>'';

  PERFORM assert_runtimes_dispatchable(v_required);

  INSERT INTO task_runtime_snapshots(
    task_id,orchestrator,executors,source,captured_from_defaults_version
  )
  VALUES(p_task_id,v_orchestrator,v_executors,'catalog',v_defaults.version)
  RETURNING jsonb_build_object(
    'task_id',task_id,'orchestrator',orchestrator,'executors',executors,
    'source',source,'captured_from_defaults_version',captured_from_defaults_version
  ) INTO v_captured;
  RETURN v_captured;
END; $function$;

CREATE OR REPLACE FUNCTION create_followup_task(p_project_id uuid, p_source_task_id uuid, p_new_task_id uuid, p_actor_id text, p_title text, p_objective text, p_idempotency_key text, p_expected_version bigint, p_correlation_id text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'control_plane', 'public', 'extensions', 'pg_temp'
AS $function$
DECLARE
  v_command commands%ROWTYPE;
  v_source tasks%ROWTYPE;
  v_created tasks%ROWTYPE;
  v_event domain_events%ROWTYPE;
  v_audit uuid;
  v_executor_count integer;
  v_session_count integer;
  v_snapshot jsonb;
  v_result jsonb;
BEGIN
  IF p_new_task_id IS NULL OR length(trim(p_actor_id))=0
     OR length(trim(p_title))<2 OR length(p_title)>120
     OR length(trim(p_objective))<2 OR length(p_objective)>12000 THEN
    RAISE EXCEPTION 'invalid follow-up task arguments' USING ERRCODE='22023', DETAIL=jsonb_build_object('reason','followup_arguments_invalid')::text;
  END IF;

  v_command:=submit_command(
    p_project_id,p_source_task_id,'CreateFollowupTask','user',p_actor_id,
    p_idempotency_key,
    jsonb_build_object('source_task_id',p_source_task_id,'title',p_title,'objective',p_objective),
    p_expected_version,p_correlation_id
  );
  IF v_command.status='completed' THEN RETURN v_command.result; END IF;

  SELECT * INTO v_source FROM tasks t
  WHERE t.id=p_source_task_id AND t.project_id=p_project_id FOR UPDATE;
  IF NOT FOUND OR v_source.version<>p_expected_version
     OR v_source.status NOT IN ('approved','completed','deployed') THEN
    RAISE EXCEPTION 'source task is not terminal at the expected version' USING ERRCODE='40001', DETAIL=jsonb_build_object('reason','task_version_stale')::text;
  END IF;
  -- 0063: a conversation is linear. The unique index refuses a second
  -- follow-up of one task in any case; this says so in words first.
  IF EXISTS (SELECT 1 FROM tasks f WHERE f.followup_of_task_id=p_source_task_id) THEN
    RAISE EXCEPTION 'this task already has a follow-up; continue from the latest task of the conversation'
      USING ERRCODE='55000', DETAIL='followup_exists';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM project_agent_assignments pa
    JOIN agents a ON a.id=pa.agent_id AND a.enabled
    JOIN runtime_profiles rp ON rp.id=pa.runtime_profile_id AND rp.enabled
    WHERE pa.id=v_source.orchestrator_assignment_id AND pa.project_id=p_project_id
      AND pa.enabled AND role_holds(pa.role_definition_id,'conversation.hold') AND runtime_plays(rp.runtime_type,'orchestrator')
  ) THEN
    RAISE EXCEPTION 'source task orchestrator is unavailable' USING ERRCODE='55000', DETAIL=jsonb_build_object('reason','orchestrator_unavailable')::text;
  END IF;

  INSERT INTO tasks(
    id,project_id,title,objective,constraints,acceptance_criteria,status,
    active_agent_id,orchestrator_assignment_id,created_by,followup_of_task_id
  ) VALUES (
    p_new_task_id,p_project_id,trim(p_title),trim(p_objective),
    v_source.constraints,v_source.acceptance_criteria,'planning',
    v_source.active_agent_id,v_source.orchestrator_assignment_id,p_actor_id,p_source_task_id
  ) RETURNING * INTO v_created;

  INSERT INTO task_executor_assignments(task_id,project_agent_assignment_id,priority,enabled)
  SELECT v_created.id,tea.project_agent_assignment_id,tea.priority,tea.enabled
  FROM task_executor_assignments tea
  JOIN project_agent_assignments pa ON pa.id=tea.project_agent_assignment_id
    AND pa.project_id=p_project_id AND pa.enabled AND role_holds(pa.role_definition_id,'implementation.execute')
  WHERE tea.task_id=p_source_task_id AND tea.enabled;
  GET DIAGNOSTICS v_executor_count=ROW_COUNT;

  v_snapshot := capture_task_runtime_snapshot(
    v_created.id,p_project_id,
    COALESCE(
      (SELECT array_agg(tea.project_agent_assignment_id ORDER BY tea.priority,tea.created_at)
       FROM task_executor_assignments tea
       WHERE tea.task_id=v_created.id AND tea.enabled),
      ARRAY[]::uuid[]
    )
  );

  -- 0063: nothing is copied. The follow-up belongs to the source's conversation
  -- (the tasks trigger set it), and the conversation's sessions are found by
  -- conversation, role and agent. What the event and audit report as continued
  -- is the number of sessions the new task will resume.
  SELECT count(*) INTO v_session_count FROM agent_sessions s
  WHERE s.conversation_id=v_created.conversation_id AND s.active AND s.native_session_id IS NOT NULL;

  v_event:=append_event(
    'chat.user_message',p_project_id,v_created.id,NULL,'user',p_actor_id,
    v_command.id,p_correlation_id,'followup-message:'||p_idempotency_key,
    'task',v_created.id,v_created.version,
    jsonb_build_object(
      'content',v_created.objective,'title',v_created.title,
      'followup_of_task_id',p_source_task_id,
      'orchestrator_assignment_id',v_created.orchestrator_assignment_id,
      'executor_assignment_ids',COALESCE((
        SELECT jsonb_agg(tea.project_agent_assignment_id ORDER BY tea.priority,tea.created_at)
        FROM task_executor_assignments tea WHERE tea.task_id=v_created.id AND tea.enabled
      ),'[]'::jsonb),
      'continued_session_count',v_session_count,
      'snapshot_source',v_snapshot->>'source'
    )
  );
  v_audit:=write_audit_event(
    p_project_id,v_created.id,NULL,'operator',p_actor_id,'task.followup_created',
    'task',v_created.id::text,'allowed',NULL,
    jsonb_build_object('source_task_id',p_source_task_id,'source_status',v_source.status,
      'source_version',v_source.version,'executor_count',v_executor_count,
      'continued_session_count',v_session_count,'command_id',v_command.id,
      'snapshot_source',v_snapshot->>'source'),p_correlation_id
  );
  v_result:=jsonb_build_object(
    'status','planning','project_id',p_project_id,'task_id',v_created.id,
    'task_version',v_created.version,'followup_of_task_id',p_source_task_id,
    'event_id',v_event.id,'audit_event_id',v_audit,
    'executor_count',v_executor_count,'continued_session_count',v_session_count,
    'snapshot_source',v_snapshot->>'source'
  );
  UPDATE commands SET status='completed',result=v_result,completed_at=clock_timestamp()
    WHERE id=v_command.id;
  RETURN v_result;
END;
$function$;

CREATE OR REPLACE FUNCTION create_task_with_executors(p_project_id uuid, p_task_id uuid, p_title text, p_objective text, p_actor text, p_correlation text DEFAULT ''::text, p_orchestrator_assignment_id uuid DEFAULT NULL::uuid, p_executor_assignment_ids jsonb DEFAULT '[]'::jsonb, p_executor_selection_explicit boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'control_plane', 'public', 'extensions', 'pg_temp'
AS $function$
DECLARE
  v_orchestrator project_agent_assignments%ROWTYPE;
  v_task tasks%ROWTYPE;
  v_requested uuid[];
  v_selected uuid[];
  v_selected_count integer;
  v_snapshot jsonb;
BEGIN
  SELECT array_agg(DISTINCT value::uuid) INTO v_requested
  FROM jsonb_array_elements_text(p_executor_assignment_ids) AS t(value);
  v_requested := COALESCE(v_requested, ARRAY[]::uuid[]);

  SELECT pa.* INTO v_orchestrator
  FROM project_agent_assignments pa
  JOIN agents a ON a.id=pa.agent_id AND a.enabled
  JOIN runtime_profiles rp ON rp.id=pa.runtime_profile_id
    AND rp.enabled AND rp.last_verified_at IS NOT NULL
  WHERE pa.project_id=p_project_id AND pa.enabled
    AND role_holds(pa.role_definition_id,'conversation.hold') AND runtime_plays(rp.runtime_type,'orchestrator')
    AND (p_orchestrator_assignment_id IS NULL OR pa.id=p_orchestrator_assignment_id)
  ORDER BY pa.is_default DESC, pa.created_at
  LIMIT 1;

  IF NOT FOUND THEN RETURN NULL; END IF;

  -- Ordering is the priority source, so it is captured once into an array and
  -- reused; a temp table would break on a second call within one transaction.
  SELECT array_agg(pa.id ORDER BY pa.created_at, pa.id) INTO v_selected
  FROM project_agent_assignments pa
  WHERE pa.project_id=p_project_id AND pa.enabled AND role_holds(pa.role_definition_id,'implementation.execute')
    AND (NOT p_executor_selection_explicit OR pa.id=ANY(v_requested));

  v_selected := COALESCE(v_selected, ARRAY[]::uuid[]);
  v_selected_count := cardinality(v_selected);

  IF v_selected_count=0 THEN
    RAISE EXCEPTION 'this project has no enabled executor assignment' USING ERRCODE='55000', DETAIL=jsonb_build_object('reason','executor_unavailable')::text;
  END IF;
  IF p_executor_selection_explicit AND v_selected_count<>cardinality(v_requested) THEN
    RAISE EXCEPTION 'one or more selected executors are unavailable' USING ERRCODE='55000', DETAIL=jsonb_build_object('reason','executor_unavailable')::text;
  END IF;

  INSERT INTO tasks(id,project_id,title,objective,status,active_agent_id,
                    orchestrator_assignment_id,created_by)
  VALUES (p_task_id,p_project_id,p_title,p_objective,'planning',
          v_orchestrator.agent_id,v_orchestrator.id,p_actor)
  RETURNING * INTO v_task;

  INSERT INTO task_executor_assignments(task_id,project_agent_assignment_id,priority)
  SELECT v_task.id, e.id, (e.ord*100)::integer
  FROM unnest(v_selected) WITH ORDINALITY AS e(id, ord);

  v_snapshot := capture_task_runtime_snapshot(v_task.id, v_task.project_id, v_selected);

  PERFORM append_event('chat.user_message',v_task.project_id,v_task.id,NULL,'user',p_actor,
    NULL,p_correlation,'chat-message:'||v_task.id||':1','task',v_task.id,v_task.version,
    jsonb_build_object('content',v_task.objective,'title',v_task.title,
      'orchestrator_assignment_id',v_task.orchestrator_assignment_id,
      'executor_assignment_ids',to_jsonb(v_selected),
      'snapshot_source',COALESCE(v_snapshot->>'source','')));

  RETURN jsonb_build_object('project_id',v_task.project_id,'task_id',v_task.id,
    'status',v_task.status,'version',v_task.version,
    'orchestrator_assignment_id',v_task.orchestrator_assignment_id,
    'executor_count',v_selected_count,
    'snapshot_source',COALESCE(v_snapshot->>'source',''));
END $function$;

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
  WHERE j.id=p_job_id AND j.job_type = 'implementation_run';
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
    WHERE j.id=p_job_id AND j.job_type = 'implementation_run';
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
    AND role_holds(pa.role_definition_id,'implementation.execute') AND pa.enabled
  JOIN task_executor_assignments tea ON tea.task_id=j.task_id
    AND tea.project_agent_assignment_id=pa.id AND tea.enabled
  JOIN runtime_profiles rp ON rp.id=pa.runtime_profile_id AND rp.enabled AND runtime_plays(rp.runtime_type,'executor')
  JOIN tasks session_task ON session_task.id=j.task_id
  -- 0063: the conversation's executor session for this agent (ADR-0014).
  LEFT JOIN agent_sessions s ON s.conversation_id=session_task.conversation_id AND s.role='executor'
    AND s.agent_id=pa.agent_id AND s.session_namespace=rp.runtime_type AND s.active
  WHERE j.id=p_job_id AND j.job_type = 'implementation_run' AND j.status='in_flight'
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
    WHERE j.id=p_job_id AND j.job_type = 'implementation_run' AND j.status='in_flight'
      AND j.leased_by=p_worker_id AND j.leased_until>clock_timestamp()
      AND s.conversation_id=session_task.conversation_id AND s.role='executor'
      AND s.agent_id=h.to_agent_id AND s.active AND s.session_namespace IS DISTINCT FROM (
        SELECT xrp.runtime_type FROM project_agent_assignments xpa
        JOIN runtime_profiles xrp ON xrp.id=xpa.runtime_profile_id WHERE xpa.id=h.executor_assignment_id);
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
      AND role_holds(pa.role_definition_id,'implementation.execute') AND pa.enabled
    JOIN task_executor_assignments tea ON tea.task_id=j.task_id
      AND tea.project_agent_assignment_id=pa.id AND tea.enabled
    JOIN runtime_profiles rp ON rp.id=pa.runtime_profile_id AND rp.enabled AND runtime_plays(rp.runtime_type,'executor')
    WHERE j.id=p_job_id AND j.job_type = 'implementation_run' AND j.status='in_flight'
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
    AND role_holds(pa.role_definition_id,'implementation.execute') AND pa.enabled
  JOIN task_executor_assignments tea ON tea.task_id=j.task_id
    AND tea.project_agent_assignment_id=pa.id AND tea.enabled
  JOIN agents a ON a.id=pa.agent_id AND a.enabled
  JOIN runtime_profiles rp ON rp.id=pa.runtime_profile_id AND rp.enabled AND runtime_plays(rp.runtime_type,'executor')
  WHERE j.id=p_job_id AND j.job_type = 'implementation_run' AND j.status='in_flight'
    AND j.leased_by=p_worker_id AND j.leased_until>clock_timestamp();
  IF v_context IS NULL THEN
    RAISE EXCEPTION 'executor job % is not actively leased or assigned',p_job_id USING ERRCODE='55000', DETAIL=jsonb_build_object('reason','job_not_in_flight')::text;
  END IF;
  RETURN v_context;
END; $function$;

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
  JOIN agents a ON a.id=pa.agent_id AND a.enabled AND a.role='implementer'
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

CREATE OR REPLACE FUNCTION resolve_executor_launch_model(p_job_id bigint)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET search_path TO 'control_plane', 'public', 'extensions', 'pg_temp'
AS $function$
  WITH task AS (
    SELECT t.id AS task_id,get_task_runtime_snapshot(t.id) AS snapshot
    FROM runtime_jobs j JOIN tasks t ON t.id=j.task_id
    WHERE j.id=p_job_id AND j.job_type = 'implementation_run'
  ), handoff_assignment AS (
    SELECT h.executor_assignment_id AS assignment_id
    FROM runtime_jobs j
    JOIN domain_events e ON e.id=j.source_event_id AND e.event_type='implementation.requested'
    JOIN handoffs h ON h.id=(e.payload->>'handoff_id')::uuid
    WHERE j.id=p_job_id AND j.job_type = 'implementation_run'
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
      AND role_holds(pa.role_definition_id,'implementation.execute') AND pa.enabled
    JOIN task_executor_assignments tea ON tea.task_id=j.task_id
      AND tea.project_agent_assignment_id=pa.id AND tea.enabled
    JOIN runtime_profiles rp ON rp.id=pa.runtime_profile_id AND rp.enabled AND runtime_plays(rp.runtime_type,'executor')
    WHERE j.id=p_job_id AND j.job_type = 'implementation_run'
  ),'null'::jsonb);
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
        AND pa.enabled AND role_holds(pa.role_definition_id,'conversation.hold')
      JOIN agents a ON a.id=pa.agent_id AND a.enabled
      JOIN runtime_profiles rp ON rp.id=pa.runtime_profile_id AND rp.enabled
      WHERE t.id=v_event.task_id AND runtime_plays(rp.runtime_type,'orchestrator')
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

CREATE OR REPLACE FUNCTION set_project_runtime_defaults(p_project_id uuid, p_owner_id uuid, p_expected_version bigint, p_orchestrator_entry_id uuid, p_executor_entry_ids uuid[], p_reasoning_effort text DEFAULT ''::text, p_service_tier text DEFAULT ''::text, p_actor text DEFAULT ''::text, p_correlation_id text DEFAULT ''::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'control_plane', 'public', 'extensions', 'pg_temp'
AS $function$
DECLARE
  v_project projects%ROWTYPE;
  v_defaults project_runtime_defaults%ROWTYPE;
  v_orchestrator jsonb;
  v_entry_id uuid;
  v_priority integer;
  v_runtime text;
  v_executor_count integer;
BEGIN
  SELECT * INTO v_project FROM projects p
  WHERE p.id=p_project_id AND p.owner_id=p_owner_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'project is unavailable' USING ERRCODE='55000', DETAIL=jsonb_build_object('reason','project_unavailable')::text; END IF;
  SELECT * INTO v_defaults FROM project_runtime_defaults d
  WHERE d.project_id=p_project_id FOR UPDATE;
  IF p_expected_version<>COALESCE(v_defaults.version,1) THEN
    RAISE EXCEPTION 'project runtime defaults version is stale' USING ERRCODE='40001', DETAIL=jsonb_build_object('reason','runtime_defaults_version_stale')::text;
  END IF;
  IF COALESCE(array_length(p_executor_entry_ids,1),0) > 8 THEN
    RAISE EXCEPTION 'too many executor defaults' USING ERRCODE='22023', DETAIL=jsonb_build_object('reason','runtime_defaults_invalid')::text;
  END IF;

  v_orchestrator := resolve_catalog_snapshot_entry(p_orchestrator_entry_id,p_reasoning_effort,p_service_tier);
  IF NOT runtime_plays(v_orchestrator->>'runtime_type','orchestrator') THEN
    RAISE EXCEPTION 'orchestrator default must be a model of a runtime that plays the orchestrator' USING ERRCODE='22023', DETAIL=jsonb_build_object('reason','runtime_cannot_play_role')::text;
  END IF;
  SELECT runtime_type INTO v_runtime FROM provider_model_catalog WHERE id=p_orchestrator_entry_id;
  IF NOT runtime_plays(v_runtime,'orchestrator') THEN
    RAISE EXCEPTION 'orchestrator default must be a model of a runtime that plays the orchestrator' USING ERRCODE='22023', DETAIL=jsonb_build_object('reason','runtime_cannot_play_role')::text;
  END IF;
  -- The project's orchestrator assignment runs the turn, on its profile's
  -- runtime; a default of another runtime's model would hand it that model.
  IF EXISTS (SELECT 1 FROM project_agent_assignments pa
             WHERE pa.project_id=p_project_id AND role_holds(pa.role_definition_id,'conversation.hold') AND pa.enabled)
     AND NOT EXISTS (SELECT 1 FROM project_agent_assignments pa JOIN runtime_profiles rp ON rp.id=pa.runtime_profile_id
                 WHERE pa.project_id=p_project_id AND role_holds(pa.role_definition_id,'conversation.hold') AND pa.enabled
                   AND rp.runtime_type=v_runtime) THEN
    RAISE EXCEPTION 'orchestrator default must be a model of the runtime the project''s orchestrator runs on' USING ERRCODE='22023', DETAIL=jsonb_build_object('reason','runtime_default_not_assigned')::text;
  END IF;

  INSERT INTO project_runtime_defaults(project_id,orchestrator_entry_id,reasoning_effort,service_tier,updated_by)
  VALUES(p_project_id,p_orchestrator_entry_id,p_reasoning_effort,p_service_tier,p_actor)
  ON CONFLICT (project_id) DO UPDATE SET
    orchestrator_entry_id=EXCLUDED.orchestrator_entry_id,
    reasoning_effort=EXCLUDED.reasoning_effort,
    service_tier=EXCLUDED.service_tier,
    updated_by=EXCLUDED.updated_by,
    version=project_runtime_defaults.version+1,
    updated_at=clock_timestamp()
  RETURNING * INTO v_defaults;

  DELETE FROM project_runtime_default_executors WHERE project_id=p_project_id;
  v_executor_count := 0;
  IF p_executor_entry_ids IS NOT NULL THEN
    FOR v_entry_id, v_priority IN
      SELECT t.id, row_number() OVER () * 100
      FROM unnest(p_executor_entry_ids) WITH ORDINALITY AS t(id,ordinality)
      ORDER BY t.ordinality
    LOOP
      SELECT runtime_type INTO v_runtime FROM provider_model_catalog WHERE id=v_entry_id;
      IF NOT runtime_plays(v_runtime,'executor') THEN
        RAISE EXCEPTION 'executor default must be a model of a runtime that plays the executor' USING ERRCODE='22023', DETAIL=jsonb_build_object('reason','runtime_cannot_play_role')::text;
      END IF;
      IF EXISTS (SELECT 1 FROM project_agent_assignments pa
                 WHERE pa.project_id=p_project_id AND role_holds(pa.role_definition_id,'implementation.execute') AND pa.enabled)
         AND NOT EXISTS (SELECT 1 FROM project_agent_assignments pa JOIN runtime_profiles rp ON rp.id=pa.runtime_profile_id
                     WHERE pa.project_id=p_project_id AND role_holds(pa.role_definition_id,'implementation.execute') AND pa.enabled
                       AND rp.runtime_type=v_runtime) THEN
        RAISE EXCEPTION 'executor default must be a model of a runtime the project''s executors run on' USING ERRCODE='22023', DETAIL=jsonb_build_object('reason','runtime_default_not_assigned')::text;
      END IF;
      PERFORM resolve_catalog_snapshot_entry(v_entry_id);
      INSERT INTO project_runtime_default_executors(project_id,catalog_entry_id,priority)
      VALUES(p_project_id,v_entry_id,v_priority);
      v_executor_count := v_executor_count + 1;
    END LOOP;
  END IF;

  PERFORM write_audit_event(NULL,NULL,NULL,'operator',COALESCE(NULLIF(p_actor,''),p_owner_id::text),
    'project.runtime_defaults_updated','project',p_project_id::text,'allowed',NULL,
    jsonb_build_object('orchestrator_entry_id',p_orchestrator_entry_id,
      'executor_entry_ids',p_executor_entry_ids,'reasoning_effort',p_reasoning_effort,
      'service_tier',p_service_tier,'version',v_defaults.version),
    COALESCE(NULLIF(p_correlation_id,''),p_project_id::text));
  RETURN jsonb_build_object(
    'project_id',p_project_id,'status','saved','version',v_defaults.version,
    'orchestrator_entry_id',v_defaults.orchestrator_entry_id,
    'executor_count',v_executor_count
  );
END; $function$;

CREATE OR REPLACE FUNCTION validate_task_executor_assignment()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'control_plane', 'public', 'extensions', 'pg_temp'
AS $function$
BEGIN
  IF NOT EXISTS(
    SELECT 1 FROM tasks t JOIN project_agent_assignments pa
      ON pa.id=NEW.project_agent_assignment_id
    WHERE t.id=NEW.task_id AND pa.project_id=t.project_id
      AND role_holds(pa.role_definition_id,'implementation.execute') AND pa.enabled
  ) THEN
    RAISE EXCEPTION 'task executor is not enabled for this project' USING ERRCODE='23514', DETAIL=jsonb_build_object('reason','executor_unavailable')::text;
  END IF;
  RETURN NEW;
END; $function$;
