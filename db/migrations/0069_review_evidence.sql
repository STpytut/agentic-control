-- A review is about a tree, and says which (WP-7, prework A3, ADR-0015).
--
-- `approve_task_review` recorded a summary, the reviewer's agent id and a task
-- version — nothing about *what* was approved. `project_workspace_states` is a
-- periodic snapshot that the next inspection overwrites. So a review could be
-- excellent and the published tree a different state, and nothing in the
-- database could show it; §3.5 approved a file that does not parse, said twice
-- to pass its tests.
--
-- What this migration adds
-- ------------------------
-- * `review_evidence`: one immutable row per implementation run, written by the
--   supervisor under the run's fencing token after the executor reports and
--   before the completion is accepted. Four digests, all mandatory — base
--   commit, head commit, worktree, patch — because for a dirty workspace a
--   commit SHA is not an answer. The executor's claims about its checks and the
--   checks the platform ran itself are two columns, never one. Plus the
--   executor run and its token, a bounded diff, the diffstat and what was cut.
-- * `review_evidence_bases`: the commit a task's first run started from, taken
--   by the supervisor before the executor is spawned. The evidence of every run
--   of the task is relative to it, and the database refuses evidence that names
--   another base — the base is not the reporter's to choose.
-- * `review_evidence_deliveries`: which evidence a review turn was given.
-- * `review_verdicts`: an approval or a revision request, referencing the
--   evidence *and its digest* through one foreign key, so a verdict cannot name
--   a digest the evidence does not have.
-- * `publish_preparations`: the durable `prepare_publish` boundary. An approval
--   requests one; the supervisor recomputes the four digests from the workspace
--   and `prepare_publish` refuses a tree or patch that has moved, with
--   `review_evidence_digest_moved`. The refusal is then recorded on the row with
--   its reason, which is a foreign key into the vocabulary.
--
-- What it deliberately does not add (owner's decision, 2026-09-24, plan §5):
-- a publish job, a publish intent, push and pull-request receipts. The push and
-- the pull request stay a manual step in 11.1b, taken from a prepared row's
-- `head_commit_sha`.
--
-- Compatibility with the release before this one
-- ----------------------------------------------
-- `finalize_worker_completion` requires evidence only for a run whose base the
-- supervisor recorded. The previous release records no base, so its completions
-- finalize as before. What it meets instead is `approve_task_review` refusing a
-- task with no evidence (`review_evidence_missing`), which is the fix. A run
-- launched by the previous release and finished by this one is the same case:
-- its approval is refused, and a revision produces the evidence.
--
-- Every redefined function keeps its signature, its SQLSTATEs and its human
-- sentence; their refusals now carry a reason (0067's rule: a function touched
-- is a function converted).
--
-- No BEGIN/COMMIT: migrate.mjs owns the transaction (0039 onwards).
SET search_path TO control_plane, public, extensions;

INSERT INTO failure_reasons(reason, code, note) VALUES
  ('review_evidence_invalid','invalid_argument','evidence with a digest, commit or field outside what the algorithm defines'),
  ('review_evidence_base_mismatch','invalid_argument','evidence relative to a base other than the one recorded when the task''s first run started'),
  ('review_evidence_conflict','conflict','evidence for this run was already recorded with different digests'),
  ('review_evidence_missing','conflict','there is no evidence of the implementation under review'),
  ('review_evidence_stale','conflict','the evidence a verdict names is not the evidence of the task''s latest implementation'),
  ('review_evidence_immutable','conflict','a recorded review fact or a finished publish preparation cannot be changed'),
  ('review_evidence_unverified','conflict','the platform''s own check of the evidence failed, so it cannot be published'),
  ('review_evidence_digest_moved','conflict','the workspace no longer has the digests that were reviewed and approved'),
  ('review_verdict_missing','conflict','the approval of this task names no evidence'),
  ('review_approval_invalid','invalid_argument','an approval without an actor or a summary'),
  ('review_context_unavailable','conflict','the task has no orchestrator or executor assignment to review under'),
  ('revision_arguments_invalid','invalid_argument','a revision request without a call id or a non-empty list of changes'),
  ('task_not_reviewable','conflict','the task is not awaiting review at the expected version'),
  ('reviewer_unavailable','conflict','the task''s active agent is not an enabled reviewer'),
  ('completion_report_not_found','not_found','no completion report with that id'),
  ('completion_report_not_finalizable','conflict','the completion report is neither submitted nor accepted'),
  ('completion_job_mismatch','conflict','the job is not the implementation job of this completion''s run'),
  ('publish_task_not_approved','conflict','only an approved task can be prepared for publishing'),
  ('publish_worktree_uncommitted','conflict','the approved tree has changes that are not in its head commit, which a push would not carry'),
  ('publish_observation_invalid','invalid_argument','the recomputed digests are missing or malformed'),
  ('publish_observation_failed','unavailable','the workspace could not be read to recompute the digests'),
  ('publish_preparation_not_claimed','lease_lost','the preparation is not claimed by this worker, or its lease ran out'),
  ('orchestration_job_not_leased','lease_lost','the Codex job is not in flight under this worker''s lease')
ON CONFLICT (reason) DO UPDATE SET code=EXCLUDED.code, note=EXCLUDED.note;

-- ------------------------------------------------------------------ tables

CREATE TABLE review_evidence_bases (
  run_id uuid PRIMARY KEY REFERENCES task_runs(id),
  task_id uuid NOT NULL REFERENCES tasks(id),
  base_commit_sha text NOT NULL CHECK (base_commit_sha ~ '^[0-9a-f]{40}([0-9a-f]{24})?$'),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX review_evidence_bases_task ON review_evidence_bases(task_id, recorded_at);

CREATE TABLE review_evidence (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id),
  task_id uuid NOT NULL REFERENCES tasks(id),
  -- The executor run and the token it held when the evidence was taken.
  run_id uuid NOT NULL UNIQUE REFERENCES task_runs(id),
  fencing_token bigint NOT NULL,
  base_commit_sha text NOT NULL CHECK (base_commit_sha ~ '^[0-9a-f]{40}([0-9a-f]{24})?$'),
  head_commit_sha text NOT NULL CHECK (head_commit_sha ~ '^[0-9a-f]{40}([0-9a-f]{24})?$'),
  worktree_digest text NOT NULL CHECK (worktree_digest ~ '^sha256:[0-9a-f]{64}$'),
  patch_digest text NOT NULL CHECK (patch_digest ~ '^sha256:[0-9a-f]{64}$'),
  -- Computed here, from the columns above and the run, never supplied.
  evidence_digest text NOT NULL UNIQUE CHECK (evidence_digest ~ '^sha256:[0-9a-f]{64}$'),
  algorithm jsonb NOT NULL CHECK (algorithm = '{"worktree":"infra-cod-worktree-v1","patch":"infra-cod-patch-v1"}'::jsonb),
  object_format text NOT NULL CHECK (object_format IN ('sha1','sha256')),
  worktree_committed boolean NOT NULL,
  changed_files jsonb NOT NULL CHECK (jsonb_typeof(changed_files)='array'),
  diffstat jsonb NOT NULL CHECK (jsonb_typeof(diffstat)='object'),
  diff text NOT NULL CHECK (octet_length(diff) <= 65536),
  truncation jsonb NOT NULL CHECK (jsonb_typeof(truncation)='object'),
  -- What the runtime said about itself, copied from its completion report …
  executor_reported_checks jsonb NOT NULL CHECK (jsonb_typeof(executor_reported_checks)='object'),
  -- … and what the control plane ran and observed. Two columns, on purpose.
  platform_verified_checks jsonb NOT NULL CHECK (jsonb_typeof(platform_verified_checks)='array'),
  recorded_by text NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (id, evidence_digest)
);
CREATE INDEX review_evidence_task ON review_evidence(task_id, recorded_at);

CREATE TABLE review_evidence_deliveries (
  turn_run_id uuid PRIMARY KEY REFERENCES task_runs(id),
  job_id bigint NOT NULL REFERENCES runtime_jobs(id),
  evidence_id uuid NOT NULL,
  evidence_digest text NOT NULL,
  delivered_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (evidence_id, evidence_digest) REFERENCES review_evidence(id, evidence_digest)
);

CREATE TABLE review_verdicts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id),
  task_id uuid NOT NULL REFERENCES tasks(id),
  evidence_id uuid NOT NULL,
  evidence_digest text NOT NULL,
  verdict text NOT NULL CHECK (verdict IN ('approved','changes_requested')),
  actor_type text NOT NULL CHECK (actor_type IN ('user','agent')),
  actor_id text NOT NULL,
  turn_run_id uuid REFERENCES task_runs(id),
  command_id uuid REFERENCES commands(id),
  task_version bigint NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (evidence_id, evidence_digest) REFERENCES review_evidence(id, evidence_digest),
  UNIQUE (id, evidence_id)
);
CREATE INDEX review_verdicts_task ON review_verdicts(task_id, recorded_at);

