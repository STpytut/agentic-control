-- The project's team, changed from the panel (Stage 11.5, sprint C U2;
-- exit criterion 10; ADR-0017).
--
-- A project's team is fixed when the project is made: one orchestrator
-- assignment and its executors (create_project_with_roster), and the models
-- they run by default (project_runtime_defaults, whose orchestrator entry is
-- the orchestrator's model and whose executor entries are the executors'
-- models, matched by position — the n-th enabled executor, by creation, runs
-- the n-th default, by priority; capture_task_runtime_snapshot and
-- project_readiness read it that way). The panel could change the models
-- (set_project_runtime_defaults) and nothing else, and could not say why a
-- model it did not offer was not offered.
--
-- What the operator can now do, each through one audited, owner-checked,
-- version-checked function that keeps the positions matched:
--
--   add_project_executor           a new executor on a verified model: a
--                                  structural profile for its runtime, an
--                                  agent, an assignment with the built-in
--                                  Executor definition, and the model as the
--                                  last default — the new last executor.
--   change_project_assignment_model  another verified model of the same
--                                  runtime for the orchestrator or one
--                                  executor, in its own position.
--   disable_project_executor       an executor out of the team, with its
--                                  default: refused for the last executor and
--                                  for one an open task is bound to.
--
-- And one read, project_team, for the tab: the assignments with their role's
-- permissions and the capabilities those need, what each runtime declares,
-- and every model the operator could pick for each role with the reason one
-- cannot be picked. The version the writes expect is the defaults' version:
-- every change to the team bumps it, so a card left open across another
-- change is refused, not applied to a team it did not show.
--
-- Roles are the built-in definitions only (decision C1). A runtime is chosen
-- by the model: changing an assignment to another runtime's model is refused
-- with the way to do it — add an executor on that runtime and disable this one.
-- Running tasks keep their snapshot (0028): the team as changed applies to new
-- tasks. The database stays the boundary: 0079's triggers still refuse a
-- second default orchestrator, a forbidden combination and a runtime without
-- a role's capabilities, whatever called.

SET search_path TO control_plane, public, extensions;

INSERT INTO failure_reasons(reason, code, note) VALUES
  ('project_team_unmanaged','conflict','this project has no catalog defaults, so its team is fixed; set its models in Settings first'),
  ('team_assignment_unavailable','not_found','no enabled assignment of that kind in this project'),
  ('team_last_executor','conflict','a project keeps at least one enabled executor'),
  ('team_assignment_in_use','conflict','an open task is bound to this executor; finish or close it first'),
  ('team_model_in_use','conflict','another executor of this project already runs that model');

-- The team's lock and version: the project row and its defaults, the version
-- the card showed. Every writer below starts here.
CREATE FUNCTION lock_project_team(p_project_id uuid, p_owner_id uuid, p_expected_version bigint)
RETURNS project_runtime_defaults
LANGUAGE plpgsql
SET search_path TO control_plane, public, extensions, pg_temp
AS $$
DECLARE v_defaults project_runtime_defaults%ROWTYPE;
BEGIN
  PERFORM 1 FROM projects p WHERE p.id=p_project_id AND p.owner_id=p_owner_id
    AND p.status NOT IN ('archived','deleting','deletion_failed','deleted') FOR UPDATE;
  IF NOT FOUND THEN
    PERFORM refuse('project_unavailable', format('no project %s this operator owns', p_project_id));
  END IF;
  SELECT * INTO v_defaults FROM project_runtime_defaults d WHERE d.project_id=p_project_id FOR UPDATE;
  IF NOT FOUND THEN
    PERFORM refuse('project_team_unmanaged', format('project %s has no catalog defaults', p_project_id));
  END IF;
  IF p_expected_version IS DISTINCT FROM v_defaults.version THEN
    PERFORM refuse('runtime_defaults_version_stale',
      format('the team is at version %s; the card showed %s', v_defaults.version, p_expected_version), '40001');
  END IF;
  RETURN v_defaults;
END $$;

