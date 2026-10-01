BEGIN;

SET search_path TO control_plane, public, extensions;

-- Immutable runtime selection snapshots (7.1D.3).
--
-- Project settings define defaults for NEW tasks only. Each task captures an
-- immutable snapshot of its exact runtime tuple (orchestrator + executors:
-- provider/billing boundary, canonical model, reasoning effort, service tier,
-- capabilities, adapter/runtime version and the catalog verification identity
-- and time) at creation. An in-flight task never re-reads live project
-- defaults; changing a project default only affects tasks created after the
-- change.
--
-- Existing projects/tasks are backfilled from their current assignments with
-- source='legacy_backfill' and keep today's behavior (context reads fall back
-- to the assignment/runtime_profiles path when no snapshot exists).
--
-- Snapshot content is compatible with the future 7.2 `launch_snapshot`
-- contract: a bounded JSON document resolved at launch time, never mutated.

CREATE TABLE project_runtime_defaults (
  project_id uuid PRIMARY KEY REFERENCES projects(id),
  orchestrator_entry_id uuid NOT NULL REFERENCES provider_model_catalog(id),
  reasoning_effort text NOT NULL DEFAULT '',
  service_tier text NOT NULL DEFAULT '',
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  updated_by text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE project_runtime_default_executors (
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  catalog_entry_id uuid NOT NULL REFERENCES provider_model_catalog(id),
  priority integer NOT NULL DEFAULT 100 CHECK (priority > 0),
  PRIMARY KEY (project_id, catalog_entry_id)
);

CREATE TABLE task_runtime_snapshots (
  task_id uuid PRIMARY KEY REFERENCES tasks(id),
  orchestrator jsonb NOT NULL
    CHECK (jsonb_typeof(orchestrator) = 'object' AND length(orchestrator::text) <= 8192),
  executors jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(executors) = 'array' AND jsonb_array_length(executors) <= 8
           AND length(executors::text) <= 32768),
  source text NOT NULL CHECK (source IN ('catalog','legacy_backfill')),
  captured_from_defaults_version bigint,
  captured_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX task_runtime_snapshots_captured
  ON task_runtime_snapshots(captured_at);

-- Helper: resolve a catalog entry into the immutable snapshot tuple.
CREATE OR REPLACE FUNCTION resolve_catalog_snapshot_entry(
  p_entry_id uuid, p_reasoning_effort text DEFAULT '', p_service_tier text DEFAULT ''
) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE v_entry provider_model_catalog%ROWTYPE; v_reasoning text; v_tier text;
BEGIN
  SELECT * INTO v_entry FROM provider_model_catalog m
  JOIN provider_connections c ON c.id=m.connection_id
  WHERE m.id=p_entry_id AND m.status='verified' AND c.status='connected';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'catalog entry is not available for selection' USING ERRCODE='55000';
  END IF;
  v_reasoning := '';
  IF p_reasoning_effort <> '' THEN
    IF NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements_text(v_entry.reasoning_efforts) e WHERE e = p_reasoning_effort
    ) THEN
      RAISE EXCEPTION 'reasoning effort is not supported by this model' USING ERRCODE='22023';
    END IF;
    v_reasoning := p_reasoning_effort;
  END IF;
  v_tier := '';
  IF p_service_tier <> '' THEN
    IF NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements_text(v_entry.service_tiers) e WHERE e = p_service_tier
    ) THEN
      RAISE EXCEPTION 'service tier is not supported by this model' USING ERRCODE='22023';
    END IF;
    v_tier := p_service_tier;
  END IF;
  RETURN jsonb_build_object(
    'entry_id',v_entry.id,'connection_id',v_entry.connection_id,
    'runtime_type',v_entry.runtime_type,'provider_id',v_entry.provider_id,
    'model_id',v_entry.model_id,'display_name',v_entry.display_name,
    'provider_badge',v_entry.provider_badge,'plan_badge',v_entry.plan_badge,
    'billing_boundary',v_entry.billing_boundary,
    'reasoning_effort',v_reasoning,'service_tier',v_tier,
    'capabilities',v_entry.capabilities,
    'adapter_version',v_entry.adapter_version,'runtime_version',v_entry.runtime_version,
    'verification_id',v_entry.verification_id,'last_verified_at',v_entry.last_verified_at
  );
