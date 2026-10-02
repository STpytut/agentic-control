\set ON_ERROR_STOP on
BEGIN;
SET search_path TO control_plane,public,extensions;

DO $$
DECLARE
  v_owner uuid;
  v_other uuid;
  v_project uuid := gen_random_uuid();
  v_codex uuid;
  v_exec_a uuid;
  v_exec_b uuid;
  v_unverified uuid;
  v_task uuid := gen_random_uuid();
  v_result jsonb;
  v_assignment uuid;
  v_count bigint;
BEGIN
  INSERT INTO users(display_name) VALUES('Role Privileges Test') RETURNING id INTO v_owner;
  INSERT INTO users(display_name) VALUES('Other Operator') RETURNING id INTO v_other;

  INSERT INTO runtime_profiles(runtime_type,adapter_version,runtime_version,provider_type,model,last_verified_at)
    VALUES('codex','t','t','openai','role-test-codex',clock_timestamp()) RETURNING id INTO v_codex;
  INSERT INTO runtime_profiles(runtime_type,adapter_version,runtime_version,provider_type,model,last_verified_at)
    VALUES('opencode','t','t','test','role-test-exec-a',clock_timestamp()) RETURNING id INTO v_exec_a;
  INSERT INTO runtime_profiles(runtime_type,adapter_version,runtime_version,provider_type,model,last_verified_at)
    VALUES('opencode','t','t','test','role-test-exec-b',clock_timestamp()) RETURNING id INTO v_exec_b;
  -- Never verified: must be refused as an orchestrator.
  INSERT INTO runtime_profiles(runtime_type,adapter_version,runtime_version,provider_type,model)
    VALUES('codex','t','t','openai','role-test-unverified') RETURNING id INTO v_unverified;

  -- ------------------------------------------ create_project_with_roster ----

  v_result := create_project_with_roster(
    v_project, v_owner, 'Role Test', 'role-test-'||left(v_project::text,8),
    '/srv/role-test/'||v_project, NULL, 'main',
    '{"provisioning_status":"pending","provisioning_source":"empty","agent_roster_configured":true}'::jsonb,
    'empty', v_codex, to_jsonb(ARRAY[v_exec_a,v_exec_b]), 'operator:test', 'corr-1');

  IF v_result IS NULL THEN RAISE EXCEPTION 'project creation returned no result'; END IF;
  IF (v_result->>'executor_count')::integer <> 2 THEN
    RAISE EXCEPTION 'expected 2 executors, got %', v_result->>'executor_count';
  END IF;
  IF (v_result->>'status') <> 'needs_attention' THEN
    RAISE EXCEPTION 'new project was not created in needs_attention';
  END IF;

  -- The roster, the lock row and the creation event must all exist.
  SELECT count(*) INTO v_count FROM project_agent_assignments
  WHERE project_id=v_project AND assignment_role='orchestrator' AND is_default;
  IF v_count<>1 THEN RAISE EXCEPTION 'expected exactly one default orchestrator, got %', v_count; END IF;

  SELECT count(*) INTO v_count FROM project_agent_assignments
  WHERE project_id=v_project AND assignment_role='executor';
  IF v_count<>2 THEN RAISE EXCEPTION 'expected 2 executor assignments, got %', v_count; END IF;

  IF NOT EXISTS (SELECT 1 FROM workspace_locks WHERE project_id=v_project) THEN
    RAISE EXCEPTION 'project creation did not create the workspace lock row';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM domain_events
                 WHERE project_id=v_project AND event_type='project.created') THEN
    RAISE EXCEPTION 'project creation did not append project.created';
  END IF;

  -- An unverified orchestrator runtime yields no project, as the inline CTE did.
  IF create_project_with_roster(
       gen_random_uuid(), v_owner, 'Unverified', 'unverified-x',
       '/srv/x', NULL, 'main', '{}'::jsonb, 'empty',
       v_unverified, to_jsonb(ARRAY[v_exec_a]), 'operator:test') IS NOT NULL THEN
    RAISE EXCEPTION 'an unverified orchestrator runtime was accepted';
  END IF;

  -- A GitHub selection that resolves to nothing must abort before any insert.
  BEGIN
    PERFORM create_project_with_roster(
      gen_random_uuid(), v_owner, 'Stale GitHub', 'stale-gh',
      '/srv/y', NULL, 'main', '{}'::jsonb, 'github_app',
      v_codex, to_jsonb(ARRAY[v_exec_a]), 'operator:test', '',
      gen_random_uuid(), 123456::bigint);
    RAISE EXCEPTION 'a stale GitHub selection was accepted';
  EXCEPTION WHEN sqlstate '55000' THEN NULL;
  END;
  SELECT count(*) INTO v_count FROM projects WHERE slug='stale-gh';
  IF v_count<>0 THEN RAISE EXCEPTION 'the aborted GitHub project left a row behind'; END IF;

  -- ------------------------------------------ create_task_with_executors ----

  v_result := create_task_with_executors(
    v_project, v_task, 'First task', 'Do the thing', 'operator:test', 'corr-2');

  IF v_result IS NULL THEN RAISE EXCEPTION 'task creation returned no result'; END IF;
  IF (v_result->>'executor_count')::integer <> 2 THEN
    RAISE EXCEPTION 'implicit executor selection did not take both executors';
  END IF;
  IF (v_result->>'status') <> 'planning' THEN
    RAISE EXCEPTION 'new task was not created in planning';
  END IF;

  -- Priorities must follow assignment order, spaced by 100 as before.
  SELECT count(*) INTO v_count FROM task_executor_assignments
  WHERE task_id=v_task AND priority IN (100,200);
  IF v_count<>2 THEN RAISE EXCEPTION 'executor priorities were not 100/200'; END IF;

  -- Explicit selection of one executor takes exactly that one.
  SELECT id INTO v_assignment FROM project_agent_assignments
  WHERE project_id=v_project AND assignment_role='executor' ORDER BY created_at,id LIMIT 1;

  v_result := create_task_with_executors(
    v_project, gen_random_uuid(), 'Second task', 'Only one executor',
    'operator:test', 'corr-3', NULL, to_jsonb(ARRAY[v_assignment]), true);
  IF (v_result->>'executor_count')::integer <> 1 THEN
    RAISE EXCEPTION 'explicit executor selection did not narrow to one';
  END IF;

  -- An explicitly requested assignment that does not belong to the project is
  -- refused rather than silently narrowing the selection.
  BEGIN
    PERFORM create_task_with_executors(
      v_project, gen_random_uuid(), 'Bad selection', 'x', 'operator:test', '',
      NULL, to_jsonb(ARRAY[gen_random_uuid()]), true);
    RAISE EXCEPTION 'an unavailable executor selection was accepted';
  EXCEPTION WHEN sqlstate '55000' THEN NULL;
  END;

  -- A project with no orchestrator assignment yields no task.
  UPDATE project_agent_assignments SET enabled=false
  WHERE project_id=v_project AND assignment_role='orchestrator';
  IF create_task_with_executors(v_project, gen_random_uuid(), 'No orchestrator', 'x',
                                'operator:test') IS NOT NULL THEN
    RAISE EXCEPTION 'a task was created without a usable orchestrator';
  END IF;
  UPDATE project_agent_assignments SET enabled=true
  WHERE project_id=v_project AND assignment_role='orchestrator';

  -- ------------------------------------------ record_task_chat_message ----

  v_result := record_task_chat_message(v_project, v_task, 'hello', 'operator:test', 'corr-4');
  IF v_result IS NULL THEN RAISE EXCEPTION 'chat message was rejected on an open task'; END IF;
  IF (v_result->>'version')::bigint <> 2 THEN
    RAISE EXCEPTION 'chat message did not bump the task version to 2, got %', v_result->>'version';
  END IF;

  UPDATE tasks SET status='completed' WHERE id=v_task;
  IF record_task_chat_message(v_project, v_task, 'late', 'operator:test') IS NOT NULL THEN
    RAISE EXCEPTION 'a closed task accepted a chat message';
  END IF;
  UPDATE tasks SET status='planning' WHERE id=v_task;

  -- A task id from another project is not reachable.
  IF record_task_chat_message(gen_random_uuid(), v_task, 'x', 'operator:test') IS NOT NULL THEN
    RAISE EXCEPTION 'a chat message crossed a project boundary';
  END IF;

  -- ----------------------------------------- retry_project_provisioning ----

  IF retry_project_provisioning(v_project, v_owner, 'operator:test') IS NOT NULL THEN
    RAISE EXCEPTION 'provisioning retry ran on a project that had not failed';
  END IF;

  UPDATE projects SET settings=jsonb_set(settings,'{provisioning_status}','"failed"'::jsonb,true)
  WHERE id=v_project;

  -- Another operator must not be able to retry it.
  IF retry_project_provisioning(v_project, v_other, 'operator:other') IS NOT NULL THEN
    RAISE EXCEPTION 'provisioning retry ignored project ownership';
  END IF;

  v_result := retry_project_provisioning(v_project, v_owner, 'operator:test', 'corr-5');
  IF v_result IS NULL THEN RAISE EXCEPTION 'provisioning retry did not run for the owner'; END IF;
  IF (v_result->>'provisioning_status') <> 'pending' THEN
    RAISE EXCEPTION 'provisioning retry did not reset the status to pending';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM audit_events
                 WHERE action='project.provisioning_retried' AND target_id=v_project::text) THEN
    RAISE EXCEPTION 'provisioning retry was not audited';
  END IF;

  -- --------------------------------------------- single-owner invariant ----

  -- ADR-0011 records that twelve operator functions do not scope by owner and
  -- are safe only while exactly one owner can exist. If that constraint is ever
  -- relaxed, this fails and forces those functions to be revisited rather than
  -- letting the gap turn into a silent cross-operator leak.
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname='users_role_check'
      AND conrelid='control_plane.users'::regclass
      AND pg_get_constraintdef(oid) NOT LIKE '%''owner''%'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname='users_role_check' AND conrelid='control_plane.users'::regclass
  ) THEN
    RAISE EXCEPTION 'users_role_check no longer pins the single-owner invariant';
  END IF;

  -- ------------------------------------------------- definer surface ----

  IF EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='control_plane'
      AND p.proname IN ('create_project_with_roster','create_task_with_executors',
                        'record_task_chat_message','retry_project_provisioning')
      AND (NOT p.prosecdef
           OR p.proconfig IS NULL
           OR NOT EXISTS (SELECT 1 FROM unnest(p.proconfig) c WHERE c LIKE 'search_path=%'))
  ) THEN
    RAISE EXCEPTION 'a web-facing write function is not SECURITY DEFINER with a pinned search_path';
  END IF;

  RAISE NOTICE 'local role privilege assertions passed';
