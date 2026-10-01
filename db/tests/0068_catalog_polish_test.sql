-- The catalog's polish (migration 0105): what the panel reads beside the
-- models, and the two re-checks the design promised.
--
-- What this file pins down:
--   * a Claude alias's drift: a run reporting the model its alias resolved to
--     notes it; a model other than the last passed check's queues one
--     background re-check (alias_drift), at most once a day, and the model
--     stays selectable meanwhile; the re-check records the new model;
--   * a rejected model that leaves the list and comes back is re-checked once,
--     automatically (relisted), and not again the same day;
--   * request_model_check says why at once when the answer is a refusal;
--   * the Models card: vendors with counts, a rollup that adds up to the
--     connection's total, the budget's moments, and what a newer runtime
--     version's qualification would add — per connection, OpenCode's
--     provider-qualified list split by provider;
--   * the release baseline, recorded from the health report and read back.
\set ON_ERROR_STOP on

BEGIN;
SET search_path TO control_plane, public, extensions;

-- A check run through the lane as the worker runs it: asked, claimed, judged.
CREATE FUNCTION pg_temp.check(p_owner uuid, p_entry uuid, p_result text, p_resolved text DEFAULT '') RETURNS uuid
LANGUAGE plpgsql AS $$
DECLARE v_request jsonb; v_claim jsonb;
BEGIN
  DELETE FROM model_checks WHERE finished_at IS NULL AND entry_id <> p_entry;
  v_request := request_model_check(p_owner, p_entry, 'check_again');
  v_claim := claim_model_checks('polish-worker', interval '5 minutes')->0;
  IF (v_claim->>'check_id')::uuid IS DISTINCT FROM (v_request->>'check_id')::uuid THEN
    RAISE EXCEPTION 'fixture: claimed % instead of %', v_claim, v_request;
  END IF;
  PERFORM complete_model_check((v_claim->>'check_id')::uuid, 'polish-worker', p_result,
    CASE p_result WHEN 'rejected' THEN 'model' WHEN 'failed' THEN 'runtime' END,
    CASE p_result WHEN 'rejected' THEN 'not in your plan' ELSE 'PARITY_OK' END, p_resolved, 120, true);
  RETURN (v_claim->>'check_id')::uuid;
END $$;

