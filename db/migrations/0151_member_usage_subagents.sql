-- M7 (rc.141): the analysts' tokens, a stop for a question, and each member's
-- own subagents.
--
-- * An analyst's run now writes its activity under its job (the supervisor),
--   so the usage trigger counts its tokens into run_usage like any run's;
--   finish_consultation names the row's analyst (run_usage.analyst_id) and
--   model, and get_task_usage lists the analysts a chat asked beside the
--   orchestrator and executors.
-- * The owner may stop a question while the analyst reads
--   (request_consultation_stop); the consultation worker sees it and cancels
--   the run, and the orchestrator is told the question was stopped.
-- * A runtime's own subagents — Claude Code's Task tool, Codex's multi_agent,
--   OpenCode's task — are each member's to allow: an executor's assignment
--   config `allow_subagents`, an analyst's column. Off unless allowed.

SET search_path TO control_plane, public, extensions;

ALTER TABLE project_analysts ADD COLUMN allow_subagents boolean NOT NULL DEFAULT false;
ALTER TABLE consultations ADD COLUMN stop_requested_at timestamptz, ADD COLUMN stop_requested_by text;
ALTER TABLE run_usage ADD COLUMN analyst_id uuid;
CREATE INDEX run_usage_analyst ON run_usage(analyst_id) WHERE analyst_id IS NOT NULL;

INSERT INTO failure_reasons(reason, code, note) VALUES
  ('team_member_unavailable','not_found','no executor or analyst of this project has that id'),
  ('consultation_not_running','conflict','that question is not waiting for an answer')
ON CONFLICT (reason) DO NOTHING;

