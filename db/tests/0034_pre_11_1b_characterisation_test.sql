-- Characterisation tests: what this schema does **today**, before Stage 11.1b
-- changes it.
--
-- Every assertion here describes behaviour that is wrong, or at least not yet
-- right. They pass on HEAD, and that is the point: a test that only passes after
-- a fix proves the fix compiles, not that the defect was ever real. Each one
-- names the work package that will invert it, and the inversion is an edit to
-- this file rather than a deletion — a characterisation that is deleted instead
-- of inverted leaves nothing saying the behaviour changed.
--
-- Specification: STAGE_11_1B_PLAN.md §3 WP-2, row 2 of §4.
\set ON_ERROR_STOP on

BEGIN;
SET search_path TO control_plane,public,extensions;

-- inverted_by_wp3b: chat_claim_waits_for_a_held_workspace
--
-- Was characterises_chat_claim_ignores_an_active_implementation, and asserted
-- the opposite: that the claim below returned the chat job. Inverted by WP-3b
-- (migration 0060) rather than deleted — the fixture and the history stay, and
-- the assertion now says what the product does instead of what it used to.
--
-- The A1 race, in the one place that can be tested without two live runtimes.
-- `claim_orchestrator_jobs` excludes only *earlier chat and resume jobs on the same
-- task*; it asks nothing about an implementation that is in flight, and nothing
-- about the workspace lock. So the claim succeeds while another run holds the
-- lock with a fencing token — and it is that claim which leads the supervisor to
-- chown the workspace out from under a live OpenCode process.
--
-- On the host: `codex_chat_turn` job 14 opened at 11:44:50 while run fc7bbace
-- was live (11:12:04 - 11:49:04). That run ended `lost`.
DO $$
DECLARE
  v_user uuid; v_project uuid; v_codex_profile uuid; v_executor_profile uuid;
  v_codex uuid; v_executor uuid; v_orchestrator_assignment uuid; v_executor_assignment uuid;
  v_task uuid; v_run uuid; v_event domain_events; v_chat_event domain_events;
  v_claimed runtime_jobs; v_lock workspace_locks;
