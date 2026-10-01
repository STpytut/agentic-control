-- The panel's reads of limits and consumption (Stage 12; 0113).
--
--   get_operator_usage_limits  Settings → Limits & usage: every model connection
--                              of the operator with its latest windows (and where
--                              and when they were read), what it used today and
--                              in its current window, and whether limits can be
--                              read for it at all:
--                                read    ChatGPT — read without a model call,
--                                        and seen in every Codex run;
--                                stream  Claude — seen only during a run;
--                                probe   OpenCode Go — only through ADR-0019's
--                                        probe, which is not installed yet;
--                                free    OpenCode Zen — free, no limits;
--                                none    OpenRouter — no limits, and the
--                                        account's balance is not read (the
--                                        owner, ADR-0019).
--                              For OpenCode Go also the requests our runs and
--                              checks made per model in the last five hours
--                              (OpenCode's model steps), which the panel sets
--                              beside the per-model estimates opencode.ai/go
--                              publishes.
--   get_task_usage             the task view: what each member of the task's
--                              conversation used, live while a run is going,
--                              and the windows of the connections they ran on.
--
-- Both are read-only definers that check the operator themselves, like every
-- web-facing function (0062); they return numbers, times and closed words.
-- "Today" is the UTC day. Model checks are counted apart, as checks.

SET search_path TO control_plane, public, extensions;

CREATE FUNCTION usage_limits_mode(p_gateway text)
RETURNS text
LANGUAGE sql IMMUTABLE
SET search_path TO control_plane, public, extensions, pg_temp
AS $$
  SELECT CASE p_gateway WHEN 'openai_chatgpt' THEN 'read' WHEN 'claude_subscription' THEN 'stream'
    WHEN 'opencode_go' THEN 'probe' WHEN 'opencode_zen' THEN 'free' ELSE 'none' END;
$$;

-- Requests per model since a moment: a request is one model call — an
-- OpenCode step (step_finish), a Codex usage update, a Claude turn — which
-- run_usage counts as model_steps. Checks count too: they spend the same quota.
CREATE FUNCTION usage_requests_by_model(p_connection_id uuid, p_since timestamptz)
RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO control_plane, public, extensions, pg_temp
AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object('model', m.model, 'requests', m.requests, 'total_tokens', m.total_tokens)
    ORDER BY m.requests DESC, m.model), '[]'::jsonb)
  FROM (SELECT u.model, sum(u.model_steps) AS requests, sum(u.total_tokens) AS total_tokens
        FROM run_usage u WHERE u.connection_id = p_connection_id AND u.started_at >= p_since AND u.model <> ''
        GROUP BY u.model ORDER BY 2 DESC LIMIT 50) m;
$$;

CREATE FUNCTION usage_connection_label(p_gateway text, p_provider text)
RETURNS text
LANGUAGE sql IMMUTABLE
SET search_path TO control_plane, public, extensions, pg_temp
AS $$
  SELECT CASE p_gateway WHEN 'openai_chatgpt' THEN 'ChatGPT' WHEN 'claude_subscription' THEN 'Claude'
    WHEN 'opencode_zen' THEN 'OpenCode Zen' WHEN 'opencode_go' THEN 'OpenCode Go'
    WHEN 'openrouter' THEN 'OpenRouter' ELSE p_provider END;
$$;

-- A connection's latest reading as the panel shows it: reset times as
-- timestamps, and whether each reset has passed since (the percentage then says
-- nothing about now).
CREATE FUNCTION latest_usage_reading(p_connection_id uuid)
RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO control_plane, public, extensions, pg_temp
AS $$
  SELECT jsonb_build_object(
    'source', r.source, 'read_at', r.read_at, 'first_read_at', r.first_read_at,
    'windows', COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'key', w->>'key', 'used_percent', (w->>'used_percent')::numeric,
        'resets_at', CASE WHEN w->'resets_at' <> 'null'::jsonb THEN to_timestamp((w->>'resets_at')::bigint) END,
        'window_minutes', (w->>'window_minutes')::integer,
        'reset_passed', w->'resets_at' <> 'null'::jsonb AND to_timestamp((w->>'resets_at')::bigint) <= clock_timestamp())
        ORDER BY o) FROM jsonb_array_elements(r.windows) WITH ORDINALITY x(w, o)), '[]'::jsonb),
    'plan', r.plan, 'credits', r.credits, 'status', r.status, 'error_class', r.error_class)
  FROM provider_usage_readings r
  WHERE r.connection_id = p_connection_id
  ORDER BY r.read_at DESC, r.id DESC LIMIT 1;
$$;

