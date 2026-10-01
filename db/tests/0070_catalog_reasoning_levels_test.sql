-- The reasoning levels each model supports (migration 0110).
--
-- What this file pins down:
--
--   * a refresh that sends a model's levels as objects — Codex's
--     `{reasoningEffort, description}` normalised by the worker to
--     `{level, description, default}` — through upsert_catalog_entries unchanged
--     stores the names in reasoning_efforts (what every reader validates
--     against), the objects in reasoning_levels and the default beside them;
--   * a level that is not a bounded token, and a repeated one, are dropped,
--     because a level reaches a runtime's argv;
--   * the previous release's worker, which sends names, keeps the descriptions
--     and the default already known for the levels still listed, and loses the
--     default when it is no longer listed;
--   * a Claude row's levels are the documented table's for the model its check
--     resolved, whatever the worker sent, and change when the resolution does:
--     Opus 5.5 all five with medium the default, Sonnet 4.6 without xhigh,
--     Haiku none, a dated Opus 4 none, nothing before a check resolved it.
\set ON_ERROR_STOP on

BEGIN;
SET search_path TO control_plane, public, extensions;

DO $$
DECLARE
  v_owner uuid; v_opencode uuid; v_claude uuid; v_refresh uuid; v_claim jsonb; v_row provider_model_catalog%ROWTYPE;
  v_entry uuid;
BEGIN
  INSERT INTO users(display_name) VALUES('Reasoning owner') RETURNING id INTO v_owner;
  INSERT INTO provider_connections(operator_id,provider,auth_method,status,billing_boundary,native_credential_reference)
    VALUES(v_owner,'opencode','native','connected','free','opencode-home:opencode-worker') RETURNING id INTO v_opencode;

  -- Through the refresh path the worker uses.
  v_refresh := (request_catalog_refresh(v_opencode,v_owner,'reasoning-test')->>'refresh_id')::uuid;
  v_claim := claim_catalog_refresh_work('reasoning-test-worker',5,interval '2 minutes');
  IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_claim) c WHERE (c->>'refresh_id')::uuid=v_refresh) THEN
    RAISE EXCEPTION 'the refresh was not claimed: %', v_claim;
  END IF;
  PERFORM upsert_catalog_entries(v_refresh,'reasoning-test-worker',
    '[{"runtime_type":"opencode","provider_id":"opencode","model_id":"reasoning-a","discovery_source":"opencode_provider_api",
       "reasoning_efforts":[{"level":"low","description":"Fast answers"},
                            {"level":"medium","description":"Balanced","default":true},
                            {"level":"--model evil"},{"level":"low"},{"level":"high"},"max"]}]'::jsonb);
  SELECT * INTO v_row FROM provider_model_catalog WHERE connection_id=v_opencode AND model_id='reasoning-a';
  IF v_row.reasoning_efforts <> '["low","medium","high","max"]'::jsonb THEN
    RAISE EXCEPTION 'the names are not the bounded, unique levels in order: %', v_row.reasoning_efforts;
  END IF;
  IF v_row.reasoning_levels <> '[{"level":"low","description":"Fast answers"},{"level":"medium","description":"Balanced"},{"level":"high"},{"level":"max"}]'::jsonb THEN
    RAISE EXCEPTION 'the levels were not kept with their descriptions: %', v_row.reasoning_levels;
  END IF;
  IF v_row.default_reasoning_effort <> 'medium' THEN
    RAISE EXCEPTION 'the default was not kept: %', v_row.default_reasoning_effort;
  END IF;
  -- The existing validation reads the names, as it always has.
  UPDATE provider_model_catalog SET status='verified',last_verified_at=clock_timestamp(),verification_id=gen_random_uuid() WHERE id=v_row.id;
  IF resolve_catalog_snapshot_entry(v_row.id,'high')->>'reasoning_effort' IS DISTINCT FROM 'high' THEN
    RAISE EXCEPTION 'a listed level was refused';
  END IF;

  -- The previous release's worker: names only.
  UPDATE provider_model_catalog SET reasoning_efforts='["medium","high"]' WHERE id=v_row.id;
  SELECT * INTO v_row FROM provider_model_catalog WHERE id=v_row.id;
  IF v_row.reasoning_levels <> '[{"level":"medium","description":"Balanced"},{"level":"high"}]'::jsonb
     OR v_row.default_reasoning_effort <> 'medium' THEN
    RAISE EXCEPTION 'names from the previous release lost what was known: % / %', v_row.reasoning_levels, v_row.default_reasoning_effort;
  END IF;
  UPDATE provider_model_catalog SET reasoning_efforts='["high"]' WHERE id=v_row.id;
  SELECT * INTO v_row FROM provider_model_catalog WHERE id=v_row.id;
  IF v_row.default_reasoning_effort <> '' THEN
    RAISE EXCEPTION 'a default no longer listed was kept: %', v_row.default_reasoning_effort;
  END IF;
  -- A default the list does not hold cannot be written directly either.
  BEGIN
    UPDATE provider_model_catalog SET default_reasoning_effort='low' WHERE id=v_row.id;
    RAISE EXCEPTION 'a default outside the list was stored';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  -- Claude: the table, by the resolved model.
  INSERT INTO provider_connections(operator_id,provider,auth_method,status,billing_boundary,access_gateway,native_credential_reference)
    VALUES(v_owner,'claude','native','connected','subscription','claude_subscription','claude-home:claude-worker') RETURNING id INTO v_claude;
  INSERT INTO provider_model_catalog(operator_id,connection_id,runtime_type,provider_id,model_id,discovery_source,reasoning_efforts)
    VALUES(v_owner,v_claude,'claude','anthropic','opus','claude_aliases','[{"level":"ultra","default":true}]') RETURNING id INTO v_entry;
  SELECT * INTO v_row FROM provider_model_catalog WHERE id=v_entry;
  IF v_row.reasoning_efforts <> '[]'::jsonb OR v_row.default_reasoning_effort <> '' THEN
    RAISE EXCEPTION 'a Claude alias no check resolved has levels: %', v_row.reasoning_efforts;
  END IF;
  UPDATE provider_model_catalog SET resolved_model='claude-opus-5-5' WHERE id=v_entry;
  SELECT * INTO v_row FROM provider_model_catalog WHERE id=v_entry;
  IF v_row.reasoning_efforts <> '["low","medium","high","xhigh","max"]'::jsonb OR v_row.default_reasoning_effort <> 'medium' THEN
    RAISE EXCEPTION 'Opus 5.5: % / %', v_row.reasoning_efforts, v_row.default_reasoning_effort;
  END IF;
  UPDATE provider_model_catalog SET resolved_model='claude-sonnet-4-6[1m]' WHERE id=v_entry;
  SELECT * INTO v_row FROM provider_model_catalog WHERE id=v_entry;
  IF v_row.reasoning_efforts <> '["low","medium","high","max"]'::jsonb OR v_row.default_reasoning_effort <> 'high' THEN
    RAISE EXCEPTION 'Sonnet 4.6: % / %', v_row.reasoning_efforts, v_row.default_reasoning_effort;
  END IF;
  -- The worker cannot say otherwise.
  UPDATE provider_model_catalog SET reasoning_efforts='["ultra"]' WHERE id=v_entry;
  IF (SELECT reasoning_efforts FROM provider_model_catalog WHERE id=v_entry) <> '["low","medium","high","max"]'::jsonb THEN
    RAISE EXCEPTION 'a worker changed a Claude row''s levels';
  END IF;
  IF claude_reasoning_levels('claude-haiku-4-5-20251001') <> '{"levels":[],"default":""}'::jsonb
     OR claude_reasoning_levels('claude-opus-4-20250514') <> '{"levels":[],"default":""}'::jsonb
     OR claude_reasoning_levels('claude-opus-4-7-20260101')->>'default' <> 'xhigh'
     OR claude_reasoning_levels('claude-fable-5-1')->'levels' <> '["low","medium","high","xhigh","max"]'::jsonb
     OR claude_reasoning_levels(NULL)->'levels' <> '[]'::jsonb THEN
    RAISE EXCEPTION 'the Claude table does not read resolved ids as documented';
  END IF;

  -- Nobody but the database calls the table or the trigger.
  IF has_function_privilege('infra_web','claude_reasoning_levels(text)','EXECUTE')
     OR has_function_privilege('infra_worker','normalize_catalog_reasoning()','EXECUTE') THEN
    RAISE EXCEPTION 'the reasoning helpers are executable by a service role';
  END IF;

  RAISE NOTICE 'catalog reasoning levels are normalised from objects and names, bounded, and Claude''s follow its resolved model';
