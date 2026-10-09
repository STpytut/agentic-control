-- rc.145: a review of a pull request, by Codex's own review mode.
--
-- The owner asks from a chat for a review of an open pull request of the
-- project's GitHub repository. Nothing of it touches the project's workspace:
--   1. request_pr_review: the row, and `pr_review.requested` in the chat;
--   2. the GitHub broker (claim_pr_review_fetch) reads the pull request with a
--      read-only token, bundles its head and its base into an inbox the
--      supervisor made, and finishes the fetch (`pr_review.started`);
--   3. the review worker (claim_pr_reviews) has the supervisor run
--      `codex exec review --base` in a scratch repository built from the
--      bundle, read-only, and finishes it (`pr_review.completed` or
--      `pr_review.failed`) with the review and its findings;
--   4. on the owner's word only (request_pr_review_publish), the broker posts
--      the review as one comment on the pull request (`pr_review.published`).
--
-- The chat shows each event; none of them is routed to the orchestrator, so a
-- review never starts a turn. The model is the team's Codex: the project's
-- orchestrator default when it is Codex, else its first Codex executor.

SET search_path TO control_plane, public, extensions;

-- The role (the registry's, mirrored): Codex plays it.
ALTER TABLE runtime_role_core DROP CONSTRAINT runtime_role_core_role_check;
ALTER TABLE runtime_role_core ADD CONSTRAINT runtime_role_core_role_check CHECK (role IN ('orchestrator','executor','analyst','pr_reviewer'));
ALTER TABLE runtime_roles DROP CONSTRAINT runtime_roles_role_check;
ALTER TABLE runtime_roles ADD CONSTRAINT runtime_roles_role_check CHECK (role IN ('orchestrator','executor','analyst','pr_reviewer'));
-- capabilities.mjs ROLE_CORE.pr_reviewer
INSERT INTO runtime_role_core(role, capability) VALUES ('pr_reviewer','run.read_only'),('pr_reviewer','stream.structured')
ON CONFLICT DO NOTHING;
-- runtime-adapters.mjs roles
INSERT INTO runtime_roles(runtime_type, role) VALUES ('codex','pr_reviewer') ON CONFLICT DO NOTHING;

CREATE TABLE pr_reviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  task_id uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  pr_number integer NOT NULL CHECK (pr_number BETWEEN 1 AND 100000000),
  status text NOT NULL DEFAULT 'requested'
    CHECK (status IN ('requested','fetched','reviewing','reviewed','failed')),
  catalog_entry_id uuid REFERENCES provider_model_catalog(id) ON DELETE SET NULL,
  model text NOT NULL DEFAULT '' CHECK (length(model) <= 200),
  title text NOT NULL DEFAULT '' CHECK (length(title) <= 300),
  pr_url text NOT NULL DEFAULT '' CHECK (length(pr_url) <= 500),
  base_ref text NOT NULL DEFAULT '' CHECK (length(base_ref) <= 255),
  base_sha text CHECK (base_sha ~ '^[0-9a-f]{40}([0-9a-f]{24})?$'),
  head_sha text CHECK (head_sha ~ '^[0-9a-f]{40}([0-9a-f]{24})?$'),
  review text CHECK (length(review) <= 32000),
  findings jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(findings) = 'array'),
  failure text CHECK (length(failure) <= 500),
  attempts integer NOT NULL DEFAULT 0,
  leased_by text,
  leased_until timestamptz,
  publish_status text CHECK (publish_status IN ('requested','publishing','published','failed')),
  publish_attempts integer NOT NULL DEFAULT 0,
  publish_leased_until timestamptz,
  published_url text CHECK (length(published_url) <= 500),
  publish_error text CHECK (length(publish_error) <= 500),
  requested_by text NOT NULL DEFAULT '' CHECK (length(requested_by) <= 200),
  requested_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  finished_at timestamptz
);
CREATE INDEX pr_reviews_open ON pr_reviews(status, requested_at) WHERE status IN ('requested','fetched','reviewing');
CREATE INDEX pr_reviews_publish ON pr_reviews(publish_status) WHERE publish_status IN ('requested','publishing');
CREATE UNIQUE INDEX pr_reviews_one_open ON pr_reviews(task_id, pr_number) WHERE status IN ('requested','fetched','reviewing');

