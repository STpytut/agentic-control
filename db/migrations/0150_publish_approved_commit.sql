-- Publishing the approved commit after the workspace moved on (rc.140).
--
-- A project has one workspace, and its tasks commit there one after another.
-- On rc.139 the owner approved "Reset to defaults" after "Chime volume" had
-- already committed on top of it; preparing the first publish compared the
-- workspace with the reviewed evidence and refused it
-- (review_evidence_digest_moved), and the second's pull request carried both.
--
-- What a publish pushes is a commit, named by its id: its tree and history
-- cannot differ from what was reviewed. So a preparation whose workspace moved
-- on is prepared from the approved commit when the review saw the work
-- committed and the workspace still holds that commit; the export packs that
-- commit rather than requiring HEAD to be it (publish-export.mjs). A workspace
-- that no longer holds the commit, or whose base moved, is still refused.

SET search_path TO control_plane, public, extensions;

CREATE OR REPLACE FUNCTION claim_publish_preparation(p_worker_id text, p_lease interval DEFAULT interval '2 minutes')
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE v_row publish_preparations%ROWTYPE; v_evidence review_evidence%ROWTYPE; v_path text;
BEGIN
  SELECT * INTO v_row FROM publish_preparations p
  WHERE p.status='requested' OR (p.status='claimed' AND p.leased_until<=clock_timestamp())
  ORDER BY p.requested_at
  LIMIT 1 FOR UPDATE SKIP LOCKED;
  IF NOT FOUND THEN RETURN NULL; END IF;
  UPDATE publish_preparations SET status='claimed', leased_by=p_worker_id,
    leased_until=clock_timestamp()+p_lease, attempt_count=attempt_count+1
  WHERE id=v_row.id RETURNING * INTO v_row;
  SELECT * INTO v_evidence FROM review_evidence e WHERE e.id=v_row.evidence_id;
  SELECT pr.workspace_path INTO v_path FROM projects pr WHERE pr.id=v_row.project_id;
  RETURN jsonb_build_object('id', v_row.id, 'project_id', v_row.project_id, 'task_id', v_row.task_id,
    'workspace_path', v_path, 'base_commit_sha', v_evidence.base_commit_sha,
    'evidence_digest', v_row.evidence_digest, 'attempt_count', v_row.attempt_count,
    -- 0150: the approved commit, so the supervisor can say whether the
    -- workspace still holds it when its HEAD has moved on.
    'head_commit_sha', v_evidence.head_commit_sha);
END $$;

CREATE OR REPLACE FUNCTION prepare_publish(p_preparation_id uuid, p_worker_id text, p_observed jsonb)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
  v_row publish_preparations%ROWTYPE; v_task tasks%ROWTYPE; v_evidence review_evidence%ROWTYPE;
  v_moved text[] := ARRAY[]::text[]; v_field text; v_event domain_events%ROWTYPE;
