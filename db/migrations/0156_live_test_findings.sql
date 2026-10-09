-- rc.148: findings of rc.146/147's live tests in Focus Timer.
--
-- * A refusal of the platform's policy hook (rc.144) was only in the live
--   activity feed, gone from the chat once the run ended. Each one is now an
--   event of the chat too (`run.policy_refused`).
-- * A published pull request carried the commits of an earlier one still open
--   (focus-timer #15 carried #14's): the workspace's approved commits are a
--   chain. The broker reads the project's earlier published pull requests
--   (earlier_published_intents) and says so in the new one's description.

SET search_path TO control_plane, public, extensions;

CREATE FUNCTION run_policy_refused_event()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO control_plane, public, extensions, pg_temp
AS $$
BEGIN
  IF NEW.task_id IS NULL THEN RETURN NULL; END IF;
  PERFORM append_event('run.policy_refused', NEW.project_id, NEW.task_id, NEW.run_id, 'system', 'policy-hook', NULL,
    NEW.task_id::text, 'event:policy-refused:' || NEW.id, 'runtime_activity', gen_random_uuid(), 1,
    jsonb_build_object('tool', left(COALESCE(NEW.details->>'tool', ''), 80), 'reason', left(COALESCE(NEW.details->>'reason', ''), 200)));
  RETURN NULL;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'policy refusal % was not recorded in the chat: %', NEW.id, SQLERRM;
  RETURN NULL;
END $$;
CREATE TRIGGER runtime_activity_events_policy_refused AFTER INSERT ON runtime_activity_events
  FOR EACH ROW WHEN (NEW.event_type = 'runtime.policy.refused')
  EXECUTE FUNCTION run_policy_refused_event();

-- The project's earlier pull requests the platform opened, newest first: the
-- broker asks GitHub which are still open and contain no commit the new one
-- lacks — those it names in the new one's description.
CREATE FUNCTION earlier_published_intents(p_intent_id uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO control_plane, public, extensions, pg_temp
AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object('number', e.pr_number, 'url', e.pr_url, 'sha', e.pushed_sha)
    ORDER BY e.finished_at DESC), '[]'::jsonb)
  FROM (SELECT o.pr_number, o.pr_url, o.pushed_sha, o.finished_at FROM publish_intents i
        JOIN publish_intents o ON o.project_id = i.project_id AND o.id <> i.id
        WHERE i.id = p_intent_id AND o.status = 'published' AND o.pr_number IS NOT NULL
          AND o.pushed_sha ~ '^[0-9a-f]{40}$'
        ORDER BY o.finished_at DESC NULLS LAST LIMIT 10) e;
$$;

REVOKE ALL ON FUNCTION run_policy_refused_event(), earlier_published_intents(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION earlier_published_intents(uuid) TO infra_worker;
