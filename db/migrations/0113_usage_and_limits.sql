-- Subscription limits and live consumption (Stage 12;
-- docs/REASONING_AND_LIMITS_RESEARCH.md, docs/adr/0019-provider-usage-probe.md).
--
-- Two tables, both written only through the functions below:
--
--   provider_usage_readings  a connection's usage windows as last read — the
--                            percent used, when each resets, the plan and the
--                            credits — with where the reading came from:
--                              runtime_stream  seen in a run's own stream
--                                              (Codex account/rateLimits/updated,
--                                              Claude Code rate_limit_event);
--                              runtime_read    asked of the runtime without a
--                                              model call (Codex
--                                              account/rateLimits/read);
--                              probe           ADR-0019's usage probe (accepted for
--                                              OpenCode Go only). Not built in
--                                              this change: the source is here so
--                                              its readings fit when it is.
--                            The latest per connection and a short history (50).
--
--   run_usage                what one run used: per dispatch attempt (0071), or
--                            per model check ('check'), with the member, the
--                            task, the connection, the model and the level it
--                            ran at; input, cached, output and reasoning tokens;
--                            the cost and what the cost is — 'list_estimate' for
--                            OpenCode's and Claude Code's list-price figures,
--                            'provider' for a provider's bill (none today),
--                            'none' where nothing was reported (Codex).
--
-- How a run's numbers arrive. Every runtime's stream already reaches the
-- database one way, whichever process reads it: append_runtime_activity_event,
-- from the orchestrator worker (Codex) and the supervisor's batch runs (Claude
-- Code, OpenCode). The normalisers now also turn the usage and window events
-- into bounded activity events (runtime-events.mjs), and a trigger on that
-- table adds them up here. So no worker path changes, and a runtime's output is
-- bounded twice: by its normaliser and again by the cleaning below. A dispatch
-- attempt opens its row when it is recorded and closes it when it finishes.
--
-- Nothing here stores a credential, a prompt or a model's words: numbers, times
-- and words from closed lists.
--
-- An accounting failure never fails a run: the triggers catch their own errors
-- and warn. The previous release writes the same activity events it always
-- wrote (its Claude and OpenCode usage events are counted from now on); it
-- never calls anything added here.

SET search_path TO control_plane, public, extensions;

INSERT INTO failure_reasons(reason, code, note) VALUES
  ('usage_reading_invalid','invalid_argument','a usage reading names a model connection and a source from the list'),
  ('usage_unavailable','permission_denied','no usage for this operator');

CREATE TABLE provider_usage_readings (
  id bigserial PRIMARY KEY,
  connection_id uuid NOT NULL REFERENCES provider_connections(id) ON DELETE CASCADE,
  operator_id uuid NOT NULL,
  runtime_type text NOT NULL CHECK (runtime_type IN ('codex','opencode','claude','antigravity')),
  source text NOT NULL CHECK (source IN ('runtime_stream','runtime_read','probe')),
  -- [{key, used_percent 0–100, resets_at unix seconds|null, window_minutes|null}]
  windows jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(windows) = 'array' AND jsonb_array_length(windows) <= 8 AND octet_length(windows::text) <= 2048),
  plan text CHECK (plan ~ '^[a-z0-9_]{1,40}$'),
  credits jsonb CHECK (credits IS NULL OR (jsonb_typeof(credits) = 'object' AND octet_length(credits::text) <= 512)),
  status text CHECK (status IN ('allowed','allowed_warning','rejected')),
  -- ADR-0019 §1: the probe's error classes. Nothing else writes one.
  error_class text CHECK (error_class IN ('unauthorized','unavailable','malformed','timeout')),
  -- The same reading seen again moves read_at; first_read_at stays.
  first_read_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  read_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (read_at >= first_read_at)
);
CREATE INDEX provider_usage_readings_latest ON provider_usage_readings(connection_id, read_at DESC, id DESC);