BEGIN
  INSERT INTO users(display_name) VALUES('A1 Race Characterisation') RETURNING id INTO v_user;
  INSERT INTO projects(owner_id,name,slug,workspace_path)
    VALUES(v_user,'A1 Race','a1-race','/srv/a1-race') RETURNING id INTO v_project;
  INSERT INTO runtime_profiles(runtime_type,adapter_version,runtime_version,provider_type,model)
    VALUES('codex','test','test','openai','codex-a1') RETURNING id INTO v_codex_profile;
  INSERT INTO runtime_profiles(runtime_type,adapter_version,runtime_version,provider_type,model)
    VALUES('opencode','test','test','opencode-free','opencode-a1') RETURNING id INTO v_executor_profile;
  INSERT INTO agents(name,role,runtime_profile_id)
    VALUES('a1-codex','architect',v_codex_profile) RETURNING id INTO v_codex;
  INSERT INTO agents(name,role,runtime_profile_id)
    VALUES('a1-executor','implementer',v_executor_profile) RETURNING id INTO v_executor;
  INSERT INTO project_agent_assignments(project_id,agent_id,runtime_profile_id,assignment_role,is_default)
    VALUES(v_project,v_codex,v_codex_profile,'orchestrator',true) RETURNING id INTO v_orchestrator_assignment;
  INSERT INTO project_agent_assignments(project_id,agent_id,runtime_profile_id,assignment_role)
    VALUES(v_project,v_executor,v_executor_profile,'executor') RETURNING id INTO v_executor_assignment;
  INSERT INTO tasks(project_id,title,objective,status,active_agent_id,orchestrator_assignment_id,created_by)
    VALUES(v_project,'Being implemented','Work in progress','implementing',
      v_codex,v_orchestrator_assignment,'test') RETURNING id INTO v_task;

  -- A live implementation run, holding the workspace lock with a fencing token.
  --
  -- Taken through acquire_workspace_lock, the way a real run takes it. The first
  -- version of this fixture UPDATEd workspace_locks directly: a new project has no
  -- lock row, so the update touched nothing, and its guard compared a NULL status
  -- with `<>` — NULL, which IF treats as false — so it passed without the lock
  -- ever being held. The characterisation then proved less than its name said,
  -- and WP-3b's fix was the first thing that noticed.
  INSERT INTO task_runs(task_id,agent_id,phase,status,write_capable)
    VALUES(v_task,v_executor,'implementation','starting',true) RETURNING id INTO v_run;
  PERFORM acquire_workspace_lock(v_project,v_run,'implementation',interval '30 minutes');
  UPDATE task_runs SET status='running' WHERE id=v_run;
  SELECT * INTO v_lock FROM workspace_locks WHERE project_id=v_project;
  IF v_lock.status IS DISTINCT FROM 'held' OR v_lock.owner_run_id IS DISTINCT FROM v_run THEN
    RAISE EXCEPTION 'fixture did not hold the workspace lock: %',v_lock;
  END IF;

  v_event:=append_event('implementation.requested',v_project,v_task,v_run,'system','a1-fixture',
    NULL,'a1-correlation','a1-implementation','task',v_task,1,'{}'::jsonb);
  INSERT INTO runtime_jobs(source_event_id,job_type,project_id,task_id,run_id,status,
    leased_by,leased_until)
    VALUES(v_event.id,'implementation_run',v_project,v_task,v_run,'in_flight',
      'a1-executor-worker',clock_timestamp()+interval '30 minutes');

  -- The operator types a message while that run is live. The message is
  -- accepted (see the next characterisation) and becomes a chat turn.
  v_chat_event:=append_event('chat.user_message',v_project,v_task,NULL,'user','operator',
    NULL,'a1-correlation','a1-chat','task',v_task,2,
    jsonb_build_object('content','Is this going anywhere?'));
  INSERT INTO runtime_jobs(source_event_id,job_type,project_id,task_id,status)
    VALUES(v_chat_event.id,'orchestrator_turn',v_project,v_task,'pending');

  SELECT * INTO v_claimed FROM claim_orchestrator_jobs('a1-codex-worker',1,interval '5 minutes');

  IF v_claimed.id IS NOT NULL THEN
    RAISE EXCEPTION
      'the chat claim took job % while run % holds the workspace — the A1 race is back',v_claimed.id,v_run;
  END IF;
  IF (SELECT status FROM runtime_jobs WHERE task_id=v_task AND job_type='orchestrator_turn')<>'pending' THEN
    RAISE EXCEPTION 'the waiting chat job is not pending';
  END IF;

  -- It waits; it is not lost. Once the writer releases the lock, the same job is
  -- claimed.
  PERFORM release_workspace_lock(v_project,v_run,v_lock.fencing_token);
  UPDATE task_runs SET status='completed',finished_at=clock_timestamp() WHERE id=v_run;
  -- And its job ends, as the executor's acknowledgement ends it. Since 0070 the
  -- chat job also waits for the conversation's live job (ingress order), which a
  -- run that finished and a job left in flight would never release.
  UPDATE runtime_jobs SET status='completed',completed_at=clock_timestamp(),leased_by=NULL,leased_until=NULL
  WHERE task_id=v_task AND job_type='implementation_run';
  SELECT * INTO v_claimed FROM claim_orchestrator_jobs('a1-codex-worker',1,interval '5 minutes');
  IF v_claimed.job_type IS DISTINCT FROM 'orchestrator_turn' OR v_claimed.task_id IS DISTINCT FROM v_task THEN
    RAISE EXCEPTION 'the chat job was not claimed after the writer released the workspace: %',v_claimed;
  END IF;

  RAISE NOTICE 'inverted_by_wp3b: a chat turn waits while a write-run holds the workspace, and is claimed after';
END;
$$;

-- characterises_chat_message_accepted_while_implementing
--
-- **Not inverted.** WP-3b keeps this behaviour deliberately: refusing the
-- operator's message is the wrong fix, and the message is queued rather than
-- rejected. The test is here because the behaviour is load-bearing from WP-3
-- onward, and something that is deliberately kept is worth pinning as firmly as
-- something that is about to change.
--
-- `record_task_chat_message` refuses only terminal statuses -- approved,
-- deployed, completed, cancelled, failed (0038:56). `implementing` and
-- `revising` are not among them, and 0054 says that is on purpose.
DO $$
DECLARE
  v_user uuid; v_project uuid; v_profile uuid; v_agent uuid; v_assignment uuid;
  v_task uuid; v_result jsonb;
