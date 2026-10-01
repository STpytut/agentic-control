-- Least-privilege database roles for the self-hosted installation.
--
-- See docs/adr/0011-self-hosted-access-model.md. The goal is that infra_web
-- holds no INSERT/UPDATE/DELETE anywhere: every operator mutation goes through
-- an audited SECURITY DEFINER function, and secret-bearing columns are not
-- readable at all.
--
-- Part 1 lifts the web layer's remaining inline DML into functions.
-- Part 2 converts the existing operator functions to SECURITY DEFINER.
-- Part 3 creates the roles and grants.

BEGIN;

SET search_path TO control_plane, public, extensions;

-- ============================================================== part 1 ====
-- Functions replacing the web layer's inline writes.

-- Was control-plane-actions.ts:425. Scoped by owner, as the inline statement
-- was, and returns NULL when the project is not in a retryable failed state so
-- the caller keeps its own message.
CREATE OR REPLACE FUNCTION retry_project_provisioning(
  p_project_id uuid, p_owner_id uuid, p_actor text, p_correlation text DEFAULT ''
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_project projects%ROWTYPE;
BEGIN
  UPDATE projects SET
    status='needs_attention',
    updated_at=clock_timestamp(),
    settings=jsonb_set(settings-'provisioning_error','{provisioning_status}','"pending"'::jsonb,true)
  WHERE id=p_project_id AND owner_id=p_owner_id
    AND settings->>'provisioning_status'='failed'
  RETURNING * INTO v_project;

  IF NOT FOUND THEN RETURN NULL; END IF;

  PERFORM write_audit_event(v_project.id,NULL,NULL,'operator',p_actor,
    'project.provisioning_retried','project',v_project.id::text,'allowed',NULL,
    jsonb_build_object('repository_url',v_project.repository_url),p_correlation);

  RETURN jsonb_build_object(
    'project_id',v_project.id,
    'provisioning_status',v_project.settings->>'provisioning_status');
END $$;

-- Was control-plane-actions.ts:539. Returns NULL when the task is closed.
CREATE OR REPLACE FUNCTION record_task_chat_message(
  p_project_id uuid, p_task_id uuid, p_message text,
  p_actor text, p_correlation text DEFAULT ''
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_task tasks%ROWTYPE;
BEGIN
  UPDATE tasks SET version=version+1, updated_at=clock_timestamp()
  WHERE id=p_task_id AND project_id=p_project_id
    AND status NOT IN ('approved','deployed','completed','cancelled','failed')
  RETURNING * INTO v_task;

  IF NOT FOUND THEN RETURN NULL; END IF;

  PERFORM append_event('chat.user_message',v_task.project_id,v_task.id,NULL,'user',p_actor,
    NULL,p_correlation,'chat-message:'||v_task.id||':'||v_task.version,'task',v_task.id,
    v_task.version, jsonb_build_object('content',p_message));

  RETURN jsonb_build_object('project_id',v_task.project_id,'task_id',v_task.id,
                            'status',v_task.status,'version',v_task.version);
END $$;

-- Was control-plane-actions.ts:649-681 (an ownership probe, an allowlist insert
-- and a verification fan-out). Folding all three into one function makes the
-- ownership check and the insert atomic; as three separate statements the
-- catalog could change between the probe and the write.
CREATE OR REPLACE FUNCTION request_catalog_gate_allowlist(
  p_operator_id uuid, p_entry_ids jsonb, p_actor text, p_correlation text DEFAULT ''
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_ids uuid[];
  v_owned integer;
  v_requests jsonb;
BEGIN
  SELECT array_agg(DISTINCT value::uuid) INTO v_ids
  FROM jsonb_array_elements_text(p_entry_ids) AS t(value);

  IF v_ids IS NULL OR cardinality(v_ids)=0 OR cardinality(v_ids)>8 THEN
    RAISE EXCEPTION 'select at least one and at most eight catalog models to verify'
      USING ERRCODE='22023';
  END IF;

  SELECT count(*) INTO v_owned
  FROM provider_model_catalog m
  JOIN provider_connections c ON c.id=m.connection_id
  WHERE m.operator_id=p_operator_id AND m.id=ANY(v_ids);

  IF v_owned<>cardinality(v_ids) THEN
    RAISE EXCEPTION 'one or more selected models are not available for this account'
      USING ERRCODE='55000';
  END IF;

  INSERT INTO catalog_gate_allowlist(operator_id,connection_id,provider_id,model_id,created_by)
  SELECT m.operator_id,m.connection_id,m.provider_id,m.model_id,p_actor
  FROM provider_model_catalog m
  WHERE m.operator_id=p_operator_id AND m.id=ANY(v_ids)
  ON CONFLICT DO NOTHING;

  SELECT COALESCE(jsonb_agg(r.result),'[]'::jsonb) INTO v_requests
  FROM (
    SELECT request_catalog_verification(m.id,p_operator_id,p_actor,p_correlation) AS result
    FROM provider_model_catalog m
    WHERE m.operator_id=p_operator_id AND m.id=ANY(v_ids)
  ) r;

  RETURN jsonb_build_object('requests',v_requests);
END $$;

-- Was control-plane-actions.ts:453-508. Returns NULL when no orchestrator
-- assignment is usable; raises when the executor selection is unsatisfiable.
-- The inline version signalled that second case with a 1/0 division, which
-- surfaced as a division_by_zero error rather than anything an operator could
-- read.
CREATE OR REPLACE FUNCTION create_task_with_executors(
  p_project_id uuid, p_task_id uuid, p_title text, p_objective text,
  p_actor text, p_correlation text DEFAULT '',
  p_orchestrator_assignment_id uuid DEFAULT NULL,
  p_executor_assignment_ids jsonb DEFAULT '[]'::jsonb,
  p_executor_selection_explicit boolean DEFAULT false
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_orchestrator project_agent_assignments%ROWTYPE;
  v_task tasks%ROWTYPE;
  v_requested uuid[];
  v_selected uuid[];
  v_selected_count integer;
  v_snapshot jsonb;
BEGIN
  SELECT array_agg(DISTINCT value::uuid) INTO v_requested
  FROM jsonb_array_elements_text(p_executor_assignment_ids) AS t(value);
  v_requested := COALESCE(v_requested, ARRAY[]::uuid[]);

  SELECT pa.* INTO v_orchestrator
  FROM project_agent_assignments pa
  JOIN agents a ON a.id=pa.agent_id AND a.enabled
  JOIN runtime_profiles rp ON rp.id=pa.runtime_profile_id
    AND rp.enabled AND rp.last_verified_at IS NOT NULL
  WHERE pa.project_id=p_project_id AND pa.enabled
    AND pa.assignment_role='orchestrator' AND rp.runtime_type='codex'
    AND (p_orchestrator_assignment_id IS NULL OR pa.id=p_orchestrator_assignment_id)
  ORDER BY pa.is_default DESC, pa.created_at
  LIMIT 1;

  IF NOT FOUND THEN RETURN NULL; END IF;

  -- Ordering is the priority source, so it is captured once into an array and
  -- reused; a temp table would break on a second call within one transaction.
  SELECT array_agg(pa.id ORDER BY pa.created_at, pa.id) INTO v_selected
  FROM project_agent_assignments pa
  WHERE pa.project_id=p_project_id AND pa.enabled AND pa.assignment_role='executor'
    AND (NOT p_executor_selection_explicit OR pa.id=ANY(v_requested));

  v_selected := COALESCE(v_selected, ARRAY[]::uuid[]);
  v_selected_count := cardinality(v_selected);

  IF v_selected_count=0 THEN
    RAISE EXCEPTION 'this project has no enabled executor assignment' USING ERRCODE='55000';
  END IF;
  IF p_executor_selection_explicit AND v_selected_count<>cardinality(v_requested) THEN
    RAISE EXCEPTION 'one or more selected executors are unavailable' USING ERRCODE='55000';
  END IF;

  INSERT INTO tasks(id,project_id,title,objective,status,active_agent_id,
                    orchestrator_assignment_id,created_by)
  VALUES (p_task_id,p_project_id,p_title,p_objective,'planning',
          v_orchestrator.agent_id,v_orchestrator.id,p_actor)
  RETURNING * INTO v_task;

  INSERT INTO task_executor_assignments(task_id,project_agent_assignment_id,priority)
  SELECT v_task.id, e.id, (e.ord*100)::integer
  FROM unnest(v_selected) WITH ORDINALITY AS e(id, ord);

  v_snapshot := capture_task_runtime_snapshot(v_task.id, v_task.project_id, v_selected);

  PERFORM append_event('chat.user_message',v_task.project_id,v_task.id,NULL,'user',p_actor,
    NULL,p_correlation,'chat-message:'||v_task.id||':1','task',v_task.id,v_task.version,
    jsonb_build_object('content',v_task.objective,'title',v_task.title,
      'orchestrator_assignment_id',v_task.orchestrator_assignment_id,
      'executor_assignment_ids',to_jsonb(v_selected),
      'snapshot_source',COALESCE(v_snapshot->>'source','')));

  RETURN jsonb_build_object('project_id',v_task.project_id,'task_id',v_task.id,
    'status',v_task.status,'version',v_task.version,
    'orchestrator_assignment_id',v_task.orchestrator_assignment_id,
    'executor_count',v_selected_count,
    'snapshot_source',COALESCE(v_snapshot->>'source',''));
END $$;

-- Was control-plane-actions.ts:212-287: a single CTE inserting a project, an
-- orchestrator agent and its assignment, the executor agents and theirs, the
-- workspace lock row and the creation event. Returns NULL when no orchestrator
-- runtime qualifies, matching the inline version, where the final CROSS JOIN
-- against an empty orchestrator_assignment produced no row.
--
-- The GitHub guard was also a 1/0 division. It is a real precondition — the
-- selected repository must still be visible to a connected installation and not
-- archived — so it now raises with a message an operator can act on.
CREATE OR REPLACE FUNCTION create_project_with_roster(
  p_project_id uuid, p_owner_id uuid, p_name text, p_slug text,
  p_workspace_path text, p_repository text, p_branch text,
  p_settings jsonb, p_credential_mode text,
  p_orchestrator_profile_id uuid, p_executor_profile_ids jsonb,
  p_actor text, p_correlation text DEFAULT '',
  p_provider_connection_id uuid DEFAULT NULL,
  p_github_repository_id bigint DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  -- Scalars rather than a record: with no GitHub selection there is nothing to
  -- assign, and an unassigned record raises on first field reference.
  v_repo_full_name text;
  v_repo_clone_url text;
  v_repo_default_branch text;
  v_repo_archived boolean;
  v_project projects%ROWTYPE;
  v_orchestrator_agent agents%ROWTYPE;
  v_orchestrator_profile runtime_profiles%ROWTYPE;
  v_executor_count integer := 0;
  v_requested uuid[];
BEGIN
  -- Resolve the GitHub selection first: nothing should be created if it is stale.
  IF p_provider_connection_id IS NOT NULL THEN
    SELECT r.full_name, r.clone_url, r.default_branch, r.archived
    INTO v_repo_full_name, v_repo_clone_url, v_repo_default_branch, v_repo_archived
    FROM provider_installation_repositories r
    JOIN provider_connections c ON c.id=r.connection_id
    WHERE r.connection_id=p_provider_connection_id
      AND r.github_repository_id=p_github_repository_id
      AND c.operator_id=p_owner_id
      AND c.provider='github' AND c.status='connected';

    IF NOT FOUND THEN
      RAISE EXCEPTION 'the selected GitHub repository is no longer available to the GitHub App'
        USING ERRCODE='55000';
    END IF;
    IF v_repo_archived THEN
      RAISE EXCEPTION 'the selected GitHub repository is archived' USING ERRCODE='55000';
    END IF;
  END IF;

  -- The orchestrator runtime must be enabled, verified and a Codex runtime.
  SELECT * INTO v_orchestrator_profile FROM runtime_profiles rp
  WHERE rp.id=p_orchestrator_profile_id
    AND rp.enabled AND rp.last_verified_at IS NOT NULL AND rp.runtime_type='codex';
  IF NOT FOUND THEN RETURN NULL; END IF;

  SELECT array_agg(value::uuid) INTO v_requested
  FROM jsonb_array_elements_text(p_executor_profile_ids) AS t(value);
  v_requested := COALESCE(v_requested, ARRAY[]::uuid[]);

  INSERT INTO projects(id,owner_id,name,slug,workspace_path,repository_url,default_branch,
                       status,settings,credential_mode,provider_connection_id,
                       github_repository_id,repository_full_name)
  VALUES (p_project_id,p_owner_id,p_name,p_slug,p_workspace_path,
          COALESCE(v_repo_clone_url, NULLIF(p_repository,'')),
          COALESCE(v_repo_default_branch, p_branch),
          'needs_attention',p_settings,p_credential_mode,
          p_provider_connection_id,p_github_repository_id,v_repo_full_name)
  RETURNING * INTO v_project;

  INSERT INTO agents(name,role,runtime_profile_id)
  VALUES ('orchestrator-'||v_orchestrator_profile.runtime_type||'-'||v_project.id,
          'architect',v_orchestrator_profile.id)
  RETURNING * INTO v_orchestrator_agent;

  INSERT INTO project_agent_assignments(project_id,agent_id,runtime_profile_id,
                                        assignment_role,is_default)
  VALUES (v_project.id,v_orchestrator_agent.id,v_orchestrator_agent.runtime_profile_id,
          'orchestrator',true);

  WITH executor_profiles AS (
    SELECT rp.*, row_number() OVER(ORDER BY rp.runtime_type,rp.provider_type,rp.model,rp.id) AS ordinal
    FROM runtime_profiles rp
    WHERE rp.id=ANY(v_requested)
      AND rp.enabled AND rp.last_verified_at IS NOT NULL
      AND rp.runtime_type IN ('opencode','antigravity')
  ), executor_agents AS (
    INSERT INTO agents(name,role,runtime_profile_id)
    SELECT 'executor-'||ep.runtime_type||'-'||ep.ordinal||'-'||v_project.id,'implementer',ep.id
    FROM executor_profiles ep
    RETURNING *
  ), executor_assignments AS (
    INSERT INTO project_agent_assignments(project_id,agent_id,runtime_profile_id,assignment_role)
    SELECT v_project.id,a.id,a.runtime_profile_id,'executor' FROM executor_agents a
    RETURNING id
  ) SELECT count(*) INTO v_executor_count FROM executor_assignments;

  INSERT INTO workspace_locks(project_id) VALUES (v_project.id);

  PERFORM append_event('project.created',v_project.id,NULL,NULL,'user',p_actor,NULL,p_correlation,
    'project-created:'||v_project.id,'project',v_project.id,v_project.version,
    jsonb_build_object('name',v_project.name,'slug',v_project.slug,
      'provisioning_status','pending','credential_mode',p_credential_mode,
      'repository_full_name',v_project.repository_full_name,
      'orchestrator_profile_id',p_orchestrator_profile_id,
      'executor_profile_ids',p_executor_profile_ids));

  RETURN jsonb_build_object('project_id',v_project.id,'slug',v_project.slug,
    'status',v_project.status,'workspace_path',v_project.workspace_path,
    'orchestrator_profile_id',p_orchestrator_profile_id,
    'credential_mode',v_project.credential_mode,
    'repository_full_name',v_project.repository_full_name,
    'executor_count',v_executor_count);
END $$;

-- Pinning search_path is the hard prerequisite for SECURITY DEFINER: without it
-- a caller could shadow an unqualified name and have it resolved with the
-- function owner's privileges. pg_temp is listed last for the same reason.
ALTER FUNCTION retry_project_provisioning(uuid,uuid,text,text)
  SET search_path=control_plane,public,extensions,pg_temp;
ALTER FUNCTION record_task_chat_message(uuid,uuid,text,text,text)
  SET search_path=control_plane,public,extensions,pg_temp;
ALTER FUNCTION request_catalog_gate_allowlist(uuid,jsonb,text,text)
  SET search_path=control_plane,public,extensions,pg_temp;
ALTER FUNCTION create_task_with_executors(uuid,uuid,text,text,text,text,uuid,jsonb,boolean)
  SET search_path=control_plane,public,extensions,pg_temp;
ALTER FUNCTION create_project_with_roster(uuid,uuid,text,text,text,text,text,jsonb,text,uuid,jsonb,text,text,uuid,bigint)
  SET search_path=control_plane,public,extensions,pg_temp;

-- Operator audit writes, narrowed.
--
-- infra_web previously needed EXECUTE on write_audit_event, whose actor_type
-- and actor are parameters: the web role could attribute an entry to anyone.
-- This forces actor_type='operator' and derives the actor from the user id, so
-- an audit entry cannot be forged, and constrains the action to the two
-- namespaces the web layer actually writes.
CREATE OR REPLACE FUNCTION write_operator_audit(
  p_user_id uuid, p_action text, p_target_type text, p_target_id text,
  p_decision text DEFAULT 'allowed', p_details jsonb DEFAULT '{}'::jsonb,
  p_project_id uuid DEFAULT NULL, p_correlation text DEFAULT ''
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM users u WHERE u.id=p_user_id AND u.role='owner') THEN
    RAISE EXCEPTION 'operator is unavailable' USING ERRCODE='55000';
  END IF;
  -- A bracket expression rather than an escaped dot: with
  -- standard_conforming_strings=on a backslash in a SQL literal is literal, so
  -- '\\.' reaches the regex engine as "backslash, any char" and matches nothing.
  IF p_action !~ '^(auth|operator)[.][a-z0-9_]+$' THEN
    RAISE EXCEPTION 'unsupported operator audit action: %', p_action USING ERRCODE='22023';
  END IF;
  IF p_decision NOT IN ('allowed','denied','not_required') THEN
    RAISE EXCEPTION 'unsupported audit decision: %', p_decision USING ERRCODE='22023';
  END IF;

  RETURN jsonb_build_object('audit_event_id', write_audit_event(
    p_project_id, NULL, NULL, 'operator', p_user_id::text, p_action,
    p_target_type, p_target_id, p_decision, NULL, p_details, p_correlation));
END $$;

ALTER FUNCTION write_operator_audit(uuid,text,text,text,text,jsonb,uuid,text)
  SET search_path=control_plane,public,extensions,pg_temp;

-- ============================================================== part 2 ====
-- Convert the operator API to SECURITY DEFINER.
--
-- All 37 already carry a pinned search_path from the 0004/0009 convention,
-- which is the hard prerequisite: without it a caller could shadow an
-- unqualified name and have it resolved with the owner's privileges. Verified
-- before conversion, and the test re-asserts it.
--
-- 25 of these scope by a passed-in owner id; 12 do not. Per ADR-0011 that gap
-- is not exploitable while exactly one owner can exist, which users_role_check
-- enforces and db/tests/0026 pins.

ALTER FUNCTION append_event(p_event_type text, p_project_id uuid, p_task_id uuid, p_run_id uuid, p_actor_type text, p_actor_id text, p_causation_id uuid, p_correlation_id text, p_idempotency_key text, p_aggregate_type text, p_aggregate_id uuid, p_aggregate_version bigint, p_payload jsonb, p_destination text) SECURITY DEFINER;
ALTER FUNCTION approve_project_delete_now(p_project_id uuid, p_owner_id uuid, p_expected_version bigint, p_correlation_id text) SECURITY DEFINER;
ALTER FUNCTION approve_task_review(p_project_id uuid, p_task_id uuid, p_actor_id text, p_summary text, p_idempotency_key text, p_expected_version bigint, p_correlation_id text) SECURITY DEFINER;
ALTER FUNCTION capture_task_runtime_snapshot(p_task_id uuid, p_project_id uuid) SECURITY DEFINER;
ALTER FUNCTION capture_task_runtime_snapshot(p_task_id uuid, p_project_id uuid, p_executor_assignment_ids uuid[]) SECURITY DEFINER;
ALTER FUNCTION create_followup_task(p_project_id uuid, p_source_task_id uuid, p_new_task_id uuid, p_actor_id text, p_title text, p_objective text, p_idempotency_key text, p_expected_version bigint, p_correlation_id text) SECURITY DEFINER;
ALTER FUNCTION decide_approval(p_approval_id uuid, p_decided_by text, p_decision text, p_reason text, p_correlation_id text) SECURITY DEFINER;
ALTER FUNCTION disconnect_github_connection(p_connection_id uuid, p_operator_id uuid, p_correlation_id text) SECURITY DEFINER;
ALTER FUNCTION get_operator_catalog_refresh_status(p_operator_id uuid) SECURITY DEFINER;
ALTER FUNCTION get_operator_codex_connection(p_operator_id uuid) SECURITY DEFINER;
ALTER FUNCTION get_operator_codex_login_status(p_operator_id uuid) SECURITY DEFINER;
ALTER FUNCTION get_operator_github_connections(p_operator_id uuid) SECURITY DEFINER;
ALTER FUNCTION get_operator_github_oauth_status(p_operator_id uuid) SECURITY DEFINER;
ALTER FUNCTION get_operator_model_catalog(p_operator_id uuid) SECURITY DEFINER;
ALTER FUNCTION get_operator_opencode_connections(p_operator_id uuid) SECURITY DEFINER;
ALTER FUNCTION get_operator_opencode_enrollment_status(p_operator_id uuid) SECURITY DEFINER;
ALTER FUNCTION get_operator_project_deletion_status(p_owner_id uuid) SECURITY DEFINER;
ALTER FUNCTION get_project_runtime_defaults(p_project_id uuid, p_owner_id uuid) SECURITY DEFINER;
ALTER FUNCTION list_operator_github_repositories(p_operator_id uuid, p_connection_id uuid, p_search text, p_limit integer) SECURITY DEFINER;
ALTER FUNCTION request_catalog_refresh(p_connection_id uuid, p_operator_id uuid, p_reason text) SECURITY DEFINER;
ALTER FUNCTION request_catalog_verification(p_entry_id uuid, p_operator_id uuid, p_actor text, p_correlation_id text) SECURITY DEFINER;
ALTER FUNCTION request_codex_connection_action(p_connection_id uuid, p_operator_id uuid, p_action text, p_correlation_id text) SECURITY DEFINER;
ALTER FUNCTION request_github_verify(p_connection_id uuid, p_operator_id uuid, p_correlation_id text) SECURITY DEFINER;
ALTER FUNCTION request_opencode_connection_action(p_connection_id uuid, p_operator_id uuid, p_action text, p_correlation_id text) SECURITY DEFINER;
ALTER FUNCTION request_project_deletion(p_project_id uuid, p_owner_id uuid, p_expected_version bigint, p_correlation_id text, p_skip_grace boolean) SECURITY DEFINER;
ALTER FUNCTION request_revision(p_project_id uuid, p_task_id uuid, p_reviewer_agent_id uuid, p_changes_required jsonb, p_acceptance_criteria jsonb, p_idempotency_key text, p_expected_version bigint, p_correlation_id text) SECURITY DEFINER;
ALTER FUNCTION request_runtime_interrupt(p_project_id uuid, p_task_id uuid, p_actor_id text, p_reason text, p_correlation_id text) SECURITY DEFINER;
ALTER FUNCTION request_workspace_operation(p_project_id uuid, p_operation_type text, p_actor_id text, p_reason text, p_correlation_id text) SECURITY DEFINER;
ALTER FUNCTION resolve_runtime_job_incident(p_job_id bigint, p_actor_id text, p_resolution text, p_correlation_id text) SECURITY DEFINER;
ALTER FUNCTION resolve_worker_interaction(p_report_id uuid, p_actor_id text, p_response jsonb, p_correlation_id text) SECURITY DEFINER;
ALTER FUNCTION retry_project_cleanup(p_project_id uuid, p_owner_id uuid, p_expected_version bigint, p_correlation_id text) SECURITY DEFINER;
ALTER FUNCTION set_project_runtime_defaults(p_project_id uuid, p_owner_id uuid, p_expected_version bigint, p_orchestrator_entry_id uuid, p_executor_entry_ids uuid[], p_reasoning_effort text, p_service_tier text, p_actor text, p_correlation_id text) SECURITY DEFINER;
ALTER FUNCTION start_codex_device_login(p_operator_id uuid, p_correlation_id text, p_ttl interval) SECURITY DEFINER;
ALTER FUNCTION start_opencode_enrollment(p_operator_id uuid, p_billing_boundary text, p_correlation_id text, p_ttl interval) SECURITY DEFINER;
ALTER FUNCTION store_opencode_enrollment_secret(p_enrollment_id uuid, p_operator_id uuid, p_ciphertext text, p_iv text, p_tag text, p_key_wrap text, p_key_fingerprint text) SECURITY DEFINER;
ALTER FUNCTION undo_project_deletion(p_project_id uuid, p_owner_id uuid, p_expected_version bigint, p_correlation_id text) SECURITY DEFINER;
ALTER FUNCTION write_audit_event(p_project_id uuid, p_task_id uuid, p_run_id uuid, p_actor_type text, p_actor_id text, p_action text, p_target_type text, p_target_id text, p_policy_decision text, p_approval_id uuid, p_details jsonb, p_correlation_id text) SECURITY DEFINER;

-- ============================================================== part 3 ====
-- Roles and grants.

-- Production creates these in deploy/setup-postgresql-production.sh before
-- migrating, so this block is a no-op there. It exists so a development or CI
-- database reaches the same privilege layout from `npm run db:migrate` alone.
DO $roles$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='infra_migrator') THEN
    CREATE ROLE infra_migrator LOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='infra_web') THEN
    CREATE ROLE infra_web LOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='infra_worker') THEN
    CREATE ROLE infra_worker LOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='infra_backup') THEN
    CREATE ROLE infra_backup LOGIN;
  END IF;
END $roles$;

GRANT USAGE ON SCHEMA control_plane, public TO infra_web, infra_worker, infra_backup;

-- infra_worker is the execution layer and needs the full surface.
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA control_plane TO infra_worker;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA control_plane TO infra_worker;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA control_plane TO infra_worker;

-- Without these, every future migration creates tables that infra_worker cannot
-- read, and the failure is silent until runtime.
ALTER DEFAULT PRIVILEGES FOR ROLE infra_migrator IN SCHEMA control_plane
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO infra_worker;
ALTER DEFAULT PRIVILEGES FOR ROLE infra_migrator IN SCHEMA control_plane
  GRANT USAGE, SELECT ON SEQUENCES TO infra_worker;
ALTER DEFAULT PRIVILEGES FOR ROLE infra_migrator IN SCHEMA control_plane
  GRANT EXECUTE ON FUNCTIONS TO infra_worker;
-- Deliberately no default privileges for infra_web: every new table and
-- function must be granted explicitly, or the boundary erodes silently.
--
-- That only holds if new functions are not reachable another way, and by
-- default they are: PostgreSQL grants EXECUTE on every new function to PUBLIC.
--
-- The revoke below must be global, without IN SCHEMA. PUBLIC's EXECUTE is a
-- global built-in default, and a schema-scoped ALTER DEFAULT PRIVILEGES cannot
-- remove it — measured on 17.11: with IN SCHEMA the created function still has
-- proacl NULL (owner + PUBLIC), without it the function is created as
-- {owner=X/owner}. This is the documented behaviour.
ALTER DEFAULT PRIVILEGES FOR ROLE infra_migrator
  REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
DO $public_default$
BEGIN
  -- Migrations run as infra_migrator in production and as the installing role
  -- in development and CI; both need the same default.
  IF current_user <> 'infra_migrator' THEN
    EXECUTE format(
      'ALTER DEFAULT PRIVILEGES FOR ROLE %I REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC',
      current_user);
  END IF;
END $public_default$;

-- Defence in depth for what the default above does not cover: a function
-- created by some other role, or a migration that grants PUBLIC explicitly.
-- Called by db/tests/0026 and by migrate.mjs after each migration file and
-- before its ledger row, so a leak names the migration, is not recorded as
-- applied, and stops the run.

CREATE OR REPLACE FUNCTION assert_no_public_function_execute()
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
  v_leaked text[];
BEGIN
  SELECT array_agg(p.proname||'('||pg_get_function_identity_arguments(p.oid)||')'
                   ORDER BY p.proname)
  INTO v_leaked
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname='control_plane'
    AND (p.proacl IS NULL OR EXISTS (
      SELECT 1 FROM aclexplode(p.proacl) a
      WHERE a.grantee=0 AND a.privilege_type='EXECUTE'));

  IF v_leaked IS NOT NULL THEN
    RAISE EXCEPTION
      'these control_plane functions grant EXECUTE to PUBLIC: %. Add an explicit REVOKE EXECUTE ... FROM PUBLIC and grant only the roles that need it.',
      array_to_string(v_leaked, ', ')
      USING ERRCODE='42501';
  END IF;

  RETURN jsonb_build_object('checked_at',clock_timestamp(),'leaked',0);
END $$;

ALTER FUNCTION assert_no_public_function_execute()
  SET search_path=control_plane,public,extensions,pg_temp;

-- infra_backup reads everything and writes nothing.
GRANT pg_read_all_data TO infra_backup;

-- infra_web starts from nothing. PUBLIC holds EXECUTE on functions by default,
-- so revoking from infra_web alone would leave that path open.
REVOKE ALL ON ALL TABLES IN SCHEMA control_plane FROM infra_web;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA control_plane FROM infra_web;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA control_plane FROM infra_web, PUBLIC;

-- Reads. Five tables are secret-bearing throughout and are not granted at all:
-- github_oauth_codes, provider_secret_enrollments, credential_references,
-- web_sessions and auth_attempts. The web layer reaches what it needs from
-- those through the definer functions above.
GRANT SELECT ON agent_sessions TO infra_web;
GRANT SELECT ON agents TO infra_web;
GRANT SELECT ON approvals TO infra_web;
GRANT SELECT ON audit_events TO infra_web;
GRANT SELECT ON catalog_gate_allowlist TO infra_web;
GRANT SELECT ON catalog_refresh_jobs TO infra_web;
GRANT SELECT ON commands TO infra_web;
GRANT SELECT ON domain_events TO infra_web;
GRANT SELECT ON github_clone_authorizations TO infra_web;
GRANT SELECT ON handoffs TO infra_web;
GRANT SELECT ON model_verification_receipts TO infra_web;
GRANT SELECT ON outbox_messages TO infra_web;
GRANT SELECT ON project_agent_assignments TO infra_web;
GRANT SELECT ON project_runtime_default_executors TO infra_web;
GRANT SELECT ON project_runtime_defaults TO infra_web;
GRANT SELECT ON project_workspace_states TO infra_web;
GRANT SELECT ON projects TO infra_web;
GRANT SELECT ON provider_installation_repositories TO infra_web;
GRANT SELECT ON provider_login_sessions TO infra_web;
GRANT SELECT ON provider_model_catalog TO infra_web;
GRANT SELECT ON runtime_activity_events TO infra_web;
GRANT SELECT ON runtime_health TO infra_web;
GRANT SELECT ON runtime_jobs TO infra_web;
GRANT SELECT ON runtime_profiles TO infra_web;
GRANT SELECT ON schema_migrations TO infra_web;
GRANT SELECT ON task_executor_assignments TO infra_web;
GRANT SELECT ON task_runtime_snapshots TO infra_web;
GRANT SELECT ON tasks TO infra_web;
GRANT SELECT ON workspace_operations TO infra_web;

-- Seven tables mix operational columns with one secret each. These are granted
-- column by column rather than table-wide with the secret revoked: in
-- PostgreSQL a table-level GRANT is resolved ahead of a column-level REVOKE, so
-- the revoke would be silently inert. Verified on 17.11.
GRANT SELECT (id,operator_id,provider,auth_method,status,account_label,installation_label,external_account_id,external_installation_id,repository_selection,permissions,last_verified_at,verify_requested_at,last_failure_code,last_failure_message,broker_leased_by,broker_leased_until,version,created_at,updated_at,verified_via,broker_requested_action,billing_boundary) ON provider_connections TO infra_web;
GRANT SELECT (run_id,project_id,job_id,supervisor_id,state,process_ref,created_at,updated_at,expires_at) ON runtime_launch_reservations TO infra_web;
GRANT SELECT (id,task_id,session_id,agent_id,phase,status,write_capable,native_run_id,process_ref,started_at,finished_at,exit_code,failure_code,usage_summary,version,created_at,updated_at) ON task_runs TO infra_web;
GRANT SELECT (id,display_name,timezone,created_at,auth_user_id,email,role,username,password_changed_at,must_change_password,disabled_at,last_login_at) ON users TO infra_web;
GRANT SELECT (id,project_id,task_id,run_id,agent_id,native_session_id,idempotency_key,result_summary,checks_summary,notes,status,completion_result,submitted_at,finalized_at) ON worker_completion_reports TO infra_web;
GRANT SELECT (id,project_id,task_id,run_id,agent_id,native_session_id,report_type,payload,idempotency_key,status,result,submitted_at,finalized_at,resolved_at,resolved_by,resolution) ON worker_interaction_reports TO infra_web;
GRANT SELECT (project_id,owner_run_id,mode,lease_expires_at,heartbeat_at,reason,status,version) ON workspace_locks TO infra_web;

-- Writes, exclusively through the audited definer surface.
GRANT EXECUTE ON FUNCTION approve_project_delete_now(p_project_id uuid, p_owner_id uuid, p_expected_version bigint, p_correlation_id text) TO infra_web;
GRANT EXECUTE ON FUNCTION approve_task_review(p_project_id uuid, p_task_id uuid, p_actor_id text, p_summary text, p_idempotency_key text, p_expected_version bigint, p_correlation_id text) TO infra_web;
GRANT EXECUTE ON FUNCTION authenticate_lookup(p_username text) TO infra_web;
GRANT EXECUTE ON FUNCTION capture_task_runtime_snapshot(p_task_id uuid, p_project_id uuid) TO infra_web;
GRANT EXECUTE ON FUNCTION capture_task_runtime_snapshot(p_task_id uuid, p_project_id uuid, p_executor_assignment_ids uuid[]) TO infra_web;
GRANT EXECUTE ON FUNCTION create_followup_task(p_project_id uuid, p_source_task_id uuid, p_new_task_id uuid, p_actor_id text, p_title text, p_objective text, p_idempotency_key text, p_expected_version bigint, p_correlation_id text) TO infra_web;
GRANT EXECUTE ON FUNCTION create_project_with_roster(p_project_id uuid, p_owner_id uuid, p_name text, p_slug text, p_workspace_path text, p_repository text, p_branch text, p_settings jsonb, p_credential_mode text, p_orchestrator_profile_id uuid, p_executor_profile_ids jsonb, p_actor text, p_correlation text, p_provider_connection_id uuid, p_github_repository_id bigint) TO infra_web;
GRANT EXECUTE ON FUNCTION create_task_with_executors(p_project_id uuid, p_task_id uuid, p_title text, p_objective text, p_actor text, p_correlation text, p_orchestrator_assignment_id uuid, p_executor_assignment_ids jsonb, p_executor_selection_explicit boolean) TO infra_web;
GRANT EXECUTE ON FUNCTION create_web_session(p_user_id uuid, p_token_digest bytea, p_csrf_digest bytea, p_idle interval, p_absolute interval, p_ip_hash bytea, p_user_agent_hash bytea) TO infra_web;
GRANT EXECUTE ON FUNCTION decide_approval(p_approval_id uuid, p_decided_by text, p_decision text, p_reason text, p_correlation_id text) TO infra_web;
GRANT EXECUTE ON FUNCTION disconnect_github_connection(p_connection_id uuid, p_operator_id uuid, p_correlation_id text) TO infra_web;
GRANT EXECUTE ON FUNCTION get_operator_catalog_refresh_status(p_operator_id uuid) TO infra_web;
GRANT EXECUTE ON FUNCTION get_operator_codex_connection(p_operator_id uuid) TO infra_web;
GRANT EXECUTE ON FUNCTION get_operator_codex_login_status(p_operator_id uuid) TO infra_web;
GRANT EXECUTE ON FUNCTION get_operator_github_connections(p_operator_id uuid) TO infra_web;
GRANT EXECUTE ON FUNCTION get_operator_github_oauth_status(p_operator_id uuid) TO infra_web;
GRANT EXECUTE ON FUNCTION get_operator_model_catalog(p_operator_id uuid) TO infra_web;
GRANT EXECUTE ON FUNCTION get_operator_opencode_connections(p_operator_id uuid) TO infra_web;
GRANT EXECUTE ON FUNCTION get_operator_opencode_enrollment_status(p_operator_id uuid) TO infra_web;
GRANT EXECUTE ON FUNCTION get_operator_project_deletion_status(p_owner_id uuid) TO infra_web;
GRANT EXECUTE ON FUNCTION get_project_runtime_defaults(p_project_id uuid, p_owner_id uuid) TO infra_web;
GRANT EXECUTE ON FUNCTION list_operator_github_repositories(p_operator_id uuid, p_connection_id uuid, p_search text, p_limit integer) TO infra_web;
GRANT EXECUTE ON FUNCTION record_auth_attempt(p_username text, p_ip_hash bytea, p_outcome text, p_user_agent_hash bytea) TO infra_web;
GRANT EXECUTE ON FUNCTION record_task_chat_message(p_project_id uuid, p_task_id uuid, p_message text, p_actor text, p_correlation text) TO infra_web;
GRANT EXECUTE ON FUNCTION request_catalog_gate_allowlist(p_operator_id uuid, p_entry_ids jsonb, p_actor text, p_correlation text) TO infra_web;
GRANT EXECUTE ON FUNCTION request_catalog_refresh(p_connection_id uuid, p_operator_id uuid, p_reason text) TO infra_web;
GRANT EXECUTE ON FUNCTION request_catalog_verification(p_entry_id uuid, p_operator_id uuid, p_actor text, p_correlation_id text) TO infra_web;
GRANT EXECUTE ON FUNCTION request_codex_connection_action(p_connection_id uuid, p_operator_id uuid, p_action text, p_correlation_id text) TO infra_web;
GRANT EXECUTE ON FUNCTION request_github_verify(p_connection_id uuid, p_operator_id uuid, p_correlation_id text) TO infra_web;
GRANT EXECUTE ON FUNCTION request_opencode_connection_action(p_connection_id uuid, p_operator_id uuid, p_action text, p_correlation_id text) TO infra_web;
GRANT EXECUTE ON FUNCTION request_project_deletion(p_project_id uuid, p_owner_id uuid, p_expected_version bigint, p_correlation_id text, p_skip_grace boolean) TO infra_web;
GRANT EXECUTE ON FUNCTION request_revision(p_project_id uuid, p_task_id uuid, p_reviewer_agent_id uuid, p_changes_required jsonb, p_acceptance_criteria jsonb, p_idempotency_key text, p_expected_version bigint, p_correlation_id text) TO infra_web;
GRANT EXECUTE ON FUNCTION request_runtime_interrupt(p_project_id uuid, p_task_id uuid, p_actor_id text, p_reason text, p_correlation_id text) TO infra_web;
GRANT EXECUTE ON FUNCTION request_workspace_operation(p_project_id uuid, p_operation_type text, p_actor_id text, p_reason text, p_correlation_id text) TO infra_web;
GRANT EXECUTE ON FUNCTION resolve_runtime_job_incident(p_job_id bigint, p_actor_id text, p_resolution text, p_correlation_id text) TO infra_web;
GRANT EXECUTE ON FUNCTION resolve_worker_interaction(p_report_id uuid, p_actor_id text, p_response jsonb, p_correlation_id text) TO infra_web;
GRANT EXECUTE ON FUNCTION retry_project_cleanup(p_project_id uuid, p_owner_id uuid, p_expected_version bigint, p_correlation_id text) TO infra_web;
GRANT EXECUTE ON FUNCTION retry_project_provisioning(p_project_id uuid, p_owner_id uuid, p_actor text, p_correlation text) TO infra_web;
GRANT EXECUTE ON FUNCTION revoke_user_sessions(p_user_id uuid, p_reason text, p_except_session_id uuid) TO infra_web;
GRANT EXECUTE ON FUNCTION revoke_web_session(p_token_digest bytea, p_reason text) TO infra_web;
GRANT EXECUTE ON FUNCTION set_project_runtime_defaults(p_project_id uuid, p_owner_id uuid, p_expected_version bigint, p_orchestrator_entry_id uuid, p_executor_entry_ids uuid[], p_reasoning_effort text, p_service_tier text, p_actor text, p_correlation_id text) TO infra_web;
GRANT EXECUTE ON FUNCTION set_user_password(p_user_id uuid, p_password_hash text, p_must_change boolean, p_keep_session_id uuid) TO infra_web;
GRANT EXECUTE ON FUNCTION set_user_username(p_user_id uuid, p_username text) TO infra_web;
GRANT EXECUTE ON FUNCTION start_codex_device_login(p_operator_id uuid, p_correlation_id text, p_ttl interval) TO infra_web;
GRANT EXECUTE ON FUNCTION start_opencode_enrollment(p_operator_id uuid, p_billing_boundary text, p_correlation_id text, p_ttl interval) TO infra_web;
GRANT EXECUTE ON FUNCTION store_opencode_enrollment_secret(p_enrollment_id uuid, p_operator_id uuid, p_ciphertext text, p_iv text, p_tag text, p_key_wrap text, p_key_fingerprint text) TO infra_web;
GRANT EXECUTE ON FUNCTION touch_web_session(p_token_digest bytea, p_idle interval, p_slide_after interval) TO infra_web;
GRANT EXECUTE ON FUNCTION undo_project_deletion(p_project_id uuid, p_owner_id uuid, p_expected_version bigint, p_correlation_id text) TO infra_web;

-- append_event and write_audit_event are deliberately absent above. Both take
-- the actor as a parameter, so granting either would let the web role forge an
-- audit entry or inject an arbitrary outbox event. append_event is not called
-- from apps/web at all; audit goes through write_operator_audit.
-- auth_lockout_state is absent too: it reserves nothing, so admitting a login
-- with it would race. begin_auth_attempt is the admission path.
GRANT EXECUTE ON FUNCTION write_operator_audit(uuid,text,text,text,text,jsonb,uuid,text) TO infra_web;
GRANT EXECUTE ON FUNCTION begin_auth_attempt(text,bytea,bytea,interval,integer) TO infra_web;
GRANT EXECUTE ON FUNCTION finish_auth_attempt(bigint,text) TO infra_web;

COMMIT;
