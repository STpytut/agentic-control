-- Which runtime version was made active on this host, when, by whom and on
-- what grounds (Stage 12 W4, docs/RUNTIMES_AND_MODELS_DESIGN.md §3.3, §3.4).
--
-- `infra-cod runtime promote` and `rollback` switch the version on disk and
-- record it in /etc/infra-cod/runtimes.json, which stays the host's truth. This
-- is the panel's and the audit's view: every switch, the qualification that
-- earned it or the reason it was accepted without one (R10). Append-only.

SET search_path TO control_plane, public, extensions;

CREATE TABLE runtime_activations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  runtime_type text NOT NULL CHECK (runtime_type IN ('codex','opencode','claude','antigravity')),
  kind text NOT NULL CHECK (kind IN ('promote','rollback')),
  version text NOT NULL CHECK (version ~ '^[0-9]+\.[0-9]+\.[0-9]+$'),
  from_version text NOT NULL CHECK (from_version ~ '^[0-9]+\.[0-9]+\.[0-9]+$'),
  qualification_id uuid REFERENCES runtime_qualifications(id),
  -- A promotion without a passed qualification carries the operator's reason;
  -- one with a qualification does not need one.
  accepted_unqualified boolean NOT NULL DEFAULT false,
  reason text NOT NULL DEFAULT '' CHECK (length(reason) <= 500),
  actor text NOT NULL CHECK (length(actor) BETWEEN 1 AND 120),
  activated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (kind <> 'promote' OR qualification_id IS NOT NULL OR (accepted_unqualified AND length(reason) >= 8))
);
CREATE INDEX runtime_activations_by_runtime ON runtime_activations(runtime_type, activated_at DESC);

CREATE FUNCTION record_runtime_activation(p_runtime_type text, p_kind text, p_version text, p_from_version text, p_qualification_id uuid, p_accepted_unqualified boolean, p_reason text, p_actor text)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO control_plane, public, extensions, pg_temp
AS $$
DECLARE v_id uuid;
BEGIN
  -- A promotion names a qualification that passed, of that version — the
  -- database does not take the caller's word for it.
  IF p_qualification_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM runtime_qualifications
    WHERE id = p_qualification_id AND runtime_type = p_runtime_type AND version = p_version AND result = 'passed'
  ) THEN
    RAISE EXCEPTION 'qualification % is not a passed qualification of % %', p_qualification_id, p_runtime_type, p_version
      USING ERRCODE='23514', DETAIL=jsonb_build_object('reason','runtime_activation_unqualified')::text;
  END IF;
  INSERT INTO runtime_activations(runtime_type, kind, version, from_version, qualification_id, accepted_unqualified, reason, actor)
  VALUES (p_runtime_type, p_kind, p_version, p_from_version, p_qualification_id, COALESCE(p_accepted_unqualified,false),
    left(COALESCE(p_reason,''),500), p_actor)
  RETURNING id INTO v_id;
  RETURN v_id;
END $$;

CREATE FUNCTION get_runtime_activations()
RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO control_plane, public, extensions, pg_temp
AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'runtime', a.runtime_type, 'kind', a.kind, 'version', a.version, 'from', a.from_version,
    'qualification_id', a.qualification_id, 'accepted_unqualified', a.accepted_unqualified,
    'reason', NULLIF(a.reason,''), 'actor', a.actor, 'at', a.activated_at
  ) ORDER BY a.activated_at DESC), '[]'::jsonb)
  FROM (SELECT * FROM runtime_activations ORDER BY activated_at DESC LIMIT 50) a;
$$;

REVOKE ALL ON runtime_activations FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION record_runtime_activation(text,text,text,text,uuid,boolean,text,text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION get_runtime_activations() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION record_runtime_activation(text,text,text,text,uuid,boolean,text,text) TO infra_worker;
GRANT EXECUTE ON FUNCTION get_runtime_activations() TO infra_web;
