-- The check lane (migration 0100, Stage 12 W6; docs/RUNTIMES_AND_MODELS_DESIGN.md
-- §2.6, §2.8, decisions R2, R5).
--
-- What this file pins down:
--   * asking is idempotent per model, and a more urgent ask takes over the
--     queued check instead of adding one;
--   * the claim hands out one check at a time for the host, in the order pick,
--     pin, in-use, whole small lists, and brings its key up to date;
--   * automatic checks stop at 30 a day and wait visibly; the operator's are
--     refused only past 60 (SQLSTATE 54000, reason model_check_budget);
--   * a check handed back before its model turn costs nothing and waits; an
--     inconclusive one is retried after 5 min, 30 min and 2 h, then left;
--   * a lost lease puts the check back; a worker that does not hold a check
--     cannot report it;
--   * the automatic set: a small subscription list whole, a large metered list
--     never, the pinned and in-use models of any list; and at the quiet hour,
--     in-use models whose passed check is a month old.
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

-- A finished check spent in the last day, as the budget counts it.
CREATE FUNCTION pg_temp.spent(p_entry uuid, p_automatic boolean, p_count integer) RETURNS void LANGUAGE sql AS $$
  INSERT INTO model_checks(entry_id,operator_id,connection_id,runtime_type,credential_generation,trigger,automatic,
    priority,result,failure_class,model_called,started_at,finished_at)
  SELECT m.id,m.operator_id,m.connection_id,m.runtime_type,1,
    CASE WHEN p_automatic THEN 'auto_small_list' ELSE 'pick' END,p_automatic,3,'inconclusive','infrastructure',true,
    clock_timestamp()-interval '1 hour',clock_timestamp()-interval '1 hour'
  FROM provider_model_catalog m, generate_series(1,p_count)
  WHERE m.id = p_entry $$;

DO $$
DECLARE
  v_owner uuid; v_stranger uuid; v_small uuid; v_router uuid;
  v_a uuid; v_b uuid; v_c uuid; v_d uuid; v_big uuid; v_pinned uuid; v_used uuid; v_project uuid;
  v_request jsonb; v_again jsonb; v_claim jsonb; v_result jsonb; v_check uuid; v_first uuid; v_i integer;
