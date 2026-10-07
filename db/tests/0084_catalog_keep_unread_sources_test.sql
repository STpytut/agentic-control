-- Migration 0137: a refresh that could not read a source leaves that source's
-- models as they were; one that read it marks the missing ones unavailable.
\set ON_ERROR_STOP on

BEGIN;
SET search_path TO control_plane, public, extensions;

DO $$
DECLARE
  v_owner uuid; v_conn uuid; v_listed uuid; v_alias uuid; v_refresh uuid; v_upsert jsonb;
BEGIN
  IF has_function_privilege('infra_web', 'control_plane.complete_catalog_refresh(uuid,text,uuid[],text,text[])', 'EXECUTE')
     OR NOT has_function_privilege('infra_worker', 'control_plane.complete_catalog_refresh(uuid,text,uuid[],text,text[])', 'EXECUTE') THEN
    RAISE EXCEPTION 'complete_catalog_refresh grants are not the worker''s alone';
  END IF;

  INSERT INTO users(display_name,role) VALUES('Unread owner','owner') RETURNING id INTO v_owner;
  INSERT INTO provider_connections(operator_id,provider,auth_method,status,billing_boundary,access_gateway,native_credential_reference)
    VALUES(v_owner,'claude','native','connected','subscription','claude_subscription','claude-home:claude-worker') RETURNING id INTO v_conn;
  INSERT INTO provider_model_catalog(operator_id,connection_id,runtime_type,provider_id,model_id,discovery_source)
    VALUES(v_owner,v_conn,'claude','anthropic','claude-sonnet-5-5','anthropic_models') RETURNING id INTO v_listed;
  INSERT INTO provider_model_catalog(operator_id,connection_id,runtime_type,provider_id,model_id,discovery_source)
    VALUES(v_owner,v_conn,'claude','anthropic','retired-alias','claude_aliases') RETURNING id INTO v_alias;
  UPDATE catalog_refresh_jobs SET status='failed', failure_code='test-isolation' WHERE status IN ('pending','in_progress');

  -- The list was not read: the listed model keeps its status, the alias the
  -- refresh did read and did not see is marked as before.
  v_refresh := (request_catalog_refresh(v_conn, v_owner, 'unread')->>'refresh_id')::uuid;
  PERFORM claim_catalog_refresh_work('unread-worker', 5, interval '2 minutes');
  v_upsert := upsert_catalog_entries(v_refresh, 'unread-worker',
    '[{"runtime_type":"claude","provider_id":"anthropic","model_id":"sonnet","discovery_source":"claude_aliases"}]');
  PERFORM complete_catalog_refresh(v_refresh, 'unread-worker',
    ARRAY(SELECT x::uuid FROM jsonb_array_elements_text(v_upsert->'seen_entry_ids') t(x)), 'unavailable', ARRAY['anthropic_models']);
  IF (SELECT status FROM provider_model_catalog WHERE id = v_listed) = 'unavailable' THEN
    RAISE EXCEPTION 'an unread list marked its model unavailable';
  END IF;
  IF (SELECT status FROM provider_model_catalog WHERE id = v_alias) <> 'unavailable' THEN
    RAISE EXCEPTION 'a read source''s missing model is %', (SELECT status FROM provider_model_catalog WHERE id = v_alias);
  END IF;

  -- The list was read and did not name it: now it is unavailable, through the
  -- four-argument form an older worker still calls.
  v_refresh := (request_catalog_refresh(v_conn, v_owner, 'read')->>'refresh_id')::uuid;
  PERFORM claim_catalog_refresh_work('unread-worker', 5, interval '2 minutes');
  v_upsert := upsert_catalog_entries(v_refresh, 'unread-worker',
    '[{"runtime_type":"claude","provider_id":"anthropic","model_id":"sonnet","discovery_source":"claude_aliases"}]');
  PERFORM complete_catalog_refresh(v_refresh, 'unread-worker',
    ARRAY(SELECT x::uuid FROM jsonb_array_elements_text(v_upsert->'seen_entry_ids') t(x)), 'unavailable');
  IF (SELECT status FROM provider_model_catalog WHERE id = v_listed) <> 'unavailable' THEN
    RAISE EXCEPTION 'a read list kept a model it did not name';
  END IF;
  RAISE NOTICE 'catalog unread-source assertions passed';
END $$;

ROLLBACK;