END $$;

ROLLBACK;

-- 0118: a second refresh of the same model keeps what the first one knew —
-- on the host after rc.92 every Codex row lost its descriptions and default.
BEGIN;
SET search_path TO control_plane, public, extensions;
DO $$
DECLARE v_owner uuid; v_conn uuid; v_refresh uuid; v_row provider_model_catalog%ROWTYPE; v_entries jsonb;
BEGIN
  INSERT INTO users(display_name) VALUES('Refresh twice') RETURNING id INTO v_owner;
  INSERT INTO provider_connections(operator_id,provider,auth_method,status,billing_boundary,native_credential_reference)
    VALUES(v_owner,'opencode','native','connected','free','opencode-home:opencode-worker') RETURNING id INTO v_conn;
  v_entries := '[{"runtime_type":"opencode","provider_id":"opencode","model_id":"twice","discovery_source":"opencode_provider_api",
     "reasoning_efforts":[{"level":"low","description":"Fast"},{"level":"medium","description":"Balanced","default":true}]}]';
  FOR i IN 1..2 LOOP
    v_refresh := (request_catalog_refresh(v_conn,v_owner,'twice')->>'refresh_id')::uuid;
    PERFORM claim_catalog_refresh_work('twice-worker',5,interval '2 minutes');
    PERFORM upsert_catalog_entries(v_refresh,'twice-worker',v_entries);
    PERFORM complete_catalog_refresh(v_refresh,'twice-worker',
      ARRAY(SELECT id FROM provider_model_catalog WHERE connection_id=v_conn AND model_id='twice'));
  END LOOP;
  SELECT * INTO v_row FROM provider_model_catalog WHERE connection_id=v_conn AND model_id='twice';
  IF v_row.default_reasoning_effort <> 'medium' OR v_row.reasoning_levels->0->>'description' IS DISTINCT FROM 'Fast' THEN
    RAISE EXCEPTION 'a second refresh lost the default or the descriptions: % / %', v_row.default_reasoning_effort, v_row.reasoning_levels;
  END IF;
  RAISE NOTICE 'a refresh keeps the levels'' descriptions and the default';
END $$;
ROLLBACK;
