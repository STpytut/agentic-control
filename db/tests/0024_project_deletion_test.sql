\set ON_ERROR_STOP on
BEGIN;
SET search_path TO control_plane,public,extensions;

DO $$
DECLARE
  v_owner uuid;
  v_other uuid;
  v_project uuid;
  v_task uuid;
  v_event uuid;
  v_job bigint;
  v_outbox bigint;
  v_result jsonb;
  v_claim jsonb;
  v_attempts integer;
  v_status text;
  v_run uuid;
  v_token text;
BEGIN
  INSERT INTO users(display_name) VALUES('Deletion owner') RETURNING id INTO v_owner;
  INSERT INTO users(display_name) VALUES('Deletion outsider') RETURNING id INTO v_other;

  INSERT INTO projects(owner_id,name,slug,workspace_path,default_branch)
  VALUES(v_owner,'Delete me','delete-me','/fixture/workspaces/delete-me','main')
  RETURNING id INTO v_project;

  -- Owner isolation and stale version rejection.
  BEGIN
    PERFORM request_project_deletion(v_project,v_other,1,'corr-foreign',false);
    RAISE EXCEPTION 'foreign operator requested project deletion';
  EXCEPTION WHEN others THEN
    IF SQLERRM NOT ILIKE '%unavailable%' THEN RAISE; END IF;
  END;
  BEGIN
    PERFORM request_project_deletion(v_project,v_owner,99,'corr-stale',false);
    RAISE EXCEPTION 'stale version requested project deletion';
  EXCEPTION WHEN others THEN
    IF SQLERRM NOT ILIKE '%stale%' THEN RAISE; END IF;
  END;

  -- Queued work is cancelled by the request.
  INSERT INTO tasks(project_id,title,objective,status,created_by)
  VALUES(v_project,'Queued task','Queued objective','planning',v_owner::text)
  RETURNING id INTO v_task;
  INSERT INTO domain_events(
    event_type,project_id,task_id,actor_type,actor_id,
    correlation_id,aggregate_type,aggregate_id,aggregate_version,payload
  ) VALUES(
    'implementation.requested',v_project,v_task,'system','deletion-test',
    'deletion-correlation','task',v_task,1,'{}'::jsonb
  ) RETURNING id INTO v_event;
  INSERT INTO outbox_messages(event_id,destination)
  VALUES(v_event,'control-plane') RETURNING id INTO v_outbox;
  INSERT INTO runtime_jobs(source_event_id,job_type,project_id,task_id,payload)
  VALUES(v_event,'implementation_run',v_project,v_task,'{}'::jsonb)
  RETURNING id INTO v_job;

  v_result := request_project_deletion(v_project,v_owner,1,'corr-1',false);
  IF v_result->>'status'<>'deleting' OR (v_result->>'active_jobs')::integer<>1
     OR (v_result->>'cancelled_outbox')::integer<>1 OR (v_result->>'cancelled_jobs')::integer<>1 THEN
    RAISE EXCEPTION 'deletion request did not cancel queued work';
  END IF;
  IF (SELECT status FROM runtime_jobs WHERE id=v_job)<>'dead_letter' THEN
    RAISE EXCEPTION 'queued runtime job was not cancelled';
  END IF;

  -- DB-level fail-closed guard: a deleting project accepts no new work through
  -- any path (tasks, chat messages, delegation, outbox, runtime jobs,
  -- workspace operations).
  BEGIN
    INSERT INTO tasks(project_id,title,objective,status,created_by)
    VALUES(v_project,'Blocked task','Blocked objective','planning',v_owner::text);
    RAISE EXCEPTION 'task insert into a deleting project was accepted';
  EXCEPTION WHEN others THEN
    IF SQLERRM NOT ILIKE '%being deleted%' THEN RAISE; END IF;
  END;
  BEGIN
    INSERT INTO domain_events(
      event_type,project_id,task_id,actor_type,actor_id,
      correlation_id,aggregate_type,aggregate_id,aggregate_version,payload
    ) VALUES(
      'chat.user_message',v_project,v_task,'user',v_owner::text,
      'guard-correlation','task',v_task,1,'{}'::jsonb
    );
    RAISE EXCEPTION 'chat message into a deleting project was accepted';
  EXCEPTION WHEN others THEN
    IF SQLERRM NOT ILIKE '%being deleted%' THEN RAISE; END IF;
  END;
  BEGIN
    INSERT INTO outbox_messages(event_id,destination)
    SELECT id,'control-plane' FROM domain_events WHERE id=v_event;
    RAISE EXCEPTION 'outbox insert for a deleting project was accepted';
  EXCEPTION WHEN others THEN
    IF SQLERRM NOT ILIKE '%being deleted%' THEN RAISE; END IF;
  END;
  BEGIN
    INSERT INTO runtime_jobs(source_event_id,job_type,project_id,task_id,payload)
    VALUES(v_event,'resume_orchestrator',v_project,v_task,'{}'::jsonb);
    RAISE EXCEPTION 'runtime job insert for a deleting project was accepted';
  EXCEPTION WHEN others THEN
    IF SQLERRM NOT ILIKE '%being deleted%' THEN RAISE; END IF;
  END;
  BEGIN
    INSERT INTO workspace_operations(project_id,operation_type,requested_by,reason,correlation_id,status)
    VALUES(v_project,'restore_owner','guard-worker','lifecycle guard','guard-correlation','pending');
    RAISE EXCEPTION 'workspace operation for a deleting project was accepted';
  EXCEPTION WHEN others THEN
    IF SQLERRM NOT ILIKE '%being deleted%' THEN RAISE; END IF;
  END;
  IF (SELECT count(*) FROM tasks WHERE project_id=v_project)<>1 THEN
    RAISE EXCEPTION 'lifecycle guard let a blocked task through';
  END IF;

  -- Double request is rejected while deleting.
  BEGIN
    PERFORM request_project_deletion(v_project,v_owner,2,'corr-2',false);
    RAISE EXCEPTION 'double deletion request was accepted';
  EXCEPTION WHEN others THEN
    IF SQLERRM NOT ILIKE '%already in progress%' THEN RAISE; END IF;
  END;

  -- Grace period: cleanup cannot be claimed before the deadline.
  IF jsonb_array_length(claim_project_cleanup('cleanup-worker',1,interval '10 minutes'))<>0 THEN
    RAISE EXCEPTION 'cleanup was claimed before the grace deadline';
  END IF;

  -- Undo restores the project; a second request works again.
  v_result := undo_project_deletion(v_project,v_owner,2,'corr-3');
  IF v_result->>'status'<>'active' THEN RAISE EXCEPTION 'undo did not restore the project'; END IF;
  IF (SELECT status FROM projects WHERE id=v_project)<>'active' THEN
    RAISE EXCEPTION 'undo did not restore project status';
  END IF;
  v_result := request_project_deletion(v_project,v_owner,3,'corr-4',false);
  IF v_result->>'status'<>'deleting' THEN RAISE EXCEPTION 'second deletion request failed'; END IF;

  -- Undo after the grace deadline but before claim is allowed.
  UPDATE projects SET
    deletion_requested_at=clock_timestamp()-interval '2 seconds',
    deletion_not_before=clock_timestamp()-interval '1 second'
  WHERE id=v_project;
  v_result := undo_project_deletion(v_project,v_owner,4,'corr-5');
  v_result := request_project_deletion(v_project,v_owner,5,'corr-6',false);
  UPDATE projects SET
    deletion_requested_at=clock_timestamp()-interval '2 seconds',
    deletion_not_before=clock_timestamp()-interval '1 second'
  WHERE id=v_project;

  -- Concurrent claims: only one worker wins the lease.
  v_claim := claim_project_cleanup('cleanup-worker-a',1,interval '10 minutes');
  IF jsonb_array_length(v_claim)<>1 OR v_claim->0->>'project_id'<>v_project::text THEN
    RAISE EXCEPTION 'first cleanup claim failed';
  END IF;
  IF jsonb_array_length(claim_project_cleanup('cleanup-worker-b',1,interval '10 minutes'))<>0 THEN
    RAISE EXCEPTION 'second concurrent cleanup claim was accepted';
  END IF;
  IF (SELECT cleanup_leased_by FROM projects WHERE id=v_project)<>'cleanup-worker-a' THEN
    RAISE EXCEPTION 'cleanup lease was not recorded';
  END IF;

  -- Undo is denied once cleanup is claimed (attempt_count>0).
  BEGIN
    PERFORM undo_project_deletion(v_project,v_owner,7,'corr-7');
    RAISE EXCEPTION 'undo after cleanup claim was accepted';
  EXCEPTION WHEN others THEN
    IF SQLERRM NOT ILIKE '%already been claimed%' THEN RAISE; END IF;
  END;

  -- Complete cleanup marks the tombstone deleted.
  v_result := complete_project_cleanup(v_project,'cleanup-worker-a');
  IF v_result->>'status'<>'deleted' OR (SELECT deprovisioned_at IS NULL FROM projects WHERE id=v_project) THEN
    RAISE EXCEPTION 'cleanup completion did not mark the tombstone deleted';
  END IF;

  -- Idle-project deletion completes; the tombstone stays visible in the
  -- operations read model and remains attributable.
  IF (SELECT count(*) FROM projects WHERE id=v_project)<>1 THEN
    RAISE EXCEPTION 'project row was physically deleted';
  END IF;
  v_claim := get_operator_project_deletion_status(v_owner);
  IF jsonb_array_length(v_claim)<>1 OR v_claim->0->>'status'<>'deleted' THEN
    RAISE EXCEPTION 'deletion tombstone is not visible to the owner';
  END IF;
  IF get_operator_project_deletion_status(v_other)<>'[]'::jsonb THEN
    RAISE EXCEPTION 'foreign operator can see deletion tombstones';
  END IF;

  -- Repeated cleanup is harmless: no lease, no state change.
  IF jsonb_array_length(claim_project_cleanup('cleanup-worker-a',1,interval '10 minutes'))<>0 THEN
    RAISE EXCEPTION 'repeated cleanup claimed a deleted project';
  END IF;

  -- Partial failure -> deletion_failed, retryable.
  INSERT INTO projects(owner_id,name,slug,workspace_path,default_branch)
  VALUES(v_owner,'Retry me','retry-me','/fixture/workspaces/retry-me','main')
  RETURNING id INTO v_project;
  PERFORM request_project_deletion(v_project,v_owner,1,'corr-8',true);
  v_claim := claim_project_cleanup('cleanup-worker-c',1,interval '10 minutes');
  v_result := fail_project_cleanup(v_project,'cleanup-worker-c','disk_error','disk full');
  IF v_result->>'status'<>'deletion_failed' THEN RAISE EXCEPTION 'cleanup failure did not mark deletion_failed'; END IF;
  IF (SELECT count(*) FROM projects WHERE status='deleting' AND deletion_not_before<=clock_timestamp())<>0 THEN
    RAISE EXCEPTION 'failed project is still claimable without retry';
  END IF;
  -- A partially cleaned project must never be restored to active by undo.
  BEGIN
    PERFORM undo_project_deletion(v_project,v_owner,4,'corr-undo-failed');
    RAISE EXCEPTION 'undo after deletion_failed was accepted';
  EXCEPTION WHEN others THEN
    IF SQLERRM NOT ILIKE '%cannot be undone%' THEN RAISE; END IF;
  END;
  v_result := retry_project_cleanup(v_project,v_owner,4,'corr-9');
  IF v_result->>'status'<>'deleting' THEN RAISE EXCEPTION 'cleanup retry failed'; END IF;
  v_claim := claim_project_cleanup('cleanup-worker-d',1,interval '10 minutes');
  IF jsonb_array_length(v_claim)<>1 THEN RAISE EXCEPTION 'retried cleanup was not claimable'; END IF;
  v_result := complete_project_cleanup(v_project,'cleanup-worker-d');
  IF v_result->>'status'<>'deleted' THEN RAISE EXCEPTION 'retried cleanup did not complete'; END IF;

  -- Delete now skips the grace timer only with the approval marker.
  INSERT INTO projects(owner_id,name,slug,workspace_path,default_branch)
  VALUES(v_owner,'Now me','now-me','/fixture/workspaces/now-me','main')
  RETURNING id INTO v_project;
  v_result := request_project_deletion(v_project,v_owner,1,'corr-approve',true);
  IF v_result->>'status'<>'deleting' THEN RAISE EXCEPTION 'delete-now request failed'; END IF;
  v_claim := claim_project_cleanup('cleanup-worker-e',1,interval '10 minutes');
  IF jsonb_array_length(v_claim)<>1 THEN RAISE EXCEPTION 'delete-now project is not immediately claimable'; END IF;

  -- Launch admission fence: a deleting project cannot register a new launch
  -- reservation (fail-closed), and deprovision scans treat a live reservation
  -- as an active writer.
  INSERT INTO projects(owner_id,name,slug,workspace_path,default_branch)
  VALUES(v_owner,'Admission me','admission-me','/fixture/workspaces/admission-me','main')
  RETURNING id INTO v_project;
  INSERT INTO runtime_profiles(runtime_type,adapter_version,runtime_version,provider_type,model,enabled)
  VALUES('codex','0.5.0','0.5.0','openai','admission-codex',true)
  ON CONFLICT DO NOTHING;
  INSERT INTO agents(name,role,runtime_profile_id)
  SELECT 'admission-orchestrator','architect',rp.id
  FROM runtime_profiles rp WHERE rp.model='admission-codex' AND rp.enabled LIMIT 1;
  INSERT INTO project_agent_assignments(project_id,agent_id,runtime_profile_id,assignment_role,is_default)
  SELECT v_project,a.id,a.runtime_profile_id,'orchestrator',true
  FROM agents a WHERE a.name='admission-orchestrator' AND a.enabled LIMIT 1;
  INSERT INTO tasks(project_id,title,objective,status,created_by)
  VALUES(v_project,'Admission task','Admission objective','ready',v_owner::text)
  RETURNING id INTO v_task;
  INSERT INTO domain_events(
    event_type,project_id,task_id,actor_type,actor_id,
    correlation_id,aggregate_type,aggregate_id,aggregate_version,payload
  ) VALUES(
    'implementation.requested',v_project,v_task,'system','admission-test',
    'admission-correlation','task',v_task,1,'{}'::jsonb
  ) RETURNING id INTO v_event;
  INSERT INTO runtime_jobs(source_event_id,job_type,project_id,task_id,payload)
  VALUES(v_event,'implementation_run',v_project,v_task,'{}'::jsonb)
  RETURNING id INTO v_job;
  UPDATE runtime_jobs SET status='in_flight', leased_by='admission-supervisor',
    leased_until=clock_timestamp()+interval '2 minutes'
  WHERE id=v_job;
  INSERT INTO task_runs(task_id,agent_id,phase,status,write_capable,workspace_fencing_token)
  SELECT v_task,pa.agent_id,'running','running',true,1
  FROM project_agent_assignments pa
  WHERE pa.project_id=v_project AND pa.assignment_role='orchestrator'
  LIMIT 1
  RETURNING id INTO v_run;
  UPDATE runtime_jobs SET run_id=v_run WHERE id=v_job;

  -- Reservation succeeds for an active project with a token; bind attaches
  -- the PID via CAS; complete replaces it with the process identity
  -- atomically (second lifecycle check still passes).
  v_result := reserve_runtime_launch(v_run,v_project,v_job,'admission-supervisor',interval '90 seconds');
  IF v_result->>'status'<>'reserved' OR (v_result->>'token') !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'launch reservation failed for an active project';
  END IF;
  IF (SELECT count(*) FROM runtime_launch_reservations WHERE project_id=v_project)<>1 THEN
    RAISE EXCEPTION 'launch reservation was not persisted';
  END IF;
  v_token := v_result->>'token';
  v_result := bind_runtime_launch_pid(v_run,v_token,'admission-supervisor','runtime-supervisor:4242');
  IF v_result->>'status'<>'pid_bound' THEN RAISE EXCEPTION 'pid binding failed'; END IF;
  IF (SELECT process_ref FROM runtime_launch_reservations WHERE run_id=v_run)<>'runtime-supervisor:4242' THEN
    RAISE EXCEPTION 'pid was not attached to the reservation';
  END IF;
  v_result := complete_runtime_launch(v_run,v_project,v_job,'admission-supervisor',
    v_token,'runtime-supervisor:4242');
  IF v_result->>'status'<>'launched' THEN RAISE EXCEPTION 'launch completion failed'; END IF;
  IF (SELECT state FROM runtime_launch_reservations WHERE run_id=v_run)<>'completed' THEN
    RAISE EXCEPTION 'launch reservation was not marked completed';
  END IF;
  IF (SELECT process_ref FROM task_runs WHERE id=v_run)<>'runtime-supervisor:4242' THEN
    RAISE EXCEPTION 'process identity was not registered';
  END IF;

  -- A completed launch cannot be silently re-reserved for the same run.
  BEGIN
    PERFORM reserve_runtime_launch(v_run,v_project,v_job,'admission-supervisor',interval '90 seconds');
    RAISE EXCEPTION 'completed launch was re-reserved';
  EXCEPTION WHEN others THEN
    IF SQLERRM NOT ILIKE '%already exists%' THEN RAISE; END IF;
  END;

  -- Reset only this transactional fixture to exercise a fresh reservation.
  DELETE FROM runtime_launch_reservations WHERE run_id=v_run;
  UPDATE task_runs SET process_ref=NULL WHERE id=v_run;

  -- A wrong token cannot bind or complete the reservation (CAS).
  v_result := reserve_runtime_launch(v_run,v_project,v_job,'admission-supervisor',interval '90 seconds');
  v_token := v_result->>'token';
  BEGIN
    PERFORM bind_runtime_launch_pid(
      v_run,
      (CASE left(v_token,1) WHEN '0' THEN '1' ELSE '0' END)||substr(v_token,2),
      'admission-supervisor','runtime-supervisor:9999'
    );
    RAISE EXCEPTION 'bind with a wrong token was accepted';
  EXCEPTION WHEN others THEN
    IF SQLERRM NOT ILIKE '%not active%' THEN RAISE; END IF;
  END;
  IF (SELECT process_ref FROM runtime_launch_reservations WHERE run_id=v_run) IS NOT NULL THEN
    RAISE EXCEPTION 'wrong-token bind mutated the reservation';
  END IF;

  -- A deleting project cannot register a new launch reservation (fail-closed).
  -- Re-reserve while the project is still active, then delete it: the later
  -- complete must fail and leave the reservation reserved.
  PERFORM cancel_runtime_launch(v_run,v_job,'admission-supervisor',v_token,false);
  v_result := reserve_runtime_launch(v_run,v_project,v_job,'admission-supervisor',interval '90 seconds');
  v_token := v_result->>'token';
  PERFORM request_project_deletion(v_project,v_owner,1,'corr-admission',true);
  BEGIN
    PERFORM reserve_runtime_launch(v_run,v_project,v_job,'admission-supervisor',interval '90 seconds');
    RAISE EXCEPTION 'launch reservation for a deleting project was accepted';
  EXCEPTION WHEN others THEN
    IF SQLERRM NOT ILIKE '%being deleted%' THEN RAISE; END IF;
  END;

  -- Complete on a deleting project fails and leaves an existing reservation.
  BEGIN
    PERFORM complete_runtime_launch(v_run,v_project,v_job,'admission-supervisor',
      v_token,'runtime-supervisor:9999');
    RAISE EXCEPTION 'launch completion for a deleting project was accepted';
  EXCEPTION WHEN others THEN
    IF SQLERRM NOT ILIKE '%being deleted%' THEN RAISE; END IF;
  END;
  IF (SELECT count(*) FROM runtime_launch_reservations
      WHERE project_id=v_project AND state='reserved')<>1 THEN
    RAISE EXCEPTION 'reservation was cancelled despite launch failure';
  END IF;
  -- A deprovision scan must treat the live reservation as an active writer.
  IF (SELECT count(*) FROM runtime_launch_reservations
      WHERE project_id=v_project AND state='reserved' AND expires_at>clock_timestamp())<>1 THEN
    RAISE EXCEPTION 'live launch reservation is invisible to deprovision scan';
  END IF;

  -- A late complete after expiry is impossible; an unbound expired
  -- reservation remains fail-closed for operator reconciliation.
  UPDATE runtime_launch_reservations SET
    created_at=clock_timestamp()-interval '2 seconds',
    expires_at=clock_timestamp()-interval '1 second'
  WHERE run_id=v_run;
  BEGIN
    PERFORM complete_runtime_launch(v_run,v_project,v_job,'admission-supervisor',
      v_token,'runtime-supervisor:9999');
    RAISE EXCEPTION 'late complete after expiry was accepted';
  EXCEPTION WHEN others THEN
    IF SQLERRM NOT ILIKE '%being deleted%' THEN RAISE; END IF;
  END;
  IF (SELECT state FROM runtime_launch_reservations WHERE run_id=v_run)<>'reserved' THEN
    RAISE EXCEPTION 'expired reservation was not left reserved';
  END IF;

  RAISE NOTICE 'project deletion assertions passed';
END $$;

ROLLBACK;
