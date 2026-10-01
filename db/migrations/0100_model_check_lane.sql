-- The check lane: who asks for a model check, in what order it runs, what it
-- may spend, and what it records (Stage 12 W6; docs/RUNTIMES_AND_MODELS_DESIGN.md
-- §2.3, §2.4, §2.6, §2.8, decisions R2, R4, R5).
--
-- A check is asked for by the operator (a pick in Team, a pin, "Check again")
-- or by the platform: every model of a small subscription or free list after a
-- refresh or a new credential, the models a team or an open task names, the
-- pinned ones, a model a task run just failed on, and — at a quiet hour — an
-- in-use model whose last passed check is a month old. Asking is idempotent per
-- model: one check is queued or running for a model at a time, and a request
-- for one already queued returns it (raising its priority if it is the more
-- urgent). Every request NOTIFYs model_checks, which the check worker LISTENs
-- on; the worker's 60 s poll is only the fallback.
--
-- The worker claims one check at a time for the whole host, in the order pick,
-- pin and check again, in-use, whole small lists; it never shares a queue with
-- task runs. Automatic checks are budgeted per operator (30 a day, R5); the
-- operator's own are counted and refused only past 60 a day. A check that
-- spent no model turn — handed back for memory, a paused runtime, a Codex
-- window above 80 % — counts toward nothing and simply waits. A check that
-- spent one and was inconclusive (a limit, the network) is finished as such and
-- retried after 5 min, 30 min and 2 h; eligibility does not move meanwhile.

SET search_path TO control_plane, public, extensions;

-- R5, in one place. The panel shows the same numbers the claim enforces.
CREATE FUNCTION model_check_limits()
RETURNS jsonb
LANGUAGE sql IMMUTABLE
SET search_path TO control_plane, public, extensions, pg_temp
AS $$
  SELECT jsonb_build_object('auto_per_day', 30, 'hard_per_day', 60, 'small_list_max', 12);
$$;
REVOKE EXECUTE ON FUNCTION model_check_limits() FROM PUBLIC;

-- What an operator spent in the last 24 hours: checks that sent a model turn.
CREATE FUNCTION model_check_usage(p_operator_id uuid)
RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO control_plane, public, extensions, pg_temp
AS $$
  SELECT jsonb_build_object(
    'used', count(*) FILTER (WHERE k.model_called),
    'auto_used', count(*) FILTER (WHERE k.model_called AND k.automatic),
    'operator_pending', (SELECT count(*) FROM model_checks p
      WHERE p.operator_id = p_operator_id AND p.finished_at IS NULL AND NOT p.automatic))
  FROM model_checks k
  WHERE k.operator_id = p_operator_id AND k.started_at > clock_timestamp() - interval '24 hours';
$$;
REVOKE EXECUTE ON FUNCTION model_check_usage(uuid) FROM PUBLIC;

-- A check that still stands for the model at its current key: one queued or
-- running, one with a verdict, or an inconclusive one from the last day. The
-- platform does not ask again while one does.
CREATE FUNCTION model_check_current(p_entry_id uuid)
RETURNS model_checks
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO control_plane, public, extensions, pg_temp
AS $$
  SELECT k.* FROM model_checks k
  JOIN provider_model_catalog m ON m.id = k.entry_id
  JOIN provider_connections c ON c.id = m.connection_id
  WHERE k.entry_id = p_entry_id
    AND (k.finished_at IS NULL
      OR (k.runtime_version = active_runtime_version(m.runtime_type)
        AND k.credential_generation = c.credential_generation
        AND (k.result IN ('passed','rejected','failed')
          OR (k.result = 'inconclusive' AND k.finished_at > clock_timestamp() - interval '24 hours'))))
  ORDER BY (k.finished_at IS NULL) DESC, k.finished_at DESC, k.id DESC
  LIMIT 1;
$$;
REVOKE EXECUTE ON FUNCTION model_check_current(uuid) FROM PUBLIC;

-- The panel's word for one check (§2.7): checking, waiting (reason), ready,
-- refused (reason), failed — failed being a refusal that points at the runtime.
CREATE FUNCTION model_check_state(p_check model_checks)
RETURNS text
LANGUAGE sql STABLE
SET search_path TO control_plane, public, extensions, pg_temp
AS $$
  SELECT CASE
    WHEN p_check.id IS NULL THEN NULL
    WHEN p_check.finished_at IS NULL THEN
      CASE WHEN p_check.leased_by IS NOT NULL THEN 'checking'
           WHEN p_check.wait_reason <> '' OR p_check.not_before > clock_timestamp() THEN 'waiting'
           ELSE 'checking' END
    WHEN p_check.result = 'passed' THEN 'ready'
    WHEN p_check.result = 'rejected' THEN 'refused'
    WHEN p_check.result = 'failed' THEN 'failed'
    ELSE 'waiting' END;
