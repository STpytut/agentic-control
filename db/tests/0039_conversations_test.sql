-- WP-4: Conversation, Task, NativeSession and Run (migration 0063, ADR-0014).
\set ON_ERROR_STOP on

BEGIN;
SET search_path TO control_plane, public, extensions;

CREATE TEMP SEQUENCE conv_event_version START 9000;
CREATE FUNCTION pg_temp.refusal(p_sql text) RETURNS text LANGUAGE plpgsql AS $$
DECLARE v_detail text; v_constraint text;
BEGIN
  EXECUTE p_sql;
  RETURN NULL;
EXCEPTION WHEN OTHERS THEN
  GET STACKED DIAGNOSTICS v_detail = PG_EXCEPTION_DETAIL, v_constraint = CONSTRAINT_NAME;
  RETURN COALESCE(NULLIF(v_constraint,''),NULLIF(v_detail,''),'sqlstate:'||SQLSTATE);
END $$;
CREATE FUNCTION pg_temp.expect_refusal(p_sql text, p_expected text, p_what text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE v_got text;
BEGIN
  v_got:=pg_temp.refusal(p_sql);
  IF v_got IS DISTINCT FROM p_expected THEN
    RAISE EXCEPTION '%: expected refusal %, got %',p_what,p_expected,COALESCE(v_got,'success');
  END IF;
END $$;

CREATE TEMP TABLE conv_fixture(project_id uuid, codex uuid, codex_profile uuid, orch uuid) ON COMMIT DROP;
DO $$
DECLARE v_user uuid; v_project uuid; v_cp uuid; v_codex uuid; v_oa uuid;
BEGIN
  INSERT INTO users(display_name) VALUES('Conversations') RETURNING id INTO v_user;
  INSERT INTO projects(owner_id,name,slug,workspace_path) VALUES(v_user,'Conversations','conversations','/srv/conversations') RETURNING id INTO v_project;
  INSERT INTO runtime_profiles(runtime_type,adapter_version,runtime_version,provider_type,model)
    VALUES('codex','test','test','openai','codex-conv') RETURNING id INTO v_cp;
  INSERT INTO agents(name,role,runtime_profile_id) VALUES('conv-codex','architect',v_cp) RETURNING id INTO v_codex;
  INSERT INTO project_agent_assignments(project_id,agent_id,runtime_profile_id,assignment_role,is_default)
    VALUES(v_project,v_codex,v_cp,'orchestrator',true) RETURNING id INTO v_oa;
  INSERT INTO conv_fixture VALUES(v_project,v_codex,v_cp,v_oa);
END $$;

CREATE FUNCTION pg_temp.new_task(p_title text, p_parent uuid DEFAULT NULL) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE v_f conv_fixture; v_id uuid;
BEGIN
  SELECT * INTO v_f FROM conv_fixture;
  INSERT INTO tasks(project_id,title,objective,status,active_agent_id,orchestrator_assignment_id,created_by,followup_of_task_id)
    VALUES(v_f.project_id,p_title,'Work','planning',v_f.codex,v_f.orch,'test',p_parent) RETURNING id INTO v_id;
  RETURN v_id;
END $$;
CREATE FUNCTION pg_temp.event(p_task uuid, p_type text) RETURNS domain_events LANGUAGE plpgsql AS $$
DECLARE v_f conv_fixture;
BEGIN
  SELECT * INTO v_f FROM conv_fixture;
  RETURN append_event(p_type,v_f.project_id,p_task,NULL,'user','operator',NULL,'conv',
    'conv-'||nextval('conv_event_version'),'task',p_task,nextval('conv_event_version'),'{}'::jsonb);
END $$;

-- A task opens a conversation; a follow-up joins its parent's; nothing else joins
-- one; a task does not move.
DO $$
DECLARE v_a uuid; v_b uuid; v_c uuid; v_f conv_fixture;
BEGIN
  SELECT * INTO v_f FROM conv_fixture;
  v_a:=pg_temp.new_task('first');
  v_b:=pg_temp.new_task('follow-up', v_a);
  v_c:=pg_temp.new_task('another');
  IF (SELECT conversation_id FROM tasks WHERE id=v_a) IS NULL
     OR (SELECT conversation_id FROM tasks WHERE id=v_b)<>(SELECT conversation_id FROM tasks WHERE id=v_a)
     OR (SELECT conversation_id FROM tasks WHERE id=v_c)=(SELECT conversation_id FROM tasks WHERE id=v_a) THEN
    RAISE EXCEPTION 'conversations were not assigned as a line per root';
  END IF;
  PERFORM pg_temp.expect_refusal(format(
    'INSERT INTO tasks(project_id,title,objective,status,created_by,conversation_id) VALUES(%L,%L,%L,%L,%L,%L)',
    v_f.project_id,'intruder','x','planning','test',(SELECT conversation_id FROM tasks WHERE id=v_a)),
    'conversation_join_requires_followup','a task that is not a follow-up joining a conversation');
  PERFORM pg_temp.expect_refusal(format('UPDATE tasks SET conversation_id=%L WHERE id=%L',
    (SELECT conversation_id FROM tasks WHERE id=v_c), v_b),
    'conversation_immutable','a task moved to another conversation');
  PERFORM pg_temp.expect_refusal(format('SELECT pg_temp.new_task(%L,%L)','second follow-up',v_a),
    'tasks_followup_is_linear','a second follow-up of one task');
  RAISE NOTICE 'a task opens a conversation, a follow-up joins it, nothing else does, and it is a line';
END $$;

-- The order: every task event takes the next number of its conversation; numbers
-- are per conversation; a rolled-back event leaves no gap; a caller cannot supply
-- a number; a project event takes none.
DO $$
DECLARE v_a uuid; v_b uuid; v_x uuid; v_e domain_events; v_f conv_fixture; v_conv uuid; v_seqs bigint[];
BEGIN
  SELECT * INTO v_f FROM conv_fixture;
  v_a:=pg_temp.new_task('ordered');
  v_b:=pg_temp.new_task('ordered follow-up', v_a);
  v_x:=pg_temp.new_task('elsewhere');
  v_conv:=(SELECT conversation_id FROM tasks WHERE id=v_a);

  PERFORM pg_temp.event(v_a,'chat.user_message');
  PERFORM pg_temp.event(v_x,'chat.user_message');
  PERFORM pg_temp.event(v_a,'chat.agent_message');
  BEGIN
    PERFORM pg_temp.event(v_b,'chat.user_message');
    RAISE EXCEPTION 'roll this one back';
  EXCEPTION WHEN raise_exception THEN NULL;
  END;
  PERFORM pg_temp.event(v_b,'chat.agent_message');

  SELECT array_agg(conversation_sequence ORDER BY conversation_sequence) INTO v_seqs
  FROM domain_events WHERE conversation_id=v_conv;
  IF v_seqs<>ARRAY[1,2,3]::bigint[] THEN
    RAISE EXCEPTION 'the conversation is numbered %, not 1,2,3 without gaps',v_seqs;
  END IF;
  IF (SELECT conversation_sequence FROM domain_events WHERE task_id=v_x)<>1 THEN
    RAISE EXCEPTION 'another conversation''s numbering is not its own';
  END IF;
  IF (SELECT last_sequence FROM conversations WHERE id=v_conv)<>3 THEN
    RAISE EXCEPTION 'the counter does not match the numbers issued';
  END IF;

  -- Forged numbers are ignored.
  INSERT INTO domain_events(event_type,project_id,task_id,actor_type,actor_id,correlation_id,aggregate_type,aggregate_id,aggregate_version,conversation_id,conversation_sequence)
    VALUES('chat.user_message',v_f.project_id,v_a,'user','operator','conv','task',v_a,nextval('conv_event_version'),
      (SELECT conversation_id FROM tasks WHERE id=v_x),999)
    RETURNING * INTO v_e;
  IF v_e.conversation_id<>v_conv OR v_e.conversation_sequence<>4 THEN
    RAISE EXCEPTION 'a supplied conversation or number was accepted: %/%',v_e.conversation_id,v_e.conversation_sequence;
  END IF;

  -- A project event is not part of any conversation, even when one is supplied.
  INSERT INTO domain_events(event_type,project_id,actor_type,actor_id,correlation_id,aggregate_type,aggregate_id,aggregate_version,conversation_id,conversation_sequence)
    VALUES('project.noted',v_f.project_id,'system','conv','conv','project',v_f.project_id,nextval('conv_event_version'),v_conv,999)
    RETURNING * INTO v_e;
  IF v_e.conversation_id IS NOT NULL OR v_e.conversation_sequence IS NOT NULL THEN
    RAISE EXCEPTION 'a project event kept a supplied conversation number';
  END IF;
  v_e:=append_event('project.noted',v_f.project_id,NULL,NULL,'system','conv',NULL,'conv','conv-project-'||nextval('conv_event_version'),
    'project',v_f.project_id,nextval('conv_event_version'),'{}'::jsonb);
  IF v_e.conversation_id IS NOT NULL OR v_e.conversation_sequence IS NOT NULL THEN
    RAISE EXCEPTION 'a project event was given a conversation number';
  END IF;
  RAISE NOTICE 'every task event takes the next number of its conversation, without gaps, forgery or project events';
END $$;

-- Sessions: the namespace is derived; one active session per conversation, role
-- and agent; one native id per namespace.
DO $$
DECLARE v_a uuid; v_f conv_fixture; v_conv uuid; v_s uuid; v_op uuid;
BEGIN
  SELECT * INTO v_f FROM conv_fixture;
  v_a:=pg_temp.new_task('sessions');
  v_conv:=(SELECT conversation_id FROM tasks WHERE id=v_a);
  INSERT INTO agent_sessions(project_id,agent_id,runtime_profile_id,native_session_id,purpose,conversation_id,role,session_namespace)
    VALUES(v_f.project_id,v_f.codex,v_f.codex_profile,'thread-1','description',v_conv,'chat','forged-namespace')
    RETURNING id INTO v_s;
  IF (SELECT session_namespace FROM agent_sessions WHERE id=v_s)<>'codex' THEN
    RAISE EXCEPTION 'a supplied session namespace was accepted';
  END IF;
  PERFORM pg_temp.expect_refusal(format(
    'INSERT INTO agent_sessions(project_id,agent_id,runtime_profile_id,purpose,conversation_id,role) VALUES(%L,%L,%L,%L,%L,%L)',
    v_f.project_id,v_f.codex,v_f.codex_profile,'a copy',v_conv,'chat'),
    'agent_sessions_one_active_per_conversation_role','a second active chat session for one agent in one conversation');
  PERFORM pg_temp.expect_refusal(format(
    'INSERT INTO agent_sessions(project_id,agent_id,runtime_profile_id,native_session_id,purpose) VALUES(%L,%L,%L,%L,%L)',
    v_f.project_id,v_f.codex,v_f.codex_profile,'thread-1','elsewhere'),
    'agent_sessions_native_identity','one native session id in two rows of one namespace');
  INSERT INTO runtime_profiles(runtime_type,adapter_version,runtime_version,provider_type,model)
    VALUES('opencode','test','test','opencode-free','other') RETURNING id INTO v_op;
  INSERT INTO agent_sessions(project_id,agent_id,runtime_profile_id,native_session_id,purpose)
    VALUES(v_f.project_id,v_f.codex,v_op,'thread-1','same id, another runtime');
  RAISE NOTICE 'a session''s namespace is derived, and a copy of a session or of its native id is refused';
END $$;

-- The chat, end to end through the database: a follow-up resumes the native
-- session its parent bound, without a copy; a session of another runtime's
-- namespace is neither resumed nor overwritten.
CREATE FUNCTION pg_temp.chat_job(p_task uuid) RETURNS runtime_jobs LANGUAGE plpgsql AS $$
DECLARE v_e domain_events; v_m outbox_messages; v_j runtime_jobs;
BEGIN
  v_e:=pg_temp.event(p_task,'chat.user_message');
  v_m:=claim_outbox_event(v_e.id,'conv-dispatcher',interval '1 minute');
  PERFORM route_outbox_message(v_m.id,'conv-dispatcher');
  SELECT * INTO v_j FROM claim_orchestrator_jobs('conv-worker',1,interval '1 minute');
  IF v_j.id IS NULL THEN RAISE EXCEPTION 'no chat job was claimed for %',p_task; END IF;
  RETURN v_j;
END $$;

DO $$
DECLARE v_f conv_fixture; v_a uuid; v_b uuid; v_c uuid; v_j runtime_jobs; v_s uuid; v_s2 uuid; v_op uuid; v_foreign uuid;
BEGIN
  SELECT * INTO v_f FROM conv_fixture;
  v_a:=pg_temp.new_task('chat parent');
  v_j:=pg_temp.chat_job(v_a);
  v_s:=bind_orchestrator_session(v_j.id,'conv-worker','thread-A');
  PERFORM complete_orchestrator_job(v_j.id,'conv-worker','thread-A','turn-A','ok');

  v_b:=pg_temp.new_task('chat follow-up', v_a);
  v_j:=pg_temp.chat_job(v_b);
  IF orchestrator_job_context(v_j.id,'conv-worker')->>'native_session_id' IS DISTINCT FROM 'thread-A' THEN
    RAISE EXCEPTION 'a follow-up did not resume its conversation''s native session';
  END IF;
  v_s2:=bind_orchestrator_session(v_j.id,'conv-worker','thread-A');
  IF v_s2<>v_s OR (SELECT count(*) FROM agent_sessions WHERE native_session_id='thread-A')<>1 THEN
    RAISE EXCEPTION 'a follow-up bound a second session row instead of the conversation''s';
  END IF;
  PERFORM complete_orchestrator_job(v_j.id,'conv-worker','thread-A','turn-B','ok');

  v_c:=pg_temp.new_task('chat after a runtime change');
  INSERT INTO runtime_profiles(runtime_type,adapter_version,runtime_version,provider_type,model)
    VALUES('opencode','test','test','opencode-free','conv-foreign') RETURNING id INTO v_op;
  INSERT INTO agent_sessions(project_id,agent_id,runtime_profile_id,native_session_id,purpose,conversation_id,role)
    VALUES(v_f.project_id,v_f.codex,v_op,'foreign-thread','foreign',(SELECT conversation_id FROM tasks WHERE id=v_c),'chat')
    RETURNING id INTO v_foreign;
  v_j:=pg_temp.chat_job(v_c);
  IF orchestrator_job_context(v_j.id,'conv-worker')->>'native_session_id' IS NOT NULL THEN
    RAISE EXCEPTION 'Codex was handed a native session from another runtime''s namespace';
  END IF;
  v_s:=bind_orchestrator_session(v_j.id,'conv-worker','thread-C');
  IF v_s=v_foreign
     OR (SELECT row(active,native_session_id)::text FROM agent_sessions WHERE id=v_foreign)<>row(false,'foreign-thread')::text THEN
    RAISE EXCEPTION 'the other runtime''s session was overwritten instead of closed';
  END IF;
  RAISE NOTICE 'a follow-up resumes its conversation''s session, and another runtime''s session is closed, not resumed';
END $$;

-- The executor side of the same rule: a session another runtime left in the
-- conversation is closed with its native id intact, and OpenCode starts clean.
DO $$
DECLARE
  v_f conv_fixture; v_task uuid; v_op uuid; v_executor uuid; v_ea uuid; v_foreign uuid;
  v_j runtime_jobs; v_delegate jsonb; v_m outbox_messages; v_context jsonb;
BEGIN
  SELECT * INTO v_f FROM conv_fixture;
  INSERT INTO runtime_profiles(runtime_type,adapter_version,runtime_version,provider_type,model)
    VALUES('opencode','test','test','opencode-free','conv-executor') RETURNING id INTO v_op;
  INSERT INTO agents(name,role,runtime_profile_id) VALUES('conv-executor','implementer',v_op) RETURNING id INTO v_executor;
  INSERT INTO project_agent_assignments(project_id,agent_id,runtime_profile_id,assignment_role)
    VALUES(v_f.project_id,v_executor,v_op,'executor') RETURNING id INTO v_ea;
  v_task:=pg_temp.new_task('executor after a runtime change');
  INSERT INTO task_executor_assignments(task_id,project_agent_assignment_id,priority) VALUES(v_task,v_ea,100);
  INSERT INTO agent_sessions(project_id,agent_id,runtime_profile_id,native_session_id,purpose,conversation_id,role)
    VALUES(v_f.project_id,v_executor,v_f.codex_profile,'foreign-executor-thread','foreign',
      (SELECT conversation_id FROM tasks WHERE id=v_task),'executor')
    RETURNING id INTO v_foreign;

  v_j:=pg_temp.chat_job(v_task);
  v_delegate:=invoke_delegate_task(v_j.id,'conv-worker','conv-delegate','Do the work','[]','[]');
  PERFORM complete_orchestrator_job(v_j.id,'conv-worker','thread-exec','turn-exec','Delegated.');
  v_m:=claim_outbox_event((v_delegate->>'event_id')::uuid,'conv-dispatcher',interval '1 minute');
  PERFORM route_outbox_message(v_m.id,'conv-dispatcher');
  SELECT * INTO v_j FROM claim_executor_jobs('conv-executor-worker',1,interval '2 minutes');
  v_context:=executor_job_context(v_j.id,'conv-executor-worker');
  IF v_context->>'native_session_id' IS NOT NULL OR (v_context->>'session_id')::uuid=v_foreign THEN
    RAISE EXCEPTION 'OpenCode was handed a session from another runtime''s namespace: %',v_context;
  END IF;
  IF (SELECT row(active,native_session_id,session_namespace)::text FROM agent_sessions WHERE id=v_foreign)
     <>row(false,'foreign-executor-thread','codex')::text THEN
    RAISE EXCEPTION 'the other runtime''s executor session was taken over instead of closed';
  END IF;
  RAISE NOTICE 'an executor session of another runtime is closed, not resumed or taken over';
END $$;

-- The backfill, on rows shaped the way 0062 left them: tasks without a
-- conversation, events without numbers, sessions named by purpose, and a copied
-- follow-up session. Constraints and triggers are set aside inside this
-- transaction and put back by ROLLBACK.
DO $$
DECLARE
  v_f conv_fixture; v_root uuid:=gen_random_uuid(); v_follow uuid:=gen_random_uuid(); v_result jsonb;
  v_t0 timestamptz:=clock_timestamp()-interval '2 days'; v_canonical uuid; v_copy uuid; v_conv uuid;
BEGIN
  SELECT * INTO v_f FROM conv_fixture;
  ALTER TABLE tasks DISABLE TRIGGER tasks_assign_conversation;
  ALTER TABLE tasks ALTER COLUMN conversation_id DROP NOT NULL;
  ALTER TABLE domain_events DISABLE TRIGGER domain_events_conversation_sequence;
  ALTER TABLE domain_events DROP CONSTRAINT domain_events_task_event_in_conversation;
  ALTER TABLE agent_sessions DISABLE TRIGGER agent_sessions_derive_namespace;
  ALTER TABLE agent_sessions ALTER COLUMN session_namespace DROP NOT NULL;
  DROP INDEX agent_sessions_one_active_per_conversation_role;
  DROP INDEX agent_sessions_native_identity;

  INSERT INTO tasks(id,project_id,title,objective,status,active_agent_id,orchestrator_assignment_id,created_by,created_at,updated_at)
    VALUES(v_root,v_f.project_id,'legacy','x','approved',v_f.codex,v_f.orch,'test',v_t0,v_t0);
  INSERT INTO tasks(id,project_id,title,objective,status,active_agent_id,orchestrator_assignment_id,created_by,followup_of_task_id,created_at,updated_at)
    VALUES(v_follow,v_f.project_id,'legacy follow-up','x','planning',v_f.codex,v_f.orch,'test',v_root,v_t0+interval '1 hour',v_t0+interval '1 hour');
  -- Events inserted out of time order, with a tie broken by aggregate_version.
  -- Ids run against the shown order, so only occurred_at and aggregate_version
  -- can put these right.
  INSERT INTO domain_events(id,event_type,project_id,task_id,actor_type,actor_id,correlation_id,aggregate_type,aggregate_id,aggregate_version,occurred_at)
  VALUES ('00000000-0000-4000-8000-000000000001','chat.agent_message',v_f.project_id,v_follow,'agent','codex','l','task',v_follow,2,v_t0+interval '2 hours'),
         ('00000000-0000-4000-8000-000000000004','chat.user_message',v_f.project_id,v_root,'user','operator','l','task',v_root,1,v_t0),
         ('00000000-0000-4000-8000-000000000002','chat.user_message',v_f.project_id,v_follow,'user','operator','l','task',v_follow,1,v_t0+interval '2 hours'),
         ('00000000-0000-4000-8000-000000000003','chat.agent_message',v_f.project_id,v_root,'agent','codex','l','task',v_root,2,v_t0+interval '5 minutes');
  INSERT INTO agent_sessions(project_id,agent_id,runtime_profile_id,native_session_id,purpose,created_at)
    VALUES(v_f.project_id,v_f.codex,v_f.codex_profile,'legacy-thread','task_chat:'||v_root,v_t0) RETURNING id INTO v_canonical;
  INSERT INTO agent_sessions(project_id,agent_id,runtime_profile_id,native_session_id,purpose,created_at)
    VALUES(v_f.project_id,v_f.codex,v_f.codex_profile,'legacy-thread','task_chat:'||v_follow,v_t0+interval '1 hour') RETURNING id INTO v_copy;

  v_result:=backfill_conversations();

  v_conv:=(SELECT conversation_id FROM tasks WHERE id=v_root);
  IF v_conv IS NULL OR (SELECT conversation_id FROM tasks WHERE id=v_follow)<>v_conv THEN
    RAISE EXCEPTION 'the legacy chain did not become one conversation: %',v_result;
  END IF;
  IF (SELECT array_agg(event_type||'@'||task_id::text ORDER BY conversation_sequence) FROM domain_events WHERE conversation_id=v_conv)
     <>ARRAY['chat.user_message@'||v_root,'chat.agent_message@'||v_root,'chat.user_message@'||v_follow,'chat.agent_message@'||v_follow] THEN
    RAISE EXCEPTION 'history was not numbered in the order the chat showed it';
  END IF;
  IF (SELECT array_agg(conversation_sequence ORDER BY conversation_sequence) FROM domain_events WHERE conversation_id=v_conv)<>ARRAY[1,2,3,4]::bigint[]
     OR (SELECT last_sequence FROM conversations WHERE id=v_conv)<>4 THEN
    RAISE EXCEPTION 'history numbers or the counter are wrong';
  END IF;
  IF (SELECT row(active,role,conversation_id,native_session_id)::text FROM agent_sessions WHERE id=v_canonical)
     <>row(true,'chat',v_conv,'legacy-thread')::text THEN
    RAISE EXCEPTION 'the canonical session was not kept';
  END IF;
  IF (SELECT active OR native_session_id IS NOT NULL OR (metadata->>'merged_into')::uuid<>v_canonical FROM agent_sessions WHERE id=v_copy) THEN
    RAISE EXCEPTION 'the copied session was not merged into the canonical one';
  END IF;
  IF (backfill_conversations()->>'conversations')::int<>0 OR (backfill_conversations()->>'events_numbered')::int<>0 THEN
    RAISE EXCEPTION 'the backfill is not idempotent';
  END IF;

  -- The invariants the migration puts back must hold over what it produced.
  CREATE UNIQUE INDEX agent_sessions_one_active_per_conversation_role
    ON agent_sessions(conversation_id, role, agent_id) WHERE active AND conversation_id IS NOT NULL;
  CREATE UNIQUE INDEX agent_sessions_native_identity
    ON agent_sessions(session_namespace, native_session_id) WHERE native_session_id IS NOT NULL;
  ALTER TABLE domain_events ADD CONSTRAINT domain_events_task_event_in_conversation CHECK (task_id IS NULL OR conversation_id IS NOT NULL);
  ALTER TABLE tasks ALTER COLUMN conversation_id SET NOT NULL;
  ALTER TABLE agent_sessions ALTER COLUMN session_namespace SET NOT NULL;
  RAISE NOTICE 'legacy chains become conversations, history is numbered in its shown order, and a copied session is merged';
END $$;

ROLLBACK;
