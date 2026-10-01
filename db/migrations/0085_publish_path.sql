-- The publish path (Stage 11.4, sprint B P1; ADR-0015 §6, B5).
--
-- 0069 stopped at the boundary: an approval prepares a publish, the supervisor
-- recomputes the four digests and `prepare_publish` fixes the head commit the
-- operator approved. The push and the pull request stayed the operator's own,
-- by hand, from that commit.
--
-- Now the platform does it, and only this way:
--
--   request   — the operator asks to publish a *prepared* preparation
--               (`request_publish`, infra_web). The intent is made by that
--               request and by nothing else: no model and no worker can write
--               one. `publish.request` lets an agent ask the operator; it
--               grants nothing here.
--   claim     — the GitHub broker, the only holder of the App's key, claims the
--               intent (`claim_publish_intent`) together with a GitHub
--               authorization on the project's connection (0022's
--               github_clone_authorizations, which a disconnect waits for), and
--               learns what to push: the prepared head commit, the branch named
--               for the task, the project's default branch as the base.
--   push      — the broker mints an installation token for that one
--               repository, `contents: write` and `pull_requests: write`, for
--               this operation only. The supervisor exports the approved commit's
--               objects from the workspace as its owner, never as root, and
--               refuses when the workspace's HEAD has moved since prepare. The
--               broker pushes the commit by id to the task's branch from a
--               scratch repository — never a force push — and records the ref
--               (`record_publish_push`).
--   PR        — the broker opens a pull request (or finds the one already open
--               for that branch) and records its number and URL
--               (`complete_publish_intent`).
--   failure   — any step's refusal is recorded with its reason
--               (`fail_publish_intent`); the operator can retry a failed intent
--               from the panel (`retry_publish_intent`), which puts the same
--               intent back with the same commit.
--
-- The token never enters argv, the database, events or logs. Each step is an
-- event on the intent's own aggregate, so the task's conversation says what
-- was pushed and where the pull request is.

SET search_path TO control_plane, public, extensions;

INSERT INTO failure_reasons(reason, code, note) VALUES
  ('publish_not_prepared','conflict','only a prepared publish of an approved task can be published'),
  ('publish_unsupported_repository','conflict','this project has no GitHub App repository to publish to; its tree stays prepare-only'),
  ('publish_intent_not_claimed','lease_lost','the publish is not claimed by this worker, or its lease ran out'),
  ('publish_intent_not_failed','conflict','only a failed publish can be retried, or the card is out of date'),
  ('publish_connection_unavailable','unavailable','the project''s GitHub connection is not connected'),
  ('publish_head_moved','conflict','the workspace''s HEAD moved since the publish was prepared'),
  ('publish_export_failed','unavailable','the approved commit could not be read from the workspace'),
  ('publish_token_unavailable','unavailable','GitHub did not issue a token with contents and pull request write access for this repository'),
  ('publish_push_rejected','conflict','GitHub refused the push: the branch holds commits the approved one does not contain'),
  ('publish_push_failed','unavailable','the push to GitHub did not complete'),
  ('publish_pull_request_failed','unavailable','the pull request could not be opened');