$$;
REVOKE EXECUTE ON FUNCTION model_check_state(model_checks) FROM PUBLIC;

-- Queues a check, or returns the one already queued for the model. Nothing
-- here checks ownership or budget: the callers do, each by its own rule.
CREATE FUNCTION queue_model_check(p_entry_id uuid, p_trigger text, p_automatic boolean, p_requested_by text,
  p_not_before timestamptz DEFAULT NULL, p_wait_reason text DEFAULT '', p_detail text DEFAULT '')
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO control_plane, public, extensions, pg_temp
AS $$
DECLARE
  v_entry provider_model_catalog%ROWTYPE;
  v_connection provider_connections%ROWTYPE;
  v_pending model_checks%ROWTYPE;
  v_priority smallint;
  v_id uuid;
BEGIN
  IF p_trigger NOT IN ('auto_small_list','in_use','pin','pick','check_again','run_failure','ttl','alias_drift') THEN
    PERFORM refuse('model_check_invalid', format('%s is not a trigger a check can be asked for by', p_trigger), '22023');
  END IF;
  v_priority := CASE p_trigger WHEN 'pick' THEN 0
    WHEN 'pin' THEN CASE WHEN p_automatic THEN 2 ELSE 1 END
    WHEN 'check_again' THEN 1 WHEN 'auto_small_list' THEN 3 ELSE 2 END;
  -- The row lock serialises two requests for one model; the unique index on
  -- pending checks is the guarantee behind it.
  SELECT * INTO v_entry FROM provider_model_catalog WHERE id = p_entry_id FOR UPDATE;
  SELECT * INTO v_connection FROM provider_connections WHERE id = v_entry.connection_id;
  SELECT * INTO v_pending FROM model_checks WHERE entry_id = p_entry_id AND finished_at IS NULL FOR UPDATE;
  IF FOUND THEN
    -- Already queued: a more urgent request takes it over. A check waiting
    -- only for the automatic budget stops waiting once the operator asks.
    IF v_priority < v_pending.priority AND v_pending.leased_by IS NULL THEN
      UPDATE model_checks SET priority = v_priority, trigger = p_trigger, automatic = p_automatic,
        requested_by = left(COALESCE(p_requested_by,''),120),
        wait_reason = CASE WHEN wait_reason = 'daily check budget reached' THEN '' ELSE wait_reason END
      WHERE id = v_pending.id;
      PERFORM pg_notify('model_checks', v_pending.id::text);
    END IF;
    RETURN jsonb_build_object('check_id', v_pending.id, 'deduplicated', true);
  END IF;
  INSERT INTO model_checks(entry_id, operator_id, connection_id, runtime_type, runtime_version, adapter_version,
    credential_generation, trigger, automatic, priority, requested_by, not_before, wait_reason, detail)
  VALUES (v_entry.id, v_entry.operator_id, v_entry.connection_id, v_entry.runtime_type,
    active_runtime_version(v_entry.runtime_type), v_entry.adapter_version, v_connection.credential_generation,
    p_trigger, p_automatic, v_priority, left(COALESCE(p_requested_by,''),120),
    COALESCE(p_not_before, clock_timestamp()), left(COALESCE(p_wait_reason,''),200), left(COALESCE(p_detail,''),500))
  RETURNING id INTO v_id;
  PERFORM pg_notify('model_checks', v_id::text);
  RETURN jsonb_build_object('check_id', v_id, 'deduplicated', false);
END $$;
REVOKE EXECUTE ON FUNCTION queue_model_check(uuid, text, boolean, text, timestamptz, text, text) FROM PUBLIC;