END; $$;

CREATE OR REPLACE FUNCTION set_project_runtime_defaults(
  p_project_id uuid, p_owner_id uuid, p_expected_version bigint,
  p_orchestrator_entry_id uuid, p_executor_entry_ids uuid[],
  p_reasoning_effort text DEFAULT '', p_service_tier text DEFAULT '',
  p_actor text DEFAULT '', p_correlation_id text DEFAULT ''
) RETURNS jsonb LANGUAGE plpgsql AS $$
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
  IF NOT FOUND THEN RAISE EXCEPTION 'project is unavailable' USING ERRCODE='55000'; END IF;
  SELECT * INTO v_defaults FROM project_runtime_defaults d
  WHERE d.project_id=p_project_id FOR UPDATE;
  IF p_expected_version<>COALESCE(v_defaults.version,1) THEN
    RAISE EXCEPTION 'project runtime defaults version is stale' USING ERRCODE='40001';
  END IF;
  IF COALESCE(array_length(p_executor_entry_ids,1),0) > 8 THEN
    RAISE EXCEPTION 'too many executor defaults' USING ERRCODE='22023';
  END IF;

  v_orchestrator := resolve_catalog_snapshot_entry(p_orchestrator_entry_id,p_reasoning_effort,p_service_tier);
  IF v_orchestrator->>'runtime_type'<>'codex' THEN
    RAISE EXCEPTION 'orchestrator default must be a Codex model' USING ERRCODE='22023';
  END IF;
  SELECT runtime_type INTO v_runtime FROM provider_model_catalog WHERE id=p_orchestrator_entry_id;
  IF v_runtime<>'codex' THEN
    RAISE EXCEPTION 'orchestrator default must be a Codex model' USING ERRCODE='22023';
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
      IF v_runtime<>'opencode' THEN
        RAISE EXCEPTION 'executor default must be an OpenCode model' USING ERRCODE='22023';
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
END; $$;

-- Immutable capture: the snapshot is written once at task creation and never
-- overwritten, so an in-flight task can never see changed live defaults.
CREATE OR REPLACE FUNCTION capture_task_runtime_snapshot(
  p_task_id uuid, p_project_id uuid
) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE v_defaults project_runtime_defaults%ROWTYPE; v_task tasks%ROWTYPE;
  v_orchestrator jsonb; v_executors jsonb := '[]'::jsonb; v_entry_id uuid;
  v_captured jsonb;
