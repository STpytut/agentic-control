-- A reasoning level per team member (Stage 12; the owner's decision: the level
-- is chosen next to the model, for the orchestrator and for each executor, in
-- Create project, the project's runtime defaults and the Team tab).
--
-- Where the level lives:
--
--   project_runtime_defaults.reasoning_effort (0028)  the orchestrator's; it
--                                  existed, validated against the model, and
--                                  was captured into each task's snapshot.
--   project_runtime_default_executors.reasoning_effort  new: each executor's,
--                                  beside the model it runs, by the same
--                                  position the model has.
--   task_runtime_snapshots        each member's level, as captured (0028 already
--                                  carried the key; executors now get theirs).
--   runtime_job_selections.reasoning_effort  new: the level the launch sent,
--                                  recorded where the model is (0071).
--
-- '' is "send nothing — the runtime's default", as it has been for the
-- orchestrator since 0028; the panel shows it as "Default" and the API as null.
-- A level is always one the model lists (provider_model_catalog.reasoning_efforts,
-- filled by 0110): a runtime told a level it does not know either ignores it
-- silently (OpenCode's --variant) or, for Codex, was not confirmed to refuse it,
-- so the database is where an unsupported level stops.
--
-- When the list moves under a saved level — a model changed, a refresh that no
-- longer lists it, a Claude alias that now resolves to another model — nothing
-- fails: a model change without a level keeps the old level only if the new
-- model lists it and otherwise resets it and says so in its result; a task
-- captured after the list moved runs at the default and its snapshot names the
-- level it dropped. Saving a level the model does not list is refused.

SET search_path TO control_plane, public, extensions;

INSERT INTO failure_reasons(reason, code, note) VALUES
  ('reasoning_effort_unsupported','invalid_argument','the model does not offer that reasoning level; pick one it lists, or the runtime default');

ALTER TABLE project_runtime_default_executors
  ADD COLUMN reasoning_effort text NOT NULL DEFAULT '' CHECK (length(reasoning_effort) <= 64);

ALTER TABLE runtime_job_selections
  ADD COLUMN reasoning_effort text
    CHECK (reasoning_effort IS NULL OR reasoning_effort ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$');

-- ------------------------------------------------------------------ helpers

-- Whether a model lists a level; '' (the runtime's default) always holds.
CREATE FUNCTION reasoning_effort_supported(p_entry_id uuid, p_level text)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path TO control_plane, public, extensions, pg_temp
AS $$
  SELECT COALESCE(p_level, '') = ''
    OR EXISTS (SELECT 1 FROM provider_model_catalog m WHERE m.id = p_entry_id AND m.reasoning_efforts ? p_level);
$$;

-- A level to save: the model lists it, or it is ''. Refused otherwise.
CREATE FUNCTION assert_reasoning_effort(p_entry_id uuid, p_level text)
RETURNS text
LANGUAGE plpgsql
STABLE
SET search_path TO control_plane, public, extensions, pg_temp
AS $$
BEGIN
  IF length(COALESCE(p_level, '')) > 64 OR NOT reasoning_effort_supported(p_entry_id, p_level) THEN
    PERFORM refuse('reasoning_effort_unsupported', format('%s does not offer the reasoning level %s',
      COALESCE((SELECT model_id FROM provider_model_catalog WHERE id = p_entry_id), p_entry_id::text), left(p_level, 64)), '22023');
  END IF;
  RETURN COALESCE(p_level, '');
END $$;

-- ------------------------------------------------------------------ defaults

-- The orchestrator's level as before; each executor's level by position,
-- p_executor_reasoning_efforts[i] for p_executor_entry_ids[i] ('' or missing:
-- the runtime's default). Called with the old nine arguments it saves every
-- executor at the default, which is what the previous release meant.
DROP FUNCTION set_project_runtime_defaults(uuid,uuid,bigint,uuid,uuid[],text,text,text,text);
CREATE FUNCTION set_project_runtime_defaults(
  p_project_id uuid, p_owner_id uuid, p_expected_version bigint,
  p_orchestrator_entry_id uuid, p_executor_entry_ids uuid[],
  p_reasoning_effort text DEFAULT '', p_service_tier text DEFAULT '',
  p_actor text DEFAULT '', p_correlation_id text DEFAULT '',
  p_executor_reasoning_efforts text[] DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO control_plane, public, extensions, pg_temp
AS $$
DECLARE
  v_project projects%ROWTYPE;
  v_defaults project_runtime_defaults%ROWTYPE;
  v_orchestrator jsonb;
  v_entry_id uuid;
  v_priority integer;
  v_ordinal integer;
  v_level text;
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
  IF COALESCE(array_length(p_executor_reasoning_efforts,1),0) > COALESCE(array_length(p_executor_entry_ids,1),0) THEN
    RAISE EXCEPTION 'more executor reasoning levels than executors' USING ERRCODE='22023', DETAIL=jsonb_build_object('reason','runtime_defaults_invalid')::text;
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
    FOR v_entry_id, v_ordinal IN
      SELECT t.id, t.ordinality::integer
      FROM unnest(p_executor_entry_ids) WITH ORDINALITY AS t(id,ordinality)
      ORDER BY t.ordinality
    LOOP
      v_priority := v_ordinal * 100;
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
      v_level := assert_reasoning_effort(v_entry_id, COALESCE(p_executor_reasoning_efforts[v_ordinal], ''));
      INSERT INTO project_runtime_default_executors(project_id,catalog_entry_id,priority,reasoning_effort)
      VALUES(p_project_id,v_entry_id,v_priority,v_level);
      v_executor_count := v_executor_count + 1;
    END LOOP;
  END IF;

  PERFORM write_audit_event(NULL,NULL,NULL,'operator',COALESCE(NULLIF(p_actor,''),p_owner_id::text),
    'project.runtime_defaults_updated','project',p_project_id::text,'allowed',NULL,
    jsonb_build_object('orchestrator_entry_id',p_orchestrator_entry_id,
      'executor_entry_ids',p_executor_entry_ids,'reasoning_effort',p_reasoning_effort,
      'executor_reasoning_efforts',p_executor_reasoning_efforts,
      'service_tier',p_service_tier,'version',v_defaults.version),
    COALESCE(NULLIF(p_correlation_id,''),p_project_id::text));
  RETURN jsonb_build_object(
    'project_id',p_project_id,'status','saved','version',v_defaults.version,
    'orchestrator_entry_id',v_defaults.orchestrator_entry_id,
    'executor_count',v_executor_count
  );
END $$;

-- The read the settings card uses (0094): each member's level beside its model,
-- and whether the model still lists it. A level the model no longer lists no
-- longer makes the model itself read as unavailable.
CREATE OR REPLACE FUNCTION get_project_runtime_defaults(p_project_id uuid, p_owner_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO control_plane, public, extensions, pg_temp
AS $$
  SELECT COALESCE((
    SELECT jsonb_build_object(
      'project_id',d.project_id,'version',d.version,
      'reasoning_effort',d.reasoning_effort,'service_tier',d.service_tier,
      'orchestrator',describe_runtime_default_entry(d.orchestrator_entry_id,'',d.service_tier)
        || jsonb_build_object('reasoning_effort',d.reasoning_effort,
             'reasoning_supported',reasoning_effort_supported(d.orchestrator_entry_id,d.reasoning_effort)),
      'executors',COALESCE((
        SELECT jsonb_agg(describe_runtime_default_entry(e.catalog_entry_id)
            || jsonb_build_object('reasoning_effort',e.reasoning_effort,
                 'reasoning_supported',reasoning_effort_supported(e.catalog_entry_id,e.reasoning_effort))
          ORDER BY e.priority,e.catalog_entry_id)
        FROM project_runtime_default_executors e WHERE e.project_id=d.project_id
      ),'[]'::jsonb)
    )
    FROM project_runtime_defaults d JOIN projects p ON p.id=d.project_id
    WHERE d.project_id=p_project_id AND p.owner_id=p_owner_id
  ),'null'::jsonb);
$$;

-- ------------------------------------------------------------------ snapshot

-- 0088's capture, with each member's level: the orchestrator's as before, each
-- executor's from its default. A level its model no longer lists is not a
-- reason to refuse the task: the member runs at the runtime's default, and the
-- snapshot keeps the level it dropped (`reasoning_effort_dropped`).
CREATE OR REPLACE FUNCTION capture_task_runtime_snapshot(p_task_id uuid, p_project_id uuid, p_executor_assignment_ids uuid[])
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO control_plane, public, extensions, pg_temp
AS $$
DECLARE
  v_defaults project_runtime_defaults%ROWTYPE;
  v_task tasks%ROWTYPE;
  v_orchestrator jsonb;
  v_executors jsonb := '[]'::jsonb;
  v_entry_id uuid;
  v_assignment_id uuid;
  v_saved_level text;
  v_level text;
  v_captured jsonb;
  v_required text[];
  v_runtime text;
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

  -- U1 (0088): each prerequisite of the orchestrator by name, the reading the
  -- panel showed, before the entry is resolved.
  SELECT rp.runtime_type INTO v_runtime
  FROM project_agent_assignments pa JOIN runtime_profiles rp ON rp.id=pa.runtime_profile_id
  WHERE pa.id=v_task.orchestrator_assignment_id;
  PERFORM assert_dispatch_prerequisites(v_runtime, v_defaults.orchestrator_entry_id, 'orchestrator');

  v_level := CASE WHEN reasoning_effort_supported(v_defaults.orchestrator_entry_id, v_defaults.reasoning_effort)
    THEN v_defaults.reasoning_effort ELSE '' END;
  v_orchestrator := resolve_catalog_snapshot_entry(
    v_defaults.orchestrator_entry_id,
    v_level,
    v_defaults.service_tier
  );
  IF v_level IS DISTINCT FROM v_defaults.reasoning_effort THEN
    v_orchestrator := v_orchestrator || jsonb_build_object('reasoning_effort_dropped', v_defaults.reasoning_effort);
  END IF;

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

  FOR v_entry_id, v_assignment_id, v_saved_level IN
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
      SELECT d.catalog_entry_id,d.reasoning_effort,
        row_number() OVER (ORDER BY d.priority,d.catalog_entry_id) AS ordinal
      FROM project_runtime_default_executors d
      WHERE d.project_id=p_project_id
    )
    SELECT d.catalog_entry_id,e.assignment_id,d.reasoning_effort
    FROM defaults d
    LEFT JOIN effective_assignments e ON e.ordinal=d.ordinal
    WHERE e.assignment_id IS NOT NULL
       OR NOT EXISTS (SELECT 1 FROM all_assignments)
    ORDER BY d.ordinal,e.priority NULLS LAST
  LOOP
    -- U1 (0088): the same four questions of each executor that will be bound.
    SELECT rp.runtime_type INTO v_runtime
    FROM project_agent_assignments pa JOIN runtime_profiles rp ON rp.id=pa.runtime_profile_id
    WHERE pa.id=v_assignment_id;
    PERFORM assert_dispatch_prerequisites(v_runtime, v_entry_id, 'executor');
    v_level := CASE WHEN reasoning_effort_supported(v_entry_id, v_saved_level) THEN v_saved_level ELSE '' END;
    v_executors := v_executors || jsonb_build_array(
      resolve_catalog_snapshot_entry(v_entry_id, v_level) || jsonb_build_object(
        'assignment_ids',CASE WHEN v_assignment_id IS NULL
          THEN '[]'::jsonb ELSE jsonb_build_array(v_assignment_id::text) END
      ) || CASE WHEN v_level IS DISTINCT FROM v_saved_level
          THEN jsonb_build_object('reasoning_effort_dropped', v_saved_level) ELSE '{}'::jsonb END
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
END $$;

-- ------------------------------------------------------------------ launch

-- The executor's launch reads its level from the same snapshot entry that
-- authorizes its model (0080), so the supervisor never takes a level from
-- anywhere but the task's snapshot.
CREATE OR REPLACE FUNCTION resolve_executor_launch_model(p_job_id bigint)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path TO control_plane, public, extensions, pg_temp
AS $$
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
      e->>'verification_id' AS verification_id,e->>'reasoning_effort' AS reasoning_effort
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
      e->>'verification_id' AS verification_id,e->>'reasoning_effort' AS reasoning_effort
    FROM task, jsonb_array_elements(task.snapshot->'executors') e
    WHERE task.snapshot->>'source'='catalog' AND e->>'model_id' IS NOT NULL
      AND NOT (SELECT has FROM snapshot_has_provenance)
    ORDER BY e->>'model_id' LIMIT 1
  )
  SELECT COALESCE((
    SELECT jsonb_build_object(
      'model',sm.model,'snapshot_entry_id',sm.entry_id,
      'snapshot_verification_id',sm.verification_id,'snapshot_authorized',true,
      'reasoning_effort',NULLIF(sm.reasoning_effort,'')
    ) FROM snapshot_model sm
  ),(
    SELECT jsonb_build_object(
      'model',smf.model,'snapshot_entry_id',smf.entry_id,
      'snapshot_verification_id',smf.verification_id,'snapshot_authorized',true,
      'reasoning_effort',NULLIF(smf.reasoning_effort,'')
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
$$;

-- 0084's record_runtime_dispatch, with the level the launch sent recorded on
-- the selection beside its model. The launcher says it, as it says the model:
-- the previous release's launchers send none and are recorded with none, which
-- is what they ran. A retry that sends another level than the selection holds
-- supersedes it, like a runtime that moved between attempts.
CREATE OR REPLACE FUNCTION record_runtime_dispatch(p_job_id bigint, p_worker_id text, p_launch jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path TO control_plane, public, extensions, pg_temp
AS $$
DECLARE
  v_job runtime_jobs%ROWTYPE; v_run task_runs%ROWTYPE; v_grant workspace_access_grants%ROWTYPE;
  v_assignment project_agent_assignments%ROWTYPE; v_runtime text; v_selection runtime_job_selections%ROWTYPE;
  v_capabilities text[]; v_attempt runtime_dispatch_attempts%ROWTYPE; v_reused boolean := true;
  v_blocked text; v_revoked uuid; v_level text;
BEGIN
  SELECT * INTO v_job FROM runtime_jobs WHERE id=p_job_id FOR UPDATE;
  IF NOT FOUND OR v_job.status<>'in_flight' OR v_job.leased_by IS DISTINCT FROM p_worker_id
     OR v_job.leased_until<=clock_timestamp() THEN
    PERFORM refuse('run_command_not_leased', format('job %s is not leased by %s', p_job_id, p_worker_id));
  END IF;
  -- Every term IS DISTINCT FROM, not <>: a missing key is NULL, and one NULL
  -- term makes the whole OR NULL, which IF reads as false — the hole 0068
  -- closed in a guard and f519986 in a test.
  IF p_launch IS NULL OR jsonb_typeof(p_launch) IS DISTINCT FROM 'object'
     OR jsonb_typeof(p_launch->'capabilities') IS DISTINCT FROM 'array'
     OR COALESCE(jsonb_array_length(CASE WHEN jsonb_typeof(p_launch->'capabilities')='array' THEN p_launch->'capabilities' END),0)=0
     OR COALESCE(p_launch->>'runtime','')='' OR COALESCE(p_launch->>'adapter_version','')=''
     OR COALESCE(p_launch->>'executable','')='' OR COALESCE(p_launch->>'surface','')=''
     OR COALESCE(p_launch->>'capability_verification','') NOT IN ('verified','unverified')
     OR COALESCE(p_launch->>'reasoning_effort','') !~ '^([A-Za-z0-9][A-Za-z0-9._-]{0,63})?$' THEN
    PERFORM refuse('runtime_selection_invalid', 'a launch names its runtime, adapter version, executable, surface, capabilities and verification, and a reasoning level only as a bounded token', '22023');
  END IF;
  SELECT array_agg(value ORDER BY value) INTO v_capabilities FROM jsonb_array_elements_text(p_launch->'capabilities');
  v_level := NULLIF(p_launch->>'reasoning_effort','');

  v_run.id:=active_run_of_job(v_job);
  IF v_run.id IS NOT NULL THEN SELECT * INTO v_run FROM task_runs WHERE id=v_run.id; END IF;
  SELECT * INTO v_grant FROM workspace_access_grants
  WHERE run_id=v_run.id ORDER BY (revoked_at IS NULL) DESC, issued_at DESC LIMIT 1;
  IF v_grant.id IS NULL THEN
    PERFORM refuse('runtime_selection_no_grant', format('run %s of job %s holds no workspace grant', v_run.id, p_job_id));
  END IF;
  SELECT * INTO v_assignment FROM project_agent_assignments WHERE id=v_grant.assignment_id;
  SELECT rp.runtime_type INTO v_runtime FROM runtime_profiles rp WHERE rp.id=v_assignment.runtime_profile_id;
  IF v_runtime IS DISTINCT FROM p_launch->>'runtime' THEN
    PERFORM refuse('runtime_selection_mismatch',
      format('job %s selected %s through its assignment, and the launch is %s', p_job_id, v_runtime, p_launch->>'runtime'));
  END IF;
  -- 0072: the runtime as the host last reported it, read under a share lock on
  -- the one row the report writes. A removal that has written and not yet
  -- committed is waited for and then seen; one that comes after waits for this
  -- launch to commit and meets it as a running process instead. Either way the
  -- launch and the removal are ordered, never interleaved.
  v_blocked:=runtime_undispatchable_reason(v_runtime);
  IF v_blocked IS NOT NULL THEN
    PERFORM refuse(v_blocked, format('job %s cannot launch %s: %s', p_job_id, v_runtime,
      (SELECT note FROM failure_reasons WHERE reason=v_blocked)));
  END IF;
  -- 0084: the connection the task's model reaches its models through, read
  -- under a share lock on its row. A revocation written and not yet committed
  -- is waited for and then seen; one that comes after waits for this launch.
  v_revoked:=revoked_model_access(v_job);
  IF v_revoked IS NOT NULL THEN
    PERFORM refuse('model_access_revoked', format('job %s cannot launch: connection %s of its model is no longer connected',
      p_job_id, v_revoked));
  END IF;

  v_selection:=current_runtime_job_selection(p_job_id);
  IF v_selection.id IS NULL OR v_selection.source='backfill' THEN
    INSERT INTO runtime_job_selections(job_id,project_id,task_id,source,supersedes,supersede_reason,
      assignment_id,agent_id,runtime_type,adapter_version,runtime_version,verified_runtime_version,
      capability_verification,capabilities,session_id,access_mode,model,reasoning_effort,selected_by)
    VALUES(v_job.id,v_job.project_id,v_job.task_id,
      CASE WHEN v_selection.id IS NULL THEN 'launch' ELSE 'supersede' END,
      v_selection.id, CASE WHEN v_selection.id IS NULL THEN NULL ELSE 'the first launch recorded under 0071 replaces a backfilled selection' END,
      v_assignment.id,v_assignment.agent_id,v_runtime,p_launch->>'adapter_version',p_launch->>'runtime_version',
      p_launch->>'verified_runtime_version',p_launch->>'capability_verification',v_capabilities,
      v_run.session_id,v_grant.mode,NULLIF(p_launch->>'model',''),v_level,p_worker_id)
    RETURNING * INTO v_selection;
    v_reused:=false;
  ELSIF v_selection.assignment_id IS DISTINCT FROM v_assignment.id
     OR v_selection.runtime_type IS DISTINCT FROM v_runtime
     OR v_selection.access_mode IS DISTINCT FROM v_grant.mode THEN
    -- A retry that would run for another assignment, on another runtime or
    -- with other access. Recording it over the first selection is exactly the
    -- history this table exists to keep, and choosing it is not a launcher's.
    PERFORM refuse('runtime_selection_changed',
      format('job %s was selected as %s for assignment %s with %s access, and this launch is %s for %s with %s',
        p_job_id, v_selection.runtime_type, v_selection.assignment_id, v_selection.access_mode,
        v_runtime, v_assignment.id, v_grant.mode));
  ELSIF v_selection.adapter_version IS DISTINCT FROM p_launch->>'adapter_version'
     OR v_selection.runtime_version IS DISTINCT FROM p_launch->>'runtime_version'
     OR v_selection.capabilities IS DISTINCT FROM v_capabilities
     OR v_selection.reasoning_effort IS DISTINCT FROM v_level THEN
    -- The same selection on a host whose runtime or driver moved between
    -- attempts (a `runtime install`, a release). Not an update: a superseding
    -- selection that names the old one and says what changed.
    INSERT INTO runtime_job_selections(job_id,project_id,task_id,source,supersedes,supersede_reason,
      assignment_id,agent_id,runtime_type,adapter_version,runtime_version,verified_runtime_version,
      capability_verification,capabilities,session_id,access_mode,model,reasoning_effort,selected_by)
    VALUES(v_job.id,v_job.project_id,v_job.task_id,'supersede',v_selection.id,
      left(format('the runtime moved between attempts: adapter %s -> %s, runtime %s -> %s%s%s',
        v_selection.adapter_version, p_launch->>'adapter_version',
        COALESCE(v_selection.runtime_version,'unknown'), COALESCE(p_launch->>'runtime_version','unknown'),
        CASE WHEN v_selection.capabilities IS DISTINCT FROM v_capabilities THEN ', declared capabilities changed' ELSE '' END,
        CASE WHEN v_selection.reasoning_effort IS DISTINCT FROM v_level
          THEN format(', reasoning level %s -> %s', COALESCE(v_selection.reasoning_effort,'default'), COALESCE(v_level,'default')) ELSE '' END),500),
      v_assignment.id,v_assignment.agent_id,v_runtime,p_launch->>'adapter_version',p_launch->>'runtime_version',
      p_launch->>'verified_runtime_version',p_launch->>'capability_verification',v_capabilities,
      v_selection.session_id,v_grant.mode,COALESCE(NULLIF(p_launch->>'model',''),v_selection.model),v_level,p_worker_id)
    RETURNING * INTO v_selection;
    v_reused:=false;
  END IF;

  INSERT INTO runtime_dispatch_attempts(job_id,selection_id,attempt_number,run_id,runtime_type,executable,
    adapter_version,runtime_version,capability_verification,session_id,native_session_id,grant_id,access_mode,
    worker_id,surface)
  VALUES(v_job.id,v_selection.id,GREATEST(v_job.attempt_count,1),v_run.id,v_runtime,p_launch->>'executable',
    p_launch->>'adapter_version',p_launch->>'runtime_version',p_launch->>'capability_verification',
    v_run.session_id,NULLIF(p_launch->>'native_session_id',''),v_grant.id,v_grant.mode,p_worker_id,p_launch->>'surface')
  RETURNING * INTO v_attempt;

  RETURN jsonb_build_object('selection_id',v_selection.id,'selection_reused',v_reused,'attempt_id',v_attempt.id,
    'attempt_number',v_attempt.attempt_number,'runtime_type',v_runtime,'access_mode',v_grant.mode,
    'assignment_id',v_assignment.id,'grant_id',v_grant.id,'reasoning_effort',v_selection.reasoning_effort);
END $$;

-- ------------------------------------------------------------------ the Team tab

-- 0089's add, with the new executor's level ('' = the runtime's default).
DROP FUNCTION add_project_executor(uuid,uuid,bigint,uuid,text,text);
CREATE FUNCTION add_project_executor(p_project_id uuid, p_owner_id uuid, p_expected_version bigint,
  p_entry_id uuid, p_actor text, p_correlation_id text, p_reasoning_effort text DEFAULT '')
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO control_plane, public, extensions, pg_temp
AS $$
DECLARE v_entry jsonb; v_runtime text; v_definition uuid; v_profile uuid; v_agent uuid; v_assignment uuid;
  v_count integer; v_priority integer; v_version bigint; v_level text;
BEGIN
  PERFORM lock_project_team(p_project_id, p_owner_id, p_expected_version);
  SELECT count(*) INTO v_count FROM project_executor_positions(p_project_id);
  IF v_count >= 8 THEN
    PERFORM refuse('runtime_defaults_invalid', 'a project has at most eight executors', '22023');
  END IF;
  v_entry:=team_model(p_owner_id, p_entry_id);
  v_runtime:=v_entry->>'runtime_type';
  IF NOT runtime_plays(v_runtime,'executor') THEN
    PERFORM refuse('runtime_cannot_play_role', format('%s does not play the executor', v_runtime), '22023');
  END IF;
  SELECT id INTO v_definition FROM role_definitions WHERE builtin_key='executor';
  IF NOT assignment_may(v_runtime, v_definition) THEN
    PERFORM refuse('runtime_cannot_play_role',
      format('%s lacks a capability the Executor role needs', v_runtime), '22023');
  END IF;
  IF EXISTS (SELECT 1 FROM project_runtime_default_executors d WHERE d.project_id=p_project_id AND d.catalog_entry_id=p_entry_id) THEN
    PERFORM refuse('team_model_in_use', format('another executor of project %s already runs %s', p_project_id, v_entry->>'model_id'));
  END IF;
  v_level:=assert_reasoning_effort(p_entry_id, p_reasoning_effort);

  v_profile:=ensure_structural_runtime_profile(p_owner_id, v_runtime);
  INSERT INTO agents(name, runtime_profile_id)
  VALUES('executor-'||v_runtime||'-'||left(gen_random_uuid()::text,8)||'-'||p_project_id, v_profile)
  RETURNING id INTO v_agent;
  -- clock_timestamp, not the transaction's now(): the new executor is the last
  -- by creation, which is the position its default takes below.
  INSERT INTO project_agent_assignments(project_id, agent_id, runtime_profile_id, role_definition_id, created_at, updated_at)
  VALUES(p_project_id, v_agent, v_profile, v_definition, clock_timestamp(), clock_timestamp())
  RETURNING id INTO v_assignment;
  SELECT COALESCE(max(priority),0)+100 INTO v_priority FROM project_runtime_default_executors WHERE project_id=p_project_id;
  INSERT INTO project_runtime_default_executors(project_id, catalog_entry_id, priority, reasoning_effort)
  VALUES(p_project_id, p_entry_id, v_priority, v_level);

  v_version:=bump_project_team(p_project_id, p_owner_id, p_actor, p_correlation_id, 'executor_added',
    jsonb_build_object('assignment_id',v_assignment,'entry_id',p_entry_id,'runtime',v_runtime,'reasoning_effort',v_level));
  RETURN jsonb_build_object('project_id',p_project_id,'assignment_id',v_assignment,'version',v_version,'status','added',
    'reasoning_effort',NULLIF(v_level,''));
END $$;

-- 0089's change of model, with the member's level. p_reasoning_effort NULL
-- (the previous release, or a picker that did not ask) keeps the member's level
-- if the new model lists it and otherwise resets it to the default — and the
-- result says which level was reset. '' asks for the default; a level is
-- refused unless the new model lists it. The same model with another level is
-- a change of level only. The orchestrator's service tier follows the same
-- rule as its level: kept if the new model lists it, else cleared, because a
-- tier the model does not list would refuse every new task's snapshot.
DROP FUNCTION change_project_assignment_model(uuid,uuid,bigint,uuid,uuid,text,text);
CREATE FUNCTION change_project_assignment_model(p_project_id uuid, p_owner_id uuid, p_expected_version bigint,
  p_assignment_id uuid, p_entry_id uuid, p_actor text, p_correlation_id text, p_reasoning_effort text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO control_plane, public, extensions, pg_temp
AS $$
DECLARE v_assignment project_agent_assignments%ROWTYPE; v_runtime text; v_entry jsonb; v_ordinal bigint;
  v_old uuid; v_priority integer; v_version bigint; v_role text; v_old_level text := ''; v_level text; v_reset text;
BEGIN
  PERFORM lock_project_team(p_project_id, p_owner_id, p_expected_version);
  SELECT pa.* INTO v_assignment FROM project_agent_assignments pa
  WHERE pa.id=p_assignment_id AND pa.project_id=p_project_id AND pa.enabled;
  IF NOT FOUND THEN
    PERFORM refuse('team_assignment_unavailable', format('no enabled assignment %s in project %s', p_assignment_id, p_project_id));
  END IF;
  SELECT runtime_type INTO v_runtime FROM runtime_profiles WHERE id=v_assignment.runtime_profile_id;
  v_entry:=team_model(p_owner_id, p_entry_id);
  IF v_entry->>'runtime_type' IS DISTINCT FROM v_runtime THEN
    PERFORM refuse('runtime_default_not_assigned',
      format('this assignment runs on %s and %s is a %s model: add an executor on %s and disable this one',
        v_runtime, v_entry->>'model_id', v_entry->>'runtime_type', v_entry->>'runtime_type'), '22023');
  END IF;

  IF role_holds(v_assignment.role_definition_id,'conversation.hold') THEN
    v_role:='orchestrator';
    IF NOT runtime_plays(v_runtime,'orchestrator') THEN
      PERFORM refuse('runtime_cannot_play_role', format('%s does not play the orchestrator', v_runtime), '22023');
    END IF;
    SELECT orchestrator_entry_id, reasoning_effort INTO v_old, v_old_level FROM project_runtime_defaults WHERE project_id=p_project_id;
  ELSIF role_holds(v_assignment.role_definition_id,'implementation.execute') THEN
    v_role:='executor';
    SELECT e.ordinal INTO v_ordinal FROM project_executor_positions(p_project_id) e WHERE e.assignment_id=p_assignment_id;
    SELECT d.catalog_entry_id, d.priority INTO v_old, v_priority
    FROM project_default_executor_positions(p_project_id) d WHERE d.ordinal=v_ordinal;
    SELECT d.reasoning_effort INTO v_old_level FROM project_runtime_default_executors d
    WHERE d.project_id=p_project_id AND d.catalog_entry_id=v_old;
    v_old_level:=COALESCE(v_old_level,'');
  ELSE
    PERFORM refuse('team_assignment_unavailable', format('assignment %s is neither the orchestrator nor an executor', p_assignment_id));
  END IF;

  IF p_reasoning_effort IS NULL THEN
    v_level:=CASE WHEN reasoning_effort_supported(p_entry_id, v_old_level) THEN v_old_level ELSE '' END;
    IF v_level IS DISTINCT FROM v_old_level THEN v_reset:=v_old_level; END IF;
  ELSE
    v_level:=assert_reasoning_effort(p_entry_id, p_reasoning_effort);
  END IF;

  IF v_role='orchestrator' THEN
    UPDATE project_runtime_defaults SET orchestrator_entry_id=p_entry_id, reasoning_effort=v_level,
      service_tier=CASE WHEN service_tier='' OR (SELECT m.service_tiers ? project_runtime_defaults.service_tier
                          FROM provider_model_catalog m WHERE m.id=p_entry_id) THEN service_tier ELSE '' END
    WHERE project_id=p_project_id;
  ELSIF v_old IS DISTINCT FROM p_entry_id THEN
    IF EXISTS (SELECT 1 FROM project_runtime_default_executors d WHERE d.project_id=p_project_id AND d.catalog_entry_id=p_entry_id) THEN
      PERFORM refuse('team_model_in_use', format('another executor of project %s already runs %s', p_project_id, v_entry->>'model_id'));
    END IF;
    IF v_old IS NULL THEN
      -- An executor without a default of its own (more executors than
      -- defaults): its model goes to the end, which is its position only if
      -- it is the last. Otherwise the positions would shift under the others.
      IF v_ordinal IS DISTINCT FROM (SELECT count(*) FROM project_default_executor_positions(p_project_id)) + 1 THEN
        PERFORM refuse('runtime_defaults_invalid',
          'the executors before this one have no models of their own; set them first', '22023');
      END IF;
      SELECT COALESCE(max(priority),0)+100 INTO v_priority FROM project_runtime_default_executors WHERE project_id=p_project_id;
    ELSE
      DELETE FROM project_runtime_default_executors WHERE project_id=p_project_id AND catalog_entry_id=v_old;
    END IF;
    INSERT INTO project_runtime_default_executors(project_id, catalog_entry_id, priority, reasoning_effort)
    VALUES(p_project_id, p_entry_id, v_priority, v_level);
  ELSE
    UPDATE project_runtime_default_executors SET reasoning_effort=v_level
    WHERE project_id=p_project_id AND catalog_entry_id=p_entry_id;
  END IF;

  v_version:=bump_project_team(p_project_id, p_owner_id, p_actor, p_correlation_id, 'model_changed',
    jsonb_build_object('assignment_id',p_assignment_id,'role',v_role,'from_entry_id',v_old,'entry_id',p_entry_id,
      'from_reasoning_effort',v_old_level,'reasoning_effort',v_level));
  RETURN jsonb_build_object('project_id',p_project_id,'assignment_id',p_assignment_id,'version',v_version,'status','changed',
    'reasoning_effort',NULLIF(v_level,''),'reasoning_effort_reset',NULLIF(v_reset,''));
END $$;

-- A member's level alone, its model unchanged.
CREATE FUNCTION set_project_assignment_reasoning(p_project_id uuid, p_owner_id uuid, p_expected_version bigint,
  p_assignment_id uuid, p_reasoning_effort text, p_actor text, p_correlation_id text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO control_plane, public, extensions, pg_temp
AS $$
DECLARE v_assignment project_agent_assignments%ROWTYPE; v_ordinal bigint; v_entry uuid; v_role text;
  v_old_level text; v_level text; v_version bigint;
BEGIN
  PERFORM lock_project_team(p_project_id, p_owner_id, p_expected_version);
  SELECT pa.* INTO v_assignment FROM project_agent_assignments pa
  WHERE pa.id=p_assignment_id AND pa.project_id=p_project_id AND pa.enabled;
  IF NOT FOUND THEN
    PERFORM refuse('team_assignment_unavailable', format('no enabled assignment %s in project %s', p_assignment_id, p_project_id));
  END IF;
  IF role_holds(v_assignment.role_definition_id,'conversation.hold') THEN
    v_role:='orchestrator';
    SELECT orchestrator_entry_id, reasoning_effort INTO v_entry, v_old_level FROM project_runtime_defaults WHERE project_id=p_project_id;
  ELSIF role_holds(v_assignment.role_definition_id,'implementation.execute') THEN
    v_role:='executor';
    SELECT e.ordinal INTO v_ordinal FROM project_executor_positions(p_project_id) e WHERE e.assignment_id=p_assignment_id;
    SELECT d.catalog_entry_id INTO v_entry FROM project_default_executor_positions(p_project_id) d WHERE d.ordinal=v_ordinal;
    IF v_entry IS NULL THEN
      PERFORM refuse('team_assignment_unavailable', format('executor %s has no model of its own yet; set its model first', p_assignment_id));
    END IF;
    SELECT d.reasoning_effort INTO v_old_level FROM project_runtime_default_executors d
    WHERE d.project_id=p_project_id AND d.catalog_entry_id=v_entry;
  ELSE
    PERFORM refuse('team_assignment_unavailable', format('assignment %s is neither the orchestrator nor an executor', p_assignment_id));
  END IF;
  v_level:=assert_reasoning_effort(v_entry, p_reasoning_effort);

  IF v_role='orchestrator' THEN
    UPDATE project_runtime_defaults SET reasoning_effort=v_level WHERE project_id=p_project_id;
  ELSE
    UPDATE project_runtime_default_executors SET reasoning_effort=v_level
    WHERE project_id=p_project_id AND catalog_entry_id=v_entry;
  END IF;
  v_version:=bump_project_team(p_project_id, p_owner_id, p_actor, p_correlation_id, 'reasoning_changed',
    jsonb_build_object('assignment_id',p_assignment_id,'role',v_role,'entry_id',v_entry,
      'from_reasoning_effort',COALESCE(v_old_level,''),'reasoning_effort',v_level));
  RETURN jsonb_build_object('project_id',p_project_id,'assignment_id',p_assignment_id,'version',v_version,'status','changed',
    'reasoning_effort',NULLIF(v_level,''));
END $$;

-- The Team tab's levels, beside project_team (0089): each member's saved level
-- and whether its model still lists it, and the levels of every model the tab
-- can offer. Its own read so the team's read keeps its shape.
CREATE FUNCTION project_team_reasoning(p_project_id uuid, p_owner_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO control_plane, public, extensions, pg_temp
AS $$
DECLARE v_defaults project_runtime_defaults%ROWTYPE;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM projects p WHERE p.id=p_project_id AND p.owner_id=p_owner_id) THEN
    PERFORM refuse('project_unavailable', format('no project %s this operator owns', p_project_id));
  END IF;
  SELECT * INTO v_defaults FROM project_runtime_defaults WHERE project_id=p_project_id;
  RETURN jsonb_build_object(
    'assignments', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('assignment_id', m.assignment_id, 'entry_id', m.entry_id,
        'reasoning_effort', NULLIF(m.level,''), 'supported', reasoning_effort_supported(m.entry_id, m.level)))
      FROM (
        SELECT pa.id AS assignment_id, v_defaults.orchestrator_entry_id AS entry_id, v_defaults.reasoning_effort AS level
        FROM project_agent_assignments pa
        WHERE pa.project_id=p_project_id AND pa.enabled AND role_holds(pa.role_definition_id,'conversation.hold')
          AND v_defaults.project_id IS NOT NULL
        UNION ALL
        SELECT e.assignment_id, d.catalog_entry_id, x.reasoning_effort
        FROM project_executor_positions(p_project_id) e
        JOIN project_default_executor_positions(p_project_id) d ON d.ordinal=e.ordinal
        JOIN project_runtime_default_executors x ON x.project_id=p_project_id AND x.catalog_entry_id=d.catalog_entry_id
      ) m), '[]'::jsonb),
    'models', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('entry_id', m.id, 'levels', m.reasoning_levels,
        'default', NULLIF(m.default_reasoning_effort,'')) ORDER BY m.id)
      FROM provider_model_catalog m JOIN provider_connections c ON c.id=m.connection_id
      WHERE m.operator_id=p_owner_id AND m.superseded_by IS NULL AND m.status='verified' AND c.status='connected'
        AND jsonb_array_length(m.reasoning_levels) > 0), '[]'::jsonb));
END $$;

REVOKE EXECUTE ON FUNCTION reasoning_effort_supported(uuid,text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION assert_reasoning_effort(uuid,text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION set_project_runtime_defaults(uuid,uuid,bigint,uuid,uuid[],text,text,text,text,text[]) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION get_project_runtime_defaults(uuid,uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION capture_task_runtime_snapshot(uuid,uuid,uuid[]) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION resolve_executor_launch_model(bigint) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION record_runtime_dispatch(bigint,text,jsonb) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION add_project_executor(uuid,uuid,bigint,uuid,text,text,text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION change_project_assignment_model(uuid,uuid,bigint,uuid,uuid,text,text,text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION set_project_assignment_reasoning(uuid,uuid,bigint,uuid,text,text,text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION project_team_reasoning(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION set_project_runtime_defaults(uuid,uuid,bigint,uuid,uuid[],text,text,text,text,text[]) TO infra_web, infra_worker;
GRANT EXECUTE ON FUNCTION add_project_executor(uuid,uuid,bigint,uuid,text,text,text) TO infra_web;
GRANT EXECUTE ON FUNCTION change_project_assignment_model(uuid,uuid,bigint,uuid,uuid,text,text,text) TO infra_web;
GRANT EXECUTE ON FUNCTION set_project_assignment_reasoning(uuid,uuid,bigint,uuid,text,text,text) TO infra_web;
GRANT EXECUTE ON FUNCTION project_team_reasoning(uuid,uuid) TO infra_web;
