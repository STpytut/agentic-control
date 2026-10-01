-- A project's runtime defaults follow its assignments (Stage 11.2, rc.47).
--
-- A turn is run by the runtime its assignment's profile names; the model is the
-- project's default, snapshotted into the task. set_project_runtime_defaults
-- asked only whether the model's runtime plays the role at all, so on a project
-- whose orchestrator is OpenCode the panel offered, and this function accepted,
-- a Codex model — the turn would have handed it to OpenCode. rc.44's first
-- defect was the same pair the other way round, made by the create action.
--
-- The function is 0074's definition, with one check after each role check:
-- where the project has enabled assignments of that role, the model's runtime
-- is one of theirs. A project with none has no turn to hand a model to, and is
-- left as it was. Existing defaults are not re-examined; the next save is.

SET search_path TO control_plane, public, extensions;

INSERT INTO failure_reasons(reason, code, note) VALUES
  ('runtime_default_not_assigned','conflict','a default model is of a runtime no enabled assignment of that role in the project runs on');

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
             WHERE pa.project_id=p_project_id AND pa.assignment_role='orchestrator' AND pa.enabled)
     AND NOT EXISTS (SELECT 1 FROM project_agent_assignments pa JOIN runtime_profiles rp ON rp.id=pa.runtime_profile_id
                 WHERE pa.project_id=p_project_id AND pa.assignment_role='orchestrator' AND pa.enabled
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
                 WHERE pa.project_id=p_project_id AND pa.assignment_role='executor' AND pa.enabled)
         AND NOT EXISTS (SELECT 1 FROM project_agent_assignments pa JOIN runtime_profiles rp ON rp.id=pa.runtime_profile_id
                     WHERE pa.project_id=p_project_id AND pa.assignment_role='executor' AND pa.enabled
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