-- The enabled executors in the order the snapshot matches them to defaults,
-- and the defaults in theirs.
CREATE FUNCTION project_executor_positions(p_project_id uuid)
RETURNS TABLE(ordinal bigint, assignment_id uuid, runtime_type text)
LANGUAGE sql
STABLE
SET search_path TO control_plane, public, extensions, pg_temp
AS $$
  SELECT row_number() OVER (ORDER BY pa.created_at, pa.id), pa.id, rp.runtime_type
  FROM project_agent_assignments pa JOIN runtime_profiles rp ON rp.id=pa.runtime_profile_id
  WHERE pa.project_id=p_project_id AND pa.enabled AND role_holds(pa.role_definition_id,'implementation.execute')
  ORDER BY pa.created_at, pa.id;
$$;

CREATE FUNCTION project_default_executor_positions(p_project_id uuid)
RETURNS TABLE(ordinal bigint, catalog_entry_id uuid, priority integer)
LANGUAGE sql
STABLE
SET search_path TO control_plane, public, extensions, pg_temp
AS $$
  SELECT row_number() OVER (ORDER BY d.priority, d.catalog_entry_id), d.catalog_entry_id, d.priority
  FROM project_runtime_default_executors d WHERE d.project_id=p_project_id
  ORDER BY d.priority, d.catalog_entry_id;
$$;

-- A model the operator may pick: theirs, verified, its connection connected
-- (resolve_catalog_snapshot_entry refuses the rest, as a snapshot would).
CREATE FUNCTION team_model(p_owner_id uuid, p_entry_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path TO control_plane, public, extensions, pg_temp
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM provider_model_catalog m WHERE m.id=p_entry_id AND m.operator_id=p_owner_id) THEN
    PERFORM refuse('catalog_entry_unavailable', format('no model %s in this operator''s catalog', p_entry_id));
  END IF;
  RETURN resolve_catalog_snapshot_entry(p_entry_id);
END $$;

CREATE FUNCTION bump_project_team(p_project_id uuid, p_owner_id uuid, p_actor text, p_correlation_id text,
  p_change text, p_details jsonb)
RETURNS bigint
LANGUAGE plpgsql
SET search_path TO control_plane, public, extensions, pg_temp
AS $$
DECLARE v_version bigint;
BEGIN
  UPDATE project_runtime_defaults SET version=version+1, updated_by=COALESCE(NULLIF(p_actor,''),p_owner_id::text),
    updated_at=clock_timestamp()
  WHERE project_id=p_project_id RETURNING version INTO v_version;
  PERFORM write_audit_event(p_project_id,NULL,NULL,'operator',COALESCE(NULLIF(p_actor,''),p_owner_id::text),
    'project.team_changed','project',p_project_id::text,'allowed',NULL,
    jsonb_build_object('change',p_change,'version',v_version) || p_details,
    COALESCE(NULLIF(p_correlation_id,''),p_project_id::text));
  RETURN v_version;
END $$;

-- ------------------------------------------------------------------ writes