BEGIN
  v_row:=assert_publish_preparation_claim(p_preparation_id, p_worker_id);
  IF p_observed IS NULL OR jsonb_typeof(p_observed)<>'object'
     OR COALESCE(p_observed->>'base_commit_sha','') !~ '^[0-9a-f]{40}([0-9a-f]{24})?$'
     OR COALESCE(p_observed->>'head_commit_sha','') !~ '^[0-9a-f]{40}([0-9a-f]{24})?$'
     OR COALESCE(p_observed->>'worktree_digest','') !~ '^sha256:[0-9a-f]{64}$'
     OR COALESCE(p_observed->>'patch_digest','') !~ '^sha256:[0-9a-f]{64}$' THEN
    PERFORM refuse('publish_observation_invalid',
      'prepare_publish needs the recomputed base, head, worktree digest and patch digest', '22023');
  END IF;
  SELECT * INTO v_task FROM tasks t WHERE t.id=v_row.task_id FOR UPDATE;
  IF v_task.status<>'approved' THEN
    PERFORM refuse('publish_task_not_approved', format('task %s is %s, not approved', v_task.id, v_task.status));
  END IF;
  SELECT * INTO v_evidence FROM review_evidence e WHERE e.id=v_row.evidence_id;

  FOREACH v_field IN ARRAY ARRAY['base_commit_sha','head_commit_sha','worktree_digest','patch_digest'] LOOP
    IF p_observed->>v_field IS DISTINCT FROM to_jsonb(v_evidence)->>v_field THEN
      v_moved:=v_moved || v_field;
    END IF;
  END LOOP;
  -- 0150: a workspace that moved on past the approved commit — the next task's
  -- work committed on top of it — still publishes that commit. A commit id
  -- names its tree and its history, so the commit that is pushed is the one
  -- reviewed whatever the workspace holds now, provided the review saw it
  -- committed and the workspace still has it (the supervisor asks git, as the
  -- workspace's owner). The base is the evidence's own either way.
  IF cardinality(v_moved) > 0 AND v_evidence.worktree_committed
     AND p_observed->>'approved_commit_present' = 'true'
     AND p_observed->>'approved_commit_sha' = v_evidence.head_commit_sha
     AND NOT 'base_commit_sha' = ANY(v_moved) THEN
    v_moved := ARRAY[]::text[];
  END IF;
  IF cardinality(v_moved) > 0 THEN
    PERFORM refuse('review_evidence_digest_moved',
      format('the workspace has moved since evidence %s was approved: %s differ',
        v_evidence.evidence_digest, array_to_string(v_moved, ', ')));
  END IF;
  -- The tree is the approved one. Whether it can be published by pushing a
  -- commit is a separate question, and so is whether the platform's own check
  -- of it passed.
  IF NOT v_evidence.worktree_committed THEN
    PERFORM refuse('publish_worktree_uncommitted',
      format('the approved tree of evidence %s is not the tree of head %s; a push of that commit would not carry it',
        v_evidence.evidence_digest, v_evidence.head_commit_sha));
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(v_evidence.platform_verified_checks) c
             WHERE c->>'status' IS DISTINCT FROM 'passed') THEN
    PERFORM refuse('review_evidence_unverified',
      format('a platform check of evidence %s did not pass', v_evidence.evidence_digest));
  END IF;

  UPDATE publish_preparations SET status='prepared', observed=p_observed,
    head_commit_sha=v_evidence.head_commit_sha, finished_at=clock_timestamp(), leased_until=NULL
  WHERE id=v_row.id RETURNING * INTO v_row;
  v_event:=append_event('publish.prepared', v_row.project_id, v_row.task_id, NULL, 'system', p_worker_id,
    NULL, v_row.correlation_id, 'publish-prepared:'||v_row.id, 'publish_preparation', v_row.id, 1,
    jsonb_build_object('publish_preparation_id', v_row.id, 'evidence_digest', v_row.evidence_digest,
      'head_commit_sha', v_row.head_commit_sha, 'base_commit_sha', v_evidence.base_commit_sha));
  PERFORM write_audit_event(v_row.project_id, v_row.task_id, NULL, 'system', p_worker_id,
    'task.publish_prepared', 'publish_preparation', v_row.id::text, 'allowed', NULL,
    jsonb_build_object('evidence_digest', v_row.evidence_digest, 'head_commit_sha', v_row.head_commit_sha),
    v_row.correlation_id);
  RETURN jsonb_build_object('status', 'prepared', 'publish_preparation_id', v_row.id,
    'evidence_digest', v_row.evidence_digest, 'base_commit_sha', v_evidence.base_commit_sha,
    'head_commit_sha', v_row.head_commit_sha, 'event_id', v_event.id);
END $$;
ALTER FUNCTION claim_publish_preparation(text,interval) SET search_path=control_plane,public,extensions,pg_temp;
ALTER FUNCTION prepare_publish(uuid,text,jsonb) SET search_path=control_plane,public,extensions,pg_temp;
