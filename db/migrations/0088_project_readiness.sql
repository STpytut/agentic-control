-- Project readiness, read where the operator acts (Stage 11.5, sprint C U1;
-- exit criterion 6, the panel half).
--
-- Since 0054 the database refuses to create a task whose runtime the host does
-- not report ready, and since 0072 and 0084 a launch asks the host's report and
-- the model's connection again. The panel has shown only the host half of that
-- — one warning banner built from `runtime_health` in TypeScript — and nothing
-- about the model or the connection the project's assignments would run on. So
-- an operator whose connection had expired learned it from a dead letter after
-- the task existed, and a project whose orchestrator was signed out looked the
-- same as one that was not.
--
-- What is added: one reading of the four prerequisites of an assignment, and
-- one function that gives it to the panel for every enabled assignment of a
-- project. The four questions are answered separately, because they are fixed
-- by different commands:
--
--   runtime installed      the host's last report (`runtime_health`), the same
--   runtime authenticated  reading `runtime_undispatchable_reason` makes at a
--                          launch, with its rule for a stale or silent report:
--                          "unknown", which task creation refuses (0054) and a
--                          launch leaves to the launch;
--   model verified         the project's default catalog entry for the
--                          assignment has status `verified`;
--   connection connected   the rule of `revoked_model_access` (0084): the row
--                          is present, `connected`, and the operator has not
--                          asked the broker to disconnect it.
--
-- Shared, not copied. `runtime_undispatchable_reason` and `revoked_model_access`
-- are redefined over two primitives, `runtime_health_reading` and
-- `connection_revoked`, and the readiness reading is built on the same two, so
-- the panel and dispatch read one condition. The primitives keep the share
-- locks the launch relies on (0072, 0084): a readiness read taken in a
-- transaction is ordered against a removal or a revocation the same way a
-- launch is.
--
-- The send path repeats the check. `capture_task_runtime_snapshot` — every
-- creator's one gate (0054) — asks each prerequisite by name before it resolves
-- the entries, so a refusal carries the reason the panel showed instead of the
-- collapsed `catalog_entry_unavailable`. `record_task_chat_message` asks the
-- same of the task's orchestrator before it starts a turn; the reply to an open
-- input request is not a turn and is not asked. 0054 left the chat path alone
-- so an operator could keep talking to work that was running; that work now
-- ends as a dead letter with the same reason at its next turn (0072, 0084), so
-- a refusal up front, with the fix in the sentence, is the kinder answer.
--
-- Two reasons are new: `runtime_readiness_unknown`, the "cannot say" that 0054
-- refused with a bare sentence, and `model_not_verified`. The others already
-- exist. Each carries the operator action in the readiness reading.

SET search_path TO control_plane, public, extensions;

INSERT INTO failure_reasons(reason, code, note) VALUES
  ('runtime_readiness_unknown','unavailable','the host has not reported whether this runtime can run, or its last report is too old to be evidence'),
  ('model_not_verified','unavailable','the model this assignment would run has not passed verification')
ON CONFLICT (reason) DO UPDATE SET code=EXCLUDED.code, note=EXCLUDED.note;

-- --------------------------------------------------------- the primitives --