BEGIN
  -- Nothing another file left may be claimed here.
  DELETE FROM model_checks WHERE finished_at IS NULL;
  INSERT INTO users(display_name,role) VALUES('Lane owner','owner') RETURNING id INTO v_owner;
  INSERT INTO users(display_name,role) VALUES('Lane stranger','owner') RETURNING id INTO v_stranger;
  -- A small free list, and a large metered one.
  INSERT INTO provider_connections(operator_id,provider,auth_method,status,billing_boundary,native_credential_reference)
    VALUES(v_owner,'opencode','native','connected','free','opencode-home:opencode-worker') RETURNING id INTO v_small;
  INSERT INTO provider_connections(operator_id,provider,auth_method,status,access_gateway,billing_boundary,native_credential_reference)
    VALUES(v_owner,'opencode','api_key','connected','openrouter','third_party_metered','opencode-home:opencode-worker')
    RETURNING id INTO v_router;
  INSERT INTO provider_model_catalog(operator_id,connection_id,runtime_type,provider_id,model_id,discovery_source)
    VALUES(v_owner,v_small,'opencode','opencode','lane-a','opencode_provider_api') RETURNING id INTO v_a;
  INSERT INTO provider_model_catalog(operator_id,connection_id,runtime_type,provider_id,model_id,discovery_source)
    VALUES(v_owner,v_small,'opencode','opencode','lane-b','opencode_provider_api') RETURNING id INTO v_b;
  INSERT INTO provider_model_catalog(operator_id,connection_id,runtime_type,provider_id,model_id,discovery_source)
    VALUES(v_owner,v_small,'opencode','opencode','lane-c','opencode_provider_api') RETURNING id INTO v_c;
  INSERT INTO provider_model_catalog(operator_id,connection_id,runtime_type,provider_id,model_id,discovery_source)
    VALUES(v_owner,v_small,'opencode','opencode','lane-d','opencode_provider_api') RETURNING id INTO v_d;
  INSERT INTO provider_model_catalog(operator_id,connection_id,runtime_type,provider_id,model_id,discovery_source)
    SELECT v_owner,v_router,'opencode','openrouter','vendor/model-'||i,'opencode_provider_api' FROM generate_series(1,20) i;
  v_big := (SELECT id FROM provider_model_catalog WHERE connection_id=v_router AND model_id='vendor/model-1');
  v_pinned := (SELECT id FROM provider_model_catalog WHERE connection_id=v_router AND model_id='vendor/model-2');
  v_used := (SELECT id FROM provider_model_catalog WHERE connection_id=v_router AND model_id='vendor/model-3');

  -- Asking: the vocabulary, the owner, idempotency.
  IF pg_temp.failure_of(format('SELECT request_model_check(%L,%L,''verify'')', v_owner, v_a)) <> '22023 model_check_invalid' THEN
    RAISE EXCEPTION 'a trigger outside the vocabulary was accepted';
  END IF;
  IF pg_temp.failure_of(format('SELECT request_model_check(%L,%L,''pick'')', v_stranger, v_a)) <> '42501 catalog_entry_not_owned' THEN
    RAISE EXCEPTION 'another operator asked for this operator''s check';
  END IF;
  v_request := request_model_check(v_owner, v_c, 'check_again');
  v_again := request_model_check(v_owner, v_c, 'check_again');
  IF v_request->>'state' <> 'checking' OR (v_request->>'deduplicated')::boolean
     OR v_again->>'check_id' <> v_request->>'check_id' OR NOT (v_again->>'deduplicated')::boolean THEN
    RAISE EXCEPTION 'asking twice was not idempotent: % %', v_request, v_again;
  END IF;
  PERFORM queue_model_check(v_a, 'auto_small_list', true, 'system');
  PERFORM queue_model_check(v_b, 'in_use', true, 'system');
  -- A pick takes over the automatic check of the same model.
  PERFORM queue_model_check(v_d, 'auto_small_list', true, 'system');
  v_request := request_model_check(v_owner, v_d, 'pick');
  IF NOT (v_request->>'deduplicated')::boolean
     OR (SELECT trigger||' '||priority||' '||automatic FROM model_checks WHERE id=(v_request->>'check_id')::uuid) <> 'pick 0 false' THEN
    RAISE EXCEPTION 'a pick did not take over the queued automatic check';
  END IF;
  IF (SELECT count(*) FROM model_checks WHERE entry_id = v_d) <> 1 THEN RAISE EXCEPTION 'a pick added a second check'; END IF;

  -- The order: pick, then check again, then in use, then the small list.
  v_claim := claim_model_checks('lane-worker', interval '5 minutes')->0;
  IF (v_claim->>'entry_id')::uuid <> v_d OR (v_claim->>'automatic')::boolean
     OR v_claim->'admission'->>'background' <> 'true' OR (v_claim->'admission'->'budget'->>'auto_limit')::int <> 30 THEN
    RAISE EXCEPTION 'the pick was not claimed first: %', v_claim;
  END IF;
  -- One at a time for the host.
  IF jsonb_array_length(claim_model_checks('lane-worker-2', interval '5 minutes')) <> 0 THEN
    RAISE EXCEPTION 'a second check ran beside the first';
  END IF;
  -- Only its holder reports it.
  IF pg_temp.failure_of(format('SELECT complete_model_check(%L,''someone-else'',''passed'',NULL,'''')', v_claim->>'check_id'))
     <> '55000 model_check_not_leased' THEN
    RAISE EXCEPTION 'a worker that does not hold the check completed it';
  END IF;
  IF pg_temp.failure_of(format('SELECT complete_model_check(%L,''lane-worker'',''inconclusive'',''infrastructure'','''')', v_claim->>'check_id'))
     <> '22023 model_check_invalid' THEN
    RAISE EXCEPTION 'inconclusive was accepted as a verdict';
  END IF;
  v_result := complete_model_check((v_claim->>'check_id')::uuid, 'lane-worker', 'passed', NULL, 'PARITY_OK', '', 180, true);
  IF v_result->>'state' <> 'ready' OR (SELECT status FROM provider_model_catalog WHERE id = v_d) <> 'verified' THEN
    RAISE EXCEPTION 'a passed pick: %', v_result;
  END IF;
  IF (SELECT peak_memory_mb FROM model_checks WHERE id = (v_claim->>'check_id')::uuid) <> 180 THEN
    RAISE EXCEPTION 'the check''s memory was not recorded';
  END IF;
  -- A pick of a ready model spends nothing.
  v_again := request_model_check(v_owner, v_d, 'pick');
  IF v_again->>'check_id' <> v_claim->>'check_id' OR v_again->>'state' <> 'ready' THEN
    RAISE EXCEPTION 'a pick of a ready model asked again: %', v_again;
  END IF;
  v_claim := claim_model_checks('lane-worker', interval '5 minutes')->0;
  IF (v_claim->>'entry_id')::uuid <> v_c THEN RAISE EXCEPTION 'check again was not second: %', v_claim; END IF;

  -- Handed back before the model turn: waits, visibly, and costs nothing.
  v_result := defer_model_check((v_claim->>'check_id')::uuid, 'lane-worker', 'waiting: memory', false,
    clock_timestamp() + interval '1 minute');
  IF v_result->>'status' <> 'waiting'
     OR (get_model_check(v_owner, (v_claim->>'check_id')::uuid))->>'state' <> 'waiting'
     OR (get_model_check(v_owner, (v_claim->>'check_id')::uuid))->>'reason' <> 'waiting: memory'
     -- The pick above is the one check that spent a turn.
     OR (model_check_usage(v_owner)->>'used')::int <> 1 THEN
    RAISE EXCEPTION 'a check handed back before its turn: % %', v_result, get_model_check(v_owner, (v_claim->>'check_id')::uuid);
  END IF;
  -- Not before its moment: the in-use check goes first.
  v_claim := claim_model_checks('lane-worker', interval '5 minutes')->0;
  IF (v_claim->>'entry_id')::uuid <> v_b THEN RAISE EXCEPTION 'in use was not next: %', v_claim; END IF;

  -- Inconclusive after a turn: finished, and retried at 5 min, 30 min, 2 h.
  v_first := (v_claim->>'check_id')::uuid;
  v_result := defer_model_check(v_first, 'lane-worker', 'usage limit reached', true);
  IF (SELECT result||' '||failure_class||' '||model_called FROM model_checks WHERE id = v_first) <> 'inconclusive infrastructure true'
     OR (v_result->>'retry_at')::timestamptz NOT BETWEEN clock_timestamp() + interval '4 minutes' AND clock_timestamp() + interval '6 minutes' THEN
    RAISE EXCEPTION 'the first inconclusive attempt: %', v_result;
  END IF;
  -- The dialog keeps the first id and reads the chain's latest attempt.
  IF (get_model_check(v_owner, v_first))->>'state' <> 'waiting' OR ((get_model_check(v_owner, v_first))->>'attempt')::int <> 2
     OR (get_model_check(v_owner, v_first))->>'check_id' <> v_first::text THEN
    RAISE EXCEPTION 'the chain was not followed: %', get_model_check(v_owner, v_first);
  END IF;
  FOR v_i IN 2..4 LOOP
    UPDATE model_checks SET not_before = clock_timestamp() - interval '1 second', wait_reason = ''
    WHERE root_id = v_first AND finished_at IS NULL;
    DELETE FROM model_checks WHERE finished_at IS NULL AND root_id <> v_first;
    v_claim := claim_model_checks('lane-worker', interval '5 minutes')->0;
    IF (v_claim->>'attempt')::int <> v_i THEN RAISE EXCEPTION 'attempt % was not claimed: %', v_i, v_claim; END IF;
    v_result := defer_model_check((v_claim->>'check_id')::uuid, 'lane-worker', 'usage limit reached', true);
    IF v_i = 2 AND (v_result->>'retry_at')::timestamptz < clock_timestamp() + interval '29 minutes' THEN
      RAISE EXCEPTION 'the second retry is not 30 minutes: %', v_result;
    END IF;
    IF v_i = 3 AND (v_result->>'retry_at')::timestamptz < clock_timestamp() + interval '119 minutes' THEN
      RAISE EXCEPTION 'the third retry is not 2 hours: %', v_result;
    END IF;
    IF v_i = 4 AND (v_result->>'next_check_id' IS NOT NULL OR v_result->>'retry_at' IS NOT NULL) THEN
      RAISE EXCEPTION 'a fourth inconclusive attempt was retried: %', v_result;
    END IF;
  END LOOP;
  IF (get_model_check(v_owner, v_first))->>'state' <> 'waiting' OR (get_model_check(v_owner, v_first))->>'retry_at' IS NOT NULL THEN
    RAISE EXCEPTION 'the last inconclusive attempt: %', get_model_check(v_owner, v_first);
  END IF;
  -- A worker's reference that points nowhere is not the operator's to read.
  IF pg_temp.failure_of(format('SELECT get_model_check(%L,%L)', v_stranger, v_first)) <> '42501 model_check_unavailable' THEN
    RAISE EXCEPTION 'another operator read the check';
  END IF;

  -- A lost lease: the check goes back and is not counted.
  DELETE FROM model_checks WHERE finished_at IS NULL;
  PERFORM queue_model_check(v_a, 'auto_small_list', true, 'system');
  v_claim := claim_model_checks('lane-worker', interval '5 minutes')->0;
  UPDATE model_checks SET lease_until = clock_timestamp() - interval '1 second' WHERE id = (v_claim->>'check_id')::uuid;
  v_again := claim_model_checks('lane-worker-2', interval '5 minutes')->0;
  IF v_again->>'check_id' <> v_claim->>'check_id' THEN RAISE EXCEPTION 'a lost lease was not claimed again'; END IF;
  IF (defer_model_check((v_claim->>'check_id')::uuid, 'lane-worker', 'late', false))->>'status' <> 'not_held' THEN
    RAISE EXCEPTION 'the worker that lost the lease still deferred the check';
  END IF;
  DELETE FROM model_checks WHERE finished_at IS NULL;

  -- The automatic budget: 30 a day; past it automatic checks wait, visibly,
  -- and the operator's still run.
  PERFORM pg_temp.spent(v_c, true, 30 - (model_check_usage(v_owner)->>'auto_used')::int);
  PERFORM queue_model_check(v_a, 'auto_small_list', true, 'system');
  IF jsonb_array_length(claim_model_checks('lane-worker', interval '5 minutes')) <> 0 THEN
    RAISE EXCEPTION 'an automatic check ran past the daily budget';
  END IF;
  IF (SELECT wait_reason FROM model_checks WHERE entry_id = v_a AND finished_at IS NULL) <> 'daily check budget reached'
     OR (get_model_check(v_owner, (SELECT id FROM model_checks WHERE entry_id = v_a AND finished_at IS NULL)))->>'state' <> 'waiting' THEN
    RAISE EXCEPTION 'a check waiting for the budget does not say so';
  END IF;
  v_request := request_model_check(v_owner, v_b, 'check_again');
  v_claim := claim_model_checks('lane-worker', interval '5 minutes')->0;
  IF v_claim->>'check_id' <> v_request->>'check_id' THEN RAISE EXCEPTION 'the operator''s check waited for the automatic budget'; END IF;
  PERFORM complete_model_check((v_claim->>'check_id')::uuid, 'lane-worker', 'passed', NULL, 'PARITY_OK');
  -- The operator picking a model that waits for the budget takes it out of the wait.
  v_request := request_model_check(v_owner, v_a, 'pick');
  IF (v_request->>'state') <> 'checking' THEN RAISE EXCEPTION 'a pick left the check waiting for the budget: %', v_request; END IF;
  DELETE FROM model_checks WHERE finished_at IS NULL;
  -- The hard ceiling: 60, counted with the operator's own pending checks.
  PERFORM pg_temp.spent(v_c, false, 60 - (model_check_usage(v_owner)->>'used')::int);
  IF pg_temp.failure_of(format('SELECT request_model_check(%L,%L,''pick'')', v_owner, v_a)) <> '54000 model_check_budget' THEN
    RAISE EXCEPTION 'a check past the daily ceiling was accepted';
  END IF;
  DELETE FROM model_checks WHERE operator_id = v_owner;

  -- The automatic set: the small free list whole (but lane-b and lane-d, which
  -- are ready), of the large metered list only the pinned and the in-use model.
  UPDATE provider_model_catalog SET pinned_at = clock_timestamp() WHERE id = v_pinned;
  INSERT INTO projects(owner_id,name,slug,workspace_path)
    VALUES(v_owner,'Lane','lane-w6','/srv/infra-cod/workspaces/lane-w6') RETURNING id INTO v_project;
  INSERT INTO project_runtime_defaults(project_id,orchestrator_entry_id) VALUES(v_project,v_used);
  PERFORM queue_automatic_model_checks(NULL);
  IF (SELECT array_agg(m.model_id ORDER BY m.model_id) FROM model_checks k JOIN provider_model_catalog m ON m.id = k.entry_id
      WHERE k.connection_id = v_small AND k.finished_at IS NULL AND k.trigger = 'auto_small_list') <> ARRAY['lane-a','lane-c']
     OR (SELECT count(*) FROM model_checks WHERE connection_id = v_router AND finished_at IS NULL) <> 2
     OR NOT EXISTS (SELECT 1 FROM model_checks WHERE entry_id = v_pinned AND trigger = 'pin' AND automatic AND priority = 2)
     OR NOT EXISTS (SELECT 1 FROM model_checks WHERE entry_id = v_used AND trigger = 'in_use' AND automatic) THEN
    RAISE EXCEPTION 'the automatic set is not R2''s: %',
      (SELECT jsonb_agg(jsonb_build_object('model',m.model_id,'trigger',k.trigger)) FROM model_checks k
       JOIN provider_model_catalog m ON m.id = k.entry_id WHERE k.finished_at IS NULL);
  END IF;
  -- Asking again changes nothing while they are queued.
  IF queue_automatic_model_checks(NULL) <> 0 THEN RAISE EXCEPTION 'the automatic set was queued twice'; END IF;

  -- The month-old in-use check, at the quiet hour only.
  DELETE FROM model_checks WHERE finished_at IS NULL;
  INSERT INTO model_checks(entry_id,operator_id,connection_id,runtime_type,runtime_version,credential_generation,trigger,
    automatic,priority,result,model_called,started_at,finished_at)
  SELECT id,operator_id,connection_id,runtime_type,active_runtime_version('opencode'),
    (SELECT credential_generation FROM provider_connections WHERE id = v_router),
    'in_use',true,2,'passed',true,clock_timestamp()-interval '40 days',clock_timestamp()-interval '40 days'
  FROM provider_model_catalog WHERE id = v_used;
  IF (SELECT status FROM provider_model_catalog WHERE id = v_used) <> 'verified' THEN
    RAISE EXCEPTION 'fixture: the in-use model is not eligible';
  END IF;
  v_result := request_model_checks_due(NULL, interval '30 days');
  IF (v_result->>'aged')::int <> 0 THEN RAISE EXCEPTION 'the age re-check ran outside the quiet hour'; END IF;
  DELETE FROM model_checks WHERE finished_at IS NULL;
  v_result := request_model_checks_due(extract(hour FROM clock_timestamp() AT TIME ZONE 'UTC')::int, interval '30 days');
  IF (v_result->>'aged')::int <> 1 OR NOT EXISTS (SELECT 1 FROM model_checks WHERE entry_id = v_used AND trigger = 'ttl'
     AND finished_at IS NULL) THEN
    RAISE EXCEPTION 'the month-old in-use check was not re-run: %', v_result;
  END IF;

  RAISE NOTICE 'model check lane assertions passed';