-- The current window: the shortest one of the latest reading that has not
-- reset yet, from when it began.
CREATE FUNCTION usage_current_window(p_connection_id uuid)
RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO control_plane, public, extensions, pg_temp
AS $$
  SELECT jsonb_build_object('key', w->>'key',
    'since', to_timestamp((w->>'resets_at')::bigint) - make_interval(mins => (w->>'window_minutes')::integer),
    'until', to_timestamp((w->>'resets_at')::bigint))
  FROM (SELECT r.windows FROM provider_usage_readings r WHERE r.connection_id = p_connection_id
        ORDER BY r.read_at DESC, r.id DESC LIMIT 1) r,
    jsonb_array_elements(r.windows) w
  WHERE w->'resets_at' <> 'null'::jsonb AND w->'window_minutes' <> 'null'::jsonb
    AND to_timestamp((w->>'resets_at')::bigint) > clock_timestamp()
  ORDER BY (w->>'window_minutes')::integer, w->>'key' LIMIT 1;
$$;

-- What a set of run_usage rows adds up to; checks apart.
CREATE FUNCTION usage_totals(p_rows run_usage[])
RETURNS jsonb
LANGUAGE sql IMMUTABLE
SET search_path TO control_plane, public, extensions, pg_temp
AS $$
  SELECT jsonb_build_object(
    'input_tokens', COALESCE(sum(u.input_tokens) FILTER (WHERE u.kind = 'run'), 0),
    'cache_read_tokens', COALESCE(sum(u.cache_read_tokens) FILTER (WHERE u.kind = 'run'), 0),
    'cache_write_tokens', COALESCE(sum(u.cache_write_tokens) FILTER (WHERE u.kind = 'run'), 0),
    'output_tokens', COALESCE(sum(u.output_tokens) FILTER (WHERE u.kind = 'run'), 0),
    'reasoning_tokens', COALESCE(sum(u.reasoning_tokens) FILTER (WHERE u.kind = 'run'), 0),
    'total_tokens', COALESCE(sum(u.total_tokens) FILTER (WHERE u.kind = 'run'), 0),
    'cost_usd', sum(u.cost_usd) FILTER (WHERE u.kind = 'run'),
    'cost_basis', CASE WHEN bool_or(u.cost_basis = 'list_estimate') FILTER (WHERE u.kind = 'run') THEN 'list_estimate'
                       WHEN bool_or(u.cost_basis = 'provider') FILTER (WHERE u.kind = 'run') THEN 'provider' ELSE 'none' END,
    'runs', count(*) FILTER (WHERE u.kind = 'run'),
    'model_steps', COALESCE(sum(u.model_steps) FILTER (WHERE u.kind = 'run'), 0),
    'checks', jsonb_build_object('count', count(*) FILTER (WHERE u.kind = 'check'),
      'total_tokens', COALESCE(sum(u.total_tokens) FILTER (WHERE u.kind = 'check'), 0),
      'cost_usd', sum(u.cost_usd) FILTER (WHERE u.kind = 'check')),
    'updated_at', max(u.updated_at))
  FROM unnest(p_rows) u;
$$;

CREATE FUNCTION get_operator_usage_limits(p_operator_id uuid)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path TO control_plane, public, extensions, pg_temp
AS $$
DECLARE v_day timestamptz := date_trunc('day', clock_timestamp() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC';
BEGIN
  IF NOT EXISTS (SELECT 1 FROM users WHERE id = p_operator_id AND disabled_at IS NULL) THEN
    PERFORM refuse('usage_unavailable', 'no such operator', '42501');
  END IF;
  RETURN jsonb_build_object(
    'generated_at', clock_timestamp(), 'day_start', v_day,
    'connections', COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'connection_id', c.id,
        'provider', CASE c.access_gateway WHEN 'opencode_go' THEN 'opencode-go' WHEN 'openrouter' THEN 'openrouter' ELSE c.provider END,
        'label', usage_connection_label(c.access_gateway, c.provider),
        'gateway', c.access_gateway, 'runtime_type', c.provider, 'status', c.status,
        'billing', CASE WHEN c.billing_boundary IN ('subscription','free') THEN c.billing_boundary ELSE 'metered' END,
        'limits_mode', usage_limits_mode(c.access_gateway),
        'limits', latest_usage_reading(c.id),
        'today', usage_totals(ARRAY(SELECT u FROM run_usage u WHERE u.connection_id = c.id AND u.started_at >= v_day)),
        'window', (SELECT w || jsonb_build_object('usage',
                     usage_totals(ARRAY(SELECT u FROM run_usage u WHERE u.connection_id = c.id
                                          AND u.started_at >= (w->>'since')::timestamptz)))
                   FROM usage_current_window(c.id) w WHERE w IS NOT NULL),
        'requests_5h', CASE WHEN c.access_gateway = 'opencode_go' THEN jsonb_build_object(
          'since', clock_timestamp() - interval '5 hours',
          'models', usage_requests_by_model(c.id, clock_timestamp() - interval '5 hours')) END)
      ORDER BY c.provider, c.access_gateway, c.created_at)
      FROM provider_connections c
      WHERE c.operator_id = p_operator_id AND c.connection_kind = 'model_access'), '[]'::jsonb));
END $$;

