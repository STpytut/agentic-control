BEGIN;

SET search_path TO control_plane, public, extensions;

-- Catalog models are immutable launch choices, while runtime_profiles remain
-- structural adapter provenance. Bind executor catalog entries to project
-- assignments by their deterministic ordinal instead of requiring a legacy
-- profile whose model string happens to equal a newly discovered model.
CREATE OR REPLACE FUNCTION capture_task_runtime_snapshot(
  p_task_id uuid, p_project_id uuid
) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
  v_defaults project_runtime_defaults%ROWTYPE;
  v_task tasks%ROWTYPE;
  v_orchestrator jsonb;
  v_executors jsonb := '[]'::jsonb;
  v_entry_id uuid;
  v_executor_ordinal integer := 0;
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
    v_executor_ordinal := v_executor_ordinal + 1;
    v_executors := v_executors || jsonb_build_array(
      resolve_catalog_snapshot_entry(v_entry_id) || jsonb_build_object(
        'assignment_ids',COALESCE((
          SELECT jsonb_agg(assigned.id::text)
          FROM (
            SELECT pa.id
            FROM project_agent_assignments pa
            JOIN agents a ON a.id=pa.agent_id AND a.enabled
            JOIN runtime_profiles rp ON rp.id=pa.runtime_profile_id
              AND rp.enabled AND rp.runtime_type='opencode'
            WHERE pa.project_id=p_project_id AND pa.enabled
              AND pa.assignment_role='executor'
            ORDER BY a.name,pa.id
            OFFSET v_executor_ordinal - 1 LIMIT 1
          ) assigned
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

ALTER FUNCTION capture_task_runtime_snapshot(uuid,uuid)
  SET search_path=control_plane,public,extensions,pg_temp;

COMMIT;