END $$;

-- The worker's role reaches the lane — as infra_worker, not as the owner
-- these tests otherwise run as. (The gate's wrappers it reached it through for
-- one release went in W5-b, 0106.)
DO $$
DECLARE v_owner uuid; v_entry uuid; v_claim jsonb;
BEGIN
  DELETE FROM model_checks WHERE finished_at IS NULL;
  SELECT operator_id, id INTO v_owner, v_entry FROM provider_model_catalog WHERE model_id = 'lane-a';
  PERFORM request_model_check(v_owner, v_entry, 'pin');
  EXECUTE 'SET LOCAL ROLE infra_worker';
  PERFORM request_model_checks_due(NULL, interval '30 days');
  v_claim := claim_model_checks('lane-worker', interval '5 minutes')->0;
  IF (v_claim->>'entry_id')::uuid <> v_entry THEN RAISE EXCEPTION 'the worker claimed %', v_claim; END IF;
  IF complete_model_check((v_claim->>'check_id')::uuid, 'lane-worker', 'passed', NULL, 'PARITY_OK', '', NULL, true)->>'state'
       <> 'ready' THEN
    RAISE EXCEPTION 'the worker did not complete the check';
  END IF;
  IF jsonb_array_length(claim_model_checks('lane-worker', interval '5 minutes')) > 1 THEN
    RAISE EXCEPTION 'the claim handed out more than one check';
  END IF;
  EXECUTE 'RESET ROLE';
  RAISE NOTICE 'the lane answers infra_worker';
END $$;

ROLLBACK;
