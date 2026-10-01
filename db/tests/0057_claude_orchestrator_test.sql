-- Claude Code as an orchestrator (migration 0091, sprint C K2).
--
-- What this file pins down:
--
--   * the operator's Claude subscription is connected from the panel only once
--     the host reports the runtime installed and signed in — each missing step
--     refused by its own reason — and connecting asks for its catalog;
--   * disconnecting is what dispatch reads as revoked, and connecting again
--     reuses the one connection;
--   * a Claude connection has one shape: the subscription, signed in natively
--     as claude-worker;
--   * Claude Code plays the orchestrator and is refused as an executor;
--   * its aliases are catalog entries of their own source, Anthropic's.
\set ON_ERROR_STOP on

BEGIN;
SET search_path TO control_plane, public, extensions;

CREATE FUNCTION pg_temp.reason_of(p_sql text) RETURNS text LANGUAGE plpgsql AS $$
DECLARE v_detail text;
BEGIN
  EXECUTE p_sql;
  RETURN NULL;
EXCEPTION WHEN OTHERS THEN
  GET STACKED DIAGNOSTICS v_detail = PG_EXCEPTION_DETAIL;
  IF v_detail IS NULL OR left(v_detail, 1) <> '{' THEN RETURN 'NO_DETAIL: ' || SQLERRM; END IF;
  RETURN v_detail::jsonb->>'reason';
END $$;

-- The host's report of Claude Code, as the health snapshot writes it.
CREATE FUNCTION pg_temp.report(p_installed boolean, p_authenticated boolean) RETURNS void LANGUAGE sql AS $$
  INSERT INTO runtime_health(singleton,status,snapshot,observed_at) VALUES(true,'healthy',
    jsonb_build_object('type','health.snapshot','status','healthy','runtimes',jsonb_build_array(
      jsonb_build_object('runtime','claude','version','2.1.270','installed',p_installed,'authenticated',p_authenticated,
        'capability_verified',false,'ready',false))),
    clock_timestamp())
  ON CONFLICT (singleton) DO UPDATE SET status=EXCLUDED.status,snapshot=EXCLUDED.snapshot,observed_at=EXCLUDED.observed_at $$;

DO $$
DECLARE
  v_owner uuid; v_stranger uuid; v_result jsonb; v_again jsonb; v_reason text; v_connection uuid;
  v_project uuid; v_profile uuid; v_agent uuid; v_card jsonb;
