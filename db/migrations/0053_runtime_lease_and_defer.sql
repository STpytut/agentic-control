-- Stage 11A: the lease a worker holds, stated by the database.
--
-- Numbered 0053, not 0051. The Stage 11.0 rehearsal shipped
-- `0051_rehearsal_additive_marker.sql` and `0052_rehearsal_incompatible_drop.sql`
-- in tagged release candidates and applied them to the VPS. The ledger is keyed
-- by version, not by name, so reusing either number would meet a recorded
-- checksum that is not this file's and stop the update — and the answer to a
-- deployed checksum is never to rewrite it.
--
-- A worker's authority to act is bounded by the lease its claim granted. Until
-- now the worker computed that boundary itself, as `Date.now()` plus the
-- interval it had asked for — after the claim had already returned. Two things
-- are wrong with that and both extend the worker's authority silently: the
-- response takes time that is not counted, and the worker's clock is not the
-- database's.
--
-- So every claim now returns `lease_expires_at`: the absolute moment, from the
-- same row and the same clock that granted it.
--
-- And every claim gains a way to be handed back. `fail_*` is terminal — a
-- rejected model, a failed login — which is the wrong record for "this worker
-- ran out of lease" or "a runtime installation was in progress". Letting the
-- lease lapse was the previous answer and it does not requeue: an OpenCode
-- enrollment stays `claimed` and is never selected again, and a catalog entry
-- returns to `discovered` with `gate_requested_at` already cleared, so nothing
-- asks for it a second time. `defer_*` puts the work back where a claim can
-- find it, and says nothing about whether it would have succeeded.
--
-- No BEGIN/COMMIT. Every migration after 0038 is wrapped by the runner, which is
-- what makes apply, verify and stamp one transaction; `migrate.mjs` refuses a
-- file that runs its own. This one shipped with them, and so could not be
-- applied at all — `check-lease-contract.sh` did not notice because it feeds the
-- files to `psql` directly and never asks the runner.

-- Without this the functions are created in `public`, which is not where
-- anything looks for them: the claim the workers call would still be the old
-- one, and a run against a real database is the only thing that says so.
SET search_path TO control_plane, public, extensions;

CREATE OR REPLACE FUNCTION claim_opencode_enrollments(
  p_worker_id text, p_limit integer DEFAULT 1, p_lease interval DEFAULT interval '90 seconds'
) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE v_result jsonb;
BEGIN
  PERFORM expire_opencode_enrollments();
  WITH candidates AS (
    SELECT e.id FROM provider_secret_enrollments e
    WHERE e.provider='opencode' AND e.status='provisioned' AND e.expires_at>clock_timestamp()
      AND (e.broker_leased_until IS NULL OR e.broker_leased_until<=clock_timestamp())
    ORDER BY e.created_at FOR UPDATE SKIP LOCKED LIMIT GREATEST(p_limit,0)
  ), claimed AS (
    UPDATE provider_secret_enrollments e SET
      status='claimed', broker_leased_by=p_worker_id,
      broker_leased_until=LEAST(e.expires_at,clock_timestamp()+p_lease),
      updated_at=clock_timestamp()
    FROM candidates c WHERE e.id=c.id RETURNING e.*
  )
  SELECT jsonb_agg(jsonb_build_object(
    'lease_expires_at',broker_leased_until,
    
    'enrollment_id',id,'connection_id',connection_id,'operator_id',operator_id,
    'billing_boundary',billing_boundary,'key_fingerprint',key_fingerprint,
    'ciphertext',encode(secret_ciphertext,'base64'),'iv',encode(secret_iv,'base64'),
    'tag',encode(secret_auth_tag,'base64'),'key_wrap',encode(key_wrap_ciphertext,'base64'),
    'expires_at',expires_at)) INTO v_result FROM claimed;
  RETURN COALESCE(v_result,'[]'::jsonb);
END; $$;

ALTER FUNCTION claim_opencode_enrollments(text,integer,interval)
  SET search_path=control_plane,public,extensions,pg_temp;

