-- Reading a project's runtime defaults never fails on a model that went away
-- (found by the redesign's step 7, 2026-09-28).
--
-- get_project_runtime_defaults resolved each saved entry through
-- resolve_catalog_snapshot_entry, which refuses an entry that is no longer
-- verified or whose connection is no longer connected. That refusal is right
-- when a task snapshot is captured or defaults are saved; on the read it took
-- the whole project settings page down with a 500 as soon as the connection
-- behind the default model expired. The read now describes such an entry as
-- unavailable (with the model it was, when the catalog still has it) and the
-- operator can pick another one; saving and capturing refuse as before.

SET search_path TO control_plane, public, extensions;

CREATE FUNCTION describe_runtime_default_entry(
  p_entry_id uuid, p_reasoning_effort text DEFAULT '', p_service_tier text DEFAULT ''
) RETURNS jsonb
LANGUAGE plpgsql STABLE
SET search_path TO control_plane, public, extensions, pg_temp
AS $$
DECLARE v_reason text;
BEGIN
  RETURN resolve_catalog_snapshot_entry(p_entry_id, p_reasoning_effort, p_service_tier)
    || jsonb_build_object('available', true);
EXCEPTION WHEN SQLSTATE '55000' OR SQLSTATE '22023' THEN
  v_reason := CASE WHEN SQLSTATE='55000' THEN 'catalog_entry_unavailable' ELSE 'runtime_defaults_invalid' END;
  RETURN COALESCE((
    SELECT jsonb_build_object(
      'entry_id', m.id, 'connection_id', m.connection_id,
      'runtime_type', m.runtime_type, 'provider_id', m.provider_id, 'model_id', m.model_id,
      'model_vendor', m.model_vendor, 'access_gateway', m.access_gateway,
      'billing_boundary', m.billing_boundary, 'catalog_status', m.status)
    FROM provider_model_catalog m WHERE m.id=p_entry_id
  ), jsonb_build_object('entry_id', p_entry_id))
    || jsonb_build_object('available', false, 'reason', v_reason);
END $$;

REVOKE EXECUTE ON FUNCTION describe_runtime_default_entry(uuid, text, text) FROM PUBLIC;

CREATE OR REPLACE FUNCTION get_project_runtime_defaults(
  p_project_id uuid, p_owner_id uuid
) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO control_plane, public, extensions, pg_temp
AS $$
  SELECT COALESCE((
    SELECT jsonb_build_object(
      'project_id',d.project_id,'version',d.version,
      'reasoning_effort',d.reasoning_effort,'service_tier',d.service_tier,
      'orchestrator',describe_runtime_default_entry(d.orchestrator_entry_id,
        d.reasoning_effort,d.service_tier),
      'executors',COALESCE((
        SELECT jsonb_agg(describe_runtime_default_entry(e.catalog_entry_id)
          ORDER BY e.priority,e.catalog_entry_id)
        FROM project_runtime_default_executors e WHERE e.project_id=d.project_id
      ),'[]'::jsonb)
    )
    FROM project_runtime_defaults d JOIN projects p ON p.id=d.project_id
    WHERE d.project_id=p_project_id AND p.owner_id=p_owner_id
  ),'null'::jsonb);
$$;