INSERT INTO failure_reasons(reason, code, note) VALUES
  ('pr_review_unavailable','conflict','the project has no GitHub repository the platform can read'),
  ('pr_review_needs_codex','conflict','no verified Codex model is on the project''s team to review with'),
  ('pr_review_invalid','invalid_argument','a pull request number is a positive whole number'),
  ('pr_review_not_ready','conflict','that review is not finished, or was published already'),
  ('pr_review_not_held','lease_lost','the review is not leased by this worker')
ON CONFLICT (reason) DO NOTHING;

-- The model a project's review runs on — of a runtime that plays the
-- pull request reviewer — or null.
CREATE FUNCTION pr_review_model(p_project_id uuid)
RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO control_plane, public, extensions, pg_temp
AS $$
  SELECT m.id FROM (
    SELECT d.orchestrator_entry_id AS entry_id, 0 AS rank FROM project_runtime_defaults d WHERE d.project_id = p_project_id
    UNION ALL
    SELECT e.catalog_entry_id, e.priority FROM project_runtime_default_executors e WHERE e.project_id = p_project_id
  ) candidate
  JOIN provider_model_catalog m ON m.id = candidate.entry_id
  WHERE runtime_plays(m.runtime_type, 'pr_reviewer') AND m.status = 'verified' AND m.superseded_by IS NULL
  ORDER BY candidate.rank, m.model_id LIMIT 1;
$$;

