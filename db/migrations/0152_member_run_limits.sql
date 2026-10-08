-- rc.142: a token limit per run and a fallback model, for each executor and
-- analyst.
--
-- * A token limit: the most tokens one run of this member may use, counted as
--   the usage panel counts them (input, output, reasoning, cache read and
--   write). The supervisor meters the run's own stream and stops it past the
--   limit. Null is no limit.
-- * A fallback model (Claude Code only): the model its `--fallback-model`
--   switches to when the member's own model is overloaded or not available. A
--   verified Claude model of the same owner; a fallback that is no longer
--   verified is simply not passed. The switch is reported in the run's
--   activity (`runtime.model.fallback`), and the run's usage row names the
--   model that answered.
--
-- An executor keeps both in its assignment config (`run_token_limit`,
-- `fallback_entry_id`), as it keeps `allow_subagents`; an analyst in columns.

SET search_path TO control_plane, public, extensions;

ALTER TABLE project_analysts
  ADD COLUMN run_token_limit bigint CHECK (run_token_limit IS NULL OR run_token_limit BETWEEN 10000 AND 1000000000),
  ADD COLUMN fallback_entry_id uuid REFERENCES provider_model_catalog(id) ON DELETE SET NULL;

INSERT INTO failure_reasons(reason, code, note) VALUES
  ('run_limit_invalid','invalid_argument','a token limit per run is between 10 000 and 1 000 000 000, or none'),
  ('fallback_model_unavailable','invalid_argument','a fallback is a verified Claude Code model of the same owner, for a Claude Code member')
ON CONFLICT (reason) DO NOTHING;

-- The model a fallback entry names, while it may still be used: a verified,
-- current Claude Code model of the owner. Null otherwise — the run then goes
-- without a fallback rather than failing.
CREATE FUNCTION member_fallback_model(p_entry_id uuid, p_owner_id uuid)
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO control_plane, public, extensions, pg_temp
AS $$
  SELECT m.model_id FROM provider_model_catalog m
  WHERE m.id=p_entry_id AND m.operator_id=p_owner_id AND m.runtime_type='claude'
    AND m.status='verified' AND m.superseded_by IS NULL;
$$;

