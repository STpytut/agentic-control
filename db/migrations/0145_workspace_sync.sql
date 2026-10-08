-- Workspaces brought up to date with GitHub (rc.133).
--
-- A GitHub App project's workspace was cloned once and never fetched again: a
-- pull request merged with squash, or a commit pushed by someone else, was
-- never seen by the next task, which then built on an old tree. Now a sync is
-- asked for when a chat starts (and by the owner from the panel): the GitHub
-- broker fetches the base branch into a bundle — it never touches the
-- workspace — and the supervisor applies it as the workspace's owner, in the
-- workspace's turn, by the rules in workspace-sync.mjs: fast-forward when
-- behind, keep local commits not on GitHub, reset only when the trees are the
-- same or the owner asked (and then the local commits go to a backup branch).

SET search_path TO control_plane, public, extensions;

INSERT INTO failure_reasons(reason, code, note) VALUES
  ('workspace_sync_unsupported','conflict','only a project cloned through the GitHub App is synced with GitHub'),
  ('workspace_sync_not_held','lease_lost','this worker does not hold the workspace sync'),
  ('workspace_sync_busy','conflict','a sync of this workspace is running; ask again when it has finished')
ON CONFLICT (reason) DO NOTHING;

CREATE TABLE workspace_syncs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  mode text NOT NULL DEFAULT 'sync' CHECK (mode IN ('sync','reset')),
  requested_by text NOT NULL,
  status text NOT NULL DEFAULT 'requested' CHECK (status IN ('requested','claimed','synced','kept','failed')),
  base_branch text NOT NULL,
  origin_sha text,
  before_sha text,
  after_sha text,
  backup_ref text,
  outcome text CHECK (outcome IS NULL OR char_length(outcome) <= 500),
  leased_by text,
  leased_until timestamptz,
  attempts integer NOT NULL DEFAULT 0,
  requested_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  finished_at timestamptz,
  CHECK ((status IN ('synced','kept','failed')) = (finished_at IS NOT NULL))
);
-- One open sync per project: a second request while one is open is that one.
CREATE UNIQUE INDEX workspace_syncs_one_open ON workspace_syncs(project_id) WHERE status IN ('requested','claimed');
CREATE INDEX workspace_syncs_recent ON workspace_syncs(project_id, requested_at DESC);

