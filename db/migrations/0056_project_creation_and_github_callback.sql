-- Stage 11.1: a project can be created on a host that has only ever been
-- installed, and the GitHub callback can finish.
--
-- Both found by using the panel on the production host, and both are the same
-- shape as the ones before them: a surface the web tier reaches for and a
-- database that never offered it.
--
-- 1. `runtime_profiles` is empty on every real installation
-- ---------------------------------------------------------
-- `create_project` asks for a verified `runtime_profiles` row and refuses
-- without one — "The selected orchestrator runtime is unavailable", which is the
-- message an operator sees after connecting Codex, verifying a model and filling
-- in the form. Nothing in the product writes that table: the only `INSERT INTO
-- runtime_profiles` in the repository is in `pocs/`, so a developer who ran a PoC
-- has rows and a customer never does.
--
-- The selection itself moved to the catalog in 0027/0028 — `set_project_runtime_defaults`
-- records the verified entry, and `capture_task_runtime_snapshot` is what a task
-- actually runs from. What remains of the profile is structure: `agents`
-- and `project_agent_assignments` reference one, and `create_task_with_executors`
-- reads `runtime_type` off it. The code already treats it that way; it calls the
-- executor profiles "structural". It just had no way to make one.
--
-- So one per runtime type, created on demand and marked for what it is. The
-- model is not invented: a profile that claimed `gpt-5.6-luna` would be a second,
-- staler answer to a question `task_runtime_snapshots` already answers exactly.
--
-- 2. The GitHub callback
-- ----------------------
-- 0055 granted `start_provider_login_session` and `consume_provider_login_session`
-- — the two the connect button failed on. The callback calls a third,
-- `consume_session_and_record_github_oauth`, which was neither SECURITY DEFINER
-- nor granted, so the flow moved its failure from the first click to the return
-- from GitHub: `?github=error`, no audit row, and a bare `catch {}` in the route
-- where the reason had been.
--
-- The lesson is about the fix, not the function: a permissions defect belongs to
-- the whole flow, and stopping at the error that is currently visible guarantees
-- meeting the next one from the same cause. `db/tests/0026` now checks every
-- function the web tier calls, not only the ones somebody thought to list.

SET search_path TO control_plane, public, extensions;

-- The structural profile for a runtime type: found, or made.
--
-- SECURITY DEFINER because `infra_web` holds no DML anywhere and this is not the
-- place to start. The operator is checked for the same reason 0055 checks it:
-- definer rights mean the tables stopped checking.
CREATE OR REPLACE FUNCTION ensure_structural_runtime_profile(
  p_operator_id uuid, p_runtime_type text
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_id uuid;
  v_version text;
BEGIN
  IF p_runtime_type NOT IN ('codex','opencode','antigravity') THEN
    RAISE EXCEPTION 'unknown runtime type %', p_runtime_type USING ERRCODE='22023';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM users u
    WHERE u.id=p_operator_id AND u.role='owner' AND u.disabled_at IS NULL
  ) THEN
    RAISE EXCEPTION 'not an enabled operator' USING ERRCODE='42501';
  END IF;

  SELECT rp.id INTO v_id FROM runtime_profiles rp
  WHERE rp.runtime_type=p_runtime_type AND rp.enabled AND rp.last_verified_at IS NOT NULL
  ORDER BY rp.last_verified_at DESC, rp.created_at, rp.id
  LIMIT 1;
  IF FOUND THEN RETURN v_id; END IF;

  -- The version the host reports for this runtime, so the row describes the
  -- installation rather than a guess. A host that has not reported says so.
  SELECT r.version INTO v_version
  FROM runtime_health h,
       LATERAL jsonb_to_recordset(h.snapshot->'runtimes') AS r(runtime text, version text)
  WHERE h.singleton=true AND r.runtime=p_runtime_type;

  INSERT INTO runtime_profiles(runtime_type, adapter_version, runtime_version,
                               provider_type, model, last_verified_at, enabled)
  VALUES (p_runtime_type, 'catalog', COALESCE(v_version,'unreported'),
          'catalog', 'selected per task', clock_timestamp(), true)
  RETURNING id INTO v_id;
  RETURN v_id;
END $$;

-- 0023's body, unchanged to the character, plus `SECURITY DEFINER`. The return
-- type is jsonb and stays jsonb: `CREATE OR REPLACE` cannot change one, the
-- caller wraps it, and a permissions fix that alters a signature is not a
-- permissions fix.
CREATE OR REPLACE FUNCTION consume_session_and_record_github_oauth(
  p_operator_id uuid, p_state_digest text, p_installation_id text, p_setup_action text,
  p_authorization_code_ciphertext text, p_authorization_code_iv text, p_authorization_code_tag text,
  p_client_id text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_code_id uuid;
BEGIN
  PERFORM consume_provider_login_session(p_operator_id,'github',p_state_digest);
  v_code_id := record_github_oauth_callback(p_operator_id, p_state_digest, p_installation_id, p_setup_action,
    p_authorization_code_ciphertext, p_authorization_code_iv, p_authorization_code_tag, p_client_id);
  RETURN jsonb_build_object('code_id',v_code_id);
END; $$;

ALTER FUNCTION ensure_structural_runtime_profile(uuid,text)
  SET search_path=control_plane,public,extensions,pg_temp;
ALTER FUNCTION consume_session_and_record_github_oauth(uuid,text,text,text,text,text,text,text)
  SET search_path=control_plane,public,extensions,pg_temp;

REVOKE EXECUTE ON FUNCTION ensure_structural_runtime_profile(uuid,text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION consume_session_and_record_github_oauth(uuid,text,text,text,text,text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ensure_structural_runtime_profile(uuid,text) TO infra_web;
GRANT EXECUTE ON FUNCTION consume_session_and_record_github_oauth(uuid,text,text,text,text,text,text,text) TO infra_web;

DO $assert$
DECLARE v_missing text;
BEGIN
  SELECT string_agg(signature,', ' ORDER BY signature) INTO v_missing
  FROM (VALUES
    ('ensure_structural_runtime_profile(uuid,text)'),
    ('consume_session_and_record_github_oauth(uuid,text,text,text,text,text,text,text)')
  ) AS needed(signature)
  WHERE NOT has_function_privilege('infra_web', ('control_plane.'||signature)::regprocedure, 'EXECUTE');
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'infra_web still cannot execute: %', v_missing USING ERRCODE='42501';
  END IF;
END $assert$;
