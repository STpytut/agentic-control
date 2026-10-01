-- The model catalog, polished for the operator (Stage 12, after W6/W7;
-- docs/RUNTIMES_AND_MODELS_DESIGN.md §2.4, §2.5, §2.7, §3.6, §4;
-- docs/W6_W7_CONTRACT.md, the additions marked "0105").
--
-- Nothing here changes what is selectable. It adds what the panel had to
-- guess, and two things the design promised and W6 left out:
--
--  * A Claude alias's drift (§2.4). A task run's first event says which model
--    the alias resolved to; the supervisor puts it in the dispatch attempt's
--    native_result, and when it differs from what the model's last passed
--    check recorded, the row says so ("sonnet now resolves to …") and a
--    background re-check (trigger alias_drift) is queued. Eligibility does not
--    move meanwhile: the alias still works, the check is what re-records it.
--  * A rejected model re-checked when it comes back (R3's "a new list"). A
--    refresh that no longer names a rejected model now marks it unavailable,
--    like any other it no longer names; when a later refresh names it again,
--    one automatic check (trigger relisted) is queued, within the budget.
--
-- And what the panel reads: per connection its vendors with counts (the search
-- filter is complete before any search), a rollup of states over the whole
-- list, and what the latest qualification of a newer runtime version would add
-- or drop; at the top, when the rolling 24-hour budget frees its next check and
-- when it is clear; request_model_check's answer carries the reason when the
-- answer is immediate (refused, failed, waiting). The runtimes' release
-- baselines — the version each driver was built and gated at — are recorded
-- from the health snapshot, so the Runtimes card reads them instead of
-- inferring "release baseline" from the absence of anything else.

SET search_path TO control_plane, public, extensions;

-- What is selectable before; the NOTICE at the end compares (a dry run on a
-- host is this file inside BEGIN … ROLLBACK).
CREATE TEMP TABLE catalog_polish_selectable AS
  SELECT id FROM provider_model_catalog WHERE status = 'verified' AND superseded_by IS NULL;

-- ------------------------------------------------------------ versions

-- A runtime version as numbers, for ordering: 0.158.0 < 0.159.0 < 0.160.0,
-- which text ordering gets wrong at the first two-digit part. NULL for anything
-- that is not dotted digits, which then orders nowhere.
CREATE FUNCTION runtime_version_key(p_version text)
RETURNS integer[]
LANGUAGE sql IMMUTABLE
SET search_path TO control_plane, public, extensions, pg_temp
AS $$
  SELECT CASE WHEN p_version ~ '^[0-9]{1,9}(\.[0-9]{1,9}){0,5}$' THEN string_to_array(p_version, '.')::integer[] END;
$$;
REVOKE EXECUTE ON FUNCTION runtime_version_key(text) FROM PUBLIC;

-- ------------------------------------------------------------ baselines

-- The version each runtime's driver was verified at in the release (the
-- driver's pinned verified.runtimeVersion, R15), and what verifies the version
-- the host runs now: the baseline, a host qualification, or nothing. Written
-- from the health snapshot, which reads both from the release and the host's
-- inventory every minute; only a change writes.
CREATE TABLE runtime_baselines (
  runtime_type text PRIMARY KEY CHECK (runtime_type IN ('codex','opencode','claude','antigravity')),
  baseline_version text NOT NULL CHECK (length(baseline_version) BETWEEN 1 AND 64),
  adapter_version text NOT NULL DEFAULT '' CHECK (length(adapter_version) <= 32),
  active_version text NOT NULL DEFAULT '' CHECK (length(active_version) <= 64),
  -- "baseline", "host qualification <id>", or '' when the active version is
  -- verified by neither.
  active_verified_by text NOT NULL DEFAULT '' CHECK (length(active_verified_by) <= 120),
  noted_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
REVOKE ALL ON runtime_baselines FROM PUBLIC;

-- 0099's trigger function, same trigger: the active version as before, and
-- now the baseline beside it. Nothing here may fail the report.
CREATE OR REPLACE FUNCTION note_runtime_version_from_health()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO control_plane, public, extensions, pg_temp
AS $$
DECLARE v_entry jsonb;
BEGIN
  IF jsonb_typeof(NEW.snapshot->'runtimes') IS DISTINCT FROM 'array' THEN RETURN NULL; END IF;
  FOR v_entry IN SELECT e FROM jsonb_array_elements(NEW.snapshot->'runtimes') e LOOP
    CONTINUE WHEN NOT EXISTS (SELECT 1 FROM runtime_roles r WHERE r.runtime_type = v_entry->>'runtime');
    IF COALESCE(v_entry->>'baseline_version','') <> '' AND length(v_entry->>'baseline_version') <= 64 THEN
      BEGIN
        INSERT INTO runtime_baselines(runtime_type, baseline_version, adapter_version, active_version, active_verified_by)
        VALUES (v_entry->>'runtime', v_entry->>'baseline_version', left(COALESCE(v_entry->>'adapter_version',''), 32),
          left(COALESCE(v_entry->>'version',''), 64), left(COALESCE(v_entry->>'verified_by',''), 120))
        ON CONFLICT (runtime_type) DO UPDATE SET baseline_version = EXCLUDED.baseline_version,
          adapter_version = EXCLUDED.adapter_version, active_version = EXCLUDED.active_version,
          active_verified_by = EXCLUDED.active_verified_by, noted_at = clock_timestamp()
        WHERE (runtime_baselines.baseline_version, runtime_baselines.adapter_version, runtime_baselines.active_version,
               runtime_baselines.active_verified_by)
          IS DISTINCT FROM (EXCLUDED.baseline_version, EXCLUDED.adapter_version, EXCLUDED.active_version,
               EXCLUDED.active_verified_by);
      EXCEPTION WHEN OTHERS THEN
        RAISE WARNING 'runtime baseline from the health report not recorded: %', SQLERRM;
      END;
    END IF;
    CONTINUE WHEN v_entry ? 'unreadable' OR COALESCE(v_entry->>'version','') = ''
      OR (v_entry->>'installed') = 'false';
    CONTINUE WHEN (SELECT v.version FROM runtime_active_versions v WHERE v.runtime_type = v_entry->>'runtime')
      IS NOT DISTINCT FROM v_entry->>'version';
    BEGIN
      PERFORM note_active_runtime_version(v_entry->>'runtime', v_entry->>'version', 'health');
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'runtime version from the health report not recorded: %', SQLERRM;
    END;
  END LOOP;
  RETURN NULL;
END $$;

-- 0095's read, same signature and keys, plus the baseline and what verifies the
-- active version; a runtime the health report named before the watch ran is
-- listed too.
CREATE OR REPLACE FUNCTION get_runtime_versions()
RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO control_plane, public, extensions, pg_temp
AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'runtime', r.runtime_type,
    'active_version', COALESCE(w.active_version, NULLIF(b.active_version, '')),
    'checked_at', w.checked_at,
    'error', NULLIF(w.error, ''),
    'baseline_version', b.baseline_version,
    'verified_by', CASE WHEN b.runtime_type IS NULL THEN NULL
      WHEN b.active_version = COALESCE(w.active_version, b.active_version) THEN NULLIF(b.active_verified_by, '') END,
    'newer', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'version', v.version,
        'published_at', v.published_at,
        'offered_from', v.published_at + interval '48 hours',
        'offered', v.published_at IS NOT NULL AND v.published_at + interval '48 hours' <= clock_timestamp()
      ) ORDER BY string_to_array(v.version, '.')::int[] DESC)
      FROM runtime_versions v
      WHERE v.runtime_type = r.runtime_type AND v.state = 'available'
        AND (w.active_version IS NULL
          OR string_to_array(v.version, '.')::int[] > string_to_array(w.active_version, '.')::int[])
    ), '[]'::jsonb)
  ) ORDER BY r.runtime_type), '[]'::jsonb)
  FROM (SELECT runtime_type FROM runtime_watch_state UNION SELECT runtime_type FROM runtime_baselines) r
  LEFT JOIN runtime_watch_state w ON w.runtime_type = r.runtime_type
  LEFT JOIN runtime_baselines b ON b.runtime_type = r.runtime_type;