CREATE TABLE publish_intents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id),
  task_id uuid NOT NULL REFERENCES tasks(id),
  -- One intent per preparation: a retry is the same intent again, so a
  -- preparation is pushed to one branch and opens at most one pull request.
  preparation_id uuid NOT NULL UNIQUE REFERENCES publish_preparations(id),
  head_commit_sha text NOT NULL CHECK (head_commit_sha ~ '^[0-9a-f]{40}([0-9a-f]{24})?$'),
  branch_name text NOT NULL CHECK (branch_name ~ '^infra-cod/[0-9a-f-]{36}$'),
  base_branch text NOT NULL CHECK (length(base_branch) BETWEEN 1 AND 255),
  repository_full_name text NOT NULL CHECK (repository_full_name ~ '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$'),
  github_repository_id bigint NOT NULL,
  connection_id uuid NOT NULL,
  connection_kind text GENERATED ALWAYS AS ('scm') STORED,
  requested_by text NOT NULL,
  correlation_id text NOT NULL,
  status text NOT NULL DEFAULT 'requested'
    CHECK (status IN ('requested','claimed','published','failed')),
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  leased_by text,
  leased_until timestamptz,
  authorization_id uuid REFERENCES github_clone_authorizations(id),
  pushed_ref text,
  pushed_sha text,
  pushed_at timestamptz,
  pr_number integer,
  pr_url text CHECK (pr_url IS NULL OR pr_url ~ '^https://'),
  failure_reason text REFERENCES failure_reasons(reason),
  failure_message text CHECK (failure_message IS NULL OR length(failure_message) <= 1000),
  requested_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  finished_at timestamptz,
  FOREIGN KEY (connection_id, connection_kind) REFERENCES provider_connections(id, connection_kind),
  CHECK ((status='claimed') = (leased_by IS NOT NULL AND leased_until IS NOT NULL)),
  CHECK ((status='failed') = (failure_reason IS NOT NULL)),
  CHECK ((status IN ('published','failed')) = (finished_at IS NOT NULL)),
  CHECK (status<>'published' OR (pushed_ref IS NOT NULL AND pr_number IS NOT NULL AND pr_url IS NOT NULL)),
  -- What was pushed is the approved commit, and nothing else.
  CHECK (pushed_sha IS NULL OR pushed_sha=head_commit_sha),
  CHECK ((pushed_ref IS NULL) = (pushed_sha IS NULL))
);
CREATE INDEX publish_intents_pending ON publish_intents(requested_at) WHERE status IN ('requested','claimed');

-- A published intent is a receipt: nothing changes it.
CREATE FUNCTION refuse_published_intent_change()
RETURNS trigger LANGUAGE plpgsql
SET search_path TO control_plane, public, extensions, pg_temp
AS $$
BEGIN
  IF TG_OP='UPDATE' THEN
    IF OLD.status<>'published' THEN RETURN NEW; END IF;
  END IF;
  PERFORM refuse('review_evidence_immutable', format('a published intent cannot be changed (%s refused)', TG_OP));
  RETURN NULL;
END $$;
CREATE TRIGGER publish_intents_final BEFORE UPDATE OR DELETE ON publish_intents
  FOR EACH ROW EXECUTE FUNCTION refuse_published_intent_change();

-- An event on the intent's own aggregate, attached to the task's conversation.
CREATE FUNCTION append_publish_event(p_intent publish_intents, p_event_type text, p_actor_type text, p_actor text,
  p_payload jsonb)
RETURNS domain_events LANGUAGE sql
SET search_path TO control_plane, public, extensions, pg_temp
AS $$
  SELECT * FROM append_event(p_event_type, p_intent.project_id, p_intent.task_id, NULL, p_actor_type, p_actor,
    NULL, p_intent.correlation_id, p_event_type||':'||p_intent.id||':'||p_intent.version,
    'publish_intent', p_intent.id, p_intent.version,
    jsonb_build_object('publish_intent_id',p_intent.id,'head_commit_sha',p_intent.head_commit_sha,
      'branch',p_intent.branch_name,'repository',p_intent.repository_full_name,'attempt',p_intent.attempt_count) || p_payload);
$$;

-- ------------------------------------------------------------- the operator

