-- Eligibility comes from model checks (migration 0099, Stage 12 W6): a model
-- is selectable when a check passed for the active runtime version and the
-- connection's current credential, and `status` follows that one definition.
--
-- What this file pins down:
--   * every stored credential and every return to connected bumps the
--     connection's credential generation, and a check made under an older one
--     stops counting;
--   * a check counts for the runtime version it ran at: a new version (from the
--     watch, the health report or an activation) takes eligibility away until
--     the model is listed and checked there, and a rollback gives it back;
--   * a promotion carries forward exactly the in-use models its qualification
--     re-checked, with a listing at the new version;
--   * a row no check ever judged keeps the status its writer gave it;
--   * a check's result is written once;
--   * a task run's model-class failure asks for a refresh and one re-check;
--   * shaped like the host (rc.85): an OpenCode promotion with no refresh at
--     the new version yet — the carry keeps every in-use model selectable and
--     the team's defaults resolving; a verified model not in use is listed but
--     not checked.
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

-- A check run through the lane as the worker runs it: asked, claimed, judged.
CREATE FUNCTION pg_temp.check(p_owner uuid, p_entry uuid, p_result text) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE v_request jsonb; v_claim jsonb;
BEGIN
  -- Nothing else of this file's may be claimed first.
  DELETE FROM model_checks WHERE finished_at IS NULL AND entry_id <> p_entry;
  v_request := request_model_check(p_owner, p_entry, 'check_again');
  v_claim := claim_model_checks('eligibility-worker', interval '5 minutes')->0;
  IF (v_claim->>'check_id')::uuid IS DISTINCT FROM (v_request->>'check_id')::uuid THEN
    RAISE EXCEPTION 'fixture: claimed % instead of %', v_claim, v_request;
  END IF;
  PERFORM complete_model_check((v_claim->>'check_id')::uuid, 'eligibility-worker', p_result,
    CASE p_result WHEN 'rejected' THEN 'model' WHEN 'failed' THEN 'runtime' END, 'fixture ' || p_result, '', 120, true);
  RETURN (v_claim->>'check_id')::uuid;
END $$;

CREATE FUNCTION pg_temp.status(p_entry uuid) RETURNS text LANGUAGE sql AS $$
  SELECT status FROM provider_model_catalog WHERE id = p_entry $$;
CREATE FUNCTION pg_temp.why(p_entry uuid) RETURNS text LANGUAGE sql AS $$
  SELECT COALESCE(model_eligibility(p_entry)->>'reason', 'eligible') $$;

DO $$
DECLARE
  v_owner uuid; v_codex uuid; v_entry uuid; v_other uuid; v_legacy uuid; v_generation bigint;
  v_check uuid; v_session uuid; v_project uuid; v_task uuid; v_job bigint; v_qualification uuid;
  v_result jsonb; v_event domain_events;