END $$;

-- =========================================================================
-- The role boundary itself. Everything above proves the functions behave;
-- this proves infra_web cannot reach around them.
--
-- Runs as the actual role rather than inspecting catalogs, so it fails if a
-- future migration widens a grant, not merely if someone edits the intent.
-- =========================================================================

-- A credentialed operator for the sign-in below, seeded here rather than found.
--
-- The block that opens the session used to take the oldest `users` row that had
-- a username and let `authenticate_lookup` supply its hash. That works on an
-- installation that already ran `infra-cod admin bootstrap` and fails on a
-- database this suite just migrated, which is the case that matters: the suite
-- has to pass on the fresh schema as well as on a developer's. Seeding the row,
-- like 0031 does, removes the dependency on committed state without weakening
-- what is being asserted — the digest and hash are local to this file, and the
-- `infra_web` grants under test are unchanged.
DO $$
DECLARE
  v_seed_hash text := '$argon2id$v=19$m=19456,t=2,p=1$cm9sZXByaXZzZWVkc2Vl$cm9sZXByaXZzZWVkc2VlZA';
BEGIN
  -- Replaced, not duplicated: a pre-existing credential would still be
  -- selectable by the ORDER BY below, and the test would silently assert about
  -- a row it did not create.
  UPDATE users SET username=NULL, password_hash=NULL, must_change_password=false,
                   disabled_at=NULL
  WHERE username IS NOT NULL;
  PERFORM bootstrap_local_owner('role-privileges-probe', v_seed_hash, 'Role Probe');
