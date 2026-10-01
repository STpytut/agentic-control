-- Roles are permission sets, expand half (migration 0079, Stage 11.3 R2; ADR-0017).
--
-- What the schema now holds and refuses:
--   * the closed vocabulary and the two built-ins, which are today's behaviour;
--   * every assignment points at a definition, and a writer that still names
--     the word gets the built-in of that word;
--   * a definition written with its permissions names the word the readers
--     of this release decide on, so a custom conversation holder is an
--     orchestrator and the one-default index holds for it;
--   * the combinations ADR-0017 §4 forbids, a change to a built-in, and an
--     assignment whose runtime lacks a capability its permissions need;
--   * a task keeps the permissions it was given, whatever the definition
--     becomes later.
\set ON_ERROR_STOP on

BEGIN;
SET search_path TO control_plane,public,extensions;

DO $$
DECLARE
  v_owner uuid; v_project uuid; v_codex_profile uuid; v_opencode_profile uuid;
  v_codex uuid; v_worker uuid; v_orchestrator uuid; v_executor uuid; v_task uuid;
  v_custom uuid; v_holder uuid; v_row project_agent_assignments; v_snapshot task_role_snapshots;
BEGIN
  -- The vocabulary and the built-ins.
  IF (SELECT array_agg(permission ORDER BY permission) FROM role_permission_vocabulary)
     <> ARRAY['completion.required','conversation.hold','implementation.execute','publish.request','review.perform'] THEN
    RAISE EXCEPTION 'the permission vocabulary is not the closed five';
  END IF;
  IF (SELECT array_agg(p.permission ORDER BY p.permission) FROM role_permissions p JOIN role_definitions d ON d.id=p.role_definition_id WHERE d.builtin_key='orchestrator')
     <> ARRAY['conversation.hold','publish.request','review.perform']
     OR (SELECT array_agg(p.permission ORDER BY p.permission) FROM role_permissions p JOIN role_definitions d ON d.id=p.role_definition_id WHERE d.builtin_key='executor')
     <> ARRAY['completion.required','implementation.execute'] THEN
    RAISE EXCEPTION 'the built-ins are not ADR-0017 §3';
  END IF;
  IF EXISTS (SELECT 1 FROM project_agent_assignments WHERE role_definition_id IS NULL) THEN
    RAISE EXCEPTION 'an assignment has no role definition';
  END IF;

  -- A built-in is changed only by a migration.
  BEGIN
    UPDATE role_definitions SET name='Boss' WHERE builtin_key='orchestrator';
    RAISE EXCEPTION 'a built-in role was renamed';
  EXCEPTION WHEN others THEN
    IF SQLERRM NOT LIKE '%changed only by a migration%' THEN RAISE; END IF;
  END;
  BEGIN
    DELETE FROM role_permissions WHERE role_definition_id=(SELECT id FROM role_definitions WHERE builtin_key='executor')
      AND permission='completion.required';
    RAISE EXCEPTION 'a built-in role lost a permission';
  EXCEPTION WHEN others THEN
    IF SQLERRM NOT LIKE '%changed only by a migration%' THEN RAISE; END IF;
  END;

  -- Fixture: a Codex orchestrator and an OpenCode executor, written the way
  -- this release's writers write them — by the word.
  INSERT INTO users(display_name) VALUES('Roles Test') RETURNING id INTO v_owner;
  INSERT INTO projects(owner_id,name,slug,workspace_path)
    VALUES(v_owner,'Roles Test','roles-test','/srv/roles-test') RETURNING id INTO v_project;
  INSERT INTO runtime_profiles(runtime_type,adapter_version,runtime_version,provider_type,model)
    VALUES('codex','test','test','openai','roles-codex') RETURNING id INTO v_codex_profile;
  INSERT INTO runtime_profiles(runtime_type,adapter_version,runtime_version,provider_type,model)
    VALUES('opencode','test','test','opencode','roles-opencode') RETURNING id INTO v_opencode_profile;
  INSERT INTO agents(name,role,runtime_profile_id) VALUES('roles-codex','architect',v_codex_profile) RETURNING id INTO v_codex;
  INSERT INTO agents(name,role,runtime_profile_id) VALUES('roles-worker','implementer',v_opencode_profile) RETURNING id INTO v_worker;
  INSERT INTO project_agent_assignments(project_id,agent_id,runtime_profile_id,assignment_role,is_default)
    VALUES(v_project,v_codex,v_codex_profile,'orchestrator',true) RETURNING * INTO v_row;
  v_orchestrator := v_row.id;
  IF v_row.role_definition_id<>(SELECT id FROM role_definitions WHERE builtin_key='orchestrator') THEN
    RAISE EXCEPTION 'a writer naming the word did not get the built-in';
  END IF;
  INSERT INTO project_agent_assignments(project_id,agent_id,runtime_profile_id,assignment_role)
    VALUES(v_project,v_worker,v_opencode_profile,'executor') RETURNING id INTO v_executor;

  -- A definition names the word. A custom conversation holder is an orchestrator.
  INSERT INTO role_definitions(owner_id,name) VALUES(v_owner,'Lead') RETURNING id INTO v_custom;
  INSERT INTO role_permissions(role_definition_id,permission) VALUES(v_custom,'conversation.hold'),(v_custom,'review.perform');
  SET CONSTRAINTS role_permissions_valid IMMEDIATE;
  SET CONSTRAINTS role_permissions_valid DEFERRED;
  INSERT INTO agents(name,role,runtime_profile_id) VALUES('roles-lead','architect',v_codex_profile) RETURNING id INTO v_holder;
  INSERT INTO project_agent_assignments(project_id,agent_id,runtime_profile_id,role_definition_id)
    VALUES(v_project,v_holder,v_codex_profile,v_custom) RETURNING * INTO v_row;
  IF v_row.assignment_role<>'orchestrator' THEN
    RAISE EXCEPTION 'a conversation holder was not named the orchestrator: %', v_row.assignment_role;
  END IF;
  -- … and the one-default index holds for it.
  BEGIN
    UPDATE project_agent_assignments SET is_default=true WHERE id=v_row.id;
    RAISE EXCEPTION 'a second default conversation holder was accepted';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;

  -- Forbidden combinations (ADR-0017 §4), refused when the definition is complete.
  BEGIN
    INSERT INTO role_definitions(owner_id,name) VALUES(v_owner,'Both') RETURNING id INTO v_custom;
    INSERT INTO role_permissions(role_definition_id,permission) VALUES(v_custom,'conversation.hold'),(v_custom,'implementation.execute');
    SET CONSTRAINTS role_permissions_valid IMMEDIATE;
    RAISE EXCEPTION 'a holder that also implements was accepted';
  EXCEPTION WHEN others THEN
    IF SQLERRM NOT LIKE '%separate runs%' THEN RAISE; END IF;
  END;
  SET CONSTRAINTS role_permissions_valid DEFERRED;
  BEGIN
    INSERT INTO role_definitions(owner_id,name) VALUES(v_owner,'Reviewer') RETURNING id INTO v_custom;
    INSERT INTO role_permissions(role_definition_id,permission) VALUES(v_custom,'review.perform');
    SET CONSTRAINTS role_permissions_valid IMMEDIATE;
    RAISE EXCEPTION 'a separate reviewer was accepted before it exists';
  EXCEPTION WHEN others THEN
    IF SQLERRM NOT LIKE '%held by the conversation holder%' THEN RAISE; END IF;
  END;
  SET CONSTRAINTS role_permissions_valid DEFERRED;
  BEGIN
    INSERT INTO role_definitions(owner_id,name) VALUES(v_owner,'Gate') RETURNING id INTO v_custom;
    INSERT INTO role_permissions(role_definition_id,permission) VALUES(v_custom,'completion.required');
    SET CONSTRAINTS role_permissions_valid IMMEDIATE;
    RAISE EXCEPTION 'completion.required without implementation was accepted';
  EXCEPTION WHEN others THEN
    IF SQLERRM NOT LIKE '%belongs to implementation.execute%' THEN RAISE; END IF;
  END;
  SET CONSTRAINTS role_permissions_valid DEFERRED;

  -- A runtime without a capability the permissions need is refused: Codex
  -- without run.workspace_write cannot be an executor. (0123 gave it the
  -- capability; taken away here, where the refusal is what is tested.)
  DELETE FROM runtime_capabilities WHERE runtime_type='codex' AND capability='run.workspace_write';
  BEGIN
    INSERT INTO agents(name,role,runtime_profile_id) VALUES('roles-codex-worker','implementer',v_codex_profile) RETURNING id INTO v_holder;
    INSERT INTO project_agent_assignments(project_id,agent_id,runtime_profile_id,role_definition_id)
      VALUES(v_project,v_holder,v_codex_profile,(SELECT id FROM role_definitions WHERE builtin_key='executor'));
    RAISE EXCEPTION 'Codex was assigned to implement';
  EXCEPTION WHEN others THEN
    IF SQLERRM NOT LIKE '%does not play the executor%' AND SQLERRM NOT LIKE '%lacks a capability%'
       AND SQLERRM NOT LIKE '%not registered for what the role holds%' THEN RAISE; END IF;
  END;

  -- A task snapshots its permissions and keeps them.
  INSERT INTO tasks(project_id,title,objective,status,active_agent_id,orchestrator_assignment_id,created_by)
    VALUES(v_project,'Roles task','x','planning',v_codex,v_orchestrator,'test') RETURNING id INTO v_task;
  INSERT INTO task_executor_assignments(task_id,project_agent_assignment_id,priority) VALUES(v_task,v_executor,10);
  SELECT * INTO v_snapshot FROM task_role_snapshots WHERE task_id=v_task AND assignment_id=v_orchestrator;
  IF v_snapshot.permissions<>ARRAY['conversation.hold','publish.request','review.perform'] THEN
    RAISE EXCEPTION 'the orchestrator''s permissions were not snapshotted: %', v_snapshot.permissions;
  END IF;
  IF (SELECT permissions FROM task_role_snapshots WHERE task_id=v_task AND assignment_id=v_executor)
     <> ARRAY['completion.required','implementation.execute'] THEN
    RAISE EXCEPTION 'the executor''s permissions were not snapshotted';
  END IF;
  -- Moving the assignment to another definition leaves the task's snapshot.
  INSERT INTO role_definitions(owner_id,name) VALUES(v_owner,'Lead 2') RETURNING id INTO v_custom;
  INSERT INTO role_permissions(role_definition_id,permission) VALUES(v_custom,'conversation.hold');
  UPDATE project_agent_assignments SET role_definition_id=v_custom WHERE id=v_orchestrator;
  UPDATE tasks SET orchestrator_assignment_id=v_orchestrator WHERE id=v_task;
  IF (SELECT permissions FROM task_role_snapshots WHERE task_id=v_task AND assignment_id=v_orchestrator)
     <> ARRAY['conversation.hold','publish.request','review.perform'] THEN
    RAISE EXCEPTION 'a task in flight took a later definition';
  END IF;

  RAISE NOTICE 'roles are permission sets: vocabulary, built-ins, combinations, capabilities and snapshots hold';
