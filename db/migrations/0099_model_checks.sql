-- A model is usable because a check proved it, here, at this runtime version,
-- with this credential (Stage 12 W6; docs/RUNTIMES_AND_MODELS_DESIGN.md §2.1,
-- §2.4, §5.1, decisions R2–R4).
--
-- Until now one column said it all: `status = 'verified'` was written by the
-- capability gate and stayed true through a runtime update, a new login and a
-- model the provider stopped offering (the gpt-6-sol case in the review notes).
-- Here the three facts get their homes. What a check found is model_checks, one
-- row per check, never rewritten once it has a result. Which runtime version is
-- active is runtime_active_versions, one row per runtime, written by whatever
-- last saw it change (the supervisor's health report, the daily watch, a
-- promotion or rollback). Which credential a connection carries is
-- provider_connections.credential_generation, bumped by every stored or
-- replaced credential and every return to `connected`.
--
-- Eligible is one definition, model_eligibility(): not superseded, listed at the
-- active runtime version, the connection connected, and the latest decisive
-- check for (active version, current credential) passed. `status` stays as its
-- maintained projection (verified ⇔ eligible), so the Team tab, snapshots and
-- readiness — every reader since 0027 — keep reading one column and are
-- unchanged. A row no decisive check has ever touched keeps the status its
-- writer gave it: that is every row a test fixture or an older release inserts
-- directly, and nothing on a host after this migration, because every verified
-- and rejected row gets its legacy check below.
--
-- Decisions the W5-a author left open, and what is decided here:
--  (a) A check counts for the runtime version it ran at. A promotion carries a
--      passed check to the new version only for the models its qualification
--      re-checked (the models.in_use check of 0096) — the trigger on
--      runtime_activations writes those carried checks, marked 'qualification'.
--      Listings carry further: a qualified promotion lists at the new version
--      every model listed at the version left (unless the candidate's list read
--      failed), so a version change never makes a model unselectable only
--      because no refresh has run there yet; the first refresh corrects the
--      list. Promotions recorded before this migration get the same carry in the
--      backfill. A rollback needs nothing: the checks and listings at the older
--      version are still there.
--  (b) Codex and Claude rows whose version was never recorded: their listings
--      are attributed to the version active at this migration (the baseline),
--      and their legacy checks to the version active when the check was made —
--      the latest activation before it (0097), else the receipt's own version,
--      else the baseline. So a model verified by a candidate gate while an
--      activation says another version was active does not count now.
--  (c) "Listed at the active version" is: not unavailable (the last refresh at
--      the active runtime named it) and a model_listings row for exactly that
--      version. While no version is known at all (a fresh install before the
--      first health report), any listing counts, and checks are recorded with
--      the empty version — the same empty version they are later compared with.

SET search_path TO control_plane, public, extensions;

INSERT INTO failure_reasons(reason, code, note) VALUES
  ('model_check_budget','unavailable','the operator reached the daily ceiling of model checks; it resets as the day''s checks age out'),
  ('model_check_unavailable','not_found','no such model check for this operator'),
  ('model_check_not_leased','lease_lost','the model check is not leased by the worker reporting it'),
  ('model_check_invalid','invalid_argument','a model check result, class or trigger outside the vocabulary'),
  ('catalog_entry_not_owned','permission_denied','the catalog entry or connection is not the operator''s')
ON CONFLICT (reason) DO NOTHING;

-- ------------------------------------------------------------ active version