CREATE TABLE run_usage (
  id bigserial PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('run','check')),
  attempt_id bigint UNIQUE REFERENCES runtime_dispatch_attempts(id) ON DELETE CASCADE,
  job_id bigint REFERENCES runtime_jobs(id) ON DELETE CASCADE,
  check_id uuid UNIQUE REFERENCES model_checks(id) ON DELETE CASCADE,
  operator_id uuid NOT NULL,
  -- Kept as ids, not references: a project's removal is its own business and
  -- must not wait on its accounting.
  project_id uuid,
  task_id uuid,
  assignment_id uuid,
  agent_id uuid,
  connection_id uuid REFERENCES provider_connections(id) ON DELETE SET NULL,
  runtime_type text NOT NULL CHECK (runtime_type IN ('codex','opencode','claude','antigravity')),
  model text NOT NULL DEFAULT '' CHECK (length(model) <= 200),
  reasoning_effort text CHECK (reasoning_effort ~ '^[a-z0-9_]{1,32}$'),
  input_tokens bigint NOT NULL DEFAULT 0 CHECK (input_tokens BETWEEN 0 AND 1000000000000),
  cache_read_tokens bigint NOT NULL DEFAULT 0 CHECK (cache_read_tokens BETWEEN 0 AND 1000000000000),
  cache_write_tokens bigint NOT NULL DEFAULT 0 CHECK (cache_write_tokens BETWEEN 0 AND 1000000000000),
  output_tokens bigint NOT NULL DEFAULT 0 CHECK (output_tokens BETWEEN 0 AND 1000000000000),
  reasoning_tokens bigint NOT NULL DEFAULT 0 CHECK (reasoning_tokens BETWEEN 0 AND 1000000000000),
  total_tokens bigint NOT NULL DEFAULT 0 CHECK (total_tokens BETWEEN 0 AND 5000000000000),
  model_steps integer NOT NULL DEFAULT 0 CHECK (model_steps BETWEEN 0 AND 1000000),
  cost_usd numeric(16,6) CHECK (cost_usd IS NULL OR cost_usd BETWEEN 0 AND 1000000),
  cost_basis text NOT NULL DEFAULT 'none' CHECK (cost_basis IN ('provider','list_estimate','none')),
  -- Codex's running thread total at the last counted update: an update that
  -- repeats it is the same usage sent again, and is not counted twice.
  native_total bigint CHECK (native_total >= 0),
  started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  finished_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK ((cost_usd IS NULL) = (cost_basis = 'none')),
  CHECK ((kind = 'check') = (check_id IS NOT NULL)),
  CHECK (kind = 'check' OR job_id IS NOT NULL)
);
-- A job's usage before any attempt was recorded for it (a turn in flight when
-- this migration ran) has one row of its own.
CREATE UNIQUE INDEX run_usage_job_without_attempt ON run_usage(job_id) WHERE kind = 'run' AND attempt_id IS NULL;
CREATE INDEX run_usage_task ON run_usage(task_id) WHERE task_id IS NOT NULL;
CREATE INDEX run_usage_connection_recent ON run_usage(connection_id, started_at) WHERE connection_id IS NOT NULL;
CREATE INDEX run_usage_started ON run_usage(started_at);

-- ------------------------------------------------------------------ cleaning