BEGIN
  SELECT * INTO v_task FROM tasks WHERE id=p_task_id AND project_id=p_project_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'task is unavailable' USING ERRCODE='55000'; END IF;
  IF EXISTS (SELECT 1 FROM task_runtime_snapshots WHERE task_id=p_task_id) THEN
    RETURN jsonb_build_object('task_id',p_task_id,'status','already_captured');
  END IF;
  SELECT * INTO v_defaults FROM project_runtime_defaults
  WHERE project_id=p_project_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('task_id',p_task_id,'status','skipped_no_defaults');
  END IF;

  v_orchestrator := resolve_catalog_snapshot_entry(
    v_defaults.orchestrator_entry_id,v_defaults.reasoning_effort,v_defaults.service_tier);
  FOR v_entry_id IN
    SELECT d.catalog_entry_id FROM project_runtime_default_executors d
    WHERE d.project_id=p_project_id ORDER BY d.priority,d.catalog_entry_id
  LOOP
    -- Provenance: bind the snapshot executor entry to the project agent
    -- assignments whose legacy runtime profile matches this catalog entry, so
    -- a task with multiple executors resolves the model of the exact executor
    -- assignment that owns the current handoff.
    v_executors := v_executors || jsonb_build_array(
      resolve_catalog_snapshot_entry(v_entry_id) || jsonb_build_object(
        'assignment_ids',COALESCE((
          SELECT jsonb_agg(pa.id::text)
          FROM project_agent_assignments pa
          JOIN runtime_profiles rp ON rp.id=pa.runtime_profile_id
          WHERE pa.project_id=p_project_id AND pa.enabled
            AND pa.assignment_role='executor'
            AND rp.model=(
              SELECT model_id FROM provider_model_catalog WHERE id=v_entry_id
            )
            AND rp.runtime_type='opencode'
        ),'[]'::jsonb)
      )
    );
  END LOOP;

  INSERT INTO task_runtime_snapshots(task_id,orchestrator,executors,source,captured_from_defaults_version)
  VALUES(p_task_id,v_orchestrator,v_executors,'catalog',v_defaults.version)
  RETURNING jsonb_build_object(
    'task_id',task_id,'orchestrator',orchestrator,'executors',executors,
    'source',source,'captured_from_defaults_version',captured_from_defaults_version
  ) INTO v_captured;
  RETURN v_captured;
END; $$;

CREATE OR REPLACE FUNCTION get_task_runtime_snapshot(
  p_task_id uuid
) RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT COALESCE((
    SELECT jsonb_build_object(
      'task_id',task_id,'orchestrator',orchestrator,'executors',executors,
      'source',source,'captured_from_defaults_version',captured_from_defaults_version,
      'captured_at',captured_at
    ) FROM task_runtime_snapshots WHERE task_id=p_task_id
  ),'null'::jsonb);
$$;

CREATE OR REPLACE FUNCTION get_project_runtime_defaults(
  p_project_id uuid, p_owner_id uuid
) RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT COALESCE((
    SELECT jsonb_build_object(
      'project_id',d.project_id,'version',d.version,
      'reasoning_effort',d.reasoning_effort,'service_tier',d.service_tier,
      'orchestrator',resolve_catalog_snapshot_entry(d.orchestrator_entry_id,
        d.reasoning_effort,d.service_tier),
      'executors',COALESCE((
        SELECT jsonb_agg(resolve_catalog_snapshot_entry(e.catalog_entry_id)
          ORDER BY e.priority,e.catalog_entry_id)
        FROM project_runtime_default_executors e WHERE e.project_id=d.project_id
      ),'[]'::jsonb)
    )
    FROM project_runtime_defaults d JOIN projects p ON p.id=d.project_id
    WHERE d.project_id=p_project_id AND p.owner_id=p_owner_id
  ),'null'::jsonb);
$$;

-- Backfill existing projects/tasks from current assignments without changing
-- their behavior: source='legacy_backfill', no catalog verification identity.
CREATE OR REPLACE FUNCTION backfill_legacy_runtime_snapshots()
RETURNS integer LANGUAGE plpgsql AS $$
DECLARE v_count integer := 0; v_task record; v_orchestrator jsonb; v_executors jsonb; v_rows integer;
BEGIN
  FOR v_task IN
    SELECT t.id AS task_id,t.project_id,pa.runtime_profile_id AS orchestrator_profile_id,
      rp.model AS orchestrator_model,rp.provider_type AS orchestrator_provider,
      rp.runtime_version AS orchestrator_runtime_version,
      rp.adapter_version AS orchestrator_adapter_version
    FROM tasks t
    JOIN project_agent_assignments pa ON pa.id=t.orchestrator_assignment_id
      AND pa.enabled AND pa.assignment_role='orchestrator'
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
      AND pa.enabled AND pa.assignment_role='executor'
    JOIN runtime_profiles rp ON rp.id=pa.runtime_profile_id AND rp.enabled
    WHERE tea.task_id=v_task.task_id AND tea.enabled;
    INSERT INTO task_runtime_snapshots(task_id,orchestrator,executors,source)
    VALUES(v_task.task_id,v_orchestrator,v_executors,'legacy_backfill')
    ON CONFLICT (task_id) DO NOTHING;
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    v_count := v_count + v_rows;
  END LOOP;
  RETURN v_count;