CREATE TABLE runtime_active_versions (
  runtime_type text PRIMARY KEY CHECK (runtime_type IN ('codex','opencode','claude','antigravity')),
  version text NOT NULL CHECK (length(version) BETWEEN 1 AND 64),
  source text NOT NULL CHECK (source IN ('health','watch','activation','baseline')),
  changed_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
REVOKE ALL ON runtime_active_versions FROM PUBLIC;

-- The version eligibility compares with. Stored, not read live from the health
-- report, because the report goes stale every few minutes a supervisor is
-- quiet, and eligibility must not flap with it: a version stays active until
-- something says another one is. Empty when nothing ever said.
CREATE FUNCTION active_runtime_version(p_runtime text)
RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO control_plane, public, extensions, pg_temp
AS $$
  SELECT COALESCE((SELECT version FROM runtime_active_versions WHERE runtime_type = p_runtime), '');
$$;
REVOKE EXECUTE ON FUNCTION active_runtime_version(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION active_runtime_version(text) TO infra_worker;

-- ------------------------------------------------------------ credentials

ALTER TABLE provider_connections
  ADD COLUMN credential_generation bigint NOT NULL DEFAULT 1 CHECK (credential_generation > 0);

-- A return to `connected` is a credential the platform has not seen work yet:
-- a reconnect after an expiry, a disconnect undone. The same reason 0093
-- refreshes the list on it.
CREATE FUNCTION bump_credential_generation_on_connect()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO control_plane, public, extensions, pg_temp
AS $$
BEGIN
  IF NEW.status = 'connected' AND OLD.status IS DISTINCT FROM 'connected' THEN
    NEW.credential_generation := OLD.credential_generation + 1;
  END IF;
  RETURN NEW;
END $$;
REVOKE EXECUTE ON FUNCTION bump_credential_generation_on_connect() FROM PUBLIC;
CREATE TRIGGER provider_connections_credential_generation
  BEFORE UPDATE OF status ON provider_connections
  FOR EACH ROW EXECUTE FUNCTION bump_credential_generation_on_connect();

-- A credential stored over one that worked leaves the connection `connected`
-- throughout, so the status cannot tell. The two places a credential is
-- stored can: an OpenCode key enrollment completing, a Codex device login
-- consumed. (Claude's login lives in the runtime's own home; the platform sees
-- it only as a return to connected.)
CREATE FUNCTION bump_credential_generation_on_store()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO control_plane, public, extensions, pg_temp
AS $$
BEGIN
  UPDATE provider_connections SET credential_generation = credential_generation + 1
  WHERE id = NEW.connection_id;
  RETURN NULL;
END $$;
REVOKE EXECUTE ON FUNCTION bump_credential_generation_on_store() FROM PUBLIC;
CREATE TRIGGER provider_secret_enrollments_credential_generation
  AFTER UPDATE OF status ON provider_secret_enrollments
  FOR EACH ROW WHEN (NEW.status = 'completed' AND OLD.status IS DISTINCT FROM 'completed')
  EXECUTE FUNCTION bump_credential_generation_on_store();
CREATE TRIGGER provider_login_sessions_credential_generation
  AFTER UPDATE OF status ON provider_login_sessions
  FOR EACH ROW WHEN (NEW.status = 'consumed' AND OLD.status IS DISTINCT FROM 'consumed')
  EXECUTE FUNCTION bump_credential_generation_on_store();

-- ------------------------------------------------------------ checks

CREATE TABLE model_checks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entry_id uuid NOT NULL REFERENCES provider_model_catalog(id) ON DELETE CASCADE,
  operator_id uuid NOT NULL,
  connection_id uuid NOT NULL REFERENCES provider_connections(id) ON DELETE CASCADE,
  runtime_type text NOT NULL CHECK (runtime_type IN ('codex','opencode','claude','antigravity')),
  -- The key a check is for. Set when it is asked for and brought up to date
  -- when it is claimed, since until then nothing has run.
  runtime_version text NOT NULL DEFAULT '' CHECK (length(runtime_version) <= 64),
  adapter_version text NOT NULL DEFAULT '' CHECK (length(adapter_version) <= 64),
  credential_generation bigint NOT NULL CHECK (credential_generation > 0),
  trigger text NOT NULL CHECK (trigger IN ('auto_small_list','in_use','pin','pick','check_again',
    'run_failure','ttl','alias_drift','qualification','legacy')),
  -- Whether the operator asked (pick, pin, check again) or the platform did.
  -- The automatic ones are budgeted (R5); the operator's are counted.
  automatic boolean NOT NULL,
  -- The lane's order: pick 0, the operator's pin and check-again 1, in-use
  -- re-checks 2, whole small lists 3 (§2.8).
  priority smallint NOT NULL CHECK (priority BETWEEN 0 AND 9),
  qualification_id uuid REFERENCES runtime_qualifications(id),
  -- An inconclusive attempt is finished and its retry is a new row: every
  -- attempt is one row written once, and a dialog polling the first id follows
  -- the chain to the latest.
  retry_of uuid REFERENCES model_checks(id),
  root_id uuid NOT NULL,
  attempt integer NOT NULL DEFAULT 1 CHECK (attempt BETWEEN 1 AND 100),
  result text CHECK (result IN ('passed','rejected','inconclusive','failed')),
  failure_class text CHECK (failure_class IN ('model','infrastructure','runtime','harness')),
  detail text NOT NULL DEFAULT '' CHECK (length(detail) <= 500),
  resolved_model text NOT NULL DEFAULT '' CHECK (length(resolved_model) <= 200),
  peak_memory_mb integer CHECK (peak_memory_mb >= 0),
  -- Whether a model turn was sent. A check handed back before it (memory, a
  -- paused runtime, a Codex window above 80 %) spent nothing and counts
  -- toward no budget.
  model_called boolean NOT NULL DEFAULT false,
  requested_by text NOT NULL DEFAULT '' CHECK (length(requested_by) <= 120),
  requested_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  not_before timestamptz NOT NULL DEFAULT clock_timestamp(),
  -- Why a queued check is not running: shown as "waiting (reason)".
  wait_reason text NOT NULL DEFAULT '' CHECK (length(wait_reason) <= 200),
  leased_by text CHECK (length(leased_by) <= 200),
  lease_until timestamptz,
  started_at timestamptz,
  finished_at timestamptz,
  retry_after timestamptz,
  CHECK ((finished_at IS NULL) = (result IS NULL)),
  CHECK ((leased_by IS NULL) = (lease_until IS NULL)),
  CHECK (leased_by IS NULL OR finished_at IS NULL),
  CHECK ((result = 'passed') = (result IS NOT NULL AND failure_class IS NULL)),
  CHECK (result IS DISTINCT FROM 'rejected' OR failure_class = 'model'),
  CHECK (result IS DISTINCT FROM 'inconclusive' OR failure_class = 'infrastructure'),
  CHECK (result IS DISTINCT FROM 'failed' OR failure_class IN ('runtime','harness')),
  CHECK (trigger <> 'qualification' OR qualification_id IS NOT NULL)
);
CREATE INDEX model_checks_by_entry ON model_checks(entry_id, finished_at DESC);
CREATE INDEX model_checks_pending ON model_checks(priority, requested_at) WHERE finished_at IS NULL;
CREATE INDEX model_checks_by_operator ON model_checks(operator_id, started_at);
CREATE INDEX model_checks_by_root ON model_checks(root_id, attempt DESC);
-- One queued or running check per model at a time: the lane's idempotency
-- holds even against two requests racing past each other.
CREATE UNIQUE INDEX model_checks_one_pending ON model_checks(entry_id) WHERE finished_at IS NULL;
REVOKE ALL ON model_checks FROM PUBLIC;
-- Read by the workers (the lane's own writes go through its functions); the
-- panel reads it only through the operator's functions.
GRANT SELECT ON model_checks TO infra_worker;

-- The root of a chain is its first check; a result, once written, is never
-- rewritten — the check is the evidence.
CREATE FUNCTION model_checks_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO control_plane, public, extensions, pg_temp
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.root_id := COALESCE(NEW.root_id, NEW.id);
    RETURN NEW;
  END IF;
  IF OLD.finished_at IS NOT NULL THEN
    PERFORM refuse('model_check_invalid', format('model check %s already has its result', OLD.id));
  END IF;
  RETURN NEW;
END $$;
REVOKE EXECUTE ON FUNCTION model_checks_guard() FROM PUBLIC;
CREATE TRIGGER model_checks_guard BEFORE INSERT OR UPDATE ON model_checks
  FOR EACH ROW EXECUTE FUNCTION model_checks_guard();

ALTER TABLE provider_model_catalog
  ADD COLUMN last_check_id uuid REFERENCES model_checks(id) ON DELETE SET NULL;

-- ------------------------------------------------------------ eligibility

-- Listed at the active version, per (c) above.
CREATE FUNCTION model_listed_at(p_entry_id uuid, p_version text)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO control_plane, public, extensions, pg_temp
AS $$
  SELECT CASE WHEN COALESCE(p_version,'') = '' THEN true
    ELSE EXISTS (SELECT 1 FROM model_listings l WHERE l.entry_id = p_entry_id AND l.runtime_version = p_version) END;
$$;
REVOKE EXECUTE ON FUNCTION model_listed_at(uuid, text) FROM PUBLIC;

-- The latest check with a verdict for one model at one key. Inconclusive is no
-- verdict: a limit or a lost network says nothing about the model, so it
-- neither grants nor takes away eligibility.
CREATE FUNCTION latest_decisive_check(p_entry_id uuid, p_version text, p_generation bigint)
RETURNS model_checks
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO control_plane, public, extensions, pg_temp
AS $$
  SELECT k.* FROM model_checks k
  WHERE k.entry_id = p_entry_id AND k.runtime_version = COALESCE(p_version,'')
    AND k.credential_generation = p_generation
    AND k.result IN ('passed','rejected','failed')
  ORDER BY k.finished_at DESC, k.id DESC
  LIMIT 1;
$$;
REVOKE EXECUTE ON FUNCTION latest_decisive_check(uuid, text, bigint) FROM PUBLIC;

-- The one definition of §2.1. {eligible, reason, check_id, runtime_version,
-- credential_generation}; the reason says what is missing.
CREATE FUNCTION model_eligibility(p_entry_id uuid)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path TO control_plane, public, extensions, pg_temp
AS $$
DECLARE
  v_entry provider_model_catalog%ROWTYPE;
  v_connection provider_connections%ROWTYPE;
  v_version text;
  v_check model_checks%ROWTYPE;
  v_reason text;
BEGIN
  SELECT * INTO v_entry FROM provider_model_catalog WHERE id = p_entry_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('eligible', false, 'reason', 'unknown_entry');
  END IF;
  SELECT * INTO v_connection FROM provider_connections WHERE id = v_entry.connection_id;
  v_version := active_runtime_version(v_entry.runtime_type);
  v_reason := CASE
    WHEN v_entry.superseded_by IS NOT NULL THEN 'superseded'
    WHEN v_entry.status = 'unavailable' THEN 'not_listed'
    WHEN v_connection.status IS DISTINCT FROM 'connected' THEN 'connection_not_connected' END;
  IF v_reason IS NULL AND NOT EXISTS (
    SELECT 1 FROM model_checks k WHERE k.entry_id = p_entry_id AND k.result IN ('passed','rejected','failed')
  ) THEN
    -- Never touched by a check: the status its writer set (see the header).
    RETURN jsonb_build_object('eligible', v_entry.status = 'verified',
      'reason', CASE WHEN v_entry.status = 'verified' THEN 'legacy' ELSE 'not_checked' END,
      'check_id', NULL, 'runtime_version', v_version,
      'credential_generation', v_connection.credential_generation);
  END IF;
  IF v_reason IS NULL AND NOT model_listed_at(p_entry_id, v_version) THEN
    v_reason := 'not_listed_at_version';
  END IF;
  IF v_reason IS NULL THEN
    v_check := latest_decisive_check(p_entry_id, v_version, v_connection.credential_generation);
    IF v_check.id IS NULL THEN
      v_reason := CASE
        WHEN EXISTS (SELECT 1 FROM model_checks k WHERE k.entry_id = p_entry_id AND k.result = 'passed'
                       AND k.runtime_version <> v_version) THEN 'runtime_version_changed'
        WHEN EXISTS (SELECT 1 FROM model_checks k WHERE k.entry_id = p_entry_id AND k.result = 'passed'
                       AND k.credential_generation <> v_connection.credential_generation) THEN 'credential_changed'
        ELSE 'not_checked' END;
    ELSIF v_check.result <> 'passed' THEN
      v_reason := 'check_' || v_check.result;
    END IF;
  END IF;
  RETURN jsonb_build_object('eligible', v_reason IS NULL, 'reason', v_reason,
    'check_id', v_check.id, 'runtime_version', v_version,
    'credential_generation', v_connection.credential_generation);
END $$;
REVOKE EXECUTE ON FUNCTION model_eligibility(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION model_eligibility(uuid) TO infra_worker;

-- `status` kept in step with model_eligibility. Rows that are history
-- (superseded), not in the list (unavailable) or never judged by a check are
-- left as they are: those are facts other writers own.
CREATE FUNCTION project_model_status(p_entry_id uuid)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO control_plane, public, extensions, pg_temp
AS $$
DECLARE
  v_entry provider_model_catalog%ROWTYPE;
  v_eligibility jsonb;
  v_check model_checks%ROWTYPE;
  v_generation bigint;
  v_status text;
BEGIN
  SELECT * INTO v_entry FROM provider_model_catalog WHERE id = p_entry_id FOR UPDATE;
  IF NOT FOUND OR v_entry.superseded_by IS NOT NULL OR v_entry.status = 'unavailable' THEN RETURN; END IF;
  IF NOT EXISTS (SELECT 1 FROM model_checks k WHERE k.entry_id = p_entry_id AND k.result IN ('passed','rejected','failed')) THEN
    RETURN;
  END IF;
  v_eligibility := model_eligibility(p_entry_id);
  SELECT credential_generation INTO v_generation FROM provider_connections WHERE id = v_entry.connection_id;
  v_check := latest_decisive_check(p_entry_id, v_eligibility->>'runtime_version', v_generation);
  v_status := CASE WHEN (v_eligibility->>'eligible')::boolean THEN 'verified'
                   WHEN v_check.result IN ('rejected','failed') THEN 'rejected'
                   ELSE 'discovered' END;
  UPDATE provider_model_catalog SET
    status = v_status,
    verification_id = CASE WHEN v_status = 'verified' THEN v_check.id END,
    last_verified_at = CASE WHEN v_status = 'verified' THEN v_check.finished_at ELSE last_verified_at END,
    verified_lease_until = NULL,
    failure_code = CASE v_status WHEN 'rejected' THEN 'model_check_' || v_check.result ELSE '' END,
    failure_message = CASE v_status WHEN 'rejected'
      THEN left(COALESCE(NULLIF(v_check.detail,''), 'The model check did not pass.'), 500) ELSE '' END,
    resolved_model = CASE WHEN v_status = 'verified' AND v_check.resolved_model <> '' THEN v_check.resolved_model
                          ELSE resolved_model END,
    updated_at = clock_timestamp(), version = version + 1
  WHERE id = p_entry_id
    AND (status IS DISTINCT FROM v_status
      OR verification_id IS DISTINCT FROM CASE WHEN v_status = 'verified' THEN v_check.id END
      OR failure_code IS DISTINCT FROM CASE v_status WHEN 'rejected' THEN 'model_check_' || v_check.result ELSE '' END);
END $$;
REVOKE EXECUTE ON FUNCTION project_model_status(uuid) FROM PUBLIC;

-- Every live row of one connection, or of one runtime.
CREATE FUNCTION project_model_statuses(p_connection_id uuid, p_runtime text)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO control_plane, public, extensions, pg_temp
AS $$
DECLARE v_id uuid; v_count integer := 0;
BEGIN
  FOR v_id IN
    SELECT m.id FROM provider_model_catalog m
    WHERE m.superseded_by IS NULL
      AND (p_connection_id IS NULL OR m.connection_id = p_connection_id)
      AND (p_runtime IS NULL OR m.runtime_type = p_runtime)
    ORDER BY m.id
  LOOP
    PERFORM project_model_status(v_id);
    v_count := v_count + 1;
  END LOOP;
  RETURN v_count;
END $$;
REVOKE EXECUTE ON FUNCTION project_model_statuses(uuid, text) FROM PUBLIC;

-- A check with its verdict, and a version newly listing a model.
CREATE FUNCTION project_model_status_on_check()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO control_plane, public, extensions, pg_temp
AS $$
BEGIN
  PERFORM project_model_status(NEW.entry_id);
  IF NEW.result IS NOT NULL THEN
    UPDATE provider_model_catalog SET last_check_id = NEW.id WHERE id = NEW.entry_id
      AND last_check_id IS DISTINCT FROM NEW.id;
  END IF;
  RETURN NULL;
END $$;
REVOKE EXECUTE ON FUNCTION project_model_status_on_check() FROM PUBLIC;
CREATE TRIGGER model_checks_project_status
  AFTER INSERT OR UPDATE OF result ON model_checks
  FOR EACH ROW WHEN (NEW.result IS NOT NULL)
  EXECUTE FUNCTION project_model_status_on_check();

CREATE FUNCTION project_model_status_on_listing()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO control_plane, public, extensions, pg_temp
AS $$
BEGIN
  PERFORM project_model_status(NEW.entry_id);
  RETURN NULL;
END $$;
REVOKE EXECUTE ON FUNCTION project_model_status_on_listing() FROM PUBLIC;
CREATE TRIGGER model_listings_project_status
  AFTER INSERT OR UPDATE ON model_listings
  FOR EACH ROW EXECUTE FUNCTION project_model_status_on_listing();

-- A connection leaving or returning to `connected`, or carrying a new
-- credential, changes every one of its models at once.
CREATE FUNCTION project_model_status_on_connection()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO control_plane, public, extensions, pg_temp
AS $$
BEGIN
  PERFORM project_model_statuses(NEW.id, NULL);
  RETURN NULL;
END $$;
REVOKE EXECUTE ON FUNCTION project_model_status_on_connection() FROM PUBLIC;
CREATE TRIGGER provider_connections_project_model_status
  AFTER UPDATE OF status, credential_generation ON provider_connections
  FOR EACH ROW WHEN (NEW.connection_kind = 'model_access'
    AND (OLD.status IS DISTINCT FROM NEW.status OR OLD.credential_generation <> NEW.credential_generation))
  EXECUTE FUNCTION project_model_status_on_connection();

-- ------------------------------------------------------------ version changes

-- Records that a runtime now runs p_version, and when that is a change, puts
-- every model of the runtime in step and asks for its list at the new version.
-- The first version ever recorded changes nothing that was judged: the empty
-- key had no checks worth keeping and asking every connection for its list
-- again would only repeat the reconnect's refresh.
CREATE FUNCTION note_active_runtime_version(p_runtime text, p_version text, p_source text)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO control_plane, public, extensions, pg_temp
AS $$
DECLARE v_previous text; v_connection record;
BEGIN
  IF COALESCE(p_version,'') = '' OR length(p_version) > 64 THEN RETURN false; END IF;
  SELECT version INTO v_previous FROM runtime_active_versions WHERE runtime_type = p_runtime FOR UPDATE;
  IF v_previous IS NOT DISTINCT FROM p_version THEN RETURN false; END IF;
  INSERT INTO runtime_active_versions(runtime_type, version, source) VALUES (p_runtime, p_version, p_source)
  ON CONFLICT (runtime_type) DO UPDATE SET version = EXCLUDED.version, source = EXCLUDED.source,
    changed_at = clock_timestamp();
  PERFORM project_model_statuses(NULL, p_runtime);
  IF v_previous IS NOT NULL THEN
    FOR v_connection IN
      SELECT DISTINCT c.id, c.operator_id FROM provider_connections c
      JOIN provider_model_catalog m ON m.connection_id = c.id AND m.runtime_type = p_runtime
      WHERE c.status = 'connected'
        AND NOT EXISTS (SELECT 1 FROM catalog_refresh_jobs j
                        WHERE j.connection_id = c.id AND j.status IN ('pending','in_progress'))
    LOOP
      INSERT INTO catalog_refresh_jobs(operator_id, connection_id, reason)
      VALUES (v_connection.operator_id, v_connection.id, 'runtime_version_changed');
    END LOOP;
  END IF;
  RETURN true;
END $$;
REVOKE EXECUTE ON FUNCTION note_active_runtime_version(text, text, text) FROM PUBLIC;

-- The supervisor's report is written every few seconds; only a changed version
-- does anything. A report the version cannot be read from, or a runtime this
-- schema does not know, changes nothing, and nothing here may fail the report.
CREATE FUNCTION note_runtime_version_from_health()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO control_plane, public, extensions, pg_temp
AS $$
DECLARE v_entry jsonb;
BEGIN
  IF jsonb_typeof(NEW.snapshot->'runtimes') IS DISTINCT FROM 'array' THEN RETURN NULL; END IF;
  FOR v_entry IN SELECT e FROM jsonb_array_elements(NEW.snapshot->'runtimes') e LOOP
    CONTINUE WHEN v_entry ? 'unreadable' OR COALESCE(v_entry->>'version','') = ''
      OR (v_entry->>'installed') = 'false'
      OR NOT EXISTS (SELECT 1 FROM runtime_roles r WHERE r.runtime_type = v_entry->>'runtime');
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
REVOKE EXECUTE ON FUNCTION note_runtime_version_from_health() FROM PUBLIC;
CREATE TRIGGER runtime_health_active_version
  AFTER INSERT OR UPDATE OF snapshot ON runtime_health
  FOR EACH ROW EXECUTE FUNCTION note_runtime_version_from_health();

CREATE FUNCTION note_runtime_version_from_watch()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO control_plane, public, extensions, pg_temp
AS $$
BEGIN
  PERFORM note_active_runtime_version(NEW.runtime_type, NEW.active_version, 'watch');
  RETURN NULL;
END $$;
REVOKE EXECUTE ON FUNCTION note_runtime_version_from_watch() FROM PUBLIC;
CREATE TRIGGER runtime_watch_state_active_version
  AFTER INSERT OR UPDATE OF active_version ON runtime_watch_state
  FOR EACH ROW WHEN (COALESCE(NEW.active_version,'') <> '')
  EXECUTE FUNCTION note_runtime_version_from_watch();

-- The models a qualification re-checked on the candidate, by model id, from
-- its models.in_use check: the evidence's list where it has one (the batch
-- runtimes), else the detail line ("gpt-5.6-luna: ok, gpt-5.5: limited").
CREATE FUNCTION qualification_models_ok(p_qualification_id uuid)
RETURNS SETOF text
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO control_plane, public, extensions, pg_temp
AS $$
  WITH c AS (
    SELECT * FROM runtime_qualification_checks
    WHERE qualification_id = p_qualification_id AND check_key = 'models.in_use'
      AND result IN ('passed','inconclusive')
  )
  SELECT m->>'model' FROM c, jsonb_array_elements(
      CASE WHEN jsonb_typeof(c.evidence->'models') = 'array' THEN c.evidence->'models' ELSE '[]'::jsonb END) m
  WHERE (m->>'ok') = 'true' AND COALESCE(m->>'model','') <> ''
  UNION
  SELECT substring(part FROM '^(.*): ok$') FROM c, regexp_split_to_table(c.detail, ', ') part
  WHERE jsonb_typeof(c.evidence->'models') IS DISTINCT FROM 'array' AND part ~ ': ok$';
$$;
REVOKE EXECUTE ON FUNCTION qualification_models_ok(uuid) FROM PUBLIC;

-- The entries a project team or an open task names. The design's "models in
-- use": what a runtime update must not take away, and what is re-checked by
-- itself. A superseded row a snapshot still names counts as the row that
-- replaced it.
CREATE FUNCTION model_entries_in_use()
RETURNS TABLE(entry_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO control_plane, public, extensions, pg_temp
AS $$
  WITH named AS (
    SELECT d.orchestrator_entry_id AS id FROM project_runtime_defaults d
    JOIN projects p ON p.id = d.project_id AND p.deleted_at IS NULL
    WHERE d.orchestrator_entry_id IS NOT NULL
    UNION
    SELECT e.catalog_entry_id FROM project_runtime_default_executors e
    JOIN projects p ON p.id = e.project_id AND p.deleted_at IS NULL
    UNION
    SELECT NULLIF(s.orchestrator->>'entry_id','')::uuid FROM task_runtime_snapshots s
    JOIN tasks t ON t.id = s.task_id AND t.status NOT IN ('completed','failed','cancelled','deployed')
    WHERE s.source = 'catalog'
    UNION
    SELECT NULLIF(x->>'entry_id','')::uuid FROM task_runtime_snapshots s
    JOIN tasks t ON t.id = s.task_id AND t.status NOT IN ('completed','failed','cancelled','deployed'),
      jsonb_array_elements(CASE WHEN jsonb_typeof(s.executors) = 'array' THEN s.executors ELSE '[]'::jsonb END) x
    WHERE s.source = 'catalog'
  )
  SELECT DISTINCT COALESCE(m.superseded_by, m.id) FROM named n
  JOIN provider_model_catalog m ON m.id = n.id;
$$;
REVOKE EXECUTE ON FUNCTION model_entries_in_use() FROM PUBLIC;

-- A promotion earned by a qualification keeps what the qualification proved
-- (decision (a)), in two parts:
--
--  * Listings. A version change must not make a model unselectable only
--    because no refresh has run at the new version yet. So every model listed
--    at the version left (and not unavailable) is listed at the new version
--    too — unless the qualification read the candidate's list and that read
--    failed. The candidate's own list was read by its catalog.list check (Codex,
--    OpenCode); Claude's aliases are declared, not read, and do not change with
--    the version. The first refresh at the new version then marks whatever it
--    no longer names unavailable, as every refresh does.
--  * Checks. Only the models in use that the qualification re-checked on the
--    candidate (models.in_use reported them ok), and that passed at the version
--    left, get a check at the new version. Carrying is keeping, not granting.
--    Every other model is listed but "not checked" at the new version, and is
--    checked again the way R2 says: pinned models and small lists by
--    themselves, the rest when picked or pinned.
--
-- A rollback carries nothing: the checks and listings at the older version are
-- still there. Returns what it wrote.
CREATE FUNCTION carry_model_checks(p_runtime text, p_from text, p_to text, p_qualification_id uuid,
  p_actor text, p_at timestamptz)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO control_plane, public, extensions, pg_temp
AS $$
DECLARE v_entry record; v_listings integer := 0; v_checks integer := 0; v_list_failed boolean;
BEGIN
  IF p_qualification_id IS NULL OR COALESCE(p_from,'') = '' OR COALESCE(p_to,'') = '' OR p_from = p_to THEN
    RETURN jsonb_build_object('listings', 0, 'checks', 0);
  END IF;
  SELECT EXISTS (SELECT 1 FROM runtime_qualification_checks
                 WHERE qualification_id = p_qualification_id AND check_key = 'catalog.list' AND result <> 'passed')
    INTO v_list_failed;
  IF NOT v_list_failed THEN
    INSERT INTO model_listings(entry_id, runtime_type, runtime_version, first_seen_at, last_seen_at)
    SELECT l.entry_id, l.runtime_type, p_to, p_at, p_at
    FROM model_listings l JOIN provider_model_catalog m ON m.id = l.entry_id
    WHERE l.runtime_type = p_runtime AND l.runtime_version = p_from
      AND m.superseded_by IS NULL AND m.status <> 'unavailable'
    ON CONFLICT (entry_id, runtime_version) DO NOTHING;
    GET DIAGNOSTICS v_listings = ROW_COUNT;
  END IF;
  FOR v_entry IN
    SELECT m.id, m.operator_id, m.connection_id, m.runtime_type, m.adapter_version, c.credential_generation,
      k.resolved_model
    FROM provider_model_catalog m
    JOIN provider_connections c ON c.id = m.connection_id
    JOIN LATERAL latest_decisive_check(m.id, p_from, c.credential_generation) k ON k.result = 'passed'
    WHERE m.runtime_type = p_runtime AND m.superseded_by IS NULL
      AND m.id IN (SELECT u.entry_id FROM model_entries_in_use() u)
      AND m.model_id IN (SELECT qualification_models_ok(p_qualification_id))
      AND NOT EXISTS (SELECT 1 FROM model_checks x WHERE x.entry_id = m.id AND x.runtime_version = p_to
                        AND x.qualification_id = p_qualification_id)
  LOOP
    INSERT INTO model_listings(entry_id, runtime_type, runtime_version, first_seen_at, last_seen_at)
    VALUES (v_entry.id, v_entry.runtime_type, p_to, p_at, p_at)
    ON CONFLICT (entry_id, runtime_version) DO NOTHING;
    INSERT INTO model_checks(entry_id, operator_id, connection_id, runtime_type, runtime_version, adapter_version,
      credential_generation, trigger, automatic, priority, qualification_id, result, detail, resolved_model,
      requested_by, requested_at, started_at, finished_at)
    VALUES (v_entry.id, v_entry.operator_id, v_entry.connection_id, v_entry.runtime_type, p_to,
      v_entry.adapter_version, v_entry.credential_generation, 'qualification', true, 2, p_qualification_id,
      'passed', format('carried from %s: the qualification of %s re-checked it', p_from, p_to),
      COALESCE(v_entry.resolved_model,''), left(COALESCE(NULLIF(p_actor,''),'qualification'),120), p_at, p_at,
      clock_timestamp());
    v_checks := v_checks + 1;
  END LOOP;
  RETURN jsonb_build_object('listings', v_listings, 'checks', v_checks);
END $$;
REVOKE EXECUTE ON FUNCTION carry_model_checks(text, text, text, uuid, text, timestamptz) FROM PUBLIC;

-- The trigger: carry, then note the new version, which puts every model of
-- the runtime in step. It is AFTER INSERT and leaves the row as written, so it
-- sits beside any BEFORE INSERT trigger another package puts on the table.
CREATE FUNCTION carry_model_checks_on_activation()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO control_plane, public, extensions, pg_temp
AS $$
BEGIN
  IF NEW.kind = 'promote' THEN
    PERFORM carry_model_checks(NEW.runtime_type, NEW.from_version, NEW.version, NEW.qualification_id,
      NEW.actor, NEW.activated_at);
  END IF;
  PERFORM note_active_runtime_version(NEW.runtime_type, NEW.version, 'activation');
  RETURN NULL;
END $$;
REVOKE EXECUTE ON FUNCTION carry_model_checks_on_activation() FROM PUBLIC;
CREATE TRIGGER runtime_activations_carry_model_checks
  AFTER INSERT ON runtime_activations
  FOR EACH ROW EXECUTE FUNCTION carry_model_checks_on_activation();

-- 0098's function, with one more fallback: the version eligibility compares
-- with. A refresh while the health report is stale and the watch has not run
-- would otherwise record the empty version, which is listed at nothing.
CREATE OR REPLACE FUNCTION catalog_listing_version(p_runtime text, p_reported text)
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO control_plane, public, extensions, pg_temp
AS $$
DECLARE v_version text;
BEGIN
  IF COALESCE(p_reported,'') <> '' THEN RETURN left(p_reported, 64); END IF;
  v_version := runtime_health_reading(p_runtime)->>'version';
  IF COALESCE(v_version,'') = '' THEN
    SELECT w.active_version INTO v_version FROM runtime_watch_state w WHERE w.runtime_type = p_runtime;
  END IF;
  IF COALESCE(v_version,'') = '' THEN v_version := active_runtime_version(p_runtime); END IF;
  RETURN left(COALESCE(v_version,''), 64);
END $$;

-- ------------------------------------------------------------ backfill

-- Everything this migration derives from the rows that exist, as a function
-- so the DB test can run it over host-shaped rows (0067's test); running it
-- again changes nothing. Dropped in W5-b.
--  1. The baseline: the version each runtime runs now, from the last health
--     report (stale or not — it is the latest word), else the watch, else the
--     latest activation. Written directly: nothing is judged yet, so there is
--     nothing to put in step and no list to ask for.
--  2. Listings nobody recorded a version for belong to the baseline, per (b).
--  3. Every verified and rejected row becomes a legacy check with its verdict,
--     at the version it was judged at: the row's own when it carries one, else
--     the receipt's, else the version the latest activation before it made
--     active, else the baseline. The credential is the connection's current
--     one — the check is the reason the row is what it is today.
--  4. Promotions recorded before this migration get the carry the trigger
--     gives new ones: for each runtime, the latest activation, when it is a
--     qualified promotion to the version active now. (On the host: OpenCode
--     1.18.31 to 1.18.32, promoted before any refresh ran at 1.18.32.)
--  5. A gate in flight under the old worker ends with this release: the entry
--     is asked for again as a pin check (0100), like every request waiting.
--  6. Every live row is put in step, and what stops being selectable is named.
CREATE FUNCTION backfill_model_checks()
RETURNS jsonb
LANGUAGE plpgsql
SET search_path TO control_plane, public, extensions, pg_temp
AS $$
DECLARE
  v_before uuid[];
  v_legacy integer;
  v_carried jsonb := '[]'::jsonb;
  v_activation record;
  v_in_step integer;
  v_lost jsonb;
BEGIN
  SELECT COALESCE(array_agg(id), '{}') INTO v_before FROM provider_model_catalog
  WHERE status = 'verified' AND superseded_by IS NULL;

  INSERT INTO runtime_active_versions(runtime_type, version, source)
  SELECT r.runtime, r.version, 'baseline' FROM (
    SELECT DISTINCT ON (runtime) runtime, version FROM (
      SELECT e->>'runtime' AS runtime, e->>'version' AS version, 1 AS rank
      FROM runtime_health h, jsonb_array_elements(
        CASE WHEN jsonb_typeof(h.snapshot->'runtimes') = 'array' THEN h.snapshot->'runtimes' ELSE '[]'::jsonb END) e
      WHERE NOT (e ? 'unreadable') AND COALESCE(e->>'version','') <> ''
      UNION ALL
      SELECT w.runtime_type, w.active_version, 2 FROM runtime_watch_state w WHERE COALESCE(w.active_version,'') <> ''
      UNION ALL
      SELECT * FROM (SELECT DISTINCT ON (a.runtime_type) a.runtime_type, a.version, 3
        FROM runtime_activations a ORDER BY a.runtime_type, a.activated_at DESC) latest
    ) s
    WHERE runtime IN (SELECT runtime_type FROM runtime_roles) AND length(version) <= 64
    ORDER BY runtime, rank
  ) r
  ON CONFLICT (runtime_type) DO NOTHING;

  UPDATE model_listings l SET runtime_version = v.version
  FROM runtime_active_versions v
  WHERE l.runtime_version = '' AND v.runtime_type = l.runtime_type
    AND NOT EXISTS (SELECT 1 FROM model_listings o WHERE o.entry_id = l.entry_id AND o.runtime_version = v.version);
  DELETE FROM model_listings l USING runtime_active_versions v
  WHERE l.runtime_version = '' AND v.runtime_type = l.runtime_type;

  WITH judged AS (
    SELECT m.*, c.credential_generation,
      (SELECT r FROM model_verification_receipts r WHERE r.catalog_entry_id = m.id
         AND r.result = CASE WHEN m.status = 'verified' THEN 'passed' ELSE 'failed' END
       ORDER BY r.verified_at DESC LIMIT 1) AS receipt
    FROM provider_model_catalog m
    JOIN provider_connections c ON c.id = m.connection_id
    WHERE m.superseded_by IS NULL AND m.status IN ('verified','rejected')
      AND NOT EXISTS (SELECT 1 FROM model_checks k WHERE k.entry_id = m.id)
  )
  INSERT INTO model_checks(entry_id, operator_id, connection_id, runtime_type, runtime_version, adapter_version,
    credential_generation, trigger, automatic, priority, result, failure_class, detail, resolved_model,
    model_called, requested_by, requested_at, started_at, finished_at)
  SELECT j.id, j.operator_id, j.connection_id, j.runtime_type,
    COALESCE(NULLIF(j.runtime_version,''), NULLIF((j.receipt).runtime_version,''),
      (SELECT a.version FROM runtime_activations a WHERE a.runtime_type = j.runtime_type
         AND a.activated_at <= COALESCE(j.last_verified_at, (j.receipt).verified_at, j.updated_at)
       ORDER BY a.activated_at DESC LIMIT 1),
      active_runtime_version(j.runtime_type)),
    j.adapter_version, j.credential_generation, 'legacy', true, 3,
    CASE WHEN j.status = 'verified' THEN 'passed' ELSE 'rejected' END,
    CASE WHEN j.status = 'verified' THEN NULL ELSE 'model' END,
    CASE WHEN j.status = 'verified' THEN 'verified by the capability gate before model checks'
         ELSE left(COALESCE(NULLIF(j.failure_message,''), 'rejected by the capability gate'), 500) END,
    CASE WHEN j.status = 'verified' THEN j.resolved_model ELSE '' END,
    true, 'migration 0099',
    COALESCE(j.last_verified_at, (j.receipt).verified_at, j.updated_at),
    COALESCE(j.last_verified_at, (j.receipt).verified_at, j.updated_at),
    COALESCE(j.last_verified_at, (j.receipt).verified_at, j.updated_at)
  FROM judged j;
  GET DIAGNOSTICS v_legacy = ROW_COUNT;

  FOR v_activation IN
    SELECT DISTINCT ON (a.runtime_type) a.* FROM runtime_activations a
    ORDER BY a.runtime_type, a.activated_at DESC, a.id
  LOOP
    CONTINUE WHEN v_activation.kind <> 'promote' OR v_activation.qualification_id IS NULL
      OR v_activation.version IS DISTINCT FROM active_runtime_version(v_activation.runtime_type);
    v_carried := v_carried || jsonb_build_array(jsonb_build_object('runtime', v_activation.runtime_type,
      'from', v_activation.from_version, 'to', v_activation.version) || carry_model_checks(v_activation.runtime_type,
        v_activation.from_version, v_activation.version, v_activation.qualification_id, v_activation.actor,
        v_activation.activated_at));
  END LOOP;

  UPDATE provider_model_catalog SET status = 'discovered', verified_lease_until = NULL, verification_id = NULL,
    gate_requested_at = COALESCE(gate_requested_at, clock_timestamp()),
    updated_at = clock_timestamp(), version = version + 1
  WHERE status = 'verifying' AND superseded_by IS NULL;

  v_in_step := project_model_statuses(NULL, NULL);
  SELECT COALESCE(jsonb_agg(format('%s %s (%s)', m.runtime_type, m.model_id, model_eligibility(m.id)->>'reason')
      ORDER BY m.runtime_type, m.model_id), '[]'::jsonb)
    INTO v_lost FROM provider_model_catalog m
  WHERE m.id = ANY(v_before) AND m.status <> 'verified';
  RETURN jsonb_build_object(
    'active_versions', (SELECT COALESCE(jsonb_object_agg(runtime_type, version), '{}'::jsonb) FROM runtime_active_versions),
    'legacy_checks', v_legacy, 'carried', v_carried, 'rows_in_step', v_in_step,
    'verified_before', cardinality(v_before),
    'verified_after', (SELECT count(*) FROM provider_model_catalog WHERE status = 'verified' AND superseded_by IS NULL),
    'no_longer_selectable', v_lost);
END $$;
REVOKE EXECUTE ON FUNCTION backfill_model_checks() FROM PUBLIC;

-- The NOTICE is the dry run's answer on a host (this file inside BEGIN …
-- ROLLBACK): the versions taken as active, what was carried, and every model
-- that stops being selectable.
DO $$ BEGIN RAISE NOTICE 'model checks backfill: %', backfill_model_checks(); END $$;