-- A finished dispatch attempt of a job, reporting what its model resolved to.
CREATE FUNCTION pg_temp.run_reports(p_job bigint, p_resolved text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE v_selection bigint; v_attempt bigint;
BEGIN
  SELECT id INTO v_selection FROM runtime_job_selections WHERE job_id = p_job;
  IF v_selection IS NULL THEN
    INSERT INTO runtime_job_selections(job_id,project_id,task_id,source,runtime_type,access_mode,selected_by)
    SELECT j.id, j.project_id, j.task_id, 'backfill', 'claude', 'read_only', 'test' FROM runtime_jobs j WHERE j.id = p_job
    RETURNING id INTO v_selection;
  END IF;
  INSERT INTO runtime_dispatch_attempts(job_id,selection_id,attempt_number,runtime_type,executable,adapter_version,
      capability_verification,access_mode,worker_id,surface)
    VALUES (p_job, v_selection, (SELECT count(*) + 1 FROM runtime_dispatch_attempts WHERE job_id = p_job),
      'claude','/usr/local/bin/claude','1.0.0','verified','read_only','supervisor','project')
    RETURNING id INTO v_attempt;
  UPDATE runtime_dispatch_attempts SET finished_at = clock_timestamp(),
    native_result = jsonb_build_object('status','exited','exit_code',0,'resolved_model',p_resolved)
  WHERE id = v_attempt;
END $$;

DO $$
DECLARE
  v_owner uuid; v_claude uuid; v_sonnet uuid; v_project uuid; v_task uuid; v_job bigint; v_event domain_events;
  v_row jsonb; v_check uuid; v_drift_check uuid;
BEGIN
  INSERT INTO users(display_name,role) VALUES('Polish owner','owner') RETURNING id INTO v_owner;
  INSERT INTO provider_connections(operator_id,provider,auth_method,status,access_gateway,billing_boundary,
      native_credential_reference,account_label,last_verified_at)
    VALUES(v_owner,'claude','native','connected','claude_subscription','subscription',
      'claude-home:claude-worker','Claude subscription',clock_timestamp()) RETURNING id INTO v_claude;
  PERFORM note_active_runtime_version('claude', '2.1.270', 'baseline');
  INSERT INTO provider_model_catalog(operator_id,connection_id,runtime_type,provider_id,model_id,discovery_source,
      billing_boundary,model_vendor)
    VALUES(v_owner,v_claude,'claude','claude','sonnet','claude_aliases','subscription','anthropic') RETURNING id INTO v_sonnet;
  INSERT INTO model_listings(entry_id,runtime_type,runtime_version) VALUES(v_sonnet,'claude','2.1.270');
  PERFORM pg_temp.check(v_owner, v_sonnet, 'passed', 'claude-sonnet-5');
  IF (SELECT status||' '||resolved_model FROM provider_model_catalog WHERE id = v_sonnet) <> 'verified claude-sonnet-5' THEN
    RAISE EXCEPTION 'fixture: the alias was not checked';
  END IF;

  INSERT INTO projects(owner_id,name,slug,workspace_path)
    VALUES(v_owner,'Polish','polish-0105','/srv/infra-cod/workspaces/polish-0105') RETURNING id INTO v_project;
  INSERT INTO tasks(project_id,title,objective,status,created_by)
    VALUES(v_project,'Alias drift','test','planning','test') RETURNING id INTO v_task;
  INSERT INTO task_runtime_snapshots(task_id,orchestrator,source)
    VALUES(v_task,jsonb_build_object('entry_id',v_sonnet,'model_id','sonnet'),'catalog');
  v_event := append_event('chat.user_message',v_project,v_task,NULL,'user','operator',NULL,
    'polish-drift','polish-drift','task',v_task,(SELECT version FROM tasks WHERE id=v_task),'{}');
  INSERT INTO runtime_jobs(source_event_id,job_type,project_id,task_id,payload)
    VALUES(v_event.id,'orchestrator_turn',v_project,v_task,'{}') RETURNING id INTO v_job;

  -- The run resolves the alias as the check did: noted, nothing asked.
  PERFORM pg_temp.run_reports(v_job, 'claude-sonnet-5');
  IF (SELECT observed_model FROM provider_model_catalog WHERE id = v_sonnet) <> 'claude-sonnet-5'
     OR EXISTS (SELECT 1 FROM model_checks WHERE entry_id = v_sonnet AND trigger = 'alias_drift') THEN
    RAISE EXCEPTION 'a run that agreed with the check was treated as drift';
  END IF;
  IF model_row(v_sonnet, v_owner)->'alias_drift' <> 'null'::jsonb THEN
    RAISE EXCEPTION 'no drift is shown as drift: %', model_row(v_sonnet, v_owner);
  END IF;

  -- The alias moved: drift noted and audited, one background re-check, still selectable.
  PERFORM pg_temp.run_reports(v_job, 'claude-sonnet-5-1');
  SELECT id INTO v_drift_check FROM model_checks WHERE entry_id = v_sonnet AND trigger = 'alias_drift' AND finished_at IS NULL
    AND automatic AND priority = 2;
  IF v_drift_check IS NULL THEN RAISE EXCEPTION 'drift queued no re-check'; END IF;
  IF (SELECT status FROM provider_model_catalog WHERE id = v_sonnet) <> 'verified'
     OR NOT (model_eligibility(v_sonnet)->>'eligible')::boolean THEN
    RAISE EXCEPTION 'drift took the alias away: %', model_eligibility(v_sonnet);
  END IF;
  v_row := model_row(v_sonnet, v_owner);
  IF v_row->'alias_drift'->>'model' <> 'claude-sonnet-5-1' OR v_row->>'resolved_model' <> 'claude-sonnet-5'
     OR v_row->'alias_drift'->>'seen_at' IS NULL THEN
    RAISE EXCEPTION 'the row does not say the alias moved: %', v_row;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM audit_events WHERE action = 'model.alias_drift' AND target_id = v_sonnet::text) THEN
    RAISE EXCEPTION 'drift was not audited';
  END IF;
  -- More runs the same day ask for nothing more.
  PERFORM pg_temp.run_reports(v_job, 'claude-sonnet-5-2');
  IF (SELECT count(*) FROM model_checks WHERE entry_id = v_sonnet AND trigger = 'alias_drift') <> 1 THEN
    RAISE EXCEPTION 'drift asked twice in a day';
  END IF;
  -- A report without a model, or of a job with no catalog model, changes nothing.
  IF (record_alias_resolution(v_job, '')->>'recorded')::boolean
     OR (record_alias_resolution(-1, 'x')->>'recorded')::boolean THEN
    RAISE EXCEPTION 'an empty or orphan report was recorded';
  END IF;
  -- The re-check records what the alias resolves to now; the drift is gone.
  PERFORM pg_temp.run_reports(v_job, 'claude-sonnet-5-1');
  UPDATE model_checks SET priority = 0 WHERE id = v_drift_check;
  v_check := (claim_model_checks('polish-worker', interval '5 minutes')->0->>'check_id')::uuid;
  IF v_check <> v_drift_check THEN RAISE EXCEPTION 'claimed % instead of the drift check', v_check; END IF;
  PERFORM complete_model_check(v_check, 'polish-worker', 'passed', NULL, 'PARITY_OK', 'claude-sonnet-5-1', 120, true);
  v_row := model_row(v_sonnet, v_owner);
  IF v_row->>'resolved_model' <> 'claude-sonnet-5-1' OR v_row->'alias_drift' <> 'null'::jsonb OR v_row->>'state' <> 'ready' THEN
    RAISE EXCEPTION 'the re-check did not record the new model: %', v_row;
  END IF;
  RAISE NOTICE 'alias drift assertions passed';
