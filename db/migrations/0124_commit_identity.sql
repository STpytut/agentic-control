-- Who an executor's commits are by (battle test, chat 1). Nothing said, so the
-- model said it: Claude Code committed as `Claude <the subscription's email>`,
-- taken from its own context, and a publish would have put that address in a
-- public repository's history. The owner chose the GitHub App's bot: its
-- noreply address, which GitHub links to the App and to no person.
--
-- The GitHub App worker holds the App's key and asks GitHub once who the bot
-- is (GET /app, GET /users/<slug>[bot]); the supervisor reads the row when it
-- launches an executor and sets GIT_AUTHOR_* and GIT_COMMITTER_*, which win over
-- anything a model passes with `git -c`. One row: one App per installation.

SET search_path TO control_plane, public, extensions;

CREATE TABLE IF NOT EXISTS github_app_identity (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  app_id bigint NOT NULL CHECK (app_id > 0),
  slug text NOT NULL CHECK (slug ~ '^[a-z0-9][a-z0-9-]{0,99}$'),
  bot_user_id bigint NOT NULL CHECK (bot_user_id > 0),
  recorded_by text NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE OR REPLACE FUNCTION record_github_app_identity(
  p_worker text, p_app_id bigint, p_slug text, p_bot_user_id bigint
) RETURNS jsonb
LANGUAGE plpgsql
SET search_path = control_plane, public, extensions
AS $$
BEGIN
  INSERT INTO github_app_identity(singleton, app_id, slug, bot_user_id, recorded_by)
  VALUES (true, p_app_id, p_slug, p_bot_user_id, p_worker)
  ON CONFLICT (singleton) DO UPDATE
    SET app_id = EXCLUDED.app_id, slug = EXCLUDED.slug, bot_user_id = EXCLUDED.bot_user_id,
        recorded_by = EXCLUDED.recorded_by, recorded_at = clock_timestamp()
    WHERE (github_app_identity.app_id, github_app_identity.slug, github_app_identity.bot_user_id)
      IS DISTINCT FROM (EXCLUDED.app_id, EXCLUDED.slug, EXCLUDED.bot_user_id);
  RETURN commit_identity_for(NULL);
END;
$$;

-- The name and address a project's commits are by: the App's bot for a project
-- published through the App once its identity is known, else the platform's
-- own (the seed commit's, workspace-provisioning.mjs SEED_AUTHOR). Never null:
-- a launch without one would leave it to the model again.
CREATE OR REPLACE FUNCTION commit_identity_for(p_project_id uuid) RETURNS jsonb
LANGUAGE sql STABLE
SET search_path = control_plane, public, extensions
AS $$
  SELECT COALESCE(
    (SELECT jsonb_build_object(
       'name', gi.slug || '[bot]',
       'email', gi.bot_user_id || '+' || gi.slug || '[bot]@users.noreply.github.com',
       'source', 'github_app')
     FROM github_app_identity gi
     WHERE p_project_id IS NULL
        OR EXISTS (SELECT 1 FROM projects p WHERE p.id = p_project_id AND p.credential_mode = 'github_app')),
    jsonb_build_object('name', 'infra-cod', 'email', 'infra-cod@localhost', 'source', 'platform'));
$$;

REVOKE EXECUTE ON FUNCTION record_github_app_identity(text, bigint, text, bigint) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION commit_identity_for(uuid) FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON github_app_identity TO infra_worker;
GRANT EXECUTE ON FUNCTION record_github_app_identity(text, bigint, text, bigint) TO infra_worker;
GRANT EXECUTE ON FUNCTION commit_identity_for(uuid) TO infra_worker;