$$;

-- ------------------------------------------------------------ newer versions

-- What the latest qualification of a version newer than the active one read in
-- the candidate's list against the active one's (its catalog.list check, 0096:
-- evidence {count, added, removed}). The highest such version, its latest
-- qualification that read the list; NULL when none is newer.
CREATE FUNCTION runtime_catalog_preview(p_runtime text)
RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO control_plane, public, extensions, pg_temp
AS $$
  SELECT jsonb_build_object('version', q.version, 'qualification_id', q.id, 'result', q.result,
    'finished_at', q.finished_at,
    'count', CASE WHEN jsonb_typeof(c.evidence->'count') = 'number' THEN c.evidence->'count' END,
    'added', CASE WHEN jsonb_typeof(c.evidence->'added') = 'array' THEN c.evidence->'added' ELSE '[]'::jsonb END,
    'removed', CASE WHEN jsonb_typeof(c.evidence->'removed') = 'array' THEN c.evidence->'removed' ELSE '[]'::jsonb END)
  FROM runtime_qualifications q
  JOIN runtime_qualification_checks c ON c.qualification_id = q.id AND c.check_key = 'catalog.list' AND c.result = 'passed'
  WHERE q.runtime_type = p_runtime
    AND runtime_version_key(q.version) > runtime_version_key(NULLIF(active_runtime_version(p_runtime), ''))
  ORDER BY runtime_version_key(q.version) DESC, q.started_at DESC, c.recorded_at DESC
  LIMIT 1;