BEGIN
  INSERT INTO users(display_name,role) VALUES('Eligibility owner','owner') RETURNING id INTO v_owner;
  -- The version the watch saw: the baseline this file's checks are made at.
  PERFORM record_runtime_watch('codex', '0.154.0', '[]'::jsonb, '');
  IF active_runtime_version('codex') <> '0.154.0' THEN RAISE EXCEPTION 'the watch did not set the active version'; END IF;

  INSERT INTO provider_connections(operator_id,provider,auth_method,status,native_credential_reference)
    VALUES(v_owner,'codex','device_code','connected','codex-home:codex-worker') RETURNING id INTO v_codex;
  INSERT INTO provider_model_catalog(operator_id,connection_id,runtime_type,provider_id,model_id,discovery_source,status)
    VALUES(v_owner,v_codex,'codex','chatgpt','gpt-5.6-luna','codex_model_list','discovered') RETURNING id INTO v_entry;
  INSERT INTO provider_model_catalog(operator_id,connection_id,runtime_type,provider_id,model_id,discovery_source,status)
    VALUES(v_owner,v_codex,'codex','chatgpt','gpt-5.5','codex_model_list','discovered') RETURNING id INTO v_other;
  INSERT INTO model_listings(entry_id,runtime_type,runtime_version)
    VALUES(v_entry,'codex','0.154.0'),(v_other,'codex','0.154.0');

  -- Not checked: not eligible, and the status says discovered.
  IF pg_temp.why(v_entry) <> 'not_checked' THEN RAISE EXCEPTION 'an unchecked model: %', pg_temp.why(v_entry); END IF;

  -- A passed check makes it eligible, and the status follows.
  v_check := pg_temp.check(v_owner, v_entry, 'passed');
  IF pg_temp.why(v_entry) <> 'eligible' OR pg_temp.status(v_entry) <> 'verified' THEN
    RAISE EXCEPTION 'a passed check did not make the model eligible: % %', pg_temp.why(v_entry), pg_temp.status(v_entry);
  END IF;
  IF (SELECT verification_id FROM provider_model_catalog WHERE id = v_entry) <> v_check
     OR (SELECT last_check_id FROM provider_model_catalog WHERE id = v_entry) <> v_check THEN
    RAISE EXCEPTION 'the status does not name the check it follows';
  END IF;
  IF (SELECT runtime_version || '/' || credential_generation FROM model_checks WHERE id = v_check) <> '0.154.0/1' THEN
    RAISE EXCEPTION 'the check was not made at the active version and current credential';
  END IF;
  -- The team functions read status: the model is selectable.
  PERFORM team_model(v_owner, v_entry);

  -- A result is written once.
  IF pg_temp.reason_of(format('UPDATE model_checks SET result=''rejected'', failure_class=''model'' WHERE id=%L', v_check))
     <> 'model_check_invalid' THEN
    RAISE EXCEPTION 'a finished check was rewritten';
  END IF;

  -- A new version: not listed there, so not eligible; its list is asked for.
  PERFORM record_runtime_watch('codex', '0.158.0', '[]'::jsonb, '');
  IF pg_temp.why(v_entry) <> 'not_listed_at_version' OR pg_temp.status(v_entry) <> 'discovered' THEN
    RAISE EXCEPTION 'a new runtime version kept the model: % %', pg_temp.why(v_entry), pg_temp.status(v_entry);
  END IF;
  IF pg_temp.reason_of(format('SELECT team_model(%L,%L)', v_owner, v_entry)) <> 'catalog_entry_unavailable' THEN
    RAISE EXCEPTION 'the team function accepted a model not checked at the active version';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM catalog_refresh_jobs WHERE connection_id = v_codex AND reason = 'runtime_version_changed'
                 AND status = 'pending') THEN
    RAISE EXCEPTION 'a version change did not ask for the list at the new version';
  END IF;
  -- Listed there too, but checked only at the old version.
  INSERT INTO model_listings(entry_id,runtime_type,runtime_version) VALUES(v_entry,'codex','0.158.0');
  IF pg_temp.why(v_entry) <> 'runtime_version_changed' THEN
    RAISE EXCEPTION 'a check at another version counted: %', pg_temp.why(v_entry);
  END IF;
  -- The rollback brings the version back, and the check made there counts again.
  PERFORM record_runtime_activation('codex','rollback','0.154.0','0.158.0',NULL,false,'','test');
  IF pg_temp.why(v_entry) <> 'eligible' OR pg_temp.status(v_entry) <> 'verified' THEN
    RAISE EXCEPTION 'a rollback did not restore the model: %', pg_temp.why(v_entry);
  END IF;
  IF (SELECT source FROM runtime_active_versions WHERE runtime_type = 'codex') <> 'activation' THEN
    RAISE EXCEPTION 'the activation did not set the active version';
  END IF;

  -- A credential stored over a working one: the connection stays connected,
  -- the generation moves, and the check made under the old one stops counting.
  SELECT credential_generation INTO v_generation FROM provider_connections WHERE id = v_codex;
  INSERT INTO provider_login_sessions(operator_id,connection_id,provider,status,state_digest,expires_at)
    VALUES(v_owner,v_codex,'codex','pending',repeat('b',64),clock_timestamp()+interval '10 minutes')
    RETURNING id INTO v_session;
  UPDATE provider_login_sessions SET status='consumed', consumed_at=clock_timestamp() WHERE id = v_session;
  IF (SELECT credential_generation FROM provider_connections WHERE id = v_codex) <> v_generation + 1 THEN
    RAISE EXCEPTION 'a consumed login did not bump the credential generation';
  END IF;
  IF pg_temp.why(v_entry) <> 'credential_changed' OR pg_temp.status(v_entry) <> 'discovered' THEN
    RAISE EXCEPTION 'a new credential kept the old check: % %', pg_temp.why(v_entry), pg_temp.status(v_entry);
  END IF;
  -- ...and the small subscription list is checked again by itself.
  IF NOT EXISTS (SELECT 1 FROM model_checks WHERE entry_id = v_entry AND finished_at IS NULL AND automatic) THEN
    RAISE EXCEPTION 'a new credential queued no automatic check';
  END IF;
  v_check := pg_temp.check(v_owner, v_entry, 'passed');
  IF pg_temp.status(v_entry) <> 'verified' THEN RAISE EXCEPTION 'the re-check did not restore the model'; END IF;

  -- A return to connected is a new credential too.
  UPDATE provider_connections SET status='action_required' WHERE id = v_codex;
  IF pg_temp.why(v_entry) <> 'connection_not_connected' OR pg_temp.status(v_entry) <> 'discovered' THEN
    RAISE EXCEPTION 'a connection that is not connected kept its model: %', pg_temp.why(v_entry);
  END IF;
  UPDATE provider_connections SET status='connected' WHERE id = v_codex;
  IF (SELECT credential_generation FROM provider_connections WHERE id = v_codex) <> v_generation + 2 THEN
    RAISE EXCEPTION 'a return to connected did not bump the credential generation';
  END IF;
  IF pg_temp.why(v_entry) <> 'credential_changed' THEN RAISE EXCEPTION 'the reconnect kept the old check'; END IF;
  v_check := pg_temp.check(v_owner, v_entry, 'passed');

  -- A rejected check at the current key takes the model away and says why.
  PERFORM pg_temp.check(v_owner, v_other, 'rejected');
  IF pg_temp.status(v_other) <> 'rejected' OR pg_temp.why(v_other) <> 'check_rejected'
     OR (SELECT failure_code FROM provider_model_catalog WHERE id = v_other) <> 'model_check_rejected' THEN
    RAISE EXCEPTION 'a rejected check: % %', pg_temp.status(v_other), pg_temp.why(v_other);
  END IF;
  -- An inconclusive attempt moves nothing.
  PERFORM request_model_check(v_owner, v_other, 'check_again');
  DELETE FROM model_checks WHERE finished_at IS NULL AND entry_id <> v_other;
  v_result := claim_model_checks('eligibility-worker', interval '5 minutes')->0;
  PERFORM defer_model_check((v_result->>'check_id')::uuid, 'eligibility-worker', 'usage limit', true);
  IF pg_temp.status(v_other) <> 'rejected' THEN RAISE EXCEPTION 'an inconclusive attempt moved eligibility'; END IF;

  -- A health report of a version is noted like any other source.
  INSERT INTO runtime_health(singleton,status,snapshot,observed_at) VALUES(true,'healthy',
    jsonb_build_object('runtimes',jsonb_build_array(
      jsonb_build_object('runtime','codex','version','0.154.0','installed',true,'authenticated',true),
      jsonb_build_object('runtime','opencode','version','1.18.31','installed',true,'authenticated',true),
      jsonb_build_object('runtime','nothing-known','version','9.9.9','installed',true))),clock_timestamp())
  ON CONFLICT (singleton) DO UPDATE SET snapshot=EXCLUDED.snapshot, observed_at=EXCLUDED.observed_at;
  IF active_runtime_version('opencode') <> '1.18.31' OR active_runtime_version('codex') <> '0.154.0' THEN
    RAISE EXCEPTION 'the health report did not set the active versions';
  END IF;

  -- A promotion by a qualification carries the in-use models it re-checked.
  INSERT INTO projects(owner_id,name,slug,workspace_path)
    VALUES(v_owner,'Eligibility','eligibility-w6','/srv/infra-cod/workspaces/eligibility-w6') RETURNING id INTO v_project;
  INSERT INTO project_runtime_defaults(project_id,orchestrator_entry_id) VALUES(v_project,v_entry);
  INSERT INTO runtime_qualifications(runtime_type,version,adapter_version,release_version,requested_by,result,finished_at)
    VALUES('codex','0.158.0','1.0.0','test','test','passed',clock_timestamp()) RETURNING id INTO v_qualification;
  INSERT INTO runtime_qualification_checks(qualification_id,check_key,capability,result,failure_class,detail)
    VALUES(v_qualification,'models.in_use','gate.smoke','passed','','gpt-5.6-luna: ok');
  PERFORM record_runtime_activation('codex','promote','0.158.0','0.154.0',v_qualification,false,'','test');
  IF pg_temp.why(v_entry) <> 'eligible' OR pg_temp.status(v_entry) <> 'verified' THEN
    RAISE EXCEPTION 'the in-use model the qualification re-checked was not carried: %', pg_temp.why(v_entry);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM model_checks WHERE entry_id = v_entry AND trigger = 'qualification'
                 AND qualification_id = v_qualification AND runtime_version = '0.158.0' AND result = 'passed') THEN
    RAISE EXCEPTION 'the carried check does not name its qualification';
  END IF;
  -- The other model is neither in use nor re-checked: listed at the new
  -- version (the qualification's list read did not fail), it waits for its own.
  IF pg_temp.why(v_other) <> 'not_checked' THEN
    RAISE EXCEPTION 'a model the qualification did not re-check was carried: %', pg_temp.why(v_other);
  END IF;

  -- A row no check ever judged keeps its writer's status (fixtures, and what an
  -- older release inserts directly).
  INSERT INTO provider_model_catalog(operator_id,connection_id,runtime_type,provider_id,model_id,discovery_source,
      status,last_verified_at,verification_id)
    VALUES(v_owner,v_codex,'codex','chatgpt','legacy-model','codex_model_list','verified',clock_timestamp(),gen_random_uuid())
    RETURNING id INTO v_legacy;
  IF pg_temp.why(v_legacy) <> 'legacy' OR pg_temp.status(v_legacy) <> 'verified' THEN
    RAISE EXCEPTION 'a row without checks lost its status: % %', pg_temp.why(v_legacy), pg_temp.status(v_legacy);
  END IF;

  -- A task run that failed on its model: one refresh, one re-check, later.
  INSERT INTO tasks(project_id,title,objective,status,created_by)
    VALUES(v_project,'Run failure','test','planning','test') RETURNING id INTO v_task;
  INSERT INTO task_runtime_snapshots(task_id,orchestrator,source)
    VALUES(v_task,jsonb_build_object('entry_id',v_entry,'model_id','gpt-5.6-luna'),'catalog');
  v_event := append_event('chat.user_message',v_project,v_task,NULL,'user','operator',NULL,
    'w6-run-failure','w6-run-failure','task',v_task,(SELECT version FROM tasks WHERE id=v_task),'{}');
  INSERT INTO runtime_jobs(source_event_id,job_type,project_id,task_id,payload)
    VALUES(v_event.id,'orchestrator_turn',v_project,v_task,'{}') RETURNING id INTO v_job;
  UPDATE catalog_refresh_jobs SET status='failed', failure_code='test-isolation' WHERE connection_id = v_codex
    AND status IN ('pending','in_progress');
  DELETE FROM model_checks WHERE entry_id = v_entry AND finished_at IS NULL;
  -- A limit is not the model's: nothing is asked.
  UPDATE runtime_jobs SET last_error = 'Codex usage limit reached; try again at 14:20' WHERE id = v_job;
  IF EXISTS (SELECT 1 FROM model_checks WHERE entry_id = v_entry AND trigger = 'run_failure') THEN
    RAISE EXCEPTION 'a limit was recorded against the model';
  END IF;
  UPDATE runtime_jobs SET last_error = 'Codex exited: the model is not supported when using Codex with a ChatGPT account'
  WHERE id = v_job;
  IF NOT EXISTS (SELECT 1 FROM model_checks WHERE entry_id = v_entry AND trigger = 'run_failure'
                 AND finished_at IS NULL AND not_before > clock_timestamp() AND automatic AND priority = 2) THEN
    RAISE EXCEPTION 'a model failure of a run queued no re-check';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM catalog_refresh_jobs WHERE connection_id = v_codex AND reason = 'run_model_failure') THEN
    RAISE EXCEPTION 'a model failure of a run asked for no refresh';
  END IF;
  -- Still eligible until the re-check says otherwise.
  IF pg_temp.status(v_entry) <> 'verified' THEN RAISE EXCEPTION 'the run failure alone took the model away'; END IF;
  -- The second failure within the hour asks for nothing more.
  v_result := record_run_model_failure(v_job, 'model', 'model not found');
  IF (SELECT count(*) FROM model_checks WHERE entry_id = v_entry AND trigger = 'run_failure') <> 1 THEN
    RAISE EXCEPTION 'a second run failure queued a second re-check';
  END IF;
  IF (record_run_model_failure(v_job, 'infrastructure', 'rate limit'))->>'recorded' <> 'false' THEN
    RAISE EXCEPTION 'an infrastructure failure was recorded against the model';
  END IF;
  IF model_failure_class('Claude Code rate limited: try later') <> 'infrastructure'
     OR model_failure_class('Claude Code model not available: claude-x') <> 'model'
     OR model_failure_class('runtime run exceeded 30 minutes') IS NOT NULL THEN
    RAISE EXCEPTION 'model_failure_class misreads a failure';
  END IF;

  RAISE NOTICE 'model eligibility assertions passed';
