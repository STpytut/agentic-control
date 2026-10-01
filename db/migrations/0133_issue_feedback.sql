-- The loop back to GitHub (docs/ISSUE_INTAKE_DESIGN.md, I2).
--
-- A chat started from an issue says so on the issue, once, and says again when
-- its pull request opens; that pull request's body closes the issue when it
-- is merged. The comments are an outbox the GitHub App worker drains: a
-- failure is retried a few times and then left, recorded, rather than lost.

SET search_path TO control_plane, public, extensions;

INSERT INTO failure_reasons(reason, code, note) VALUES
  ('issue_comment_kind_unknown','invalid_argument','an issue comment is about the start or the pull request')
ON CONFLICT (reason) DO NOTHING;

ALTER TABLE issue_links
  ADD COLUMN started_comment_at timestamptz,
  ADD COLUMN pull_request_comment_at timestamptz,
  ADD COLUMN comment_attempts integer NOT NULL DEFAULT 0 CHECK (comment_attempts >= 0),
  ADD COLUMN comment_error text,
  ADD COLUMN comment_leased_until timestamptz;

-- The issue a task works on: its own, or the one its conversation started
-- from — a follow-up in the same chat is the same work.
CREATE OR REPLACE FUNCTION issue_for_task(p_task_id uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO control_plane, public, extensions, pg_temp AS $$
  SELECT jsonb_build_object('number', l.issue_number, 'url', l.html_url)
  FROM issue_links l
  JOIN tasks started ON started.id = l.task_id
  JOIN tasks t ON t.id = p_task_id
  WHERE l.status = 'started'
    AND (l.task_id = p_task_id OR (t.conversation_id IS NOT NULL AND started.conversation_id = t.conversation_id))
  ORDER BY l.decided_at DESC
  LIMIT 1;
$$;

-- What the issues should hear: a started chat not yet announced, and a chat
-- whose pull request opened and was not announced either.
CREATE OR REPLACE FUNCTION claim_issue_comments(p_worker_id text, p_limit integer DEFAULT 5)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO control_plane, public, extensions, pg_temp AS $$
DECLARE v_claimed jsonb;
BEGIN
  WITH pending AS (
    SELECT l.id, l.project_id, l.issue_number, l.task_id,
      CASE WHEN l.started_comment_at IS NULL THEN 'started' ELSE 'pull_request' END AS kind,
      pr.pr_url, pr.pr_number
    FROM issue_links l
    JOIN projects p ON p.id = l.project_id AND p.status = 'active'
    JOIN tasks t ON t.id = l.task_id
    LEFT JOIN LATERAL (
      SELECT i.pr_url, i.pr_number FROM publish_intents i JOIN tasks it ON it.id = i.task_id
      WHERE i.status = 'published' AND i.pr_url IS NOT NULL
        AND (i.task_id = l.task_id OR (t.conversation_id IS NOT NULL AND it.conversation_id = t.conversation_id))
      ORDER BY i.finished_at DESC NULLS LAST LIMIT 1
    ) pr ON true
    WHERE l.status = 'started' AND l.comment_attempts < 5
      AND (l.comment_leased_until IS NULL OR l.comment_leased_until <= clock_timestamp())
      AND (l.started_comment_at IS NULL OR (l.pull_request_comment_at IS NULL AND pr.pr_url IS NOT NULL))
    ORDER BY l.decided_at
    LIMIT GREATEST(LEAST(p_limit, 20), 1)
    FOR UPDATE OF l SKIP LOCKED
  ), leased AS (
    UPDATE issue_links l SET comment_leased_until = clock_timestamp() + interval '2 minutes'
    FROM pending WHERE l.id = pending.id
    RETURNING l.id
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'id', pending.id, 'kind', pending.kind, 'issue_number', pending.issue_number,
      'task_id', pending.task_id, 'project_id', pending.project_id,
      'pr_url', pending.pr_url, 'pr_number', pending.pr_number,
      'repository_full_name', p.repository_full_name, 'github_repository_id', p.github_repository_id,
      'installation_id', c.external_installation_id)), '[]'::jsonb)
  INTO v_claimed
  FROM pending JOIN leased ON leased.id = pending.id
  JOIN projects p ON p.id = pending.project_id
  JOIN provider_connections c ON c.id = p.provider_connection_id AND c.status = 'connected';
  RETURN v_claimed;
END $$;

CREATE OR REPLACE FUNCTION record_issue_comment(p_link_id uuid, p_kind text, p_error text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO control_plane, public, extensions, pg_temp AS $$
BEGIN
  IF p_kind NOT IN ('started', 'pull_request') THEN
    PERFORM refuse('issue_comment_kind_unknown', 'an issue comment is about the start or the pull request', '22023');
  END IF;
  UPDATE issue_links SET comment_leased_until = NULL,
    started_comment_at = CASE WHEN p_kind = 'started' AND p_error IS NULL THEN clock_timestamp() ELSE started_comment_at END,
    pull_request_comment_at = CASE WHEN p_kind = 'pull_request' AND p_error IS NULL THEN clock_timestamp() ELSE pull_request_comment_at END,
    comment_attempts = CASE WHEN p_error IS NULL THEN 0 ELSE comment_attempts + 1 END,
    comment_error = left(p_error, 500)
  WHERE id = p_link_id;
  RETURN jsonb_build_object('id', p_link_id, 'kind', p_kind, 'ok', p_error IS NULL);
END $$;

REVOKE ALL ON FUNCTION issue_for_task(uuid), claim_issue_comments(text,integer), record_issue_comment(uuid,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION issue_for_task(uuid), claim_issue_comments(text,integer), record_issue_comment(uuid,text,text) TO infra_worker;