-- A non-negative whole number from JSON, or 0: a count the runtime sent as
-- something else is not a count.
CREATE FUNCTION usage_count(p_value jsonb, p_max bigint DEFAULT 50000000)
RETURNS bigint
LANGUAGE sql IMMUTABLE
SET search_path TO control_plane, public, extensions, pg_temp
AS $$
  SELECT CASE WHEN jsonb_typeof(p_value) = 'number' AND (p_value #>> '{}')::numeric BETWEEN 0 AND p_max
              AND (p_value #>> '{}')::numeric = trunc((p_value #>> '{}')::numeric)
         THEN (p_value #>> '{}')::bigint ELSE 0 END;
$$;

-- A reading, rebuilt from named fields with each value checked: the windows
-- (at most eight), the plan, the credits, the status and a probe's error class.
-- Whatever else it carried is not kept.
CREATE FUNCTION usage_reading_clean(p_reading jsonb)
RETURNS jsonb
LANGUAGE sql IMMUTABLE
SET search_path TO control_plane, public, extensions, pg_temp
AS $$
  WITH r AS (SELECT CASE WHEN jsonb_typeof(p_reading) = 'object' THEN p_reading ELSE '{}'::jsonb END AS v),
  w AS (
    SELECT e.value AS v, e.ordinality AS n
    FROM r, jsonb_array_elements(CASE WHEN jsonb_typeof(r.v->'windows') = 'array' THEN r.v->'windows' ELSE '[]'::jsonb END)
      WITH ORDINALITY e
    WHERE e.ordinality <= 8 AND jsonb_typeof(e.value) = 'object'
      AND e.value->>'key' ~ '^[a-z0-9_]{1,40}$'
      AND jsonb_typeof(e.value->'used_percent') = 'number'
      AND (e.value->>'used_percent')::numeric BETWEEN 0 AND 100
  ),
  c AS (SELECT CASE WHEN jsonb_typeof(r.v->'credits') = 'object' THEN r.v->'credits' END AS v FROM r)
  SELECT jsonb_build_object(
    'windows', COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'key', w.v->>'key',
        'used_percent', trim_scale(round((w.v->>'used_percent')::numeric, 1)),
        'resets_at', CASE WHEN jsonb_typeof(w.v->'resets_at') = 'number'
                            AND (w.v->>'resets_at')::numeric BETWEEN 1600000000 AND 4100000000
                          THEN floor((w.v->>'resets_at')::numeric)::bigint END,
        'window_minutes', CASE WHEN jsonb_typeof(w.v->'window_minutes') = 'number'
                                 AND (w.v->>'window_minutes')::numeric BETWEEN 1 AND 527040
                               THEN floor((w.v->>'window_minutes')::numeric)::integer END) ORDER BY w.n) FROM w), '[]'::jsonb),
    'plan', CASE WHEN r.v->>'plan' ~ '^[a-z0-9_]{1,40}$' THEN r.v->>'plan' END,
    'credits', CASE WHEN c.v IS NOT NULL THEN jsonb_build_object(
        'has_credits', CASE WHEN jsonb_typeof(c.v->'has_credits') = 'boolean' THEN c.v->'has_credits' END,
        'unlimited', CASE WHEN jsonb_typeof(c.v->'unlimited') = 'boolean' THEN c.v->'unlimited' END,
        'balance', CASE WHEN c.v->>'balance' ~ '^-?[0-9]{1,12}([.][0-9]{1,6})?$' THEN c.v->>'balance' END) END,
    'status', CASE WHEN r.v->>'status' IN ('allowed','allowed_warning','rejected') THEN r.v->>'status' END,
    'error_class', CASE WHEN r.v->>'error_class' IN ('unauthorized','unavailable','malformed','timeout') THEN r.v->>'error_class' END)
  FROM r, c;
$$;

-- ------------------------------------------------------------------ readings