-- Whether a run is in the workspace: an implementation holding its lock, or a
-- turn reading it under a live grant (a planning or review turn). A sync never
-- moves the tree under either.
CREATE FUNCTION workspace_in_use(p_project_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO control_plane, public, extensions, pg_temp
AS $$
  SELECT EXISTS (SELECT 1 FROM workspace_locks l WHERE l.project_id=p_project_id AND l.status='held')
      OR EXISTS (SELECT 1 FROM workspace_access_grants g WHERE g.project_id=p_project_id
                 AND g.revoked_at IS NULL AND g.expires_at > clock_timestamp());
$$;

-- A sync for the project, unless one is already open; a reset asked by the
-- owner replaces an open plain sync. Only GitHub App projects.
CREATE FUNCTION enqueue_workspace_sync(p_project_id uuid, p_mode text, p_requested_by text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO control_plane, public, extensions, pg_temp
AS $$
DECLARE v_project projects%ROWTYPE; v_id uuid;
BEGIN
  SELECT * INTO v_project FROM projects WHERE id=p_project_id;
  IF NOT FOUND OR v_project.credential_mode <> 'github_app' OR v_project.status IN ('archived','deleting','deletion_failed','deleted') THEN
    RETURN NULL;
  END IF;
  -- Two first tasks at once must not collide on the one-open index: the
  -- second finds the first's row instead of raising.
  INSERT INTO workspace_syncs(project_id, mode, requested_by, base_branch)
  VALUES (p_project_id, p_mode, p_requested_by, COALESCE(NULLIF(v_project.default_branch,''),'main'))
  ON CONFLICT (project_id) WHERE status IN ('requested','claimed') DO NOTHING
  RETURNING id INTO v_id;
  IF v_id IS NOT NULL THEN RETURN v_id; END IF;
  SELECT id INTO v_id FROM workspace_syncs WHERE project_id=p_project_id AND status IN ('requested','claimed') FOR UPDATE;
  IF p_mode = 'reset' THEN
    UPDATE workspace_syncs SET mode='reset', requested_by=p_requested_by WHERE id=v_id AND status='requested';
    IF NOT FOUND THEN
      PERFORM refuse('workspace_sync_busy', 'a sync of this workspace is running; ask for the reset when it has finished');
    END IF;
  END IF;
  RETURN v_id;
END $$;

-- A new chat starts from GitHub's state: its first task asks for a sync.
CREATE FUNCTION sync_on_new_chat()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO control_plane, public, extensions, pg_temp
AS $$
BEGIN
  -- A sync is a convenience; it never vetoes a task.
  BEGIN
    PERFORM enqueue_workspace_sync(NEW.project_id, 'sync', 'chat-start');
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
  RETURN NULL;
END $$;

CREATE TRIGGER tasks_sync_on_new_chat
  AFTER INSERT ON tasks
  FOR EACH ROW
  WHEN (NEW.followup_of_task_id IS NULL)
  EXECUTE FUNCTION sync_on_new_chat();

-- The panel: "Sync now", or "Reset to GitHub" after the sync said diverged.
CREATE FUNCTION request_workspace_sync(p_project_id uuid, p_owner_id uuid, p_mode text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO control_plane, public, extensions, pg_temp
AS $$
DECLARE v_id uuid;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM projects WHERE id=p_project_id AND owner_id=p_owner_id) THEN
    PERFORM refuse('project_unavailable', format('project %s is not one this operator owns', p_project_id));
  END IF;
  IF p_mode NOT IN ('sync','reset') THEN
    PERFORM refuse('workspace_sync_unsupported', 'a sync is "sync" or "reset"', '22023');
  END IF;
  v_id := enqueue_workspace_sync(p_project_id, p_mode, p_owner_id::text);
  IF v_id IS NULL THEN
    PERFORM refuse('workspace_sync_unsupported', 'only a project cloned through the GitHub App is synced with GitHub');
  END IF;
  PERFORM write_audit_event(p_project_id,NULL,NULL,'operator',p_owner_id::text,'workspace.sync_requested',
    'workspace_sync',v_id::text,'allowed',NULL,jsonb_build_object('mode',p_mode),'workspace-sync:'||v_id);
  RETURN jsonb_build_object('sync_id', v_id);
END $$;

-- The latest sync of a project, for the Workspace page.
CREATE FUNCTION get_workspace_sync(p_project_id uuid, p_owner_id uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO control_plane, public, extensions, pg_temp
AS $$
  SELECT to_jsonb(s) - 'leased_by' - 'leased_until'
  FROM workspace_syncs s JOIN projects p ON p.id=s.project_id
  WHERE s.project_id=p_project_id AND p.owner_id=p_owner_id
  ORDER BY s.requested_at DESC LIMIT 1;
$$;

-- The broker's claim: a requested sync whose workspace no run holds. A run in
-- progress keeps it waiting; a sync never moves a tree under a run.
CREATE FUNCTION claim_workspace_sync(p_worker_id text, p_lease interval DEFAULT interval '5 minutes')
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO control_plane, public, extensions, pg_temp
AS $$
DECLARE v_sync workspace_syncs%ROWTYPE; v_project projects%ROWTYPE;
BEGIN
  -- A claim whose lease ran out is offered again, three times in all; then it
  -- is failed, so a sync that keeps breaking does not hold every new chat's.
  UPDATE workspace_syncs SET status='failed', finished_at=clock_timestamp(), leased_by=NULL, leased_until=NULL,
    outcome=COALESCE(outcome, 'the sync did not finish after three attempts')
  WHERE status='claimed' AND leased_until < clock_timestamp() AND attempts >= 3;
  UPDATE workspace_syncs SET status='requested', leased_by=NULL, leased_until=NULL
  WHERE status='claimed' AND leased_until < clock_timestamp();
  SELECT s.* INTO v_sync FROM workspace_syncs s
  WHERE s.status='requested' AND NOT workspace_in_use(s.project_id)
  ORDER BY s.requested_at LIMIT 1 FOR UPDATE SKIP LOCKED;
  IF NOT FOUND THEN RETURN NULL; END IF;
  UPDATE workspace_syncs SET status='claimed', leased_by=p_worker_id, leased_until=clock_timestamp()+p_lease,
    attempts=attempts+1
  WHERE id=v_sync.id RETURNING * INTO v_sync;
  SELECT * INTO v_project FROM projects WHERE id=v_sync.project_id;
  RETURN jsonb_build_object('sync_id',v_sync.id,'project_id',v_sync.project_id,'mode',v_sync.mode,
    'base_branch',v_sync.base_branch,'repository_url',v_project.repository_url,'attempts',v_sync.attempts);
END $$;

-- For the supervisor: the claimed sync it is asked to apply, and where.
CREATE FUNCTION workspace_sync_target(p_sync_id uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO control_plane, public, extensions, pg_temp
AS $$
  SELECT jsonb_build_object('sync_id',s.id,'project_id',s.project_id,'workspace_path',p.workspace_path,
    'mode',s.mode,'base_branch',s.base_branch,
    'run_holds_workspace',workspace_in_use(s.project_id))
  FROM workspace_syncs s JOIN projects p ON p.id=s.project_id
  WHERE s.id=p_sync_id AND s.status='claimed' AND s.leased_until > clock_timestamp();
$$;

CREATE FUNCTION finish_workspace_sync(p_sync_id uuid, p_result jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO control_plane, public, extensions, pg_temp
AS $$
DECLARE v_status text := p_result->>'status'; v_sync workspace_syncs%ROWTYPE;
BEGIN
  IF v_status NOT IN ('synced','kept','failed') THEN v_status := 'failed'; END IF;
  UPDATE workspace_syncs SET status=v_status, finished_at=clock_timestamp(), leased_by=NULL, leased_until=NULL,
    origin_sha=p_result->>'origin_sha', before_sha=p_result->>'before_sha', after_sha=p_result->>'after_sha',
    backup_ref=p_result->>'backup_ref', outcome=left(COALESCE(p_result->>'outcome',''),500)
  WHERE id=p_sync_id AND status='claimed' RETURNING * INTO v_sync;
  IF NOT FOUND THEN PERFORM refuse('workspace_sync_not_held', 'the workspace sync is not claimed'); END IF;
  PERFORM write_audit_event(v_sync.project_id,NULL,NULL,'system','workspace-sync','workspace.synced',
    'workspace_sync',v_sync.id::text,'allowed',NULL,
    jsonb_build_object('status',v_status,'mode',v_sync.mode,'before',v_sync.before_sha,'after',v_sync.after_sha,'backup',v_sync.backup_ref),
    'workspace-sync:'||v_sync.id);
  RETURN jsonb_build_object('status',v_status);
END $$;

REVOKE ALL ON workspace_syncs FROM PUBLIC;
REVOKE ALL ON FUNCTION workspace_in_use(uuid), enqueue_workspace_sync(uuid,text,text), sync_on_new_chat(), request_workspace_sync(uuid,uuid,text),
  get_workspace_sync(uuid,uuid), claim_workspace_sync(text,interval), workspace_sync_target(uuid),
  finish_workspace_sync(uuid,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION request_workspace_sync(uuid,uuid,text), get_workspace_sync(uuid,uuid) TO infra_web;
GRANT EXECUTE ON FUNCTION claim_workspace_sync(text,interval), workspace_sync_target(uuid), finish_workspace_sync(uuid,jsonb) TO infra_worker;
