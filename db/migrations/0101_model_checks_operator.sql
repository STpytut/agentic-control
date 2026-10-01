-- What the panel reads and starts: the Models card, search over a large list,
-- pins, and one check's progress (Stage 12 W6; docs/W6_W7_CONTRACT.md,
-- docs/RUNTIMES_AND_MODELS_DESIGN.md §2.5, §2.7, decisions R6, R7).
--
-- The card never carries a whole large list: per connection it shows the
-- pinned models, the models in use and — only when the list is small — the
-- rest, with a count of what is left for search. Search is server-side and
-- capped at 50 rows. Every function takes the operator first and refuses
-- (42501) a model, connection or check that is not the operator's; the
-- unowned and the non-existent are refused alike, so neither can be probed.

SET search_path TO control_plane, public, extensions;

-- Which projects' teams name a model, and as what (the card's "in use").
CREATE FUNCTION model_team_uses(p_operator_id uuid)
RETURNS TABLE(entry_id uuid, project_id uuid, project_name text, role text)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO control_plane, public, extensions, pg_temp
AS $$
  SELECT COALESCE(m.superseded_by, m.id), p.id, p.name, COALESCE(rd.builtin_key, rd.name, 'orchestrator')
  FROM projects p
  JOIN project_runtime_defaults d ON d.project_id = p.id
  JOIN provider_model_catalog m ON m.id = d.orchestrator_entry_id
  LEFT JOIN LATERAL (
    SELECT r.builtin_key, r.name FROM project_agent_assignments pa
    JOIN role_definitions r ON r.id = pa.role_definition_id
    WHERE pa.project_id = p.id AND pa.enabled AND role_holds(pa.role_definition_id, 'conversation.hold')
    ORDER BY pa.created_at, pa.id LIMIT 1) rd ON true
  WHERE p.owner_id = p_operator_id AND p.deleted_at IS NULL
  UNION ALL
  SELECT COALESCE(m.superseded_by, m.id), p.id, p.name, COALESCE(r.builtin_key, r.name, 'executor')
  FROM projects p
  CROSS JOIN LATERAL project_default_executor_positions(p.id) d
  JOIN provider_model_catalog m ON m.id = d.catalog_entry_id
  LEFT JOIN LATERAL (SELECT e.assignment_id FROM project_executor_positions(p.id) e WHERE e.ordinal = d.ordinal) e ON true
  LEFT JOIN project_agent_assignments pa ON pa.id = e.assignment_id
  LEFT JOIN role_definitions r ON r.id = pa.role_definition_id
  WHERE p.owner_id = p_operator_id AND p.deleted_at IS NULL;
$$;
REVOKE EXECUTE ON FUNCTION model_team_uses(uuid) FROM PUBLIC;

-- One ModelRow of the contract. The state is the panel's word (§2.7): a check
-- queued or running speaks first, then eligibility, then why not.
CREATE FUNCTION model_row(p_entry_id uuid, p_operator_id uuid)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path TO control_plane, public, extensions, pg_temp
AS $$
DECLARE
  v_entry provider_model_catalog%ROWTYPE;
  v_connection provider_connections%ROWTYPE;
  v_eligibility jsonb;
  v_pending model_checks%ROWTYPE;
  v_decisive model_checks%ROWTYPE;
  v_waiting model_checks%ROWTYPE;
  v_state text;
  v_reason text;
  v_retry timestamptz;
  v_checked timestamptz;