CREATE OR REPLACE FUNCTION claim_opencode_connection_work(
  p_worker_id text, p_limit integer DEFAULT 1, p_lease interval DEFAULT interval '90 seconds'
) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE v_result jsonb;
BEGIN
  WITH candidates AS (
    SELECT id FROM provider_connections
    WHERE provider='opencode' AND billing_boundary<>'free'
      AND broker_requested_action IN ('verify','disconnect')
      AND (broker_leased_until IS NULL OR broker_leased_until<=clock_timestamp())
    ORDER BY updated_at FOR UPDATE SKIP LOCKED LIMIT GREATEST(p_limit,0)
  ), claimed AS (
    UPDATE provider_connections c SET
      broker_leased_by=p_worker_id, broker_leased_until=clock_timestamp()+p_lease
    FROM candidates x WHERE c.id=x.id RETURNING c.*
  )
  SELECT jsonb_agg(jsonb_build_object(
    'lease_expires_at',broker_leased_until,
    
    'connection_id',id,'operator_id',operator_id,'work_kind',broker_requested_action,
    'current_status',status,'billing_boundary',billing_boundary)) INTO v_result FROM claimed;
  RETURN COALESCE(v_result,'[]'::jsonb);
END; $$;

ALTER FUNCTION claim_opencode_connection_work(text,integer,interval)
  SET search_path=control_plane,public,extensions,pg_temp;

CREATE OR REPLACE FUNCTION claim_codex_login_sessions(
  p_worker_id text, p_limit integer DEFAULT 1, p_lease interval DEFAULT interval '16 minutes'
) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE v_result jsonb;
BEGIN
  UPDATE provider_login_sessions SET
    status='expired', failure_code='device_code_expired',
    device_verification_url='', device_user_code='', native_login_id='',
    broker_leased_by=NULL, broker_leased_until=NULL
  WHERE provider='codex' AND status='pending' AND expires_at<=clock_timestamp();

  UPDATE provider_connections c SET
    status='expired', last_failure_code='device_code_expired',
    last_failure_message='The Codex device authorization expired. Reconnect to try again.',
    updated_at=clock_timestamp(), version=version+1
  WHERE c.provider='codex' AND c.status='pending_finalize'
    AND EXISTS (
      SELECT 1 FROM provider_login_sessions s
      WHERE s.connection_id=c.id AND s.provider='codex'
        AND s.status='expired' AND s.failure_code='device_code_expired'
    )
    AND NOT EXISTS (
      SELECT 1 FROM provider_login_sessions s
      WHERE s.connection_id=c.id AND s.provider='codex' AND s.status='pending'
    );

  WITH candidates AS (
    SELECT s.id FROM provider_login_sessions s
    WHERE s.provider='codex' AND s.status='pending'
      AND s.expires_at>clock_timestamp()
      AND (s.broker_leased_until IS NULL OR s.broker_leased_until<=clock_timestamp())
    ORDER BY s.created_at
    FOR UPDATE SKIP LOCKED LIMIT GREATEST(p_limit,0)
  ), claimed AS (
    UPDATE provider_login_sessions s SET
      broker_leased_by=p_worker_id,
      broker_leased_until=LEAST(s.expires_at,clock_timestamp()+p_lease)
    FROM candidates c WHERE s.id=c.id
    RETURNING s.*
  )
  SELECT jsonb_agg(jsonb_build_object(
    'lease_expires_at',broker_leased_until,
    
    'session_id',id,'connection_id',connection_id,'operator_id',operator_id,
    'expires_at',expires_at
  )) INTO v_result FROM claimed;
  RETURN COALESCE(v_result,'[]'::jsonb);
END; $$;

ALTER FUNCTION claim_codex_login_sessions(text,integer,interval)
  SET search_path=control_plane,public,extensions,pg_temp;

CREATE OR REPLACE FUNCTION claim_codex_connection_work(
  p_worker_id text, p_limit integer DEFAULT 1, p_lease interval DEFAULT interval '90 seconds'
) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE v_result jsonb;
BEGIN
  WITH candidates AS (
    SELECT id FROM provider_connections
    WHERE provider='codex' AND broker_requested_action IN ('verify','disconnect')
      AND (broker_leased_until IS NULL OR broker_leased_until<=clock_timestamp())
    ORDER BY updated_at FOR UPDATE SKIP LOCKED LIMIT GREATEST(p_limit,0)
  ), claimed AS (
    UPDATE provider_connections c SET
      broker_leased_by=p_worker_id, broker_leased_until=clock_timestamp()+p_lease
    FROM candidates x WHERE c.id=x.id RETURNING c.*
  )
  SELECT jsonb_agg(jsonb_build_object(
    'lease_expires_at',broker_leased_until,
    
    'connection_id',id,'operator_id',operator_id,
    'work_kind',broker_requested_action,'current_status',status
  )) INTO v_result FROM claimed;
  RETURN COALESCE(v_result,'[]'::jsonb);