END $$;

DO $$
DECLARE
  v_owner uuid; v_free uuid; v_router uuid; v_codex uuid; v_refresh uuid; v_upsert jsonb; v_kept uuid; v_gone uuid;
  v_answer jsonb; v_card jsonb; v_connection jsonb; v_q uuid; v_rollup jsonb;
  v_entries jsonb := '[{"runtime_type":"opencode","provider_id":"opencode","model_id":"kept-free","discovery_source":"opencode_provider_api",
                        "billing_boundary":"free","model_vendor":"opencode","runtime_version":"1.18.32"},
                       {"runtime_type":"opencode","provider_id":"opencode","model_id":"gone-free","discovery_source":"opencode_provider_api",
                        "billing_boundary":"free","model_vendor":"moonshot","runtime_version":"1.18.32"}]';
BEGIN
  INSERT INTO users(display_name,role) VALUES('Relisted owner','owner') RETURNING id INTO v_owner;
  INSERT INTO provider_connections(operator_id,provider,auth_method,status,access_gateway,billing_boundary,native_credential_reference)
    VALUES(v_owner,'opencode','native','connected','opencode_zen','free','opencode-home:opencode-worker') RETURNING id INTO v_free;
  PERFORM note_active_runtime_version('opencode', '1.18.32', 'baseline');
  UPDATE catalog_refresh_jobs SET status='failed', failure_code='test-isolation' WHERE status IN ('pending','in_progress');

  v_refresh := (request_catalog_refresh(v_free, v_owner, 'polish')->>'refresh_id')::uuid;
  PERFORM claim_catalog_refresh_work('polish-refresh', 5, interval '2 minutes');
  v_upsert := upsert_catalog_entries(v_refresh, 'polish-refresh', v_entries);
  PERFORM complete_catalog_refresh(v_refresh, 'polish-refresh',
    ARRAY(SELECT x::uuid FROM jsonb_array_elements_text(v_upsert->'seen_entry_ids') t(x)), 'unavailable');
  SELECT id INTO v_kept FROM provider_model_catalog WHERE connection_id = v_free AND model_id = 'kept-free';
  SELECT id INTO v_gone FROM provider_model_catalog WHERE connection_id = v_free AND model_id = 'gone-free';
  PERFORM pg_temp.check(v_owner, v_kept, 'passed');
  PERFORM pg_temp.check(v_owner, v_gone, 'rejected');
  DELETE FROM model_checks WHERE finished_at IS NULL;

  -- A pick of a model refused at its key answers at once, with why.
  v_answer := request_model_check(v_owner, v_gone, 'pick');
  IF v_answer->>'state' <> 'refused' OR v_answer->>'reason' <> 'not in your plan' OR v_answer->>'result' <> 'rejected'
     OR NOT (v_answer->>'deduplicated')::boolean THEN
    RAISE EXCEPTION 'an immediate refusal did not say why: %', v_answer;
  END IF;
  v_answer := request_model_check(v_owner, v_kept, 'pick');
  IF v_answer->>'state' <> 'ready' OR v_answer->'reason' <> 'null'::jsonb THEN
    RAISE EXCEPTION 'a ready answer: %', v_answer;
  END IF;

  -- The list stops naming the rejected model: it is unavailable, not rejected.
  v_refresh := (request_catalog_refresh(v_free, v_owner, 'polish')->>'refresh_id')::uuid;
  PERFORM claim_catalog_refresh_work('polish-refresh', 5, interval '2 minutes');
  v_upsert := upsert_catalog_entries(v_refresh, 'polish-refresh', jsonb_build_array(v_entries->0));
  PERFORM complete_catalog_refresh(v_refresh, 'polish-refresh',
    ARRAY(SELECT x::uuid FROM jsonb_array_elements_text(v_upsert->'seen_entry_ids') t(x)), 'unavailable');
  IF (SELECT status FROM provider_model_catalog WHERE id = v_gone) <> 'unavailable' THEN
    RAISE EXCEPTION 'a rejected model the list no longer names is %', (SELECT status FROM provider_model_catalog WHERE id = v_gone);
  END IF;
  -- It comes back: its verdict shows again, and one automatic re-check is asked.
  v_refresh := (request_catalog_refresh(v_free, v_owner, 'polish')->>'refresh_id')::uuid;
  PERFORM claim_catalog_refresh_work('polish-refresh', 5, interval '2 minutes');
  v_upsert := upsert_catalog_entries(v_refresh, 'polish-refresh', v_entries);
  IF (SELECT status FROM provider_model_catalog WHERE id = v_gone) <> 'rejected'
     OR NOT EXISTS (SELECT 1 FROM model_checks WHERE entry_id = v_gone AND trigger = 'relisted' AND automatic
                      AND finished_at IS NULL) THEN
    RAISE EXCEPTION 'a relisted rejected model: % %', (SELECT status FROM provider_model_catalog WHERE id = v_gone),
      (SELECT jsonb_agg(trigger) FROM model_checks WHERE entry_id = v_gone);
  END IF;
  PERFORM complete_catalog_refresh(v_refresh, 'polish-refresh',
    ARRAY(SELECT x::uuid FROM jsonb_array_elements_text(v_upsert->'seen_entry_ids') t(x)), 'unavailable');
  -- The re-check refuses again; the model leaves and comes back the same day:
  -- nothing more is asked.
  UPDATE model_checks SET priority = 0 WHERE entry_id = v_gone AND finished_at IS NULL;
  PERFORM complete_model_check((claim_model_checks('polish-worker', interval '5 minutes')->0->>'check_id')::uuid,
    'polish-worker', 'rejected', 'model', 'not in your plan', '', NULL, true);
  UPDATE provider_model_catalog SET status = 'unavailable' WHERE id = v_gone;
  UPDATE provider_model_catalog SET status = 'discovered' WHERE id = v_gone;
  IF (SELECT count(*) FROM model_checks WHERE entry_id = v_gone AND trigger = 'relisted') <> 1 THEN
    RAISE EXCEPTION 'a model relisted twice in a day was re-checked twice';
  END IF;
  -- A model that was never refused is not re-checked when it comes back.
  UPDATE provider_model_catalog SET status = 'unavailable', verification_id = NULL WHERE id = v_kept;
  UPDATE provider_model_catalog SET status = 'discovered' WHERE id = v_kept;
  IF EXISTS (SELECT 1 FROM model_checks WHERE entry_id = v_kept AND trigger = 'relisted') THEN
    RAISE EXCEPTION 'a model that passed was re-checked as relisted';
  END IF;
  PERFORM project_model_status(v_kept);

  -- A second, provider-qualified connection, and a Codex one.
  INSERT INTO provider_connections(operator_id,provider,auth_method,status,access_gateway,billing_boundary,native_credential_reference)
    VALUES(v_owner,'opencode','api_key','connected','openrouter','third_party_metered','opencode-home:opencode-worker')
    RETURNING id INTO v_router;
  INSERT INTO provider_model_catalog(operator_id,connection_id,runtime_type,provider_id,model_id,discovery_source,model_vendor)
    SELECT v_owner, v_router, 'opencode', 'openrouter', v, 'opencode_provider_api', split_part(v, '/', 1)
    FROM unnest(ARRAY['openai/a','openai/b','qwen/c']) v;
  INSERT INTO provider_connections(operator_id,provider,auth_method,status,native_credential_reference)
    VALUES(v_owner,'codex','device_code','connected','codex-home:codex-worker') RETURNING id INTO v_codex;
  PERFORM note_active_runtime_version('codex', '0.154.0', 'baseline');
  INSERT INTO provider_model_catalog(operator_id,connection_id,runtime_type,provider_id,model_id,discovery_source,model_vendor,billing_boundary)
    VALUES(v_owner, v_codex, 'codex', 'chatgpt', 'gpt-5.6-luna', 'codex_model_list', 'openai', 'subscription');

  -- Newer versions' lists: an older qualification is ignored, the highest newer one counts.
  INSERT INTO runtime_qualifications(runtime_type,version,adapter_version,release_version,requested_by,result,finished_at)
    VALUES('codex','0.153.0','1.0.0','rc.90','owner','passed',clock_timestamp()) RETURNING id INTO v_q;
  INSERT INTO runtime_qualification_checks(qualification_id,check_key,capability,result,failure_class,detail,evidence)
    VALUES(v_q,'catalog.list','catalog.models','passed','','5 models','{"count":5,"added":["old-model"],"removed":[]}');
  INSERT INTO runtime_qualifications(runtime_type,version,adapter_version,release_version,requested_by,result,finished_at)
    VALUES('codex','0.158.0','1.0.0','rc.90','owner','passed',clock_timestamp()) RETURNING id INTO v_q;
  INSERT INTO runtime_qualification_checks(qualification_id,check_key,capability,result,failure_class,detail,evidence)
    VALUES(v_q,'catalog.list','catalog.models','passed','','7 models; adds gpt-6-sol, gpt-6-luna',
      '{"count":7,"added":["gpt-6-sol","gpt-6-luna"],"removed":[]}');
  INSERT INTO runtime_qualifications(runtime_type,version,adapter_version,release_version,requested_by,result,finished_at)
    VALUES('opencode','1.18.33','1.0.0','rc.90','owner','failed',clock_timestamp()) RETURNING id INTO v_q;
  INSERT INTO runtime_qualification_checks(qualification_id,check_key,capability,result,failure_class,detail,evidence)
    VALUES(v_q,'catalog.list','catalog.models','passed','','338 models',
      '{"count":338,"added":["opencode/new-free","openrouter/openai/d"],"removed":["openrouter/qwen/c"]}');

  v_card := get_operator_models(v_owner);
  IF v_card->'budget'->>'next_slot_at' IS NULL OR (v_card->'budget'->>'window_hours')::int <> 24
     OR (v_card->'budget'->>'clear_at')::timestamptz < (v_card->'budget'->>'next_slot_at')::timestamptz
     OR (v_card->'budget'->>'next_slot_at')::timestamptz <= clock_timestamp() THEN
    RAISE EXCEPTION 'the budget''s moments: %', v_card->'budget';
  END IF;

  SELECT c INTO v_connection FROM jsonb_array_elements(v_card->'connections') c WHERE c->>'connection_id' = v_free::text;
  IF v_connection->'vendors' <> '[{"count":1,"vendor":"moonshot"},{"count":1,"vendor":"opencode"}]'::jsonb THEN
    RAISE EXCEPTION 'the vendors: %', v_connection->'vendors';
  END IF;
  v_rollup := v_connection->'rollup';
  IF (v_rollup->>'total')::int <> (v_connection->>'total_models')::int
     OR (v_rollup->>'ready')::int + (v_rollup->>'checking')::int + (v_rollup->>'not_checked')::int
        + (v_rollup->>'refused')::int + (v_rollup->>'waiting')::int <> (v_rollup->>'total')::int
     OR (v_rollup->>'ready')::int <> 1 OR (v_rollup->>'refused')::int <> 1 THEN
    RAISE EXCEPTION 'the rollup: % of %', v_rollup, v_connection->>'total_models';
  END IF;
  IF v_connection->'newer_runtime'->>'version' <> '1.18.33' OR v_connection->'newer_runtime'->'added' <> '["new-free"]'::jsonb
     OR v_connection->'newer_runtime'->'removed' <> '[]'::jsonb OR v_connection->'newer_runtime'->>'result' <> 'failed' THEN
    RAISE EXCEPTION 'Zen''s newer runtime: %', v_connection->'newer_runtime';
  END IF;
  SELECT c INTO v_connection FROM jsonb_array_elements(v_card->'connections') c WHERE c->>'connection_id' = v_router::text;
  IF v_connection->'newer_runtime'->'added' <> '["openai/d"]'::jsonb
     OR v_connection->'newer_runtime'->'removed' <> '["qwen/c"]'::jsonb
     OR v_connection->'vendors' <> '[{"count":2,"vendor":"openai"},{"count":1,"vendor":"qwen"}]'::jsonb
     OR (v_connection->'rollup'->>'not_checked')::int <> 3 THEN
    RAISE EXCEPTION 'OpenRouter: %', v_connection - 'models';
  END IF;
  SELECT c INTO v_connection FROM jsonb_array_elements(v_card->'connections') c WHERE c->>'connection_id' = v_codex::text;
  IF v_connection->'newer_runtime'->>'version' <> '0.158.0'
     OR v_connection->'newer_runtime'->'added' <> '["gpt-6-sol","gpt-6-luna"]'::jsonb THEN
    RAISE EXCEPTION 'Codex''s newer runtime: %', v_connection->'newer_runtime';
  END IF;
  -- The Runtimes card's read carries each qualification's list diff.
  IF (SELECT q->'catalog' FROM jsonb_array_elements(get_runtime_qualifications()) q
      WHERE q->>'runtime' = 'codex' AND q->>'version' = '0.158.0')
     <> '{"count":7,"added":["gpt-6-sol","gpt-6-luna"],"removed":[]}'::jsonb THEN
    RAISE EXCEPTION 'the qualification''s catalog: %', get_runtime_qualifications();
  END IF;
  -- Once 0.158.0 is active, nothing is newer.
  PERFORM note_active_runtime_version('codex', '0.158.0', 'activation');
  IF connection_catalog_preview(v_codex) IS NOT NULL THEN RAISE EXCEPTION 'the active version is its own preview'; END IF;
  IF runtime_version_key('0.10.0') <= runtime_version_key('0.9.1') OR runtime_version_key('1.2.x') IS NOT NULL THEN
    RAISE EXCEPTION 'versions do not order as numbers';
  END IF;
  RAISE NOTICE 'relisted, immediate answers and the card''s additions passed';