-- One reading of a connection's windows. The same reading from the same source
-- within ten minutes only moves its read_at, so a stream that repeats itself
-- every model call does not fill the history; the history keeps 50.
CREATE FUNCTION record_provider_usage_reading(p_connection_id uuid, p_source text, p_reading jsonb,
  p_read_at timestamptz DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO control_plane, public, extensions, pg_temp
AS $$
DECLARE
  v_connection provider_connections%ROWTYPE; v_clean jsonb; v_latest provider_usage_readings%ROWTYPE;
  v_at timestamptz := LEAST(COALESCE(p_read_at, clock_timestamp()), clock_timestamp()); v_id bigint;
BEGIN
  IF p_source IS NULL OR p_source NOT IN ('runtime_stream','runtime_read','probe') THEN
    PERFORM refuse('usage_reading_invalid', 'a reading comes from the runtime''s stream, a runtime read or the probe', '22023');
  END IF;
  SELECT * INTO v_connection FROM provider_connections WHERE id = p_connection_id AND connection_kind = 'model_access';
  IF NOT FOUND THEN
    PERFORM refuse('usage_reading_invalid', format('no model connection %s', p_connection_id), '22023');
  END IF;
  v_clean := usage_reading_clean(p_reading);
  IF jsonb_array_length(v_clean->'windows') = 0 AND v_clean->'plan' = 'null'::jsonb AND v_clean->'credits' = 'null'::jsonb
     AND v_clean->'status' = 'null'::jsonb AND v_clean->'error_class' = 'null'::jsonb THEN
    RETURN jsonb_build_object('recorded', false, 'reason', 'nothing usable');
  END IF;
  SELECT * INTO v_latest FROM provider_usage_readings
  WHERE connection_id = p_connection_id ORDER BY read_at DESC, id DESC LIMIT 1 FOR UPDATE;
  IF FOUND AND v_latest.source = p_source AND v_latest.windows = v_clean->'windows'
     AND v_latest.plan IS NOT DISTINCT FROM v_clean->>'plan'
     AND v_latest.credits IS NOT DISTINCT FROM NULLIF(v_clean->'credits', 'null'::jsonb)
     AND v_latest.status IS NOT DISTINCT FROM v_clean->>'status'
     AND v_latest.error_class IS NOT DISTINCT FROM v_clean->>'error_class'
     AND v_at >= v_latest.read_at AND v_at - v_latest.first_read_at < interval '10 minutes' THEN
    UPDATE provider_usage_readings SET read_at = v_at WHERE id = v_latest.id;
    RETURN jsonb_build_object('recorded', true, 'reading_id', v_latest.id, 'repeat', true);
  END IF;
  INSERT INTO provider_usage_readings(connection_id, operator_id, runtime_type, source, windows, plan, credits, status,
    error_class, first_read_at, read_at)
  VALUES (p_connection_id, v_connection.operator_id, v_connection.provider, p_source, v_clean->'windows',
    v_clean->>'plan', NULLIF(v_clean->'credits', 'null'::jsonb), v_clean->>'status', v_clean->>'error_class', v_at, v_at)
  RETURNING id INTO v_id;
  DELETE FROM provider_usage_readings
  WHERE connection_id = p_connection_id
    AND id NOT IN (SELECT id FROM provider_usage_readings WHERE connection_id = p_connection_id
                   ORDER BY read_at DESC, id DESC LIMIT 50);
  RETURN jsonb_build_object('recorded', true, 'reading_id', v_id, 'repeat', false);
END $$;

-- The ChatGPT connections whose windows nobody has read for p_every: the
-- account worker reads them without a model call (account/rateLimits/read), so
-- an idle panel still has a value, and a run's own readings keep it quiet.
CREATE FUNCTION codex_usage_reads_due(p_every interval)
RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO control_plane, public, extensions, pg_temp
AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object('connection_id', c.id) ORDER BY c.created_at), '[]'::jsonb)
  FROM provider_connections c
  WHERE c.access_gateway = 'openai_chatgpt' AND c.status = 'connected'
    AND NOT EXISTS (SELECT 1 FROM provider_usage_readings r
                    WHERE r.connection_id = c.id AND r.read_at > clock_timestamp() - GREATEST(p_every, interval '1 minute'));
$$;

-- ------------------------------------------------------------------ runs

-- Which connection, model and level a job's run used, for the member that ran
-- it: the entry the task's snapshot bound to that assignment (0028), and
-- failing that the only connection it can be — the runtime's one model
-- connection (a ChatGPT or a Claude login), or the one connection whose
-- catalog lists the model.
CREATE FUNCTION run_usage_context(p_job_id bigint, p_assignment_id uuid, p_runtime text, p_model text)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path TO control_plane, public, extensions, pg_temp
AS $$
DECLARE v_job runtime_jobs%ROWTYPE; v_owner uuid; v_task tasks%ROWTYPE; v_entry jsonb; v_connection uuid;
BEGIN
  SELECT * INTO v_job FROM runtime_jobs WHERE id = p_job_id;
  SELECT owner_id INTO v_owner FROM projects WHERE id = v_job.project_id;
  SELECT * INTO v_task FROM tasks WHERE id = v_job.task_id;
  SELECT CASE WHEN p_assignment_id IS NOT NULL AND p_assignment_id = v_task.orchestrator_assignment_id THEN s.orchestrator
              ELSE (SELECT e FROM jsonb_array_elements(s.executors) e
                    WHERE p_assignment_id IS NOT NULL AND e->'assignment_ids' @> to_jsonb(p_assignment_id::text) LIMIT 1) END
    INTO v_entry
  FROM task_runtime_snapshots s WHERE s.task_id = v_job.task_id;
  IF v_entry IS NOT NULL AND v_entry->>'runtime_type' IS DISTINCT FROM p_runtime THEN v_entry := NULL; END IF;
  v_connection := CASE WHEN v_entry->>'connection_id' ~ '^[0-9a-f-]{36}$' THEN (v_entry->>'connection_id')::uuid END;
  IF v_connection IS NULL THEN
    SELECT CASE WHEN count(*) = 1 THEN min(id::text)::uuid END INTO v_connection FROM provider_connections
    WHERE operator_id = v_owner AND provider = p_runtime AND connection_kind = 'model_access';
  END IF;
  IF v_connection IS NULL AND COALESCE(p_model, '') <> '' THEN
    SELECT CASE WHEN count(DISTINCT m.connection_id) = 1 THEN min(m.connection_id::text)::uuid END INTO v_connection
    FROM provider_model_catalog m
    WHERE m.operator_id = v_owner AND m.runtime_type = p_runtime AND m.superseded_by IS NULL
      AND (m.model_id = p_model OR m.provider_id || '/' || m.model_id = p_model);
  END IF;
  RETURN jsonb_build_object(
    'operator_id', v_owner, 'project_id', v_job.project_id, 'task_id', v_job.task_id,
    'connection_id', v_connection,
    'model', left(COALESCE(NULLIF(p_model, ''), v_entry->>'model_id', ''), 200),
    'reasoning_effort', CASE WHEN v_entry->>'reasoning_effort' ~ '^[a-z0-9_]{1,32}$' THEN v_entry->>'reasoning_effort' END);
