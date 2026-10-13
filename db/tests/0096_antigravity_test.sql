-- Antigravity as an analyst (migration 0157, rc.150).
--
--   * the registry's mirror: Antigravity plays the analyst and nothing else,
--     with the driver's capabilities, and an orchestrator or executor
--     assignment to it is refused by reason;
--   * the connection: refused by its own reason until the host reports the
--     runtime installed and signed in, then connected with its gateway and
--     shape, its catalog asked for, and disconnected only by its owner;
--   * the catalog: `agy models` entries under their own source, each model's
--     vendor read from its id;
--   * the sign-in: a runtime login for any runtime whose driver declares
--     account.login — Antigravity's beside Claude Code's, each one open at a
--     time, a Google code with its slashes accepted, the worker's claim
--     naming the runtime — and refused for a runtime without the capability.
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

-- The host's report of Antigravity, as the health snapshot writes it.
CREATE FUNCTION pg_temp.report(p_installed boolean, p_authenticated boolean) RETURNS void LANGUAGE sql AS $$
  INSERT INTO runtime_health(singleton,status,snapshot,observed_at) VALUES(true,'healthy',
    jsonb_build_object('type','health.snapshot','status','healthy','runtimes',jsonb_build_array(
      jsonb_build_object('runtime','antigravity','version','1.3.4','installed',p_installed,'authenticated',p_authenticated,
        'capability_verified',false,'ready',false))),
    clock_timestamp())
  ON CONFLICT (singleton) DO UPDATE SET status=EXCLUDED.status,snapshot=EXCLUDED.snapshot,observed_at=EXCLUDED.observed_at $$;

-- The mirror ----------------------------------------------------------------
DO $$
DECLARE v_owner uuid; v_project uuid; v_profile uuid; v_agent uuid; v_reason text; v_capabilities text[];
BEGIN
  IF NOT runtime_plays('antigravity','analyst') THEN RAISE EXCEPTION 'Antigravity does not play the analyst'; END IF;
  IF runtime_plays('antigravity','orchestrator') OR runtime_plays('antigravity','executor') OR runtime_plays('antigravity','pr_reviewer') THEN
    RAISE EXCEPTION 'Antigravity plays a role the platform''s tools cannot reach';
  END IF;
  SELECT array_agg(capability ORDER BY capability) INTO v_capabilities FROM runtime_capabilities WHERE runtime_type='antigravity';
  IF v_capabilities IS DISTINCT FROM ARRAY['account.login','catalog.models','events.raw','gate.smoke','interrupt','run.read_only',
      'sessions.create','sessions.resume','stream.structured','usage.report'] THEN
    RAISE EXCEPTION 'the capability mirror is not the driver''s: %', v_capabilities;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM failure_reasons WHERE reason IN ('antigravity_not_signed_in','runtime_login_unsupported') HAVING count(*)=2) THEN
    RAISE EXCEPTION 'the failure reasons are missing';
  END IF;

  INSERT INTO users(display_name,role) VALUES('Antigravity owner','owner') RETURNING id INTO v_owner;
  INSERT INTO projects(owner_id,name,slug,workspace_path,status)
    VALUES(v_owner,'Antigravity','antigravity-mirror','/srv/infra-cod/workspaces/antigravity-mirror','active') RETURNING id INTO v_project;
  v_profile:=ensure_structural_runtime_profile(v_owner,'antigravity');
  INSERT INTO agents(name,runtime_profile_id) VALUES('antigravity-agent',v_profile) RETURNING id INTO v_agent;
  FOREACH v_reason IN ARRAY ARRAY['orchestrator','executor'] LOOP
    v_reason:=pg_temp.reason_of(format(
      'INSERT INTO project_agent_assignments(project_id,agent_id,runtime_profile_id,role_definition_id,created_at) VALUES(%L,%L,%L,(SELECT id FROM role_definitions WHERE builtin_key=%L),clock_timestamp())',
      v_project, v_agent, v_profile, v_reason));
    IF v_reason<>'runtime_cannot_play_role' THEN RAISE EXCEPTION 'Antigravity was assigned a role it does not play: %', v_reason; END IF;
  END LOOP;
  RAISE NOTICE 'Antigravity plays the analyst, with its driver''s capabilities, and nothing else';
END $$;

-- The connection and the catalog ------------------------------------------------
DO $$
DECLARE
  v_owner uuid; v_stranger uuid; v_result jsonb; v_again jsonb; v_reason text; v_connection uuid; v_card jsonb;
  v_row provider_connections%ROWTYPE;
