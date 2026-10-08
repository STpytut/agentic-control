-- One question per analyst per turn while its answer is on the way (rc.136).
--
-- On rc.135's first real consultation the orchestrator read consult's receipt
-- ("asked") as the answer missing, asked the same analyst again five seconds
-- later, and delegated before either answer came. The prompt and the receipt
-- now say the answer comes after the turn (turn-prompts.mjs, CONSULT_NEXT);
-- this keeps a second ask from the same turn from starting a second run: it
-- answers with the question already asked.

SET search_path TO control_plane, public, extensions;

CREATE OR REPLACE FUNCTION invoke_consult(p_job_id bigint, p_worker_id text, p_call_id text, p_member text, p_question text)
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
  -- The same analyst asked again from the same turn while its answer is on the
  -- way: the question already asked, not a second run (rc.135, Codex asked
  -- "return the trace now" five seconds after asking).
  SELECT * INTO v_existing FROM consultations
  WHERE requested_by_job=p_job_id AND analyst_id=v_analyst.id AND status='requested'
  ORDER BY requested_at LIMIT 1;
  IF FOUND THEN
    RETURN jsonb_build_object('status','already_asked','consultation_id',v_existing.id,'analyst',v_analyst.name,
      'question',v_existing.question);
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