BEGIN
  SELECT * INTO v_entry FROM provider_model_catalog WHERE id = p_entry_id;
  SELECT * INTO v_connection FROM provider_connections WHERE id = v_entry.connection_id;
  v_eligibility := model_eligibility(p_entry_id);
  SELECT * INTO v_pending FROM model_checks WHERE entry_id = p_entry_id AND finished_at IS NULL;
  v_decisive := latest_decisive_check(p_entry_id, v_eligibility->>'runtime_version', v_connection.credential_generation);
  v_checked := COALESCE(v_decisive.finished_at,
    CASE WHEN v_eligibility->>'reason' = 'legacy' THEN v_entry.last_verified_at END);
  IF v_pending.id IS NOT NULL THEN
    v_state := model_check_state(v_pending);
    v_reason := NULLIF(v_pending.wait_reason, '');
    v_retry := CASE WHEN v_pending.not_before > clock_timestamp() THEN v_pending.not_before END;
  ELSIF (v_eligibility->>'eligible')::boolean THEN
    v_state := 'ready';
  ELSIF v_entry.superseded_by IS NOT NULL OR v_entry.status = 'unavailable' THEN
    v_state := 'refused'; v_reason := 'not in the connection''s current model list';
  ELSIF v_connection.status IS DISTINCT FROM 'connected' THEN
    v_state := 'waiting'; v_reason := 'the connection is not connected';
  ELSIF v_eligibility->>'reason' = 'not_listed_at_version' THEN
    v_state := 'refused';
    v_reason := format('not offered by %s %s', v_entry.runtime_type, v_eligibility->>'runtime_version');
  ELSIF v_decisive.result IN ('rejected','failed') THEN
    v_state := CASE v_decisive.result WHEN 'rejected' THEN 'refused' ELSE 'failed' END;
    v_reason := NULLIF(v_decisive.detail, '');
  ELSE
    SELECT * INTO v_waiting FROM model_checks
    WHERE entry_id = p_entry_id AND result = 'inconclusive'
      AND runtime_version = COALESCE(v_eligibility->>'runtime_version','')
      AND credential_generation = v_connection.credential_generation
    ORDER BY finished_at DESC LIMIT 1;
    IF v_waiting.id IS NOT NULL THEN
      v_state := 'waiting'; v_reason := NULLIF(v_waiting.detail, '');
    ELSE
      v_state := 'not_checked';
      v_reason := CASE v_eligibility->>'reason'
        WHEN 'runtime_version_changed' THEN 'the runtime version changed since its last check'
        WHEN 'credential_changed' THEN 'the connection''s credential changed since its last check' END;
    END IF;
  END IF;
  RETURN jsonb_build_object(
    'entry_id', v_entry.id, 'provider_id', v_entry.provider_id, 'model_id', v_entry.model_id,
    'display_name', v_entry.display_name, 'vendor', NULLIF(v_entry.model_vendor, ''),
    'pinned', v_entry.pinned_at IS NOT NULL,
    'in_use', COALESCE((SELECT jsonb_agg(jsonb_build_object('project_id', u.project_id,
        'project_name', u.project_name, 'role', u.role) ORDER BY u.project_name, u.role)
      FROM model_team_uses(p_operator_id) u WHERE u.entry_id = v_entry.id), '[]'::jsonb),
    'state', v_state, 'reason', v_reason, 'checked_at', v_checked, 'retry_at', v_retry,
    'resolved_model', NULLIF(v_entry.resolved_model, ''));
END $$;
REVOKE EXECUTE ON FUNCTION model_row(uuid, uuid) FROM PUBLIC;

-- The Models card.
CREATE FUNCTION get_operator_models(p_operator_id uuid)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path TO control_plane, public, extensions, pg_temp
AS $$
DECLARE
  v_limits jsonb := model_check_limits();
  v_usage jsonb := model_check_usage(p_operator_id);
  v_connections jsonb;