CREATE TABLE publish_preparations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id),
  task_id uuid NOT NULL REFERENCES tasks(id),
  verdict_id uuid NOT NULL,
  evidence_id uuid NOT NULL,
  evidence_digest text NOT NULL,
  requested_by text NOT NULL,
  idempotency_key text NOT NULL,
  correlation_id text NOT NULL,
  status text NOT NULL DEFAULT 'requested'
    CHECK (status IN ('requested','claimed','prepared','refused')),
  attempt_count integer NOT NULL DEFAULT 0,
  leased_by text,
  leased_until timestamptz,
  observed jsonb,
  head_commit_sha text,
  refusal_reason text REFERENCES failure_reasons(reason),
  refusal_message text,
  requested_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  finished_at timestamptz,
  UNIQUE (task_id, idempotency_key),
  FOREIGN KEY (verdict_id, evidence_id) REFERENCES review_verdicts(id, evidence_id),
  FOREIGN KEY (evidence_id, evidence_digest) REFERENCES review_evidence(id, evidence_digest),
  CHECK ((status='prepared') = (observed IS NOT NULL AND head_commit_sha IS NOT NULL)),
  CHECK ((status='refused') = (refusal_reason IS NOT NULL)),
  CHECK ((status IN ('prepared','refused')) = (finished_at IS NOT NULL))
);
CREATE INDEX publish_preparations_pending ON publish_preparations(requested_at)
  WHERE status IN ('requested','claimed');

GRANT SELECT, INSERT, UPDATE, DELETE ON review_evidence_bases, review_evidence,
  review_evidence_deliveries, review_verdicts, publish_preparations TO infra_worker;

-- Immutable means the database refuses the change, not that nothing is written
-- to make it. A finished preparation is immutable too; one in progress moves
-- through its states.
CREATE OR REPLACE FUNCTION refuse_review_record_change()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- Nested, not joined by AND: PL/pgSQL does not promise to short-circuit, and
  -- OLD.status does not exist on the other tables.
  IF TG_TABLE_NAME = 'publish_preparations' AND TG_OP = 'UPDATE' THEN
    IF OLD.status IN ('requested','claimed') THEN
      RETURN NEW;
    END IF;
  END IF;
  PERFORM refuse('review_evidence_immutable',
    format('%s rows are immutable once recorded (%s refused)', TG_TABLE_NAME, TG_OP));
  RETURN NULL;
END $$;

CREATE TRIGGER review_evidence_bases_immutable BEFORE UPDATE OR DELETE ON review_evidence_bases
  FOR EACH ROW EXECUTE FUNCTION refuse_review_record_change();
CREATE TRIGGER review_evidence_immutable BEFORE UPDATE OR DELETE ON review_evidence
  FOR EACH ROW EXECUTE FUNCTION refuse_review_record_change();
CREATE TRIGGER review_evidence_deliveries_immutable BEFORE UPDATE OR DELETE ON review_evidence_deliveries
  FOR EACH ROW EXECUTE FUNCTION refuse_review_record_change();
CREATE TRIGGER review_verdicts_immutable BEFORE UPDATE OR DELETE ON review_verdicts
  FOR EACH ROW EXECUTE FUNCTION refuse_review_record_change();
CREATE TRIGGER publish_preparations_final BEFORE UPDATE OR DELETE ON publish_preparations
  FOR EACH ROW EXECUTE FUNCTION refuse_review_record_change();

-- --------------------------------------------------------------- helpers

-- The evidence digest (ADR-0015): the four digests and the run that took them,
-- under a version string. The run and its token are inside it, so the same tree
-- reported by two runs is two pieces of evidence — which it is.
CREATE OR REPLACE FUNCTION review_evidence_digest(
  p_run_id uuid, p_fencing_token bigint, p_base text, p_head text, p_worktree text, p_patch text
) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT 'sha256:' || encode(sha256(convert_to(concat_ws(E'\n',
    'infra-cod-review-evidence-v1', p_run_id::text, p_fencing_token::text,
    p_base, p_head, p_worktree, p_patch), 'UTF8')), 'hex');
$$;

-- The base every run of a task is reviewed against: the commit its first run
-- started from.
CREATE OR REPLACE FUNCTION review_evidence_base(p_run_id uuid)
RETURNS text LANGUAGE sql STABLE AS $$
  SELECT b.base_commit_sha FROM review_evidence_bases b
  WHERE b.task_id=(SELECT r.task_id FROM task_runs r WHERE r.id=p_run_id)
  ORDER BY b.recorded_at, b.run_id
  LIMIT 1;
$$;

-- The evidence of the task's latest implementation or revision run, or none.
-- "Latest run" rather than "latest evidence": a run that finished without
-- evidence must not leave the evidence of the run before it standing in.
CREATE OR REPLACE FUNCTION current_review_evidence(p_task_id uuid)
RETURNS SETOF review_evidence LANGUAGE sql STABLE AS $$
  SELECT e.* FROM review_evidence e
  WHERE e.run_id=(
    SELECT r.id FROM task_runs r
    WHERE r.task_id=p_task_id AND r.write_capable
    ORDER BY r.created_at DESC, r.id DESC
    LIMIT 1
  );
$$;