$$;
REVOKE EXECUTE ON FUNCTION runtime_catalog_preview(text) FROM PUBLIC;

-- The same, for one connection. A runtime whose list names models alone (Codex,
-- Claude) reads one list per account, so the connection's is the runtime's. A
-- runtime whose list names every connected provider as provider/model
-- (OpenCode) is read for all its connections at once: a connection keeps what
-- names one of its providers, without the prefix — the ids its own rows carry.
-- Which kind a list is, it says itself: whether its entries start with a
-- provider the runtime's catalog knows. NULL when the newer version changes
-- nothing for this connection.
CREATE FUNCTION connection_catalog_preview(p_connection_id uuid)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path TO control_plane, public, extensions, pg_temp
AS $$
DECLARE v_runtime text; v_preview jsonb; v_providers text[]; v_known text[]; v_added jsonb; v_removed jsonb;
BEGIN
  SELECT provider INTO v_runtime FROM provider_connections WHERE id = p_connection_id;
  v_preview := runtime_catalog_preview(v_runtime);
  IF v_preview IS NULL THEN RETURN NULL; END IF;
  SELECT COALESCE(array_agg(DISTINCT provider_id), '{}') INTO v_known FROM provider_model_catalog
  WHERE runtime_type = v_runtime AND superseded_by IS NULL;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements_text((v_preview->'added') || (v_preview->'removed')) x
             WHERE strpos(x, '/') > 0 AND split_part(x, '/', 1) = ANY(v_known)) THEN
    SELECT COALESCE(array_agg(DISTINCT provider_id), '{}') INTO v_providers FROM provider_model_catalog
    WHERE connection_id = p_connection_id AND superseded_by IS NULL;
    SELECT COALESCE(jsonb_agg(substr(x, strpos(x, '/') + 1) ORDER BY o), '[]'::jsonb) INTO v_added
    FROM jsonb_array_elements_text(v_preview->'added') WITH ORDINALITY a(x, o)
    WHERE strpos(x, '/') > 0 AND split_part(x, '/', 1) = ANY(v_providers);
    SELECT COALESCE(jsonb_agg(substr(x, strpos(x, '/') + 1) ORDER BY o), '[]'::jsonb) INTO v_removed
    FROM jsonb_array_elements_text(v_preview->'removed') WITH ORDINALITY a(x, o)
    WHERE strpos(x, '/') > 0 AND split_part(x, '/', 1) = ANY(v_providers);
    v_preview := v_preview || jsonb_build_object('added', v_added, 'removed', v_removed);
  END IF;
  IF jsonb_array_length(v_preview->'added') = 0 AND jsonb_array_length(v_preview->'removed') = 0 THEN
    RETURN NULL;
  END IF;
  RETURN v_preview - 'count';
END $$;
REVOKE EXECUTE ON FUNCTION connection_catalog_preview(uuid) FROM PUBLIC;

-- 0096's read, same signature and keys, plus what each qualification's list
-- read found: {count, added, removed}, or null when it read none.
CREATE OR REPLACE FUNCTION get_runtime_qualifications()
RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO control_plane, public, extensions, pg_temp
AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id', q.id, 'runtime', q.runtime_type, 'version', q.version, 'result', q.result,
    'started_at', q.started_at, 'finished_at', q.finished_at, 'summary', q.summary,
    'checks', COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'check', c.check_key, 'result', c.result, 'failure_class', NULLIF(c.failure_class,''),
        'detail', c.detail, 'duration_ms', c.duration_ms) ORDER BY c.recorded_at)
      FROM runtime_qualification_checks c WHERE c.qualification_id = q.id), '[]'::jsonb),
    'catalog', (SELECT jsonb_build_object(
        'count', CASE WHEN jsonb_typeof(c.evidence->'count') = 'number' THEN c.evidence->'count' END,
        'added', CASE WHEN jsonb_typeof(c.evidence->'added') = 'array' THEN c.evidence->'added' ELSE '[]'::jsonb END,
        'removed', CASE WHEN jsonb_typeof(c.evidence->'removed') = 'array' THEN c.evidence->'removed' ELSE '[]'::jsonb END)
      FROM runtime_qualification_checks c
      WHERE c.qualification_id = q.id AND c.check_key = 'catalog.list' AND c.result = 'passed'
      ORDER BY c.recorded_at DESC LIMIT 1)
  ) ORDER BY q.runtime_type, q.started_at DESC), '[]'::jsonb)
  FROM (
    SELECT DISTINCT ON (runtime_type, version) *
    FROM runtime_qualifications ORDER BY runtime_type, version, started_at DESC
  ) q;