BEGIN
  WITH used AS (
    SELECT DISTINCT u.entry_id FROM model_entries_in_use() u
    UNION SELECT DISTINCT t.entry_id FROM model_team_uses(p_operator_id) t
  ), rows AS (
    SELECT m.id, m.connection_id, m.model_id, m.pinned_at IS NOT NULL AS pinned,
      m.id IN (SELECT entry_id FROM used) AS in_use, m.status <> 'unavailable' AS listed,
      count(*) FILTER (WHERE m.status <> 'unavailable') OVER (PARTITION BY m.connection_id) AS list_size
    FROM provider_model_catalog m
    WHERE m.operator_id = p_operator_id AND m.superseded_by IS NULL
  ), shown AS (
    SELECT r.*, (r.pinned OR r.in_use OR (r.listed AND r.list_size <= (v_limits->>'small_list_max')::int)) AS show
    FROM rows r
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'connection_id', c.id,
    -- The name the operator knows the account by: Zen is the runtime's own
    -- provider, Go and OpenRouter are named for their gateway.
    'provider', CASE c.access_gateway WHEN 'opencode_go' THEN 'opencode-go'
                  WHEN 'openrouter' THEN 'openrouter' ELSE c.provider END,
    'label', CASE c.access_gateway WHEN 'openai_chatgpt' THEN 'ChatGPT' WHEN 'claude_subscription' THEN 'Claude'
               WHEN 'opencode_zen' THEN 'OpenCode Zen' WHEN 'opencode_go' THEN 'OpenCode Go'
               WHEN 'openrouter' THEN 'OpenRouter' ELSE c.provider END,
    'runtime_type', c.provider,
    'runtime_version', NULLIF(active_runtime_version(c.provider), ''),
    'status', c.status,
    'billing', CASE WHEN c.billing_boundary IN ('subscription','free') THEN c.billing_boundary ELSE 'metered' END,
    'list_read_at', (SELECT max(j.completed_at) FROM catalog_refresh_jobs j
                     WHERE j.connection_id = c.id AND j.status = 'completed'),
    'total_models', (SELECT count(*) FROM shown s WHERE s.connection_id = c.id AND (s.show OR s.listed)),
    'models', COALESCE((SELECT jsonb_agg(model_row(s.id, p_operator_id) ORDER BY s.in_use DESC, s.pinned DESC, s.model_id)
                        FROM shown s WHERE s.connection_id = c.id AND s.show), '[]'::jsonb),
    'more_count', (SELECT count(*) FROM shown s WHERE s.connection_id = c.id AND s.listed AND NOT s.show)
  ) ORDER BY c.provider, c.access_gateway, c.created_at), '[]'::jsonb)
  INTO v_connections
  FROM provider_connections c
  WHERE c.operator_id = p_operator_id AND c.connection_kind = 'model_access';
  RETURN jsonb_build_object(
    'checks_today', (v_usage->>'used')::int,
    'auto_checks', jsonb_build_object('used', (v_usage->>'auto_used')::int, 'limit', (v_limits->>'auto_per_day')::int),
    'hard_limit', (v_limits->>'hard_per_day')::int,
    'connections', v_connections);
