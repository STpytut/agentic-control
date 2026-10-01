-- The first publish to an empty repository (battle test, Pocket Ledger).
--
-- A publish pushes the approved commit to its own branch and opens a pull
-- request against the base. An empty repository has no base: the push made the
-- only branch, GitHub took it as the default, and the pull request was refused
-- for its base (422). Nor could any base be made for it — the first commit of a
-- repository has no parent, so it shares history with no branch at all.
--
-- So the approved commit becomes the base branch itself, as any first push to
-- an empty repository does, and the publish ends there: published, with the
-- base as its ref and no pull request. The push is made by the broker only
-- when the remote has no base and no branch but the platform's own
-- (github-publish.mjs); from the second task on, publishes open pull requests.

SET search_path TO control_plane, public, extensions;

ALTER TABLE publish_intents ADD COLUMN IF NOT EXISTS initialised_base_ref text
  CHECK (initialised_base_ref IS NULL OR initialised_base_ref ~ '^refs/heads/');

DO $$
DECLARE v_name text;
BEGIN
  -- The published-needs-a-pull-request check, by what it says rather than by
  -- the name PostgreSQL gave it.
  FOR v_name IN
    SELECT conname FROM pg_constraint
    WHERE conrelid = 'control_plane.publish_intents'::regclass AND contype = 'c'
      AND pg_get_constraintdef(oid) LIKE '%pr_number IS NOT NULL%' AND pg_get_constraintdef(oid) LIKE '%published%'
  LOOP
    EXECUTE format('ALTER TABLE publish_intents DROP CONSTRAINT %I', v_name);
  END LOOP;
END $$;
ALTER TABLE publish_intents ADD CONSTRAINT publish_intents_published_receipt CHECK (
  status <> 'published' OR (pushed_ref IS NOT NULL AND (
    (pr_number IS NOT NULL AND pr_url IS NOT NULL) OR initialised_base_ref IS NOT NULL)));

CREATE OR REPLACE FUNCTION complete_publish_as_base(p_intent_id uuid, p_worker_id text, p_ref text, p_sha text)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path TO control_plane, public, extensions, pg_temp
AS $$
DECLARE v_intent publish_intents%ROWTYPE; v_event domain_events%ROWTYPE;
BEGIN
  v_intent := assert_publish_intent_claim(p_intent_id, p_worker_id);
  IF p_ref IS DISTINCT FROM 'refs/heads/'||v_intent.base_branch OR p_sha IS DISTINCT FROM v_intent.head_commit_sha THEN
    PERFORM refuse('publish_push_failed',
      format('publish %s makes %s the base %s; the receipt names %s at %s', v_intent.id, v_intent.head_commit_sha,
        v_intent.base_branch, COALESCE(p_sha, 'nothing'), COALESCE(p_ref, 'no ref')), '22023');
  END IF;
  -- A retry of a publish whose branch was pushed before keeps that receipt;
  -- the base is recorded beside it.
  UPDATE publish_intents SET pushed_ref = COALESCE(pushed_ref, p_ref), pushed_sha = COALESCE(pushed_sha, p_sha),
    pushed_at = COALESCE(pushed_at, clock_timestamp()), initialised_base_ref = p_ref, status = 'published',
    leased_by = NULL, leased_until = NULL, finished_at = clock_timestamp(), version = version + 1
  WHERE id = v_intent.id RETURNING * INTO v_intent;
  IF v_intent.authorization_id IS NOT NULL THEN
    PERFORM finalize_github_clone_authorization(v_intent.authorization_id, p_worker_id, true);
  END IF;
  v_event := append_publish_event(v_intent, 'publish.base_initialised', 'system', p_worker_id,
    jsonb_build_object('ref', p_ref, 'message',
      format('The repository was empty, so %s is now its %s branch. There was no base to open a pull request against; the next publish opens one.',
        left(p_sha, 12), v_intent.base_branch)));
  PERFORM write_audit_event(v_intent.project_id, v_intent.task_id, NULL, 'system', p_worker_id, 'task.published',
    'publish_intent', v_intent.id::text, 'allowed', NULL,
    jsonb_build_object('head_commit_sha', v_intent.head_commit_sha, 'ref', p_ref, 'initialised_base', true),
    v_intent.correlation_id);
  RETURN jsonb_build_object('publish_intent_id', v_intent.id, 'status', v_intent.status, 'ref', p_ref,
    'event_id', v_event.id);
END $$;

REVOKE EXECUTE ON FUNCTION complete_publish_as_base(uuid, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION complete_publish_as_base(uuid, text, text, text) TO infra_worker;
