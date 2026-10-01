-- A project created with two executors of one runtime got one (the owner's
-- test project on 2026-09-29: OpenCode openai/gpt-6-luna and big-pickle chosen,
-- only the first in the team). create_project_with_roster made one executor
-- per distinct runtime profile, and since 0074 every executor of a runtime
-- shares its structural profile. Redefined under the same signature, security
-- and grants to make one per requested executor, in order; and every project
-- whose defaults name more executors than it has is given the missing ones, on
-- the structural profile of each model's runtime, as add_project_executor does.

SET search_path TO control_plane, public, extensions;

CREATE OR REPLACE FUNCTION create_project_with_roster(p_project_id uuid, p_owner_id uuid, p_name text, p_slug text, p_workspace_path text, p_repository text, p_branch text, p_settings jsonb, p_credential_mode text, p_orchestrator_profile_id uuid, p_executor_profile_ids jsonb, p_actor text, p_correlation text DEFAULT ''::text, p_provider_connection_id uuid DEFAULT NULL::uuid, p_github_repository_id bigint DEFAULT NULL::bigint)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'control_plane', 'public', 'extensions', 'pg_temp'
AS $function$
DECLARE
  -- Scalars rather than a record: with no GitHub selection there is nothing to
  -- assign, and an unassigned record raises on first field reference.
  v_repo_full_name text;
  v_repo_clone_url text;
  v_repo_default_branch text;
  v_repo_archived boolean;
  v_project projects%ROWTYPE;
  v_orchestrator_agent agents%ROWTYPE;
  v_orchestrator_profile runtime_profiles%ROWTYPE;
  v_executor_count integer := 0;
  v_requested uuid[];
  v_item record;
  v_agent_id uuid;
  v_base timestamptz;
BEGIN
  -- Resolve the GitHub selection first: nothing should be created if it is stale.
  IF p_provider_connection_id IS NOT NULL THEN
    SELECT r.full_name, r.clone_url, r.default_branch, r.archived
    INTO v_repo_full_name, v_repo_clone_url, v_repo_default_branch, v_repo_archived
    FROM provider_installation_repositories r
    JOIN provider_connections c ON c.id=r.connection_id
    WHERE r.connection_id=p_provider_connection_id
      AND r.github_repository_id=p_github_repository_id
      AND c.operator_id=p_owner_id
      AND c.provider='github' AND c.status='connected';

    IF NOT FOUND THEN
      RAISE EXCEPTION 'the selected GitHub repository is no longer available to the GitHub App'
        USING ERRCODE='55000', DETAIL=jsonb_build_object('reason','repository_unavailable')::text;
    END IF;
    IF v_repo_archived THEN
      RAISE EXCEPTION 'the selected GitHub repository is archived' USING ERRCODE='55000', DETAIL=jsonb_build_object('reason','repository_unavailable')::text;
    END IF;
  END IF;

  -- The orchestrator runtime must be enabled, verified and a Codex runtime.
  SELECT * INTO v_orchestrator_profile FROM runtime_profiles rp
  WHERE rp.id=p_orchestrator_profile_id
    AND rp.enabled AND rp.last_verified_at IS NOT NULL AND runtime_plays(rp.runtime_type,'orchestrator');
  IF NOT FOUND THEN RETURN NULL; END IF;

  SELECT array_agg(value::uuid) INTO v_requested
  FROM jsonb_array_elements_text(p_executor_profile_ids) AS t(value);
  v_requested := COALESCE(v_requested, ARRAY[]::uuid[]);

  INSERT INTO projects(id,owner_id,name,slug,workspace_path,repository_url,default_branch,
                       status,settings,credential_mode,provider_connection_id,
                       github_repository_id,repository_full_name)
  VALUES (p_project_id,p_owner_id,p_name,p_slug,p_workspace_path,
          COALESCE(v_repo_clone_url, NULLIF(p_repository,'')),
          COALESCE(v_repo_default_branch, p_branch),
          'needs_attention',p_settings,p_credential_mode,
          p_provider_connection_id,p_github_repository_id,v_repo_full_name)
  RETURNING * INTO v_project;

  INSERT INTO agents(name,runtime_profile_id)
  VALUES ('orchestrator-'||v_orchestrator_profile.runtime_type||'-'||v_project.id,
          v_orchestrator_profile.id)
  RETURNING * INTO v_orchestrator_agent;

  INSERT INTO project_agent_assignments(project_id,agent_id,runtime_profile_id,
                                        role_definition_id,is_default)
  VALUES (v_project.id,v_orchestrator_agent.id,v_orchestrator_agent.runtime_profile_id,
          (SELECT id FROM role_definitions WHERE builtin_key='orchestrator'),true);

  -- One executor per element of the request, in its order (0121). Two
  -- executors of one runtime share its structural profile; keyed by the
  -- profile, the second was dropped and its model stood in the project's
  -- defaults with nobody to run it. Creation times rise with the request's
  -- order, which is the position project_executor_positions gives each and the
  -- order the defaults were written in.
  v_base := clock_timestamp();
  FOR v_item IN
    SELECT rp.id AS profile_id, rp.runtime_type, t.ordinality
    FROM jsonb_array_elements_text(p_executor_profile_ids) WITH ORDINALITY AS t(value, ordinality)
    JOIN runtime_profiles rp ON rp.id=t.value::uuid
    WHERE rp.enabled AND rp.last_verified_at IS NOT NULL AND runtime_plays(rp.runtime_type,'executor')
    ORDER BY t.ordinality
  LOOP
    INSERT INTO agents(name,runtime_profile_id)
    VALUES ('executor-'||v_item.runtime_type||'-'||v_item.ordinality||'-'||v_project.id, v_item.profile_id)
    RETURNING id INTO v_agent_id;
    INSERT INTO project_agent_assignments(project_id,agent_id,runtime_profile_id,role_definition_id,created_at,updated_at)
    VALUES (v_project.id,v_agent_id,v_item.profile_id,(SELECT id FROM role_definitions WHERE builtin_key='executor'),
            v_base + make_interval(secs => v_item.ordinality / 1000000.0), v_base + make_interval(secs => v_item.ordinality / 1000000.0));
    v_executor_count := v_executor_count + 1;
  END LOOP;

  INSERT INTO workspace_locks(project_id) VALUES (v_project.id);

  PERFORM append_event('project.created',v_project.id,NULL,NULL,'user',p_actor,NULL,p_correlation,
    'project-created:'||v_project.id,'project',v_project.id,v_project.version,
    jsonb_build_object('name',v_project.name,'slug',v_project.slug,
      'provisioning_status','pending','credential_mode',p_credential_mode,
      'repository_full_name',v_project.repository_full_name,
      'orchestrator_profile_id',p_orchestrator_profile_id,
      'executor_profile_ids',p_executor_profile_ids));

  RETURN jsonb_build_object('project_id',v_project.id,'slug',v_project.slug,
    'status',v_project.status,'workspace_path',v_project.workspace_path,
    'orchestrator_profile_id',p_orchestrator_profile_id,
    'credential_mode',v_project.credential_mode,
    'repository_full_name',v_project.repository_full_name,
    'executor_count',v_executor_count);
