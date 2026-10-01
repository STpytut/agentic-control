-- Two executors of one runtime share its structural profile; a project created
-- with both gets both, in the order they were asked for (migration 0121).
\set ON_ERROR_STOP on

BEGIN;
SET search_path TO control_plane, public, extensions;

DO $$
DECLARE
  v_owner uuid; v_codex uuid; v_exec uuid; v_other uuid; v_project uuid := gen_random_uuid();
  v_result jsonb; v_names text[];
BEGIN
  INSERT INTO users(display_name) VALUES('One executor per request') RETURNING id INTO v_owner;
  INSERT INTO runtime_profiles(runtime_type,adapter_version,runtime_version,provider_type,model,last_verified_at)
    VALUES('codex','t','t','openai','0121-codex',clock_timestamp()) RETURNING id INTO v_codex;
  INSERT INTO runtime_profiles(runtime_type,adapter_version,runtime_version,provider_type,model,last_verified_at)
    VALUES('opencode','t','t','test','0121-shared',clock_timestamp()) RETURNING id INTO v_exec;
  INSERT INTO runtime_profiles(runtime_type,adapter_version,runtime_version,provider_type,model,last_verified_at)
    VALUES('opencode','t','t','test','0121-other',clock_timestamp()) RETURNING id INTO v_other;

  -- The shared profile twice, then another: three executors, in that order.
  v_result := create_project_with_roster(
    v_project, v_owner, 'Two of one runtime', 'two-of-one-'||left(v_project::text,8),
    '/srv/0121/'||v_project, NULL, 'main',
    '{"provisioning_status":"pending","provisioning_source":"empty","agent_roster_configured":true}'::jsonb,
    'empty', v_codex, to_jsonb(ARRAY[v_exec, v_other, v_exec]), 'operator:test', 'corr-0121');
  IF (v_result->>'executor_count')::integer <> 3 THEN
    RAISE EXCEPTION 'expected 3 executors, got %', v_result->>'executor_count';
  END IF;
  SELECT array_agg(rp.model ORDER BY e.ordinal) INTO v_names
  FROM project_executor_positions(v_project) e
  JOIN project_agent_assignments pa ON pa.id=e.assignment_id
  JOIN runtime_profiles rp ON rp.id=pa.runtime_profile_id;
  IF v_names <> ARRAY['0121-shared','0121-other','0121-shared'] THEN
    RAISE EXCEPTION 'executors are not in the requested order: %', v_names;
  END IF;
  RAISE NOTICE 'one executor per request, in order';
END $$;

ROLLBACK;