CREATE FUNCTION request_publish(p_preparation_id uuid, p_owner_id uuid, p_actor text, p_correlation_id text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO control_plane, public, extensions, pg_temp
AS $$
DECLARE v_preparation publish_preparations%ROWTYPE; v_project projects%ROWTYPE; v_task tasks%ROWTYPE;
  v_intent publish_intents%ROWTYPE; v_connection provider_connections%ROWTYPE; v_event domain_events%ROWTYPE;
BEGIN
  IF p_actor IS NULL OR length(trim(p_actor)) < 2 OR p_correlation_id IS NULL OR p_correlation_id='' THEN
    PERFORM refuse('publish_not_prepared', 'a publish request names its actor and correlation', '22023');
  END IF;
  SELECT pp.* INTO v_preparation FROM publish_preparations pp
  JOIN projects p ON p.id=pp.project_id
  WHERE pp.id=p_preparation_id AND p.owner_id=p_owner_id FOR UPDATE OF pp;
  IF NOT FOUND THEN
    PERFORM refuse('publish_not_prepared', format('no publish preparation %s in a project this operator owns', p_preparation_id));
  END IF;
  SELECT * INTO v_intent FROM publish_intents WHERE preparation_id=v_preparation.id;
  IF FOUND THEN
    -- The same click again: the answer it already had.
    RETURN jsonb_build_object('publish_intent_id',v_intent.id,'status',v_intent.status,'repeat',true);
  END IF;
  IF v_preparation.status<>'prepared' THEN
    PERFORM refuse('publish_not_prepared', format('publish preparation %s is %s', v_preparation.id, v_preparation.status));
  END IF;
  SELECT * INTO v_task FROM tasks WHERE id=v_preparation.task_id FOR UPDATE;
  IF v_task.status<>'approved' THEN
    PERFORM refuse('publish_not_prepared', format('task %s is %s, not approved', v_task.id, v_task.status));
  END IF;
  -- A later preparation of the same task supersedes this one: publish what was
  -- prepared last.
  IF EXISTS (SELECT 1 FROM publish_preparations later WHERE later.task_id=v_task.id
             AND later.requested_at>v_preparation.requested_at AND later.status IN ('requested','claimed','prepared')) THEN
    PERFORM refuse('publish_not_prepared', format('task %s has a later publish preparation', v_task.id));
  END IF;
  SELECT * INTO v_project FROM projects WHERE id=v_preparation.project_id;
  IF v_project.credential_mode<>'github_app' OR v_project.provider_connection_id IS NULL
     OR v_project.github_repository_id IS NULL OR COALESCE(v_project.repository_full_name,'')='' THEN
    PERFORM refuse('publish_unsupported_repository',
      format('project %s is %s; only a GitHub App repository is published by the platform', v_project.id, v_project.credential_mode));
  END IF;
  SELECT * INTO v_connection FROM provider_connections WHERE id=v_project.provider_connection_id;
  IF NOT FOUND OR v_connection.status<>'connected' THEN
    PERFORM refuse('publish_connection_unavailable',
      format('GitHub connection %s of project %s is %s', v_project.provider_connection_id, v_project.id, COALESCE(v_connection.status,'gone')));
  END IF;

  INSERT INTO publish_intents(project_id, task_id, preparation_id, head_commit_sha, branch_name, base_branch,
    repository_full_name, github_repository_id, connection_id, requested_by, correlation_id)
  VALUES(v_project.id, v_task.id, v_preparation.id, v_preparation.head_commit_sha, 'infra-cod/'||v_task.id,
    COALESCE(NULLIF(v_project.default_branch,''),'main'), v_project.repository_full_name,
    v_project.github_repository_id::bigint, v_connection.id, p_actor, p_correlation_id)
  RETURNING * INTO v_intent;
  v_event:=append_publish_event(v_intent, 'publish.requested', 'user', p_actor,
    jsonb_build_object('message', format('You asked to publish %s to %s and open a pull request against %s.',
      left(v_intent.head_commit_sha,12), v_intent.branch_name, v_intent.base_branch)));
  PERFORM write_audit_event(v_intent.project_id, v_intent.task_id, NULL, 'operator', p_actor, 'task.publish_requested',
    'publish_intent', v_intent.id::text, 'allowed', NULL,
    jsonb_build_object('preparation_id',v_preparation.id,'head_commit_sha',v_intent.head_commit_sha,
      'branch',v_intent.branch_name,'repository',v_intent.repository_full_name), p_correlation_id);
  RETURN jsonb_build_object('publish_intent_id',v_intent.id,'status',v_intent.status,'repeat',false,'event_id',v_event.id);
END $$;

CREATE FUNCTION retry_publish_intent(p_intent_id uuid, p_attempt integer, p_owner_id uuid, p_actor text, p_correlation_id text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO control_plane, public, extensions, pg_temp
AS $$
DECLARE v_intent publish_intents%ROWTYPE; v_task tasks%ROWTYPE; v_connection provider_connections%ROWTYPE; v_from text;
BEGIN
  SELECT i.* INTO v_intent FROM publish_intents i JOIN projects p ON p.id=i.project_id
  WHERE i.id=p_intent_id AND p.owner_id=p_owner_id FOR UPDATE OF i;
  IF NOT FOUND THEN
    PERFORM refuse('publish_intent_not_failed', format('no publish %s in a project this operator owns', p_intent_id));
  END IF;
  IF v_intent.status<>'failed' OR v_intent.attempt_count IS DISTINCT FROM p_attempt THEN
    PERFORM refuse('publish_intent_not_failed',
      format('publish %s is %s at attempt %s; the card showed attempt %s', v_intent.id, v_intent.status, v_intent.attempt_count, p_attempt));
  END IF;
  SELECT * INTO v_task FROM tasks WHERE id=v_intent.task_id;
  IF v_task.status<>'approved' THEN
    PERFORM refuse('publish_not_prepared', format('task %s is %s, not approved', v_task.id, v_task.status));
  END IF;
  SELECT * INTO v_connection FROM provider_connections WHERE id=v_intent.connection_id;
  IF NOT FOUND OR v_connection.status<>'connected' THEN
    PERFORM refuse('publish_connection_unavailable',
      format('GitHub connection %s is %s; reconnect it, then retry', v_intent.connection_id, COALESCE(v_connection.status,'gone')));
  END IF;
  v_from:=v_intent.failure_reason;
  UPDATE publish_intents SET status='requested', failure_reason=NULL, failure_message=NULL, finished_at=NULL,
    requested_at=clock_timestamp(), version=version+1
  WHERE id=v_intent.id RETURNING * INTO v_intent;
  PERFORM append_publish_event(v_intent, 'publish.retried', 'user', p_actor,
    jsonb_build_object('recovered_from',v_from,'message','You retried the publish that had stopped ('||v_from||').'));
  PERFORM write_audit_event(v_intent.project_id, v_intent.task_id, NULL, 'operator', p_actor, 'task.publish_retried',
    'publish_intent', v_intent.id::text, 'allowed', NULL, jsonb_build_object('recovered_from',v_from), p_correlation_id);
  RETURN jsonb_build_object('publish_intent_id',v_intent.id,'status',v_intent.status,'recovered_from',v_from);
END $$;

-- ------------------------------------------------------------- the broker

-- The next intent due, with what the broker needs to publish it and a GitHub
-- authorization it holds for the operation. An intent whose connection is not
-- connected fails here, with the reason, rather than being handed out.
CREATE FUNCTION claim_publish_intent(p_worker_id text, p_lease interval DEFAULT interval '5 minutes')
RETURNS jsonb
LANGUAGE plpgsql
SET search_path TO control_plane, public, extensions, pg_temp
AS $$
DECLARE v_intent publish_intents%ROWTYPE; v_auth jsonb; v_task tasks%ROWTYPE; v_report worker_completion_reports%ROWTYPE;
  v_evidence review_evidence%ROWTYPE; v_project projects%ROWTYPE;
BEGIN
  IF p_lease <= interval '0 seconds' OR p_lease > interval '30 minutes' THEN
    PERFORM refuse('publish_intent_not_claimed', 'a publish lease is between zero and thirty minutes', '22023');
  END IF;
  LOOP
    SELECT * INTO v_intent FROM publish_intents i
    WHERE i.status='requested' OR (i.status='claimed' AND i.leased_until<=clock_timestamp())
    ORDER BY i.requested_at, i.id FOR UPDATE SKIP LOCKED LIMIT 1;
    IF NOT FOUND THEN RETURN NULL; END IF;
    UPDATE publish_intents SET status='claimed', leased_by=p_worker_id, leased_until=clock_timestamp()+p_lease,
      attempt_count=attempt_count+1, version=version+1
    WHERE id=v_intent.id RETURNING * INTO v_intent;
    BEGIN
      v_auth:=acquire_github_clone_authorization(v_intent.project_id, p_worker_id);
    EXCEPTION WHEN object_not_in_prerequisite_state THEN
      v_auth:=NULL;
    END;
    IF v_auth IS NULL OR (v_auth->>'connection_id')::uuid IS DISTINCT FROM v_intent.connection_id THEN
      PERFORM fail_publish_intent(v_intent.id, p_worker_id, 'publish_connection_unavailable',
        'the project''s GitHub connection is not connected, or is no longer the one the publish was requested on');
      CONTINUE;
    END IF;
    UPDATE publish_intents SET authorization_id=(v_auth->>'authorization_id')::uuid WHERE id=v_intent.id
    RETURNING * INTO v_intent;
    EXIT;
  END LOOP;

  SELECT * INTO v_task FROM tasks WHERE id=v_intent.task_id;
  SELECT * INTO v_project FROM projects WHERE id=v_intent.project_id;
  SELECT e.* INTO v_evidence FROM publish_preparations pp JOIN review_evidence e ON e.id=pp.evidence_id
  WHERE pp.id=v_intent.preparation_id;
  SELECT * INTO v_report FROM worker_completion_reports r WHERE r.run_id=v_evidence.run_id
  ORDER BY r.submitted_at DESC LIMIT 1;
  RETURN jsonb_build_object(
    'id',v_intent.id,'attempt',v_intent.attempt_count,'project_id',v_intent.project_id,'task_id',v_intent.task_id,
    'head_commit_sha',v_intent.head_commit_sha,'branch',v_intent.branch_name,'base_branch',v_intent.base_branch,
    'repository_full_name',v_intent.repository_full_name,'github_repository_id',v_intent.github_repository_id,
    'repository_url',v_project.repository_url,
    'installation_id',v_auth->>'installation_id','authorization_id',v_intent.authorization_id,
    'title',left(v_task.title,240),
    'objective',v_task.objective,'acceptance_criteria',v_task.acceptance_criteria,
    'summary',v_report.result_summary,'diffstat',v_evidence.diffstat,
    'evidence_digest',v_evidence.evidence_digest);
END $$;

CREATE FUNCTION assert_publish_intent_claim(p_intent_id uuid, p_worker_id text)
RETURNS publish_intents
LANGUAGE plpgsql
SET search_path TO control_plane, public, extensions, pg_temp
AS $$
DECLARE v_intent publish_intents%ROWTYPE;
BEGIN
  SELECT * INTO v_intent FROM publish_intents WHERE id=p_intent_id FOR UPDATE;
  IF NOT FOUND OR v_intent.status<>'claimed' OR v_intent.leased_by IS DISTINCT FROM p_worker_id
     OR v_intent.leased_until<=clock_timestamp() THEN
    PERFORM refuse('publish_intent_not_claimed', format('publish %s is not claimed by %s', p_intent_id, p_worker_id));
  END IF;
  RETURN v_intent;
END $$;

-- What the supervisor needs to export the commit: the claim, checked by the
-- database, not by the broker that asks.
CREATE FUNCTION publish_export_target(p_intent_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path TO control_plane, public, extensions, pg_temp
AS $$
  SELECT jsonb_build_object('id',i.id,'project_id',i.project_id,'workspace_path',p.workspace_path,
    'head_commit_sha',i.head_commit_sha,'attempt',i.attempt_count)
  FROM publish_intents i JOIN projects p ON p.id=i.project_id
  WHERE i.id=p_intent_id AND i.status='claimed' AND i.leased_until>clock_timestamp()
    AND p.credential_mode='github_app' AND p.status NOT IN ('archived','deleting','deletion_failed','deleted');
$$;

-- The push landed: the ref and the commit, as a receipt, before the pull
-- request is asked for — so a pull request that fails leaves the push on record.
CREATE FUNCTION record_publish_push(p_intent_id uuid, p_worker_id text, p_ref text, p_sha text)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path TO control_plane, public, extensions, pg_temp
AS $$
DECLARE v_intent publish_intents%ROWTYPE; v_event domain_events%ROWTYPE;
BEGIN
  v_intent:=assert_publish_intent_claim(p_intent_id, p_worker_id);
  IF p_ref IS DISTINCT FROM 'refs/heads/'||v_intent.branch_name OR p_sha IS DISTINCT FROM v_intent.head_commit_sha THEN
    PERFORM refuse('publish_push_failed',
      format('publish %s pushes %s to refs/heads/%s; the receipt names %s at %s', v_intent.id, v_intent.head_commit_sha,
        v_intent.branch_name, COALESCE(p_sha,'nothing'), COALESCE(p_ref,'no ref')), '22023');
  END IF;
  IF v_intent.pushed_sha IS NOT NULL THEN
    RETURN jsonb_build_object('publish_intent_id',v_intent.id,'pushed_ref',v_intent.pushed_ref,'repeat',true);
  END IF;
  UPDATE publish_intents SET pushed_ref=p_ref, pushed_sha=p_sha, pushed_at=clock_timestamp(), version=version+1
  WHERE id=v_intent.id RETURNING * INTO v_intent;
  v_event:=append_publish_event(v_intent, 'publish.pushed', 'system', p_worker_id,
    jsonb_build_object('ref',p_ref,'message',format('Pushed %s to %s on %s.', left(p_sha,12), v_intent.branch_name,
      v_intent.repository_full_name)));
  RETURN jsonb_build_object('publish_intent_id',v_intent.id,'pushed_ref',p_ref,'event_id',v_event.id,'repeat',false);
END $$;

CREATE FUNCTION complete_publish_intent(p_intent_id uuid, p_worker_id text, p_pr_number integer, p_pr_url text)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path TO control_plane, public, extensions, pg_temp
AS $$
DECLARE v_intent publish_intents%ROWTYPE; v_event domain_events%ROWTYPE;
BEGIN
  v_intent:=assert_publish_intent_claim(p_intent_id, p_worker_id);
  IF v_intent.pushed_sha IS NULL THEN
    PERFORM refuse('publish_push_failed', format('publish %s has no recorded push to open a pull request from', v_intent.id));
  END IF;
  IF p_pr_number IS NULL OR p_pr_number <= 0 OR p_pr_url IS NULL
     OR p_pr_url !~ ('^https://[^/]+/'||replace(v_intent.repository_full_name,'.','\.')||'/pull/'||p_pr_number||'$') THEN
    PERFORM refuse('publish_pull_request_failed',
      format('publish %s: pull request %s at %s is not a pull request of %s', v_intent.id, p_pr_number, p_pr_url,
        v_intent.repository_full_name), '22023');
  END IF;
  UPDATE publish_intents SET status='published', pr_number=p_pr_number, pr_url=p_pr_url, leased_by=NULL, leased_until=NULL,
    finished_at=clock_timestamp(), version=version+1
  WHERE id=v_intent.id RETURNING * INTO v_intent;
  IF v_intent.authorization_id IS NOT NULL THEN
    PERFORM finalize_github_clone_authorization(v_intent.authorization_id, p_worker_id, true);
  END IF;
  v_event:=append_publish_event(v_intent, 'publish.pull_request_opened', 'system', p_worker_id,
    jsonb_build_object('pr_number',p_pr_number,'pr_url',p_pr_url,
      'message',format('Opened pull request #%s: %s', p_pr_number, p_pr_url)));
  PERFORM write_audit_event(v_intent.project_id, v_intent.task_id, NULL, 'system', p_worker_id, 'task.published',
    'publish_intent', v_intent.id::text, 'allowed', NULL,
    jsonb_build_object('head_commit_sha',v_intent.head_commit_sha,'ref',v_intent.pushed_ref,'pr_number',p_pr_number,
      'pr_url',p_pr_url), v_intent.correlation_id);
  RETURN jsonb_build_object('publish_intent_id',v_intent.id,'status',v_intent.status,'pr_number',p_pr_number,
    'pr_url',p_pr_url,'event_id',v_event.id);
END $$;

CREATE FUNCTION fail_publish_intent(p_intent_id uuid, p_worker_id text, p_reason text, p_message text)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path TO control_plane, public, extensions, pg_temp
AS $$
DECLARE v_intent publish_intents%ROWTYPE; v_note text;
BEGIN
  v_intent:=assert_publish_intent_claim(p_intent_id, p_worker_id);
  SELECT note INTO v_note FROM failure_reasons WHERE reason=p_reason;
  IF v_note IS NULL THEN
    PERFORM refuse('publish_push_failed', format('a publish failure named the reason %s, which is not in the vocabulary',
      COALESCE(p_reason,'(none)')), '22023');
  END IF;
  UPDATE publish_intents SET status='failed', failure_reason=p_reason, failure_message=left(COALESCE(p_message,''),1000),
    leased_by=NULL, leased_until=NULL, finished_at=clock_timestamp(), version=version+1
  WHERE id=v_intent.id RETURNING * INTO v_intent;
  IF v_intent.authorization_id IS NOT NULL THEN
    PERFORM finalize_github_clone_authorization(v_intent.authorization_id, p_worker_id, false);
  END IF;
  PERFORM append_publish_event(v_intent, 'publish.failed', 'system', p_worker_id,
    jsonb_build_object('reason',p_reason,'error',left(COALESCE(p_message,''),500),
      'message','The publish stopped: '||v_note||'.'));
  RETURN jsonb_build_object('publish_intent_id',v_intent.id,'status',v_intent.status,'failure_reason',p_reason);
END $$;

GRANT SELECT ON publish_intents TO infra_worker;
REVOKE EXECUTE ON FUNCTION refuse_published_intent_change() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION append_publish_event(publish_intents,text,text,text,jsonb) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION request_publish(uuid,uuid,text,text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION retry_publish_intent(uuid,integer,uuid,text,text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION claim_publish_intent(text,interval) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION assert_publish_intent_claim(uuid,text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION publish_export_target(uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION record_publish_push(uuid,text,text,text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION complete_publish_intent(uuid,text,integer,text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION fail_publish_intent(uuid,text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION request_publish(uuid,uuid,text,text) TO infra_web;
GRANT EXECUTE ON FUNCTION retry_publish_intent(uuid,integer,uuid,text,text) TO infra_web;
GRANT EXECUTE ON FUNCTION claim_publish_intent(text,interval) TO infra_worker;
GRANT EXECUTE ON FUNCTION publish_export_target(uuid) TO infra_worker;
GRANT EXECUTE ON FUNCTION record_publish_push(uuid,text,text,text) TO infra_worker;
GRANT EXECUTE ON FUNCTION complete_publish_intent(uuid,text,integer,text) TO infra_worker;
GRANT EXECUTE ON FUNCTION fail_publish_intent(uuid,text,text,text) TO infra_worker;