-- The implementation job a supervisor is holding, checked the way
-- start_implementation_job checks it (0067), with the same reasons.
CREATE OR REPLACE FUNCTION assert_supervised_implementation(
  p_job_id bigint, p_supervisor_id text, p_run_id uuid, p_fencing_token bigint
) RETURNS runtime_jobs LANGUAGE plpgsql AS $$
DECLARE v_job runtime_jobs%ROWTYPE; v_run task_runs%ROWTYPE;
BEGIN
  SELECT * INTO v_job FROM runtime_jobs j WHERE j.id=p_job_id FOR UPDATE;
  IF NOT FOUND THEN
    PERFORM refuse('job_not_found', format('no runtime job %s', p_job_id));
  END IF;
  IF v_job.job_type<>'start_implementation' THEN
    PERFORM refuse('job_type_mismatch', format('job %s is %s, not start_implementation', p_job_id, v_job.job_type));
  END IF;
  IF v_job.status<>'in_flight' THEN
    PERFORM refuse('job_not_in_flight', format('job %s is %s', p_job_id, v_job.status));
  END IF;
  IF v_job.leased_by IS DISTINCT FROM p_supervisor_id THEN
    PERFORM refuse('job_lease_held_by_another', format('job %s is leased by another worker', p_job_id));
  END IF;
  IF v_job.leased_until<=clock_timestamp() THEN
    PERFORM refuse('job_lease_expired', format('the lease of job %s expired', p_job_id));
  END IF;
  IF v_job.run_id IS DISTINCT FROM p_run_id THEN
    PERFORM refuse('completion_job_mismatch', format('job %s is not the job of run %s', p_job_id, p_run_id));
  END IF;
  SELECT * INTO v_run FROM task_runs r WHERE r.id=p_run_id FOR UPDATE;
  IF NOT FOUND THEN
    PERFORM refuse('run_not_found', format('no run %s', p_run_id), '55000');
  END IF;
  IF NOT v_run.write_capable THEN
    PERFORM refuse('run_not_write_capable', format('run %s is a turn', p_run_id));
  END IF;
  IF v_run.status<>'running' THEN
    PERFORM refuse('run_not_running', format('run %s is %s, not running', p_run_id, v_run.status));
  END IF;
  PERFORM assert_workspace_fence(v_job.project_id, p_run_id, p_fencing_token);
  RETURN v_job;
END $$;

-- ------------------------------------------------------ the supervisor side

-- Before the executor is spawned: the commit it starts from. The first run of
-- a task fixes the base for all of them; a later run's record is kept too, as a
-- fact, but does not move it.
CREATE OR REPLACE FUNCTION record_review_base(
  p_job_id bigint, p_supervisor_id text, p_run_id uuid, p_fencing_token bigint, p_head_commit_sha text
) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE v_job runtime_jobs%ROWTYPE;
BEGIN
  IF p_head_commit_sha IS NULL OR p_head_commit_sha !~ '^[0-9a-f]{40}([0-9a-f]{24})?$' THEN
    PERFORM refuse('review_evidence_invalid', 'a review base is a full commit id', '22023');
  END IF;
  v_job:=assert_supervised_implementation(p_job_id, p_supervisor_id, p_run_id, p_fencing_token);
  INSERT INTO review_evidence_bases(run_id, task_id, base_commit_sha)
  VALUES (p_run_id, v_job.task_id, p_head_commit_sha)
  ON CONFLICT (run_id) DO NOTHING;
  RETURN jsonb_build_object('run_id', p_run_id, 'base_commit_sha', review_evidence_base(p_run_id));
END $$;

-- After the executor reported, before its completion is accepted: what it
-- produced, under its fencing token.
CREATE OR REPLACE FUNCTION record_review_evidence(
  p_job_id bigint, p_supervisor_id text, p_run_id uuid, p_fencing_token bigint, p_evidence jsonb
) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
  v_job runtime_jobs%ROWTYPE; v_report worker_completion_reports%ROWTYPE;
  v_existing review_evidence%ROWTYPE; v_row review_evidence%ROWTYPE; v_digest text; v_base text;
BEGIN
  IF p_evidence IS NULL OR jsonb_typeof(p_evidence)<>'object'
     OR COALESCE(p_evidence->>'base_commit_sha','') !~ '^[0-9a-f]{40}([0-9a-f]{24})?$'
     OR COALESCE(p_evidence->>'head_commit_sha','') !~ '^[0-9a-f]{40}([0-9a-f]{24})?$'
     OR COALESCE(p_evidence->>'worktree_digest','') !~ '^sha256:[0-9a-f]{64}$'
     OR COALESCE(p_evidence->>'patch_digest','') !~ '^sha256:[0-9a-f]{64}$'
     OR jsonb_typeof(p_evidence->'changed_files') IS DISTINCT FROM 'array'
     OR jsonb_typeof(p_evidence->'diffstat') IS DISTINCT FROM 'object'
     OR jsonb_typeof(p_evidence->'truncation') IS DISTINCT FROM 'object'
     OR jsonb_typeof(p_evidence->'platform_verified_checks') IS DISTINCT FROM 'array'
     OR jsonb_typeof(p_evidence->'worktree_committed') IS DISTINCT FROM 'boolean'
     OR jsonb_typeof(p_evidence->'diff') IS DISTINCT FROM 'string'
     OR p_evidence->'algorithm' IS DISTINCT FROM '{"worktree":"infra-cod-worktree-v1","patch":"infra-cod-patch-v1"}'::jsonb
     OR COALESCE(p_evidence->>'object_format','') NOT IN ('sha1','sha256') THEN
    PERFORM refuse('review_evidence_invalid',
      'review evidence needs a base, a head, a worktree digest and a patch digest, and the fields the algorithm defines', '22023');
  END IF;
  v_job:=assert_supervised_implementation(p_job_id, p_supervisor_id, p_run_id, p_fencing_token);

  v_base:=review_evidence_base(p_run_id);
  IF v_base IS NULL OR v_base<>p_evidence->>'base_commit_sha' THEN
    PERFORM refuse('review_evidence_base_mismatch',
      format('evidence of run %s is relative to %s; the task''s base is %s',
        p_run_id, p_evidence->>'base_commit_sha', COALESCE(v_base,'not recorded')), '22023');
  END IF;

  -- The executor's own account of its checks is taken from its report, not from
  -- whoever records the evidence.
  SELECT * INTO v_report FROM worker_completion_reports r
  WHERE r.run_id=p_run_id AND r.status IN ('submitted','accepted')
  ORDER BY r.submitted_at DESC LIMIT 1;
  IF NOT FOUND THEN
    PERFORM refuse('review_evidence_invalid', format('run %s has no completion report to take evidence for', p_run_id));
  END IF;

  v_digest:=review_evidence_digest(p_run_id, p_fencing_token, p_evidence->>'base_commit_sha',
    p_evidence->>'head_commit_sha', p_evidence->>'worktree_digest', p_evidence->>'patch_digest');
  SELECT * INTO v_existing FROM review_evidence e WHERE e.run_id=p_run_id;
  IF FOUND THEN
    IF v_existing.evidence_digest<>v_digest THEN
      PERFORM refuse('review_evidence_conflict',
        format('run %s already has evidence %s', p_run_id, v_existing.evidence_digest));
    END IF;
    RETURN jsonb_build_object('evidence_id', v_existing.id, 'evidence_digest', v_existing.evidence_digest, 'repeat', true);
  END IF;

  INSERT INTO review_evidence(project_id, task_id, run_id, fencing_token, base_commit_sha, head_commit_sha,
    worktree_digest, patch_digest, evidence_digest, algorithm, object_format, worktree_committed,
    changed_files, diffstat, diff, truncation, executor_reported_checks, platform_verified_checks, recorded_by)
  VALUES (v_job.project_id, v_job.task_id, p_run_id, p_fencing_token, p_evidence->>'base_commit_sha',
    p_evidence->>'head_commit_sha', p_evidence->>'worktree_digest', p_evidence->>'patch_digest', v_digest,
    p_evidence->'algorithm', p_evidence->>'object_format', (p_evidence->>'worktree_committed')::boolean,
    p_evidence->'changed_files', p_evidence->'diffstat', p_evidence->>'diff', p_evidence->'truncation',
    v_report.checks_summary, p_evidence->'platform_verified_checks', p_supervisor_id)
  RETURNING * INTO v_row;
  RETURN jsonb_build_object('evidence_id', v_row.id, 'evidence_digest', v_row.evidence_digest);