END $$;

SET ROLE infra_web;

DO $$
DECLARE
  -- The session these assertions act as, opened by the login block below.
  v_digest bytea := decode(repeat('a7',32),'hex');
BEGIN
  -- Reads the operator's own UI legitimately needs.
  BEGIN PERFORM 1 FROM projects LIMIT 1;
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE EXCEPTION 'infra_web cannot read projects'; END;

  BEGIN PERFORM display_name FROM users LIMIT 1;
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE EXCEPTION 'infra_web cannot read users.display_name'; END;

  -- Secrets must be unreachable even though the rest of the row is not.
  BEGIN
    PERFORM password_hash FROM users LIMIT 1;
    RAISE EXCEPTION 'infra_web can read users.password_hash';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;

  BEGIN
    PERFORM fencing_token FROM workspace_locks LIMIT 1;
    RAISE EXCEPTION 'infra_web can read workspace_locks.fencing_token';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;

  BEGIN
    PERFORM workspace_fencing_token FROM task_runs LIMIT 1;
    RAISE EXCEPTION 'infra_web can read task_runs.workspace_fencing_token';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;

  BEGIN
    PERFORM native_credential_reference FROM provider_connections LIMIT 1;
    RAISE EXCEPTION 'infra_web can read provider_connections.native_credential_reference';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;

  -- Wholly secret-bearing tables are not reachable at all.
  BEGIN
    PERFORM 1 FROM web_sessions LIMIT 1;
    RAISE EXCEPTION 'infra_web can read web_sessions';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;

  BEGIN
    PERFORM 1 FROM provider_secret_enrollments LIMIT 1;
    RAISE EXCEPTION 'infra_web can read provider_secret_enrollments';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;

  BEGIN
    PERFORM 1 FROM github_oauth_codes LIMIT 1;
    RAISE EXCEPTION 'infra_web can read github_oauth_codes';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;

  -- No DML anywhere. These three stand for the whole surface.
  BEGIN
    INSERT INTO agents(name,role) VALUES('boundary','implementer');
    RAISE EXCEPTION 'infra_web can INSERT into agents';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;

  BEGIN
    UPDATE users SET display_name='boundary';
    RAISE EXCEPTION 'infra_web can UPDATE users';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;

  BEGIN
    DELETE FROM projects;
    RAISE EXCEPTION 'infra_web can DELETE from projects';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;

  -- The audited surface is reachable.
  BEGIN PERFORM authenticate_lookup('nobody');
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE EXCEPTION 'infra_web cannot execute authenticate_lookup'; END;

  -- Operator-only and maintenance functions are not. bootstrap_local_owner
  -- would mint an owner; prune_auth_records is the health timer's.
  BEGIN
    PERFORM bootstrap_local_owner('boundary','$argon2id$x','x');
    RAISE EXCEPTION 'infra_web can execute bootstrap_local_owner';
  EXCEPTION
    WHEN insufficient_privilege THEN NULL;
    WHEN others THEN RAISE EXCEPTION
      'infra_web reached bootstrap_local_owner: %', SQLERRM;
  END;

  BEGIN
    PERFORM prune_auth_records();
    RAISE EXCEPTION 'infra_web can execute prune_auth_records';
  EXCEPTION
    WHEN insufficient_privilege THEN NULL;
    WHEN others THEN RAISE EXCEPTION
      'infra_web reached prune_auth_records: %', SQLERRM;
  END;

  -- The generic event and audit writers must stay out of reach: both take the
  -- actor as a parameter, so either would let the web role forge an audit
  -- entry or inject an arbitrary outbox event.
  BEGIN
    PERFORM append_event('probe',NULL,NULL,NULL,'user','a',NULL,'','k','project',NULL,1,'{}'::jsonb,NULL);
    RAISE EXCEPTION 'infra_web can execute append_event';
  EXCEPTION
    WHEN insufficient_privilege THEN NULL;
    WHEN others THEN RAISE EXCEPTION 'infra_web reached append_event: %', SQLERRM;
  END;

  BEGIN
    PERFORM write_audit_event(NULL,NULL,NULL,'system','forged','x','y','z','allowed',NULL,'{}'::jsonb,'');
    RAISE EXCEPTION 'infra_web can execute write_audit_event';
  EXCEPTION
    WHEN insufficient_privilege THEN NULL;
    WHEN others THEN RAISE EXCEPTION 'infra_web reached write_audit_event: %', SQLERRM;
  END;

  -- The happy path, not only the refusals. `write_operator_audit` shipped with a
  -- pattern that rejected every valid action, and the suite stayed green because
  -- nothing ever called it successfully under infra_web — which is also how it
  -- kept a caller-supplied actor for two migrations.
  --
  -- The session is opened through the real sign-in path rather than by minting
  -- one: `create_web_session` is exactly the capability that was revoked, so a
  -- test that needs it to set up would be testing the hole rather than the door.
  DECLARE
    v_owner uuid;
    v_username text;
    v_hash text;
    v_attempt bigint;
    v_lookup jsonb;
    v_login jsonb;
  BEGIN
    -- The hash comes from `authenticate_lookup`, not from the table: `password_hash`
    -- is not in infra_web's column grants, which is why the login path looks it up
    -- through the function in the first place.
    SELECT username INTO v_username
    FROM users WHERE username IS NOT NULL AND role='owner' ORDER BY created_at LIMIT 1;

    v_lookup := authenticate_lookup(v_username);
    IF v_lookup->>'found' <> 'true' THEN
      RAISE EXCEPTION 'the probe operator could not be looked up';
    END IF;
    v_owner := (v_lookup->>'user_id')::uuid;
    v_hash := v_lookup->>'password_hash';

    v_attempt := (begin_auth_attempt(v_username, decode(repeat('c7',32),'hex'))->>'attempt_id')::bigint;
    v_login := complete_local_login(
      v_attempt, v_owner, v_username, v_hash, v_digest, decode(repeat('b7',32),'hex'),
      decode(repeat('c7',32),'hex'), NULL, interval '12 hours', interval '30 days');
    IF v_login->>'completed' <> 'true' THEN
      RAISE EXCEPTION 'infra_web cannot complete a sign-in: %', v_login;
    END IF;
  END;

  -- Binding the actor to a live session is not enough on its own: it stops one
  -- account being impersonated as another, but an `auth.*` row claiming a
  -- credential change that never happened is still a lie. Every credential event
  -- is written by the function that performed it, so this writer takes only
  -- `operator.*`. Each of these has a positive counterpart, written by the
  -- operation itself, in 0031.
  DECLARE v_event text;
  BEGIN
    FOREACH v_event IN ARRAY ARRAY[
      'auth.login', 'auth.password_changed', 'auth.username_changed',
      'auth.session_revoked', 'auth.sessions_revoked', 'auth.logout'
    ] LOOP
      BEGIN
        PERFORM write_session_audit(v_digest, v_event, 'session', 'forged');
        RAISE EXCEPTION 'infra_web forged the credential event %', v_event;
      EXCEPTION
        WHEN sqlstate '22023' THEN NULL;
        WHEN others THEN RAISE EXCEPTION
          'write_session_audit reached the body for %: %', v_event, SQLERRM;
      END;
    END LOOP;
  END;

  BEGIN
    PERFORM write_session_audit(v_digest, 'operator.create_project','project','probe');
  EXCEPTION WHEN others THEN
    RAISE EXCEPTION 'infra_web cannot write a valid operator.* audit entry: %', SQLERRM;
  END;

  -- An action outside the two namespaces is still refused.
  BEGIN
    PERFORM write_session_audit(v_digest, 'system.forged','x','y');
    RAISE EXCEPTION 'an out-of-namespace audit action was accepted';
  EXCEPTION WHEN sqlstate '22023' THEN NULL;
  END;

  -- A digest that names no live session is refused outright: an audit row for a
  -- session that does not exist is the forgery this replaced.
  BEGIN
    PERFORM write_session_audit(decode(repeat('ff',32),'hex'), 'auth.login','session','forged');
    RAISE EXCEPTION 'write_session_audit accepted a digest with no live session';
  EXCEPTION WHEN sqlstate '55000' THEN NULL;
  END;

  -- And the function that takes the actor as a parameter is no longer reachable by
  -- the role whose identity it used to take on trust.
  BEGIN
    PERFORM write_operator_audit(
      (SELECT id FROM users WHERE role='owner' ORDER BY created_at LIMIT 1),
      'auth.login','session','forged-session');
    RAISE EXCEPTION 'infra_web can supply its own audit actor';
  EXCEPTION
    WHEN insufficient_privilege THEN NULL;
    WHEN others THEN RAISE EXCEPTION 'infra_web reached write_operator_audit: %', SQLERRM;
  END;

  -- auth_lockout_state reserves nothing, so admitting a login with it would
  -- race. begin_auth_attempt is the admission path and is the one granted.
  BEGIN
    PERFORM auth_lockout_state('x', sha256('y'::bytea));
    RAISE EXCEPTION 'infra_web can execute auth_lockout_state';
  EXCEPTION
    WHEN insufficient_privilege THEN NULL;
    WHEN others THEN RAISE EXCEPTION 'infra_web reached auth_lockout_state: %', SQLERRM;
  END;

  RAISE NOTICE 'infra_web boundary assertions passed';
