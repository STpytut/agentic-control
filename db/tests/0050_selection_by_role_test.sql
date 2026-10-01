-- Selection by role and capability (migration 0074, Stage 11.2 N2).
--
-- The database decides who may orchestrate and who may execute by whether a
-- runtime plays the role — registered for it, with its driver declaring the
-- role's whole core — never by the runtime's name. So:
--
--   * an assignment to a role its runtime does not play is refused by the
--     database, by reason: Codex as an executor, and a runtime nothing
--     registers (Antigravity, before this test registers it) as an
--     orchestrator. OpenCode plays both since 0076;
--   * the mutation: take one core capability away from Codex and Codex, still
--     registered as the orchestrator, is refused as one — it is the capability
--     that holds the role up, not the name;
--   * a task whose orchestrator is *not* Codex, on a runtime registered for the
--     role, has its chat message routed to an orchestrator turn — which before
--     0074 was routed nowhere;
--   * no effective function names a runtime except those that deal in its
--     identity rather than its permission, each listed with why.
\set ON_ERROR_STOP on

BEGIN;
SET search_path TO control_plane,public,extensions;

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

-- Only identity, never permission, may name a runtime.
DO $$
DECLARE v_named text;
BEGIN
  SELECT string_agg(p.proname, ', ' ORDER BY p.proname) INTO v_named
  FROM pg_proc p
  WHERE p.pronamespace='control_plane'::regnamespace AND p.prokind='f'
    AND p.prosrc ~ '''(codex|opencode|antigravity)'''
    AND p.proname NOT IN (
      -- Credentials and connections: per runtime until 11.4.
      'claim_codex_connection_work','claim_codex_login_sessions','complete_codex_connection_work',
      'complete_codex_device_login','fail_codex_connection_work','fail_codex_device_login',
      'get_operator_codex_connection','get_operator_codex_login_status','publish_codex_device_code',
      'request_codex_connection_action','start_codex_device_login',
      'claim_opencode_connection_work','claim_opencode_enrollments','complete_opencode_connection_work',
      'complete_opencode_enrollment','expire_opencode_enrollments','fail_opencode_connection_work',
      'fail_opencode_enrollment','get_operator_opencode_connections','get_operator_opencode_enrollment_status',
      'request_opencode_connection_action','start_opencode_enrollment','store_opencode_enrollment_secret',
      -- Which gateway a runtime's connection reaches, and whose models it names (0083):
      -- identity of the connection, not a permission.
      'fill_connection_gateway','catalog_model_vendor',
      -- The model catalog is refreshed through a runtime's connection.
      'request_catalog_refresh','request_catalog_refreshes_due',
      -- Validation that a value is a runtime at all (schemaGaps holds these to the registry).
      'append_runtime_activity_event','ensure_structural_runtime_profile','upsert_catalog_entries',
      -- History: every task before runtime snapshots had a Codex orchestrator.
      'backfill_legacy_runtime_snapshots');
  IF v_named IS NOT NULL THEN
    RAISE EXCEPTION 'functions still decide on a runtime''s name: %', v_named;
  END IF;
END $$;

DO $$
DECLARE
  v_user uuid; v_project uuid; v_codex_profile uuid; v_opencode_profile uuid; v_other_profile uuid;
  v_codex uuid; v_worker uuid; v_other uuid; v_oc_architect uuid; v_codex_implementer uuid; v_other_assignment uuid; v_task uuid;
  v_event domain_events; v_message outbox_messages; v_route jsonb; v_reason text;