END $$;

-- The host's shape after the migration (rc.85): rows the old gate verified at
-- OpenCode 1.18.31, each with the legacy check 0099 gave it, listed there, a
-- team on three of them; then a promotion to 1.18.32 by a passed qualification
-- that re-checked those three and read the list. (0099's backfill gave the
-- promotions recorded before it the same carry; it was dropped in W5-b, 0106.)
DO $$
DECLARE v_owner uuid; v_zen uuid; v_router uuid; v_project uuid; v_q uuid; v_model text;
BEGIN
  INSERT INTO users(display_name,role) VALUES('Host-shaped owner','owner') RETURNING id INTO v_owner;
  INSERT INTO provider_connections(operator_id,provider,auth_method,status,access_gateway,billing_boundary,native_credential_reference)
    VALUES(v_owner,'opencode','native','connected','opencode_zen','free','opencode-home:opencode-worker') RETURNING id INTO v_zen;
  INSERT INTO provider_connections(operator_id,provider,auth_method,status,access_gateway,billing_boundary,native_credential_reference)
    VALUES(v_owner,'opencode','api_key','connected','openrouter','third_party_metered','opencode-home:opencode-worker')
    RETURNING id INTO v_router;
  INSERT INTO runtime_active_versions(runtime_type,version,source) VALUES('opencode','1.18.31','baseline')
  ON CONFLICT (runtime_type) DO UPDATE SET version=EXCLUDED.version, source=EXCLUDED.source;
  INSERT INTO provider_model_catalog(operator_id,connection_id,runtime_type,provider_id,model_id,adapter_version,runtime_version,
      discovery_source,status,last_verified_at,verification_id)
    VALUES (v_owner,v_zen,'opencode','opencode','big-pickle','1.18.31','1.18.31','opencode_provider_api','verified',clock_timestamp()-interval '3 days',gen_random_uuid()),
           (v_owner,v_zen,'opencode','opencode','nemotron-3.5-lightning-free','1.18.31','1.18.31','opencode_provider_api','verified',clock_timestamp()-interval '3 days',gen_random_uuid()),
           (v_owner,v_router,'opencode','openrouter','openai/gpt-6-luna','1.18.31','1.18.31','opencode_provider_api','verified',clock_timestamp()-interval '3 days',gen_random_uuid()),
           (v_owner,v_router,'opencode','openrouter','openai/gpt-6-luna-pro','1.18.31','1.18.31','opencode_provider_api','verified',clock_timestamp()-interval '3 days',gen_random_uuid()),
           (v_owner,v_router,'opencode','openrouter','qwen/qwen3.5-coder','1.18.31','1.18.31','opencode_provider_api','discovered',NULL,NULL);
  INSERT INTO model_listings(entry_id,runtime_type,runtime_version)
    SELECT id,'opencode','1.18.31' FROM provider_model_catalog WHERE operator_id=v_owner;
  INSERT INTO model_checks(entry_id,operator_id,connection_id,runtime_type,runtime_version,adapter_version,
      credential_generation,trigger,automatic,priority,result,detail,model_called,requested_by,requested_at,started_at,finished_at)
    SELECT m.id,m.operator_id,m.connection_id,m.runtime_type,'1.18.31',m.adapter_version,c.credential_generation,
      'legacy',true,3,'passed','verified by the capability gate before model checks',true,'migration 0099',
      m.last_verified_at,m.last_verified_at,m.last_verified_at
    FROM provider_model_catalog m JOIN provider_connections c ON c.id=m.connection_id
    WHERE m.operator_id=v_owner AND m.status='verified';
  INSERT INTO projects(owner_id,name,slug,workspace_path)
    VALUES(v_owner,'infra','infra-host-shaped','/srv/infra-cod/workspaces/infra-host-shaped') RETURNING id INTO v_project;
  INSERT INTO project_runtime_default_executors(project_id,catalog_entry_id,priority)
    SELECT v_project,id,row_number() OVER (ORDER BY model_id)*100 FROM provider_model_catalog
    WHERE operator_id=v_owner AND model_id IN ('big-pickle','nemotron-3.5-lightning-free','openai/gpt-6-luna');
  INSERT INTO runtime_qualifications(runtime_type,version,adapter_version,release_version,requested_by,result,started_at,finished_at)
    VALUES('opencode','1.18.32','1.0.0','rc.82','owner','passed',clock_timestamp()-interval '26 hours',clock_timestamp()-interval '25 hours')
    RETURNING id INTO v_q;
  INSERT INTO runtime_qualification_checks(qualification_id,check_key,capability,result,failure_class,detail)
    VALUES (v_q,'models.in_use','gate.smoke','passed','','big-pickle: ok, nemotron-3.5-lightning-free: ok, openai/gpt-6-luna: ok'),
           (v_q,'catalog.list','catalog.models','passed','','336 models; no change');
  PERFORM record_runtime_activation('opencode','promote','1.18.32','1.18.31',v_q,false,'','owner');

  -- Every in-use model stays selectable, and the team's defaults resolve.
  FOREACH v_model IN ARRAY ARRAY['big-pickle','nemotron-3.5-lightning-free','openai/gpt-6-luna'] LOOP
    IF (SELECT status FROM provider_model_catalog WHERE operator_id=v_owner AND model_id=v_model) <> 'verified' THEN
      RAISE EXCEPTION '% is not selectable after the promotion: %', v_model,
        (SELECT model_eligibility(id) FROM provider_model_catalog WHERE operator_id=v_owner AND model_id=v_model);
    END IF;
  END LOOP;
  PERFORM team_model(v_owner, e.catalog_entry_id) FROM project_runtime_default_executors e WHERE e.project_id = v_project;
  -- The one verified model not in use waits for its own check at the new version.
  IF (SELECT model_eligibility(id)->>'reason' FROM provider_model_catalog
      WHERE operator_id=v_owner AND model_id='openai/gpt-6-luna-pro') <> 'runtime_version_changed' THEN
    RAISE EXCEPTION 'a verified model not in use kept its check across the promotion';
  END IF;
  -- It is listed at the new version.
  IF NOT EXISTS (SELECT 1 FROM model_listings l JOIN provider_model_catalog m ON m.id=l.entry_id
                 WHERE m.operator_id=v_owner AND m.model_id='openai/gpt-6-luna-pro' AND l.runtime_version='1.18.32') THEN
    RAISE EXCEPTION 'a model listed at the version left is not listed at the new one';
  END IF;