END $$;
REVOKE EXECUTE ON FUNCTION get_operator_models(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION get_operator_models(uuid) TO infra_web;

-- Search across one connection's list: id and display name, case-insensitive,
-- a vendor and "checked only" as filters, at most 50 rows; the ready ones
-- first.
CREATE FUNCTION search_operator_model_catalog(p_operator_id uuid, p_connection_id uuid, p_query text,
  p_filters jsonb, p_limit integer)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path TO control_plane, public, extensions, pg_temp
AS $$
DECLARE
  v_pattern text;
  v_vendor text;
  v_checked boolean;
  v_limit integer := LEAST(GREATEST(COALESCE(p_limit, 20), 1), 50);
  v_total integer;
  v_results jsonb;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM provider_connections WHERE id = p_connection_id AND operator_id = p_operator_id) THEN
    PERFORM refuse('catalog_entry_not_owned', format('no connection %s for this operator', p_connection_id), '42501');
  END IF;
  IF p_filters IS NOT NULL AND jsonb_typeof(p_filters) NOT IN ('object','null') THEN
    PERFORM refuse('model_check_invalid', 'search filters are an object', '22023');
  END IF;
  IF length(COALESCE(p_query,'')) > 200 THEN
    PERFORM refuse('model_check_invalid', 'a search is at most 200 characters', '22023');
  END IF;
  v_vendor := NULLIF(p_filters->>'vendor', '');
  v_checked := COALESCE((p_filters->>'checked_only')::boolean, false);
  -- The operator's text is matched literally: % and _ are not wildcards here.
  v_pattern := '%' || replace(replace(replace(COALESCE(btrim(p_query),''), '\', '\\'), '%', '\%'), '_', '\_') || '%';
  WITH matched AS (
    SELECT m.id, m.model_id, m.status = 'verified' AS ready FROM provider_model_catalog m
    WHERE m.connection_id = p_connection_id AND m.operator_id = p_operator_id
      AND m.superseded_by IS NULL AND m.status <> 'unavailable'
      AND (m.model_id ILIKE v_pattern OR m.display_name ILIKE v_pattern)
      AND (v_vendor IS NULL OR m.model_vendor = v_vendor)
      AND (NOT v_checked OR m.status = 'verified')
  )
  SELECT (SELECT count(*) FROM matched),
    COALESCE((SELECT jsonb_agg(model_row(x.id, p_operator_id) ORDER BY x.ready DESC, x.model_id)
      FROM (SELECT * FROM matched ORDER BY ready DESC, model_id LIMIT v_limit) x), '[]'::jsonb)
  INTO v_total, v_results;
  RETURN jsonb_build_object('total', v_total, 'results', v_results);
END $$;
REVOKE EXECUTE ON FUNCTION search_operator_model_catalog(uuid, uuid, text, jsonb, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION search_operator_model_catalog(uuid, uuid, text, jsonb, integer) TO infra_web;

-- A pin is how the owner says "offer this in Team" (§2.5), and it starts the
-- model's check unless one is current. The old allowlist follows the pin, so
-- the old reader's "allowlisted" stays true to it until W5-b drops both. A pin
-- past the day's ceiling is kept and starts nothing: check_id is null.
CREATE FUNCTION pin_model(p_operator_id uuid, p_entry_id uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO control_plane, public, extensions, pg_temp
AS $$
DECLARE
  v_entry provider_model_catalog%ROWTYPE;
  v_current model_checks%ROWTYPE;
  v_usage jsonb;
  v_check uuid;
BEGIN
  SELECT * INTO v_entry FROM provider_model_catalog WHERE id = p_entry_id AND operator_id = p_operator_id FOR UPDATE;
  IF NOT FOUND THEN
    PERFORM refuse('catalog_entry_not_owned', format('no model %s in this operator''s catalog', p_entry_id), '42501');
  END IF;
  IF v_entry.superseded_by IS NOT NULL THEN
    PERFORM refuse('catalog_entry_unavailable', format('model %s was replaced by %s', p_entry_id, v_entry.superseded_by));
  END IF;
  UPDATE provider_model_catalog SET pinned_at = COALESCE(pinned_at, clock_timestamp()) WHERE id = p_entry_id;
  INSERT INTO catalog_gate_allowlist(operator_id, connection_id, provider_id, model_id, created_by)
  VALUES (v_entry.operator_id, v_entry.connection_id, v_entry.provider_id, v_entry.model_id, p_operator_id::text)
  ON CONFLICT DO NOTHING;
  v_current := model_check_current(p_entry_id);
  IF v_current.id IS NOT NULL THEN
    v_check := v_current.id;
  ELSIF NOT (model_eligibility(p_entry_id)->>'eligible')::boolean
    AND v_entry.status <> 'unavailable'
    AND EXISTS (SELECT 1 FROM provider_connections WHERE id = v_entry.connection_id AND status = 'connected') THEN
    v_usage := model_check_usage(p_operator_id);
    IF (v_usage->>'used')::int + (v_usage->>'operator_pending')::int < (model_check_limits()->>'hard_per_day')::int THEN
      v_check := (queue_model_check(p_entry_id, 'pin', false, p_operator_id::text)->>'check_id')::uuid;
    END IF;
  END IF;
  PERFORM write_audit_event(NULL,NULL,NULL,'operator',p_operator_id::text,'model.pinned','provider_model_catalog',
    p_entry_id::text,'allowed',NULL,jsonb_build_object('model_id',v_entry.model_id,'check_id',v_check),p_entry_id::text);
  RETURN jsonb_build_object('entry_id', p_entry_id, 'pinned', true, 'check_id', v_check);
END $$;
REVOKE EXECUTE ON FUNCTION pin_model(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION pin_model(uuid, uuid) TO infra_web;

-- Unpinning takes nothing away: a check already asked for runs, and a ready
-- model stays ready. It only stops offering the model first and re-checking it
-- by itself.
CREATE FUNCTION unpin_model(p_operator_id uuid, p_entry_id uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO control_plane, public, extensions, pg_temp
AS $$
DECLARE v_entry provider_model_catalog%ROWTYPE;
BEGIN
  SELECT * INTO v_entry FROM provider_model_catalog WHERE id = p_entry_id AND operator_id = p_operator_id FOR UPDATE;
  IF NOT FOUND THEN
    PERFORM refuse('catalog_entry_not_owned', format('no model %s in this operator''s catalog', p_entry_id), '42501');
  END IF;
  UPDATE provider_model_catalog SET pinned_at = NULL WHERE id = p_entry_id AND pinned_at IS NOT NULL;
  DELETE FROM catalog_gate_allowlist a
  WHERE a.operator_id = v_entry.operator_id AND a.connection_id = v_entry.connection_id
    AND a.provider_id = v_entry.provider_id AND a.model_id = v_entry.model_id;
  PERFORM write_audit_event(NULL,NULL,NULL,'operator',p_operator_id::text,'model.unpinned','provider_model_catalog',
    p_entry_id::text,'allowed',NULL,jsonb_build_object('model_id',v_entry.model_id),p_entry_id::text);
  RETURN jsonb_build_object('entry_id', p_entry_id, 'pinned', false, 'check_id', NULL);
END $$;
REVOKE EXECUTE ON FUNCTION unpin_model(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION unpin_model(uuid, uuid) TO infra_web;

-- What the dialog polls. An inconclusive attempt's retry is its own row; the
-- dialog keeps the id it was given and reads the latest attempt of that chain.
CREATE FUNCTION get_model_check(p_operator_id uuid, p_check_id uuid)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path TO control_plane, public, extensions, pg_temp
AS $$
DECLARE v_asked model_checks%ROWTYPE; v_check model_checks%ROWTYPE; v_state text; v_position integer := 0;
BEGIN
  SELECT * INTO v_asked FROM model_checks WHERE id = p_check_id AND operator_id = p_operator_id;
  IF NOT FOUND THEN
    PERFORM refuse('model_check_unavailable', format('no model check %s for this operator', p_check_id), '42501');
  END IF;
  SELECT * INTO v_check FROM model_checks WHERE root_id = v_asked.root_id ORDER BY attempt DESC, requested_at DESC LIMIT 1;
  v_state := model_check_state(v_check);
  IF v_check.finished_at IS NULL AND v_check.leased_by IS NULL THEN
    SELECT count(*) INTO v_position FROM model_checks k
    WHERE k.finished_at IS NULL AND k.id <> v_check.id
      AND (k.leased_by IS NOT NULL
        OR (k.not_before <= clock_timestamp()
          AND (k.priority, k.requested_at, k.id) < (v_check.priority, v_check.requested_at, v_check.id)));
  END IF;
  RETURN jsonb_build_object(
    'check_id', p_check_id, 'entry_id', v_check.entry_id, 'attempt', v_check.attempt,
    'state', v_state, 'result', v_check.result, 'failure_class', v_check.failure_class,
    'reason', CASE WHEN v_state = 'waiting' THEN COALESCE(NULLIF(v_check.wait_reason,''), NULLIF(v_check.detail,''))
                   WHEN v_state IN ('refused','failed') THEN NULLIF(v_check.detail,'') END,
    'queue_position', v_position,
    'requested_at', v_asked.requested_at, 'started_at', v_check.started_at, 'finished_at', v_check.finished_at,
    'retry_at', CASE WHEN v_check.finished_at IS NULL AND v_check.not_before > clock_timestamp() THEN v_check.not_before
                     WHEN v_check.result = 'inconclusive' THEN v_check.retry_after END);
END $$;
REVOKE EXECUTE ON FUNCTION get_model_check(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION get_model_check(uuid, uuid) TO infra_web;