BEGIN
  INSERT INTO users(display_name) VALUES('Chat While Implementing') RETURNING id INTO v_user;
  INSERT INTO projects(owner_id,name,slug,workspace_path)
    VALUES(v_user,'Chat While Implementing','chat-while-implementing','/srv/chat-while-implementing')
    RETURNING id INTO v_project;
  INSERT INTO runtime_profiles(runtime_type,adapter_version,runtime_version,provider_type,model)
    VALUES('codex','test','test','openai','codex-chat-guard') RETURNING id INTO v_profile;
  INSERT INTO agents(name,role,runtime_profile_id)
    VALUES('chat-guard-codex','architect',v_profile) RETURNING id INTO v_agent;
  INSERT INTO project_agent_assignments(project_id,agent_id,runtime_profile_id,assignment_role,is_default)
    VALUES(v_project,v_agent,v_profile,'orchestrator',true) RETURNING id INTO v_assignment;
  INSERT INTO tasks(project_id,title,objective,status,active_agent_id,orchestrator_assignment_id,created_by)
    VALUES(v_project,'Running task','Work in progress','implementing',v_agent,v_assignment,'test')
    RETURNING id INTO v_task;

  v_result:=record_task_chat_message(v_project,v_task,'Please also update the README','operator','chat-guard');
  IF v_result IS NULL THEN
    RAISE EXCEPTION
      'characterises_chat_message_accepted_while_implementing no longer holds: the '
      'message was refused. WP-3b queues the message; it does not reject it.';
  END IF;
  IF v_result->>'status'<>'implementing' THEN
    RAISE EXCEPTION 'the task did not stay in implementing: %',v_result;
  END IF;

  RAISE NOTICE 'characterises_chat_message_accepted_while_implementing: a message during an implementation run is accepted';
END;
$$;

-- inverted_by_wp4: a_task_has_at_most_one_followup
-- inverted_by_wp4: a_followup_resumes_the_session_it_does_not_copy
--
-- Were characterises_two_followups_from_one_task and
-- characterises_followup_session_copies_native_session_id, asserting the
-- opposite of both: two children of one task, and three rows carrying one native
-- session id. Inverted by WP-4 (migration 0063, ADR-0014), not deleted.
--
-- Both inverted by WP-4 (migration 0061): follow-up lineage becomes linear
-- through a unique index, and native session identity becomes unique on
-- (session_namespace, native_session_id) with a task-to-session link table
-- replacing the copied id.
--
-- Today `followup_of_task_id` carries no uniqueness, so one approved task can
-- have any number of children; and the continuity insert copies
-- `s.native_session_id` verbatim, so two rows claim the same native session.
-- Idempotency does not prevent either: a second call with a different
-- idempotency key is a different command.
DO $$
DECLARE
  v_user uuid; v_project uuid; v_codex_profile uuid; v_executor_profile uuid;
  v_codex uuid; v_executor uuid; v_orchestrator_assignment uuid; v_executor_assignment uuid;
  v_source uuid; v_first uuid:=gen_random_uuid(); v_second uuid:=gen_random_uuid();
  v_children bigint; v_sessions bigint; v_detail text;