-- The host's last word on one runtime, read under the share lock a launch
-- takes (0072). `known` is false when there is nothing to go on: no report, a
-- report older than runtime_dispatch_staleness(), a runtime the report does
-- not mention or could not read. The booleans are meaningful only when it is
-- true. SECURITY DEFINER for the lock, which asks for more than a SELECT.
CREATE FUNCTION runtime_health_reading(p_runtime text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_observed timestamptz; v_runtimes jsonb; v_entry jsonb;
BEGIN
  SELECT h.observed_at, h.snapshot->'runtimes' INTO v_observed, v_runtimes
  FROM runtime_health h WHERE h.singleton FOR SHARE;
  IF p_runtime IS NULL OR v_observed IS NULL OR jsonb_typeof(v_runtimes) IS DISTINCT FROM 'array'
     OR clock_timestamp()-v_observed > runtime_dispatch_staleness() THEN
    RETURN jsonb_build_object('runtime',p_runtime,'known',false,'observed_at',v_observed,
      'installed',NULL,'authenticated',NULL,'version',NULL);
  END IF;
  SELECT e INTO v_entry FROM jsonb_array_elements(v_runtimes) e WHERE e->>'runtime'=p_runtime LIMIT 1;
  IF v_entry IS NULL OR v_entry ? 'unreadable' THEN
    RETURN jsonb_build_object('runtime',p_runtime,'known',false,'observed_at',v_observed,
      'installed',NULL,'authenticated',NULL,'version',NULL);
  END IF;
  RETURN jsonb_build_object('runtime',p_runtime,'known',true,'observed_at',v_observed,
    'installed',(v_entry->>'installed')='true',
    'authenticated',(v_entry->>'authenticated')='true',
    'version',v_entry->>'version');
END $$;

ALTER FUNCTION runtime_health_reading(text) SET search_path=control_plane,public,extensions,pg_temp;
REVOKE EXECUTE ON FUNCTION runtime_health_reading(text) FROM PUBLIC;

-- 0072's function, its body now the reading above. Same answers: NULL when the
-- host cannot say, otherwise the first of the two states that fails.
CREATE OR REPLACE FUNCTION runtime_undispatchable_reason(p_runtime text)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_reading jsonb;
BEGIN
  v_reading:=runtime_health_reading(p_runtime);
  IF NOT (v_reading->>'known')::boolean THEN RETURN NULL; END IF;
  IF NOT (v_reading->>'installed')::boolean THEN RETURN 'runtime_not_provisioned'; END IF;
  IF NOT (v_reading->>'authenticated')::boolean THEN RETURN 'runtime_not_authenticated'; END IF;
  RETURN NULL;
END $$;

-- Whether a connection is revoked, by 0084's rule, read under the share lock
-- every revocation's UPDATE conflicts with. A connection nobody names is not
-- revoked; a row that is gone is.
CREATE FUNCTION connection_revoked(p_connection uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_status text; v_action text;
BEGIN
  IF p_connection IS NULL THEN RETURN false; END IF;
  SELECT c.status, c.broker_requested_action INTO v_status, v_action
  FROM provider_connections c WHERE c.id=p_connection FOR SHARE;
  IF NOT FOUND THEN RETURN true; END IF;
  IF v_status<>'connected' THEN RETURN true; END IF;
  IF v_action='disconnect' THEN RETURN true; END IF;
  RETURN false;
END $$;

ALTER FUNCTION connection_revoked(uuid) SET search_path=control_plane,public,extensions,pg_temp;
REVOKE EXECUTE ON FUNCTION connection_revoked(uuid) FROM PUBLIC;

-- 0084's function, its rule now the primitive above.
CREATE OR REPLACE FUNCTION revoked_model_access(p_job runtime_jobs)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_connection uuid;
BEGIN
  v_connection:=job_model_connection(p_job);
  IF v_connection IS NULL THEN RETURN NULL; END IF;
  IF connection_revoked(v_connection) THEN RETURN v_connection; END IF;
  RETURN NULL;
END $$;

-- ------------------------------------------------------------ the reading --

-- What an operator does about a reason. The sentence names the command or the
-- screen, because a state without its fix is a state nobody can act on.
CREATE FUNCTION readiness_action(p_reason text, p_runtime text)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE p_reason
    WHEN 'runtime_readiness_unknown' THEN 'wait for the next health snapshot, or run `infra-cod doctor` on the server'
    WHEN 'runtime_not_provisioned' THEN format('install the runtime: `infra-cod runtime install %s --version <exact>` on the server', p_runtime)
    WHEN 'runtime_not_authenticated' THEN format('sign the runtime in: connect its account in Settings, or `infra-cod runtime login %s` on the server', p_runtime)
    WHEN 'model_not_verified' THEN 'verify the model in Settings, or choose a verified model in the project settings'
    WHEN 'model_access_revoked' THEN 'reconnect the connection this model is reached through, in Settings'
    ELSE NULL END;
$$;

REVOKE EXECUTE ON FUNCTION readiness_action(text,text) FROM PUBLIC;

-- The four prerequisites of one selection: a runtime and the catalog entry it
-- would run. Each state is `ready`, `missing` or `unknown`; `blocked_by` names
-- the first missing one in the order an operator fixes them, with its reason
-- from the vocabulary, a sentence, and the action. The connection comes before
-- the model in that order: a connection that expires takes its entries to
-- `unavailable` with it (the trigger of 0027), so the first fix is to
-- reconnect, and that is the reason a launch of the same selection gives
-- (`model_access_revoked`); an entry the gate rejected under a live connection
-- is the model's own state.
--
-- The runtime defaults to the entry's when the caller has none (a snapshot
-- being captured); a caller that knows which assignment will launch passes its
-- profile's runtime, which is what record_runtime_dispatch compares against.
-- No entry (a project without catalog defaults, a task with a backfilled
-- snapshot) leaves the model and connection unknown and blocks nothing, as
-- task creation and a launch ask nothing of such a selection either; the
-- runtime states are still reported.
CREATE FUNCTION dispatch_prerequisites(p_runtime text, p_entry_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_entry provider_model_catalog%ROWTYPE;
  v_runtime text; v_health jsonb;
  v_installed text; v_authenticated text; v_verified text; v_connected text;
  v_prerequisite text; v_reason text; v_message text; v_blocked jsonb;
BEGIN
  IF p_entry_id IS NOT NULL THEN
    SELECT * INTO v_entry FROM provider_model_catalog m WHERE m.id=p_entry_id;
  END IF;
  v_runtime:=COALESCE(p_runtime, v_entry.runtime_type);
  v_health:=runtime_health_reading(v_runtime);

  IF NOT (v_health->>'known')::boolean THEN
    v_installed:='unknown'; v_authenticated:='unknown';
  ELSE
    v_installed:=CASE WHEN (v_health->>'installed')::boolean THEN 'ready' ELSE 'missing' END;
    v_authenticated:=CASE WHEN (v_health->>'authenticated')::boolean THEN 'ready' ELSE 'missing' END;
  END IF;

  IF p_entry_id IS NULL THEN
    v_verified:='unknown'; v_connected:='unknown';
  ELSIF v_entry.id IS NULL THEN
    -- A default that names an entry the catalog no longer has.
    v_verified:='missing'; v_connected:='missing';
  ELSE
    v_verified:=CASE WHEN v_entry.status='verified' THEN 'ready' ELSE 'missing' END;
    v_connected:=CASE WHEN connection_revoked(v_entry.connection_id) THEN 'missing' ELSE 'ready' END;
  END IF;

  -- A selection without an entry is reported, not refused: task creation skips
  -- a project without catalog defaults (0054), and a launch asks nothing of a
  -- task whose snapshot names no connection (0084). The states are still on
  -- the row for the panel to show.
  IF p_entry_id IS NULL THEN
    NULL;
  ELSIF v_installed='unknown' THEN
    v_prerequisite:='runtime_installed'; v_reason:='runtime_readiness_unknown';
    v_message:=format('this host has not reported whether %s can run', COALESCE(v_runtime,'the runtime'));
  ELSIF v_installed='missing' THEN
    v_prerequisite:='runtime_installed'; v_reason:='runtime_not_provisioned';
    v_message:=format('%s is not installed on this host', v_runtime);
  ELSIF v_authenticated='missing' THEN
    v_prerequisite:='runtime_authenticated'; v_reason:='runtime_not_authenticated';
    v_message:=format('%s holds no usable credential', v_runtime);
  ELSIF v_connected='missing' THEN
    v_prerequisite:='connection_connected'; v_reason:='model_access_revoked';
    v_message:=format('the connection model %s is reached through is not connected', COALESCE(NULLIF(v_entry.model_id,''), p_entry_id::text));
  ELSIF v_verified='missing' THEN
    v_prerequisite:='model_verified'; v_reason:='model_not_verified';
    v_message:=format('model %s is not verified', COALESCE(NULLIF(v_entry.model_id,''), p_entry_id::text));
  END IF;
  IF v_reason IS NOT NULL THEN
    v_blocked:=jsonb_build_object('prerequisite',v_prerequisite,'reason',v_reason,'message',v_message,
      'action',readiness_action(v_reason, v_runtime),
      'note',(SELECT note FROM failure_reasons WHERE reason=v_reason));
  END IF;

  RETURN jsonb_build_object(
    'runtime',v_runtime,'runtime_version',v_health->>'version','observed_at',v_health->'observed_at',
    'entry_id',p_entry_id,'model_id',v_entry.model_id,'display_name',v_entry.display_name,
    'provider_id',v_entry.provider_id,'connection_id',v_entry.connection_id,
    'runtime_installed',v_installed,'runtime_authenticated',v_authenticated,
    'model_verified',v_verified,'connection_connected',v_connected,
    'ready',v_blocked IS NULL,'blocked_by',v_blocked);
END $$;

ALTER FUNCTION dispatch_prerequisites(text,uuid) SET search_path=control_plane,public,extensions,pg_temp;
REVOKE EXECUTE ON FUNCTION dispatch_prerequisites(text,uuid) FROM PUBLIC;

-- The refusal: the reading's first missing prerequisite, raised through
-- refuse() so the reason the panel showed is the reason the caller gets.
CREATE FUNCTION assert_dispatch_prerequisites(p_runtime text, p_entry_id uuid, p_role text)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE v_reading jsonb; v_blocked jsonb;
BEGIN
  v_reading:=dispatch_prerequisites(p_runtime, p_entry_id);
  v_blocked:=v_reading->'blocked_by';
  IF jsonb_typeof(v_blocked)='object' THEN
    PERFORM refuse(v_blocked->>'reason',
      format('the %s cannot start: %s — %s', p_role, v_blocked->>'message', v_blocked->>'action'));
  END IF;
END $$;

ALTER FUNCTION assert_dispatch_prerequisites(text,uuid,text) SET search_path=control_plane,public,extensions,pg_temp;
REVOKE EXECUTE ON FUNCTION assert_dispatch_prerequisites(text,uuid,text) FROM PUBLIC;

-- ------------------------------------------------------------- the panel --

-- Every enabled assignment of the project with its four states. The owner is
-- checked here, because the function is SECURITY DEFINER and reads
-- provider_connections, which infra_web may not. The entry an assignment would
-- run is found as capture_task_runtime_snapshot finds it: the orchestrator's is
-- the project's default, the executors' are the default executors matched by
-- position (0028). `ready` is whether every conversation holder is ready, which
-- is what the composer needs to know; an executor's state is on its own row.
CREATE FUNCTION project_readiness(p_project_id uuid, p_owner_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_defaults project_runtime_defaults%ROWTYPE; v_observed timestamptz; v_assignments jsonb;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM projects p WHERE p.id=p_project_id AND p.owner_id=p_owner_id) THEN
    PERFORM refuse('project_unavailable','project is unavailable');
  END IF;
  SELECT * INTO v_defaults FROM project_runtime_defaults d WHERE d.project_id=p_project_id;
  SELECT h.observed_at INTO v_observed FROM runtime_health h WHERE h.singleton;

  WITH executors AS (
    SELECT pa.id, row_number() OVER (ORDER BY pa.created_at,pa.id) AS ordinal
    FROM project_agent_assignments pa
    WHERE pa.project_id=p_project_id AND pa.enabled
      AND role_holds(pa.role_definition_id,'implementation.execute')
  ), defaults AS (
    SELECT d.catalog_entry_id, row_number() OVER (ORDER BY d.priority,d.catalog_entry_id) AS ordinal
    FROM project_runtime_default_executors d WHERE d.project_id=p_project_id
  ), assignment AS (
    SELECT pa.id AS assignment_id, pa.agent_id, a.name AS agent_name, pa.is_default, pa.created_at,
      rp.runtime_type,
      role_holds(pa.role_definition_id,'conversation.hold') AS holds_conversation,
      role_holds(pa.role_definition_id,'implementation.execute') AS executes,
      CASE
        WHEN role_holds(pa.role_definition_id,'conversation.hold') THEN v_defaults.orchestrator_entry_id
        ELSE (SELECT d.catalog_entry_id FROM defaults d JOIN executors e ON e.ordinal=d.ordinal WHERE e.id=pa.id)
      END AS entry_id
    FROM project_agent_assignments pa
    JOIN agents a ON a.id=pa.agent_id AND a.enabled
    JOIN runtime_profiles rp ON rp.id=pa.runtime_profile_id AND rp.enabled
    WHERE pa.project_id=p_project_id AND pa.enabled
  )
  SELECT jsonb_agg(
    dispatch_prerequisites(s.runtime_type, s.entry_id) || jsonb_build_object(
      'assignment_id',s.assignment_id,'agent_id',s.agent_id,'agent_name',s.agent_name,
      'role',CASE WHEN s.holds_conversation THEN 'orchestrator' WHEN s.executes THEN 'executor' ELSE 'other' END,
      'is_default',s.is_default)
    ORDER BY s.holds_conversation DESC, s.is_default DESC, s.created_at, s.assignment_id)
  INTO v_assignments FROM assignment s;

  RETURN jsonb_build_object(
    'project_id',p_project_id,'observed_at',v_observed,
    'has_defaults',v_defaults.project_id IS NOT NULL,
    'ready',COALESCE((SELECT bool_and((item->>'ready')::boolean)
                      FROM jsonb_array_elements(COALESCE(v_assignments,'[]'::jsonb)) item
                      WHERE item->>'role'='orchestrator'), true),
    'assignments',COALESCE(v_assignments,'[]'::jsonb));
END $$;

ALTER FUNCTION project_readiness(uuid,uuid) SET search_path=control_plane,public,extensions,pg_temp;
REVOKE EXECUTE ON FUNCTION project_readiness(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION project_readiness(uuid,uuid) TO infra_web;

-- --------------------------------------------------------- the send path --

-- 0080's definition with the prerequisites asked by name before each entry is
-- resolved. resolve_catalog_snapshot_entry's own refusal stays behind it as the
-- backstop it was; assert_runtimes_dispatchable stays where it was, now
-- reached only by a snapshot whose entries name no runtime. The runtime asked
-- about is the assignment's profile where the task has one — what the launch
-- will compare against — and the entry's otherwise.
CREATE OR REPLACE FUNCTION capture_task_runtime_snapshot(p_task_id uuid, p_project_id uuid, p_executor_assignment_ids uuid[])
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'control_plane', 'public', 'extensions', 'pg_temp'
AS $function$
DECLARE
  v_defaults project_runtime_defaults%ROWTYPE;
  v_task tasks%ROWTYPE;
  v_orchestrator jsonb;
  v_executors jsonb := '[]'::jsonb;
  v_entry_id uuid;
  v_assignment_id uuid;
  v_captured jsonb;
  v_required text[];
  v_runtime text;
BEGIN
  SELECT * INTO v_task FROM tasks
  WHERE id=p_task_id AND project_id=p_project_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'task is unavailable' USING ERRCODE='55000', DETAIL=jsonb_build_object('reason','task_unavailable')::text;
  END IF;
  IF EXISTS (SELECT 1 FROM task_runtime_snapshots WHERE task_id=p_task_id) THEN
    RETURN jsonb_build_object('task_id',p_task_id,'status','already_captured');
  END IF;

  SELECT * INTO v_defaults FROM project_runtime_defaults
  WHERE project_id=p_project_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('task_id',p_task_id,'status','skipped_no_defaults');
  END IF;

  -- U1 (0088): each prerequisite of the orchestrator by name, the reading the
  -- panel showed, before the entry is resolved.
  SELECT rp.runtime_type INTO v_runtime
  FROM project_agent_assignments pa JOIN runtime_profiles rp ON rp.id=pa.runtime_profile_id
  WHERE pa.id=v_task.orchestrator_assignment_id;
  PERFORM assert_dispatch_prerequisites(v_runtime, v_defaults.orchestrator_entry_id, 'orchestrator');

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
        AND pa.enabled AND role_holds(pa.role_definition_id,'implementation.execute')
    )
  ) THEN
    RAISE EXCEPTION 'task executor assignment is unavailable' USING ERRCODE='55000', DETAIL=jsonb_build_object('reason','executor_unavailable')::text;
  END IF;

  FOR v_entry_id, v_assignment_id IN
    WITH all_assignments AS (
      SELECT pa.id,
        row_number() OVER (ORDER BY pa.created_at,pa.id) AS ordinal
      FROM project_agent_assignments pa
      WHERE pa.project_id=p_project_id
        AND pa.enabled
        AND role_holds(pa.role_definition_id,'implementation.execute')
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
    -- U1 (0088): the same four questions of each executor that will be bound.
    SELECT rp.runtime_type INTO v_runtime
    FROM project_agent_assignments pa JOIN runtime_profiles rp ON rp.id=pa.runtime_profile_id
    WHERE pa.id=v_assignment_id;
    PERFORM assert_dispatch_prerequisites(v_runtime, v_entry_id, 'executor');
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
END; $function$;

-- 0061's definition with the turn's orchestrator asked before the turn is
-- started. The reply to an open input request goes to the implementation that
-- asked, not to the orchestrator, and is left as it was. The task's
-- orchestrator is what a turn's launch would compare against: the assignment's
-- profile runtime, and the entry its catalog snapshot recorded.
CREATE OR REPLACE FUNCTION record_task_chat_message(p_project_id uuid, p_task_id uuid, p_message text, p_actor text, p_correlation text DEFAULT ''::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'control_plane', 'public', 'extensions', 'pg_temp'
AS $function$
DECLARE v_task tasks%ROWTYPE; v_open worker_interaction_reports%ROWTYPE; v_runtime text; v_entry uuid;
BEGIN
  -- 0061: a message typed into the chat while the implementation is waiting for
  -- an answer is that answer. Before, it became an orchestrator turn: Codex was
  -- asked, and the run that had asked stayed blocked on a question nobody had
  -- routed to it. The dedicated reply action already resolved the report
  -- correctly; the chat composer, open at the same moment, did not.
  SELECT * INTO v_open FROM worker_interaction_reports r
  WHERE r.project_id=p_project_id AND r.task_id=p_task_id
    AND r.report_type='input_request' AND r.status='finalized' AND r.resolved_at IS NULL
  ORDER BY r.finalized_at DESC NULLS LAST, r.id DESC LIMIT 1;
  IF FOUND THEN
    RETURN jsonb_build_object('project_id',p_project_id,'task_id',p_task_id,
      'status','answered_input_request','report_id',v_open.id,'run_id',v_open.run_id,
      'resolution',resolve_worker_interaction(v_open.id,p_actor,
        jsonb_build_object('response',p_message),p_correlation));
  END IF;

  -- U1 (0088): the turn this message starts runs on the task's orchestrator;
  -- its prerequisites are asked by name before the turn exists. A closed task
  -- is not asked — it answers NULL below, as before.
  SELECT rp.runtime_type, NULLIF(s.orchestrator->>'entry_id','')::uuid INTO v_runtime, v_entry
  FROM tasks t
  JOIN project_agent_assignments pa ON pa.id=t.orchestrator_assignment_id
  JOIN runtime_profiles rp ON rp.id=pa.runtime_profile_id
  LEFT JOIN task_runtime_snapshots s ON s.task_id=t.id AND s.source='catalog'
  WHERE t.id=p_task_id AND t.project_id=p_project_id
    AND t.status NOT IN ('approved','deployed','completed','cancelled','failed');
  IF FOUND THEN
    PERFORM assert_dispatch_prerequisites(v_runtime, v_entry, 'orchestrator');
  END IF;

  UPDATE tasks SET version=version+1, updated_at=clock_timestamp()
  WHERE id=p_task_id AND project_id=p_project_id
    AND status NOT IN ('approved','deployed','completed','cancelled','failed')
  RETURNING * INTO v_task;

  IF NOT FOUND THEN RETURN NULL; END IF;

  PERFORM append_event('chat.user_message',v_task.project_id,v_task.id,NULL,'user',p_actor,
    NULL,p_correlation,'chat-message:'||v_task.id||':'||v_task.version,'task',v_task.id,
    v_task.version, jsonb_build_object('content',p_message));

  RETURN jsonb_build_object('project_id',v_task.project_id,'task_id',v_task.id,
                            'status',v_task.status,'version',v_task.version);
END $function$;

-- The redefined functions keep their ACLs (CREATE OR REPLACE does). The new
-- helpers are reached only from inside SECURITY DEFINER callers and are granted
-- to nobody; the one web function is on the allowlist db/tests/0026 pins, and
-- db/tests/0054 proves what it answers.