-- The operator's request: a pick in Team, a pin, "Check again" (the W6 ↔ W7
-- contract). A pick or a pin of a model that is ready, or that was refused at
-- its current key, returns that check rather than spending another: a refusal
-- is re-checked on a new list, credential or version, or when asked again.
CREATE FUNCTION request_model_check(p_operator_id uuid, p_entry_id uuid, p_trigger text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO control_plane, public, extensions, pg_temp
AS $$
DECLARE
  v_entry provider_model_catalog%ROWTYPE;
  v_connection provider_connections%ROWTYPE;
  v_current model_checks%ROWTYPE;
  v_usage jsonb;
  v_queued jsonb;
BEGIN
  IF p_trigger IS NULL OR p_trigger NOT IN ('pick','pin','check_again') THEN
    PERFORM refuse('model_check_invalid', 'a model check is asked for by pick, pin or check_again', '22023');
  END IF;
  SELECT * INTO v_entry FROM provider_model_catalog WHERE id = p_entry_id AND operator_id = p_operator_id FOR UPDATE;
  IF NOT FOUND THEN
    PERFORM refuse('catalog_entry_not_owned', format('no model %s in this operator''s catalog', p_entry_id), '42501');
  END IF;
  SELECT * INTO v_connection FROM provider_connections WHERE id = v_entry.connection_id;
  IF v_entry.superseded_by IS NOT NULL OR v_entry.status = 'unavailable' OR v_connection.status <> 'connected' THEN
    PERFORM refuse('catalog_entry_unavailable',
      format('%s is not in the current list of a connected account; refresh the list or reconnect first', v_entry.model_id));
  END IF;
  v_current := model_check_current(p_entry_id);
  IF v_current.id IS NOT NULL AND (v_current.finished_at IS NULL
      OR (p_trigger IN ('pick','pin') AND v_current.result IN ('passed','rejected','failed'))) THEN
    IF v_current.finished_at IS NULL THEN
      v_queued := queue_model_check(p_entry_id, p_trigger, false, p_operator_id::text);
    END IF;
    SELECT * INTO v_current FROM model_checks WHERE id = v_current.id;
    RETURN jsonb_build_object('check_id', v_current.id, 'state', model_check_state(v_current), 'deduplicated', true);
  END IF;
  v_usage := model_check_usage(p_operator_id);
  IF (v_usage->>'used')::int + (v_usage->>'operator_pending')::int >= (model_check_limits()->>'hard_per_day')::int THEN
    PERFORM refuse('model_check_budget',
      format('%s model checks in the last 24 hours: the daily ceiling is %s', v_usage->>'used',
        model_check_limits()->>'hard_per_day'), '54000');
  END IF;
  v_queued := queue_model_check(p_entry_id, p_trigger, false, p_operator_id::text);
  SELECT * INTO v_current FROM model_checks WHERE id = (v_queued->>'check_id')::uuid;
  PERFORM write_audit_event(NULL,NULL,NULL,'operator',p_operator_id::text,
    'model.check_requested','provider_model_catalog',p_entry_id::text,'allowed',NULL,
    jsonb_build_object('check_id',v_current.id,'trigger',p_trigger,'model_id',v_entry.model_id),v_current.id::text);
  RETURN jsonb_build_object('check_id', v_current.id, 'state', model_check_state(v_current),
    'deduplicated', (v_queued->>'deduplicated')::boolean);
END $$;
REVOKE EXECUTE ON FUNCTION request_model_check(uuid, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION request_model_check(uuid, uuid, text) TO infra_web;

-- One check for the host's one lane, or none. The claim brings the check's
-- key up to date — nothing has run under the key it was asked with — and says
-- what the worker needs to run it and what it may spend.
CREATE FUNCTION claim_model_checks(p_worker_id text, p_lease interval DEFAULT '10 minutes')
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO control_plane, public, extensions, pg_temp
AS $$
DECLARE
  v_limits jsonb := model_check_limits();
  v_check model_checks%ROWTYPE;
  v_entry provider_model_catalog%ROWTYPE;
  v_connection provider_connections%ROWTYPE;
  v_usage jsonb;
BEGIN
  IF COALESCE(p_worker_id,'') = '' OR p_lease IS NULL OR p_lease <= interval '0' OR p_lease > interval '1 hour' THEN
    PERFORM refuse('model_check_invalid', 'a claim names its worker and a lease of at most an hour', '22023');
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('model-check-lane', 0));
  -- A lease that ran out: the worker is gone or stuck. The check goes back to
  -- the queue; whether it spent a turn nobody knows, so it is not counted.
  UPDATE model_checks SET leased_by = NULL, lease_until = NULL, started_at = NULL,
    wait_reason = 'the previous attempt lost its lease', not_before = clock_timestamp()
  WHERE finished_at IS NULL AND lease_until <= clock_timestamp();
  IF EXISTS (SELECT 1 FROM model_checks WHERE finished_at IS NULL AND lease_until > clock_timestamp()) THEN
    RETURN '[]'::jsonb;
  END IF;

  WITH usage AS (
    SELECT k.operator_id,
      count(*) FILTER (WHERE k.model_called) AS used,
      count(*) FILTER (WHERE k.model_called AND k.automatic) AS auto_used
    FROM model_checks k WHERE k.started_at > clock_timestamp() - interval '24 hours'
    GROUP BY k.operator_id
  ), queued AS (
    SELECT k.id,
      COALESCE(u.used,0) < (v_limits->>'hard_per_day')::int
        AND (NOT k.automatic OR COALESCE(u.auto_used,0) < (v_limits->>'auto_per_day')::int) AS within_budget
    FROM model_checks k LEFT JOIN usage u ON u.operator_id = k.operator_id
    WHERE k.finished_at IS NULL AND k.leased_by IS NULL
  )
  -- What waits for the budget says so on the panel.
  UPDATE model_checks k SET wait_reason = 'daily check budget reached'
  FROM queued q WHERE q.id = k.id AND NOT q.within_budget AND k.wait_reason = '';

  SELECT k.* INTO v_check
  FROM model_checks k
  JOIN provider_model_catalog m ON m.id = k.entry_id AND m.superseded_by IS NULL AND m.status <> 'unavailable'
  JOIN provider_connections c ON c.id = k.connection_id AND c.status = 'connected'
  WHERE k.finished_at IS NULL AND k.leased_by IS NULL AND k.not_before <= clock_timestamp()
    AND k.wait_reason <> 'daily check budget reached'
  ORDER BY k.priority, k.requested_at, k.id
  LIMIT 1
  FOR UPDATE OF k SKIP LOCKED;
  IF v_check.id IS NULL THEN RETURN '[]'::jsonb; END IF;

  SELECT * INTO v_entry FROM provider_model_catalog WHERE id = v_check.entry_id;
  SELECT * INTO v_connection FROM provider_connections WHERE id = v_check.connection_id;
  UPDATE model_checks SET
    runtime_version = active_runtime_version(v_entry.runtime_type),
    adapter_version = v_entry.adapter_version,
    credential_generation = v_connection.credential_generation,
    leased_by = left(p_worker_id,200), lease_until = clock_timestamp() + p_lease,
    started_at = clock_timestamp(), wait_reason = ''
  WHERE id = v_check.id RETURNING * INTO v_check;
  v_usage := model_check_usage(v_check.operator_id);
  RETURN jsonb_build_array(jsonb_build_object(
    'check_id', v_check.id, 'entry_id', v_entry.id, 'connection_id', v_connection.id,
    'operator_id', v_check.operator_id, 'runtime_type', v_entry.runtime_type,
    'provider_id', v_entry.provider_id, 'model_id', v_entry.model_id,
    'access_gateway', v_entry.access_gateway, 'billing_boundary', v_connection.billing_boundary,
    'runtime_version', v_check.runtime_version, 'adapter_version', v_check.adapter_version,
    'credential_generation', v_check.credential_generation,
    'trigger', v_check.trigger, 'automatic', v_check.automatic, 'priority', v_check.priority,
    'attempt', v_check.attempt, 'lease_expires_at', v_check.lease_until,
    'admission', jsonb_build_object('background', true,
      'budget', jsonb_build_object('used', (v_usage->>'used')::int, 'auto_used', (v_usage->>'auto_used')::int,
        'auto_limit', (v_limits->>'auto_per_day')::int, 'hard_limit', (v_limits->>'hard_per_day')::int))
  ));
END $$;
REVOKE EXECUTE ON FUNCTION claim_model_checks(text, interval) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION claim_model_checks(text, interval) TO infra_worker;

CREATE FUNCTION held_model_check(p_check_id uuid, p_worker_id text)
RETURNS model_checks
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO control_plane, public, extensions, pg_temp
AS $$
  SELECT * FROM model_checks WHERE id = p_check_id AND finished_at IS NULL
    AND leased_by = p_worker_id AND lease_until > clock_timestamp();
$$;
REVOKE EXECUTE ON FUNCTION held_model_check(uuid, text) FROM PUBLIC;

-- A verdict: passed, rejected (the provider or runtime said no to the model),
-- or failed (the runtime or our harness broke — it points at the runtime's
-- qualification, not the model). Inconclusive is defer_model_check's.
CREATE FUNCTION complete_model_check(p_check_id uuid, p_worker_id text, p_result text, p_failure_class text,
  p_detail text, p_resolved_model text DEFAULT '', p_peak_memory_mb integer DEFAULT NULL,
  p_model_called boolean DEFAULT true)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO control_plane, public, extensions, pg_temp
AS $$
DECLARE v_check model_checks%ROWTYPE; v_class text;
BEGIN
  IF p_result IS NULL OR p_result NOT IN ('passed','rejected','failed') THEN
    PERFORM refuse('model_check_invalid', 'a model check completes as passed, rejected or failed', '22023');
  END IF;
  v_class := CASE p_result WHEN 'passed' THEN NULL WHEN 'rejected' THEN 'model'
    ELSE CASE WHEN p_failure_class = 'runtime' THEN 'runtime' ELSE 'harness' END END;
  v_check := held_model_check(p_check_id, p_worker_id);
  IF v_check.id IS NULL THEN
    PERFORM refuse('model_check_not_leased', format('model check %s is not leased by %s', p_check_id, p_worker_id));
  END IF;
  UPDATE model_checks SET result = p_result, failure_class = v_class,
    detail = left(regexp_replace(COALESCE(p_detail,''), '[[:cntrl:]]', ' ', 'g'), 500),
    resolved_model = left(COALESCE(p_resolved_model,''), 200),
    peak_memory_mb = CASE WHEN p_peak_memory_mb >= 0 THEN p_peak_memory_mb END,
    model_called = COALESCE(p_model_called, true),
    leased_by = NULL, lease_until = NULL, finished_at = clock_timestamp()
  WHERE id = v_check.id RETURNING * INTO v_check;
  PERFORM write_audit_event(NULL,NULL,NULL,'system',p_worker_id,'model.checked','provider_model_catalog',
    v_check.entry_id::text,'allowed',NULL,
    jsonb_build_object('check_id',v_check.id,'result',p_result,'failure_class',v_class,'trigger',v_check.trigger,
      'runtime_version',v_check.runtime_version),v_check.id::text);
  RETURN jsonb_build_object('check_id', v_check.id, 'entry_id', v_check.entry_id, 'result', p_result,
    'state', model_check_state(v_check));
END $$;
REVOKE EXECUTE ON FUNCTION complete_model_check(uuid, text, text, text, text, text, integer, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION complete_model_check(uuid, text, text, text, text, text, integer, boolean) TO infra_worker;

-- Not now. Without a model turn (memory, a paused runtime, the Codex window)
-- the check goes back to the queue with its reason and costs nothing. After a
-- turn that said nothing about the model (a limit, the network) the attempt is
-- finished as inconclusive and the next one queued: 5 min, 30 min, 2 h, then
-- no more until something asks again. The caller's own moment (a window's
-- reset) is kept when it is later.
CREATE FUNCTION defer_model_check(p_check_id uuid, p_worker_id text, p_detail text, p_model_called boolean,
  p_retry_after timestamptz DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO control_plane, public, extensions, pg_temp
AS $$
DECLARE
  v_check model_checks%ROWTYPE;
  v_inconclusive integer;
  v_retry timestamptz;
  v_next uuid;
  v_reason text := left(regexp_replace(COALESCE(NULLIF(p_detail,''),'not now'), '[[:cntrl:]]', ' ', 'g'), 500);
BEGIN
  v_check := held_model_check(p_check_id, p_worker_id);
  IF v_check.id IS NULL THEN
    RETURN jsonb_build_object('status', 'not_held', 'check_id', p_check_id);
  END IF;
  IF NOT COALESCE(p_model_called, false) THEN
    v_retry := LEAST(GREATEST(COALESCE(p_retry_after, clock_timestamp() + interval '1 minute'), clock_timestamp()),
      clock_timestamp() + interval '7 days');
    UPDATE model_checks SET leased_by = NULL, lease_until = NULL, started_at = NULL,
      not_before = v_retry, wait_reason = left(v_reason, 200)
    WHERE id = v_check.id;
    RETURN jsonb_build_object('status', 'waiting', 'check_id', v_check.id, 'retry_at', v_retry);
  END IF;
  SELECT count(*) + 1 INTO v_inconclusive FROM model_checks
  WHERE root_id = v_check.root_id AND result = 'inconclusive' AND model_called;
  IF v_inconclusive <= 3 THEN
    v_retry := LEAST(GREATEST(clock_timestamp() + CASE v_inconclusive WHEN 1 THEN interval '5 minutes'
        WHEN 2 THEN interval '30 minutes' ELSE interval '2 hours' END,
      COALESCE(p_retry_after, clock_timestamp())), clock_timestamp() + interval '7 days');
  END IF;
  UPDATE model_checks SET result = 'inconclusive', failure_class = 'infrastructure', detail = v_reason,
    model_called = true, retry_after = v_retry,
    leased_by = NULL, lease_until = NULL, finished_at = clock_timestamp()
  WHERE id = v_check.id;
  IF v_retry IS NOT NULL THEN
    INSERT INTO model_checks(entry_id, operator_id, connection_id, runtime_type, runtime_version, adapter_version,
      credential_generation, trigger, automatic, priority, retry_of, root_id, attempt, requested_by,
      requested_at, not_before, wait_reason)
    VALUES (v_check.entry_id, v_check.operator_id, v_check.connection_id, v_check.runtime_type,
      v_check.runtime_version, v_check.adapter_version, v_check.credential_generation, v_check.trigger,
      v_check.automatic, v_check.priority, v_check.id, v_check.root_id, v_check.attempt + 1, v_check.requested_by,
      v_check.requested_at, v_retry, left(v_reason, 200))
    RETURNING id INTO v_next;
  END IF;
  RETURN jsonb_build_object('status', 'deferred', 'check_id', v_check.id, 'retry_at', v_retry,
    'next_check_id', v_next);
END $$;
REVOKE EXECUTE ON FUNCTION defer_model_check(uuid, text, text, boolean, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION defer_model_check(uuid, text, text, boolean, timestamptz) TO infra_worker;

-- R2's automatic set, for one connection or all connected ones: a whole small
-- subscription or free list, the models in use, the pinned ones — each only
-- when it is not eligible and nothing about it is current. Metered and large
-- lists are never checked whole.
CREATE FUNCTION queue_automatic_model_checks(p_connection_id uuid DEFAULT NULL)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO control_plane, public, extensions, pg_temp
AS $$
DECLARE v_row record; v_count integer := 0; v_small integer := (model_check_limits()->>'small_list_max')::int;
BEGIN
  FOR v_row IN
    WITH listed AS (
      SELECT m.id, m.pinned_at, c.billing_boundary, count(*) OVER (PARTITION BY m.connection_id) AS list_size
      FROM provider_model_catalog m
      JOIN provider_connections c ON c.id = m.connection_id
        AND c.status = 'connected' AND c.connection_kind = 'model_access'
      WHERE m.superseded_by IS NULL AND m.status <> 'unavailable'
        AND (p_connection_id IS NULL OR m.connection_id = p_connection_id)
    ), used AS (SELECT u.entry_id FROM model_entries_in_use() u)
    SELECT l.id,
      CASE WHEN l.id IN (SELECT entry_id FROM used) THEN 'in_use'
           WHEN l.pinned_at IS NOT NULL THEN 'pin' ELSE 'auto_small_list' END AS trigger
    FROM listed l
    WHERE l.id IN (SELECT entry_id FROM used) OR l.pinned_at IS NOT NULL
       OR (l.billing_boundary IN ('subscription','free') AND l.list_size <= v_small)
    ORDER BY l.id
  LOOP
    CONTINUE WHEN (model_eligibility(v_row.id)->>'eligible')::boolean;
    CONTINUE WHEN (model_check_current(v_row.id)).id IS NOT NULL;
    PERFORM queue_model_check(v_row.id, v_row.trigger, true, 'system');
    v_count := v_count + 1;
  END LOOP;
  RETURN v_count;
END $$;
REVOKE EXECUTE ON FUNCTION queue_automatic_model_checks(uuid) FROM PUBLIC;

-- The worker's periodic sweep: the automatic set, and at the quiet hour (UTC)
-- the in-use models whose passed check is older than p_ttl — the safety net of
-- R3, nothing more. NULL for the hour turns the age re-check off.
CREATE FUNCTION request_model_checks_due(p_quiet_hour integer DEFAULT 4, p_ttl interval DEFAULT '30 days')
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO control_plane, public, extensions, pg_temp
AS $$
DECLARE v_queued integer; v_aged integer := 0; v_id uuid;
BEGIN
  v_queued := queue_automatic_model_checks(NULL);
  IF p_quiet_hour IS NOT NULL AND extract(hour FROM clock_timestamp() AT TIME ZONE 'UTC') = p_quiet_hour THEN
    FOR v_id IN
      SELECT u.entry_id FROM model_entries_in_use() u
      JOIN model_checks k ON k.id = (model_eligibility(u.entry_id)->>'check_id')::uuid
      WHERE k.finished_at < clock_timestamp() - p_ttl
        AND NOT EXISTS (SELECT 1 FROM model_checks p WHERE p.entry_id = u.entry_id AND p.finished_at IS NULL)
    LOOP
      PERFORM queue_model_check(v_id, 'ttl', true, 'system');
      v_aged := v_aged + 1;
    END LOOP;
  END IF;
  RETURN jsonb_build_object('queued', v_queued, 'aged', v_aged);
END $$;
REVOKE EXECUTE ON FUNCTION request_model_checks_due(integer, interval) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION request_model_checks_due(integer, interval) TO infra_worker;

-- After a refresh, and after a new credential: the moments R2 names.
CREATE FUNCTION queue_model_checks_after_refresh()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO control_plane, public, extensions, pg_temp
AS $$
BEGIN
  PERFORM queue_automatic_model_checks(NEW.connection_id);
  RETURN NULL;
END $$;
REVOKE EXECUTE ON FUNCTION queue_model_checks_after_refresh() FROM PUBLIC;
CREATE TRIGGER catalog_refresh_jobs_model_checks
  AFTER UPDATE OF status ON catalog_refresh_jobs
  FOR EACH ROW WHEN (NEW.status = 'completed' AND OLD.status IS DISTINCT FROM 'completed')
  EXECUTE FUNCTION queue_model_checks_after_refresh();

CREATE FUNCTION queue_model_checks_on_credential()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO control_plane, public, extensions, pg_temp
AS $$
BEGIN
  PERFORM queue_automatic_model_checks(NEW.id);
  RETURN NULL;
END $$;
REVOKE EXECUTE ON FUNCTION queue_model_checks_on_credential() FROM PUBLIC;
CREATE TRIGGER provider_connections_model_checks
  AFTER UPDATE OF credential_generation ON provider_connections
  FOR EACH ROW WHEN (NEW.credential_generation <> OLD.credential_generation AND NEW.status = 'connected'
    AND NEW.connection_kind = 'model_access')
  EXECUTE FUNCTION queue_model_checks_on_credential();

-- ------------------------------------------------------------ real runs

-- The class of a run's failure from its text, as the check worker classifies a
-- check's (model-check-outcome.mjs keeps the same two lists). A limit is not
-- the model's fault; a "no such model" is.
CREATE FUNCTION model_failure_class(p_text text)
RETURNS text
LANGUAGE sql IMMUTABLE
SET search_path TO control_plane, public, extensions, pg_temp
AS $$
  SELECT CASE
    WHEN p_text ~* '(usage limit|rate.?limit|quota|too many requests|\m429\M|insufficient credit|out of credits|runtime_capacity|no memory for another)'
      THEN 'infrastructure'
    WHEN p_text ~* '(model not available|model.?not.?found|unknown model|invalid model|unsupported model|model is not supported|not supported (when|with|by|for)|does not exist|not in your plan|no endpoints found|no allowed providers|not a valid model)'
      THEN 'model'
  END;
$$;
REVOKE EXECUTE ON FUNCTION model_failure_class(text) FROM PUBLIC;

-- A task run that failed on its model (P3): the list is read again and the
-- model re-checked once, after the refresh has had its chance. The re-check's
-- verdict is what moves eligibility — one refused turn in a task is a reason
-- to look, the check is the evidence. Other classes are the runtime's
-- probation's, not the catalog's.
CREATE FUNCTION record_run_model_failure(p_job_id bigint, p_class text, p_detail text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO control_plane, public, extensions, pg_temp
AS $$
DECLARE
  v_job runtime_jobs%ROWTYPE;
  v_entry provider_model_catalog%ROWTYPE;
  v_entry_id uuid;
  v_refresh uuid;
  v_recent uuid;
  v_queued jsonb;
BEGIN
  SELECT * INTO v_job FROM runtime_jobs WHERE id = p_job_id;
  IF NOT FOUND THEN PERFORM refuse('job_not_found', format('no runtime job %s', p_job_id)); END IF;
  IF p_class IS DISTINCT FROM 'model' THEN
    RETURN jsonb_build_object('recorded', false, 'reason', 'not_a_model_failure');
  END IF;
  v_entry_id := NULLIF(CASE WHEN v_job.job_type IN ('orchestrator_turn','resume_orchestrator')
      THEN get_task_runtime_snapshot(v_job.task_id)->'orchestrator'->>'entry_id'
      ELSE resolve_executor_launch_model(p_job_id)->>'snapshot_entry_id' END, '')::uuid;
  SELECT m.* INTO v_entry FROM provider_model_catalog o
  JOIN provider_model_catalog m ON m.id = COALESCE(o.superseded_by, o.id)
  WHERE o.id = v_entry_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('recorded', false, 'reason', 'no_catalog_model');
  END IF;
  SELECT id INTO v_refresh FROM catalog_refresh_jobs
  WHERE connection_id = v_entry.connection_id AND status IN ('pending','in_progress') LIMIT 1;
  IF v_refresh IS NULL AND EXISTS (SELECT 1 FROM provider_connections WHERE id = v_entry.connection_id AND status = 'connected') THEN
    INSERT INTO catalog_refresh_jobs(operator_id, connection_id, reason)
    VALUES (v_entry.operator_id, v_entry.connection_id, 'run_model_failure') RETURNING id INTO v_refresh;
  END IF;
  -- One re-check per model per hour, however many turns fail on it.
  SELECT id INTO v_recent FROM model_checks
  WHERE entry_id = v_entry.id AND trigger = 'run_failure' AND requested_at > clock_timestamp() - interval '1 hour'
  ORDER BY requested_at DESC LIMIT 1;
  IF v_recent IS NULL THEN
    v_queued := queue_model_check(v_entry.id, 'run_failure', true, 'job:' || p_job_id,
      clock_timestamp() + interval '2 minutes', 'a task run failed on this model; checking it again after the list refresh',
      left(COALESCE(p_detail,''), 500));
  END IF;
  RETURN jsonb_build_object('recorded', true, 'entry_id', v_entry.id,
    'check_id', COALESCE(v_recent, (v_queued->>'check_id')::uuid), 'refresh_id', v_refresh);
END $$;
REVOKE EXECUTE ON FUNCTION record_run_model_failure(bigint, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION record_run_model_failure(bigint, text, text) TO infra_worker;

-- Where a run's failure is recorded: every worker hands its error to
-- retry_runtime_job or end_runtime_job, and both write last_error. Nothing here
-- may fail that write — the job's own bookkeeping matters more than the hint.
CREATE FUNCTION record_run_model_failure_on_error()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO control_plane, public, extensions, pg_temp
AS $$
BEGIN
  IF model_failure_class(NEW.last_error) = 'model' THEN
    BEGIN
      PERFORM record_run_model_failure(NEW.id, 'model', NEW.last_error);
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'the run failure of job % was not recorded against its model: %', NEW.id, SQLERRM;
    END;
  END IF;
  RETURN NULL;
END $$;
REVOKE EXECUTE ON FUNCTION record_run_model_failure_on_error() FROM PUBLIC;
CREATE TRIGGER runtime_jobs_model_failure
  AFTER UPDATE OF last_error ON runtime_jobs
  FOR EACH ROW WHEN (NEW.last_error IS DISTINCT FROM OLD.last_error AND COALESCE(NEW.last_error,'') <> '')
  EXECUTE FUNCTION record_run_model_failure_on_error();

-- The old gate's waiting requests (and the one in flight 0099 handed back)
-- are the operator's asks: each becomes a pin check.
DO $$
DECLARE v_id uuid; v_count integer := 0;
BEGIN
  FOR v_id IN SELECT id FROM provider_model_catalog
    WHERE superseded_by IS NULL AND gate_requested_at IS NOT NULL AND status IN ('discovered','rejected')
    ORDER BY gate_requested_at
  LOOP
    PERFORM queue_model_check(v_id, 'pin', false, 'migration 0100');
    v_count := v_count + 1;
  END LOOP;
  UPDATE provider_model_catalog SET gate_requested_at = NULL WHERE gate_requested_at IS NOT NULL;
  RAISE NOTICE 'model check lane: % waiting gate requests queued as pin checks', v_count;
END $$;