END $$;

-- The release baseline, from the health report.
DO $$
DECLARE v_versions jsonb; v_codex jsonb;
BEGIN
  INSERT INTO runtime_health(singleton,status,snapshot,observed_at)
  VALUES (true,'healthy',jsonb_build_object('runtimes',jsonb_build_array(
      jsonb_build_object('runtime','codex','installed',true,'authenticated',true,'version','0.158.0',
        'baseline_version','0.154.0','adapter_version','1.0.0','verified_by','host qualification 1415518c'),
      jsonb_build_object('runtime','fictional','version','1.0.0','baseline_version','1.0.0'))),clock_timestamp())
  ON CONFLICT (singleton) DO UPDATE SET snapshot=EXCLUDED.snapshot, observed_at=EXCLUDED.observed_at;
  IF (SELECT baseline_version||' '||active_verified_by FROM runtime_baselines WHERE runtime_type='codex')
     <> '0.154.0 host qualification 1415518c'
     OR EXISTS (SELECT 1 FROM runtime_baselines WHERE runtime_type NOT IN (SELECT runtime_type FROM runtime_roles)) THEN
    RAISE EXCEPTION 'the baseline was not recorded: %', (SELECT jsonb_agg(b) FROM runtime_baselines b);
  END IF;
  v_versions := get_runtime_versions();
  SELECT v INTO v_codex FROM jsonb_array_elements(v_versions) v WHERE v->>'runtime' = 'codex';
  IF v_codex->>'baseline_version' <> '0.154.0' OR v_codex->>'verified_by' <> 'host qualification 1415518c'
     OR v_codex->>'active_version' <> '0.158.0' THEN
    RAISE EXCEPTION 'get_runtime_versions: %', v_codex;
  END IF;
  -- The next report the same: nothing is written.
  UPDATE runtime_baselines SET noted_at = clock_timestamp() - interval '1 hour' WHERE runtime_type = 'codex';
  UPDATE runtime_health SET observed_at = clock_timestamp();
  UPDATE runtime_health SET snapshot = snapshot WHERE singleton;
  IF (SELECT noted_at > clock_timestamp() - interval '1 minute' FROM runtime_baselines WHERE runtime_type = 'codex') THEN
    RAISE EXCEPTION 'an unchanged baseline was written again';
  END IF;
  RAISE NOTICE 'release baseline assertions passed';
END $$;

ROLLBACK;