BEGIN
  INSERT INTO users(display_name,role) VALUES('Claude owner','owner') RETURNING id INTO v_owner;
  INSERT INTO users(display_name,role) VALUES('Claude stranger','owner') RETURNING id INTO v_stranger;

  -- Each missing step, by its own reason.
  UPDATE runtime_health SET observed_at=clock_timestamp()-interval '1 day' WHERE singleton;
  DELETE FROM runtime_health WHERE singleton;
  v_reason:=pg_temp.reason_of(format('SELECT connect_claude_connection(%L,''o'',''c'')', v_owner));
  IF v_reason<>'runtime_readiness_unknown' THEN RAISE EXCEPTION 'connected with no report: %', v_reason; END IF;
  PERFORM pg_temp.report(false, false);
  v_reason:=pg_temp.reason_of(format('SELECT connect_claude_connection(%L,''o'',''c'')', v_owner));
  IF v_reason<>'runtime_not_provisioned' THEN RAISE EXCEPTION 'connected with nothing installed: %', v_reason; END IF;
  PERFORM pg_temp.report(true, false);
  v_reason:=pg_temp.reason_of(format('SELECT connect_claude_connection(%L,''o'',''c'')', v_owner));
  IF v_reason<>'claude_not_signed_in' THEN RAISE EXCEPTION 'connected while signed out: %', v_reason; END IF;
  v_card:=get_operator_claude_connection(v_owner);
  IF v_card->'connection'<>'null'::jsonb OR (v_card->'runtime'->>'authenticated')::boolean IS NOT FALSE THEN
    RAISE EXCEPTION 'the card does not say signed out and unconnected: %', v_card;
  END IF;

  -- Signed in: connected, and its catalog asked for.
  PERFORM pg_temp.report(true, true);
  v_result:=connect_claude_connection(v_owner, 'operator', 'c-connect');
  v_connection:=(v_result->>'connection_id')::uuid;
  IF v_result->>'status'<>'connected' OR (v_result->'refresh'->>'refresh_id') IS NULL THEN
    RAISE EXCEPTION 'connect result: %', v_result;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM provider_connections WHERE id=v_connection AND provider='claude'
                 AND access_gateway='claude_subscription' AND billing_boundary='subscription'
                 AND connection_kind='model_access' AND native_credential_reference='claude-home:claude-worker') THEN
    RAISE EXCEPTION 'the connection is not the subscription''s shape';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM audit_events WHERE action='provider_connection.connected' AND target_id=v_connection::text) THEN
    RAISE EXCEPTION 'the connect is not audited';
  END IF;
  IF connection_revoked(v_connection) THEN RAISE EXCEPTION 'a connected Claude subscription reads as revoked'; END IF;

  -- Off, and on again: the same connection.
  v_reason:=pg_temp.reason_of(format('SELECT disconnect_claude_connection(%L,%L,''o'',''c'')', v_stranger, v_connection));
  IF v_reason<>'provider_connection_unavailable' THEN RAISE EXCEPTION 'a stranger disconnected it: %', v_reason; END IF;
  PERFORM disconnect_claude_connection(v_owner, v_connection, 'operator', 'c-off');
  IF NOT connection_revoked(v_connection) THEN RAISE EXCEPTION 'a disconnected Claude subscription is not revoked for dispatch'; END IF;
  v_again:=connect_claude_connection(v_owner, 'operator', 'c-on');
  IF (v_again->>'connection_id')::uuid<>v_connection OR v_again->>'status'<>'connected' THEN
    RAISE EXCEPTION 'reconnecting made another connection: %', v_again;
  END IF;

  -- One shape.
  BEGIN
    INSERT INTO provider_connections(operator_id,provider,auth_method,status,access_gateway,billing_boundary,native_credential_reference)
    VALUES(v_stranger,'claude','api_key','connected','claude_subscription','direct_metered','claude-home:claude-worker');
    RAISE EXCEPTION 'a Claude connection of another shape was accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  -- The orchestrator, never the executor.
  INSERT INTO projects(owner_id,name,slug,workspace_path,status)
    VALUES(v_owner,'Claude','claude-k2','/srv/infra-cod/workspaces/claude-k2','active') RETURNING id INTO v_project;
  v_profile:=ensure_structural_runtime_profile(v_owner,'claude');
  INSERT INTO agents(name,runtime_profile_id) VALUES('claude-orchestrator',v_profile) RETURNING id INTO v_agent;
  INSERT INTO project_agent_assignments(project_id,agent_id,runtime_profile_id,role_definition_id,is_default,created_at)
    VALUES(v_project,v_agent,v_profile,(SELECT id FROM role_definitions WHERE builtin_key='orchestrator'),true,clock_timestamp());
  v_reason:=pg_temp.reason_of(format(
    'INSERT INTO project_agent_assignments(project_id,agent_id,runtime_profile_id,role_definition_id,created_at) VALUES(%L,%L,%L,(SELECT id FROM role_definitions WHERE builtin_key=''executor''),clock_timestamp())',
    v_project, v_agent, v_profile));
  IF v_reason<>'runtime_cannot_play_role' THEN RAISE EXCEPTION 'Claude Code was made an executor: %', v_reason; END IF;

  -- Its aliases: their own source, Anthropic's.
  IF catalog_model_vendor('claude_subscription','claude','sonnet')<>'anthropic' THEN RAISE EXCEPTION 'a Claude model is not Anthropic''s'; END IF;
  INSERT INTO provider_model_catalog(operator_id,connection_id,runtime_type,provider_id,model_id,display_name,discovery_source,status)
    VALUES(v_owner,v_connection,'claude','anthropic','sonnet','Claude Sonnet','claude_aliases','discovered');

  RAISE NOTICE 'Claude Code is connected when the host says it is signed in, orchestrates, and never executes';
END $$;

ROLLBACK;