-- The owner, from a chat: review pull request #n of the project's repository.
-- The same pull request asked again from the same chat while its review is
-- still open is that review.
CREATE FUNCTION request_pr_review(p_project_id uuid, p_task_id uuid, p_owner_id uuid, p_pr_number integer, p_actor text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO control_plane, public, extensions, pg_temp
AS $$
DECLARE v_project projects%ROWTYPE; v_task tasks%ROWTYPE; v_entry uuid; v_review pr_reviews%ROWTYPE;
BEGIN
  SELECT * INTO v_project FROM projects WHERE id = p_project_id AND owner_id = p_owner_id AND status = 'active';
  IF NOT FOUND THEN PERFORM refuse('project_unavailable', format('project %s is not yours or not active', p_project_id)); END IF;
  SELECT * INTO v_task FROM tasks WHERE id = p_task_id AND project_id = p_project_id;
  IF NOT FOUND THEN PERFORM refuse('task_unavailable', format('task %s is not in project %s', p_task_id, p_project_id)); END IF;
  IF p_pr_number IS NULL OR p_pr_number < 1 OR p_pr_number > 100000000 THEN
    PERFORM refuse('pr_review_invalid', 'a pull request number is a positive whole number');
  END IF;
  IF v_project.github_repository_id IS NULL OR COALESCE(v_project.repository_full_name, '') = ''
     OR NOT EXISTS (SELECT 1 FROM provider_connections c WHERE c.id = v_project.provider_connection_id AND c.status = 'connected') THEN
    PERFORM refuse('pr_review_unavailable', format('project %s has no connected GitHub repository', p_project_id));
  END IF;
  SELECT * INTO v_review FROM pr_reviews
  WHERE task_id = p_task_id AND pr_number = p_pr_number AND status IN ('requested','fetched','reviewing');
  IF FOUND THEN RETURN jsonb_build_object('review_id', v_review.id, 'status', v_review.status, 'repeated', true); END IF;
  v_entry := pr_review_model(p_project_id);
  IF v_entry IS NULL THEN
    PERFORM refuse('pr_review_needs_codex', format('project %s has no verified Codex model on its team', p_project_id));
  END IF;
  BEGIN
    INSERT INTO pr_reviews(project_id, task_id, pr_number, catalog_entry_id, model, requested_by)
    VALUES (p_project_id, p_task_id, p_pr_number, v_entry,
      (SELECT model_id FROM provider_model_catalog WHERE id = v_entry), left(COALESCE(p_actor, ''), 200))
    RETURNING * INTO v_review;
  EXCEPTION WHEN unique_violation THEN
    -- The same pull request asked twice at once: the other ask's review.
    SELECT * INTO v_review FROM pr_reviews
    WHERE task_id = p_task_id AND pr_number = p_pr_number AND status IN ('requested','fetched','reviewing');
    RETURN jsonb_build_object('review_id', v_review.id, 'status', v_review.status, 'repeated', true);
  END;
  PERFORM append_event('pr_review.requested', p_project_id, p_task_id, NULL, 'user', left(COALESCE(p_actor, p_owner_id::text), 200), NULL,
    p_task_id::text, 'event:pr-review-requested:' || v_review.id, 'pr_review', v_review.id, 1,
    jsonb_build_object('review_id', v_review.id, 'pr_number', p_pr_number, 'model', v_review.model,
      'runtime_type', (SELECT runtime_type FROM provider_model_catalog WHERE id = v_entry),
      'repository', v_project.repository_full_name));
  RETURN jsonb_build_object('review_id', v_review.id, 'status', v_review.status, 'repeated', false);
END $$;

-- An event of a review, in its chat, from the platform.
CREATE FUNCTION pr_review_event(p_review pr_reviews, p_event_type text, p_version integer, p_payload jsonb)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO control_plane, public, extensions, pg_temp
AS $$
BEGIN
  PERFORM append_event(p_event_type, p_review.project_id, p_review.task_id, NULL, 'system', 'pr-review', NULL,
    p_review.task_id::text, 'event:' || p_event_type || ':' || p_review.id || ':' || p_version, 'pr_review', p_review.id, p_version,
    jsonb_build_object('review_id', p_review.id, 'pr_number', p_review.pr_number, 'title', p_review.title,
      'pr_url', p_review.pr_url, 'model', p_review.model,
      'runtime_type', (SELECT runtime_type FROM provider_model_catalog WHERE id = p_review.catalog_entry_id)) || p_payload);
END $$;

-- ------------------------------------------------------------ the broker

-- One review to fetch from GitHub, leased to the broker for ten minutes, with
-- what it needs to read the repository. A lease that ran out is taken again,
-- up to three attempts; the third failure fails the review.
CREATE FUNCTION claim_pr_review_fetch(p_worker_id text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO control_plane, public, extensions, pg_temp
AS $$
DECLARE v_review pr_reviews%ROWTYPE;
BEGIN
  FOR v_review IN UPDATE pr_reviews r SET status = 'failed', failure = 'reading the pull request from GitHub failed three times',
      finished_at = clock_timestamp(), leased_by = NULL, leased_until = NULL
    WHERE r.status = 'requested' AND r.attempts >= 3 AND (r.leased_until IS NULL OR r.leased_until <= clock_timestamp())
    RETURNING r.* LOOP
    PERFORM pr_review_event(v_review, 'pr_review.failed', 3, jsonb_build_object('failure', v_review.failure));
  END LOOP;
  SELECT r.* INTO v_review FROM pr_reviews r
  JOIN projects p ON p.id = r.project_id AND p.status = 'active'
  WHERE r.status = 'requested' AND r.attempts < 3 AND (r.leased_until IS NULL OR r.leased_until <= clock_timestamp())
  ORDER BY r.requested_at LIMIT 1 FOR UPDATE OF r SKIP LOCKED;
  IF NOT FOUND THEN RETURN NULL; END IF;
  UPDATE pr_reviews SET leased_by = left(p_worker_id, 200), leased_until = clock_timestamp() + interval '10 minutes',
    attempts = attempts + 1 WHERE id = v_review.id;
  RETURN (SELECT jsonb_build_object('review_id', r.id, 'project_id', r.project_id, 'pr_number', r.pr_number,
      'repository_full_name', p.repository_full_name, 'repository_url', p.repository_url,
      'github_repository_id', p.github_repository_id, 'installation_id', c.external_installation_id)
    FROM pr_reviews r JOIN projects p ON p.id = r.project_id
    LEFT JOIN provider_connections c ON c.id = p.provider_connection_id AND c.status = 'connected'
    WHERE r.id = v_review.id);
END $$;

-- What the broker read: the pull request's head and base, bundled into the
-- review's inbox — or why it could not.
CREATE FUNCTION finish_pr_review_fetch(p_review_id uuid, p_worker_id text, p_result jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO control_plane, public, extensions, pg_temp
AS $$
DECLARE v_review pr_reviews%ROWTYPE;
BEGIN
  SELECT * INTO v_review FROM pr_reviews WHERE id = p_review_id FOR UPDATE;
  IF NOT FOUND OR v_review.status <> 'requested' OR v_review.leased_by IS DISTINCT FROM p_worker_id THEN
    PERFORM refuse('pr_review_not_held', format('review %s is not being fetched by %s', p_review_id, p_worker_id));
  END IF;
  IF p_result->>'status' = 'fetched' THEN
    UPDATE pr_reviews SET status = 'fetched', leased_by = NULL, leased_until = NULL,
      title = left(COALESCE(p_result->>'title', ''), 300), pr_url = left(COALESCE(p_result->>'pr_url', ''), 500),
      base_ref = left(COALESCE(p_result->>'base_ref', ''), 255), base_sha = p_result->>'base_sha', head_sha = p_result->>'head_sha'
    WHERE id = p_review_id RETURNING * INTO v_review;
    PERFORM pr_review_event(v_review, 'pr_review.started', 2,
      jsonb_build_object('head_sha', v_review.head_sha, 'base_ref', v_review.base_ref));
  ELSE
    UPDATE pr_reviews SET status = 'failed', leased_by = NULL, leased_until = NULL, finished_at = clock_timestamp(),
      failure = left(COALESCE(NULLIF(p_result->>'failure', ''), 'the pull request could not be read'), 500)
    WHERE id = p_review_id RETURNING * INTO v_review;
    PERFORM pr_review_event(v_review, 'pr_review.failed', 3, jsonb_build_object('failure', v_review.failure));
  END IF;
  RETURN jsonb_build_object('review_id', v_review.id, 'status', v_review.status);
END $$;

-- For the supervisor's inbox: a review the broker is fetching now.
CREATE FUNCTION pr_review_inbox_target(p_review_id uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO control_plane, public, extensions, pg_temp
AS $$
  SELECT jsonb_build_object('review_id', r.id, 'project_id', r.project_id, 'status', r.status)
  FROM pr_reviews r WHERE r.id = p_review_id AND r.status = 'requested' AND r.leased_until > clock_timestamp();
$$;

-- For the supervisor's sweep: which of these reviews still need their inbox.
CREATE FUNCTION pr_reviews_open(p_ids uuid[])
RETURNS uuid[] LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO control_plane, public, extensions, pg_temp
AS $$
  SELECT COALESCE(array_agg(id), '{}') FROM pr_reviews WHERE id = ANY(p_ids) AND status IN ('requested','fetched','reviewing');
$$;

-- ------------------------------------------------------------ the review run

-- A fetched review to run, leased for twenty minutes. A run whose lease ran
-- out is the run's failure: Codex's review is not resumed.
CREATE FUNCTION claim_pr_reviews(p_worker_id text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO control_plane, public, extensions, pg_temp
AS $$
DECLARE v_review pr_reviews%ROWTYPE;
BEGIN
  FOR v_review IN UPDATE pr_reviews SET status = 'failed', failure = 'the review run stopped answering', finished_at = clock_timestamp(),
      leased_by = NULL, leased_until = NULL
    WHERE status = 'reviewing' AND leased_until <= clock_timestamp() RETURNING * LOOP
    PERFORM pr_review_event(v_review, 'pr_review.failed', 3, jsonb_build_object('failure', v_review.failure));
  END LOOP;
  SELECT * INTO v_review FROM pr_reviews WHERE status = 'fetched' ORDER BY requested_at LIMIT 1 FOR UPDATE SKIP LOCKED;
  IF NOT FOUND THEN RETURN NULL; END IF;
  UPDATE pr_reviews SET status = 'reviewing', leased_by = left(p_worker_id, 200), leased_until = clock_timestamp() + interval '20 minutes'
  WHERE id = v_review.id;
  RETURN jsonb_build_object('review_id', v_review.id);
END $$;

-- What the supervisor needs for the run, read under the worker's lease.
CREATE FUNCTION pr_review_run_context(p_review_id uuid, p_worker_id text)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path TO control_plane, public, extensions, pg_temp
AS $$
DECLARE v_context jsonb;
BEGIN
  SELECT jsonb_build_object('review_id', r.id, 'project_id', r.project_id, 'pr_number', r.pr_number, 'title', r.title,
      'base_ref', r.base_ref, 'base_sha', r.base_sha, 'head_sha', r.head_sha,
      'runtime_type', m.runtime_type, 'model', m.model_id, 'model_status', m.status,
      'repository', p.repository_full_name)
    INTO v_context
  FROM pr_reviews r JOIN projects p ON p.id = r.project_id
  LEFT JOIN provider_model_catalog m ON m.id = r.catalog_entry_id
  WHERE r.id = p_review_id AND r.status = 'reviewing' AND r.leased_by = p_worker_id AND r.leased_until > clock_timestamp();
  IF v_context IS NULL THEN PERFORM refuse('pr_review_not_held', format('review %s is not leased by %s', p_review_id, p_worker_id)); END IF;
  RETURN v_context;
END $$;

CREATE FUNCTION heartbeat_pr_review(p_review_id uuid, p_worker_id text)
RETURNS boolean LANGUAGE sql SECURITY DEFINER
SET search_path TO control_plane, public, extensions, pg_temp
AS $$
  UPDATE pr_reviews SET leased_until = clock_timestamp() + interval '20 minutes'
  WHERE id = p_review_id AND status = 'reviewing' AND leased_by = p_worker_id
  RETURNING true;
$$;

-- The review, or why there is none. Findings are kept as given, bounded.
CREATE FUNCTION finish_pr_review(p_review_id uuid, p_worker_id text, p_result jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO control_plane, public, extensions, pg_temp
AS $$
DECLARE v_review pr_reviews%ROWTYPE;
  v_text text := left(btrim(COALESCE(p_result->>'review', '')), 32000);
  v_findings jsonb := CASE WHEN jsonb_typeof(p_result->'findings') = 'array' AND octet_length((p_result->'findings')::text) <= 65536
    THEN p_result->'findings' ELSE '[]'::jsonb END;
BEGIN
  SELECT * INTO v_review FROM pr_reviews WHERE id = p_review_id FOR UPDATE;
  IF NOT FOUND OR v_review.status <> 'reviewing' OR v_review.leased_by IS DISTINCT FROM p_worker_id THEN
    PERFORM refuse('pr_review_not_held', format('review %s is not leased by %s', p_review_id, p_worker_id));
  END IF;
  IF p_result->>'status' = 'reviewed' AND v_text <> '' THEN
    UPDATE pr_reviews SET status = 'reviewed', review = v_text, findings = v_findings, finished_at = clock_timestamp(),
      model = left(COALESCE(NULLIF(p_result->>'model', ''), model), 200), leased_by = NULL, leased_until = NULL
    WHERE id = p_review_id RETURNING * INTO v_review;
    PERFORM pr_review_event(v_review, 'pr_review.completed', 3,
      jsonb_build_object('review', v_review.review, 'findings', v_review.findings, 'head_sha', v_review.head_sha));
  ELSE
    UPDATE pr_reviews SET status = 'failed', finished_at = clock_timestamp(), leased_by = NULL, leased_until = NULL,
      failure = left(COALESCE(NULLIF(p_result->>'failure', ''), 'Codex gave no review'), 500)
    WHERE id = p_review_id RETURNING * INTO v_review;
    PERFORM pr_review_event(v_review, 'pr_review.failed', 3, jsonb_build_object('failure', v_review.failure));
  END IF;
  RETURN jsonb_build_object('review_id', v_review.id, 'status', v_review.status);
END $$;

-- ------------------------------------------------------------ publishing

-- The owner's word: post this review on the pull request.
CREATE FUNCTION request_pr_review_publish(p_project_id uuid, p_owner_id uuid, p_review_id uuid, p_actor text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO control_plane, public, extensions, pg_temp
AS $$
DECLARE v_review pr_reviews%ROWTYPE;
BEGIN
  UPDATE pr_reviews r SET publish_status = 'requested', publish_error = NULL
  FROM projects p
  WHERE r.id = p_review_id AND r.project_id = p_project_id AND p.id = r.project_id AND p.owner_id = p_owner_id
    AND r.status = 'reviewed' AND (r.publish_status IS NULL OR r.publish_status = 'failed')
  RETURNING r.* INTO v_review;
  IF NOT FOUND THEN PERFORM refuse('pr_review_not_ready', format('review %s cannot be published now', p_review_id)); END IF;
  -- In the chat too, so its Publish button is gone while the post is on its
  -- way. Versions: each attempt n has 10+2n asked and 11+2n its outcome.
  PERFORM pr_review_event(v_review, 'pr_review.publish_requested', 10 + 2 * v_review.publish_attempts, '{}'::jsonb);
  PERFORM write_audit_event(p_project_id, v_review.task_id, NULL, 'user', left(COALESCE(p_actor, p_owner_id::text), 200),
    'pr_review.publish_requested', 'pr_review', p_review_id::text, 'allowed', NULL,
    jsonb_build_object('pr_number', v_review.pr_number), p_review_id::text);
  RETURN jsonb_build_object('review_id', p_review_id, 'publish_status', 'requested');
END $$;

CREATE FUNCTION claim_pr_review_publish(p_worker_id text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO control_plane, public, extensions, pg_temp
AS $$
DECLARE v_review pr_reviews%ROWTYPE;
BEGIN
  -- A post whose broker went quiet is not posted again: it may have reached
  -- GitHub already, and a second comment would repeat it. The owner checks
  -- the pull request and asks again.
  FOR v_review IN UPDATE pr_reviews SET publish_status = 'failed', publish_leased_until = NULL,
      publish_error = 'posting did not finish; check the pull request before posting again'
    WHERE publish_status = 'publishing' AND publish_leased_until <= clock_timestamp() RETURNING * LOOP
    PERFORM pr_review_event(v_review, 'pr_review.publish_failed', 9 + 2 * v_review.publish_attempts,
      jsonb_build_object('error', v_review.publish_error));
  END LOOP;
  SELECT r.* INTO v_review FROM pr_reviews r WHERE r.publish_status = 'requested'
  ORDER BY r.finished_at LIMIT 1 FOR UPDATE SKIP LOCKED;
  IF NOT FOUND THEN RETURN NULL; END IF;
  UPDATE pr_reviews SET publish_status = 'publishing', publish_attempts = publish_attempts + 1,
    publish_leased_until = clock_timestamp() + interval '2 minutes' WHERE id = v_review.id;
  RETURN (SELECT jsonb_build_object('review_id', r.id, 'pr_number', r.pr_number, 'review', r.review, 'model', r.model,
      'head_sha', r.head_sha, 'repository_full_name', p.repository_full_name, 'github_repository_id', p.github_repository_id,
      'installation_id', c.external_installation_id)
    FROM pr_reviews r JOIN projects p ON p.id = r.project_id
    LEFT JOIN provider_connections c ON c.id = p.provider_connection_id AND c.status = 'connected'
    WHERE r.id = v_review.id);
END $$;

CREATE FUNCTION finish_pr_review_publish(p_review_id uuid, p_url text, p_error text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO control_plane, public, extensions, pg_temp
AS $$
DECLARE v_review pr_reviews%ROWTYPE;
BEGIN
  -- Published only with the comment's address: an answer without one is not proof.
  IF p_error IS NULL AND COALESCE(p_url, '') !~ '^https://' THEN p_error := 'GitHub did not return the comment''s address'; END IF;
  UPDATE pr_reviews SET publish_status = CASE WHEN p_error IS NULL THEN 'published' ELSE 'failed' END,
    published_url = CASE WHEN p_error IS NULL THEN left(p_url, 500) END, publish_error = left(p_error, 500),
    publish_leased_until = NULL
  WHERE id = p_review_id AND publish_status = 'publishing' RETURNING * INTO v_review;
  IF NOT FOUND THEN PERFORM refuse('pr_review_not_ready', format('review %s is not being published', p_review_id)); END IF;
  PERFORM pr_review_event(v_review, CASE WHEN p_error IS NULL THEN 'pr_review.published' ELSE 'pr_review.publish_failed' END,
    9 + 2 * v_review.publish_attempts, jsonb_build_object('published_url', v_review.published_url, 'error', v_review.publish_error));
  RETURN jsonb_build_object('review_id', p_review_id, 'publish_status', v_review.publish_status);
END $$;

-- The panel: each review of a chat, for its buttons.
CREATE FUNCTION task_pr_reviews(p_project_id uuid, p_task_id uuid, p_owner_id uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO control_plane, public, extensions, pg_temp
AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object('review_id', r.id, 'pr_number', r.pr_number, 'status', r.status,
      'publish_status', r.publish_status, 'published_url', r.published_url, 'publish_error', r.publish_error)
    ORDER BY r.requested_at), '[]'::jsonb)
  FROM pr_reviews r JOIN projects p ON p.id = r.project_id
  WHERE r.project_id = p_project_id AND r.task_id = p_task_id AND p.owner_id = p_owner_id;
$$;

REVOKE ALL ON pr_reviews FROM PUBLIC;
REVOKE ALL ON FUNCTION pr_review_model(uuid), request_pr_review(uuid,uuid,uuid,integer,text), pr_review_event(pr_reviews,text,integer,jsonb),
  claim_pr_review_fetch(text), finish_pr_review_fetch(uuid,text,jsonb), claim_pr_reviews(text), pr_review_run_context(uuid,text),
  heartbeat_pr_review(uuid,text), finish_pr_review(uuid,text,jsonb), request_pr_review_publish(uuid,uuid,uuid,text),
  claim_pr_review_publish(text), finish_pr_review_publish(uuid,text,text), task_pr_reviews(uuid,uuid,uuid),
  pr_review_inbox_target(uuid), pr_reviews_open(uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION request_pr_review(uuid,uuid,uuid,integer,text), request_pr_review_publish(uuid,uuid,uuid,text),
  task_pr_reviews(uuid,uuid,uuid) TO infra_web;
GRANT EXECUTE ON FUNCTION claim_pr_review_fetch(text), finish_pr_review_fetch(uuid,text,jsonb), claim_pr_reviews(text),
  pr_review_run_context(uuid,text), heartbeat_pr_review(uuid,text), finish_pr_review(uuid,text,jsonb),
  claim_pr_review_publish(text), finish_pr_review_publish(uuid,text,text), pr_review_inbox_target(uuid), pr_reviews_open(uuid[]) TO infra_worker;
