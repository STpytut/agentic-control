-- Stage 11.1: a project whose runtime is not ready says so before dispatch, and
-- says so again at dispatch, in the transaction that would have created the work.
--
-- The panel could already be told: the root health snapshot writes one bounded
-- row per runtime into `runtime_health`, and `infra_web` may read that table. A
-- rendered page is a statement about the past, though — the operator reads it,
-- thinks, and presses a button some seconds later, and `infra-cod runtime
-- remove` or a revoked credential fits comfortably into those seconds. So the
-- check is repeated here, where the task, its executor rows and its runtime
-- snapshot are written, and a refusal rolls all three back together. Nothing is
-- queued, no workspace lock is taken, and no job is left for a worker to find.
--
-- Where the check goes, and why it is one place
-- ---------------------------------------------
-- `capture_task_runtime_snapshot` is the moment a task's runtimes stop being a
-- project default and become this task's fixed selection. Every creator goes
-- through it — `create_task_with_executors`, `create_followup_task` and the
-- older creator in 0028 — so guarding it guards all of them without three copies
-- of the same rule drifting apart.
--
-- `record_task_chat_message` is deliberately not guarded. It adds a turn to a
-- task whose snapshot was taken and checked when the task was created; refusing
-- there would stop an operator from talking to work that is already running,
-- which is the opposite of useful when a runtime has just gone away.
--
-- What counts as ready here, and what does not
-- -------------------------------------------
-- Two of the four readiness states, and only two: `installed` and
-- `authenticated`. `capability_verified` is the capability gate's answer and it
-- is not implemented yet (11.2/11.4) — `readinessOf()` reports it as `false`
-- because that is honest, and a gate that required it today would refuse every
-- task on every host. When the gate exists, this is where it is added.
--
-- Silence is refusal
-- ------------------
-- No snapshot row, no `runtimes` key in it, a runtime the snapshot does not
-- mention, or a snapshot older than the staleness bound: each of those means
-- this host cannot presently say whether the runtime can run, and "cannot say"
-- is not "yes". The same rule the installer applies to an unanswerable `pgrep`.
--
-- The bound is ten minutes against a timer that fires every minute
-- (`infra-cod-health.timer`: `OnUnitActiveSec=1m`), so it takes about nine
-- consecutive failures to trip — a host that is genuinely not reporting, not one
-- that missed a tick.

SET search_path TO control_plane, public, extensions;

CREATE OR REPLACE FUNCTION runtime_dispatch_staleness()
RETURNS interval LANGUAGE sql IMMUTABLE AS $$
  SELECT interval '10 minutes';
$$;

-- Raises unless every runtime named can run right now, according to the most
-- recent root health snapshot.
--
-- The message names the state, never collapses it: "not provisioned" and "holds
-- no credential" send an operator to two different commands, and one number
-- covering both sends them to the wrong one.
CREATE OR REPLACE FUNCTION assert_runtimes_dispatchable(p_runtimes text[])
RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  v_observed timestamptz;
  v_runtimes jsonb;
  v_age interval;
  v_blocked text;
BEGIN
  IF p_runtimes IS NULL OR cardinality(p_runtimes)=0 THEN RETURN; END IF;

  SELECT h.observed_at, h.snapshot->'runtimes'
  INTO v_observed, v_runtimes
  FROM runtime_health h WHERE h.singleton=true;

  IF v_observed IS NULL OR v_runtimes IS NULL OR jsonb_typeof(v_runtimes)<>'array' THEN
    RAISE EXCEPTION
      'this host has not reported which agent runtimes can run; run `infra-cod doctor` on the server and wait for the next health snapshot'
      USING ERRCODE='55000';
  END IF;

  v_age := clock_timestamp() - v_observed;
  IF v_age > runtime_dispatch_staleness() THEN
    RAISE EXCEPTION
      'the host health snapshot is % old, so runtime readiness cannot be confirmed; check infra-cod-health.timer on the server',
      date_trunc('second', v_age)
      USING ERRCODE='55000';
  END IF;

  SELECT string_agg(reason, '; ' ORDER BY reason) INTO v_blocked
  FROM (
    SELECT CASE
        WHEN r.runtime IS NULL THEN need.runtime||' is not reported by this host'
        WHEN NOT COALESCE(r.installed,false) THEN need.runtime||' is not provisioned'
        ELSE need.runtime||' holds no usable credential'
      END AS reason
    FROM unnest(p_runtimes) AS need(runtime)
    LEFT JOIN jsonb_to_recordset(v_runtimes)
      AS r(runtime text, installed boolean, authenticated boolean)
      ON r.runtime = need.runtime
    WHERE r.runtime IS NULL
       OR NOT COALESCE(r.installed,false)
       OR NOT COALESCE(r.authenticated,false)
  ) AS blocked;

  IF v_blocked IS NOT NULL THEN
    RAISE EXCEPTION 'this task cannot start: %', v_blocked USING ERRCODE='55000';
  END IF;