END $$;

-- 0005's body, with two changes: a run whose base was recorded cannot finalize
-- without evidence, and each refusal has a reason. The previous release records
-- no base, so for it nothing changes (header).
CREATE OR REPLACE FUNCTION finalize_worker_completion(
  p_report_id uuid,
  p_job_id bigint,
  p_supervisor_id text
)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_report worker_completion_reports%ROWTYPE;
  v_job runtime_jobs%ROWTYPE;
  v_task tasks%ROWTYPE;
  v_handoff handoffs%ROWTYPE;
  v_result jsonb;
BEGIN
  SELECT * INTO v_report FROM worker_completion_reports r WHERE r.id = p_report_id FOR UPDATE;
  IF NOT FOUND THEN
    PERFORM refuse('completion_report_not_found',
      format('worker completion report %s not found', p_report_id), '23503');
  END IF;
  IF v_report.status = 'accepted' THEN RETURN v_report.completion_result; END IF;
  IF v_report.status <> 'submitted' THEN
    PERFORM refuse('completion_report_not_finalizable',
      format('worker completion report %s is not finalizable', p_report_id));
  END IF;

  SELECT * INTO v_job FROM runtime_jobs j WHERE j.id = p_job_id FOR UPDATE;
  IF NOT FOUND THEN
    PERFORM refuse('job_not_found', 'runtime supervisor does not own the completion run');
  END IF;
  IF v_job.run_id IS DISTINCT FROM v_report.run_id OR v_job.job_type <> 'start_implementation' THEN
    PERFORM refuse('completion_job_mismatch', 'runtime supervisor does not own the completion run');
  END IF;
  IF v_job.status <> 'in_flight' THEN
    PERFORM refuse('job_not_in_flight', 'runtime supervisor does not own the completion run');
  END IF;
  IF v_job.leased_by IS DISTINCT FROM p_supervisor_id THEN
    PERFORM refuse('job_lease_held_by_another', 'runtime supervisor does not own the completion run');
  END IF;
  IF v_job.leased_until <= clock_timestamp() THEN
    PERFORM refuse('job_lease_expired', 'runtime supervisor does not own the completion run');
  END IF;
  IF EXISTS (SELECT 1 FROM review_evidence_bases b WHERE b.run_id = v_report.run_id)
     AND NOT EXISTS (SELECT 1 FROM review_evidence e WHERE e.run_id = v_report.run_id) THEN
    PERFORM refuse('review_evidence_missing',
      format('run %s cannot complete before its review evidence is recorded', v_report.run_id));
  END IF;
  SELECT * INTO v_task FROM tasks t WHERE t.id = v_report.task_id FOR UPDATE;
  SELECT * INTO v_handoff FROM handoffs h WHERE h.target_run_id = v_report.run_id;

  v_result := complete_implementation(
    v_report.project_id, v_report.task_id, v_report.run_id, v_report.agent_id,
    v_handoff.from_agent_id, v_report.fencing_token,
    v_report.result_summary, v_report.checks_summary,
    'complete:' || v_report.run_id, v_task.version, v_report.task_id::text
  );
  UPDATE worker_completion_reports
  SET status = 'accepted', completion_result = v_result, finalized_at = clock_timestamp()
  WHERE id = p_report_id;
  RETURN v_result;
END;
$$;

-- ------------------------------------------------------- the review turn

-- The evidence of the implementation a review turn is about, recorded as
-- delivered to that turn. NULL for an implementation that finished without
-- evidence (a run the previous release launched): the turn is then told so.
CREATE OR REPLACE FUNCTION deliver_review_evidence(p_job_id bigint, p_worker_id text)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE v_job runtime_jobs%ROWTYPE; v_run uuid; v_evidence review_evidence%ROWTYPE;
BEGIN
  SELECT * INTO v_job FROM runtime_jobs j WHERE j.id=p_job_id FOR UPDATE;
  IF NOT FOUND THEN
    PERFORM refuse('job_not_found', format('no runtime job %s', p_job_id));
  END IF;
  IF v_job.job_type<>'resume_codex' THEN
    PERFORM refuse('job_type_mismatch', format('job %s is %s, not a review turn', p_job_id, v_job.job_type));
  END IF;
  IF v_job.status<>'in_flight' THEN
    PERFORM refuse('job_not_in_flight', format('job %s is %s', p_job_id, v_job.status));
  END IF;
  IF v_job.leased_by IS DISTINCT FROM p_worker_id THEN
    PERFORM refuse('job_lease_held_by_another', format('job %s is leased by another worker', p_job_id));
  END IF;
  IF v_job.leased_until<=clock_timestamp() THEN
    PERFORM refuse('job_lease_expired', format('the lease of job %s expired', p_job_id));
  END IF;
  -- The implementation this turn reviews is the source event's run; the job's
  -- own run is the turn (0059).
  SELECT e.run_id INTO v_run FROM domain_events e WHERE e.id=v_job.source_event_id;
  SELECT * INTO v_evidence FROM review_evidence e WHERE e.run_id=v_run;
  IF NOT FOUND THEN RETURN NULL; END IF;
  INSERT INTO review_evidence_deliveries(turn_run_id, job_id, evidence_id, evidence_digest)
  VALUES (v_job.run_id, v_job.id, v_evidence.id, v_evidence.evidence_digest)
  ON CONFLICT (turn_run_id) DO NOTHING;
  RETURN to_jsonb(v_evidence) - 'executor_reported_checks' - 'platform_verified_checks'
    || jsonb_build_object(
      'evidence_id', v_evidence.id,
      'executor_reported_checks', v_evidence.executor_reported_checks,
      'platform_verified_checks', v_evidence.platform_verified_checks);
END $$;

-- 0014's body. Two changes: the refusals have reasons, and a revision requested
-- by a turn that was given evidence is a verdict on that evidence — refused if
-- the evidence is no longer the task's current one.
CREATE OR REPLACE FUNCTION invoke_codex_request_revision(
  p_job_id bigint,p_worker_id text,p_call_id text,p_changes_required jsonb
)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE v_job runtime_jobs%ROWTYPE; v_task tasks%ROWTYPE;
  v_orchestrator project_agent_assignments%ROWTYPE; v_handoff handoffs%ROWTYPE;
  v_existing commands%ROWTYPE; v_key text; v_result jsonb;
  v_delivery review_evidence_deliveries%ROWTYPE; v_current uuid; v_version bigint;