END $$;

-- The row a job's usage goes to: its latest attempt's, opened here if the
-- attempt was recorded before this migration; a job without any attempt has a
-- row of its own.
CREATE FUNCTION run_usage_row_for_job(p_job_id bigint, p_runtime text)
RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO control_plane, public, extensions, pg_temp
AS $$
DECLARE v_attempt runtime_dispatch_attempts%ROWTYPE; v_selection runtime_job_selections%ROWTYPE; v_id bigint; v_context jsonb;
BEGIN
  SELECT * INTO v_attempt FROM runtime_dispatch_attempts WHERE job_id = p_job_id ORDER BY id DESC LIMIT 1;
  IF FOUND THEN
    SELECT id INTO v_id FROM run_usage WHERE attempt_id = v_attempt.id;
    IF v_id IS NOT NULL THEN RETURN v_id; END IF;
    SELECT * INTO v_selection FROM runtime_job_selections WHERE id = v_attempt.selection_id;
  ELSE
    SELECT id INTO v_id FROM run_usage WHERE job_id = p_job_id AND kind = 'run' AND attempt_id IS NULL;
    IF v_id IS NOT NULL THEN RETURN v_id; END IF;
    v_selection := current_runtime_job_selection(p_job_id);
  END IF;
  v_context := run_usage_context(p_job_id, v_selection.assignment_id, COALESCE(v_attempt.runtime_type, v_selection.runtime_type, p_runtime),
    v_selection.model);
  IF v_context->>'operator_id' IS NULL THEN RETURN NULL; END IF;
  INSERT INTO run_usage(kind, attempt_id, job_id, operator_id, project_id, task_id, assignment_id, agent_id, connection_id,
    runtime_type, model, reasoning_effort, started_at, finished_at)
  VALUES ('run', v_attempt.id, p_job_id, (v_context->>'operator_id')::uuid, (v_context->>'project_id')::uuid,
    (v_context->>'task_id')::uuid, v_selection.assignment_id, v_selection.agent_id,
    (v_context->>'connection_id')::uuid, COALESCE(v_attempt.runtime_type, v_selection.runtime_type, p_runtime),
    v_context->>'model', v_context->>'reasoning_effort', COALESCE(v_attempt.started_at, clock_timestamp()), v_attempt.finished_at)
  ON CONFLICT DO NOTHING
  RETURNING id INTO v_id;
  IF v_id IS NULL THEN
    SELECT id INTO v_id FROM run_usage
    WHERE (v_attempt.id IS NOT NULL AND attempt_id = v_attempt.id)
       OR (v_attempt.id IS NULL AND job_id = p_job_id AND kind = 'run' AND attempt_id IS NULL);
  END IF;
  RETURN v_id;
END $$;