END $$;

RESET ROLE;

-- Two separate properties about functions added by a later migration.
--
-- First: the default. PostgreSQL grants EXECUTE on new functions to PUBLIC, and
-- 0038 removes that with a global ALTER DEFAULT PRIVILEGES (without IN SCHEMA —
-- the schema-scoped form cannot remove a global built-in default). A function
-- created normally must therefore already be out of infra_web's reach.
CREATE FUNCTION control_plane.default_probe() RETURNS int LANGUAGE sql AS $probe$ SELECT 1 $probe$;

DO $$
BEGIN
  IF (SELECT proacl IS NULL FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='control_plane' AND p.proname='default_probe') THEN
    RAISE EXCEPTION 'a newly created function fell back to the built-in default (owner + PUBLIC)';
  END IF;
  PERFORM assert_no_public_function_execute();
  RAISE NOTICE 'new functions are not granted to PUBLIC by default';
END $$;

SET ROLE infra_web;
DO $$
BEGIN
  PERFORM control_plane.default_probe();
  RAISE EXCEPTION 'infra_web can execute a newly created function';
EXCEPTION WHEN insufficient_privilege THEN NULL;
END $$;
RESET ROLE;

-- Second: the backstop. The default only covers functions created by the
-- migrating role; a migration can still grant PUBLIC explicitly, and
-- assert_no_public_function_execute has to catch that.
GRANT EXECUTE ON FUNCTION control_plane.default_probe() TO PUBLIC;

DO $$
BEGIN
  BEGIN
    PERFORM assert_no_public_function_execute();
    RAISE EXCEPTION 'assert_no_public_function_execute missed an explicit PUBLIC grant';
  EXCEPTION WHEN sqlstate '42501' THEN NULL;
  END;
  RAISE NOTICE 'the assertion catches an explicit PUBLIC grant';