BEGIN
  IF p_call_id IS NULL OR length(trim(p_call_id))<4 OR p_changes_required IS NULL
     OR jsonb_typeof(p_changes_required)<>'array' OR jsonb_array_length(p_changes_required)=0 THEN
    PERFORM refuse('revision_arguments_invalid','invalid request_revision arguments','22023');
  END IF;
  SELECT * INTO v_job FROM runtime_jobs j WHERE j.id=p_job_id FOR UPDATE;
  IF NOT FOUND OR v_job.job_type<>'resume_codex' THEN
    PERFORM refuse('job_type_mismatch','request_revision is not bound to an active Codex review turn');
  END IF;
  IF v_job.status<>'in_flight' THEN
    PERFORM refuse('job_not_in_flight','request_revision is not bound to an active Codex review turn');
  END IF;
  IF v_job.leased_by IS DISTINCT FROM p_worker_id THEN
    PERFORM refuse('job_lease_held_by_another','request_revision is not bound to an active Codex review turn');
  END IF;
  IF v_job.leased_until<=clock_timestamp() THEN
    PERFORM refuse('job_lease_expired','request_revision is not bound to an active Codex review turn');
  END IF;
  v_key:='codex-tool:' || p_job_id || ':' || p_call_id;
  SELECT * INTO v_existing FROM commands c
    WHERE c.project_id=v_job.project_id AND c.idempotency_key=v_key;
  IF FOUND AND v_existing.status='completed' THEN RETURN v_existing.result; END IF;
  SELECT * INTO v_task FROM tasks t WHERE t.id=v_job.task_id AND t.project_id=v_job.project_id FOR UPDATE;
  SELECT * INTO v_orchestrator FROM project_agent_assignments pa
    WHERE pa.id=v_task.orchestrator_assignment_id AND pa.enabled
      AND pa.assignment_role='orchestrator';
  SELECT * INTO v_handoff FROM handoffs h WHERE h.task_id=v_task.id
    ORDER BY h.revision_number DESC LIMIT 1;
  IF v_orchestrator.id IS NULL OR v_handoff.id IS NULL OR v_handoff.executor_assignment_id IS NULL
     OR NOT EXISTS(
       SELECT 1 FROM task_executor_assignments tea
       JOIN project_agent_assignments pa ON pa.id=tea.project_agent_assignment_id
       JOIN runtime_profiles rp ON rp.id=pa.runtime_profile_id
       WHERE tea.task_id=v_task.id AND tea.project_agent_assignment_id=v_handoff.executor_assignment_id
         AND tea.enabled AND pa.enabled AND pa.assignment_role='executor'
         AND rp.enabled AND rp.runtime_type='opencode'
     ) THEN
    PERFORM refuse('review_context_unavailable','review context is unavailable');
  END IF;
  SELECT * INTO v_delivery FROM review_evidence_deliveries d WHERE d.turn_run_id=v_job.run_id;
  IF FOUND THEN
    SELECT e.id INTO v_current FROM current_review_evidence(v_task.id) e;
    IF v_current IS DISTINCT FROM v_delivery.evidence_id THEN
      PERFORM refuse('review_evidence_stale',
        format('this turn reviewed evidence %s, which is no longer the task''s current evidence', v_delivery.evidence_digest));
    END IF;
  END IF;
  v_version:=v_task.version;
  v_result:=request_revision(
    v_task.project_id,v_task.id,v_orchestrator.agent_id,p_changes_required,
    v_handoff.acceptance_criteria,v_key,
    v_task.version,COALESCE(v_job.payload->>'correlation_id',v_task.id::text)
  );
  UPDATE handoffs SET executor_assignment_id=v_handoff.executor_assignment_id
    WHERE id=(v_result#>>'{delegation,handoff_id}')::uuid AND executor_assignment_id IS NULL;
  IF v_delivery.turn_run_id IS NOT NULL THEN
    INSERT INTO review_verdicts(project_id, task_id, evidence_id, evidence_digest, verdict, actor_type, actor_id,
      turn_run_id, command_id, task_version)
    VALUES (v_task.project_id, v_task.id, v_delivery.evidence_id, v_delivery.evidence_digest, 'changes_requested',
      'agent', v_orchestrator.agent_id::text, v_job.run_id, (v_result->>'command_id')::uuid, v_version);
    v_result:=v_result || jsonb_build_object('evidence_digest', v_delivery.evidence_digest);
  END IF;
  RETURN v_result;
END; $$;

-- 0063's body, with the review turn's words changed: they said "Inspect the
-- implementation in the read-only workspace", and nothing makes it read-only —
-- the grant keeps writers out, and hands the tree to Codex's account (WP-3c).
-- The one bare refusal gets a reason while the function is open.
CREATE OR REPLACE FUNCTION codex_chat_job_context(p_job_id bigint,p_worker_id text)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE v_context jsonb; v_snapshot jsonb; v_snapshot_model text;
BEGIN
  SELECT get_task_runtime_snapshot(t.id) INTO v_snapshot
  FROM runtime_jobs j JOIN tasks t ON t.id=j.task_id
  WHERE j.id=p_job_id AND j.job_type IN ('codex_chat_turn','resume_codex');
  IF v_snapshot IS NULL OR v_snapshot->>'source'<>'catalog' THEN
    v_snapshot := '{}'::jsonb;
  END IF;
  v_snapshot_model := v_snapshot->'orchestrator'->>'model_id';

  SELECT jsonb_build_object(
    'job_id',j.id,'job_type',j.job_type,'source_event_id',j.source_event_id,
    'project_id',j.project_id,'task_id',j.task_id,'task_status',t.status,
    'task_version',t.version,'task_title',t.title,'task_objective',t.objective,
    'task_constraints',t.constraints,'task_acceptance_criteria',t.acceptance_criteria,
    'followup_of_task_id',t.followup_of_task_id,
    'content',CASE WHEN j.job_type='codex_chat_turn'
      THEN j.payload#>>'{event_payload,content}'
      ELSE concat(
        'A durable ',j.payload->>'event_type',' event is ready for review. ',
        'Inspect the implementation and the review evidence above. The workspace is not read-only, ',
        'and a change to it makes an approval of this evidence stale. ',
        'If changes are required, call platform.request_revision. ',
        'Otherwise summarize the review result for the operator.',E'\n',
        jsonb_pretty(j.payload->'event_payload')) END,
    'correlation_id',j.payload->>'correlation_id','workspace_path',p.workspace_path,
    'agent_id',a.id,'agent_name',a.name,'orchestrator_assignment_id',pa.id,
    'runtime_profile_id',COALESCE(v_snapshot->'orchestrator'->>'entry_id',rp.id::text),
    'runtime_type',COALESCE(v_snapshot->'orchestrator'->>'runtime_type',rp.runtime_type),
    'provider_type',COALESCE(v_snapshot->'orchestrator'->>'provider_id',rp.provider_type),
    'model',COALESCE(v_snapshot_model,rp.model),
    'snapshot_entry_id',v_snapshot->'orchestrator'->>'entry_id',
    'snapshot_verification_id',v_snapshot->'orchestrator'->>'verification_id',
    'reasoning_effort',v_snapshot->'orchestrator'->>'reasoning_effort',
    'service_tier',v_snapshot->'orchestrator'->>'service_tier',
    'native_session_id',s.native_session_id,
    'executor',COALESCE((
      SELECT jsonb_build_object(
        'assignment_id',epa.id,'agent_id',ea.id,'agent_name',ea.name,
        'runtime_profile_id',COALESCE(esnap.e->>'entry_id',erp.id::text),
        'runtime_type',COALESCE(esnap.e->>'runtime_type',erp.runtime_type),
        'provider_type',COALESCE(esnap.e->>'provider_id',erp.provider_type),
        'model',COALESCE(esnap.e->>'model_id',erp.model),
        'reasoning_effort',esnap.e->>'reasoning_effort','service_tier',esnap.e->>'service_tier',
        'priority',tea.priority)
      FROM task_executor_assignments tea
      JOIN project_agent_assignments epa ON epa.id=tea.project_agent_assignment_id
        AND epa.enabled AND epa.assignment_role='executor'
      JOIN agents ea ON ea.id=epa.agent_id AND ea.enabled
      JOIN runtime_profiles erp ON erp.id=epa.runtime_profile_id
        AND erp.enabled AND erp.runtime_type='opencode'
      LEFT JOIN LATERAL (
        SELECT e FROM jsonb_array_elements(v_snapshot->'executors') e
        LIMIT 1
      ) esnap ON true
      WHERE tea.task_id=t.id AND tea.enabled
      ORDER BY tea.priority,tea.created_at LIMIT 1
    ),'null'::jsonb)
  ) INTO v_context
  FROM runtime_jobs j
  JOIN projects p ON p.id=j.project_id
  JOIN tasks t ON t.id=j.task_id
  JOIN project_agent_assignments pa ON pa.id=t.orchestrator_assignment_id
    AND pa.enabled AND pa.assignment_role='orchestrator'
  JOIN agents a ON a.id=pa.agent_id AND a.enabled
  JOIN runtime_profiles rp ON rp.id=pa.runtime_profile_id
    AND rp.enabled AND rp.runtime_type='codex'
  -- 0063: the conversation's chat session for this agent, in this runtime's
  -- namespace. A model change inside the runtime resumes the same native session.
  LEFT JOIN agent_sessions s ON s.conversation_id=t.conversation_id AND s.role='chat'
    AND s.agent_id=a.id AND s.session_namespace=rp.runtime_type AND s.active
  WHERE j.id=p_job_id AND j.job_type IN ('codex_chat_turn','resume_codex')
    AND j.status='in_flight' AND j.leased_by=p_worker_id
    AND j.leased_until>clock_timestamp();
  IF v_context IS NULL THEN
    PERFORM refuse('orchestration_job_not_leased',
      format('Codex orchestration job %s is not actively leased by worker %s',p_job_id,p_worker_id));
  END IF;
  RETURN v_context;
END; $$;

-- -------------------------------------------------------------- approval

-- 0008's body. The approval is now of something: the evidence of the task's
-- latest implementation, whose digest the event, the audit row and the verdict
-- all carry. Without evidence there is nothing to approve, and it is refused.
--
-- The panel sends no digest, and does not need to: evidence is written only by
-- the completion that moves the task to awaiting_review, before the version
-- that completion produces, and nothing can add evidence to a run once it has
-- completed. So "the current evidence at the expected version" is exactly the
-- evidence the operator was shown at that version.
CREATE OR REPLACE FUNCTION approve_task_review(
  p_project_id uuid,
  p_task_id uuid,
  p_actor_id text,
  p_summary text,
  p_idempotency_key text,
  p_expected_version bigint,
  p_correlation_id text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_command commands%ROWTYPE;
  v_task tasks%ROWTYPE;
  v_event domain_events%ROWTYPE;
  v_evidence review_evidence%ROWTYPE;
  v_verdict review_verdicts%ROWTYPE;
  v_preparation publish_preparations%ROWTYPE;
  v_result jsonb;
BEGIN
  IF p_actor_id IS NULL OR p_summary IS NULL
     OR length(trim(p_actor_id)) < 2 OR length(trim(p_summary)) < 3 THEN
    PERFORM refuse('review_approval_invalid', 'review actor and summary are required', '22023');
  END IF;
  v_command := submit_command(
    p_project_id,p_task_id,'ApproveTaskReview','user',p_actor_id,p_idempotency_key,
    jsonb_build_object('summary',p_summary),p_expected_version,p_correlation_id
  );
  IF v_command.status='completed' THEN RETURN v_command.result; END IF;

  SELECT * INTO v_task FROM tasks
  WHERE id=p_task_id AND project_id=p_project_id FOR UPDATE;
  IF NOT FOUND OR v_task.status<>'awaiting_review' OR v_task.version<>p_expected_version THEN
    PERFORM refuse('task_not_reviewable', 'task is not reviewable at the expected version', '40001');
  END IF;
  IF NOT EXISTS(
    SELECT 1 FROM agents a
    WHERE a.id=v_task.active_agent_id AND a.enabled AND a.role IN ('architect','reviewer')
  ) THEN
    PERFORM refuse('reviewer_unavailable', 'active reviewer is unavailable', '55000');
  END IF;
  SELECT * INTO v_evidence FROM current_review_evidence(p_task_id);
  IF NOT FOUND THEN
    PERFORM refuse('review_evidence_missing',
      format('task %s has no review evidence for its latest implementation; request a revision to record it', p_task_id),
      '55000');
  END IF;

  UPDATE tasks SET status='approved',version=version+1,updated_at=clock_timestamp()
  WHERE id=p_task_id RETURNING * INTO v_task;
  INSERT INTO review_verdicts(project_id, task_id, evidence_id, evidence_digest, verdict, actor_type, actor_id,
    command_id, task_version)
  VALUES (p_project_id, p_task_id, v_evidence.id, v_evidence.evidence_digest, 'approved', 'user', p_actor_id,
    v_command.id, p_expected_version)
  RETURNING * INTO v_verdict;
  v_event:=append_event(
    'review.approved',p_project_id,p_task_id,NULL,'user',p_actor_id,v_command.id,p_correlation_id,
    'review-approved:'||p_idempotency_key,'task',p_task_id,v_task.version,
    jsonb_build_object('summary',p_summary,'reviewer_agent_id',v_task.active_agent_id,
      'evidence_id',v_evidence.id,'evidence_digest',v_evidence.evidence_digest,
      'head_commit_sha',v_evidence.head_commit_sha,'verdict_id',v_verdict.id)
  );
  PERFORM write_audit_event(
    p_project_id,p_task_id,NULL,'user',p_actor_id,'task.review_approved','task',p_task_id::text,
    'allowed',NULL,jsonb_build_object('summary',p_summary,'evidence_digest',v_evidence.evidence_digest),
    p_correlation_id
  );
  -- The approval asks for its own publish preparation, so that the first
  -- recomputation of the digests happens while the reviewed tree is certainly
  -- still there. The operator can ask again before pushing
  -- (request_publish_preparation).
  INSERT INTO publish_preparations(project_id, task_id, verdict_id, evidence_id, evidence_digest,
    requested_by, idempotency_key, correlation_id)
  VALUES (p_project_id, p_task_id, v_verdict.id, v_evidence.id, v_evidence.evidence_digest,
    p_actor_id, 'approval:'||p_idempotency_key, p_correlation_id)
  RETURNING * INTO v_preparation;
  v_result:=jsonb_build_object(
    'status','approved','task_id',p_task_id,'task_version',v_task.version,
    'command_id',v_command.id,'event_id',v_event.id,
    'evidence_digest',v_evidence.evidence_digest,'publish_preparation_id',v_preparation.id
  );
  UPDATE commands SET status='completed',result=v_result,completed_at=clock_timestamp()
  WHERE id=v_command.id;
  RETURN v_result;
END;
$$;

-- ------------------------------------------------------ prepare_publish

-- Another check, asked for right before a manual push. Not granted to the web
-- tier: 11.1b adds no panel action (plan §7), and widening infra_web's surface
-- is done with the action that needs it, not ahead of it (0026's allowlist).
CREATE OR REPLACE FUNCTION request_publish_preparation(
  p_project_id uuid, p_task_id uuid, p_actor_id text, p_idempotency_key text, p_correlation_id text
) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE v_task tasks%ROWTYPE; v_verdict review_verdicts%ROWTYPE; v_row publish_preparations%ROWTYPE;
BEGIN
  IF p_actor_id IS NULL OR length(trim(p_actor_id))<2 OR p_idempotency_key IS NULL OR length(p_idempotency_key)<8 THEN
    PERFORM refuse('publish_observation_invalid', 'a publish preparation needs an actor and an idempotency key', '22023');
  END IF;
  SELECT * INTO v_row FROM publish_preparations p WHERE p.task_id=p_task_id AND p.idempotency_key=p_idempotency_key;
  IF FOUND THEN
    RETURN jsonb_build_object('publish_preparation_id', v_row.id, 'status', v_row.status, 'repeat', true);
  END IF;
  SELECT * INTO v_task FROM tasks t WHERE t.id=p_task_id AND t.project_id=p_project_id;
  IF NOT FOUND OR v_task.status<>'approved' THEN
    PERFORM refuse('publish_task_not_approved', format('task %s is not approved', p_task_id));
  END IF;
  SELECT v.* INTO v_verdict FROM review_verdicts v
  WHERE v.task_id=p_task_id AND v.verdict='approved'
  ORDER BY v.recorded_at DESC LIMIT 1;
  IF NOT FOUND THEN
    PERFORM refuse('review_verdict_missing', format('the approval of task %s names no evidence', p_task_id));
  END IF;
  INSERT INTO publish_preparations(project_id, task_id, verdict_id, evidence_id, evidence_digest,
    requested_by, idempotency_key, correlation_id)
  VALUES (p_project_id, p_task_id, v_verdict.id, v_verdict.evidence_id, v_verdict.evidence_digest,
    p_actor_id, p_idempotency_key, COALESCE(p_correlation_id, p_task_id::text))
  RETURNING * INTO v_row;
  RETURN jsonb_build_object('publish_preparation_id', v_row.id, 'status', v_row.status);
END $$;

-- The supervisor's claim: one preparation, with what it needs to recompute.
CREATE OR REPLACE FUNCTION claim_publish_preparation(p_worker_id text, p_lease interval DEFAULT interval '2 minutes')
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE v_row publish_preparations%ROWTYPE; v_evidence review_evidence%ROWTYPE; v_path text;
BEGIN
  SELECT * INTO v_row FROM publish_preparations p
  WHERE p.status='requested' OR (p.status='claimed' AND p.leased_until<=clock_timestamp())
  ORDER BY p.requested_at
  LIMIT 1 FOR UPDATE SKIP LOCKED;
  IF NOT FOUND THEN RETURN NULL; END IF;
  UPDATE publish_preparations SET status='claimed', leased_by=p_worker_id,
    leased_until=clock_timestamp()+p_lease, attempt_count=attempt_count+1
  WHERE id=v_row.id RETURNING * INTO v_row;
  SELECT * INTO v_evidence FROM review_evidence e WHERE e.id=v_row.evidence_id;
  SELECT pr.workspace_path INTO v_path FROM projects pr WHERE pr.id=v_row.project_id;
  RETURN jsonb_build_object('id', v_row.id, 'project_id', v_row.project_id, 'task_id', v_row.task_id,
    'workspace_path', v_path, 'base_commit_sha', v_evidence.base_commit_sha,
    'evidence_digest', v_row.evidence_digest, 'attempt_count', v_row.attempt_count);
END $$;

CREATE OR REPLACE FUNCTION assert_publish_preparation_claim(p_preparation_id uuid, p_worker_id text)
RETURNS publish_preparations LANGUAGE plpgsql AS $$
DECLARE v_row publish_preparations%ROWTYPE;
BEGIN
  SELECT * INTO v_row FROM publish_preparations p WHERE p.id=p_preparation_id FOR UPDATE;
  IF NOT FOUND OR v_row.status<>'claimed' OR v_row.leased_by IS DISTINCT FROM p_worker_id
     OR v_row.leased_until<=clock_timestamp() THEN
    PERFORM refuse('publish_preparation_not_claimed',
      format('publish preparation %s is not claimed by %s', p_preparation_id, p_worker_id));
  END IF;
  RETURN v_row;
END $$;

-- The boundary. The supervisor recomputed the four digests from the workspace
-- with the evidence's algorithm and base; this compares them with what was
-- approved and refuses a tree or patch that has moved.
CREATE OR REPLACE FUNCTION prepare_publish(p_preparation_id uuid, p_worker_id text, p_observed jsonb)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
  v_row publish_preparations%ROWTYPE; v_task tasks%ROWTYPE; v_evidence review_evidence%ROWTYPE;
  v_moved text[] := ARRAY[]::text[]; v_field text; v_event domain_events%ROWTYPE;
BEGIN
  v_row:=assert_publish_preparation_claim(p_preparation_id, p_worker_id);
  IF p_observed IS NULL OR jsonb_typeof(p_observed)<>'object'
     OR COALESCE(p_observed->>'base_commit_sha','') !~ '^[0-9a-f]{40}([0-9a-f]{24})?$'
     OR COALESCE(p_observed->>'head_commit_sha','') !~ '^[0-9a-f]{40}([0-9a-f]{24})?$'
     OR COALESCE(p_observed->>'worktree_digest','') !~ '^sha256:[0-9a-f]{64}$'
     OR COALESCE(p_observed->>'patch_digest','') !~ '^sha256:[0-9a-f]{64}$' THEN
    PERFORM refuse('publish_observation_invalid',
      'prepare_publish needs the recomputed base, head, worktree digest and patch digest', '22023');
  END IF;
  SELECT * INTO v_task FROM tasks t WHERE t.id=v_row.task_id FOR UPDATE;
  IF v_task.status<>'approved' THEN
    PERFORM refuse('publish_task_not_approved', format('task %s is %s, not approved', v_task.id, v_task.status));
  END IF;
  SELECT * INTO v_evidence FROM review_evidence e WHERE e.id=v_row.evidence_id;

  FOREACH v_field IN ARRAY ARRAY['base_commit_sha','head_commit_sha','worktree_digest','patch_digest'] LOOP
    IF p_observed->>v_field IS DISTINCT FROM to_jsonb(v_evidence)->>v_field THEN
      v_moved:=v_moved || v_field;
    END IF;
  END LOOP;
  IF cardinality(v_moved) > 0 THEN
    PERFORM refuse('review_evidence_digest_moved',
      format('the workspace has moved since evidence %s was approved: %s differ',
        v_evidence.evidence_digest, array_to_string(v_moved, ', ')));
  END IF;
  -- The tree is the approved one. Whether it can be published by pushing a
  -- commit is a separate question, and so is whether the platform's own check
  -- of it passed.
  IF NOT v_evidence.worktree_committed THEN
    PERFORM refuse('publish_worktree_uncommitted',
      format('the approved tree of evidence %s is not the tree of head %s; a push of that commit would not carry it',
        v_evidence.evidence_digest, v_evidence.head_commit_sha));
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(v_evidence.platform_verified_checks) c
             WHERE c->>'status' IS DISTINCT FROM 'passed') THEN
    PERFORM refuse('review_evidence_unverified',
      format('a platform check of evidence %s did not pass', v_evidence.evidence_digest));
  END IF;

  UPDATE publish_preparations SET status='prepared', observed=p_observed,
    head_commit_sha=v_evidence.head_commit_sha, finished_at=clock_timestamp(), leased_until=NULL
  WHERE id=v_row.id RETURNING * INTO v_row;
  v_event:=append_event('publish.prepared', v_row.project_id, v_row.task_id, NULL, 'system', p_worker_id,
    NULL, v_row.correlation_id, 'publish-prepared:'||v_row.id, 'publish_preparation', v_row.id, 1,
    jsonb_build_object('publish_preparation_id', v_row.id, 'evidence_digest', v_row.evidence_digest,
      'head_commit_sha', v_row.head_commit_sha, 'base_commit_sha', v_evidence.base_commit_sha));
  PERFORM write_audit_event(v_row.project_id, v_row.task_id, NULL, 'system', p_worker_id,
    'task.publish_prepared', 'publish_preparation', v_row.id::text, 'allowed', NULL,
    jsonb_build_object('evidence_digest', v_row.evidence_digest, 'head_commit_sha', v_row.head_commit_sha),
    v_row.correlation_id);
  RETURN jsonb_build_object('status', 'prepared', 'publish_preparation_id', v_row.id,
    'evidence_digest', v_row.evidence_digest, 'base_commit_sha', v_evidence.base_commit_sha,
    'head_commit_sha', v_row.head_commit_sha, 'event_id', v_event.id);
END $$;

-- A refusal is an exception, and an exception rolls back everything its
-- transaction wrote. So the supervisor records it in a second call, with the
-- reason the first one raised — a foreign key into the vocabulary.
CREATE OR REPLACE FUNCTION record_publish_refusal(
  p_preparation_id uuid, p_worker_id text, p_reason text, p_message text
) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE v_row publish_preparations%ROWTYPE;
BEGIN
  v_row:=assert_publish_preparation_claim(p_preparation_id, p_worker_id);
  IF p_reason IS NULL OR NOT EXISTS (SELECT 1 FROM failure_reasons r WHERE r.reason=p_reason) THEN
    PERFORM refuse('unknown_failure_reason',
      format('a publish refusal named the reason %s, which is not in the vocabulary', COALESCE(p_reason,'(none)')));
  END IF;
  UPDATE publish_preparations SET status='refused', refusal_reason=p_reason,
    refusal_message=left(COALESCE(p_message,''), 1000), finished_at=clock_timestamp(), leased_until=NULL
  WHERE id=v_row.id RETURNING * INTO v_row;
  PERFORM append_event('publish.refused', v_row.project_id, v_row.task_id, NULL, 'system', p_worker_id,
    NULL, v_row.correlation_id, 'publish-refused:'||v_row.id, 'publish_preparation', v_row.id, 1,
    jsonb_build_object('publish_preparation_id', v_row.id, 'evidence_digest', v_row.evidence_digest,
      'reason', p_reason, 'message', v_row.refusal_message));
  PERFORM write_audit_event(v_row.project_id, v_row.task_id, NULL, 'system', p_worker_id,
    'task.publish_refused', 'publish_preparation', v_row.id::text, 'denied', NULL,
    jsonb_build_object('evidence_digest', v_row.evidence_digest, 'reason', p_reason), v_row.correlation_id);
  RETURN jsonb_build_object('status', 'refused', 'publish_preparation_id', v_row.id, 'reason', p_reason);
END $$;

-- ---------------------------------------------------------------- grants

ALTER FUNCTION refuse_review_record_change() SET search_path=control_plane,public,extensions,pg_temp;
ALTER FUNCTION review_evidence_digest(uuid,bigint,text,text,text,text) SET search_path=control_plane,public,extensions,pg_temp;
ALTER FUNCTION review_evidence_base(uuid) SET search_path=control_plane,public,extensions,pg_temp;
ALTER FUNCTION current_review_evidence(uuid) SET search_path=control_plane,public,extensions,pg_temp;
ALTER FUNCTION assert_supervised_implementation(bigint,text,uuid,bigint) SET search_path=control_plane,public,extensions,pg_temp;
ALTER FUNCTION record_review_base(bigint,text,uuid,bigint,text) SET search_path=control_plane,public,extensions,pg_temp;
ALTER FUNCTION record_review_evidence(bigint,text,uuid,bigint,jsonb) SET search_path=control_plane,public,extensions,pg_temp;
ALTER FUNCTION finalize_worker_completion(uuid,bigint,text) SET search_path=control_plane,public,extensions,pg_temp;
ALTER FUNCTION deliver_review_evidence(bigint,text) SET search_path=control_plane,public,extensions,pg_temp;
ALTER FUNCTION invoke_codex_request_revision(bigint,text,text,jsonb) SET search_path=control_plane,public,extensions,pg_temp;
ALTER FUNCTION codex_chat_job_context(bigint,text) SET search_path=control_plane,public,extensions,pg_temp;
-- CREATE OR REPLACE resets the SET clause (0062); approve keeps 0008's.
ALTER FUNCTION approve_task_review(uuid,uuid,text,text,text,bigint,text) SET search_path=control_plane,pg_temp;
ALTER FUNCTION request_publish_preparation(uuid,uuid,text,text,text) SET search_path=control_plane,public,extensions,pg_temp;
ALTER FUNCTION claim_publish_preparation(text,interval) SET search_path=control_plane,public,extensions,pg_temp;
ALTER FUNCTION assert_publish_preparation_claim(uuid,text) SET search_path=control_plane,public,extensions,pg_temp;
ALTER FUNCTION prepare_publish(uuid,text,jsonb) SET search_path=control_plane,public,extensions,pg_temp;
ALTER FUNCTION record_publish_refusal(uuid,text,text,text) SET search_path=control_plane,public,extensions,pg_temp;

REVOKE EXECUTE ON FUNCTION refuse_review_record_change() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION review_evidence_digest(uuid,bigint,text,text,text,text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION review_evidence_base(uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION current_review_evidence(uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION assert_supervised_implementation(bigint,text,uuid,bigint) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION record_review_base(bigint,text,uuid,bigint,text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION record_review_evidence(bigint,text,uuid,bigint,jsonb) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION deliver_review_evidence(bigint,text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION request_publish_preparation(uuid,uuid,text,text,text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION claim_publish_preparation(text,interval) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION assert_publish_preparation_claim(uuid,text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION prepare_publish(uuid,text,jsonb) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION record_publish_refusal(uuid,text,text,text) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION refuse_review_record_change() TO infra_worker;
GRANT EXECUTE ON FUNCTION review_evidence_digest(uuid,bigint,text,text,text,text) TO infra_worker;
GRANT EXECUTE ON FUNCTION review_evidence_base(uuid) TO infra_worker;
GRANT EXECUTE ON FUNCTION current_review_evidence(uuid) TO infra_worker;
GRANT EXECUTE ON FUNCTION assert_supervised_implementation(bigint,text,uuid,bigint) TO infra_worker;
GRANT EXECUTE ON FUNCTION record_review_base(bigint,text,uuid,bigint,text) TO infra_worker;
GRANT EXECUTE ON FUNCTION record_review_evidence(bigint,text,uuid,bigint,jsonb) TO infra_worker;
GRANT EXECUTE ON FUNCTION deliver_review_evidence(bigint,text) TO infra_worker;
GRANT EXECUTE ON FUNCTION request_publish_preparation(uuid,uuid,text,text,text) TO infra_worker;
GRANT EXECUTE ON FUNCTION claim_publish_preparation(text,interval) TO infra_worker;
GRANT EXECUTE ON FUNCTION assert_publish_preparation_claim(uuid,text) TO infra_worker;
GRANT EXECUTE ON FUNCTION prepare_publish(uuid,text,jsonb) TO infra_worker;
GRANT EXECUTE ON FUNCTION record_publish_refusal(uuid,text,text,text) TO infra_worker;

-- The web tier's approval must still run as its owner — it now writes
-- review_verdicts and publish_preparations, which infra_web cannot touch — and
-- the guard 0062 added is what says so.
SELECT assert_web_functions_run_as_definer();