$$;

-- ------------------------------------------------------------ alias drift

-- What real runs report an alias resolving to, and when it was last seen to
-- change. resolved_model stays what the last passed check recorded.
ALTER TABLE provider_model_catalog
  ADD COLUMN observed_model text NOT NULL DEFAULT '' CHECK (length(observed_model) <= 200),
  ADD COLUMN observed_model_at timestamptz;

-- Two more reasons a check is asked for: a model a list names again after it
-- was rejected and left the list (relisted); alias_drift was already allowed.
ALTER TABLE model_checks DROP CONSTRAINT model_checks_trigger_check;
ALTER TABLE model_checks ADD CONSTRAINT model_checks_trigger_check
  CHECK (trigger IN ('auto_small_list','in_use','pin','pick','check_again',
    'run_failure','ttl','alias_drift','relisted','qualification','legacy'));

-- 0100's function, same signature: 'relisted' is a trigger the platform may
-- ask by, at the in-use priority.
CREATE OR REPLACE FUNCTION queue_model_check(p_entry_id uuid, p_trigger text, p_automatic boolean, p_requested_by text,
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
  IF p_trigger NOT IN ('auto_small_list','in_use','pin','pick','check_again','run_failure','ttl','alias_drift','relisted') THEN
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

-- The catalog model a runtime job ran: the snapshot's orchestrator for an
-- orchestrator turn, the executor the job launched otherwise (the same reading
-- as record_run_model_failure), and the row that replaced a superseded one.
CREATE FUNCTION runtime_job_catalog_entry(p_job_id bigint)
RETURNS uuid
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path TO control_plane, public, extensions, pg_temp
AS $$
DECLARE v_job runtime_jobs%ROWTYPE; v_entry_id uuid;
BEGIN
  SELECT * INTO v_job FROM runtime_jobs WHERE id = p_job_id;
  IF NOT FOUND THEN RETURN NULL; END IF;
  v_entry_id := NULLIF(CASE WHEN v_job.job_type IN ('orchestrator_turn','resume_orchestrator')
      THEN get_task_runtime_snapshot(v_job.task_id)->'orchestrator'->>'entry_id'
      ELSE resolve_executor_launch_model(p_job_id)->>'snapshot_entry_id' END, '')::uuid;
  RETURN (SELECT COALESCE(o.superseded_by, o.id) FROM provider_model_catalog o WHERE o.id = v_entry_id);
END $$;
REVOKE EXECUTE ON FUNCTION runtime_job_catalog_entry(bigint) FROM PUBLIC;

-- A run's report of what its model resolved to — only a runtime that names a
-- model by alias reports one (Claude Code's init event, through its driver).
-- The first sighting of a model the catalog has no word for is simply noted; a model other than the one the
-- last passed check recorded is drift: noted, audited, and re-checked in the
-- background — at most once a day per model, however many runs report it.
CREATE FUNCTION record_alias_resolution(p_job_id bigint, p_model text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO control_plane, public, extensions, pg_temp
AS $$
DECLARE
  v_entry provider_model_catalog%ROWTYPE;
  v_entry_id uuid;
  v_model text := left(btrim(COALESCE(p_model,'')), 200);
  v_drift boolean;
  v_check uuid;
BEGIN
  IF v_model = '' THEN RETURN jsonb_build_object('recorded', false, 'reason', 'no_model'); END IF;
  v_entry_id := runtime_job_catalog_entry(p_job_id);
  SELECT * INTO v_entry FROM provider_model_catalog WHERE id = v_entry_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('recorded', false, 'reason', 'no_catalog_model');
  END IF;
  v_drift := v_entry.resolved_model <> '' AND v_entry.resolved_model <> v_model;
  IF v_entry.observed_model IS DISTINCT FROM v_model THEN
    UPDATE provider_model_catalog SET observed_model = v_model, observed_model_at = clock_timestamp()
    WHERE id = v_entry.id;
    IF v_drift THEN
      PERFORM write_audit_event(NULL,NULL,NULL,'system','job:' || p_job_id,'model.alias_drift',
        'provider_model_catalog',v_entry.id::text,'allowed',NULL,
        jsonb_build_object('model_id',v_entry.model_id,'checked',v_entry.resolved_model,'observed',v_model),
        v_entry.id::text);
    END IF;
  END IF;
  IF v_drift AND NOT EXISTS (SELECT 1 FROM model_checks k WHERE k.entry_id = v_entry.id AND k.trigger = 'alias_drift'
                               AND k.requested_at > clock_timestamp() - interval '24 hours')
     AND EXISTS (SELECT 1 FROM provider_connections c WHERE c.id = v_entry.connection_id AND c.status = 'connected') THEN
    v_check := (queue_model_check(v_entry.id, 'alias_drift', true, 'job:' || p_job_id, NULL, '',
      format('a task run reported %s resolving to %s; its last check recorded %s', v_entry.model_id, v_model,
        v_entry.resolved_model))->>'check_id')::uuid;
  END IF;
  RETURN jsonb_build_object('recorded', true, 'entry_id', v_entry.id, 'drift', v_drift, 'check_id', v_check);
END $$;
REVOKE EXECUTE ON FUNCTION record_alias_resolution(bigint, text) FROM PUBLIC;

-- Where a run's resolved model arrives: the attempt's native_result, written
-- once when the run ends (0071), with resolved_model when the driver reads one
-- from the stream. Nothing here may fail that write.
CREATE FUNCTION record_alias_resolution_on_dispatch()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO control_plane, public, extensions, pg_temp
AS $$
BEGIN
  BEGIN
    PERFORM record_alias_resolution(NEW.job_id, NEW.native_result->>'resolved_model');
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'the model job % resolved to was not recorded: %', NEW.job_id, SQLERRM;
  END;
  RETURN NULL;
END $$;
REVOKE EXECUTE ON FUNCTION record_alias_resolution_on_dispatch() FROM PUBLIC;
CREATE TRIGGER runtime_dispatch_attempts_alias_resolution
  AFTER UPDATE OF native_result ON runtime_dispatch_attempts
  FOR EACH ROW WHEN (OLD.native_result IS NULL
    AND COALESCE(NEW.native_result->>'resolved_model','') <> '')
  EXECUTE FUNCTION record_alias_resolution_on_dispatch();

-- ------------------------------------------------------------ relisted

-- 0027's function, same signature: a refresh marks every model its list no
-- longer names unavailable — a rejected one too, which it used to leave as it
-- was. The verdict is not lost: it is the model's checks, and the row shows it
-- again when a list names the model (the listing puts status back in step).
CREATE OR REPLACE FUNCTION complete_catalog_refresh(
  p_refresh_id uuid, p_worker_id text, p_seen_entry_ids uuid[],
  p_missing_status text DEFAULT 'unavailable'
) RETURNS jsonb
LANGUAGE plpgsql
SET search_path TO control_plane, public, extensions, pg_temp
AS $$
DECLARE v_job catalog_refresh_jobs%ROWTYPE; v_missing integer;
BEGIN
  IF p_missing_status NOT IN ('stale','unavailable') THEN
    RAISE EXCEPTION 'invalid catalog missing status' USING ERRCODE='22023',
      DETAIL=jsonb_build_object('reason','catalog_entry_invalid')::text;
  END IF;
  SELECT * INTO v_job FROM catalog_refresh_jobs
  WHERE id=p_refresh_id AND status='in_progress'
    AND leased_by=p_worker_id AND leased_until>clock_timestamp()
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'catalog refresh lease is unavailable' USING ERRCODE='55000',
    DETAIL=jsonb_build_object('reason','catalog_refresh_not_leased')::text; END IF;

  UPDATE provider_model_catalog SET
    status=CASE WHEN status='rejected' THEN 'unavailable' ELSE p_missing_status END, stale_at=clock_timestamp(),
    verification_id=NULL, verified_lease_until=NULL,
    gate_requested_at=NULL,
    updated_at=clock_timestamp(), version=version+1
  WHERE connection_id=v_job.connection_id
    AND superseded_by IS NULL
    AND status IN ('discovered','verified','stale','rejected')
    AND NOT (id = ANY(COALESCE(p_seen_entry_ids,'{}'::uuid[])));
  GET DIAGNOSTICS v_missing = ROW_COUNT;

  UPDATE catalog_refresh_jobs SET
    status='completed', completed_at=clock_timestamp(),
    leased_by=NULL, leased_until=NULL
  WHERE id=v_job.id;
  PERFORM write_audit_event(NULL,NULL,NULL,'system',p_worker_id,
    'catalog.refresh_completed','provider_connection',v_job.connection_id::text,
    'allowed',NULL,jsonb_build_object('entries_seen',v_job.entries_seen,'missing',v_missing),
    v_job.id::text);
  RETURN jsonb_build_object(
    'refresh_id',v_job.id,'status','completed','entries_seen',v_job.entries_seen,
    'missing_marked',v_missing
  );
END; $$;

-- A model a list names again after it left one. If its latest verdict at the
-- active version and credential is a rejection, the reason may have gone with
-- the list (a provider re-adding a model, a plan changed): one automatic check,
-- budgeted like the others, at most once a day per model.
CREATE FUNCTION queue_model_check_on_relisting()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO control_plane, public, extensions, pg_temp
AS $$
DECLARE v_connection provider_connections%ROWTYPE; v_check model_checks%ROWTYPE;
BEGIN
  SELECT * INTO v_connection FROM provider_connections WHERE id = NEW.connection_id;
  IF v_connection.status IS DISTINCT FROM 'connected' THEN RETURN NULL; END IF;
  v_check := latest_decisive_check(NEW.id, active_runtime_version(NEW.runtime_type), v_connection.credential_generation);
  IF v_check.result IS DISTINCT FROM 'rejected' THEN RETURN NULL; END IF;
  IF EXISTS (SELECT 1 FROM model_checks k WHERE k.entry_id = NEW.id
               AND (k.finished_at IS NULL OR (k.trigger = 'relisted' AND k.requested_at > clock_timestamp() - interval '24 hours'))) THEN
    RETURN NULL;
  END IF;
  PERFORM queue_model_check(NEW.id, 'relisted', true, 'system', NULL, '',
    format('%s is in the list again after it was refused: %s', NEW.model_id, left(v_check.detail, 300)));
  RETURN NULL;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'the re-check of relisted model % was not queued: %', NEW.id, SQLERRM;
  RETURN NULL;
END $$;
REVOKE EXECUTE ON FUNCTION queue_model_check_on_relisting() FROM PUBLIC;
CREATE TRIGGER provider_model_catalog_relisted
  AFTER UPDATE OF status ON provider_model_catalog
  FOR EACH ROW WHEN (OLD.status = 'unavailable' AND NEW.status <> 'unavailable' AND NEW.superseded_by IS NULL)
  EXECUTE FUNCTION queue_model_check_on_relisting();

-- ------------------------------------------------------------ the panel

-- One model's state in the panel's words (§2.7), with its reason and moments:
-- 0101's model_row, taken out so the card's rollup and the row agree.
CREATE FUNCTION model_state(p_entry_id uuid)
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
  RETURN jsonb_build_object('state', v_state, 'reason', v_reason, 'checked_at', v_checked, 'retry_at', v_retry);
END $$;
REVOKE EXECUTE ON FUNCTION model_state(uuid) FROM PUBLIC;

-- 0101's ModelRow, same keys, plus alias_drift: what real runs report the
-- alias resolving to when that is not what its last passed check recorded
-- ({model, seen_at}, else null). resolved_model falls back to what runs report
-- when no check has recorded one yet.
CREATE OR REPLACE FUNCTION model_row(p_entry_id uuid, p_operator_id uuid)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path TO control_plane, public, extensions, pg_temp
AS $$
DECLARE v_entry provider_model_catalog%ROWTYPE; v_state jsonb;
BEGIN
  SELECT * INTO v_entry FROM provider_model_catalog WHERE id = p_entry_id;
  v_state := model_state(p_entry_id);
  RETURN jsonb_build_object(
    'entry_id', v_entry.id, 'provider_id', v_entry.provider_id, 'model_id', v_entry.model_id,
    'display_name', v_entry.display_name, 'vendor', NULLIF(v_entry.model_vendor, ''),
    'pinned', v_entry.pinned_at IS NOT NULL,
    'in_use', COALESCE((SELECT jsonb_agg(jsonb_build_object('project_id', u.project_id,
        'project_name', u.project_name, 'role', u.role) ORDER BY u.project_name, u.role)
      FROM model_team_uses(p_operator_id) u WHERE u.entry_id = v_entry.id), '[]'::jsonb),
    'state', v_state->'state', 'reason', v_state->'reason', 'checked_at', v_state->'checked_at',
    'retry_at', v_state->'retry_at',
    'resolved_model', COALESCE(NULLIF(v_entry.resolved_model, ''), NULLIF(v_entry.observed_model, '')),
    'alias_drift', CASE WHEN v_entry.observed_model <> '' AND v_entry.resolved_model <> ''
        AND v_entry.observed_model <> v_entry.resolved_model
      THEN jsonb_build_object('model', v_entry.observed_model, 'seen_at', v_entry.observed_model_at) END);
END $$;

-- 0101's Models card, same keys, plus (docs/W6_W7_CONTRACT.md, 0105):
--  per connection
--    vendors   [{vendor, count}] over the listed models, for the search filter;
--    rollup    {ready, checking, not_checked, refused, waiting, total} over every
--              model total_models counts (failed counts as refused, as shown);
--    newer_runtime  what the latest qualification of a newer runtime version
--              would add to or drop from this connection's list, or null;
--  at the top
--    budget    {window_hours, next_slot_at, clear_at, auto_next_slot_at}: the
--              budget is the last 24 hours (model_check_usage), so it frees one
--              check when the oldest counted one ages out and is clear when the
--              newest does. Null moments when nothing is counted.
CREATE OR REPLACE FUNCTION get_operator_models(p_operator_id uuid)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path TO control_plane, public, extensions, pg_temp
AS $$
DECLARE
  v_limits jsonb := model_check_limits();
  v_usage jsonb := model_check_usage(p_operator_id);
  v_budget jsonb;
  v_connections jsonb;
BEGIN
  SELECT jsonb_build_object('window_hours', 24,
      'next_slot_at', min(k.started_at) + interval '24 hours',
      'clear_at', max(k.started_at) + interval '24 hours',
      'auto_next_slot_at', min(k.started_at) FILTER (WHERE k.automatic) + interval '24 hours')
    INTO v_budget
  FROM model_checks k
  WHERE k.operator_id = p_operator_id AND k.model_called AND k.started_at > clock_timestamp() - interval '24 hours';

  WITH used AS (
    SELECT DISTINCT u.entry_id FROM model_entries_in_use() u
    UNION SELECT DISTINCT t.entry_id FROM model_team_uses(p_operator_id) t
  ), rows AS (
    SELECT m.id, m.connection_id, m.model_id, m.status, m.model_vendor, m.pinned_at IS NOT NULL AS pinned,
      m.id IN (SELECT entry_id FROM used) AS in_use, m.status <> 'unavailable' AS listed,
      EXISTS (SELECT 1 FROM model_checks k WHERE k.entry_id = m.id) AS touched,
      count(*) FILTER (WHERE m.status <> 'unavailable') OVER (PARTITION BY m.connection_id) AS list_size
    FROM provider_model_catalog m
    WHERE m.operator_id = p_operator_id AND m.superseded_by IS NULL
  ), shown AS (
    SELECT r.*, (r.pinned OR r.in_use OR (r.listed AND r.list_size <= (v_limits->>'small_list_max')::int)) AS show
    FROM rows r
  ), counted AS (
    -- A row no check has touched is what its writer set (0099), so its state
    -- needs no look at the checks; the rest is model_state's.
    SELECT s.*, CASE
      WHEN s.touched OR c.status IS DISTINCT FROM 'connected' THEN model_state(s.id)->>'state'
      WHEN NOT s.listed THEN 'refused'
      WHEN s.status = 'verified' THEN 'ready'
      ELSE 'not_checked' END AS state
    FROM shown s JOIN provider_connections c ON c.id = s.connection_id
    WHERE s.show OR s.listed
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
    'total_models', (SELECT count(*) FROM counted s WHERE s.connection_id = c.id),
    'models', COALESCE((SELECT jsonb_agg(model_row(s.id, p_operator_id) ORDER BY s.in_use DESC, s.pinned DESC, s.model_id)
                        FROM shown s WHERE s.connection_id = c.id AND s.show), '[]'::jsonb),
    'more_count', (SELECT count(*) FROM shown s WHERE s.connection_id = c.id AND s.listed AND NOT s.show),
    'vendors', COALESCE((SELECT jsonb_agg(jsonb_build_object('vendor', v.vendor, 'count', v.n) ORDER BY v.vendor)
                         FROM (SELECT s.model_vendor AS vendor, count(*) AS n FROM shown s
                               WHERE s.connection_id = c.id AND s.listed AND s.model_vendor <> ''
                               GROUP BY s.model_vendor) v), '[]'::jsonb),
    'rollup', (SELECT jsonb_build_object(
        'ready', count(*) FILTER (WHERE s.state = 'ready'),
        'checking', count(*) FILTER (WHERE s.state = 'checking'),
        'not_checked', count(*) FILTER (WHERE s.state = 'not_checked'),
        'refused', count(*) FILTER (WHERE s.state IN ('refused','failed')),
        'waiting', count(*) FILTER (WHERE s.state = 'waiting'),
        'total', count(*))
      FROM counted s WHERE s.connection_id = c.id),
    'newer_runtime', connection_catalog_preview(c.id)
  ) ORDER BY c.provider, c.access_gateway, c.created_at), '[]'::jsonb)
  INTO v_connections
  FROM provider_connections c
  WHERE c.operator_id = p_operator_id AND c.connection_kind = 'model_access';
  RETURN jsonb_build_object(
    'checks_today', (v_usage->>'used')::int,
    'auto_checks', jsonb_build_object('used', (v_usage->>'auto_used')::int, 'limit', (v_limits->>'auto_per_day')::int),
    'hard_limit', (v_limits->>'hard_per_day')::int,
    'budget', v_budget,
    'connections', v_connections);
END $$;

-- 0100's request, same signature and keys, plus the reason (and the verdict)
-- when the answer is immediate: a pick or a pin of a model refused at its
-- current key answers refused with why, so the dialog needs no poll to say it;
-- a check that waits says what for.
CREATE OR REPLACE FUNCTION request_model_check(p_operator_id uuid, p_entry_id uuid, p_trigger text)
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
  v_deduplicated boolean;
  v_state text;
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
    v_deduplicated := true;
  ELSE
    v_usage := model_check_usage(p_operator_id);
    IF (v_usage->>'used')::int + (v_usage->>'operator_pending')::int >= (model_check_limits()->>'hard_per_day')::int THEN
      PERFORM refuse('model_check_budget',
        format('%s model checks in the last 24 hours: the daily ceiling is %s', v_usage->>'used',
          model_check_limits()->>'hard_per_day'), '54000');
    END IF;
    v_queued := queue_model_check(p_entry_id, p_trigger, false, p_operator_id::text);
    SELECT * INTO v_current FROM model_checks WHERE id = (v_queued->>'check_id')::uuid;
    v_deduplicated := (v_queued->>'deduplicated')::boolean;
    PERFORM write_audit_event(NULL,NULL,NULL,'operator',p_operator_id::text,
      'model.check_requested','provider_model_catalog',p_entry_id::text,'allowed',NULL,
      jsonb_build_object('check_id',v_current.id,'trigger',p_trigger,'model_id',v_entry.model_id),v_current.id::text);
  END IF;
  v_state := model_check_state(v_current);
  RETURN jsonb_build_object('check_id', v_current.id, 'state', v_state, 'deduplicated', v_deduplicated,
    'result', v_current.result, 'failure_class', v_current.failure_class,
    'reason', CASE WHEN v_state IN ('refused','failed') THEN NULLIF(v_current.detail, '')
                   WHEN v_state = 'waiting' THEN COALESCE(NULLIF(v_current.wait_reason, ''), NULLIF(v_current.detail, '')) END,
    'retry_at', CASE WHEN v_current.finished_at IS NULL AND v_current.not_before > clock_timestamp() THEN v_current.not_before
                     WHEN v_current.result = 'inconclusive' THEN v_current.retry_after END);
END $$;

DO $$ BEGIN
  RAISE NOTICE 'catalog polish: %', jsonb_build_object(
    'verified_before', (SELECT count(*) FROM pg_temp.catalog_polish_selectable),
    'verified_after', (SELECT count(*) FROM provider_model_catalog WHERE status = 'verified' AND superseded_by IS NULL),
    'no_longer_selectable', (SELECT COALESCE(jsonb_agg(format('%s %s', m.runtime_type, m.model_id) ORDER BY m.runtime_type, m.model_id), '[]'::jsonb)
      FROM provider_model_catalog m JOIN pg_temp.catalog_polish_selectable s ON s.id = m.id WHERE m.status <> 'verified'));
END $$;
DROP TABLE pg_temp.catalog_polish_selectable;