END $$;


-- R3 (0080) and R4 (0081): decisions ask for permissions. `assignment_role` is
-- named only by the trigger that keeps it as the definition's projection, and
-- no function names an agent's word at all; agents.role is history.
DO $$
DECLARE v_left text;
BEGIN
  SELECT string_agg(p.proname, ', ' ORDER BY p.proname) INTO v_left
  FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname='control_plane' AND p.prokind='f' AND pg_get_functiondef(p.oid) ~ '(^|[^_a-z])assignment_role'
    AND p.proname<>'fill_assignment_role_definition';
  IF v_left IS NOT NULL THEN
    RAISE EXCEPTION 'functions still decide on assignment_role: %', v_left;
  END IF;
  IF NOT has_function_privilege('infra_worker','control_plane.role_holds(uuid,text)','EXECUTE')
     OR has_function_privilege('infra_web','control_plane.role_holds(uuid,text)','EXECUTE') THEN
    RAISE EXCEPTION 'role_holds is not the worker''s alone';
  END IF;
  SELECT string_agg(p.proname, ', ' ORDER BY p.proname) INTO v_left
  FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname='control_plane' AND p.prokind='f'
    AND pg_get_functiondef(p.oid) ~ '''(architect|reviewer|implementer)''';
  IF v_left IS NOT NULL THEN RAISE EXCEPTION 'functions still name an agent''s word: %', v_left; END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='control_plane.agents'::regclass AND conname='agents_role_check')
     OR (SELECT attnotnull FROM pg_attribute WHERE attrelid='control_plane.agents'::regclass AND attname='role') THEN
    RAISE EXCEPTION 'agents.role still constrains an agent';
  END IF;
  IF NOT has_function_privilege('infra_worker','control_plane.agent_holds(uuid,text)','EXECUTE')
     OR has_function_privilege('infra_web','control_plane.agent_holds(uuid,text)','EXECUTE') THEN
    RAISE EXCEPTION 'agent_holds is not the worker''s alone';
  END IF;
  RAISE NOTICE 'no decision reads assignment_role or an agent''s word';
END $$;

ROLLBACK;
