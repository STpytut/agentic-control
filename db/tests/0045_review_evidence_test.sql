-- Review evidence, the verdict and the publish boundary (migration 0069, WP-7).
--
-- The three deterministic conditions of plan §3 WP-7, each through the functions
-- the services call, in the order a task meets them:
--
--   1. evidence is delivered to the review turn, with the digests present;
--   2. the verdict references the evidence digest — Codex's revision request
--      and the operator's approval alike;
--   3. `prepare_publish` refuses a mismatched digest, with a reason from the
--      vocabulary, and the refusal is then recorded on the preparation.
--
-- And around them: the evidence is taken under the run's fencing token and
-- relative to the base recorded before the executor started; a completion
-- whose base was recorded cannot finalize without it; nothing recorded can be
-- changed; the executor's claims and the platform's checks stay two fields.
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

-- What the supervisor would send for a tree, varied by one field at a time.
CREATE FUNCTION pg_temp.evidence(p_base text, p_head text, p_worktree text, p_patch text,
  p_committed boolean DEFAULT true) RETURNS jsonb LANGUAGE sql AS $$
  SELECT jsonb_build_object(
    'algorithm', '{"worktree":"infra-cod-worktree-v1","patch":"infra-cod-patch-v1"}'::jsonb,
    'object_format', 'sha1',
    'base_commit_sha', p_base, 'head_commit_sha', p_head,
    'worktree_digest', p_worktree, 'patch_digest', p_patch,
    'worktree_committed', p_committed,
    'changed_files', '[{"path":"broken.py","status":"A","added":1,"deleted":0,"binary":false}]'::jsonb,
    'diffstat', '{"files_changed":1,"insertions":1,"deletions":0,"binary_files":0}'::jsonb,
    'diff', E'diff --git a/broken.py b/broken.py\n+def broken(:\n',
    'truncation', '{"patch_bytes":40,"diff_bytes":40,"diff_truncated":false,"files_total":1,"files_listed":1,"files_truncated":false}'::jsonb,
    'platform_verified_checks', jsonb_build_array(
      jsonb_build_object('name','patch_reproduces_worktree','status','passed','detail','x'),
      jsonb_build_object('name','worktree_committed','status',CASE WHEN p_committed THEN 'passed' ELSE 'failed' END,'detail','x')));
$$;

DO $$
DECLARE
  v_user uuid; v_project uuid; v_codex_profile uuid; v_executor_profile uuid;
  v_codex uuid; v_worker uuid; v_orchestrator uuid; v_executor_assignment uuid;
  v_session uuid; v_task uuid; v_request jsonb; v_message outbox_messages; v_job runtime_jobs;
  v_start jsonb; v_run uuid; v_token bigint; v_report jsonb; v_recorded jsonb; v_final jsonb;
  v_route jsonb; v_review runtime_jobs; v_delivered jsonb; v_revision jsonb; v_verdict review_verdicts;
  v_evidence1 text; v_evidence2 text; v_approval jsonb; v_claim jsonb; v_prepared jsonb; v_reason text;
  v_base text := repeat('a',40); v_head1 text := repeat('b',40); v_head2 text := repeat('e',40);
  v_tree1 text := 'sha256:'||repeat('1',64); v_patch1 text := 'sha256:'||repeat('2',64);
  v_tree2 text := 'sha256:'||repeat('3',64); v_patch2 text := 'sha256:'||repeat('4',64);
  v_field text; v_observed jsonb; v_row publish_preparations; v_count integer;