-- The Team page's switch: a runtime's own subagents for one executor or analyst.
CREATE FUNCTION set_project_member_subagents(p_project_id uuid, p_owner_id uuid, p_expected_version bigint,
  p_member_id uuid, p_enabled boolean, p_actor text, p_correlation_id text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO control_plane, public, extensions, pg_temp
AS $$
DECLARE v_version bigint; v_kind text;
BEGIN
  PERFORM lock_project_team(p_project_id, p_owner_id, p_expected_version);
  UPDATE project_agent_assignments SET config=config || jsonb_build_object('allow_subagents', COALESCE(p_enabled,false)),
    updated_at=clock_timestamp()
  WHERE id=p_member_id AND project_id=p_project_id AND enabled AND role_holds(role_definition_id,'implementation.execute');
  IF FOUND THEN v_kind := 'executor';
  ELSE
    UPDATE project_analysts SET allow_subagents=COALESCE(p_enabled,false), updated_at=clock_timestamp()
    WHERE id=p_member_id AND project_id=p_project_id AND enabled;
    IF FOUND THEN v_kind := 'analyst'; END IF;
  END IF;
  IF v_kind IS NULL THEN
    PERFORM refuse('team_member_unavailable', format('no executor or analyst %s in project %s', p_member_id, p_project_id));
  END IF;
  v_version := bump_project_team(p_project_id, p_owner_id, p_actor, p_correlation_id, 'subagents_set',
    jsonb_build_object('member_id',p_member_id,'kind',v_kind,'allow_subagents',COALESCE(p_enabled,false)));
  RETURN jsonb_build_object('project_id',p_project_id,'member_id',p_member_id,'kind',v_kind,
    'allow_subagents',COALESCE(p_enabled,false),'version',v_version,'status','changed');
END $$;

-- What the Team page shows beside each executor and analyst.
CREATE FUNCTION project_member_subagents(p_project_id uuid, p_owner_id uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO control_plane, public, extensions, pg_temp
AS $$
  SELECT COALESCE(jsonb_object_agg(member.id, member.allowed), '{}'::jsonb) FROM (
    SELECT pa.id, COALESCE((pa.config->>'allow_subagents')::boolean, false) AS allowed
    FROM project_agent_assignments pa JOIN projects p ON p.id=pa.project_id
    WHERE pa.project_id=p_project_id AND p.owner_id=p_owner_id AND pa.enabled
      AND role_holds(pa.role_definition_id,'implementation.execute')
    UNION ALL
    SELECT a.id, a.allow_subagents FROM project_analysts a JOIN projects p ON p.id=a.project_id
    WHERE a.project_id=p_project_id AND p.owner_id=p_owner_id AND a.enabled) member;
$$;

-- The owner stops a question the analyst is still reading.
CREATE FUNCTION request_consultation_stop(p_project_id uuid, p_owner_id uuid, p_consultation_id uuid, p_actor text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO control_plane, public, extensions, pg_temp
AS $$
BEGIN
  UPDATE consultations c SET stop_requested_at=COALESCE(c.stop_requested_at, clock_timestamp()),
    stop_requested_by=COALESCE(c.stop_requested_by, left(p_actor,200))
  FROM projects p
  WHERE c.id=p_consultation_id AND c.project_id=p_project_id AND p.id=c.project_id AND p.owner_id=p_owner_id
    AND c.status='requested';
  IF NOT FOUND THEN
    PERFORM refuse('consultation_not_running', format('question %s is not waiting for an answer', p_consultation_id));
  END IF;
  RETURN jsonb_build_object('consultation_id',p_consultation_id,'status','stop_requested');
END $$;

-- For the consultation worker, while the run goes: whether the owner stopped it.
CREATE FUNCTION consultation_stop_requested(p_job_id bigint, p_worker_id text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO control_plane, public, extensions, pg_temp
AS $$
  SELECT COALESCE((SELECT c.stop_requested_at IS NOT NULL FROM runtime_jobs j
    JOIN consultations c ON c.id=(j.payload#>>'{event_payload,consultation_id}')::uuid
    WHERE j.id=p_job_id AND j.job_type='consultation_run' AND j.leased_by=p_worker_id), false);
$$;

CREATE OR REPLACE FUNCTION consultation_job_context(p_job_id bigint, p_worker_id text)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path TO control_plane, public, extensions, pg_temp
AS $$
DECLARE v_context jsonb;
BEGIN
  SELECT jsonb_build_object('job_id',j.id,'attempt_count',j.attempt_count,'consultation_id',c.id,
      'project_id',c.project_id,'task_id',c.task_id,'task_title',t.title,
      'workspace_path',p.workspace_path,'question',c.question,'status',c.status,
      'analyst',a.name,'instructions',a.instructions,'runtime_type',a.runtime_type,
      'provider_id',m.provider_id,'model',m.model_id,'model_display',COALESCE(m.display_name,m.model_id),
      'model_status',m.status,'reasoning_effort',NULLIF(a.reasoning_effort,''),'analyst_enabled',a.enabled,
      -- The repository map's layout (0146), so the analyst starts from it.
      'layout',(SELECT left(rm.map->>'tree', 8000) FROM project_repository_maps rm WHERE rm.project_id=c.project_id),
      -- 0151: the analyst's own subagents, and a stop the owner asked for.
      'allow_subagents',a.allow_subagents,'stop_requested',c.stop_requested_at IS NOT NULL)
    INTO v_context
  FROM runtime_jobs j
  JOIN consultations c ON c.id=(j.payload#>>'{event_payload,consultation_id}')::uuid
  JOIN project_analysts a ON a.id=c.analyst_id
  JOIN projects p ON p.id=c.project_id
  JOIN tasks t ON t.id=c.task_id
  LEFT JOIN provider_model_catalog m ON m.id=a.catalog_entry_id
  WHERE j.id=p_job_id AND j.job_type='consultation_run' AND j.status='in_flight'
    AND j.leased_by=p_worker_id AND j.leased_until>clock_timestamp();
  IF v_context IS NULL THEN
    PERFORM refuse('consultation_not_held', format('consultation job %s is not leased by %s', p_job_id, p_worker_id));
  END IF;
  RETURN v_context;
END $$;

CREATE OR REPLACE FUNCTION finish_consultation(p_job_id bigint, p_worker_id text, p_result jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO control_plane, public, extensions, pg_temp
AS $$
DECLARE v_job runtime_jobs%ROWTYPE; v_consultation consultations%ROWTYPE; v_analyst project_analysts%ROWTYPE;
  v_answered boolean := p_result->>'status' = 'answered' AND btrim(COALESCE(p_result->>'answer','')) <> '';
  v_answer text := left(COALESCE(p_result->>'answer',''), 32000);
BEGIN
  SELECT * INTO v_job FROM runtime_jobs WHERE id=p_job_id FOR UPDATE;
  IF NOT FOUND OR v_job.job_type<>'consultation_run' OR v_job.status<>'in_flight' OR v_job.leased_by<>p_worker_id THEN
    PERFORM refuse('consultation_not_held', format('consultation job %s is not leased by %s', p_job_id, p_worker_id));
  END IF;
  SELECT * INTO v_consultation FROM consultations
  WHERE id=(v_job.payload#>>'{event_payload,consultation_id}')::uuid FOR UPDATE;
  SELECT * INTO v_analyst FROM project_analysts WHERE id=v_consultation.analyst_id;
  IF v_consultation.status <> 'requested' THEN
    UPDATE runtime_jobs SET status='completed', completed_at=clock_timestamp(), leased_by=NULL, leased_until=NULL WHERE id=p_job_id;
    RETURN jsonb_build_object('status',v_consultation.status);
  END IF;
  UPDATE consultations SET status=CASE WHEN v_answered THEN 'answered' ELSE 'failed' END,
    answer=CASE WHEN v_answered THEN v_answer END,
    failure=CASE WHEN v_answered THEN NULL ELSE left(COALESCE(NULLIF(p_result->>'failure',''),'the analyst gave no answer'),500) END,
    model=left(NULLIF(p_result->>'model',''),200), snapshot_sha=left(NULLIF(p_result->>'snapshot_sha',''),64),
    finished_at=clock_timestamp()
  WHERE id=v_consultation.id RETURNING * INTO v_consultation;
  -- 0151: the run's tokens, counted from its activity under the job, are the
  -- analyst's: named here, with the model it ran.
  UPDATE run_usage u SET analyst_id=v_analyst.id,
    model=COALESCE(NULLIF(u.model,''), left(COALESCE(v_consultation.model,
      (SELECT m.model_id FROM provider_model_catalog m WHERE m.id=v_analyst.catalog_entry_id), ''),200)),
    finished_at=COALESCE(u.finished_at, clock_timestamp())
  WHERE u.job_id=p_job_id AND u.kind='run';
  -- Ended either way: a question nobody answered is told to the orchestrator,
  -- not left as a dead letter for the operator to retry.
  UPDATE runtime_jobs SET status='completed', completed_at=clock_timestamp(), leased_by=NULL, leased_until=NULL,
    activity_phase='finalizing',
    activity_detail=CASE WHEN v_answered THEN 'The analyst answered' ELSE left('The analyst did not answer: '||v_consultation.failure,500) END,
    last_error=CASE WHEN v_answered THEN NULL ELSE v_consultation.failure END
  WHERE id=p_job_id;
  PERFORM append_event(CASE WHEN v_answered THEN 'consultation.answered' ELSE 'consultation.failed' END,
    v_consultation.project_id, v_consultation.task_id, NULL, 'agent', 'analyst:'||v_analyst.name, NULL,
    COALESCE(v_job.payload->>'correlation_id', v_consultation.task_id::text),
    'event:consultation-finished:'||v_consultation.id, 'consultation', v_consultation.id, 2,
    jsonb_build_object('consultation_id',v_consultation.id,'analyst',v_analyst.name,'runtime_type',v_analyst.runtime_type,
      'model',v_consultation.model,'question',v_consultation.question,'answer',v_consultation.answer,
      'failure',v_consultation.failure,'snapshot_sha',v_consultation.snapshot_sha));
  RETURN jsonb_build_object('status',v_consultation.status,'consultation_id',v_consultation.id);
END $$;

CREATE OR REPLACE FUNCTION get_task_usage(p_project_id uuid, p_task_id uuid, p_owner_id uuid)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path TO control_plane, public, extensions, pg_temp
AS $$
DECLARE v_task tasks%ROWTYPE; v_lineage uuid[]; v_rows run_usage[]; v_members jsonb; v_connections jsonb;
BEGIN
  SELECT t.* INTO v_task FROM tasks t JOIN projects p ON p.id = t.project_id
  WHERE t.id = p_task_id AND t.project_id = p_project_id AND p.owner_id = p_owner_id;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT array_agg(m.id) INTO v_lineage FROM tasks m
  WHERE m.id = v_task.id OR (v_task.conversation_id IS NOT NULL AND m.conversation_id = v_task.conversation_id);
  v_rows := ARRAY(SELECT u FROM run_usage u WHERE u.kind = 'run' AND u.task_id = ANY(v_lineage));

  WITH team AS (
    SELECT DISTINCT a.id FROM tasks t JOIN project_agent_assignments a ON a.id = t.orchestrator_assignment_id
    WHERE t.id = ANY(v_lineage)
    UNION SELECT tea.project_agent_assignment_id FROM task_executor_assignments tea
    WHERE tea.task_id = ANY(v_lineage) AND tea.enabled
    UNION SELECT u.assignment_id FROM unnest(v_rows) u WHERE u.assignment_id IS NOT NULL
  ), member AS (
    SELECT a.id AS assignment_id, ag.name AS agent_name, rp.runtime_type, rd.builtin_key AS role_key,
      a.id = v_task.orchestrator_assignment_id AS is_orchestrator, a.created_at,
      ARRAY(SELECT u FROM unnest(v_rows) u WHERE u.assignment_id = a.id) AS rows
    FROM team JOIN project_agent_assignments a ON a.id = team.id
    JOIN agents ag ON ag.id = a.agent_id
    JOIN runtime_profiles rp ON rp.id = a.runtime_profile_id
    LEFT JOIN role_definitions rd ON rd.id = a.role_definition_id
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'assignment_id', m.assignment_id, 'agent_name', m.agent_name, 'runtime_type', m.runtime_type,
      'role_key', COALESCE(m.role_key, CASE WHEN m.is_orchestrator THEN 'orchestrator' ELSE 'executor' END),
      -- What its last run ran on.
      'model', NULLIF((SELECT u.model FROM unnest(m.rows) u ORDER BY u.started_at DESC, u.id DESC LIMIT 1), ''),
      'reasoning_effort', (SELECT u.reasoning_effort FROM unnest(m.rows) u ORDER BY u.started_at DESC, u.id DESC LIMIT 1),
      'connection_id', (SELECT u.connection_id FROM unnest(m.rows) u ORDER BY u.started_at DESC, u.id DESC LIMIT 1),
      'running', EXISTS (SELECT 1 FROM unnest(m.rows) u JOIN runtime_jobs j ON j.id = u.job_id
                         WHERE u.finished_at IS NULL AND j.status = 'in_flight'),
      'usage', usage_totals(m.rows))
    ORDER BY m.is_orchestrator DESC, m.created_at, m.assignment_id), '[]'::jsonb)
  INTO v_members FROM member m;
  -- 0151: the analysts this chat asked, each with its own tokens.
  v_members := v_members || COALESCE((SELECT jsonb_agg(jsonb_build_object(
      'assignment_id', a.id, 'agent_name', a.name, 'runtime_type', a.runtime_type, 'role_key', 'analyst',
      'model', NULLIF((SELECT u.model FROM unnest(v_rows) u WHERE u.analyst_id = a.id ORDER BY u.started_at DESC, u.id DESC LIMIT 1), ''),
      'reasoning_effort', NULLIF(a.reasoning_effort, ''),
      'connection_id', (SELECT u.connection_id FROM unnest(v_rows) u WHERE u.analyst_id = a.id ORDER BY u.started_at DESC, u.id DESC LIMIT 1),
      'running', EXISTS (SELECT 1 FROM consultations c JOIN runtime_jobs j ON j.job_type='consultation_run'
                         AND j.payload#>>'{event_payload,consultation_id}' = c.id::text
                         WHERE c.analyst_id = a.id AND c.task_id = ANY(v_lineage) AND j.status = 'in_flight'),
      'usage', usage_totals(ARRAY(SELECT u FROM unnest(v_rows) u WHERE u.analyst_id = a.id)))
    ORDER BY a.created_at)
    FROM project_analysts a
    WHERE a.id IN (SELECT c.analyst_id FROM consultations c WHERE c.task_id = ANY(v_lineage))), '[]'::jsonb);

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'connection_id', c.id, 'label', usage_connection_label(c.access_gateway, c.provider),
      'gateway', c.access_gateway, 'runtime_type', c.provider,
      'limits_mode', usage_limits_mode(c.access_gateway), 'limits', latest_usage_reading(c.id))
    ORDER BY c.provider, c.access_gateway), '[]'::jsonb)
  INTO v_connections
  FROM provider_connections c
  WHERE c.operator_id = p_owner_id AND c.id IN (SELECT u.connection_id FROM unnest(v_rows) u);

  RETURN jsonb_build_object(
    'task_id', v_task.id, 'generated_at', clock_timestamp(),
    'active', EXISTS (SELECT 1 FROM runtime_jobs j WHERE j.task_id = ANY(v_lineage) AND j.status = 'in_flight'),
    'totals', usage_totals(v_rows),
    'members', v_members,
    'connections', v_connections);
END $$;

REVOKE ALL ON FUNCTION set_project_member_subagents(uuid,uuid,bigint,uuid,boolean,text,text), project_member_subagents(uuid,uuid),
  request_consultation_stop(uuid,uuid,uuid,text), consultation_stop_requested(bigint,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION set_project_member_subagents(uuid,uuid,bigint,uuid,boolean,text,text), project_member_subagents(uuid,uuid),
  request_consultation_stop(uuid,uuid,uuid,text) TO infra_web;
GRANT EXECUTE ON FUNCTION consultation_stop_requested(bigint,text) TO infra_worker;
