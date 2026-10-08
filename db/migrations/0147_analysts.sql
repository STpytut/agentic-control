-- Analysts: a read-only member the orchestrator asks (Stage 12, rc.135).
--
-- The owner's order for the agent team (docs/STAGE_12_ANALYST.md): an analyst
-- first — a member with its own model and instructions that reads the project
-- and answers the orchestrator's question, beside the coder. A tester agent is
-- deferred: the platform's own project check (0143) runs the tests.
--
-- * `analyst` is a role the registry gives a runtime (runtime_roles), with its
--   core of capabilities (runtime_role_core), mirrored from capabilities.mjs
--   ROLE_CORE as 0074 did. Claude Code and OpenCode play it.
-- * An analyst is a member of the project's team, kept apart from the
--   orchestrator's and executors' assignments (project_analysts): it holds no
--   task's conversation, takes no handoff and enters no task's snapshot, so
--   nothing that decides those reads it.
-- * `platform.consult` on an orchestrator's turn asks one analyst one question
--   (invoke_consult). The question is a consultation; `consultation.requested`
--   becomes a `consultation_run` job; the supervisor runs the analyst read-only
--   on a snapshot of the last commit and hands back its answer
--   (finish_consultation); `consultation.answered` becomes a
--   `resume_orchestrator` turn whose message is the answer.
-- * A consultation turn is not a review: claim_orchestrator_jobs moves a task
--   to `reviewing` only for an implementation's completion.

SET search_path TO control_plane, public, extensions;

INSERT INTO failure_reasons(reason, code, note) VALUES
  ('analyst_unavailable','not_found','no enabled analyst of this project answers to that name'),
  ('analyst_invalid','invalid_argument','an analyst needs a name of 1 to 60 characters and instructions of at most 4000'),
  ('analyst_limit','conflict','a project has at most four analysts'),
  ('consultation_arguments_invalid','invalid_argument','a consultation needs a question of 10 to 8000 characters'),
  ('consultation_limit','conflict','this task has three consultations waiting for an answer; wait for one'),
  ('consultation_not_held','lease_lost','this worker does not hold the consultation''s job')
ON CONFLICT (reason) DO NOTHING;

-- ------------------------------------------------------------ the role

ALTER TABLE runtime_role_core DROP CONSTRAINT runtime_role_core_role_check;
ALTER TABLE runtime_role_core ADD CONSTRAINT runtime_role_core_role_check CHECK (role IN ('orchestrator','executor','analyst'));
ALTER TABLE runtime_roles DROP CONSTRAINT runtime_roles_role_check;
ALTER TABLE runtime_roles ADD CONSTRAINT runtime_roles_role_check CHECK (role IN ('orchestrator','executor','analyst'));

-- capabilities.mjs ROLE_CORE.analyst
INSERT INTO runtime_role_core(role, capability) VALUES
  ('analyst','run.read_only'),('analyst','stream.structured'),('analyst','interrupt')
ON CONFLICT DO NOTHING;
-- runtime-adapters.mjs roles
INSERT INTO runtime_roles(runtime_type, role) VALUES ('claude','analyst'),('opencode','analyst')
ON CONFLICT DO NOTHING;

-- ------------------------------------------------------------ members

CREATE TABLE project_analysts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 60 AND name !~ '[[:cntrl:]]'),
  instructions text NOT NULL DEFAULT '' CHECK (char_length(instructions) <= 4000),
  catalog_entry_id uuid NOT NULL REFERENCES provider_model_catalog(id),
  runtime_type text NOT NULL,
  reasoning_effort text NOT NULL DEFAULT '',
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
-- A name says who is asked: unique among a project's enabled analysts.
CREATE UNIQUE INDEX project_analysts_name ON project_analysts(project_id, lower(name)) WHERE enabled;