BEGIN
  INSERT INTO users(display_name) VALUES('Role Test') RETURNING id INTO v_user;
  INSERT INTO projects(owner_id,name,slug,workspace_path)
    VALUES(v_user,'Role Test','role-test','/srv/role-test') RETURNING id INTO v_project;
  INSERT INTO runtime_profiles(runtime_type,adapter_version,runtime_version,provider_type,model)
    VALUES('codex','test','test','openai','codex-role') RETURNING id INTO v_codex_profile;
  INSERT INTO runtime_profiles(runtime_type,adapter_version,runtime_version,provider_type,model)
    VALUES('opencode','test','test','openrouter','opencode-role') RETURNING id INTO v_opencode_profile;
  INSERT INTO runtime_profiles(runtime_type,adapter_version,runtime_version,provider_type,model)
    VALUES('antigravity','test','test','google','other-role') RETURNING id INTO v_other_profile;
  INSERT INTO agents(name,role,runtime_profile_id) VALUES('role-codex','architect',v_codex_profile) RETURNING id INTO v_codex;
  INSERT INTO agents(name,role,runtime_profile_id) VALUES('role-worker','implementer',v_opencode_profile) RETURNING id INTO v_worker;
  INSERT INTO agents(name,role,runtime_profile_id) VALUES('role-other','architect',v_other_profile) RETURNING id INTO v_other;
  -- Agents fit for the role, so what refuses is the runtime, not the agent.
  INSERT INTO agents(name,role,runtime_profile_id) VALUES('role-oc-architect','architect',v_opencode_profile) RETURNING id INTO v_oc_architect;
  INSERT INTO agents(name,role,runtime_profile_id) VALUES('role-codex-implementer','implementer',v_codex_profile) RETURNING id INTO v_codex_implementer;

  -- The registered pairs are accepted.
  INSERT INTO project_agent_assignments(project_id,agent_id,runtime_profile_id,assignment_role,is_default)
    VALUES(v_project,v_codex,v_codex_profile,'orchestrator',true);
  INSERT INTO project_agent_assignments(project_id,agent_id,runtime_profile_id,assignment_role)
    VALUES(v_project,v_worker,v_opencode_profile,'executor');

  -- The others are refused by the database, by reason.
  v_reason:=pg_temp.reason_of(format($q$INSERT INTO project_agent_assignments(project_id,agent_id,runtime_profile_id,assignment_role)
    VALUES(%L,%L,%L,'orchestrator')$q$, v_project, v_other, v_other_profile));
  IF v_reason IS DISTINCT FROM 'runtime_cannot_play_role' THEN
    RAISE EXCEPTION 'an unregistered runtime was assigned the orchestrator: %', v_reason;
  END IF;
  -- 0076: OpenCode plays the orchestrator too.
  INSERT INTO project_agent_assignments(project_id,agent_id,runtime_profile_id,assignment_role)
    VALUES(v_project,v_oc_architect,v_opencode_profile,'orchestrator');
  -- 0123 made Codex an executor; the refusal is of a runtime the role is not
  -- registered for, so here it is not.
  DELETE FROM runtime_roles WHERE runtime_type='codex' AND role='executor';
  v_reason:=pg_temp.reason_of(format($q$INSERT INTO project_agent_assignments(project_id,agent_id,runtime_profile_id,assignment_role)
    VALUES(%L,%L,%L,'executor')$q$, v_project, v_codex_implementer, v_codex_profile));
  IF v_reason IS DISTINCT FROM 'runtime_cannot_play_role' THEN
    RAISE EXCEPTION 'Codex was assigned the executor: %', v_reason;
  END IF;
  -- A disabled row is history, not an assignment, and is left alone.
  INSERT INTO project_agent_assignments(project_id,agent_id,runtime_profile_id,assignment_role,enabled)
    VALUES(v_project,v_codex_implementer,v_codex_profile,'executor',false);

  -- The mutation: registered, but missing a core capability.
  DELETE FROM runtime_capabilities WHERE runtime_type='codex' AND capability='run.read_only';
  IF runtime_plays('codex','orchestrator') THEN
    RAISE EXCEPTION 'Codex still plays the orchestrator without run.read_only';
  END IF;
  v_reason:=pg_temp.reason_of(format($q$INSERT INTO project_agent_assignments(project_id,agent_id,runtime_profile_id,assignment_role)
    VALUES(%L,%L,%L,'orchestrator')$q$, v_project, v_codex, v_codex_profile));
  IF v_reason IS DISTINCT FROM 'runtime_cannot_play_role' THEN
    RAISE EXCEPTION 'an orchestrator without its core was assigned: %', v_reason;
  END IF;
  INSERT INTO runtime_capabilities(runtime_type,capability) VALUES('codex','run.read_only');

  -- A non-Codex orchestrator, registered for the role with its core.
  INSERT INTO runtime_roles(runtime_type,role) VALUES('antigravity','orchestrator');
  INSERT INTO runtime_capabilities(runtime_type,capability)
    SELECT 'antigravity',capability FROM runtime_role_core WHERE role='orchestrator';
  INSERT INTO project_agent_assignments(project_id,agent_id,runtime_profile_id,assignment_role)
    VALUES(v_project,v_other,v_other_profile,'orchestrator') RETURNING id INTO v_other_assignment;
  INSERT INTO tasks(project_id,title,objective,constraints,acceptance_criteria,status,
    active_agent_id,orchestrator_assignment_id,created_by)
    VALUES(v_project,'Role task','Route by role','[]','["routed"]','planning',v_other,v_other_assignment,'test')
    RETURNING id INTO v_task;
  v_event:=append_event('chat.user_message',v_project,v_task,NULL,'user','test',NULL,v_task::text,
    'role-chat:'||v_task,'task',v_task,1,jsonb_build_object('content','Plan this'));
  v_message:=claim_outbox_event(v_event.id,'role-dispatcher',interval '1 minute');
  v_route:=route_outbox_message(v_message.id,'role-dispatcher');
  IF v_route->>'job_type' IS DISTINCT FROM 'orchestrator_turn' THEN
    RAISE EXCEPTION 'a non-Codex orchestrator''s chat was not routed to a turn: %', v_route;
  END IF;

  RAISE NOTICE 'selection by role and capability holds';
END $$;

ROLLBACK;