END; $$;

ALTER FUNCTION claim_codex_connection_work(text,integer,interval)
  SET search_path=control_plane,public,extensions,pg_temp;

CREATE OR REPLACE FUNCTION claim_catalog_verifications(
  p_worker_id text, p_limit integer DEFAULT 1, p_lease interval DEFAULT interval '10 minutes'
) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE v_result jsonb; v_op uuid;
BEGIN
  UPDATE provider_model_catalog SET
    status='discovered', verified_lease_until=NULL, verification_id=NULL,
    updated_at=clock_timestamp(), version=version+1
  WHERE status='verifying' AND verified_lease_until<=clock_timestamp();

  -- Serialize claims per operator (deterministic order avoids deadlocks) so
  -- the remaining-slot computation below is consistent across transactions.
  FOR v_op IN
    SELECT DISTINCT m.operator_id
    FROM provider_model_catalog m
    JOIN provider_connections c ON c.id=m.connection_id
    WHERE m.status='discovered' AND c.status='connected'
      AND m.gate_requested_at IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM catalog_gate_allowlist a
        WHERE a.operator_id=m.operator_id AND a.connection_id=m.connection_id
          AND a.provider_id=m.provider_id AND a.model_id=m.model_id
      )
    ORDER BY m.operator_id
  LOOP
    PERFORM pg_advisory_xact_lock(hashtextextended('catalog-gate-quota:' || v_op::text, 0));
  END LOOP;

  WITH eligible AS (
    SELECT m.id, m.operator_id, m.gate_requested_at
    FROM provider_model_catalog m
    JOIN provider_connections c ON c.id=m.connection_id
    WHERE m.status='discovered' AND c.status='connected'
      AND m.gate_requested_at IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM catalog_gate_allowlist a
        WHERE a.operator_id=m.operator_id AND a.connection_id=m.connection_id
          AND a.provider_id=m.provider_id AND a.model_id=m.model_id
      )
  ), quotas AS (
    SELECT e.operator_id,
      GREATEST(0, 2 - (SELECT count(*) FROM provider_model_catalog m2
        WHERE m2.operator_id=e.operator_id AND m2.status='verifying')) AS remaining_concurrency,
      GREATEST(0, 20 - (SELECT count(*) FROM model_verification_receipts r
        WHERE r.operator_id=e.operator_id
          AND r.verified_at>clock_timestamp()-interval '24 hours')
        - (SELECT count(*) FROM provider_model_catalog m3
          WHERE m3.operator_id=e.operator_id AND m3.status='verifying')) AS remaining_daily
    FROM (SELECT DISTINCT operator_id FROM eligible) e
  ), ranked AS (
    SELECT e.id, row_number() OVER (
      PARTITION BY e.operator_id ORDER BY e.gate_requested_at, e.id
    ) AS rn
    FROM eligible e
  ), allowed AS (
    SELECT r.id FROM ranked r
    JOIN eligible e ON e.id=r.id
    JOIN quotas q ON q.operator_id=e.operator_id
    WHERE r.rn <= LEAST(q.remaining_concurrency, q.remaining_daily)
  ), candidates AS (
    SELECT a.id FROM allowed a
    ORDER BY (SELECT gate_requested_at FROM eligible e WHERE e.id=a.id), a.id
    FOR UPDATE SKIP LOCKED LIMIT GREATEST(p_limit,0)
  ), claimed AS (
    UPDATE provider_model_catalog m SET
      status='verifying', verified_lease_until=clock_timestamp()+p_lease,
      verification_id=gen_random_uuid(),
      gate_requested_at=NULL,
      updated_at=clock_timestamp(), version=version+1
    FROM candidates c WHERE m.id=c.id
    RETURNING m.*
  )
  SELECT jsonb_agg(jsonb_build_object(
    'lease_expires_at',verified_lease_until,
    
    'entry_id',id,'connection_id',connection_id,'operator_id',operator_id,
    'runtime_type',runtime_type,'provider_id',provider_id,'model_id',model_id,
    'billing_boundary',billing_boundary,'reasoning_efforts',reasoning_efforts,
    'service_tiers',service_tiers,'adapter_version',adapter_version,
    'runtime_version',runtime_version,'verification_id',verification_id
  )) INTO v_result FROM claimed;
  RETURN COALESCE(v_result,'[]'::jsonb);
