-- A reconnected model connection brings its catalog back (migration 0093).
\set ON_ERROR_STOP on

BEGIN;
SET search_path TO control_plane, public, extensions;

DO $$
DECLARE v_owner uuid; v_connection uuid; v_entry uuid;
BEGIN
  INSERT INTO users(display_name,role) VALUES('Reconnect owner','owner') RETURNING id INTO v_owner;
  INSERT INTO provider_connections(operator_id,provider,auth_method,status,access_gateway,billing_boundary,native_credential_reference)
    VALUES(v_owner,'opencode','api_key','connected','openrouter','third_party_metered','opencode-home:opencode-worker')
    RETURNING id INTO v_connection;
  INSERT INTO provider_model_catalog(operator_id,connection_id,runtime_type,provider_id,model_id,discovery_source,status,last_verified_at,verification_id)
    VALUES(v_owner,v_connection,'opencode','openrouter','openai/reconnect','opencode_provider_api','verified',clock_timestamp(),gen_random_uuid())
    RETURNING id INTO v_entry;

  UPDATE provider_connections SET status='disconnected' WHERE id=v_connection;
  IF (SELECT status FROM provider_model_catalog WHERE id=v_entry)<>'unavailable' THEN RAISE EXCEPTION 'a disconnected catalog stayed offered'; END IF;
  IF EXISTS (SELECT 1 FROM catalog_refresh_jobs WHERE connection_id=v_connection) THEN RAISE EXCEPTION 'a disconnect asked for a refresh'; END IF;

  UPDATE provider_connections SET status='connected' WHERE id=v_connection;
  IF (SELECT count(*) FROM catalog_refresh_jobs WHERE connection_id=v_connection AND status='pending' AND reason='reconnected')<>1 THEN
    RAISE EXCEPTION 'a reconnect did not ask for its catalog back';
  END IF;
  -- Connected again without a disconnect between: nothing more is queued.
  UPDATE provider_connections SET status='action_required' WHERE id=v_connection;
  UPDATE provider_connections SET status='connected' WHERE id=v_connection;
  IF (SELECT count(*) FROM catalog_refresh_jobs WHERE connection_id=v_connection)<>1 THEN
    RAISE EXCEPTION 'a refresh already waiting was queued twice';
  END IF;
  RAISE NOTICE 'a reconnected model connection asks for its catalog back, once';
END $$;

ROLLBACK;
