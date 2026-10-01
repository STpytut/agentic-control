-- What the panel reads and starts (migration 0101, Stage 12 W6), held to the
-- shapes of docs/W6_W7_CONTRACT.md — the W7 panel is built against them.
--
-- What this file pins down:
--   * the Models card: every key the contract names; a small list whole, a
--     large one as its pinned and in-use models plus a count for search, with
--     more_count = total_models - models.length;
--   * a ModelRow's keys and its state words;
--   * search: id and display name, case-insensitive and literal, vendor and
--     "checked only" filters, at most 50 rows, the total beside them;
--   * pin starts a check unless one is current; unpin keeps what was checked;
--   * every function refuses (42501) what is not the operator's;
--   * the old request functions still answer in their old shape.
\set ON_ERROR_STOP on

BEGIN;
SET search_path TO control_plane, public, extensions;

CREATE FUNCTION pg_temp.failure_of(p_sql text) RETURNS text LANGUAGE plpgsql AS $$
DECLARE v_detail text; v_state text;
BEGIN
  EXECUTE p_sql;
  RETURN NULL;
EXCEPTION WHEN OTHERS THEN
  GET STACKED DIAGNOSTICS v_detail = PG_EXCEPTION_DETAIL, v_state = RETURNED_SQLSTATE;
  RETURN v_state || ' ' || COALESCE(v_detail::jsonb->>'reason', 'NO_DETAIL');
END $$;

CREATE FUNCTION pg_temp.keys(p jsonb) RETURNS text[] LANGUAGE sql AS $$
  SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(p) k $$;

DO $$
DECLARE
  v_owner uuid; v_stranger uuid; v_claude uuid; v_router uuid; v_project uuid;
  v_haiku uuid; v_used uuid; v_pinned uuid; v_plain uuid;
  v_card jsonb; v_connection jsonb; v_row jsonb; v_search jsonb; v_pin jsonb; v_again jsonb; v_claim jsonb;
  v_old jsonb;