-- Adds one normalised usage event to a row: tokens by name, each bounded, and
-- the cost with what it is. A Codex update whose thread total has not moved
-- past the last one counted is a repeat.
CREATE FUNCTION run_usage_add(p_row_id bigint, p_details jsonb)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO control_plane, public, extensions, pg_temp
AS $$
DECLARE
  v_row run_usage%ROWTYPE; v_tokens jsonb := CASE WHEN jsonb_typeof(p_details->'tokens') = 'object' THEN p_details->'tokens' ELSE '{}'::jsonb END;
  v_total bigint := CASE WHEN jsonb_typeof(p_details->'thread_total') = 'number'
                         THEN NULLIF(usage_count(p_details->'thread_total', 1000000000000), 0) END;
  v_in bigint; v_read bigint; v_write bigint; v_out bigint; v_reasoning bigint;
  v_cost numeric := CASE WHEN jsonb_typeof(p_details->'cost') = 'number' AND (p_details->>'cost')::numeric BETWEEN 0 AND 1000
                         THEN round((p_details->>'cost')::numeric, 6) END;
  v_basis text := CASE WHEN p_details->>'cost_basis' = 'provider' THEN 'provider' ELSE 'list_estimate' END;
BEGIN
  SELECT * INTO v_row FROM run_usage WHERE id = p_row_id FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  IF v_total IS NOT NULL AND v_row.native_total IS NOT NULL AND v_total <= v_row.native_total THEN RETURN false; END IF;
  v_in := usage_count(v_tokens->'input');
  v_read := usage_count(v_tokens#>'{cache,read}');
  v_write := usage_count(v_tokens#>'{cache,write}');
  v_out := usage_count(v_tokens->'output');
  v_reasoning := usage_count(v_tokens->'reasoning');
  UPDATE run_usage SET
    input_tokens = LEAST(input_tokens + v_in, 1000000000000),
    cache_read_tokens = LEAST(cache_read_tokens + v_read, 1000000000000),
    cache_write_tokens = LEAST(cache_write_tokens + v_write, 1000000000000),
    output_tokens = LEAST(output_tokens + v_out, 1000000000000),
    reasoning_tokens = LEAST(reasoning_tokens + v_reasoning, 1000000000000),
    total_tokens = LEAST(total_tokens + v_in + v_read + v_write + v_out + v_reasoning, 5000000000000),
    model_steps = LEAST(model_steps + 1, 1000000),
    cost_usd = CASE WHEN v_cost IS NULL THEN cost_usd ELSE LEAST(COALESCE(cost_usd, 0) + v_cost, 1000000) END,
    cost_basis = CASE WHEN v_cost IS NULL THEN cost_basis
                      WHEN cost_basis = 'list_estimate' OR v_basis = 'list_estimate' THEN 'list_estimate'
                      ELSE 'provider' END,
    native_total = COALESCE(v_total, native_total),
    updated_at = clock_timestamp()
  WHERE id = p_row_id;
  RETURN true;
END $$;

-- An attempt opens its row when it is recorded, and closes it when it ends.
-- Old rows go after a year and a half, so the table stays bounded.
CREATE FUNCTION run_usage_follow_attempt()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO control_plane, public, extensions, pg_temp
AS $$
BEGIN
  BEGIN
    IF TG_OP = 'INSERT' THEN
      PERFORM run_usage_row_for_job(NEW.job_id, NEW.runtime_type);
      DELETE FROM run_usage WHERE started_at < clock_timestamp() - interval '550 days';
    ELSIF NEW.finished_at IS NOT NULL AND OLD.finished_at IS NULL THEN
      UPDATE run_usage SET finished_at = NEW.finished_at, updated_at = clock_timestamp() WHERE attempt_id = NEW.id;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'run usage was not recorded for attempt %: %', NEW.id, SQLERRM;
  END;
  RETURN NULL;
END $$;
CREATE TRIGGER runtime_dispatch_attempts_usage AFTER INSERT OR UPDATE OF finished_at ON runtime_dispatch_attempts
  FOR EACH ROW EXECUTE FUNCTION run_usage_follow_attempt();

-- A run's usage and window events, as they are appended to its activity.
CREATE FUNCTION run_usage_from_activity()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO control_plane, public, extensions, pg_temp
AS $$
DECLARE v_row bigint; v_connection uuid;
BEGIN
  BEGIN
    v_row := run_usage_row_for_job(NEW.job_id, NEW.runtime_type);
    IF NEW.event_type = 'runtime.limits.updated' THEN
      SELECT connection_id INTO v_connection FROM run_usage WHERE id = v_row;
      IF v_connection IS NOT NULL AND jsonb_typeof(NEW.details->'rate_limits') = 'object' THEN
        PERFORM record_provider_usage_reading(v_connection, 'runtime_stream', NEW.details->'rate_limits', NEW.occurred_at);
      END IF;
    ELSIF v_row IS NOT NULL THEN
      PERFORM run_usage_add(v_row, NEW.details);
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'run usage was not recorded for activity event %: %', NEW.id, SQLERRM;
  END;
  RETURN NULL;
END $$;
CREATE TRIGGER runtime_activity_events_usage AFTER INSERT ON runtime_activity_events
  FOR EACH ROW WHEN (NEW.event_type IN ('runtime.turn.usage','runtime.usage.updated','runtime.limits.updated'))
  EXECUTE FUNCTION run_usage_from_activity();

-- ------------------------------------------------------------------ checks

-- What a model check used, counted apart from task runs ("checks"), and the
-- windows its stream reported. Written by the lane while it holds the check.
CREATE FUNCTION record_model_check_usage(p_check_id uuid, p_worker_id text, p_usage jsonb, p_limits jsonb DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO control_plane, public, extensions, pg_temp
AS $$
DECLARE v_check model_checks%ROWTYPE; v_model text; v_id bigint;
BEGIN
  v_check := held_model_check(p_check_id, p_worker_id);
  IF v_check.id IS NULL THEN
    PERFORM refuse('model_check_not_leased', format('model check %s is not leased by %s', p_check_id, p_worker_id));
  END IF;
  SELECT left(model_id, 200) INTO v_model FROM provider_model_catalog WHERE id = v_check.entry_id;
  INSERT INTO run_usage(kind, check_id, operator_id, connection_id, runtime_type, model, started_at, finished_at)
  VALUES ('check', v_check.id, v_check.operator_id, v_check.connection_id, v_check.runtime_type, COALESCE(v_model, ''),
    COALESCE(v_check.started_at, clock_timestamp()), clock_timestamp())
  ON CONFLICT (check_id) DO NOTHING
  RETURNING id INTO v_id;
  -- Once per check: a second report of the same check adds nothing.
  IF v_id IS NOT NULL AND jsonb_typeof(p_usage) = 'object' AND jsonb_typeof(p_usage->'tokens') = 'object' THEN
    PERFORM run_usage_add(v_id, p_usage);
    UPDATE run_usage SET model_steps = LEAST(GREATEST(usage_count(p_usage->'steps', 1000000), 1), 1000000) WHERE id = v_id;
  END IF;
  IF jsonb_typeof(p_limits) = 'object' THEN
    PERFORM record_provider_usage_reading(v_check.connection_id, 'runtime_stream', p_limits);
  END IF;
  RETURN jsonb_build_object('check_id', v_check.id, 'recorded', v_id IS NOT NULL);
END $$;

REVOKE EXECUTE ON FUNCTION usage_count(jsonb, bigint) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION usage_reading_clean(jsonb) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION record_provider_usage_reading(uuid, text, jsonb, timestamptz) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION codex_usage_reads_due(interval) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION run_usage_context(bigint, uuid, text, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION run_usage_row_for_job(bigint, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION run_usage_add(bigint, jsonb) FROM PUBLIC;
-- Trigger functions: nothing calls them, so nothing is granted.
REVOKE EXECUTE ON FUNCTION run_usage_follow_attempt() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION run_usage_from_activity() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION record_model_check_usage(uuid, text, jsonb, jsonb) FROM PUBLIC;
-- The workers' writes: a runtime read (the account worker, the check lane) and
-- a check's usage. A run's usage needs no grant: it arrives through the
-- activity events the workers already append.
GRANT EXECUTE ON FUNCTION record_provider_usage_reading(uuid, text, jsonb, timestamptz) TO infra_worker;
GRANT EXECUTE ON FUNCTION codex_usage_reads_due(interval) TO infra_worker;
GRANT EXECUTE ON FUNCTION record_model_check_usage(uuid, text, jsonb, jsonb) TO infra_worker;