END; $$;

ALTER FUNCTION resolve_catalog_snapshot_entry(uuid,text,text)
  SET search_path=control_plane,public,extensions,pg_temp;
ALTER FUNCTION set_project_runtime_defaults(uuid,uuid,bigint,uuid,uuid[],text,text,text,text)
  SET search_path=control_plane,public,extensions,pg_temp;
ALTER FUNCTION capture_task_runtime_snapshot(uuid,uuid)
  SET search_path=control_plane,public,extensions,pg_temp;
ALTER FUNCTION get_task_runtime_snapshot(uuid)
  SET search_path=control_plane,public,extensions,pg_temp;
ALTER FUNCTION get_project_runtime_defaults(uuid,uuid)
  SET search_path=control_plane,public,extensions,pg_temp;
ALTER FUNCTION backfill_legacy_runtime_snapshots()
  SET search_path=control_plane,public,extensions,pg_temp;

-- Control-plane integration: orchestrator chat turns and executor launches
-- resolve the model from the immutable task snapshot when one exists, falling
-- back to the legacy assignment/runtime_profiles path for backfilled tasks.
-- An in-flight task therefore never reads changed live defaults.

CREATE OR REPLACE FUNCTION codex_chat_job_context(p_job_id bigint,p_worker_id text)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE v_context jsonb; v_snapshot jsonb; v_snapshot_model text;
BEGIN
  SELECT get_task_runtime_snapshot(t.id) INTO v_snapshot
  FROM runtime_jobs j JOIN tasks t ON t.id=j.task_id
  WHERE j.id=p_job_id AND j.job_type IN ('codex_chat_turn','resume_codex');
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
    'content',CASE WHEN j.job_type='codex_chat_turn'
      THEN j.payload#>>'{event_payload,content}'
      ELSE concat(
        'A durable ',j.payload->>'event_type',' event is ready for review. ',
        'Inspect the implementation in the read-only workspace. ',
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
  LEFT JOIN agent_sessions s ON s.project_id=j.project_id AND s.agent_id=a.id
    AND s.runtime_profile_id=rp.id AND s.purpose='task_chat:' || j.task_id::text AND s.active
  WHERE j.id=p_job_id AND j.job_type IN ('codex_chat_turn','resume_codex')
    AND j.status='in_flight' AND j.leased_by=p_worker_id
    AND j.leased_until>clock_timestamp();
  IF v_context IS NULL THEN
    RAISE EXCEPTION 'Codex orchestration job % is not actively leased by worker %',p_job_id,p_worker_id
      USING ERRCODE='55000';
  END IF;
  RETURN v_context;
END; $$;

CREATE OR REPLACE FUNCTION executor_job_context(p_job_id bigint,p_worker_id text)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
  v_context jsonb; v_session agent_sessions%ROWTYPE; v_snapshot jsonb;
  v_task_snapshot jsonb; v_snapshot_model text; v_snapshot_runtime text;
BEGIN
  SELECT get_task_runtime_snapshot(t.id) INTO v_task_snapshot
  FROM runtime_jobs j JOIN tasks t ON t.id=j.task_id
  WHERE j.id=p_job_id AND j.job_type='start_implementation';
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
    WHERE j.id=p_job_id AND j.job_type='start_implementation';
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
        RAISE EXCEPTION 'task runtime snapshot does not match the executor assignment' USING ERRCODE='55000';
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
  LEFT JOIN agent_sessions s ON s.project_id=j.project_id AND s.agent_id=pa.agent_id
    AND s.runtime_profile_id=rp.id AND s.purpose='task_executor:' || j.task_id::text AND s.active
  WHERE j.id=p_job_id AND j.job_type='start_implementation' AND j.status='in_flight'
    AND j.leased_by=p_worker_id AND j.leased_until>clock_timestamp();

  IF v_session.id IS NULL THEN
    INSERT INTO agent_sessions(project_id,agent_id,runtime_profile_id,purpose,status,active,metadata)
    SELECT j.project_id,pa.agent_id,pa.runtime_profile_id,'task_executor:' || j.task_id::text,
      'active',true,jsonb_build_object('task_id',j.task_id,'executor_assignment_id',pa.id)
    FROM runtime_jobs j
    JOIN domain_events e ON e.id=j.source_event_id AND e.event_type='implementation.requested'
    JOIN handoffs h ON h.id=(e.payload->>'handoff_id')::uuid
    JOIN project_agent_assignments pa ON pa.id=h.executor_assignment_id
      AND pa.project_id=j.project_id AND pa.agent_id=h.to_agent_id
      AND pa.assignment_role='executor' AND pa.enabled
    JOIN task_executor_assignments tea ON tea.task_id=j.task_id
      AND tea.project_agent_assignment_id=pa.id AND tea.enabled
    JOIN runtime_profiles rp ON rp.id=pa.runtime_profile_id AND rp.enabled AND rp.runtime_type='opencode'
    WHERE j.id=p_job_id AND j.job_type='start_implementation' AND j.status='in_flight'
      AND j.leased_by=p_worker_id AND j.leased_until>clock_timestamp()
    ON CONFLICT(project_id,agent_id,purpose) WHERE active DO UPDATE
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
  WHERE j.id=p_job_id AND j.job_type='start_implementation' AND j.status='in_flight'
    AND j.leased_by=p_worker_id AND j.leased_until>clock_timestamp();
  IF v_context IS NULL THEN
    RAISE EXCEPTION 'executor job % is not actively leased or assigned',p_job_id USING ERRCODE='55000';
  END IF;
  RETURN v_context;
END; $$;

-- New tasks created through the follow-up path capture their own immutable
-- snapshot from the project defaults.
CREATE OR REPLACE FUNCTION create_followup_task(
  p_project_id uuid,
  p_source_task_id uuid,
  p_new_task_id uuid,
  p_actor_id text,
  p_title text,
  p_objective text,
  p_idempotency_key text,
  p_expected_version bigint,
  p_correlation_id text
)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
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
    RAISE EXCEPTION 'invalid follow-up task arguments' USING ERRCODE='22023';
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
    RAISE EXCEPTION 'source task is not terminal at the expected version' USING ERRCODE='40001';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM project_agent_assignments pa
    JOIN agents a ON a.id=pa.agent_id AND a.enabled
    JOIN runtime_profiles rp ON rp.id=pa.runtime_profile_id AND rp.enabled
    WHERE pa.id=v_source.orchestrator_assignment_id AND pa.project_id=p_project_id
      AND pa.enabled AND pa.assignment_role='orchestrator' AND rp.runtime_type='codex'
  ) THEN
    RAISE EXCEPTION 'source task orchestrator is unavailable' USING ERRCODE='55000';
  END IF;

  INSERT INTO tasks(
    id,project_id,title,objective,constraints,acceptance_criteria,status,
    active_agent_id,orchestrator_assignment_id,created_by,followup_of_task_id
  ) VALUES (
    p_new_task_id,p_project_id,trim(p_title),trim(p_objective),
    v_source.constraints,v_source.acceptance_criteria,'planning',
    v_source.active_agent_id,v_source.orchestrator_assignment_id,p_actor_id,p_source_task_id
  ) RETURNING * INTO v_created;

  v_snapshot := capture_task_runtime_snapshot(v_created.id,p_project_id);

  INSERT INTO task_executor_assignments(task_id,project_agent_assignment_id,priority,enabled)
  SELECT v_created.id,tea.project_agent_assignment_id,tea.priority,tea.enabled
  FROM task_executor_assignments tea
  JOIN project_agent_assignments pa ON pa.id=tea.project_agent_assignment_id
    AND pa.project_id=p_project_id AND pa.enabled AND pa.assignment_role='executor'
  WHERE tea.task_id=p_source_task_id AND tea.enabled;
  GET DIAGNOSTICS v_executor_count=ROW_COUNT;

  INSERT INTO agent_sessions(
    project_id,agent_id,runtime_profile_id,native_session_id,purpose,status,
    active,last_resumed_at,metadata
  )
  SELECT s.project_id,s.agent_id,s.runtime_profile_id,s.native_session_id,
    CASE
      WHEN s.purpose='task_chat:'||p_source_task_id::text THEN 'task_chat:'||v_created.id::text
      ELSE 'task_executor:'||v_created.id::text
    END,
    'active',true,s.last_resumed_at,
    s.metadata||jsonb_build_object('task_id',v_created.id,'followup_of_task_id',p_source_task_id,
      'continued_from_session_id',s.id)
  FROM agent_sessions s
  WHERE s.project_id=p_project_id AND s.active AND s.native_session_id IS NOT NULL
    AND s.purpose IN ('task_chat:'||p_source_task_id::text,'task_executor:'||p_source_task_id::text)
  ON CONFLICT(project_id,agent_id,purpose) WHERE active DO NOTHING;
  GET DIAGNOSTICS v_session_count=ROW_COUNT;

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
$$;