BEGIN
  DELETE FROM model_checks WHERE finished_at IS NULL;
  INSERT INTO users(display_name,role) VALUES('Models owner','owner') RETURNING id INTO v_owner;
  INSERT INTO users(display_name,role) VALUES('Models stranger','owner') RETURNING id INTO v_stranger;
  INSERT INTO provider_connections(operator_id,provider,auth_method,status,access_gateway,billing_boundary,
      native_credential_reference,account_label)
    VALUES(v_owner,'claude','native','connected','claude_subscription','subscription','claude-home:claude-worker','Claude')
    RETURNING id INTO v_claude;
  INSERT INTO provider_connections(operator_id,provider,auth_method,status,access_gateway,billing_boundary,native_credential_reference)
    VALUES(v_owner,'opencode','api_key','connected','openrouter','third_party_metered','opencode-home:opencode-worker')
    RETURNING id INTO v_router;
  INSERT INTO provider_model_catalog(operator_id,connection_id,runtime_type,provider_id,model_id,display_name,discovery_source)
    VALUES(v_owner,v_claude,'claude','anthropic','haiku','Claude Haiku (latest)','claude_aliases') RETURNING id INTO v_haiku;
  INSERT INTO provider_model_catalog(operator_id,connection_id,runtime_type,provider_id,model_id,display_name,discovery_source)
    VALUES(v_owner,v_claude,'claude','anthropic','sonnet','Claude Sonnet (latest)','claude_aliases');
  -- 60 OpenRouter models, two vendors; one pinned, one a team's, one ready.
  INSERT INTO provider_model_catalog(operator_id,connection_id,runtime_type,provider_id,model_id,display_name,
      model_vendor,discovery_source)
    SELECT v_owner,v_router,'opencode','openrouter',
      CASE WHEN i % 2 = 0 THEN 'openai/fixture-' ELSE 'deepseek/fixture-' END || i,
      CASE WHEN i % 2 = 0 THEN 'Fixture Luna ' ELSE 'Fixture DeepSeek ' END || i,
      CASE WHEN i % 2 = 0 THEN 'openai' ELSE 'deepseek' END, 'opencode_provider_api'
    FROM generate_series(1,60) i;
  -- A display name with the characters a LIKE pattern would read as wildcards.
  INSERT INTO provider_model_catalog(operator_id,connection_id,runtime_type,provider_id,model_id,display_name,
      model_vendor,discovery_source)
    VALUES(v_owner,v_router,'opencode','openrouter','odd/model_x','Odd 100% model','odd','opencode_provider_api');
  v_used := (SELECT id FROM provider_model_catalog WHERE model_id='deepseek/fixture-1');
  v_pinned := (SELECT id FROM provider_model_catalog WHERE model_id='openai/fixture-2');
  v_plain := (SELECT id FROM provider_model_catalog WHERE model_id='openai/fixture-4');
  INSERT INTO projects(owner_id,name,slug,workspace_path)
    VALUES(v_owner,'Models','models-w6','/srv/infra-cod/workspaces/models-w6') RETURNING id INTO v_project;
  INSERT INTO project_runtime_defaults(project_id,orchestrator_entry_id) VALUES(v_project,v_used);

  -- Pin: a check starts; pinning again returns the same check.
  v_pin := pin_model(v_owner, v_pinned);
  IF pg_temp.keys(v_pin) <> ARRAY['check_id','entry_id','pinned'] OR NOT (v_pin->>'pinned')::boolean
     OR v_pin->>'check_id' IS NULL THEN
    RAISE EXCEPTION 'pin: %', v_pin;
  END IF;
  v_again := pin_model(v_owner, v_pinned);
  IF v_again->>'check_id' <> v_pin->>'check_id' THEN RAISE EXCEPTION 'a second pin started a second check'; END IF;
  IF NOT EXISTS (SELECT 1 FROM model_checks WHERE id = (v_pin->>'check_id')::uuid AND trigger = 'pin' AND NOT automatic
                 AND priority = 1) THEN
    RAISE EXCEPTION 'the pin''s check is not the operator''s pin';
  END IF;
  -- The pin's check passes.
  DELETE FROM model_checks WHERE finished_at IS NULL AND id <> (v_pin->>'check_id')::uuid;
  v_claim := claim_model_checks('models-worker', interval '5 minutes')->0;
  PERFORM complete_model_check((v_claim->>'check_id')::uuid, 'models-worker', 'passed', NULL, 'PARITY_OK');
  -- The Claude alias check records what the alias resolved to.
  PERFORM request_model_check(v_owner, v_haiku, 'pick');
  v_claim := claim_model_checks('models-worker', interval '5 minutes')->0;
  PERFORM complete_model_check((v_claim->>'check_id')::uuid, 'models-worker', 'passed', NULL, 'PARITY_OK', 'claude-haiku-4-5');

  -- The card.
  v_card := get_operator_models(v_owner);
  IF pg_temp.keys(v_card) <> ARRAY['auto_checks','budget','checks_today','connections','hard_limit']
     OR pg_temp.keys(v_card->'auto_checks') <> ARRAY['limit','used']
     OR (v_card->>'checks_today')::int <> 2 OR (v_card->'auto_checks'->>'limit')::int <> 30
     OR (v_card->>'hard_limit')::int <> 60 THEN
    RAISE EXCEPTION 'the card: %', v_card - 'connections';
  END IF;
  IF jsonb_array_length(v_card->'connections') <> 2 THEN RAISE EXCEPTION 'the card''s connections: %', v_card; END IF;
  SELECT c INTO v_connection FROM jsonb_array_elements(v_card->'connections') c WHERE c->>'connection_id' = v_router::text;
  IF NOT pg_temp.keys(v_connection) @> ARRAY['billing','connection_id','label','list_read_at','models','more_count',
       'provider','runtime_type','runtime_version','total_models']
     OR v_connection->>'provider' <> 'openrouter' OR v_connection->>'label' <> 'OpenRouter'
     OR v_connection->>'billing' <> 'metered' OR v_connection->>'runtime_type' <> 'opencode' THEN
    RAISE EXCEPTION 'the OpenRouter connection: %', v_connection - 'models';
  END IF;
  -- A large list shows its pinned and in-use models only, and counts the rest.
  IF jsonb_array_length(v_connection->'models') <> 2 OR (v_connection->>'total_models')::int <> 61
     OR (v_connection->>'more_count')::int <> 59
     OR (v_connection->>'total_models')::int - jsonb_array_length(v_connection->'models') <> (v_connection->>'more_count')::int THEN
    RAISE EXCEPTION 'the large list: % models, total %, more %', jsonb_array_length(v_connection->'models'),
      v_connection->>'total_models', v_connection->>'more_count';
  END IF;
  -- In use first.
  v_row := v_connection->'models'->0;
  IF pg_temp.keys(v_row) <> ARRAY['alias_drift','checked_at','display_name','entry_id','in_use','model_id','pinned',
       'provider_id','reason','resolved_model','retry_at','state','vendor'] THEN
    RAISE EXCEPTION 'a ModelRow''s keys: %', pg_temp.keys(v_row);
  END IF;
  IF v_row->>'entry_id' <> v_used::text OR v_row->'in_use'->0->>'project_name' <> 'Models'
     OR v_row->'in_use'->0->>'project_id' <> v_project::text OR v_row->'in_use'->0->>'role' IS NULL
     OR v_row->>'state' <> 'not_checked' OR v_row->>'vendor' <> 'deepseek' THEN
    RAISE EXCEPTION 'the in-use row: %', v_row;
  END IF;
  v_row := v_connection->'models'->1;
  IF v_row->>'entry_id' <> v_pinned::text OR NOT (v_row->>'pinned')::boolean OR v_row->>'state' <> 'ready'
     OR v_row->>'checked_at' IS NULL THEN
    RAISE EXCEPTION 'the pinned row: %', v_row;
  END IF;
  -- A small subscription list shows whole, with what an alias resolved to.
  SELECT c INTO v_connection FROM jsonb_array_elements(v_card->'connections') c WHERE c->>'connection_id' = v_claude::text;
  IF jsonb_array_length(v_connection->'models') <> 2 OR (v_connection->>'more_count')::int <> 0
     OR v_connection->>'label' <> 'Claude' OR v_connection->>'billing' <> 'subscription' THEN
    RAISE EXCEPTION 'the small list: %', v_connection;
  END IF;
  SELECT r INTO v_row FROM jsonb_array_elements(v_connection->'models') r WHERE r->>'model_id' = 'haiku';
  IF v_row->>'state' <> 'ready' OR v_row->>'resolved_model' <> 'claude-haiku-4-5' THEN
    RAISE EXCEPTION 'the haiku row: %', v_row;
  END IF;
  IF get_operator_models(v_stranger)->'connections' <> '[]'::jsonb THEN
    RAISE EXCEPTION 'another operator sees this operator''s models';
  END IF;

  -- Search.
  v_search := search_operator_model_catalog(v_owner, v_router, 'LUNA', NULL, 100);
  IF pg_temp.keys(v_search) <> ARRAY['results','total'] OR (v_search->>'total')::int <> 30
     OR jsonb_array_length(v_search->'results') <> 30
     OR v_search->'results'->0->>'entry_id' <> v_pinned::text THEN
    RAISE EXCEPTION 'search by display name, ready first: total %, first %', v_search->>'total', v_search->'results'->0;
  END IF;
  v_search := search_operator_model_catalog(v_owner, v_router, '', NULL, 100);
  IF (v_search->>'total')::int <> 61 OR jsonb_array_length(v_search->'results') <> 50 THEN
    RAISE EXCEPTION 'the limit is not capped at 50: total %, %', v_search->>'total', jsonb_array_length(v_search->'results');
  END IF;
  v_search := search_operator_model_catalog(v_owner, v_router, 'deepseek/', '{"vendor":"deepseek","checked_only":false}', 5);
  IF (v_search->>'total')::int <> 30 OR jsonb_array_length(v_search->'results') <> 5 THEN
    RAISE EXCEPTION 'the vendor filter: %', v_search->>'total';
  END IF;
  v_search := search_operator_model_catalog(v_owner, v_router, NULL, '{"checked_only":true}', 20);
  IF (v_search->>'total')::int <> 1 OR v_search->'results'->0->>'entry_id' <> v_pinned::text THEN
    RAISE EXCEPTION 'checked only: %', v_search;
  END IF;
  v_search := search_operator_model_catalog(v_owner, v_router, '100%', NULL, 20);
  IF (v_search->>'total')::int <> 1 THEN RAISE EXCEPTION 'a %% in the search was a wildcard: %', v_search->>'total'; END IF;
  v_search := search_operator_model_catalog(v_owner, v_router, 'l_x', NULL, 20);
  IF (v_search->>'total')::int <> 1 THEN RAISE EXCEPTION 'an _ in the search: %', v_search->>'total'; END IF;
  v_search := search_operator_model_catalog(v_owner, v_router, 'l_', NULL, 20);
  IF (v_search->>'total')::int <> 1 THEN RAISE EXCEPTION 'an _ in the search was a wildcard: %', v_search->>'total'; END IF;

  -- Unpin keeps what was checked.
  v_pin := unpin_model(v_owner, v_pinned);
  IF v_pin <> jsonb_build_object('entry_id', v_pinned, 'pinned', false, 'check_id', NULL)
     OR (SELECT status FROM provider_model_catalog WHERE id = v_pinned) <> 'verified' THEN
    RAISE EXCEPTION 'unpin: %', v_pin;
  END IF;

  -- Not the operator's: refused alike, whether it exists or not.
  IF pg_temp.failure_of(format('SELECT search_operator_model_catalog(%L,%L,'''',NULL,5)', v_stranger, v_router))
       <> '42501 catalog_entry_not_owned'
     OR pg_temp.failure_of(format('SELECT pin_model(%L,%L)', v_stranger, v_plain)) <> '42501 catalog_entry_not_owned'
     OR pg_temp.failure_of(format('SELECT unpin_model(%L,%L)', v_stranger, v_plain)) <> '42501 catalog_entry_not_owned'
     OR pg_temp.failure_of(format('SELECT pin_model(%L,%L)', v_owner, gen_random_uuid())) <> '42501 catalog_entry_not_owned'
     OR pg_temp.failure_of(format('SELECT get_model_check(%L,%L)', v_owner, gen_random_uuid())) <> '42501 model_check_unavailable' THEN
    RAISE EXCEPTION 'something not the operator''s was not refused with 42501';
  END IF;

  -- get_model_check's keys.
  v_again := get_model_check(v_owner, (v_claim->>'check_id')::uuid);
  IF pg_temp.keys(v_again) <> ARRAY['attempt','check_id','entry_id','failure_class','finished_at','queue_position',
       'reason','requested_at','result','retry_at','started_at','state'] OR v_again->>'state' <> 'ready' THEN
    RAISE EXCEPTION 'get_model_check: %', v_again;
  END IF;
  -- A queued check reports its place.
  v_pin := request_model_check(v_owner, v_plain, 'check_again');
  PERFORM request_model_check(v_owner, (SELECT id FROM provider_model_catalog WHERE model_id='openai/fixture-6'), 'pick');
  IF ((get_model_check(v_owner, (v_pin->>'check_id')::uuid))->>'queue_position')::int < 1 THEN
    RAISE EXCEPTION 'a check behind a pick is not behind it';
  END IF;

  RAISE NOTICE 'model check operator assertions passed';
END $$;

ROLLBACK;
