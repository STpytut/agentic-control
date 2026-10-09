-- rc.146: the owner's message to an executor while it works.
--
-- A writing run on a runtime that takes input into a running turn (Claude
-- Code, `input.steer`: stream-json stdin, shown on the host at 2.1.294) can be
-- told something by the owner without waiting for the turn to end. The
-- message is a `steer` command of the run's mailbox (0070), which the
-- supervisor holding the run delivers in order; the chat shows it asked, and
-- then delivered or not, from the command's own outcome.
--
-- Only an executor's run: the orchestrator's turn is the conversation itself,
-- and a message to it is the next chat message.
--
-- Also: a pull request review's tokens are counted in its chat's usage.

SET search_path TO control_plane, public, extensions;

-- drivers/claude.mjs capabilities, mirrored.
INSERT INTO runtime_capabilities(runtime_type, capability) VALUES ('claude','input.steer') ON CONFLICT DO NOTHING;

INSERT INTO failure_reasons(reason, code, note) VALUES
  ('executor_not_steerable','conflict','no executor of this chat is working now on a runtime that takes messages mid-turn'),
  ('executor_message_invalid','invalid_argument','a message to the executor is 1 to 8000 characters')
ON CONFLICT (reason) DO NOTHING;

-- The executor's run the owner may write to now, or null: the chat's job that
-- is implementing, its run started, on a runtime with `input.steer`.
CREATE FUNCTION steerable_executor_run(p_project_id uuid, p_task_id uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO control_plane, public, extensions, pg_temp
AS $$
  SELECT jsonb_build_object('job_id', j.id, 'run_id', r.id, 'runtime_type', rp.runtime_type)
  FROM runtime_jobs j
  JOIN task_runs r ON r.id = active_run_of_job(j)
  JOIN agent_sessions s ON s.id = r.session_id
  JOIN runtime_profiles rp ON rp.id = s.runtime_profile_id
  WHERE j.project_id = p_project_id AND j.task_id = p_task_id AND j.status = 'in_flight'
    AND j.job_type = 'implementation_run'
    AND EXISTS (SELECT 1 FROM runtime_capabilities c WHERE c.runtime_type = rp.runtime_type AND c.capability = 'input.steer')
    -- The run's mailbox is the chat's latest job's (request_run_command): an
    -- analyst consulted after the executor started is that job, and the panel
    -- offers nothing until it ends rather than a Send that is refused.
    AND NOT EXISTS (SELECT 1 FROM runtime_jobs later WHERE later.project_id = j.project_id AND later.task_id = j.task_id
      AND later.status = 'in_flight' AND later.id > j.id)
  ORDER BY j.id DESC LIMIT 1;
$$;

-- The panel: whether the chat's executor can be written to now.
CREATE FUNCTION task_steer_target(p_project_id uuid, p_task_id uuid, p_owner_id uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO control_plane, public, extensions, pg_temp
AS $$
  SELECT CASE WHEN EXISTS (SELECT 1 FROM projects p WHERE p.id = p_project_id AND p.owner_id = p_owner_id)
    THEN steerable_executor_run(p_project_id, p_task_id) - 'job_id' - 'run_id' END;
$$;

-- The owner's message to the working executor, from the chat.
CREATE FUNCTION request_executor_message(p_project_id uuid, p_task_id uuid, p_owner_id uuid, p_text text,
  p_idempotency_key text, p_actor text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO control_plane, public, extensions, pg_temp
AS $$
DECLARE v_target jsonb; v_text text := btrim(COALESCE(p_text, '')); v_command jsonb;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM projects WHERE id = p_project_id AND owner_id = p_owner_id) THEN
    PERFORM refuse('project_unavailable', format('project %s is not yours', p_project_id));
  END IF;
  IF length(v_text) NOT BETWEEN 1 AND 8000 THEN
    PERFORM refuse('executor_message_invalid', 'a message to the executor is 1 to 8000 characters');
  END IF;
  v_target := steerable_executor_run(p_project_id, p_task_id);
  IF v_target IS NULL THEN
    PERFORM refuse('executor_not_steerable', format('no executor of task %s takes messages now', p_task_id));
  END IF;
  v_command := request_run_command(p_project_id, p_task_id, 'steer', jsonb_build_object('text', v_text),
    p_idempotency_key, left(COALESCE(p_actor, p_owner_id::text), 200), NULL);
  IF NOT COALESCE((v_command->>'repeat')::boolean, false) THEN
    PERFORM append_event('run.steer_requested', p_project_id, p_task_id, (v_target->>'run_id')::uuid, 'user',
      left(COALESCE(p_actor, p_owner_id::text), 200), NULL, p_task_id::text,
      'event:steer-requested:' || (v_command->>'command_id'), 'run_command', gen_random_uuid(), 1,
      jsonb_build_object('command_id', (v_command->>'command_id')::bigint, 'text', v_text,
        'runtime_type', v_target->>'runtime_type'));
  END IF;
  RETURN v_command || jsonb_build_object('runtime_type', v_target->>'runtime_type');
END $$;

-- What became of the message, in the chat: delivered into the turn, or not.
CREATE FUNCTION run_steer_outcome_event()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO control_plane, public, extensions, pg_temp
AS $$
BEGIN
  PERFORM append_event(CASE WHEN NEW.status = 'acknowledged' THEN 'run.steer_delivered' ELSE 'run.steer_failed' END,
    NEW.project_id, NEW.task_id, NEW.run_id, 'system', 'run-mailbox', NULL, NEW.task_id::text,
    'event:steer-outcome:' || NEW.id, 'run_command', gen_random_uuid(), 1,
    jsonb_build_object('command_id', NEW.id, 'status', NEW.status,
      'reason', COALESCE(NEW.failure_detail->>'error', NEW.failure_reason, '')));
  RETURN NULL;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'the outcome of message % was not recorded in the chat: %', NEW.id, SQLERRM;
  RETURN NULL;
END $$;
CREATE TRIGGER run_commands_steer_outcome AFTER UPDATE OF status ON run_commands
  FOR EACH ROW WHEN (NEW.command_kind = 'steer' AND OLD.status IS DISTINCT FROM NEW.status
    AND NEW.status IN ('acknowledged','failed','outcome_unknown'))
  EXECUTE FUNCTION run_steer_outcome_event();

-- ------------------------------------------------------------ review usage

-- A pull request's review counts in its chat's usage (rc.145 left it out):
-- Codex's review mode reports no tokens on its --json stream, and the
-- supervisor reads them from the review's own session files. A review has no
-- job, so a usage row may come from a review instead.
ALTER TABLE run_usage ADD COLUMN pr_review_id uuid;
DO $$
DECLARE v_name text;
BEGIN
  SELECT conname INTO v_name FROM pg_constraint
  WHERE conrelid = 'control_plane.run_usage'::regclass AND contype = 'c'
    AND pg_get_constraintdef(oid) ~ 'job_id IS NOT NULL' AND pg_get_constraintdef(oid) ~ 'check';
  IF v_name IS NULL THEN
    RAISE EXCEPTION 'run_usage has no job-or-check constraint to widen'
      USING DETAIL = jsonb_build_object('reason','database')::text;
  END IF;
  EXECUTE format('ALTER TABLE control_plane.run_usage DROP CONSTRAINT %I', v_name);
END $$;
ALTER TABLE run_usage ADD CONSTRAINT run_usage_source CHECK (kind = 'check' OR job_id IS NOT NULL OR pr_review_id IS NOT NULL);
CREATE UNIQUE INDEX run_usage_pr_review ON run_usage(pr_review_id) WHERE pr_review_id IS NOT NULL;

CREATE OR REPLACE FUNCTION finish_pr_review(p_review_id uuid, p_worker_id text, p_result jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO control_plane, public, extensions, pg_temp
AS $$
DECLARE v_review pr_reviews%ROWTYPE;
  v_text text := left(btrim(COALESCE(p_result->>'review', '')), 32000);
  v_findings jsonb := CASE WHEN jsonb_typeof(p_result->'findings') = 'array' AND octet_length((p_result->'findings')::text) <= 65536
    THEN p_result->'findings' ELSE '[]'::jsonb END;
  v_tokens jsonb := CASE WHEN jsonb_typeof(p_result->'tokens') = 'object' THEN p_result->'tokens' END;
  v_in bigint; v_read bigint; v_out bigint; v_reasoning bigint;
BEGIN
  SELECT * INTO v_review FROM pr_reviews WHERE id = p_review_id FOR UPDATE;
  IF NOT FOUND OR v_review.status <> 'reviewing' OR v_review.leased_by IS DISTINCT FROM p_worker_id THEN
    PERFORM refuse('pr_review_not_held', format('review %s is not leased by %s', p_review_id, p_worker_id));
  END IF;
  -- rc.146: the review's tokens, as the supervisor read them; whether or not
  -- it answered, what it used is counted.
  IF v_tokens IS NOT NULL THEN
    v_in := usage_count(v_tokens->'input', 1000000000000); v_read := usage_count(v_tokens->'cache_read', 1000000000000);
    v_out := usage_count(v_tokens->'output', 1000000000000); v_reasoning := usage_count(v_tokens->'reasoning', 1000000000000);
    INSERT INTO run_usage(kind, pr_review_id, operator_id, project_id, task_id, runtime_type, model,
      input_tokens, cache_read_tokens, output_tokens, reasoning_tokens, total_tokens, started_at, finished_at)
    SELECT 'run', v_review.id, p.owner_id, v_review.project_id, v_review.task_id, m.runtime_type, v_review.model,
      v_in, v_read, v_out, v_reasoning, v_in + v_read + v_out + v_reasoning, v_review.requested_at, clock_timestamp()
    FROM projects p JOIN provider_model_catalog m ON m.id = v_review.catalog_entry_id
    WHERE p.id = v_review.project_id
    ON CONFLICT DO NOTHING;
  END IF;
  IF p_result->>'status' = 'reviewed' AND v_text <> '' THEN
    UPDATE pr_reviews SET status = 'reviewed', review = v_text, findings = v_findings, finished_at = clock_timestamp(),
      model = left(COALESCE(NULLIF(p_result->>'model', ''), model), 200), leased_by = NULL, leased_until = NULL
    WHERE id = p_review_id RETURNING * INTO v_review;
    PERFORM pr_review_event(v_review, 'pr_review.completed', 3,
      jsonb_build_object('review', v_review.review, 'findings', v_review.findings, 'head_sha', v_review.head_sha));
  ELSE
    UPDATE pr_reviews SET status = 'failed', finished_at = clock_timestamp(), leased_by = NULL, leased_until = NULL,
      failure = left(COALESCE(NULLIF(p_result->>'failure', ''), 'Codex gave no review'), 500)
    WHERE id = p_review_id RETURNING * INTO v_review;
    PERFORM pr_review_event(v_review, 'pr_review.failed', 3, jsonb_build_object('failure', v_review.failure));
  END IF;
  RETURN jsonb_build_object('review_id', v_review.id, 'status', v_review.status);
END $$;

REVOKE ALL ON FUNCTION steerable_executor_run(uuid,uuid), task_steer_target(uuid,uuid,uuid),
  request_executor_message(uuid,uuid,uuid,text,text,text), run_steer_outcome_event() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION task_steer_target(uuid,uuid,uuid), request_executor_message(uuid,uuid,uuid,text,text,text) TO infra_web;