END $$;

DROP FUNCTION control_plane.default_probe();

DO $$
BEGIN
  PERFORM assert_no_public_function_execute();
  RAISE NOTICE 'schema is clean of PUBLIC function grants';
END $$;

SET ROLE infra_worker;

DO $$
DECLARE v_profile uuid;
BEGIN
  SELECT id INTO v_profile FROM runtime_profiles LIMIT 1;

  -- The execution layer keeps the full surface it needs.
  BEGIN
    INSERT INTO agents(name,role,runtime_profile_id)
    VALUES('worker-probe','implementer',v_profile);
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE EXCEPTION 'infra_worker cannot INSERT into agents'; END;

  BEGIN PERFORM fencing_token FROM workspace_locks LIMIT 1;
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE EXCEPTION 'infra_worker cannot read workspace_locks.fencing_token'; END;

  RAISE NOTICE 'infra_worker boundary assertions passed';
END $$;

RESET ROLE;

-- ================================================== infra_web full allowlist ==
--
-- The grant is the capability, and it outlives the code that used it. Deleting
-- the TypeScript helper that wrapped `create_web_session` did not stop
-- infra_web from calling it directly and minting a session with no password and
-- no audit, and `set_user_password` was still reachable for a full account
-- takeover. A test that only checks the functions a change touched cannot catch
-- that, so this pins the *entire* executable surface: anything not on the list
-- fails here, and adding a function to the allowlist is a deliberate act.