BEGIN
  INSERT INTO users(display_name) VALUES('Review evidence') RETURNING id INTO v_user;
  INSERT INTO projects(owner_id,name,slug,workspace_path)
    VALUES(v_user,'Review evidence','review-evidence','/srv/infra-cod/workspaces/review-evidence') RETURNING id INTO v_project;
  INSERT INTO workspace_locks(project_id) VALUES(v_project) ON CONFLICT DO NOTHING;
  INSERT INTO runtime_profiles(runtime_type,adapter_version,runtime_version,provider_type,model)
    VALUES('codex','test','test','openai','codex-evidence') RETURNING id INTO v_codex_profile;
  INSERT INTO runtime_profiles(runtime_type,adapter_version,runtime_version,provider_type,model)
    VALUES('opencode','test','test','opencode-free','opencode-evidence') RETURNING id INTO v_executor_profile;
  INSERT INTO agents(name,role,runtime_profile_id) VALUES('evidence-codex','architect',v_codex_profile) RETURNING id INTO v_codex;
  INSERT INTO agents(name,role,runtime_profile_id) VALUES('evidence-worker','implementer',v_executor_profile) RETURNING id INTO v_worker;
  INSERT INTO project_agent_assignments(project_id,agent_id,runtime_profile_id,assignment_role,is_default)
    VALUES(v_project,v_codex,v_codex_profile,'orchestrator',true) RETURNING id INTO v_orchestrator;
  INSERT INTO project_agent_assignments(project_id,agent_id,runtime_profile_id,assignment_role)
    VALUES(v_project,v_worker,v_executor_profile,'executor') RETURNING id INTO v_executor_assignment;
  INSERT INTO agent_sessions(project_id,agent_id,runtime_profile_id,purpose,native_session_id)
    VALUES(v_project,v_worker,v_executor_profile,'implementation','ses_evidence') RETURNING id INTO v_session;
  INSERT INTO tasks(project_id,title,objective,status,active_agent_id,orchestrator_assignment_id,created_by,acceptance_criteria)
    VALUES(v_project,'Review evidence','test','ready',v_codex,v_orchestrator,'test','["done"]') RETURNING id INTO v_task;
  INSERT INTO task_executor_assignments(task_id,project_agent_assignment_id,priority) VALUES(v_task,v_executor_assignment,10);

  -- ------------------------------------------------ revision 1: the evidence
  v_request:=request_implementation(v_project,v_task,v_codex,v_worker,1,'Implement','[]','[]','["done"]','[]',
    '/srv/infra-cod/workspaces/review-evidence','delegate:'||v_task,1,v_task::text);
  UPDATE handoffs SET executor_assignment_id=v_executor_assignment WHERE id=(v_request->>'handoff_id')::uuid;
  v_message:=claim_outbox_event((v_request->>'event_id')::uuid,'evidence-dispatcher',interval '1 minute');
  PERFORM route_outbox_message(v_message.id,'evidence-dispatcher');
  v_job:=claim_runtime_job_for_event((v_request->>'event_id')::uuid,'implementation_run','evidence-supervisor',interval '5 minutes');
  v_start:=start_implementation_job(v_job.id,v_session,'evidence-supervisor',interval '5 minutes');
  v_run:=(v_start->>'run_id')::uuid; v_token:=(v_start->>'fencing_token')::bigint;

  -- The base is taken under the fence, before the executor is spawned.
  IF pg_temp.reason_of(format($q$ SELECT record_review_base(%s,%L,%L,%s,%L) $q$,
      v_job.id,'evidence-supervisor',v_run,v_token+1,v_base)) IS DISTINCT FROM 'workspace_fencing_token_stale' THEN
    RAISE EXCEPTION 'a base recorded under a stale token was accepted';
  END IF;
  IF pg_temp.reason_of(format($q$ SELECT record_review_base(%s,%L,%L,%s,%L) $q$,
      v_job.id,'somebody-else',v_run,v_token,v_base)) IS DISTINCT FROM 'job_lease_held_by_another' THEN
    RAISE EXCEPTION 'a base recorded by another supervisor was accepted';
  END IF;
  PERFORM record_review_base(v_job.id,'evidence-supervisor',v_run,v_token,v_base);

  v_report:=submit_worker_completion(v_project,v_task,v_run,v_worker,v_token,'ses_evidence',
    '{"summary":"done"}'::jsonb,'{"tests":"all pass"}'::jsonb,NULL,'evidence-complete-1');

  -- A run whose base was recorded cannot complete without its evidence.
  IF pg_temp.reason_of(format($q$ SELECT finalize_worker_completion(%L,%s,%L) $q$,
      v_report->>'report_id',v_job.id,'evidence-supervisor')) IS DISTINCT FROM 'review_evidence_missing' THEN
    RAISE EXCEPTION 'a completion finalized without the evidence its base promised';
  END IF;
  -- The base is not the reporter's to choose, and the four digests are all
  -- required: a head SHA is not an answer for a dirty tree.
  IF pg_temp.reason_of(format($q$ SELECT record_review_evidence(%s,%L,%L,%s,%L::jsonb) $q$,
      v_job.id,'evidence-supervisor',v_run,v_token,pg_temp.evidence(repeat('f',40),v_head1,v_tree1,v_patch1))) IS DISTINCT FROM 'review_evidence_base_mismatch' THEN
    RAISE EXCEPTION 'evidence relative to another base was accepted';
  END IF;
  FOREACH v_field IN ARRAY ARRAY['base_commit_sha','head_commit_sha','worktree_digest','patch_digest'] LOOP
    IF pg_temp.reason_of(format($q$ SELECT record_review_evidence(%s,%L,%L,%s,%L::jsonb) $q$,
        v_job.id,'evidence-supervisor',v_run,v_token,pg_temp.evidence(v_base,v_head1,v_tree1,v_patch1)-v_field)) IS DISTINCT FROM 'review_evidence_invalid' THEN
      RAISE EXCEPTION 'evidence without % was accepted', v_field;
    END IF;
  END LOOP;
  IF pg_temp.reason_of(format($q$ SELECT record_review_evidence(%s,%L,%L,%s,%L::jsonb) $q$,
      v_job.id,'evidence-supervisor',v_run,v_token+1,pg_temp.evidence(v_base,v_head1,v_tree1,v_patch1))) IS DISTINCT FROM 'workspace_fencing_token_stale' THEN
    RAISE EXCEPTION 'evidence under a stale fencing token was accepted';
  END IF;

  v_recorded:=record_review_evidence(v_job.id,'evidence-supervisor',v_run,v_token,
    pg_temp.evidence(v_base,v_head1,v_tree1,v_patch1));
  v_evidence1:=v_recorded->>'evidence_digest';
  IF v_evidence1 IS DISTINCT FROM review_evidence_digest(v_run,v_token,v_base,v_head1,v_tree1,v_patch1) THEN
    RAISE EXCEPTION 'the evidence digest is not the one the algorithm defines: %', v_recorded;
  END IF;
  -- The same evidence again is a repeat; different evidence for the run is a conflict.
  IF (record_review_evidence(v_job.id,'evidence-supervisor',v_run,v_token,
      pg_temp.evidence(v_base,v_head1,v_tree1,v_patch1))->>'repeat')::boolean IS NOT TRUE THEN
    RAISE EXCEPTION 'recording the same evidence twice was not a repeat';
  END IF;
  IF pg_temp.reason_of(format($q$ SELECT record_review_evidence(%s,%L,%L,%s,%L::jsonb) $q$,
      v_job.id,'evidence-supervisor',v_run,v_token,pg_temp.evidence(v_base,v_head1,v_tree2,v_patch1))) IS DISTINCT FROM 'review_evidence_conflict' THEN
    RAISE EXCEPTION 'a second, different evidence for one run was accepted';
  END IF;
  -- Two fields, and the executor's one is its own report, not what the recorder said.
  IF (SELECT executor_reported_checks FROM review_evidence WHERE run_id=v_run) IS DISTINCT FROM '{"tests":"all pass"}'::jsonb
     OR jsonb_array_length((SELECT platform_verified_checks FROM review_evidence WHERE run_id=v_run)) <> 2 THEN
    RAISE EXCEPTION 'executor-reported and platform-verified checks are not kept apart';
  END IF;
  -- Immutable.
  IF pg_temp.reason_of(format($q$ UPDATE review_evidence SET head_commit_sha=%L WHERE run_id=%L $q$, v_head2, v_run)) IS DISTINCT FROM 'review_evidence_immutable' THEN
    RAISE EXCEPTION 'recorded evidence could be changed';
  END IF;
  IF pg_temp.reason_of(format($q$ DELETE FROM review_evidence WHERE run_id=%L $q$, v_run)) IS DISTINCT FROM 'review_evidence_immutable' THEN
    RAISE EXCEPTION 'recorded evidence could be deleted';
  END IF;

  v_final:=finalize_worker_completion((v_report->>'report_id')::uuid,v_job.id,'evidence-supervisor');
  PERFORM acknowledge_runtime_job(v_job.id,'evidence-supervisor',v_final);
  -- Once the run has completed, nothing can add evidence to it.
  v_reason:=pg_temp.reason_of(format($q$ SELECT record_review_evidence(%s,%L,%L,%s,%L::jsonb) $q$,
      v_job.id,'evidence-supervisor',v_run,v_token,pg_temp.evidence(v_base,v_head1,v_tree2,v_patch2)));
  IF v_reason IS NULL OR v_reason NOT IN ('job_not_in_flight','run_not_running','workspace_lock_not_held') THEN
    RAISE EXCEPTION 'evidence was added to a completed run';
  END IF;

  -- ------------------------- condition 1: delivered to the review turn
  v_message:=claim_outbox_event((v_final->>'event_id')::uuid,'evidence-dispatcher',interval '1 minute');
  v_route:=route_outbox_message(v_message.id,'evidence-dispatcher');
  SELECT * INTO v_review FROM claim_orchestrator_jobs('evidence-codex-worker',1,interval '2 minutes');
  IF v_review.job_type IS DISTINCT FROM 'resume_orchestrator' THEN RAISE EXCEPTION 'fixture: no review turn claimed'; END IF;
  IF pg_temp.reason_of(format($q$ SELECT deliver_review_evidence(%s,%L) $q$, v_review.id, 'somebody-else')) IS DISTINCT FROM 'job_lease_held_by_another' THEN
    RAISE EXCEPTION 'evidence was delivered to a worker that does not hold the turn';
  END IF;
  -- The review turn's own words no longer call the workspace read-only.
  IF orchestrator_job_context(v_review.id,'evidence-codex-worker')->>'content' ILIKE '%in the read-only workspace%'
     OR orchestrator_job_context(v_review.id,'evidence-codex-worker')->>'content' NOT LIKE '%The workspace is not read-only%' THEN
    RAISE EXCEPTION 'the review turn is still told its workspace is read-only';
  END IF;
  v_delivered:=deliver_review_evidence(v_review.id,'evidence-codex-worker');
  IF v_delivered->>'evidence_digest' IS DISTINCT FROM v_evidence1
     OR v_delivered->>'base_commit_sha' IS DISTINCT FROM v_base
     OR v_delivered->>'head_commit_sha' IS DISTINCT FROM v_head1
     OR v_delivered->>'worktree_digest' IS DISTINCT FROM v_tree1
     OR v_delivered->>'patch_digest' IS DISTINCT FROM v_patch1
     OR v_delivered->'executor_reported_checks' IS NULL OR v_delivered->'platform_verified_checks' IS NULL THEN
    RAISE EXCEPTION 'condition 1: the review turn was not given the evidence with its digests: %', v_delivered;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM review_evidence_deliveries d
                 WHERE d.turn_run_id=v_review.run_id AND d.evidence_digest=v_evidence1) THEN
    RAISE EXCEPTION 'condition 1: the delivery to the turn was not recorded';
  END IF;

  -- ------------------------- condition 2a: Codex's verdict names the digest
  v_revision:=invoke_request_revision(v_review.id,'evidence-codex-worker','call-evidence-1',
    '["broken.py does not parse"]');
  IF v_revision->>'evidence_digest' IS DISTINCT FROM v_evidence1 THEN
    RAISE EXCEPTION 'condition 2: the revision request does not name the evidence digest: %', v_revision;
  END IF;
  SELECT * INTO v_verdict FROM review_verdicts WHERE task_id=v_task AND verdict='changes_requested';
  IF v_verdict.evidence_digest IS DISTINCT FROM v_evidence1 OR v_verdict.turn_run_id IS DISTINCT FROM v_review.run_id
     OR v_verdict.actor_type<>'agent' THEN
    RAISE EXCEPTION 'condition 2: the revision verdict does not reference the delivered evidence: %', v_verdict;
  END IF;
  PERFORM complete_orchestrator_job(v_review.id,'evidence-codex-worker','thread-evidence','turn-1','Revision requested.');

  -- ------------------------------------------------ revision 2
  v_message:=claim_outbox_event((v_revision#>>'{delegation,event_id}')::uuid,'evidence-dispatcher',interval '1 minute');
  PERFORM route_outbox_message(v_message.id,'evidence-dispatcher');
  SELECT * INTO v_job FROM claim_executor_jobs('evidence-supervisor',1,interval '5 minutes');
  IF v_job.id IS NULL THEN RAISE EXCEPTION 'fixture: the revision''s implementation job was not claimable'; END IF;
  v_start:=start_implementation_job(v_job.id,v_session,'evidence-supervisor',interval '5 minutes');
  v_run:=(v_start->>'run_id')::uuid; v_token:=(v_start->>'fencing_token')::bigint;
  -- The second run starts from the first one's commit; the task's base does not move.
  IF (record_review_base(v_job.id,'evidence-supervisor',v_run,v_token,v_head1)->>'base_commit_sha') <> v_base THEN
    RAISE EXCEPTION 'a revision moved the task''s review base';
  END IF;
  v_report:=submit_worker_completion(v_project,v_task,v_run,v_worker,v_token,'ses_evidence',
    '{"summary":"fixed"}'::jsonb,'{"tests":"all pass"}'::jsonb,NULL,'evidence-complete-2');
  v_recorded:=record_review_evidence(v_job.id,'evidence-supervisor',v_run,v_token,
    pg_temp.evidence(v_base,v_head2,v_tree2,v_patch2));
  v_evidence2:=v_recorded->>'evidence_digest';
  v_final:=finalize_worker_completion((v_report->>'report_id')::uuid,v_job.id,'evidence-supervisor');
  PERFORM acknowledge_runtime_job(v_job.id,'evidence-supervisor',v_final);
  v_message:=claim_outbox_event((v_final->>'event_id')::uuid,'evidence-dispatcher',interval '1 minute');
  PERFORM route_outbox_message(v_message.id,'evidence-dispatcher');
  SELECT * INTO v_review FROM claim_orchestrator_jobs('evidence-codex-worker',1,interval '2 minutes');
  IF deliver_review_evidence(v_review.id,'evidence-codex-worker')->>'evidence_digest' IS DISTINCT FROM v_evidence2 THEN
    RAISE EXCEPTION 'condition 1: the second review turn was not given the second evidence';
  END IF;
  PERFORM complete_orchestrator_job(v_review.id,'evidence-codex-worker','thread-evidence','turn-2','Ready for approval.');

  -- ------------------------- condition 2b: the operator's approval names it
  v_approval:=approve_task_review(v_project,v_task,'operator','Approved after the fix',
    'evidence-approve',(SELECT version FROM tasks WHERE id=v_task),v_task::text);
  IF v_approval->>'evidence_digest' IS DISTINCT FROM v_evidence2 THEN
    RAISE EXCEPTION 'condition 2: the approval names %, not the current evidence %', v_approval->>'evidence_digest', v_evidence2;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM review_verdicts v WHERE v.task_id=v_task AND v.verdict='approved'
                 AND v.evidence_digest=v_evidence2 AND v.actor_type='user') THEN
    RAISE EXCEPTION 'condition 2: no approved verdict references the evidence digest';
  END IF;
  -- The foreign key is what makes that reference honest: a verdict cannot carry
  -- a digest its evidence does not have.
  BEGIN
    INSERT INTO review_verdicts(project_id,task_id,evidence_id,evidence_digest,verdict,actor_type,actor_id,task_version)
    SELECT v_project,v_task,e.id,v_evidence1,'approved','user','forger',1 FROM review_evidence e WHERE e.evidence_digest=v_evidence2;
    RAISE EXCEPTION 'a verdict naming a digest its evidence does not have was stored';
  EXCEPTION WHEN foreign_key_violation THEN NULL;
  END;

  -- ------------------------- condition 3: prepare_publish refuses a move
  -- The approval asked for its own preparation.
  v_claim:=claim_publish_preparation('evidence-supervisor',interval '2 minutes');
  IF v_claim->>'evidence_digest' IS DISTINCT FROM v_evidence2 OR v_claim->>'base_commit_sha' IS DISTINCT FROM v_base
     OR (v_claim->>'id')::uuid IS DISTINCT FROM (v_approval->>'publish_preparation_id')::uuid THEN
    RAISE EXCEPTION 'the approval''s publish preparation was not claimable with its expectation: %', v_claim;
  END IF;
  -- Each of the four digests, moved on its own, is refused by the same reason.
  FOREACH v_field IN ARRAY ARRAY['base_commit_sha','head_commit_sha','worktree_digest','patch_digest'] LOOP
    v_observed:=jsonb_build_object('base_commit_sha',v_base,'head_commit_sha',v_head2,
      'worktree_digest',v_tree2,'patch_digest',v_patch2)
      || jsonb_build_object(v_field, CASE WHEN v_field LIKE '%sha' THEN repeat('9',40) ELSE 'sha256:'||repeat('9',64) END);
    v_reason:=pg_temp.reason_of(format($q$ SELECT prepare_publish(%L,%L,%L::jsonb) $q$,
      v_claim->>'id','evidence-supervisor',v_observed));
    IF v_reason IS DISTINCT FROM 'review_evidence_digest_moved' THEN
      RAISE EXCEPTION 'condition 3: a moved % was answered with %, not review_evidence_digest_moved', v_field, v_reason;
    END IF;
  END LOOP;
  IF pg_temp.reason_of(format($q$ SELECT prepare_publish(%L,%L,%L::jsonb) $q$,
      v_claim->>'id','evidence-supervisor','{"head_commit_sha":"x"}')) IS DISTINCT FROM 'publish_observation_invalid' THEN
    RAISE EXCEPTION 'a malformed observation was not refused as such';
  END IF;
  IF pg_temp.reason_of(format($q$ SELECT prepare_publish(%L,%L,%L::jsonb) $q$,
      v_claim->>'id','somebody-else',jsonb_build_object('base_commit_sha',v_base,'head_commit_sha',v_head2,
        'worktree_digest',v_tree2,'patch_digest',v_patch2))) IS DISTINCT FROM 'publish_preparation_not_claimed' THEN
    RAISE EXCEPTION 'another worker prepared a preparation it had not claimed';
  END IF;
  -- The refusal is an exception, so nothing it wrote survives; the supervisor
  -- records it in a second call, and the reason is a key into the vocabulary.
  PERFORM record_publish_refusal((v_claim->>'id')::uuid,'evidence-supervisor','review_evidence_digest_moved',
    'the workspace has moved since evidence was approved: worktree_digest differ');
  SELECT * INTO v_row FROM publish_preparations WHERE id=(v_claim->>'id')::uuid;
  IF v_row.status<>'refused' OR v_row.refusal_reason<>'review_evidence_digest_moved' THEN
    RAISE EXCEPTION 'the refusal was not recorded on the preparation: %', v_row;
  END IF;
  IF pg_temp.reason_of(format($q$ UPDATE publish_preparations SET status='requested' WHERE id=%L $q$, v_row.id)) IS DISTINCT FROM 'review_evidence_immutable' THEN
    RAISE EXCEPTION 'a finished preparation could be reopened';
  END IF;

  -- Asked again, with the tree as it was approved: prepared, naming the commit to push.
  PERFORM request_publish_preparation(v_project,v_task,'operator','before-push-1',v_task::text);
  v_claim:=claim_publish_preparation('evidence-supervisor',interval '2 minutes');
  -- 0150: the claim names the approved commit; a workspace that moved on past
  -- it is prepared from it only when it still holds it and the base is the same.
  IF v_claim->>'head_commit_sha' IS DISTINCT FROM v_head2 THEN RAISE EXCEPTION 'the claim does not name the approved commit: %', v_claim; END IF;
  v_observed:=jsonb_build_object('base_commit_sha',v_base,'head_commit_sha',repeat('7',40),
    'worktree_digest','sha256:'||repeat('7',64),'patch_digest','sha256:'||repeat('7',64),'approved_commit_sha',v_head2);
  IF pg_temp.reason_of(format($q$ SELECT prepare_publish(%L,%L,%L::jsonb) $q$, v_claim->>'id','evidence-supervisor',
      v_observed || '{"approved_commit_present":false}')) IS DISTINCT FROM 'review_evidence_digest_moved' THEN
    RAISE EXCEPTION 'a workspace without the approved commit was prepared';
  END IF;
  IF pg_temp.reason_of(format($q$ SELECT prepare_publish(%L,%L,%L::jsonb) $q$, v_claim->>'id','evidence-supervisor',
      v_observed || jsonb_build_object('approved_commit_present',true,'base_commit_sha',repeat('6',40)))) IS DISTINCT FROM 'review_evidence_digest_moved' THEN
    RAISE EXCEPTION 'a moved base was prepared';
  END IF;
  v_prepared:=prepare_publish((v_claim->>'id')::uuid,'evidence-supervisor', v_observed || '{"approved_commit_present":true}');
  IF v_prepared->>'status'<>'prepared' OR v_prepared->>'head_commit_sha'<>v_head2
     OR v_prepared->>'evidence_digest'<>v_evidence2 THEN
    RAISE EXCEPTION 'the approved tree was not prepared: %', v_prepared;
  END IF;
  SELECT count(*) INTO v_count FROM domain_events WHERE task_id=v_task AND event_type IN ('publish.prepared','publish.refused');
  IF v_count<>2 THEN RAISE EXCEPTION 'the preparation and the refusal are not both events: %', v_count; END IF;

  -- The mutation check, kept in the gate rather than run once by hand: with the
  -- comparison switched off, the same moved digest is prepared — so the
  -- condition-3 assertions above fail without it, and are not passing for some
  -- other reason. The redefinition is rolled back with the rest of this file.
  EXECUTE replace(pg_get_functiondef('prepare_publish(uuid,text,jsonb)'::regprocedure),
    'IF cardinality(v_moved) > 0 THEN', 'IF false AND cardinality(v_moved) > 0 THEN');
  IF position('IF false AND cardinality' IN pg_get_functiondef('prepare_publish(uuid,text,jsonb)'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'mutation: the comparison in prepare_publish was not found to switch off';
  END IF;
  PERFORM request_publish_preparation(v_project,v_task,'operator','mutation-probe',v_task::text);
  v_claim:=claim_publish_preparation('evidence-supervisor',interval '2 minutes');
  v_reason:=pg_temp.reason_of(format($q$ SELECT prepare_publish(%L,%L,%L::jsonb) $q$,
    v_claim->>'id','evidence-supervisor',jsonb_build_object('base_commit_sha',v_base,'head_commit_sha',v_head2,
      'worktree_digest','sha256:'||repeat('9',64),'patch_digest',v_patch2)));
  IF v_reason IS NOT NULL THEN
    RAISE EXCEPTION 'mutation: with the comparison off, a moved digest was still refused (%) — condition 3 is held by something else', v_reason;
  END IF;

  RAISE NOTICE 'evidence delivered to the review turn; both verdicts name its digest; prepare_publish refuses each moved digest by reason, records the refusal, and prepares the approved tree';
END $$;

-- An approved tree that is not committed cannot be published by pushing a
-- commit; a legacy run with no recorded base still finalizes, and its approval
-- is refused.
DO $$
DECLARE
  v_user uuid; v_project uuid; v_codex_profile uuid; v_executor_profile uuid; v_codex uuid; v_worker uuid;
  v_orchestrator uuid; v_session uuid; v_task uuid; v_request jsonb; v_message outbox_messages; v_job runtime_jobs;
  v_start jsonb; v_run uuid; v_token bigint; v_report jsonb; v_final jsonb; v_claim jsonb; v_reason text;
  v_base text := repeat('a',40); v_head text := repeat('b',40);
BEGIN
  INSERT INTO users(display_name) VALUES('Review evidence, uncommitted') RETURNING id INTO v_user;
  INSERT INTO projects(owner_id,name,slug,workspace_path)
    VALUES(v_user,'Review evidence 2','review-evidence-2','/srv/infra-cod/workspaces/review-evidence-2') RETURNING id INTO v_project;
  INSERT INTO workspace_locks(project_id) VALUES(v_project) ON CONFLICT DO NOTHING;
  INSERT INTO runtime_profiles(runtime_type,adapter_version,runtime_version,provider_type,model)
    VALUES('codex','test','test','openai','codex-evidence-2') RETURNING id INTO v_codex_profile;
  INSERT INTO runtime_profiles(runtime_type,adapter_version,runtime_version,provider_type,model)
    VALUES('opencode','test','test','opencode-free','opencode-evidence-2') RETURNING id INTO v_executor_profile;
  INSERT INTO agents(name,role,runtime_profile_id) VALUES('evidence-codex-2','architect',v_codex_profile) RETURNING id INTO v_codex;
  INSERT INTO agents(name,role,runtime_profile_id) VALUES('evidence-worker-2','implementer',v_executor_profile) RETURNING id INTO v_worker;
  INSERT INTO project_agent_assignments(project_id,agent_id,runtime_profile_id,assignment_role,is_default)
    VALUES(v_project,v_codex,v_codex_profile,'orchestrator',true) RETURNING id INTO v_orchestrator;
  -- 0081: the implementer implements because an assignment of it holds implementation.execute.
  INSERT INTO project_agent_assignments(project_id,agent_id,runtime_profile_id,assignment_role)
    VALUES(v_project,v_worker,v_executor_profile,'executor');
  INSERT INTO agent_sessions(project_id,agent_id,runtime_profile_id,purpose,native_session_id)
    VALUES(v_project,v_worker,v_executor_profile,'implementation','ses_evidence_2') RETURNING id INTO v_session;

  -- Legacy: the previous release's supervisor records no base.
  INSERT INTO tasks(project_id,title,objective,status,active_agent_id,orchestrator_assignment_id,created_by,acceptance_criteria)
    VALUES(v_project,'Legacy','test','ready',v_codex,v_orchestrator,'test','["done"]') RETURNING id INTO v_task;
  v_request:=request_implementation(v_project,v_task,v_codex,v_worker,1,'Implement','[]','[]','["done"]','[]',
    '/srv/x','delegate:'||v_task,1,v_task::text);
  v_message:=claim_outbox_event((v_request->>'event_id')::uuid,'evidence-dispatcher',interval '1 minute');
  PERFORM route_outbox_message(v_message.id,'evidence-dispatcher');
  v_job:=claim_runtime_job_for_event((v_request->>'event_id')::uuid,'implementation_run','legacy-supervisor',interval '5 minutes');
  v_start:=start_implementation_job(v_job.id,v_session,'legacy-supervisor',interval '5 minutes');
  v_run:=(v_start->>'run_id')::uuid; v_token:=(v_start->>'fencing_token')::bigint;
  v_report:=submit_worker_completion(v_project,v_task,v_run,v_worker,v_token,'ses_evidence_2',
    '{"summary":"done"}'::jsonb,'{}'::jsonb,NULL,'legacy-complete');
  v_final:=finalize_worker_completion((v_report->>'report_id')::uuid,v_job.id,'legacy-supervisor');
  IF v_final->>'status'<>'awaiting_review' THEN
    RAISE EXCEPTION 'the previous release''s completion no longer finalizes: %', v_final;
  END IF;
  v_reason:=pg_temp.reason_of(format($q$ SELECT approve_task_review(%L,%L,'operator','looks fine','legacy-approve',%s,'c') $q$,
    v_project,v_task,(SELECT version FROM tasks WHERE id=v_task)));
  IF v_reason IS DISTINCT FROM 'review_evidence_missing' THEN
    RAISE EXCEPTION 'an approval of a run with no evidence was answered with %', v_reason;
  END IF;

  -- Uncommitted: the approved tree has changes its head commit does not carry.
  INSERT INTO tasks(project_id,title,objective,status,active_agent_id,orchestrator_assignment_id,created_by,acceptance_criteria)
    VALUES(v_project,'Uncommitted','test','ready',v_codex,v_orchestrator,'test','["done"]') RETURNING id INTO v_task;
  v_request:=request_implementation(v_project,v_task,v_codex,v_worker,1,'Implement','[]','[]','["done"]','[]',
    '/srv/x','delegate:'||v_task,1,v_task::text);
  v_message:=claim_outbox_event((v_request->>'event_id')::uuid,'evidence-dispatcher',interval '1 minute');
  PERFORM route_outbox_message(v_message.id,'evidence-dispatcher');
  v_job:=claim_runtime_job_for_event((v_request->>'event_id')::uuid,'implementation_run','evidence-supervisor',interval '5 minutes');
  v_start:=start_implementation_job(v_job.id,v_session,'evidence-supervisor',interval '5 minutes');
  v_run:=(v_start->>'run_id')::uuid; v_token:=(v_start->>'fencing_token')::bigint;
  PERFORM record_review_base(v_job.id,'evidence-supervisor',v_run,v_token,v_base);
  v_report:=submit_worker_completion(v_project,v_task,v_run,v_worker,v_token,'ses_evidence_2',
    '{"summary":"done"}'::jsonb,'{}'::jsonb,NULL,'uncommitted-complete');
  PERFORM record_review_evidence(v_job.id,'evidence-supervisor',v_run,v_token,
    pg_temp.evidence(v_base,v_head,'sha256:'||repeat('5',64),'sha256:'||repeat('6',64),false));
  PERFORM finalize_worker_completion((v_report->>'report_id')::uuid,v_job.id,'evidence-supervisor');
  PERFORM approve_task_review(v_project,v_task,'operator','approve the dirty tree','dirty-approve',
    (SELECT version FROM tasks WHERE id=v_task),'c');
  v_claim:=claim_publish_preparation('evidence-supervisor',interval '2 minutes');
  v_reason:=pg_temp.reason_of(format($q$ SELECT prepare_publish(%L,'evidence-supervisor',%L::jsonb) $q$, v_claim->>'id',
    jsonb_build_object('base_commit_sha',v_base,'head_commit_sha',v_head,
      'worktree_digest','sha256:'||repeat('5',64),'patch_digest','sha256:'||repeat('6',64))));
  IF v_reason IS DISTINCT FROM 'publish_worktree_uncommitted' THEN
    RAISE EXCEPTION 'an uncommitted approved tree was answered with %, not publish_worktree_uncommitted', v_reason;
  END IF;

  RAISE NOTICE 'a legacy run finalizes and its approval is refused; an uncommitted approved tree is not prepared for a push';
END $$;

ROLLBACK;