CREATE FUNCTION add_project_executor(p_project_id uuid, p_owner_id uuid, p_expected_version bigint,
  p_entry_id uuid, p_actor text, p_correlation_id text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO control_plane, public, extensions, pg_temp
AS $$
DECLARE v_entry jsonb; v_runtime text; v_definition uuid; v_profile uuid; v_agent uuid; v_assignment uuid;
  v_count integer; v_priority integer; v_version bigint;
BEGIN
  PERFORM lock_project_team(p_project_id, p_owner_id, p_expected_version);
  SELECT count(*) INTO v_count FROM project_executor_positions(p_project_id);
  IF v_count >= 8 THEN
    PERFORM refuse('runtime_defaults_invalid', 'a project has at most eight executors', '22023');
  END IF;
  v_entry:=team_model(p_owner_id, p_entry_id);
  v_runtime:=v_entry->>'runtime_type';
  IF NOT runtime_plays(v_runtime,'executor') THEN
    PERFORM refuse('runtime_cannot_play_role', format('%s does not play the executor', v_runtime), '22023');
  END IF;
  SELECT id INTO v_definition FROM role_definitions WHERE builtin_key='executor';
  IF NOT assignment_may(v_runtime, v_definition) THEN
    PERFORM refuse('runtime_cannot_play_role',
      format('%s lacks a capability the Executor role needs', v_runtime), '22023');
  END IF;
  IF EXISTS (SELECT 1 FROM project_runtime_default_executors d WHERE d.project_id=p_project_id AND d.catalog_entry_id=p_entry_id) THEN
    PERFORM refuse('team_model_in_use', format('another executor of project %s already runs %s', p_project_id, v_entry->>'model_id'));
  END IF;

  v_profile:=ensure_structural_runtime_profile(p_owner_id, v_runtime);
  INSERT INTO agents(name, runtime_profile_id)
  VALUES('executor-'||v_runtime||'-'||left(gen_random_uuid()::text,8)||'-'||p_project_id, v_profile)
  RETURNING id INTO v_agent;
  -- clock_timestamp, not the transaction's now(): the new executor is the last
  -- by creation, which is the position its default takes below.
  INSERT INTO project_agent_assignments(project_id, agent_id, runtime_profile_id, role_definition_id, created_at, updated_at)
  VALUES(p_project_id, v_agent, v_profile, v_definition, clock_timestamp(), clock_timestamp())
  RETURNING id INTO v_assignment;
  SELECT COALESCE(max(priority),0)+100 INTO v_priority FROM project_runtime_default_executors WHERE project_id=p_project_id;
  INSERT INTO project_runtime_default_executors(project_id, catalog_entry_id, priority)
  VALUES(p_project_id, p_entry_id, v_priority);

  v_version:=bump_project_team(p_project_id, p_owner_id, p_actor, p_correlation_id, 'executor_added',
    jsonb_build_object('assignment_id',v_assignment,'entry_id',p_entry_id,'runtime',v_runtime));
  RETURN jsonb_build_object('project_id',p_project_id,'assignment_id',v_assignment,'version',v_version,'status','added');
END $$;

CREATE FUNCTION change_project_assignment_model(p_project_id uuid, p_owner_id uuid, p_expected_version bigint,
  p_assignment_id uuid, p_entry_id uuid, p_actor text, p_correlation_id text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO control_plane, public, extensions, pg_temp
AS $$
DECLARE v_assignment project_agent_assignments%ROWTYPE; v_runtime text; v_entry jsonb; v_ordinal bigint;
  v_old uuid; v_priority integer; v_version bigint; v_role text;
BEGIN
  PERFORM lock_project_team(p_project_id, p_owner_id, p_expected_version);
  SELECT pa.* INTO v_assignment FROM project_agent_assignments pa
  WHERE pa.id=p_assignment_id AND pa.project_id=p_project_id AND pa.enabled;
  IF NOT FOUND THEN
    PERFORM refuse('team_assignment_unavailable', format('no enabled assignment %s in project %s', p_assignment_id, p_project_id));
  END IF;
  SELECT runtime_type INTO v_runtime FROM runtime_profiles WHERE id=v_assignment.runtime_profile_id;
  v_entry:=team_model(p_owner_id, p_entry_id);
  IF v_entry->>'runtime_type' IS DISTINCT FROM v_runtime THEN
    PERFORM refuse('runtime_default_not_assigned',
      format('this assignment runs on %s and %s is a %s model: add an executor on %s and disable this one',
        v_runtime, v_entry->>'model_id', v_entry->>'runtime_type', v_entry->>'runtime_type'), '22023');
  END IF;

  IF role_holds(v_assignment.role_definition_id,'conversation.hold') THEN
    v_role:='orchestrator';
    IF NOT runtime_plays(v_runtime,'orchestrator') THEN
      PERFORM refuse('runtime_cannot_play_role', format('%s does not play the orchestrator', v_runtime), '22023');
    END IF;
    SELECT orchestrator_entry_id INTO v_old FROM project_runtime_defaults WHERE project_id=p_project_id;
    UPDATE project_runtime_defaults SET orchestrator_entry_id=p_entry_id WHERE project_id=p_project_id;
  ELSIF role_holds(v_assignment.role_definition_id,'implementation.execute') THEN
    v_role:='executor';
    SELECT e.ordinal INTO v_ordinal FROM project_executor_positions(p_project_id) e WHERE e.assignment_id=p_assignment_id;
    SELECT d.catalog_entry_id, d.priority INTO v_old, v_priority
    FROM project_default_executor_positions(p_project_id) d WHERE d.ordinal=v_ordinal;
    IF v_old IS DISTINCT FROM p_entry_id THEN
      IF EXISTS (SELECT 1 FROM project_runtime_default_executors d WHERE d.project_id=p_project_id AND d.catalog_entry_id=p_entry_id) THEN
        PERFORM refuse('team_model_in_use', format('another executor of project %s already runs %s', p_project_id, v_entry->>'model_id'));
      END IF;
      IF v_old IS NULL THEN
        -- An executor without a default of its own (more executors than
        -- defaults): its model goes to the end, which is its position only if
        -- it is the last. Otherwise the positions would shift under the others.
        IF v_ordinal IS DISTINCT FROM (SELECT count(*) FROM project_default_executor_positions(p_project_id)) + 1 THEN
          PERFORM refuse('runtime_defaults_invalid',
            'the executors before this one have no models of their own; set them first', '22023');
        END IF;
        SELECT COALESCE(max(priority),0)+100 INTO v_priority FROM project_runtime_default_executors WHERE project_id=p_project_id;
      ELSE
        DELETE FROM project_runtime_default_executors WHERE project_id=p_project_id AND catalog_entry_id=v_old;
      END IF;
      INSERT INTO project_runtime_default_executors(project_id, catalog_entry_id, priority)
      VALUES(p_project_id, p_entry_id, v_priority);
    END IF;
  ELSE
    PERFORM refuse('team_assignment_unavailable', format('assignment %s is neither the orchestrator nor an executor', p_assignment_id));
  END IF;

  v_version:=bump_project_team(p_project_id, p_owner_id, p_actor, p_correlation_id, 'model_changed',
    jsonb_build_object('assignment_id',p_assignment_id,'role',v_role,'from_entry_id',v_old,'entry_id',p_entry_id));
  RETURN jsonb_build_object('project_id',p_project_id,'assignment_id',p_assignment_id,'version',v_version,'status','changed');
END $$;

CREATE FUNCTION disable_project_executor(p_project_id uuid, p_owner_id uuid, p_expected_version bigint,
  p_assignment_id uuid, p_actor text, p_correlation_id text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO control_plane, public, extensions, pg_temp
AS $$
DECLARE v_ordinal bigint; v_count integer; v_entry uuid; v_task uuid; v_version bigint;
BEGIN
  PERFORM lock_project_team(p_project_id, p_owner_id, p_expected_version);
  SELECT e.ordinal INTO v_ordinal FROM project_executor_positions(p_project_id) e WHERE e.assignment_id=p_assignment_id;
  IF v_ordinal IS NULL THEN
    PERFORM refuse('team_assignment_unavailable', format('no enabled executor %s in project %s', p_assignment_id, p_project_id));
  END IF;
  SELECT count(*) INTO v_count FROM project_executor_positions(p_project_id);
  IF v_count <= 1 THEN
    PERFORM refuse('team_last_executor', format('assignment %s is the only executor of project %s', p_assignment_id, p_project_id));
  END IF;
  -- A task already bound to this executor would delegate to an assignment that
  -- is no longer enabled, which the launch refuses.
  SELECT t.id INTO v_task FROM task_executor_assignments tea JOIN tasks t ON t.id=tea.task_id
  WHERE tea.project_agent_assignment_id=p_assignment_id AND tea.enabled
    AND t.status NOT IN ('approved','deployed','completed','cancelled','failed')
  ORDER BY t.updated_at DESC LIMIT 1;
  IF v_task IS NOT NULL THEN
    PERFORM refuse('team_assignment_in_use', format('task %s is open and bound to executor %s', v_task, p_assignment_id));
  END IF;

  SELECT d.catalog_entry_id INTO v_entry FROM project_default_executor_positions(p_project_id) d WHERE d.ordinal=v_ordinal;
  UPDATE project_agent_assignments SET enabled=false, updated_at=clock_timestamp() WHERE id=p_assignment_id;
  IF v_entry IS NOT NULL THEN
    DELETE FROM project_runtime_default_executors WHERE project_id=p_project_id AND catalog_entry_id=v_entry;
  END IF;

  v_version:=bump_project_team(p_project_id, p_owner_id, p_actor, p_correlation_id, 'executor_disabled',
    jsonb_build_object('assignment_id',p_assignment_id,'entry_id',v_entry));
  RETURN jsonb_build_object('project_id',p_project_id,'assignment_id',p_assignment_id,'version',v_version,'status','disabled');
END $$;

-- ------------------------------------------------------------------ read

CREATE FUNCTION project_team(p_project_id uuid, p_owner_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO control_plane, public, extensions, pg_temp
AS $$
DECLARE v_defaults project_runtime_defaults%ROWTYPE; v_result jsonb;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM projects p WHERE p.id=p_project_id AND p.owner_id=p_owner_id) THEN
    PERFORM refuse('project_unavailable', format('no project %s this operator owns', p_project_id));
  END IF;
  SELECT * INTO v_defaults FROM project_runtime_defaults WHERE project_id=p_project_id;

  WITH roles AS (
    SELECT rd.id, rd.builtin_key, rd.name,
      COALESCE((SELECT jsonb_agg(p.permission ORDER BY p.permission) FROM role_permissions p WHERE p.role_definition_id=rd.id),'[]') AS permissions,
      COALESCE((SELECT jsonb_agg(DISTINCT pc.capability ORDER BY pc.capability) FROM role_permissions p
                JOIN permission_capabilities pc ON pc.permission=p.permission WHERE p.role_definition_id=rd.id),'[]') AS capabilities
    FROM role_definitions rd WHERE rd.builtin_key IS NOT NULL
  ), executors AS (
    SELECT e.assignment_id, d.catalog_entry_id AS entry_id
    FROM project_executor_positions(p_project_id) e
    LEFT JOIN project_default_executor_positions(p_project_id) d ON d.ordinal=e.ordinal
  ), assignments AS (
    SELECT pa.id, pa.is_default, pa.created_at, a.name AS agent_name, rp.runtime_type, rd.builtin_key AS role_key, rd.name AS role_name,
      CASE WHEN role_holds(pa.role_definition_id,'conversation.hold') THEN v_defaults.orchestrator_entry_id
           ELSE (SELECT x.entry_id FROM executors x WHERE x.assignment_id=pa.id) END AS entry_id,
      (SELECT count(*) FROM task_executor_assignments tea JOIN tasks t ON t.id=tea.task_id
       WHERE tea.project_agent_assignment_id=pa.id AND tea.enabled
         AND t.status NOT IN ('approved','deployed','completed','cancelled','failed')) AS open_tasks
    FROM project_agent_assignments pa JOIN agents a ON a.id=pa.agent_id
    JOIN runtime_profiles rp ON rp.id=pa.runtime_profile_id
    JOIN role_definitions rd ON rd.id=pa.role_definition_id
    WHERE pa.project_id=p_project_id AND pa.enabled
  ), runtimes AS (
    SELECT rr.runtime_type,
      COALESCE((SELECT jsonb_agg(c.capability ORDER BY c.capability) FROM runtime_capabilities c WHERE c.runtime_type=rr.runtime_type),'[]') AS capabilities,
      jsonb_agg(DISTINCT rr.role) FILTER (WHERE runtime_plays(rr.runtime_type, rr.role)) AS plays
    FROM runtime_roles rr GROUP BY rr.runtime_type
  ), models AS (
    SELECT m.id, m.runtime_type, m.model_id, m.display_name, m.status, m.access_gateway, m.model_vendor, m.billing_boundary,
      c.status AS connection_status,
      -- Why a model cannot be picked for a role, the first reason that holds.
      CASE WHEN c.status IS DISTINCT FROM 'connected' THEN 'connection_not_connected'
           WHEN m.status<>'verified' THEN 'model_not_verified'
           WHEN NOT runtime_plays(m.runtime_type,'orchestrator') THEN 'runtime_cannot_play_role'
           WHEN NOT assignment_may(m.runtime_type,(SELECT id FROM roles WHERE builtin_key='orchestrator')) THEN 'runtime_lacks_capability'
           ELSE NULL END AS orchestrator_unavailable,
      CASE WHEN c.status IS DISTINCT FROM 'connected' THEN 'connection_not_connected'
           WHEN m.status<>'verified' THEN 'model_not_verified'
           WHEN NOT runtime_plays(m.runtime_type,'executor') THEN 'runtime_cannot_play_role'
           WHEN NOT assignment_may(m.runtime_type,(SELECT id FROM roles WHERE builtin_key='executor')) THEN 'runtime_lacks_capability'
           ELSE NULL END AS executor_unavailable
    FROM provider_model_catalog m JOIN provider_connections c ON c.id=m.connection_id
    WHERE m.operator_id=p_owner_id
  )
  SELECT jsonb_build_object(
    'project_id',p_project_id,
    'managed',v_defaults.project_id IS NOT NULL,
    'version',v_defaults.version,
    'roles',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',r.id,'key',r.builtin_key,'name',r.name,
      'permissions',r.permissions,'capabilities',r.capabilities) ORDER BY r.builtin_key DESC) FROM roles r),'[]'),
    'runtimes',COALESCE((SELECT jsonb_agg(jsonb_build_object('runtime',x.runtime_type,'capabilities',x.capabilities,
      'plays',COALESCE(x.plays,'[]'))) FROM runtimes x),'[]'),
    'assignments',COALESCE((SELECT jsonb_agg(jsonb_build_object('assignment_id',a.id,'agent_name',a.agent_name,
      'runtime',a.runtime_type,'role_key',a.role_key,'role_name',a.role_name,'is_default',a.is_default,
      'entry_id',a.entry_id,'model_id',m.model_id,'display_name',m.display_name,'open_tasks',a.open_tasks)
      ORDER BY a.role_key DESC, a.created_at, a.id) FROM assignments a LEFT JOIN models m ON m.id=a.entry_id),'[]'),
    -- Every model that can be picked, and — so the tab can say why the rest are
    -- not offered without listing hundreds of unverified entries — how many of
    -- the others each reason holds back, per runtime.
    'models',COALESCE((SELECT jsonb_agg(jsonb_build_object('entry_id',m.id,'runtime',m.runtime_type,'model_id',m.model_id,
      'display_name',m.display_name,'gateway',m.access_gateway,'vendor',m.model_vendor,'billing',m.billing_boundary,
      'orchestrator_unavailable',m.orchestrator_unavailable,'executor_unavailable',m.executor_unavailable)
      ORDER BY m.runtime_type, m.display_name, m.id)
      FROM models m WHERE m.orchestrator_unavailable IS NULL OR m.executor_unavailable IS NULL),'[]'),
    'held_back',COALESCE((SELECT jsonb_agg(jsonb_build_object('runtime',h.runtime_type,'reason',h.reason,'count',h.n)
      ORDER BY h.runtime_type, h.reason)
      FROM (SELECT m.runtime_type, m.executor_unavailable AS reason, count(*) AS n FROM models m
            WHERE m.orchestrator_unavailable IS NOT NULL AND m.executor_unavailable IS NOT NULL
            GROUP BY 1,2) h),'[]')
  ) INTO v_result;
  RETURN v_result;
END $$;

REVOKE EXECUTE ON FUNCTION lock_project_team(uuid,uuid,bigint) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION project_executor_positions(uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION project_default_executor_positions(uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION team_model(uuid,uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION bump_project_team(uuid,uuid,text,text,text,jsonb) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION add_project_executor(uuid,uuid,bigint,uuid,text,text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION change_project_assignment_model(uuid,uuid,bigint,uuid,uuid,text,text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION disable_project_executor(uuid,uuid,bigint,uuid,text,text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION project_team(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION add_project_executor(uuid,uuid,bigint,uuid,text,text) TO infra_web;
GRANT EXECUTE ON FUNCTION change_project_assignment_model(uuid,uuid,bigint,uuid,uuid,text,text) TO infra_web;
GRANT EXECUTE ON FUNCTION disable_project_executor(uuid,uuid,bigint,uuid,text,text) TO infra_web;
GRANT EXECUTE ON FUNCTION project_team(uuid,uuid) TO infra_web;