-- Held as constant text rather than queried, so widening the surface requires
-- editing this list.
CREATE TEMP TABLE infra_web_allowlist(signature text PRIMARY KEY);
INSERT INTO infra_web_allowlist(signature) VALUES
  ('approve_project_delete_now(p_project_id uuid, p_owner_id uuid, p_expected_version bigint, p_correlation_id text)'),
  ('approve_task_review(p_project_id uuid, p_task_id uuid, p_actor_id text, p_summary text, p_idempotency_key text, p_expected_version bigint, p_correlation_id text)'),
  ('authenticate_lookup(p_username text)'),
  ('begin_auth_attempt(p_username text, p_ip_hash bytea, p_user_agent_hash bytea, p_window interval, p_max integer)'),
  ('change_local_password(p_token_digest bytea, p_new_password_hash text, p_new_token_digest bytea, p_new_csrf_digest bytea, p_idle interval, p_absolute interval, p_ip_hash bytea, p_user_agent_hash bytea)'),
  ('change_local_username(p_token_digest bytea, p_username text)'),
  ('complete_local_login(p_attempt_id bigint, p_user_id uuid, p_expected_username text, p_expected_password_hash text, p_token_digest bytea, p_csrf_digest bytea, p_ip_hash bytea, p_user_agent_hash bytea, p_idle interval, p_absolute interval)'),
  -- The GitHub connect button and the callback it returns to. Both were called by
  -- the web tier and granted to nobody, so `Connect GitHub` answered "permission
  -- denied for function start_provider_login_session" on a correctly provisioned
  -- host — 0055 makes them SECURITY DEFINER and grants them. `start` checks that
  -- the operator id it is handed names an enabled owner, because definer rights
  -- mean the table no longer checks anything; `consume` matches on a 64-hex state
  -- digest the caller has to know and raises when nothing matches.
  -- The callback the connect button returns to. 0055 granted the two functions the
  -- first click failed on and stopped there, so the flow met the same cause again
  -- on the way back from GitHub: `?github=error`, no audit row, and a bare
  -- `catch {}` where the reason had been.
  ('consume_session_and_record_github_oauth(p_operator_id uuid, p_state_digest text, p_installation_id text, p_setup_action text, p_authorization_code_ciphertext text, p_authorization_code_iv text, p_authorization_code_tag text, p_client_id text)'),
  ('consume_provider_login_session(p_operator_id uuid, p_provider text, p_state_digest text)'),
  -- Structure for a catalog-driven project. `runtime_profiles` is written by
  -- nothing in this product — only by `pocs/` — so a host that has only ever been
  -- installed could not create a project at all.
  ('ensure_structural_runtime_profile(p_operator_id uuid, p_runtime_type text)'),
  ('start_provider_login_session(p_operator_id uuid, p_provider text, p_state_digest text, p_ttl interval)'),
  ('create_followup_task(p_project_id uuid, p_source_task_id uuid, p_new_task_id uuid, p_actor_id text, p_title text, p_objective text, p_idempotency_key text, p_expected_version bigint, p_correlation_id text)'),
  ('create_project_with_roster(p_project_id uuid, p_owner_id uuid, p_name text, p_slug text, p_workspace_path text, p_repository text, p_branch text, p_settings jsonb, p_credential_mode text, p_orchestrator_profile_id uuid, p_executor_profile_ids jsonb, p_actor text, p_correlation text, p_provider_connection_id uuid, p_github_repository_id bigint)'),
  ('create_task_with_executors(p_project_id uuid, p_task_id uuid, p_title text, p_objective text, p_actor text, p_correlation text, p_orchestrator_assignment_id uuid, p_executor_assignment_ids jsonb, p_executor_selection_explicit boolean)'),
  ('decide_approval(p_approval_id uuid, p_decided_by text, p_decision text, p_reason text, p_correlation_id text)'),
  ('disconnect_github_connection(p_connection_id uuid, p_operator_id uuid, p_correlation_id text)'),
  ('finish_auth_attempt(p_attempt_id bigint, p_outcome text)'),
  ('get_operator_catalog_refresh_status(p_operator_id uuid)'),
  -- Stage 12 W2 (0095): the newer upstream versions the daily watch saw, for the
  -- runtime card. Host-wide and read-only — no operator argument because the
  -- runtimes are the host's, not an operator's; it returns versions and dates,
  -- never a path or a credential.
  ('get_runtime_versions()'),
  -- Stage 12 W3 (0096): the host's runtime qualifications and their checks, for
  -- the same card. Host-wide, read-only; check details are bounded and carry no
  -- path under a home and no credential.
  ('get_runtime_qualifications()'),
  ('get_runtime_activations()'),
  ('get_operator_codex_connection(p_operator_id uuid)'),
  ('get_operator_codex_login_status(p_operator_id uuid)'),
  ('get_operator_github_connections(p_operator_id uuid)'),
  ('get_operator_github_oauth_status(p_operator_id uuid)'),
  -- G1 (0125): the GitHub App from the panel — its manifest's state, the code
  -- GitHub returns, the status the settings page polls, and the App's public fields.
  ('start_github_app_manifest(p_operator_id uuid, p_state_digest text, p_organization text)'),
  ('record_github_app_manifest_code(p_operator_id uuid, p_state_digest text, p_code_ciphertext text, p_code_iv text, p_code_tag text)'),
  ('get_github_app_manifest_status(p_operator_id uuid)'),
  ('github_app_registration()'),
  -- Runtime updates from the panel (0127): ask for a qualify or a promote, and
  -- read how the last ones went.
  ('request_runtime_update(p_operator_id uuid, p_runtime_type text, p_version text, p_kind text)'),
  ('get_runtime_update_requests()'),
  -- GitHub issues as chats (0132): the settings section and the waiting list.
  -- Each checks the project's owner; starting one goes through
  -- create_task_with_executors like any chat.
  ('set_issue_intake(p_project_id uuid, p_owner_id uuid, p_enabled boolean, p_label text, p_actor text)'),
  ('get_issue_intake(p_project_id uuid, p_owner_id uuid)'),
  ('start_issue_chat(p_link_id uuid, p_owner_id uuid, p_actor text, p_correlation text)'),
  ('dismiss_issue(p_link_id uuid, p_owner_id uuid, p_actor text)'),
  -- Claude Code's sign-in from the panel (0136): start, read, paste the code.
  -- Each is the owner's own; the code is never read back.
  ('start_claude_login(p_owner_id uuid)'),
  ('get_claude_login(p_owner_id uuid)'),
  ('submit_claude_login_code(p_owner_id uuid, p_session_id uuid, p_code text)'),
  ('get_operator_model_catalog(p_operator_id uuid)'),
  ('get_operator_opencode_connections(p_operator_id uuid)'),
  ('get_operator_opencode_enrollment_status(p_operator_id uuid)'),
  ('get_operator_project_deletion_status(p_owner_id uuid)'),
  ('get_project_runtime_defaults(p_project_id uuid, p_owner_id uuid)'),
  ('list_operator_github_repositories(p_operator_id uuid, p_connection_id uuid, p_search text, p_limit integer)'),
  ('list_web_sessions(p_token_digest bytea)'),
  ('record_task_chat_message(p_project_id uuid, p_task_id uuid, p_message text, p_actor text, p_correlation text)'),
  ('rehash_local_password(p_user_id uuid, p_expected_old_hash text, p_new_password_hash text)'),
  ('request_catalog_refresh(p_connection_id uuid, p_operator_id uuid, p_reason text)'),
  ('request_codex_connection_action(p_connection_id uuid, p_operator_id uuid, p_action text, p_correlation_id text)'),
  ('request_github_verify(p_connection_id uuid, p_operator_id uuid, p_correlation_id text)'),
  ('request_opencode_connection_action(p_connection_id uuid, p_operator_id uuid, p_action text, p_correlation_id text)'),
  ('request_project_deletion(p_project_id uuid, p_owner_id uuid, p_expected_version bigint, p_correlation_id text, p_skip_grace boolean)'),
  ('request_revision(p_project_id uuid, p_task_id uuid, p_reviewer_agent_id uuid, p_changes_required jsonb, p_acceptance_criteria jsonb, p_idempotency_key text, p_expected_version bigint, p_correlation_id text)'),
  ('request_runtime_interrupt(p_project_id uuid, p_task_id uuid, p_actor_id text, p_reason text, p_correlation_id text)'),
  ('request_workspace_operation(p_project_id uuid, p_operation_type text, p_actor_id text, p_reason text, p_correlation_id text)'),
  ('resolve_runtime_job_incident(p_job_id bigint, p_actor_id text, p_resolution text, p_correlation_id text)'),
  ('resolve_worker_interaction(p_report_id uuid, p_actor_id text, p_response jsonb, p_correlation_id text)'),
  ('retry_project_cleanup(p_project_id uuid, p_owner_id uuid, p_expected_version bigint, p_correlation_id text)'),
  ('retry_project_provisioning(p_project_id uuid, p_owner_id uuid, p_actor text, p_correlation text)'),
  ('revoke_other_web_sessions(p_token_digest bytea, p_reason text)'),
  ('revoke_web_session(p_token_digest bytea, p_reason text)'),
  ('revoke_web_session_by_id(p_token_digest bytea, p_session_id uuid, p_reason text)'),
  ('set_project_runtime_defaults(p_project_id uuid, p_owner_id uuid, p_expected_version bigint, p_orchestrator_entry_id uuid, p_executor_entry_ids uuid[], p_reasoning_effort text, p_service_tier text, p_actor text, p_correlation_id text, p_executor_reasoning_efforts text[])'),
  ('start_codex_device_login(p_operator_id uuid, p_correlation_id text, p_ttl interval)'),
  ('start_opencode_enrollment(p_operator_id uuid, p_billing_boundary text, p_correlation_id text, p_ttl interval)'),
  ('store_opencode_enrollment_secret(p_enrollment_id uuid, p_operator_id uuid, p_ciphertext text, p_iv text, p_tag text, p_key_wrap text, p_key_fingerprint text)'),
  ('touch_web_session(p_token_digest bytea, p_idle interval, p_slide_after interval)'),
  ('undo_project_deletion(p_project_id uuid, p_owner_id uuid, p_expected_version bigint, p_correlation_id text)'),
  -- 0071 (WP-9c): read-only. Whether a job's recorded driver declares
  -- interrupt — the Stop button's one answer — and usage by what ran, which
  -- checks the owner itself.
  ('runtime_job_can_interrupt(p_job_id bigint)'),
  ('conversation_runtime_usage(p_project_id uuid, p_task_id uuid, p_owner_id uuid)'),
  -- 0072 (C2): the dead-letter card's two buttons. Each checks the owner and the
  -- dead letter it answers itself; the table they write and their shared
  -- helper are not granted.
  ('retry_dead_letter_job(p_job_id bigint, p_attempt integer, p_owner_id uuid, p_actor text, p_note text, p_correlation_id text)'),
  ('dismiss_dead_letter_job(p_job_id bigint, p_attempt integer, p_owner_id uuid, p_actor text, p_note text, p_correlation_id text)'),
  -- 0085 (sprint B P1): the operator's publish of a prepared commit and the
  -- retry of one that stopped. Each checks the owner itself; the intents table
  -- and the broker's functions are not granted.
  ('request_publish(p_preparation_id uuid, p_owner_id uuid, p_actor text, p_correlation_id text)'),
  ('retry_publish_intent(p_intent_id uuid, p_attempt integer, p_owner_id uuid, p_actor text, p_correlation_id text)'),
  -- 0088 (sprint C U1): read-only. The four readiness states of every
  -- assignment of a project, checking the owner itself; it reads
  -- provider_connections, which infra_web may not, so it is SECURITY DEFINER.
  -- The reading it is built on and the refusal that shares it are not granted.
  ('project_readiness(p_project_id uuid, p_owner_id uuid)'),
  -- 0089 (sprint C U2): the Team tab's read and its three writes. Each checks
  -- the owner and the team's version itself, and is audited; the helpers that
  -- lock the team and hold its positions are not granted.
  ('project_team(p_project_id uuid, p_owner_id uuid)'),
  -- 0111 (Stage 12, a reasoning level per member): add and change take the
  -- member's level as a last, defaulted argument; the level alone and the
  -- tab's read of the levels are their own functions, each checking the owner
  -- and the team's version (the read: the owner) itself.
  ('add_project_executor(p_project_id uuid, p_owner_id uuid, p_expected_version bigint, p_entry_id uuid, p_actor text, p_correlation_id text, p_reasoning_effort text)'),
  ('change_project_assignment_model(p_project_id uuid, p_owner_id uuid, p_expected_version bigint, p_assignment_id uuid, p_entry_id uuid, p_actor text, p_correlation_id text, p_reasoning_effort text)'),
  ('set_project_assignment_reasoning(p_project_id uuid, p_owner_id uuid, p_expected_version bigint, p_assignment_id uuid, p_reasoning_effort text, p_actor text, p_correlation_id text)'),
  ('project_team_reasoning(p_project_id uuid, p_owner_id uuid)'),
  ('disable_project_executor(p_project_id uuid, p_owner_id uuid, p_expected_version bigint, p_assignment_id uuid, p_actor text, p_correlation_id text)'),
  -- 0120: the sidebar's ⋯ menu renames, archives and restores a project. Each
  -- checks the owner and the project's version itself; archiving refuses while
  -- work is queued or running; all three are audited.
  ('rename_project(p_project_id uuid, p_owner_id uuid, p_expected_version bigint, p_name text, p_correlation_id text)'),
  ('archive_project(p_project_id uuid, p_owner_id uuid, p_expected_version bigint, p_correlation_id text)'),
  ('unarchive_project(p_project_id uuid, p_owner_id uuid, p_expected_version bigint, p_correlation_id text)'),
  -- 0090: the operator closes an abandoned task. Checks the owner and the
  -- task's version itself, refuses while its work runs, and is audited.
  ('close_task(p_project_id uuid, p_task_id uuid, p_owner_id uuid, p_expected_version bigint, p_actor text, p_correlation_id text)'),
  -- 0091 (sprint C K2): the Settings card for Claude Code — its read, and the
  -- connection on and off. Each checks the operator itself; connecting asks
  -- the host's report, which the panel cannot write.
  ('get_operator_claude_connection(p_operator_id uuid)'),
  ('connect_claude_connection(p_operator_id uuid, p_actor text, p_correlation_id text)'),
  ('disconnect_claude_connection(p_operator_id uuid, p_connection_id uuid, p_actor text, p_correlation_id text)'),
  -- Stage 12 W6 (0100, 0101; docs/W6_W7_CONTRACT.md): the Models card and
  -- search (read-only), a pin and an unpin, asking for one model's check and
  -- polling it. Each checks the operator itself (42501 otherwise); the lane's
  -- tables and the worker's claim, completion and deferral are not granted.
  ('get_operator_models(p_operator_id uuid)'),
  ('search_operator_model_catalog(p_operator_id uuid, p_connection_id uuid, p_query text, p_filters jsonb, p_limit integer)'),
  ('pin_model(p_operator_id uuid, p_entry_id uuid)'),
  ('unpin_model(p_operator_id uuid, p_entry_id uuid)'),
  ('request_model_check(p_operator_id uuid, p_entry_id uuid, p_trigger text)'),
  ('get_model_check(p_operator_id uuid, p_check_id uuid)'),
  -- Stage 12, limits and consumption (0114): Settings' Limits & usage card and
  -- the task view's consumption line. Read-only; each checks the operator
  -- itself. The usage tables and their helpers are not granted.
  ('get_operator_usage_limits(p_operator_id uuid)'),
  ('get_task_usage(p_project_id uuid, p_task_id uuid, p_owner_id uuid)'),
  ('write_session_audit(p_token_digest bytea, p_action text, p_target_type text, p_target_id text, p_decision text, p_details jsonb, p_project_id uuid, p_correlation text)');