BEGIN
  INSERT INTO users(display_name,role) VALUES('Antigravity owner','owner') RETURNING id INTO v_owner;
  INSERT INTO users(display_name,role) VALUES('Antigravity stranger','owner') RETURNING id INTO v_stranger;

  -- Each missing step, by its own reason.
  UPDATE runtime_health SET observed_at=clock_timestamp()-interval '1 day' WHERE singleton;
  DELETE FROM runtime_health WHERE singleton;
  v_reason:=pg_temp.reason_of(format('SELECT connect_antigravity_connection(%L,''o'',''c'')', v_owner));
  IF v_reason<>'runtime_readiness_unknown' THEN RAISE EXCEPTION 'connected with no report: %', v_reason; END IF;
  PERFORM pg_temp.report(false, false);
  v_reason:=pg_temp.reason_of(format('SELECT connect_antigravity_connection(%L,''o'',''c'')', v_owner));
  IF v_reason<>'runtime_not_provisioned' THEN RAISE EXCEPTION 'connected with nothing installed: %', v_reason; END IF;
  PERFORM pg_temp.report(true, false);
  v_reason:=pg_temp.reason_of(format('SELECT connect_antigravity_connection(%L,''o'',''c'')', v_owner));
  IF v_reason<>'antigravity_not_signed_in' THEN RAISE EXCEPTION 'connected while signed out: %', v_reason; END IF;
  v_card:=get_operator_antigravity_connection(v_owner);
  IF v_card->'connection'<>'null'::jsonb OR (v_card->'runtime'->>'authenticated')::boolean IS NOT FALSE THEN
    RAISE EXCEPTION 'the card does not say signed out and unconnected: %', v_card;
  END IF;

  -- Signed in: connected with its gateway and shape, and its catalog asked for.
  PERFORM pg_temp.report(true, true);
  v_result:=connect_antigravity_connection(v_owner, 'operator', 'a-connect');
  v_connection:=(v_result->>'connection_id')::uuid;
  SELECT * INTO v_row FROM provider_connections WHERE id=v_connection;
  IF v_row.provider<>'antigravity' OR v_row.access_gateway<>'google_antigravity' OR v_row.billing_boundary<>'subscription'
     OR v_row.auth_method<>'native' OR v_row.native_credential_reference<>'antigravity-home:antigravity-worker' OR v_row.status<>'connected' THEN
    RAISE EXCEPTION 'the connection is not the Google account signed in as antigravity-worker: %', to_jsonb(v_row) - 'native_credential_reference';
  END IF;
  IF v_result->'refresh'->>'refresh_id' IS NULL THEN RAISE EXCEPTION 'connecting did not ask for the catalog: %', v_result; END IF;
  IF (get_operator_antigravity_connection(v_owner)->'connection'->>'status')<>'connected' THEN RAISE EXCEPTION 'the card does not say connected'; END IF;

  -- The shape holds whoever writes the row.
  v_reason:=pg_temp.reason_of(format(
    'INSERT INTO provider_connections(operator_id,provider,auth_method,status,billing_boundary,native_credential_reference) VALUES(%L,''antigravity'',''api_key'',''connected'',''subscription'',''antigravity-home:antigravity-worker'')', v_stranger));
  IF v_reason IS NULL THEN RAISE EXCEPTION 'an Antigravity connection of another shape was accepted'; END IF;
  v_reason:=pg_temp.reason_of(format(
    'INSERT INTO provider_connections(operator_id,provider,auth_method,status,access_gateway,billing_boundary,native_credential_reference) VALUES(%L,''antigravity'',''native'',''connected'',''claude_subscription'',''subscription'',''antigravity-home:antigravity-worker'')', v_stranger));
  IF v_reason IS NULL THEN RAISE EXCEPTION 'an Antigravity connection on another gateway was accepted'; END IF;

  -- Off by its owner only, and on again as the same row.
  v_reason:=pg_temp.reason_of(format('SELECT disconnect_antigravity_connection(%L,%L,''o'',''c'')', v_stranger, v_connection));
  IF v_reason<>'provider_connection_unavailable' THEN RAISE EXCEPTION 'a stranger disconnected it: %', v_reason; END IF;
  PERFORM disconnect_antigravity_connection(v_owner, v_connection, 'operator', 'a-off');
  IF (SELECT status FROM provider_connections WHERE id=v_connection)<>'disconnected' THEN RAISE EXCEPTION 'not disconnected'; END IF;
  v_again:=connect_antigravity_connection(v_owner, 'operator', 'a-on');
  IF (v_again->>'connection_id')::uuid<>v_connection THEN RAISE EXCEPTION 'reconnecting made a second connection'; END IF;

  -- Its models: `agy models` under their own source, each vendor read from the id.
  IF catalog_model_vendor('google_antigravity','antigravity','gemini-3.8-flash-high')<>'google'
     OR catalog_model_vendor('google_antigravity','antigravity','claude-sonnet-4-6')<>'anthropic'
     OR catalog_model_vendor('google_antigravity','antigravity','gpt-oss-120b-medium')<>'openai'
     OR catalog_model_vendor('google_antigravity','antigravity','something-else')<>'google' THEN
    RAISE EXCEPTION 'an Antigravity model''s vendor is not read from its id';
  END IF;
  INSERT INTO provider_model_catalog(operator_id,connection_id,runtime_type,provider_id,model_id,display_name,discovery_source,status)
    VALUES(v_owner,v_connection,'antigravity','google','gemini-3.8-flash-high','Gemini 3.8 Flash (high)','antigravity_models','discovered');
  IF (SELECT access_gateway FROM provider_model_catalog WHERE connection_id=v_connection)<>'google_antigravity' THEN
    RAISE EXCEPTION 'the catalog row did not take the connection''s gateway';
  END IF;
  v_reason:=pg_temp.reason_of(format(
    'INSERT INTO provider_model_catalog(operator_id,connection_id,runtime_type,provider_id,model_id,display_name,discovery_source,status) VALUES(%L,%L,''antigravity'',''google'',''other'',''Other'',''nowhere'',''discovered'')', v_owner, v_connection));
  IF v_reason IS NULL THEN RAISE EXCEPTION 'nothing refused a model under an unknown source'; END IF;

  RAISE NOTICE 'Antigravity is connected when the host says it is signed in, with its gateway and shape, and its models have their own source';