BEGIN
  INSERT INTO users(display_name) VALUES('Follow-up Characterisation') RETURNING id INTO v_user;
  INSERT INTO projects(owner_id,name,slug,workspace_path)
    VALUES(v_user,'Follow-up Characterisation','followup-characterisation','/srv/followup-characterisation')
    RETURNING id INTO v_project;
  INSERT INTO runtime_profiles(runtime_type,adapter_version,runtime_version,provider_type,model)
    VALUES('codex','test','test','openai','codex-followup-char') RETURNING id INTO v_codex_profile;
  INSERT INTO runtime_profiles(runtime_type,adapter_version,runtime_version,provider_type,model)
    VALUES('opencode','test','test','opencode-free','opencode-followup-char') RETURNING id INTO v_executor_profile;
  INSERT INTO agents(name,role,runtime_profile_id)
    VALUES('followup-char-codex','architect',v_codex_profile) RETURNING id INTO v_codex;
  INSERT INTO agents(name,role,runtime_profile_id)
    VALUES('followup-char-executor','implementer',v_executor_profile) RETURNING id INTO v_executor;
  INSERT INTO project_agent_assignments(project_id,agent_id,runtime_profile_id,assignment_role,is_default)
    VALUES(v_project,v_codex,v_codex_profile,'orchestrator',true) RETURNING id INTO v_orchestrator_assignment;
  INSERT INTO project_agent_assignments(project_id,agent_id,runtime_profile_id,assignment_role)
    VALUES(v_project,v_executor,v_executor_profile,'executor') RETURNING id INTO v_executor_assignment;
  INSERT INTO tasks(project_id,title,objective,constraints,acceptance_criteria,status,
    active_agent_id,orchestrator_assignment_id,created_by)
    VALUES(v_project,'Approved source','Original work','["stay scoped"]','["quality accepted"]',
      'approved',v_codex,v_orchestrator_assignment,'test') RETURNING id INTO v_source;
  INSERT INTO task_executor_assignments(task_id,project_agent_assignment_id,priority)
    VALUES(v_source,v_executor_assignment,100);
  INSERT INTO agent_sessions(project_id,agent_id,runtime_profile_id,native_session_id,purpose,metadata)
    VALUES(v_project,v_codex,v_codex_profile,'codex-native-char','task_chat:'||v_source::text,
      jsonb_build_object('task_id',v_source));

  PERFORM create_followup_task(v_project,v_source,v_first,'operator','First follow-up',
    'Apply the first correction','followup-char-1',1,'followup-char-1');
  -- A different idempotency key, and the source task is untouched by the first
  -- call, so the expected version is still 1 — which is exactly the second
  -- follow-up that used to fork the conversation.
  BEGIN
    PERFORM create_followup_task(v_project,v_source,v_second,'operator','Second follow-up',
      'Apply the second correction','followup-char-2',1,'followup-char-2');
    RAISE EXCEPTION 'a second follow-up of one task was accepted — the conversation forked';
  EXCEPTION WHEN SQLSTATE '55000' THEN
    GET STACKED DIAGNOSTICS v_detail = PG_EXCEPTION_DETAIL;
    IF v_detail IS DISTINCT FROM 'followup_exists' THEN RAISE; END IF;
  END;
  SELECT count(*) INTO v_children FROM tasks WHERE followup_of_task_id=v_source;
  IF v_children<>1 THEN
    RAISE EXCEPTION 'one task has % follow-ups; a conversation is a line',v_children;
  END IF;

  SELECT count(*) INTO v_sessions FROM agent_sessions
    WHERE project_id=v_project AND native_session_id='codex-native-char';
  IF v_sessions<>1 THEN
    RAISE EXCEPTION
      '% rows carry one native session id; a follow-up resumes the session, it does not copy it',v_sessions;
  END IF;

  RAISE NOTICE 'inverted_by_wp4: a task has one follow-up, and one row carries its native session';
END;
$$;

-- inverted_by_wp7: an_approval_names_the_evidence_it_approved
--
-- Was characterises_approval_records_no_evidence_digest, and asserted the
-- opposite: that no key of the approval's event or audit row could name what
-- was approved. Inverted by WP-7 (migration 0069, ADR-0015) rather than deleted.
-- (This comment used to say "migration 0064"; the plan's numbering moved twice
-- before WP-7 was written, and 0069 is the number it shipped under.)
--
-- Before: `approve_task_review` recorded a summary and the reviewer's agent id
-- and nothing about *what* was approved — no base or head commit, no worktree
-- digest, no patch digest — which is how §3.5 produced an approval of a file that
-- does not parse, said to pass tests, twice.
--
-- Now: an approval without evidence is refused with `review_evidence_missing`,
-- and with evidence the event, the audit row and a verdict row all carry the
-- evidence digest. The same shape-matched key search is kept, so the inversion
-- is of the very assertion that used to pass.
DO $$
DECLARE
  v_user uuid; v_project uuid; v_profile uuid; v_agent uuid; v_assignment uuid;
  v_task uuid; v_run uuid; v_digest text; v_result jsonb; v_payload jsonb; v_audit jsonb; v_keys text;
  v_detail text;
