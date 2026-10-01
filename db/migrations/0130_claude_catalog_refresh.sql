-- Claude's models are refreshed like the others (0129 gave it a list).
--
-- 0034 refreshed only Codex and OpenCode connections: Claude's catalog was
-- three aliases written by the worker, and there was nothing to read again.
-- Now the refresh reads the subscription's own model list, so a Claude
-- connection is refreshed on the same daily schedule. Every connection that
-- grants model access is — by its kind, not a list of runtime names.

SET search_path TO control_plane, public, extensions;

CREATE OR REPLACE FUNCTION request_catalog_refreshes_due(
  p_max_age interval DEFAULT interval '24 hours'
) RETURNS integer LANGUAGE plpgsql AS $$
DECLARE v_count integer;
BEGIN
  WITH eligible AS (
    SELECT c.id, c.operator_id,
      CASE WHEN EXISTS (
        SELECT 1 FROM provider_model_catalog m
        WHERE m.connection_id=c.id AND m.status='stale'
      ) THEN 'stale_entries' ELSE 'age' END AS reason
    FROM provider_connections c
    WHERE c.status='connected'
      AND c.connection_kind='model_access'
      AND NOT EXISTS (
        SELECT 1 FROM provider_model_catalog m
        WHERE m.connection_id=c.id AND m.discovery_source='manual'
      )
      AND (
        NOT EXISTS (
          SELECT 1 FROM catalog_refresh_jobs j
          WHERE j.connection_id=c.id AND j.status='completed'
        )
        OR NOT EXISTS (
          SELECT 1 FROM catalog_refresh_jobs j
          WHERE j.connection_id=c.id AND j.status='completed'
            AND j.completed_at > clock_timestamp()-p_max_age
        )
      )
      AND NOT EXISTS (
        SELECT 1 FROM catalog_refresh_jobs j
        WHERE j.connection_id=c.id AND j.status IN ('pending','in_progress')
      )
      AND NOT EXISTS (
        SELECT 1 FROM catalog_refresh_jobs j
        WHERE j.connection_id=c.id AND j.status='failed'
          AND j.created_at > clock_timestamp()-interval '15 minutes'
      )
  ), inserted AS (
    INSERT INTO catalog_refresh_jobs(operator_id,connection_id,reason)
    SELECT operator_id,id,
      CASE WHEN reason='stale_entries' THEN 'periodic_stale' ELSE 'periodic_age' END
    FROM eligible
    RETURNING id
  )
  SELECT count(*) INTO v_count FROM inserted;
  RETURN v_count;
END; $$;

ALTER FUNCTION request_catalog_refreshes_due(interval)
  SET search_path=control_plane,public,extensions,pg_temp;