ALTER FUNCTION codex_chat_job_context(bigint,text)
  SET search_path=control_plane,public,extensions,pg_temp;
ALTER FUNCTION executor_job_context(bigint,text)
  SET search_path=control_plane,public,extensions,pg_temp;
ALTER FUNCTION create_followup_task(uuid,uuid,uuid,text,text,text,text,bigint,text)
  SET search_path=control_plane,public,extensions,pg_temp;

-- Authorized launch resolution for the Runtime Supervisor: the model is
-- resolved from the immutable task snapshot when one exists, falling back to
-- the legacy assignment/runtime_profiles path. The snapshot executor entry is
-- bound to the exact project agent assignment owning this job's handoff, so a
-- task with multiple executors never launches the right agent with the wrong
-- model. A catalog snapshot whose provenance does not cover the handoff
-- assignment resolves to a fail-closed marker (`snapshot_mismatch:true`), so
-- the supervisor never launches with an arbitrary model. The generic
-- first-executor fallback applies only to fully legacy provenance-free
-- snapshots. The supervisor never accepts an arbitrary model override from
-- the web or workers.
CREATE OR REPLACE FUNCTION resolve_executor_launch_model(
  p_job_id bigint
) RETURNS jsonb LANGUAGE sql STABLE AS $$
  WITH task AS (
    SELECT t.id AS task_id,get_task_runtime_snapshot(t.id) AS snapshot
    FROM runtime_jobs j JOIN tasks t ON t.id=j.task_id
    WHERE j.id=p_job_id AND j.job_type='start_implementation'
  ), handoff_assignment AS (
    SELECT h.executor_assignment_id AS assignment_id
    FROM runtime_jobs j
    JOIN domain_events e ON e.id=j.source_event_id AND e.event_type='implementation.requested'
    JOIN handoffs h ON h.id=(e.payload->>'handoff_id')::uuid
    WHERE j.id=p_job_id AND j.job_type='start_implementation'
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
    WHERE j.id=p_job_id AND j.job_type='start_implementation'
  ),'null'::jsonb);
$$;

ALTER FUNCTION resolve_executor_launch_model(bigint)
  SET search_path=control_plane,public,extensions,pg_temp;

COMMIT;