BEGIN
  INSERT INTO users(display_name) VALUES('Approval Characterisation') RETURNING id INTO v_user;
  INSERT INTO projects(owner_id,name,slug,workspace_path)
    VALUES(v_user,'Approval Characterisation','approval-characterisation','/srv/approval-characterisation')
    RETURNING id INTO v_project;
  INSERT INTO runtime_profiles(runtime_type,adapter_version,runtime_version,provider_type,model)
    VALUES('codex','test','test','openai','codex-approval-char') RETURNING id INTO v_profile;
  INSERT INTO agents(name,role,runtime_profile_id)
    VALUES('approval-char-codex','architect',v_profile) RETURNING id INTO v_agent;
  INSERT INTO project_agent_assignments(project_id,agent_id,runtime_profile_id,assignment_role,is_default)
    VALUES(v_project,v_agent,v_profile,'orchestrator',true) RETURNING id INTO v_assignment;
  INSERT INTO tasks(project_id,title,objective,status,active_agent_id,orchestrator_assignment_id,created_by)
    VALUES(v_project,'Reviewed task','Work to approve','awaiting_review',v_agent,v_assignment,'test')
    RETURNING id INTO v_task;

  -- Nothing to approve: refused, by reason.
  BEGIN
    PERFORM approve_task_review(v_project,v_task,'operator','Looks correct to me',
      'approval-char-none',1,'approval-char-correlation');
    RAISE EXCEPTION 'inverted_by_wp7 no longer holds: an approval with no evidence was accepted';
  EXCEPTION WHEN SQLSTATE '55000' THEN
    GET STACKED DIAGNOSTICS v_detail = PG_EXCEPTION_DETAIL;
    IF v_detail IS NULL OR v_detail::jsonb->>'reason' <> 'review_evidence_missing' THEN
      RAISE EXCEPTION 'an approval without evidence was refused without its reason: %', v_detail;
    END IF;
  END;

  -- The implementation it reviews, and that implementation's evidence.
  INSERT INTO task_runs(task_id,agent_id,phase,status,write_capable,workspace_fencing_token,finished_at)
    VALUES(v_task,v_agent,'implementation','completed',true,1,clock_timestamp()) RETURNING id INTO v_run;
  v_digest:=review_evidence_digest(v_run,1,repeat('a',40),repeat('b',40),
    'sha256:'||repeat('c',64),'sha256:'||repeat('d',64));
  INSERT INTO review_evidence(project_id,task_id,run_id,fencing_token,base_commit_sha,head_commit_sha,
    worktree_digest,patch_digest,evidence_digest,algorithm,object_format,worktree_committed,changed_files,
    diffstat,diff,truncation,executor_reported_checks,platform_verified_checks,recorded_by)
  VALUES(v_project,v_task,v_run,1,repeat('a',40),repeat('b',40),'sha256:'||repeat('c',64),
    'sha256:'||repeat('d',64),v_digest,'{"worktree":"infra-cod-worktree-v1","patch":"infra-cod-patch-v1"}',
    'sha1',true,'[]','{}','','{}','{"tests":"passed"}','[]','approval-char-fixture');

  v_result:=approve_task_review(v_project,v_task,'operator','Looks correct to me',
    'approval-char',1,'approval-char-correlation');
  IF v_result->>'status'<>'approved' THEN
    RAISE EXCEPTION 'the fixture did not approve: %',v_result;
  END IF;

  SELECT payload INTO v_payload FROM domain_events WHERE id=(v_result->>'event_id')::uuid;
  SELECT details INTO v_audit FROM audit_events
    WHERE project_id=v_project AND task_id=v_task AND action='task.review_approved';

  -- Any key that could name what was approved. Matched by shape rather than by a
  -- fixed list, as before.
  SELECT string_agg(k,',') INTO v_keys FROM (
    SELECT jsonb_object_keys(v_payload) AS k
    UNION ALL
    SELECT jsonb_object_keys(v_audit)
  ) all_keys
  WHERE k ~* '(digest|sha|commit|worktree|patch|evidence|diff)';

  IF v_keys IS NULL THEN
    RAISE EXCEPTION 'inverted_by_wp7 no longer holds: the approval names nothing it approved';
  END IF;
  IF v_payload->>'evidence_digest' IS DISTINCT FROM v_digest OR v_audit->>'evidence_digest' IS DISTINCT FROM v_digest
     OR v_result->>'evidence_digest' IS DISTINCT FROM v_digest THEN
    RAISE EXCEPTION 'the approval names a digest other than its evidence''s: % / % / %',
      v_payload->>'evidence_digest', v_audit->>'evidence_digest', v_result->>'evidence_digest';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM review_verdicts v WHERE v.task_id=v_task AND v.verdict='approved'
                 AND v.evidence_digest=v_digest) THEN
    RAISE EXCEPTION 'the approval left no verdict referencing its evidence digest';
  END IF;

  RAISE NOTICE 'inverted_by_wp7: an approval is refused without evidence, and names its evidence digest (%) with it', v_keys;
END;
$$;

ROLLBACK;