END; $$;

ALTER FUNCTION claim_catalog_verifications(text,integer,interval)
  SET search_path=control_plane,public,extensions,pg_temp;

CREATE OR REPLACE FUNCTION claim_catalog_refresh_work(
  p_worker_id text, p_limit integer DEFAULT 1, p_lease interval DEFAULT interval '2 minutes'
) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE v_result jsonb;
BEGIN
  UPDATE catalog_refresh_jobs SET
    status='failed', failure_code='refresh_lease_expired',
    failure_message='The catalog refresh lease expired before the worker claimed it.',
    leased_by=NULL, leased_until=NULL
  WHERE status='in_progress' AND leased_until<=clock_timestamp();

  WITH candidates AS (
    SELECT j.id FROM catalog_refresh_jobs j
    WHERE j.status='pending' AND (j.leased_until IS NULL OR j.leased_until<=clock_timestamp())
    ORDER BY j.created_at
    FOR UPDATE SKIP LOCKED LIMIT GREATEST(p_limit,0)
  ), claimed AS (
    UPDATE catalog_refresh_jobs j SET
      status='in_progress', leased_by=p_worker_id, leased_until=clock_timestamp()+p_lease
    FROM candidates c WHERE j.id=c.id
    RETURNING j.*
  )
  SELECT jsonb_agg(jsonb_build_object(
    'lease_expires_at',leased_until,
    
    'refresh_id',id,'connection_id',connection_id,'operator_id',operator_id,
    'reason',reason,'leased_until',leased_until,
    'provider',(SELECT c.provider FROM provider_connections c WHERE c.id=connection_id),
    'billing_boundary',(SELECT c.billing_boundary FROM provider_connections c WHERE c.id=connection_id),
    'permissions',(SELECT c.permissions FROM provider_connections c WHERE c.id=connection_id)
  )) INTO v_result FROM claimed;
  RETURN COALESCE(v_result,'[]'::jsonb);
END; $$;

ALTER FUNCTION claim_catalog_refresh_work(text,integer,interval)
  SET search_path=control_plane,public,extensions,pg_temp;

-- Handing work back ---------------------------------------------------------

-- Each of these returns the work to the state a claim selects, and only when
-- this worker is the one holding it: a worker whose lease has already been
-- taken by somebody else must not reach into their claim.

CREATE OR REPLACE FUNCTION defer_opencode_enrollment(
  p_enrollment_id uuid, p_worker_id text
) RETURNS jsonb LANGUAGE plpgsql AS $$
BEGIN
  PERFORM 1 FROM provider_secret_enrollments
  WHERE id=p_enrollment_id AND status='claimed' AND broker_leased_by=p_worker_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('status','not_held','enrollment_id',p_enrollment_id);
  END IF;
  -- Back to `provisioned`, which is what `claim_opencode_enrollments` selects.
  -- Leaving it `claimed` is what made the work disappear.
  UPDATE provider_secret_enrollments SET
    status='provisioned', broker_leased_by=NULL, broker_leased_until=NULL,
    updated_at=clock_timestamp()
  WHERE id=p_enrollment_id;
  RETURN jsonb_build_object('status','deferred','enrollment_id',p_enrollment_id);
END; $$;

CREATE OR REPLACE FUNCTION defer_provider_connection_work(
  p_connection_id uuid, p_worker_id text
) RETURNS jsonb LANGUAGE plpgsql AS $$
BEGIN
  PERFORM 1 FROM provider_connections
  WHERE id=p_connection_id AND broker_leased_by=p_worker_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('status','not_held','connection_id',p_connection_id);
  END IF;
  -- The requested action is kept; only the lease is given up.
  UPDATE provider_connections SET
    broker_leased_by=NULL, broker_leased_until=NULL, updated_at=clock_timestamp()
  WHERE id=p_connection_id;
  RETURN jsonb_build_object('status','deferred','connection_id',p_connection_id);
END; $$;

CREATE OR REPLACE FUNCTION defer_codex_login_session(
  p_session_id uuid, p_worker_id text
) RETURNS jsonb LANGUAGE plpgsql AS $$
BEGIN
  PERFORM 1 FROM provider_login_sessions
  WHERE id=p_session_id AND broker_leased_by=p_worker_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('status','not_held','session_id',p_session_id);
  END IF;
  -- Still `pending`, so it is claimable again for as long as the device code
  -- the operator is typing has not expired. The device code, not this lease, is
  -- what ends a login.
  UPDATE provider_login_sessions SET
    broker_leased_by=NULL, broker_leased_until=NULL, updated_at=clock_timestamp()
  WHERE id=p_session_id AND status='pending';
  RETURN jsonb_build_object('status','deferred','session_id',p_session_id);