END $function$;


DO $$
DECLARE v_project record; v_missing record; v_agent uuid; v_profile uuid; v_base timestamptz;
BEGIN
  FOR v_project IN
    SELECT p.id, p.owner_id FROM projects p
    WHERE p.status NOT IN ('deleting','deletion_failed','deleted')
      AND (SELECT count(*) FROM project_default_executor_positions(p.id))
        > (SELECT count(*) FROM project_executor_positions(p.id))
  LOOP
    v_base := clock_timestamp();
    FOR v_missing IN
      SELECT d.ordinal, c.runtime_type
      FROM project_default_executor_positions(v_project.id) d
      JOIN provider_model_catalog c ON c.id=d.catalog_entry_id
      WHERE d.ordinal > (SELECT count(*) FROM project_executor_positions(v_project.id))
      ORDER BY d.ordinal
    LOOP
      v_profile := ensure_structural_runtime_profile(v_project.owner_id, v_missing.runtime_type);
      INSERT INTO agents(name, runtime_profile_id)
      VALUES ('executor-'||v_missing.runtime_type||'-'||left(gen_random_uuid()::text,8)||'-'||v_project.id, v_profile)
      RETURNING id INTO v_agent;
      INSERT INTO project_agent_assignments(project_id, agent_id, runtime_profile_id, role_definition_id, created_at, updated_at)
      VALUES (v_project.id, v_agent, v_profile, (SELECT id FROM role_definitions WHERE builtin_key='executor'),
              v_base + make_interval(secs => v_missing.ordinal / 1000000.0), v_base + make_interval(secs => v_missing.ordinal / 1000000.0));
    END LOOP;
    PERFORM bump_project_team(v_project.id, v_project.owner_id, 'migration-0121', '', 'executors_restored',
      jsonb_build_object('reason','an executor of a shared runtime profile was dropped at creation'));
    RAISE NOTICE 'project %: missing executors restored', v_project.id;
  END LOOP;
END $$;