DO $$
DECLARE
  v_extra text[];
  v_missing text[];
  v_writable text;
BEGIN
  SELECT array_agg(p.proname||'('||pg_get_function_identity_arguments(p.oid)||')' ORDER BY 1)
  INTO v_extra
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname='control_plane'
    AND has_function_privilege('infra_web', p.oid, 'EXECUTE')
    AND NOT EXISTS (
      SELECT 1 FROM infra_web_allowlist a
      WHERE a.signature = p.proname||'('||pg_get_function_identity_arguments(p.oid)||')');

  -- Matched against pg_proc rather than cast to regprocedure: the allowlist
  -- carries parameter names for readability, and a type name cannot include one.
  SELECT array_agg(a.signature ORDER BY a.signature)
  INTO v_missing
  FROM infra_web_allowlist a
  WHERE NOT EXISTS (
    SELECT 1 FROM pg_proc p
    JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='control_plane'
      AND p.proname||'('||pg_get_function_identity_arguments(p.oid)||')' = a.signature
      AND has_function_privilege('infra_web', p.oid, 'EXECUTE'));

  IF v_extra IS NOT NULL THEN
    RAISE EXCEPTION
      'infra_web can execute functions that are not on the allowlist: %. Widening the web surface is a deliberate act; add it here and say why.',
      array_to_string(v_extra, ', ') USING ERRCODE='42501';
  END IF;
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'the allowlist names functions infra_web cannot execute: %',
      array_to_string(v_missing, ', ');
  END IF;

  -- And the other half of the boundary: no direct DML, anywhere.
  --
  -- `information_schema.table_privileges` reports only whole-table grants, so a
  -- `GRANT UPDATE(password_hash)` would pass it unnoticed. The effective checks
  -- are used instead: they account for column-level grants and for anything
  -- inherited through a role, which is what "can this role write" actually means.
  SELECT string_agg(DISTINCT c.relname, ', ' ORDER BY c.relname)
  INTO v_writable
  FROM pg_class c
  JOIN pg_namespace n ON n.oid=c.relnamespace
  WHERE n.nspname='control_plane'
    AND c.relkind IN ('r','p','v','m','f')
    AND (has_table_privilege('infra_web', c.oid, 'INSERT')
      OR has_table_privilege('infra_web', c.oid, 'UPDATE')
      OR has_table_privilege('infra_web', c.oid, 'DELETE')
      OR has_table_privilege('infra_web', c.oid, 'TRUNCATE')
      OR has_any_column_privilege('infra_web', c.oid, 'INSERT, UPDATE'));
  IF v_writable IS NOT NULL THEN
    RAISE EXCEPTION 'infra_web holds direct write privileges on: %', v_writable USING ERRCODE='42501';
  END IF;

  -- The column-level form named explicitly, so a future column grant fails with
  -- the column in the message rather than as a bare table name.
  SELECT string_agg(DISTINCT table_name||'.'||column_name||':'||privilege_type, ', ')
  INTO v_writable
  FROM information_schema.column_privileges
  WHERE grantee='infra_web' AND table_schema='control_plane'
    AND privilege_type IN ('INSERT','UPDATE','REFERENCES');
  IF v_writable IS NOT NULL THEN
    RAISE EXCEPTION 'infra_web holds column-level write privileges: %', v_writable USING ERRCODE='42501';
  END IF;

  RAISE NOTICE 'infra_web allowlist assertions passed (% functions)', (SELECT count(*) FROM infra_web_allowlist);
