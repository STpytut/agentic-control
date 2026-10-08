-- A map of each project's repository, for the orchestrator (rc.134).
--
-- Every new chat is a new orchestrator session, and each one began by
-- exploring: the directories, package.json, the README, the log — the same
-- commands in every chat, before a word about the task. The supervisor now
-- builds those facts from the workspace's last commit (repository-map.mjs)
-- after every implementation, sync with GitHub and provisioning, and records
-- them here; a new session is told them, with what the project's earlier tasks
-- did, in its first turn (turn-prompts.mjs).
--
-- One row per project: the newest map replaces the last. A map is data the
-- project wrote — names, a README, commit subjects — bounded in size here and
-- shown to the model as data.

SET search_path TO control_plane, public, extensions;

CREATE TABLE project_repository_maps (
  project_id uuid PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  head_sha text NOT NULL CHECK (head_sha ~ '^[0-9a-f]{40}([0-9a-f]{24})?$'),
  map jsonb NOT NULL CHECK (jsonb_typeof(map)='object' AND octet_length(map::text) <= 65536),
  source text NOT NULL CHECK (source IN ('implementation','sync','provision')),
  built_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

-- For the supervisor, which built the map as the workspace's owner. A map that
-- does not name a commit, or is too large, is not recorded; the caller never
-- fails its own work over that, so this refuses quietly with NULL.
CREATE FUNCTION record_repository_map(p_project_id uuid, p_source text, p_map jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO control_plane, public, extensions, pg_temp
AS $$
BEGIN
  IF p_map IS NULL OR jsonb_typeof(p_map)<>'object' OR octet_length(p_map::text) > 65536
     OR COALESCE(p_map->>'head_sha','') !~ '^[0-9a-f]{40}([0-9a-f]{24})?$'
     OR p_source NOT IN ('implementation','sync','provision')
     OR NOT EXISTS (SELECT 1 FROM projects WHERE id=p_project_id) THEN
    RETURN NULL;
  END IF;
  INSERT INTO project_repository_maps(project_id, head_sha, map, source, built_at)
  VALUES (p_project_id, p_map->>'head_sha', p_map, p_source, clock_timestamp())
  ON CONFLICT (project_id) DO UPDATE SET head_sha=EXCLUDED.head_sha, map=EXCLUDED.map,
    source=EXCLUDED.source, built_at=EXCLUDED.built_at;
  RETURN jsonb_build_object('head_sha', p_map->>'head_sha');
END $$;

-- For the orchestrator worker, under the turn's lease: the project's map, the
-- check the platform runs, and what the project's earlier tasks did — newest
-- first, with the files each changed and the pull request it became.
CREATE FUNCTION orchestrator_repository_context(p_job_id bigint, p_worker_id text)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path TO control_plane, public, extensions, pg_temp
AS $$
DECLARE v_project uuid; v_task uuid;
BEGIN
  SELECT j.project_id, j.task_id INTO v_project, v_task FROM runtime_jobs j
  WHERE j.id=p_job_id AND j.job_type IN ('orchestrator_turn','resume_orchestrator')
    AND j.status='in_flight' AND j.leased_by=p_worker_id AND j.leased_until>clock_timestamp();
  IF v_project IS NULL THEN
    PERFORM refuse('orchestration_job_not_leased',
      format('orchestration job %s is not actively leased by worker %s', p_job_id, p_worker_id));
  END IF;
  RETURN jsonb_build_object(
    'map', (SELECT m.map FROM project_repository_maps m WHERE m.project_id=v_project),
    'built_at', (SELECT m.built_at FROM project_repository_maps m WHERE m.project_id=v_project),
    'check_command', (SELECT p.check_command FROM projects p WHERE p.id=v_project),
    'recent_tasks', COALESCE((
      SELECT jsonb_agg(recent.item ORDER BY recent.updated_at DESC) FROM (
        SELECT jsonb_build_object('title', left(t.title, 200), 'status', t.status, 'updated_at', t.updated_at,
          'changed_files', COALESCE((
            SELECT jsonb_build_object('total', jsonb_array_length(e.changed_files),
              'paths', (SELECT COALESCE(jsonb_agg(shown.value->>'path'), '[]'::jsonb)
                        FROM (SELECT f.value FROM jsonb_array_elements(e.changed_files) AS f(value) LIMIT 8) shown))
            FROM review_evidence e WHERE e.task_id=t.id ORDER BY e.recorded_at DESC LIMIT 1), 'null'::jsonb),
          'pr_url', (SELECT i.pr_url FROM publish_intents i WHERE i.task_id=t.id AND i.status='published'
                     ORDER BY i.finished_at DESC LIMIT 1)) AS item, t.updated_at
        FROM tasks t
        WHERE t.project_id=v_project AND t.id<>v_task
          AND EXISTS (SELECT 1 FROM review_evidence e WHERE e.task_id=t.id)
        ORDER BY t.updated_at DESC LIMIT 8
      ) recent), '[]'::jsonb));
END $$;

-- For the Workspace page.
CREATE FUNCTION get_repository_map(p_project_id uuid, p_owner_id uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO control_plane, public, extensions, pg_temp
AS $$
  SELECT jsonb_build_object('head_sha', m.head_sha, 'map', m.map, 'source', m.source, 'built_at', m.built_at)
  FROM project_repository_maps m JOIN projects p ON p.id=m.project_id
  WHERE m.project_id=p_project_id AND p.owner_id=p_owner_id;
$$;

REVOKE ALL ON project_repository_maps FROM PUBLIC;
REVOKE ALL ON FUNCTION record_repository_map(uuid,text,jsonb), orchestrator_repository_context(bigint,text),
  get_repository_map(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION get_repository_map(uuid,uuid) TO infra_web;
GRANT EXECUTE ON FUNCTION record_repository_map(uuid,text,jsonb), orchestrator_repository_context(bigint,text) TO infra_worker;