END $$;

-- The trigger does the same for a promotion recorded from now on; a
-- qualification whose list read failed carries the re-checked models only.
DO $$
DECLARE v_owner uuid; v_q uuid;
BEGIN
  SELECT id INTO v_owner FROM users WHERE display_name='Host-shaped owner';
  INSERT INTO runtime_qualifications(runtime_type,version,adapter_version,release_version,requested_by,result,finished_at)
    VALUES('opencode','1.18.33','1.0.0','rc.90','owner','passed',clock_timestamp()) RETURNING id INTO v_q;
  INSERT INTO runtime_qualification_checks(qualification_id,check_key,capability,result,failure_class,detail)
    VALUES (v_q,'models.in_use','gate.smoke','passed','','big-pickle: ok, nemotron-3.5-lightning-free: ok, openai/gpt-6-luna: ok'),
           (v_q,'catalog.list','catalog.models','failed','runtime','the model list could not be read');
  PERFORM record_runtime_activation('opencode','promote','1.18.33','1.18.32',v_q,false,'','owner');
  IF (SELECT count(*) FROM provider_model_catalog WHERE operator_id=v_owner AND status='verified') <> 3 THEN
    RAISE EXCEPTION 'a promotion took an in-use model away: %',
      (SELECT jsonb_agg(model_id||' '||status) FROM provider_model_catalog WHERE operator_id=v_owner);
  END IF;
  IF EXISTS (SELECT 1 FROM model_listings l JOIN provider_model_catalog m ON m.id=l.entry_id
             WHERE m.operator_id=v_owner AND m.model_id='qwen/qwen3.5-coder' AND l.runtime_version='1.18.33') THEN
    RAISE EXCEPTION 'a failed list read still carried the listings';
  END IF;
  RAISE NOTICE 'host-shaped promotion assertions passed';
END $$;

ROLLBACK;