END $$;

-- The allowlist above is a privilege check. This is the behavioural one: the
-- functions that were revoked are actually refused when called, not merely
-- un-granted on paper. Every one of them is invoked with NULL arguments, so the
-- privilege check is what decides — if a grant came back, the call would get
-- past it and raise something else, and this test would fail.
DO $$
DECLARE
  v_signatures text[] := ARRAY[
    'create_web_session(uuid,bytea,bytea,interval,interval,bytea,bytea)',
    'revoke_user_sessions(uuid,text,uuid)',
    'set_user_password(uuid,text,boolean,uuid)',
    'set_user_username(uuid,text)',
    'record_auth_attempt(text,bytea,text,bytea)',
    'capture_task_runtime_snapshot(uuid,uuid)',
    'capture_task_runtime_snapshot(uuid,uuid,uuid[])'
  ];
  v_signature text;
  v_name text;
  v_types text;
  v_args text;
  v_sql text;
  v_denied boolean;
  v_leaked text[] := ARRAY[]::text[];
BEGIN
  EXECUTE 'SET ROLE infra_web';
  FOREACH v_signature IN ARRAY v_signatures LOOP
    v_name := split_part(v_signature, '(', 1);
    -- Both parens, not just the closing one: trimming only ')' leaves a leading
    -- '(' glued to the first type.
    v_types := trim(both '()' from substring(v_signature from position('(' in v_signature)));
    SELECT string_agg('NULL::'||t, ', ') INTO v_args
    FROM unnest(string_to_array(v_types, ',')) AS t;
    v_sql := format('SELECT control_plane.%I(%s)', v_name, v_args);

    v_denied := false;
    BEGIN
      EXECUTE v_sql;
    EXCEPTION
      WHEN insufficient_privilege THEN v_denied := true;
      WHEN OTHERS THEN v_denied := false;
    END;
    IF NOT v_denied THEN v_leaked := v_leaked || v_signature; END IF;
  END LOOP;
  EXECUTE 'RESET ROLE';

  IF array_length(v_leaked, 1) > 0 THEN
    RAISE EXCEPTION 'infra_web still calls revoked functions: %',
      array_to_string(v_leaked, ', ') USING ERRCODE='42501';
  END IF;

  RAISE NOTICE 'infra_web call-level denials passed (% functions)', array_length(v_signatures, 1);
END $$;

RESET ROLE;

ROLLBACK;