END $$;

ALTER FUNCTION runtime_dispatch_staleness()
  SET search_path=control_plane,public,extensions,pg_temp;
ALTER FUNCTION assert_runtimes_dispatchable(text[])
  SET search_path=control_plane,public,extensions,pg_temp;

-- Explicit, not inherited. PostgreSQL grants EXECUTE on a new function to
-- PUBLIC, and the `ALTER DEFAULT PRIVILEGES` that 0038 uses to stop that is a
-- property of the database it ran in: the production host turns out not to carry
-- the global one. A migration that depends on it is a migration that behaves
-- differently on the host it is for.
--
-- Both are reached only from inside `capture_task_runtime_snapshot`, which is
-- SECURITY DEFINER and therefore runs them as its owner. `infra_worker` is
-- granted anyway, because it is the role that would call a creator directly.
REVOKE EXECUTE ON FUNCTION runtime_dispatch_staleness() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION assert_runtimes_dispatchable(text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION runtime_dispatch_staleness() TO infra_worker;
GRANT EXECUTE ON FUNCTION assert_runtimes_dispatchable(text[]) TO infra_worker;

-- Unchanged from 0036 except for the two lines before the INSERT.
--
-- Copied in full because plpgsql has no way to wrap a body, and re-declared
-- SECURITY DEFINER with its search_path re-pinned below: CREATE OR REPLACE keeps
-- the owner and the ACL but not the other properties, so a replacement that
-- named neither would quietly drop both — and dropping the pinned search_path on
-- a SECURITY DEFINER function is the vulnerability 0038 pinned it against.
CREATE OR REPLACE FUNCTION capture_task_runtime_snapshot(
  p_task_id uuid, p_project_id uuid, p_executor_assignment_ids uuid[]
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_defaults project_runtime_defaults%ROWTYPE;
  v_task tasks%ROWTYPE;
  v_orchestrator jsonb;
  v_executors jsonb := '[]'::jsonb;
  v_entry_id uuid;
  v_assignment_id uuid;
  v_captured jsonb;
  v_required text[];
BEGIN
  SELECT * INTO v_task FROM tasks
  WHERE id=p_task_id AND project_id=p_project_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'task is unavailable' USING ERRCODE='55000';
  END IF;
  IF EXISTS (SELECT 1 FROM task_runtime_snapshots WHERE task_id=p_task_id) THEN
    RETURN jsonb_build_object('task_id',p_task_id,'status','already_captured');
  END IF;

  SELECT * INTO v_defaults FROM project_runtime_defaults
  WHERE project_id=p_project_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('task_id',p_task_id,'status','skipped_no_defaults');
  END IF;

  v_orchestrator := resolve_catalog_snapshot_entry(
    v_defaults.orchestrator_entry_id,
    v_defaults.reasoning_effort,
    v_defaults.service_tier
  );

  IF p_executor_assignment_ids IS NOT NULL AND EXISTS (
    SELECT 1
    FROM unnest(p_executor_assignment_ids) requested(id)
    WHERE NOT EXISTS (
      SELECT 1 FROM project_agent_assignments pa
      WHERE pa.id=requested.id AND pa.project_id=p_project_id
        AND pa.enabled AND pa.assignment_role='executor'
    )
  ) THEN
    RAISE EXCEPTION 'task executor assignment is unavailable' USING ERRCODE='55000';
  END IF;

  FOR v_entry_id, v_assignment_id IN
    WITH all_assignments AS (
      SELECT pa.id,
        row_number() OVER (ORDER BY pa.created_at,pa.id) AS ordinal
      FROM project_agent_assignments pa
      WHERE pa.project_id=p_project_id
        AND pa.enabled
        AND pa.assignment_role='executor'
    ), selected_assignments AS (
      SELECT requested.id AS assignment_id,aa.ordinal,
        requested.ordinality * 100 AS priority
      FROM unnest(p_executor_assignment_ids) WITH ORDINALITY requested(id,ordinality)
      JOIN all_assignments aa ON aa.id=requested.id
    ), effective_assignments AS (
      SELECT s.assignment_id,s.ordinal,s.priority
      FROM selected_assignments s
      UNION ALL
      SELECT aa.id,aa.ordinal,aa.ordinal * 100
      FROM all_assignments aa
      WHERE p_executor_assignment_ids IS NULL
    ), defaults AS (
      SELECT d.catalog_entry_id,
        row_number() OVER (ORDER BY d.priority,d.catalog_entry_id) AS ordinal
      FROM project_runtime_default_executors d
      WHERE d.project_id=p_project_id
    )
    SELECT d.catalog_entry_id,e.assignment_id
    FROM defaults d
    LEFT JOIN effective_assignments e ON e.ordinal=d.ordinal
    WHERE e.assignment_id IS NOT NULL
       OR NOT EXISTS (SELECT 1 FROM all_assignments)
    ORDER BY d.ordinal,e.priority NULLS LAST
  LOOP
    v_executors := v_executors || jsonb_build_array(
      resolve_catalog_snapshot_entry(v_entry_id) || jsonb_build_object(
        'assignment_ids',CASE WHEN v_assignment_id IS NULL
          THEN '[]'::jsonb ELSE jsonb_build_array(v_assignment_id::text) END
      )
    );
  END LOOP;

  -- The runtimes this task has just been bound to, asked of the host before the
  -- binding is written. Read from the snapshot being captured rather than from
  -- the project's defaults, so what is checked is what will actually be launched.
  SELECT array_agg(DISTINCT runtime_type) INTO v_required
  FROM (
    SELECT v_orchestrator->>'runtime_type' AS runtime_type
    UNION ALL
    SELECT executor->>'runtime_type' FROM jsonb_array_elements(v_executors) AS executor
  ) AS required
  WHERE runtime_type IS NOT NULL AND runtime_type<>'';

  PERFORM assert_runtimes_dispatchable(v_required);

  INSERT INTO task_runtime_snapshots(
    task_id,orchestrator,executors,source,captured_from_defaults_version
  )
  VALUES(p_task_id,v_orchestrator,v_executors,'catalog',v_defaults.version)
  RETURNING jsonb_build_object(
    'task_id',task_id,'orchestrator',orchestrator,'executors',executors,
    'source',source,'captured_from_defaults_version',captured_from_defaults_version
  ) INTO v_captured;
  RETURN v_captured;
END; $$;

ALTER FUNCTION capture_task_runtime_snapshot(uuid,uuid,uuid[])
  SET search_path=control_plane,public,extensions,pg_temp;

-- 0048 took this function away from `infra_web`, and CREATE OR REPLACE keeps an
-- ACL — but asserting it is cheaper than trusting it, and the assertion is what
-- fails the migration rather than the next audit.
DO $assert$
BEGIN
  IF has_function_privilege('infra_web',
       'control_plane.capture_task_runtime_snapshot(uuid,uuid,uuid[])'::regprocedure,'EXECUTE') THEN
    RAISE EXCEPTION 'infra_web can execute capture_task_runtime_snapshot' USING ERRCODE='42501';
  END IF;
  -- The new functions are reached only from inside SECURITY DEFINER callers. The
  -- web tier reads `runtime_health` directly for what it renders, so it needs
  -- neither of them, and the global default revoke keeps PUBLIC out.
  IF has_function_privilege('infra_web',
       'control_plane.assert_runtimes_dispatchable(text[])'::regprocedure,'EXECUTE') THEN
    RAISE EXCEPTION 'infra_web can execute assert_runtimes_dispatchable' USING ERRCODE='42501';
  END IF;
END $assert$;
