BEGIN;

SET search_path TO control_plane,public,extensions;

-- Catalog discovery is defined only for Codex and OpenCode. Older 0027 code
-- scheduled every connected provider, including GitHub, which could never be
-- discovered and created an unbounded failed-job loop.
UPDATE catalog_refresh_jobs j SET
  status='failed',
  failure_code='unsupported_provider',
  failure_message='This provider does not expose a runtime model catalog.',
  leased_by=NULL,
  leased_until=NULL
FROM provider_connections c
WHERE c.id=j.connection_id
  AND c.provider NOT IN ('codex','opencode')
  AND j.status IN ('pending','in_progress');

CREATE OR REPLACE FUNCTION request_catalog_refresh(
  p_connection_id uuid, p_operator_id uuid, p_reason text DEFAULT 'manual'
) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE v_connection provider_connections%ROWTYPE; v_job catalog_refresh_jobs%ROWTYPE;
BEGIN
  SELECT * INTO v_connection FROM provider_connections
  WHERE id=p_connection_id AND operator_id=p_operator_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'provider connection is unavailable' USING ERRCODE='55000'; END IF;
  IF v_connection.provider NOT IN ('codex','opencode') THEN
    RAISE EXCEPTION 'provider does not expose a runtime model catalog' USING ERRCODE='55000';
  END IF;
  IF v_connection.status<>'connected' THEN
    RAISE EXCEPTION 'provider connection is not connected' USING ERRCODE='55000';
  END IF;
  SELECT * INTO v_job FROM catalog_refresh_jobs
  WHERE connection_id=v_connection.id AND status IN ('pending','in_progress')
  ORDER BY created_at LIMIT 1 FOR UPDATE;
  IF FOUND THEN
    RETURN jsonb_build_object(
      'refresh_id',v_job.id,'status',v_job.status,
      'connection_id',v_connection.id,'duplicate',true
    );
  END IF;
  INSERT INTO catalog_refresh_jobs(operator_id,connection_id,reason)
  VALUES(v_connection.operator_id,v_connection.id,left(COALESCE(NULLIF(p_reason,''),'manual'),200))
  RETURNING * INTO v_job;
  PERFORM write_audit_event(NULL,NULL,NULL,'operator',p_operator_id::text,
    'catalog.refresh_requested','provider_connection',v_connection.id::text,
    'allowed',NULL,jsonb_build_object('provider',v_connection.provider,'reason',v_job.reason),
    COALESCE(v_job.id::text,v_connection.id::text));
  RETURN jsonb_build_object(
    'refresh_id',v_job.id,'status',v_job.status,
    'connection_id',v_connection.id,'duplicate',false
  );
END; $$;

-- Periodic refreshes are limited to supported, connected runtime providers.
-- A recent failure gets a bounded 15-minute backoff; an explicit owner request
-- may retry immediately through request_catalog_refresh.
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
      AND c.provider IN ('codex','opencode')
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

ALTER FUNCTION request_catalog_refresh(uuid,uuid,text)
  SET search_path=control_plane,public,extensions,pg_temp;
ALTER FUNCTION request_catalog_refreshes_due(interval)
  SET search_path=control_plane,public,extensions,pg_temp;

COMMIT;