END; $$;

CREATE OR REPLACE FUNCTION defer_catalog_verification(
  p_entry_id uuid, p_worker_id text, p_verification_id uuid
) RETURNS jsonb LANGUAGE plpgsql AS $$
BEGIN
  PERFORM 1 FROM provider_model_catalog
  -- The catalog table has no worker column; a verification is held by the id
  -- the claim issued, and that is what identifies the holder.
  WHERE id=p_entry_id AND status='verifying' AND verification_id=p_verification_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('status','not_held','entry_id',p_entry_id);
  END IF;
  -- `discovered` alone is not enough: the claim also requires
  -- `gate_requested_at`, which claiming cleared. Restoring one without the other
  -- is how an entry came back to a state nothing selects.
  UPDATE provider_model_catalog SET
    status='discovered', verified_lease_until=NULL,
    verification_id=NULL, gate_requested_at=clock_timestamp(),
    updated_at=clock_timestamp()
  WHERE id=p_entry_id;
  RETURN jsonb_build_object('status','deferred','entry_id',p_entry_id);
END; $$;

CREATE OR REPLACE FUNCTION defer_catalog_refresh(
  p_refresh_id uuid, p_worker_id text
) RETURNS jsonb LANGUAGE plpgsql AS $$
BEGIN
  PERFORM 1 FROM catalog_refresh_jobs
  WHERE id=p_refresh_id AND leased_by=p_worker_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('status','not_held','refresh_id',p_refresh_id);
  END IF;
  UPDATE catalog_refresh_jobs SET
    status='pending', leased_by=NULL, leased_until=NULL, updated_at=clock_timestamp()
  WHERE id=p_refresh_id;
  RETURN jsonb_build_object('status','deferred','refresh_id',p_refresh_id);
END; $$;

ALTER FUNCTION defer_opencode_enrollment(uuid,text)
  SET search_path=control_plane,public,extensions,pg_temp;
ALTER FUNCTION defer_provider_connection_work(uuid,text)
  SET search_path=control_plane,public,extensions,pg_temp;
ALTER FUNCTION defer_codex_login_session(uuid,text)
  SET search_path=control_plane,public,extensions,pg_temp;
ALTER FUNCTION defer_catalog_verification(uuid,text,uuid)
  SET search_path=control_plane,public,extensions,pg_temp;
ALTER FUNCTION defer_catalog_refresh(uuid,text)
  SET search_path=control_plane,public,extensions,pg_temp;

-- Who may call these, stated here rather than inherited.
--
-- PostgreSQL grants EXECUTE on every new function to PUBLIC. 0038 turned that
-- off with `ALTER DEFAULT PRIVILEGES ... REVOKE EXECUTE ON FUNCTIONS FROM
-- PUBLIC`, and relying on it was a mistake this branch made and the production
-- host found: `pg_default_acl` on that host carries the three schema-scoped rows
-- and **not** the global one, so every function created here came out world-
-- executable and `assert_no_public_function_execute()` — the defence 0038 added
-- for exactly this — stopped the migration and rolled it back.
--
-- A default is a property of the database it is set in. An explicit grant is a
-- property of the migration, and travels with it to a host whose history nobody
-- present remembers. `infra_worker` is the execution layer and the only caller:
-- the web tier hands work over, it does not hand it back.
REVOKE EXECUTE ON FUNCTION defer_opencode_enrollment(uuid,text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION defer_provider_connection_work(uuid,text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION defer_codex_login_session(uuid,text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION defer_catalog_verification(uuid,text,uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION defer_catalog_refresh(uuid,text) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION defer_opencode_enrollment(uuid,text) TO infra_worker;
GRANT EXECUTE ON FUNCTION defer_provider_connection_work(uuid,text) TO infra_worker;
GRANT EXECUTE ON FUNCTION defer_codex_login_session(uuid,text) TO infra_worker;
GRANT EXECUTE ON FUNCTION defer_catalog_verification(uuid,text,uuid) TO infra_worker;
GRANT EXECUTE ON FUNCTION defer_catalog_refresh(uuid,text) TO infra_worker;