END $$;

-- The sign-in ------------------------------------------------------------------
DO $$
DECLARE v_owner uuid; v_claude jsonb; v_session jsonb; v_second jsonb; v_claim jsonb; v_taken jsonb; v_reason text;
BEGIN
  INSERT INTO users(display_name,role) VALUES('Sign-in owner','owner') RETURNING id INTO v_owner;

  -- A runtime without the capability has no sign-in by a code.
  v_reason:=pg_temp.reason_of(format('SELECT start_runtime_login(%L,''opencode'')', v_owner));
  IF v_reason<>'runtime_login_unsupported' THEN RAISE EXCEPTION 'OpenCode was given a paste-code sign-in: %', v_reason; END IF;
  v_reason:=pg_temp.reason_of(format('SELECT start_runtime_login(%L,''nobody'')', v_owner));
  IF v_reason<>'runtime_login_unsupported' THEN RAISE EXCEPTION 'an unknown runtime was given a sign-in: %', v_reason; END IF;

  -- Claude Code's and Antigravity's, open at the same time, each one at a time.
  v_claude:=start_claude_login(v_owner);
  v_session:=start_runtime_login(v_owner,'antigravity');
  IF v_session->>'runtime_type'<>'antigravity' OR v_claude->>'runtime_type'<>'claude' THEN
    RAISE EXCEPTION 'a sign-in does not say its runtime: % / %', v_session, v_claude;
  END IF;
  IF (SELECT status FROM claude_login_sessions WHERE id=(v_claude->>'id')::uuid)<>'requested' THEN
    RAISE EXCEPTION 'starting Antigravity''s sign-in cancelled Claude Code''s';
  END IF;
  v_second:=start_runtime_login(v_owner,'antigravity');
  IF (SELECT status FROM claude_login_sessions WHERE id=(v_session->>'id')::uuid)<>'cancelled' THEN
    RAISE EXCEPTION 'a second Antigravity sign-in left the first open';
  END IF;
  IF (get_runtime_login(v_owner,'antigravity')->>'id')<>(v_second->>'id') OR (get_claude_login(v_owner)->>'id')<>(v_claude->>'id') THEN
    RAISE EXCEPTION 'each runtime''s latest sign-in is not read by runtime';
  END IF;

  -- The worker's claim names the runtime; the Google code, slashes and all, reaches it once.
  v_claim:=claim_claude_logins('account-worker-test', 5);
  IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_claim) e WHERE e->>'id'=v_second->>'id' AND e->>'runtime_type'='antigravity')
     OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_claim) e WHERE e->>'id'=v_claude->>'id' AND e->>'runtime_type'='claude') THEN
    RAISE EXCEPTION 'the claim does not name each sign-in''s runtime: %', v_claim;
  END IF;
  PERFORM record_claude_login((v_second->>'id')::uuid, 'account-worker-test', 'url', 'https://accounts.google.com/o/oauth2/v2/auth?x');
  v_reason:=pg_temp.reason_of(format('SELECT submit_claude_login_code(%L,%L,''4/0AX4XfWh-abc_def.ghi'')', v_owner, (v_second->>'id')::uuid));
  IF v_reason IS NOT NULL THEN RAISE EXCEPTION 'a Google code was refused: %', v_reason; END IF;
  v_taken:=record_claude_login((v_second->>'id')::uuid, 'account-worker-test', 'take_code');
  IF v_taken->>'code'<>'4/0AX4XfWh-abc_def.ghi' THEN RAISE EXCEPTION 'the worker did not take the code: %', v_taken; END IF;
  IF (SELECT auth_code FROM claude_login_sessions WHERE id=(v_second->>'id')::uuid) IS NOT NULL THEN
    RAISE EXCEPTION 'the code stayed after it was taken';
  END IF;
  PERFORM record_claude_login((v_second->>'id')::uuid, 'account-worker-test', 'succeeded');
  IF (get_runtime_login(v_owner,'antigravity')->>'status')<>'succeeded' THEN RAISE EXCEPTION 'the sign-in did not end as succeeded'; END IF;
  IF get_runtime_login(v_owner,'antigravity') ? 'auth_code' THEN RAISE EXCEPTION 'the view shows the code'; END IF;

  RAISE NOTICE 'the paste-code sign-in is a runtime''s: Antigravity''s beside Claude Code''s, by the capability mirror';
END $$;

ROLLBACK;