CREATE TABLE consultations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  task_id uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  analyst_id uuid NOT NULL REFERENCES project_analysts(id) ON DELETE CASCADE,
  question text NOT NULL CHECK (char_length(question) BETWEEN 10 AND 8000),
  status text NOT NULL DEFAULT 'requested' CHECK (status IN ('requested','answered','failed')),
  answer text CHECK (answer IS NULL OR char_length(answer) <= 32000),
  failure text CHECK (failure IS NULL OR char_length(failure) <= 500),
  -- The orchestrator's turn and call that asked: the same call asks once.
  requested_by_job bigint NOT NULL,
  call_id text NOT NULL,
  -- What answered: the model as the run reported it, and the snapshot's commit.
  model text,
  snapshot_sha text,
  requested_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  finished_at timestamptz,
  UNIQUE (requested_by_job, call_id),
  CHECK ((status='requested') = (finished_at IS NULL)),
  CHECK (status<>'answered' OR answer IS NOT NULL)
);
CREATE INDEX consultations_task ON consultations(task_id, requested_at);

ALTER TABLE runtime_jobs DROP CONSTRAINT runtime_jobs_job_type_check;
ALTER TABLE runtime_jobs ADD CONSTRAINT runtime_jobs_job_type_check CHECK (job_type IN (
  'implementation_run','resume_orchestrator','orchestrator_turn','consultation_run'));

-- ------------------------------------------------------------ the team

-- The project's analysts, for the Team page.
CREATE FUNCTION project_analyst_list(p_project_id uuid, p_owner_id uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO control_plane, public, extensions, pg_temp
AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object('id',a.id,'name',a.name,'instructions',a.instructions,
      'runtime_type',a.runtime_type,'entry_id',a.catalog_entry_id,'model_id',m.model_id,'display_name',m.display_name,
      'provider_id',m.provider_id,'model_status',m.status,'reasoning_effort',NULLIF(a.reasoning_effort,''))
    ORDER BY a.created_at), '[]'::jsonb)
  FROM project_analysts a JOIN projects p ON p.id=a.project_id
  LEFT JOIN provider_model_catalog m ON m.id=a.catalog_entry_id
  WHERE a.project_id=p_project_id AND p.owner_id=p_owner_id AND a.enabled;
$$;

CREATE FUNCTION add_project_analyst(p_project_id uuid, p_owner_id uuid, p_expected_version bigint,
  p_entry_id uuid, p_name text, p_instructions text, p_actor text, p_correlation_id text, p_reasoning_effort text DEFAULT '')
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO control_plane, public, extensions, pg_temp
AS $$
DECLARE v_entry jsonb; v_runtime text; v_level text; v_id uuid; v_version bigint;
  v_name text := btrim(COALESCE(p_name,'')); v_instructions text := btrim(COALESCE(p_instructions,''));
BEGIN
  PERFORM lock_project_team(p_project_id, p_owner_id, p_expected_version);
  IF char_length(v_name) NOT BETWEEN 1 AND 60 OR v_name ~ '[[:cntrl:]]' OR char_length(v_instructions) > 4000 THEN
    PERFORM refuse('analyst_invalid', 'an analyst needs a name of 1 to 60 characters and instructions of at most 4000', '22023');
  END IF;
  IF (SELECT count(*) FROM project_analysts WHERE project_id=p_project_id AND enabled) >= 4 THEN
    PERFORM refuse('analyst_limit', 'a project has at most four analysts');
  END IF;
  IF EXISTS (SELECT 1 FROM project_analysts WHERE project_id=p_project_id AND enabled AND lower(name)=lower(v_name)) THEN
    PERFORM refuse('analyst_invalid', format('an analyst of this project is already called %s', v_name), '22023');
  END IF;
  v_entry := team_model(p_owner_id, p_entry_id);
  v_runtime := v_entry->>'runtime_type';
  IF NOT runtime_plays(v_runtime, 'analyst') THEN
    PERFORM refuse('runtime_cannot_play_role', format('%s does not play the analyst', v_runtime), '22023');
  END IF;
  v_level := assert_reasoning_effort(p_entry_id, p_reasoning_effort);
  INSERT INTO project_analysts(project_id, name, instructions, catalog_entry_id, runtime_type, reasoning_effort)
  VALUES (p_project_id, v_name, v_instructions, p_entry_id, v_runtime, v_level) RETURNING id INTO v_id;
  v_version := bump_project_team(p_project_id, p_owner_id, p_actor, p_correlation_id, 'analyst_added',
    jsonb_build_object('analyst_id',v_id,'entry_id',p_entry_id,'runtime',v_runtime,'name',v_name));
  RETURN jsonb_build_object('project_id',p_project_id,'analyst_id',v_id,'version',v_version,'status','added');