-- The Team page: one member's token limit and fallback, set together.
CREATE FUNCTION set_project_member_run_settings(p_project_id uuid, p_owner_id uuid, p_expected_version bigint,
  p_member_id uuid, p_token_limit bigint, p_fallback_entry_id uuid, p_actor text, p_correlation_id text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO control_plane, public, extensions, pg_temp
AS $$
DECLARE v_version bigint; v_kind text; v_runtime text;
BEGIN
  PERFORM lock_project_team(p_project_id, p_owner_id, p_expected_version);
  IF p_token_limit IS NOT NULL AND p_token_limit NOT BETWEEN 10000 AND 1000000000 THEN
    PERFORM refuse('run_limit_invalid', format('a token limit of %s is out of range', p_token_limit));
  END IF;
  SELECT 'executor', rp.runtime_type INTO v_kind, v_runtime
  FROM project_agent_assignments pa JOIN runtime_profiles rp ON rp.id=pa.runtime_profile_id
  WHERE pa.id=p_member_id AND pa.project_id=p_project_id AND pa.enabled
    AND role_holds(pa.role_definition_id,'implementation.execute');
  IF v_kind IS NULL THEN
    SELECT 'analyst', a.runtime_type INTO v_kind, v_runtime
    FROM project_analysts a WHERE a.id=p_member_id AND a.project_id=p_project_id AND a.enabled;
  END IF;
  IF v_kind IS NULL THEN
    PERFORM refuse('team_member_unavailable', format('no executor or analyst %s in project %s', p_member_id, p_project_id));
  END IF;
  IF p_fallback_entry_id IS NOT NULL
     AND (v_runtime <> 'claude' OR member_fallback_model(p_fallback_entry_id, p_owner_id) IS NULL) THEN
    PERFORM refuse('fallback_model_unavailable', format('model %s cannot be the fallback of member %s', p_fallback_entry_id, p_member_id));
  END IF;
  IF v_kind = 'executor' THEN
    UPDATE project_agent_assignments SET config=(config - 'run_token_limit' - 'fallback_entry_id')
      || jsonb_strip_nulls(jsonb_build_object('run_token_limit',p_token_limit,'fallback_entry_id',p_fallback_entry_id)),
      updated_at=clock_timestamp()
    WHERE id=p_member_id;
  ELSE
    UPDATE project_analysts SET run_token_limit=p_token_limit, fallback_entry_id=p_fallback_entry_id,
      updated_at=clock_timestamp()
    WHERE id=p_member_id;
  END IF;
  v_version := bump_project_team(p_project_id, p_owner_id, p_actor, p_correlation_id, 'run_settings_set',
    jsonb_build_object('member_id',p_member_id,'kind',v_kind,'run_token_limit',p_token_limit,'fallback_entry_id',p_fallback_entry_id));
  RETURN jsonb_build_object('project_id',p_project_id,'member_id',p_member_id,'kind',v_kind,
    'run_token_limit',p_token_limit,'fallback_entry_id',p_fallback_entry_id,'version',v_version,'status','changed');
END $$;

-- What the Team page shows beside each executor and analyst.
CREATE FUNCTION project_member_run_settings(p_project_id uuid, p_owner_id uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO control_plane, public, extensions, pg_temp
AS $$
  SELECT COALESCE(jsonb_object_agg(member.id, jsonb_build_object('run_token_limit',member.token_limit,
      'fallback_entry_id',member.fallback, 'fallback_model',member_fallback_model(member.fallback, p_owner_id))), '{}'::jsonb)
  FROM (
    SELECT pa.id, CASE WHEN pa.config->>'run_token_limit' ~ '^[0-9]{1,10}$' THEN (pa.config->>'run_token_limit')::bigint END AS token_limit,
      CASE WHEN pa.config->>'fallback_entry_id' ~ '^[0-9a-f-]{36}$' THEN (pa.config->>'fallback_entry_id')::uuid END AS fallback
    FROM project_agent_assignments pa JOIN projects p ON p.id=pa.project_id
    WHERE pa.project_id=p_project_id AND p.owner_id=p_owner_id AND pa.enabled
      AND role_holds(pa.role_definition_id,'implementation.execute')
    UNION ALL
    SELECT a.id, a.run_token_limit, a.fallback_entry_id FROM project_analysts a JOIN projects p ON p.id=a.project_id
    WHERE a.project_id=p_project_id AND p.owner_id=p_owner_id AND a.enabled) member;
$$;

-- An executor's run settings, for the supervisor's launch: the same reading
-- as the Team page's, of the assignment the run's handoff names.
CREATE FUNCTION executor_run_settings(p_assignment_id uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO control_plane, public, extensions, pg_temp
AS $$
  SELECT jsonb_build_object(
    'run_token_limit', CASE WHEN pa.config->>'run_token_limit' ~ '^[0-9]{1,10}$' THEN (pa.config->>'run_token_limit')::bigint END,
    'fallback_model', CASE WHEN pa.config->>'fallback_entry_id' ~ '^[0-9a-f-]{36}$'
      THEN member_fallback_model((pa.config->>'fallback_entry_id')::uuid, p.owner_id) END)
  FROM project_agent_assignments pa JOIN projects p ON p.id=pa.project_id WHERE pa.id=p_assignment_id;
$$;

CREATE OR REPLACE FUNCTION consultation_job_context(p_job_id bigint, p_worker_id text)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path TO control_plane, public, extensions, pg_temp
AS $$
DECLARE v_context jsonb;
BEGIN
  SELECT jsonb_build_object('job_id',j.id,'attempt_count',j.attempt_count,'consultation_id',c.id,
      'project_id',c.project_id,'task_id',c.task_id,'task_title',t.title,
      'workspace_path',p.workspace_path,'question',c.question,'status',c.status,
      'analyst',a.name,'instructions',a.instructions,'runtime_type',a.runtime_type,
      'provider_id',m.provider_id,'model',m.model_id,'model_display',COALESCE(m.display_name,m.model_id),
      'model_status',m.status,'reasoning_effort',NULLIF(a.reasoning_effort,''),'analyst_enabled',a.enabled,
      -- The repository map's layout (0146), so the analyst starts from it.
      'layout',(SELECT left(rm.map->>'tree', 8000) FROM project_repository_maps rm WHERE rm.project_id=c.project_id),
      -- 0151: the analyst's own subagents, and a stop the owner asked for.
      'allow_subagents',a.allow_subagents,'stop_requested',c.stop_requested_at IS NOT NULL,
      -- 0152: its token limit per run and its fallback model.
      'run_token_limit',a.run_token_limit,'fallback_model',member_fallback_model(a.fallback_entry_id, p.owner_id))
    INTO v_context
  FROM runtime_jobs j
  JOIN consultations c ON c.id=(j.payload#>>'{event_payload,consultation_id}')::uuid
  JOIN project_analysts a ON a.id=c.analyst_id
  JOIN projects p ON p.id=c.project_id
  JOIN tasks t ON t.id=c.task_id
  LEFT JOIN provider_model_catalog m ON m.id=a.catalog_entry_id
  WHERE j.id=p_job_id AND j.job_type='consultation_run' AND j.status='in_flight'
    AND j.leased_by=p_worker_id AND j.leased_until>clock_timestamp();
  IF v_context IS NULL THEN
    PERFORM refuse('consultation_not_held', format('consultation job %s is not leased by %s', p_job_id, p_worker_id));
  END IF;
  RETURN v_context;
END $$;

-- A run that switched to its fallback: its usage row names the model that
-- answered, not the one it was launched with. The alias check (0105) still
-- reads the launch's own resolution, so a fallback is not drift.
CREATE FUNCTION run_usage_model_from_fallback()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO control_plane, public, extensions, pg_temp
AS $$
DECLARE v_row bigint;
BEGIN
  BEGIN
    v_row := run_usage_row_for_job(NEW.job_id, NEW.runtime_type);
    IF v_row IS NOT NULL AND btrim(COALESCE(NEW.details->>'model','')) <> '' THEN
      UPDATE run_usage SET model=left(btrim(NEW.details->>'model'),200) WHERE id=v_row;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'the fallback model was not recorded for activity event %: %', NEW.id, SQLERRM;
  END;
  RETURN NULL;
END $$;
CREATE TRIGGER runtime_activity_events_model_fallback AFTER INSERT ON runtime_activity_events
  FOR EACH ROW WHEN (NEW.event_type = 'runtime.model.fallback')
  EXECUTE FUNCTION run_usage_model_from_fallback();

REVOKE ALL ON FUNCTION member_fallback_model(uuid,uuid), executor_run_settings(uuid),
  set_project_member_run_settings(uuid,uuid,bigint,uuid,bigint,uuid,text,text), project_member_run_settings(uuid,uuid),
  run_usage_model_from_fallback() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION set_project_member_run_settings(uuid,uuid,bigint,uuid,bigint,uuid,text,text),
  project_member_run_settings(uuid,uuid) TO infra_web;
GRANT EXECUTE ON FUNCTION executor_run_settings(uuid) TO infra_worker;