-- The task view's consumption: every member of the conversation's team, each
-- with what its runs used (live: the counts move as the runtime reports), and
-- the windows of the connections they ran on. Null for a task that is not the
-- operator's.
CREATE FUNCTION get_task_usage(p_project_id uuid, p_task_id uuid, p_owner_id uuid)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path TO control_plane, public, extensions, pg_temp
AS $$
DECLARE v_task tasks%ROWTYPE; v_lineage uuid[]; v_rows run_usage[]; v_members jsonb; v_connections jsonb;
BEGIN
  SELECT t.* INTO v_task FROM tasks t JOIN projects p ON p.id = t.project_id
  WHERE t.id = p_task_id AND t.project_id = p_project_id AND p.owner_id = p_owner_id;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT array_agg(m.id) INTO v_lineage FROM tasks m
  WHERE m.id = v_task.id OR (v_task.conversation_id IS NOT NULL AND m.conversation_id = v_task.conversation_id);
  v_rows := ARRAY(SELECT u FROM run_usage u WHERE u.kind = 'run' AND u.task_id = ANY(v_lineage));

  WITH team AS (
    SELECT DISTINCT a.id FROM tasks t JOIN project_agent_assignments a ON a.id = t.orchestrator_assignment_id
    WHERE t.id = ANY(v_lineage)
    UNION SELECT tea.project_agent_assignment_id FROM task_executor_assignments tea
    WHERE tea.task_id = ANY(v_lineage) AND tea.enabled
    UNION SELECT u.assignment_id FROM unnest(v_rows) u WHERE u.assignment_id IS NOT NULL
  ), member AS (
    SELECT a.id AS assignment_id, ag.name AS agent_name, rp.runtime_type, rd.builtin_key AS role_key,
      a.id = v_task.orchestrator_assignment_id AS is_orchestrator, a.created_at,
      ARRAY(SELECT u FROM unnest(v_rows) u WHERE u.assignment_id = a.id) AS rows
    FROM team JOIN project_agent_assignments a ON a.id = team.id
    JOIN agents ag ON ag.id = a.agent_id
    JOIN runtime_profiles rp ON rp.id = a.runtime_profile_id
    LEFT JOIN role_definitions rd ON rd.id = a.role_definition_id
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'assignment_id', m.assignment_id, 'agent_name', m.agent_name, 'runtime_type', m.runtime_type,
      'role_key', COALESCE(m.role_key, CASE WHEN m.is_orchestrator THEN 'orchestrator' ELSE 'executor' END),
      -- What its last run ran on.
      'model', NULLIF((SELECT u.model FROM unnest(m.rows) u ORDER BY u.started_at DESC, u.id DESC LIMIT 1), ''),
      'reasoning_effort', (SELECT u.reasoning_effort FROM unnest(m.rows) u ORDER BY u.started_at DESC, u.id DESC LIMIT 1),
      'connection_id', (SELECT u.connection_id FROM unnest(m.rows) u ORDER BY u.started_at DESC, u.id DESC LIMIT 1),
      'running', EXISTS (SELECT 1 FROM unnest(m.rows) u JOIN runtime_jobs j ON j.id = u.job_id
                         WHERE u.finished_at IS NULL AND j.status = 'in_flight'),
      'usage', usage_totals(m.rows))
    ORDER BY m.is_orchestrator DESC, m.created_at, m.assignment_id), '[]'::jsonb)
  INTO v_members FROM member m;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'connection_id', c.id, 'label', usage_connection_label(c.access_gateway, c.provider),
      'gateway', c.access_gateway, 'runtime_type', c.provider,
      'limits_mode', usage_limits_mode(c.access_gateway), 'limits', latest_usage_reading(c.id))
    ORDER BY c.provider, c.access_gateway), '[]'::jsonb)
  INTO v_connections
  FROM provider_connections c
  WHERE c.operator_id = p_owner_id AND c.id IN (SELECT u.connection_id FROM unnest(v_rows) u);

  RETURN jsonb_build_object(
    'task_id', v_task.id, 'generated_at', clock_timestamp(),
    'active', EXISTS (SELECT 1 FROM runtime_jobs j WHERE j.task_id = ANY(v_lineage) AND j.status = 'in_flight'),
    'totals', usage_totals(v_rows),
    'members', v_members,
    'connections', v_connections);
END $$;

REVOKE EXECUTE ON FUNCTION usage_limits_mode(text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION usage_requests_by_model(uuid, timestamptz) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION usage_connection_label(text, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION latest_usage_reading(uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION usage_current_window(uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION usage_totals(run_usage[]) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION get_operator_usage_limits(uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION get_task_usage(uuid, uuid, uuid) FROM PUBLIC;
-- A deliberate widening of infra_web's surface, listed in 0026's allowlist:
-- two reads, each checking the operator itself. The helpers are not granted.
GRANT EXECUTE ON FUNCTION get_operator_usage_limits(uuid) TO infra_web;
GRANT EXECUTE ON FUNCTION get_task_usage(uuid, uuid, uuid) TO infra_web;