END $$;

CREATE FUNCTION update_project_analyst(p_project_id uuid, p_owner_id uuid, p_expected_version bigint,
  p_analyst_id uuid, p_name text, p_instructions text, p_actor text, p_correlation_id text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO control_plane, public, extensions, pg_temp
AS $$
DECLARE v_version bigint; v_name text := btrim(COALESCE(p_name,'')); v_instructions text := btrim(COALESCE(p_instructions,''));
BEGIN
  PERFORM lock_project_team(p_project_id, p_owner_id, p_expected_version);
  IF char_length(v_name) NOT BETWEEN 1 AND 60 OR v_name ~ '[[:cntrl:]]' OR char_length(v_instructions) > 4000 THEN
    PERFORM refuse('analyst_invalid', 'an analyst needs a name of 1 to 60 characters and instructions of at most 4000', '22023');
  END IF;
  IF EXISTS (SELECT 1 FROM project_analysts WHERE project_id=p_project_id AND enabled AND lower(name)=lower(v_name) AND id<>p_analyst_id) THEN
    PERFORM refuse('analyst_invalid', format('an analyst of this project is already called %s', v_name), '22023');
  END IF;
  UPDATE project_analysts SET name=v_name, instructions=v_instructions, updated_at=clock_timestamp()
  WHERE id=p_analyst_id AND project_id=p_project_id AND enabled;
  IF NOT FOUND THEN PERFORM refuse('analyst_unavailable', format('no analyst %s in this project', p_analyst_id)); END IF;
  v_version := bump_project_team(p_project_id, p_owner_id, p_actor, p_correlation_id, 'analyst_changed',
    jsonb_build_object('analyst_id',p_analyst_id,'name',v_name));
  RETURN jsonb_build_object('project_id',p_project_id,'analyst_id',p_analyst_id,'version',v_version,'status','changed');
END $$;

CREATE FUNCTION remove_project_analyst(p_project_id uuid, p_owner_id uuid, p_expected_version bigint,
  p_analyst_id uuid, p_actor text, p_correlation_id text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO control_plane, public, extensions, pg_temp
AS $$
DECLARE v_version bigint;
BEGIN
  PERFORM lock_project_team(p_project_id, p_owner_id, p_expected_version);
  UPDATE project_analysts SET enabled=false, updated_at=clock_timestamp()
  WHERE id=p_analyst_id AND project_id=p_project_id AND enabled;
  IF NOT FOUND THEN PERFORM refuse('analyst_unavailable', format('no analyst %s in this project', p_analyst_id)); END IF;
  v_version := bump_project_team(p_project_id, p_owner_id, p_actor, p_correlation_id, 'analyst_removed',
    jsonb_build_object('analyst_id',p_analyst_id));
  RETURN jsonb_build_object('project_id',p_project_id,'analyst_id',p_analyst_id,'version',v_version,'status','removed');
END $$;

-- ------------------------------------------------------------ the orchestrator

-- The analysts an orchestrator may ask, for its instructions on every turn.
CREATE FUNCTION orchestrator_analysts(p_job_id bigint, p_worker_id text)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path TO control_plane, public, extensions, pg_temp
AS $$
DECLARE v_project uuid;
BEGIN
  SELECT j.project_id INTO v_project FROM runtime_jobs j
  WHERE j.id=p_job_id AND j.job_type IN ('orchestrator_turn','resume_orchestrator')
    AND j.status='in_flight' AND j.leased_by=p_worker_id;
  IF v_project IS NULL THEN
    PERFORM refuse('orchestration_job_not_leased', format('orchestration job %s is not leased by worker %s', p_job_id, p_worker_id));
  END IF;
  RETURN COALESCE((SELECT jsonb_agg(jsonb_build_object('name',a.name,'runtime_type',a.runtime_type,
      'model',COALESCE(m.display_name,m.model_id),'instructions',left(a.instructions,300)) ORDER BY a.created_at)
    FROM project_analysts a LEFT JOIN provider_model_catalog m ON m.id=a.catalog_entry_id
    WHERE a.project_id=v_project AND a.enabled), '[]'::jsonb);
END $$;

-- platform.consult: one question to one analyst, from an orchestrator's turn
-- (a conversation turn or a review). `p_member` names the analyst; empty asks
-- the project's only one. The same call asks once.
CREATE FUNCTION invoke_consult(p_job_id bigint, p_worker_id text, p_call_id text, p_member text, p_question text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO control_plane, public, extensions, pg_temp
AS $$
DECLARE v_job runtime_jobs%ROWTYPE; v_task tasks%ROWTYPE; v_analyst project_analysts%ROWTYPE;
  v_existing consultations%ROWTYPE; v_id uuid; v_count integer; v_question text := btrim(COALESCE(p_question,''));
BEGIN
  IF p_call_id IS NULL OR length(btrim(p_call_id)) < 4 OR char_length(v_question) NOT BETWEEN 10 AND 8000 THEN
    PERFORM refuse('consultation_arguments_invalid', 'a consultation needs a question of 10 to 8000 characters', '22023');
  END IF;
  SELECT * INTO v_job FROM runtime_jobs j WHERE j.id=p_job_id FOR UPDATE;
  IF NOT FOUND OR v_job.job_type NOT IN ('orchestrator_turn','resume_orchestrator') OR v_job.status<>'in_flight'
     OR v_job.leased_by<>p_worker_id OR v_job.leased_until<=clock_timestamp() THEN
    PERFORM refuse('orchestration_job_not_leased', 'consult is not bound to an active orchestrator turn');
  END IF;
  SELECT * INTO v_existing FROM consultations WHERE requested_by_job=p_job_id AND call_id=p_call_id;
  IF FOUND THEN
    RETURN jsonb_build_object('status','asked','consultation_id',v_existing.id,
      'analyst',(SELECT name FROM project_analysts WHERE id=v_existing.analyst_id));
  END IF;
  SELECT * INTO v_task FROM tasks WHERE id=v_job.task_id FOR UPDATE;
  IF v_task.status IN ('approved','deployed','completed','cancelled','failed') THEN
    PERFORM refuse('task_not_delegable', format('task %s is %s', v_task.id, v_task.status));
  END IF;
  IF btrim(COALESCE(p_member,'')) = '' THEN
    SELECT count(*) INTO v_count FROM project_analysts WHERE project_id=v_job.project_id AND enabled;
    IF v_count <> 1 THEN
      PERFORM refuse('analyst_unavailable', CASE WHEN v_count = 0 THEN 'this project has no analyst'
        ELSE 'this project has several analysts; name the one to ask' END);
    END IF;
    SELECT * INTO v_analyst FROM project_analysts WHERE project_id=v_job.project_id AND enabled;
  ELSE
    SELECT * INTO v_analyst FROM project_analysts
    WHERE project_id=v_job.project_id AND enabled AND lower(name)=lower(btrim(p_member));
    IF NOT FOUND THEN
      PERFORM refuse('analyst_unavailable', format('no enabled analyst of this project is called %s', btrim(p_member)));
    END IF;
  END IF;
  IF NOT runtime_plays(v_analyst.runtime_type, 'analyst') THEN
    PERFORM refuse('runtime_cannot_play_role', format('%s does not play the analyst', v_analyst.runtime_type));
  END IF;
  IF (SELECT count(*) FROM consultations WHERE task_id=v_task.id AND status='requested') >= 3 THEN
    PERFORM refuse('consultation_limit', 'this task has three consultations waiting for an answer');
  END IF;
  INSERT INTO consultations(project_id, task_id, analyst_id, question, requested_by_job, call_id)
  VALUES (v_job.project_id, v_task.id, v_analyst.id, v_question, p_job_id, p_call_id) RETURNING id INTO v_id;
  PERFORM append_event('consultation.requested', v_job.project_id, v_task.id, NULL,
    'agent', 'orchestrator', NULL, COALESCE(v_job.payload->>'correlation_id', v_task.id::text),
    'event:consultation-requested:'||v_id, 'consultation', v_id, 1,
    jsonb_build_object('consultation_id',v_id,'analyst',v_analyst.name,'analyst_id',v_analyst.id,
      'runtime_type',v_analyst.runtime_type,
      'model',(SELECT COALESCE(m.display_name,m.model_id) FROM provider_model_catalog m WHERE m.id=v_analyst.catalog_entry_id),
      'question',v_question));
  RETURN jsonb_build_object('status','asked','consultation_id',v_id,'analyst',v_analyst.name);
END $$;

-- ------------------------------------------------------------ the run

CREATE FUNCTION claim_consultation_jobs(p_worker_id text, p_limit integer DEFAULT 1, p_lease interval DEFAULT '00:20:00'::interval)
RETURNS SETOF runtime_jobs LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO control_plane, public, extensions, pg_temp
AS $$
DECLARE v_id bigint; v_job runtime_jobs%ROWTYPE; v_seen bigint[] := '{}'; v_taken integer := 0;
BEGIN
  LOOP
    EXIT WHEN v_taken >= GREATEST(p_limit, 0);
    SELECT j.id INTO v_id FROM runtime_jobs j
    WHERE j.job_type='consultation_run' AND j.available_at<=clock_timestamp()
      AND (j.status='pending' OR (j.status='in_flight' AND j.leased_until<=clock_timestamp()))
      AND j.id <> ALL (v_seen)
    ORDER BY j.available_at, j.id FOR UPDATE SKIP LOCKED LIMIT 1;
    EXIT WHEN NOT FOUND;
    v_seen := v_seen || v_id;
    UPDATE runtime_jobs j SET status='in_flight', attempt_count=j.attempt_count+1, leased_by=p_worker_id,
      leased_until=clock_timestamp()+p_lease, last_error=NULL,
      activity_phase='starting_runtime', activity_detail='Preparing the analyst',
      started_at=COALESCE(j.started_at, clock_timestamp()), heartbeat_at=clock_timestamp()
    WHERE j.id=v_id RETURNING j.* INTO v_job;
    v_taken := v_taken + 1;
    RETURN NEXT v_job;
  END LOOP;
END $$;

-- What the supervisor needs to run the analyst, under the job's lease: the
-- question, the analyst's model and instructions, and the workspace.
CREATE FUNCTION consultation_job_context(p_job_id bigint, p_worker_id text)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path TO control_plane, public, extensions, pg_temp
AS $$
DECLARE v_context jsonb;
BEGIN
  SELECT jsonb_build_object('job_id',j.id,'attempt_count',j.attempt_count,'consultation_id',c.id,
      'project_id',c.project_id,'task_id',c.task_id,'task_title',t.title,
      'workspace_path',p.workspace_path,'question',c.question,'status',c.status,
      'analyst',a.name,'instructions',a.instructions,'runtime_type',a.runtime_type,
      'provider_id',m.provider_id,'model',m.model_id,'model_display',COALESCE(m.display_name,m.model_id),
      'model_status',m.status,'reasoning_effort',NULLIF(a.reasoning_effort,''),'analyst_enabled',a.enabled,
      -- The repository map's layout (0146), so the analyst starts from it.
      'layout',(SELECT left(rm.map->>'tree', 8000) FROM project_repository_maps rm WHERE rm.project_id=c.project_id))
    INTO v_context
  FROM runtime_jobs j
  JOIN consultations c ON c.id=(j.payload#>>'{event_payload,consultation_id}')::uuid
  JOIN project_analysts a ON a.id=c.analyst_id
  JOIN projects p ON p.id=c.project_id
  JOIN tasks t ON t.id=c.task_id
  LEFT JOIN provider_model_catalog m ON m.id=a.catalog_entry_id
  WHERE j.id=p_job_id AND j.job_type='consultation_run' AND j.status='in_flight'
    AND j.leased_by=p_worker_id AND j.leased_until>clock_timestamp();
  IF v_context IS NULL THEN
    PERFORM refuse('consultation_not_held', format('consultation job %s is not leased by %s', p_job_id, p_worker_id));
  END IF;
  RETURN v_context;
END $$;

CREATE FUNCTION heartbeat_consultation_job(p_job_id bigint, p_worker_id text, p_lease interval DEFAULT '00:20:00'::interval)
RETURNS boolean LANGUAGE sql SECURITY DEFINER
SET search_path TO control_plane, public, extensions, pg_temp
AS $$
  UPDATE runtime_jobs SET leased_until=clock_timestamp()+p_lease, heartbeat_at=clock_timestamp()
  WHERE id=p_job_id AND job_type='consultation_run' AND status='in_flight' AND leased_by=p_worker_id
  RETURNING true;
$$;

-- The analyst's answer, or why there is none. Either way the orchestrator is
-- told (consultation.answered / consultation.failed → resume_orchestrator):
-- a question nobody answers must not leave it waiting.
CREATE FUNCTION finish_consultation(p_job_id bigint, p_worker_id text, p_result jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO control_plane, public, extensions, pg_temp
AS $$
DECLARE v_job runtime_jobs%ROWTYPE; v_consultation consultations%ROWTYPE; v_analyst project_analysts%ROWTYPE;
  v_answered boolean := p_result->>'status' = 'answered' AND btrim(COALESCE(p_result->>'answer','')) <> '';
  v_answer text := left(COALESCE(p_result->>'answer',''), 32000);
BEGIN
  SELECT * INTO v_job FROM runtime_jobs WHERE id=p_job_id FOR UPDATE;
  IF NOT FOUND OR v_job.job_type<>'consultation_run' OR v_job.status<>'in_flight' OR v_job.leased_by<>p_worker_id THEN
    PERFORM refuse('consultation_not_held', format('consultation job %s is not leased by %s', p_job_id, p_worker_id));
  END IF;
  SELECT * INTO v_consultation FROM consultations
  WHERE id=(v_job.payload#>>'{event_payload,consultation_id}')::uuid FOR UPDATE;
  SELECT * INTO v_analyst FROM project_analysts WHERE id=v_consultation.analyst_id;
  IF v_consultation.status <> 'requested' THEN
    UPDATE runtime_jobs SET status='completed', completed_at=clock_timestamp(), leased_by=NULL, leased_until=NULL WHERE id=p_job_id;
    RETURN jsonb_build_object('status',v_consultation.status);
  END IF;
  UPDATE consultations SET status=CASE WHEN v_answered THEN 'answered' ELSE 'failed' END,
    answer=CASE WHEN v_answered THEN v_answer END,
    failure=CASE WHEN v_answered THEN NULL ELSE left(COALESCE(NULLIF(p_result->>'failure',''),'the analyst gave no answer'),500) END,
    model=left(NULLIF(p_result->>'model',''),200), snapshot_sha=left(NULLIF(p_result->>'snapshot_sha',''),64),
    finished_at=clock_timestamp()
  WHERE id=v_consultation.id RETURNING * INTO v_consultation;
  -- Ended either way: a question nobody answered is told to the orchestrator,
  -- not left as a dead letter for the operator to retry.
  UPDATE runtime_jobs SET status='completed', completed_at=clock_timestamp(), leased_by=NULL, leased_until=NULL,
    activity_phase='finalizing',
    activity_detail=CASE WHEN v_answered THEN 'The analyst answered' ELSE left('The analyst did not answer: '||v_consultation.failure,500) END,
    last_error=CASE WHEN v_answered THEN NULL ELSE v_consultation.failure END
  WHERE id=p_job_id;
  PERFORM append_event(CASE WHEN v_answered THEN 'consultation.answered' ELSE 'consultation.failed' END,
    v_consultation.project_id, v_consultation.task_id, NULL, 'agent', 'analyst:'||v_analyst.name, NULL,
    COALESCE(v_job.payload->>'correlation_id', v_consultation.task_id::text),
    'event:consultation-finished:'||v_consultation.id, 'consultation', v_consultation.id, 2,
    jsonb_build_object('consultation_id',v_consultation.id,'analyst',v_analyst.name,'runtime_type',v_analyst.runtime_type,
      'model',v_consultation.model,'question',v_consultation.question,'answer',v_consultation.answer,
      'failure',v_consultation.failure,'snapshot_sha',v_consultation.snapshot_sha));
  RETURN jsonb_build_object('status',v_consultation.status,'consultation_id',v_consultation.id);
END $$;

-- ------------------------------------------------------------ routing

-- 0080's routing, with the consultation's two events.
CREATE OR REPLACE FUNCTION route_outbox_message(p_message_id bigint, p_dispatcher_id text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'control_plane', 'public', 'extensions', 'pg_temp'
AS $function$
DECLARE v_message outbox_messages%ROWTYPE; v_event domain_events%ROWTYPE;
  v_job runtime_jobs%ROWTYPE; v_job_type text;
BEGIN
  SELECT * INTO v_message FROM outbox_messages o WHERE o.id=p_message_id FOR UPDATE;
  IF NOT FOUND OR v_message.status<>'in_flight' OR v_message.leased_by<>p_dispatcher_id
     OR v_message.leased_until<=clock_timestamp() THEN
    RAISE EXCEPTION 'outbox message is not actively leased' USING ERRCODE='55000', DETAIL=jsonb_build_object('reason','outbox_message_not_leased')::text;
  END IF;
  SELECT * INTO v_event FROM domain_events e WHERE e.id=v_message.event_id;
  v_job_type:=CASE
    WHEN v_event.event_type='implementation.requested' THEN 'implementation_run'
    WHEN v_event.event_type IN ('implementation.completed','revision.completed') THEN 'resume_orchestrator'
    WHEN v_event.event_type='consultation.requested' THEN 'consultation_run'
    WHEN v_event.event_type IN ('consultation.answered','consultation.failed') THEN 'resume_orchestrator'
    WHEN v_event.event_type='chat.user_message' AND EXISTS(
      SELECT 1 FROM tasks t
      JOIN project_agent_assignments pa ON pa.id=t.orchestrator_assignment_id
        AND pa.enabled AND role_holds(pa.role_definition_id,'conversation.hold')
      JOIN agents a ON a.id=pa.agent_id AND a.enabled
      JOIN runtime_profiles rp ON rp.id=pa.runtime_profile_id AND rp.enabled
      WHERE t.id=v_event.task_id AND runtime_plays(rp.runtime_type,'orchestrator')
    ) THEN 'orchestrator_turn'
  END;
  IF v_job_type IS NOT NULL THEN
    INSERT INTO runtime_jobs(source_event_id,job_type,project_id,task_id,run_id,payload)
    VALUES(v_event.id,v_job_type,v_event.project_id,v_event.task_id,v_event.run_id,
      jsonb_build_object('event_id',v_event.id,'event_type',v_event.event_type,
        'correlation_id',v_event.correlation_id,'event_payload',v_event.payload))
    ON CONFLICT(source_event_id,job_type) DO UPDATE SET source_event_id=EXCLUDED.source_event_id
    RETURNING * INTO v_job;
  END IF;
  PERFORM acknowledge_outbox(p_message_id,p_dispatcher_id);
  RETURN jsonb_build_object('message_id',p_message_id,'event_id',v_event.id,
    'event_type',v_event.event_type,'job_id',v_job.id,'job_type',v_job.job_type,
    'routed',v_job_type IS NOT NULL);
END; $function$;

-- 0084's claim, with one change: a turn that brings an analyst's answer is not
-- a review, and does not move the task to `reviewing`.
CREATE OR REPLACE FUNCTION claim_orchestrator_jobs(p_worker_id text, p_limit integer DEFAULT 1, p_lease interval DEFAULT '00:05:00'::interval)
 RETURNS SETOF runtime_jobs
 LANGUAGE plpgsql
 SET search_path TO 'control_plane', 'public', 'extensions', 'pg_temp'
AS $function$
DECLARE v_id bigint; v_job runtime_jobs%ROWTYPE; v_revoked uuid; v_seen bigint[] := '{}'; v_taken integer := 0;
BEGIN
  LOOP
    EXIT WHEN v_taken >= GREATEST(p_limit,0);
    SELECT j.id INTO v_id FROM runtime_jobs j
    WHERE j.job_type IN ('orchestrator_turn','resume_orchestrator')
      AND j.available_at<=clock_timestamp()
      AND (j.status='pending' OR (j.status='in_flight' AND j.leased_until<=clock_timestamp()))
      AND NOT EXISTS (
        SELECT 1 FROM runtime_jobs earlier
        WHERE earlier.job_type IN ('orchestrator_turn','resume_orchestrator')
          AND earlier.task_id=j.task_id AND earlier.id<j.id
          AND earlier.status IN ('pending','in_flight')
      )
      AND NOT workspace_has_foreign_writer(j.project_id, NULL)
      AND ingress_blocker(j.id) IS NULL
      AND j.id <> ALL (v_seen)
    ORDER BY j.available_at,j.id FOR UPDATE SKIP LOCKED LIMIT 1;
    EXIT WHEN NOT FOUND;
    v_seen := v_seen || v_id;
    UPDATE runtime_jobs j
    SET status='in_flight',attempt_count=j.attempt_count+1,leased_by=p_worker_id,
        leased_until=clock_timestamp()+p_lease,last_error=NULL,
        activity_phase='starting_runtime',activity_detail='Preparing the Codex runtime',
        started_at=COALESCE(j.started_at,clock_timestamp()),heartbeat_at=clock_timestamp()
    WHERE j.id=v_id RETURNING j.* INTO v_job;
    IF v_job.job_type = 'resume_orchestrator'
       AND COALESCE(v_job.payload->>'event_type','') NOT IN ('consultation.answered','consultation.failed') THEN
      UPDATE tasks t SET status='reviewing',version=t.version+1,updated_at=clock_timestamp()
      WHERE t.id=v_job.task_id AND t.status='awaiting_review';
    END IF;
    v_revoked := revoked_model_access(v_job);
    IF v_revoked IS NOT NULL THEN
      PERFORM end_runtime_job(v_job.id, p_worker_id, 'model_access_revoked',
        format('job %s was not dispatched: connection %s of its model is no longer connected', v_job.id, v_revoked));
      CONTINUE;
    END IF;
    v_taken := v_taken + 1;
    RETURN NEXT v_job;
  END LOOP;
END $function$;

REVOKE ALL ON project_analysts, consultations FROM PUBLIC;
REVOKE ALL ON FUNCTION project_analyst_list(uuid,uuid), add_project_analyst(uuid,uuid,bigint,uuid,text,text,text,text,text),
  update_project_analyst(uuid,uuid,bigint,uuid,text,text,text,text), remove_project_analyst(uuid,uuid,bigint,uuid,text,text),
  orchestrator_analysts(bigint,text), invoke_consult(bigint,text,text,text,text), claim_consultation_jobs(text,integer,interval),
  consultation_job_context(bigint,text), heartbeat_consultation_job(bigint,text,interval), finish_consultation(bigint,text,jsonb)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION project_analyst_list(uuid,uuid), add_project_analyst(uuid,uuid,bigint,uuid,text,text,text,text,text),
  update_project_analyst(uuid,uuid,bigint,uuid,text,text,text,text), remove_project_analyst(uuid,uuid,bigint,uuid,text,text)
  TO infra_web;
GRANT EXECUTE ON FUNCTION orchestrator_analysts(bigint,text), invoke_consult(bigint,text,text,text,text),
  claim_consultation_jobs(text,integer,interval), consultation_job_context(bigint,text),
  heartbeat_consultation_job(bigint,text,interval), finish_consultation(bigint,text,jsonb) TO infra_worker;
