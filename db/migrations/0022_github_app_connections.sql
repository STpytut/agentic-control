BEGIN;

SET search_path TO control_plane, public, extensions;

-- Owner-scoped GitHub App provider connections, short-lived login sessions and an
-- installation-scoped repository cache. Installation tokens, JWTs and the GitHub
-- App private key are never stored in these tables; only safe metadata and a
-- non-secret native credential reference are persisted.

CREATE TABLE provider_connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  operator_id uuid NOT NULL REFERENCES users(id),
  provider text NOT NULL CHECK (provider IN ('github','codex','opencode')),
  auth_method text NOT NULL CHECK (auth_method IN ('github_app','deploy_key','device_code','api_key')),
  status text NOT NULL DEFAULT 'pending_finalize'
    CHECK (status IN ('pending_finalize','connected','action_required','expired','disconnected')),
  account_label text NOT NULL DEFAULT '',
  installation_label text NOT NULL DEFAULT '',
  native_credential_reference text NOT NULL DEFAULT '',
  external_account_id text NOT NULL DEFAULT '',
  external_installation_id text NOT NULL DEFAULT '',
  repository_selection text NOT NULL DEFAULT '' CHECK (repository_selection IN ('','all','selected')),
  permissions jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_verified_at timestamptz,
  verify_requested_at timestamptz,
  last_failure_code text NOT NULL DEFAULT '',
  last_failure_message text NOT NULL DEFAULT '',
  broker_leased_by text,
  broker_leased_until timestamptz,
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (auth_method <> 'github_app' OR external_installation_id ~ '^[0-9]+$'),
  CHECK (last_failure_message = left(last_failure_message, 500)),
  CHECK (broker_leased_by IS NULL = (broker_leased_until IS NULL)),
  CHECK (provider <> 'github' OR auth_method = 'github_app')
);

CREATE UNIQUE INDEX provider_connections_operator_installation_unique
  ON provider_connections(operator_id, provider, external_installation_id)
  WHERE external_installation_id <> '';
CREATE INDEX provider_connections_operator_status
  ON provider_connections(operator_id, provider, status);
CREATE INDEX provider_connections_broker_work
  ON provider_connections(status, broker_leased_until)
  WHERE status IN ('pending_finalize','action_required','expired');

CREATE TABLE provider_login_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  operator_id uuid NOT NULL REFERENCES users(id),
  provider text NOT NULL CHECK (provider IN ('github','codex','opencode')),
  state_digest text NOT NULL CHECK (state_digest ~ '^[0-9a-f]{64}$'),
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','consumed','expired','failed')),
  expires_at timestamptz NOT NULL DEFAULT clock_timestamp() + interval '10 minutes',
  consumed_at timestamptz,
  failure_code text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (expires_at > created_at),
  CHECK (status <> 'consumed' OR consumed_at IS NOT NULL)
);

CREATE INDEX provider_login_sessions_state_lookup
  ON provider_login_sessions(operator_id, provider, state_digest)
  WHERE status = 'pending';

CREATE TABLE provider_installation_repositories (
  connection_id uuid NOT NULL REFERENCES provider_connections(id),
  github_repository_id bigint NOT NULL CHECK (github_repository_id > 0),
  full_name text NOT NULL CHECK (full_name ~ '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$'),
  private boolean NOT NULL DEFAULT false,
  archived boolean NOT NULL DEFAULT false,
  default_branch text NOT NULL DEFAULT '',
  clone_url text NOT NULL CHECK (clone_url ~ '^https://github\.com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+(\.git)?$'),
  verified_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (connection_id, github_repository_id)
);

CREATE INDEX provider_installation_repositories_connection
  ON provider_installation_repositories(connection_id, full_name);

ALTER TABLE projects
  ADD COLUMN credential_mode text NOT NULL DEFAULT 'empty'
    CHECK (credential_mode IN ('empty','deploy_key','github_app')),
  ADD COLUMN provider_connection_id uuid REFERENCES provider_connections(id),
  ADD COLUMN github_repository_id bigint CHECK (github_repository_id IS NULL OR github_repository_id > 0),
  ADD COLUMN repository_full_name text CHECK (repository_full_name IS NULL OR repository_full_name ~ '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$'),
  ADD CONSTRAINT projects_github_app_binding CHECK (
    (credential_mode <> 'github_app')
    OR (provider_connection_id IS NOT NULL AND github_repository_id IS NOT NULL AND repository_full_name IS NOT NULL)
  ),
  ADD CONSTRAINT projects_repository_url_no_credentials CHECK (
    repository_url IS NULL OR repository_url !~ '@'
  );

UPDATE projects
  SET credential_mode = CASE WHEN repository_url IS NULL THEN 'empty' ELSE 'deploy_key' END
  WHERE credential_mode = 'empty' AND repository_url IS NOT NULL;

CREATE INDEX projects_github_app_clone_work
  ON projects(credential_mode, status)
  WHERE credential_mode = 'github_app';

CREATE OR REPLACE FUNCTION start_provider_login_session(
  p_operator_id uuid, p_provider text, p_state_digest text, p_ttl interval DEFAULT interval '10 minutes'
) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE v_id uuid;
BEGIN
  IF p_state_digest !~ '^[0-9a-f]{64}$' OR p_ttl <= interval '0 seconds' THEN
    RAISE EXCEPTION 'invalid provider login session parameters' USING ERRCODE='22023';
  END IF;
  INSERT INTO provider_login_sessions(operator_id, provider, state_digest, expires_at)
  VALUES(p_operator_id, p_provider, p_state_digest, clock_timestamp()+p_ttl)
  RETURNING id INTO v_id;
  PERFORM write_audit_event(NULL,NULL,NULL,'operator',p_operator_id::text,'provider.connection_started',
    'provider_connection',v_id::text,'allowed',NULL,
    jsonb_build_object('provider',p_provider),v_id::text);
  RETURN v_id;
END; $$;

CREATE OR REPLACE FUNCTION consume_provider_login_session(
  p_operator_id uuid, p_provider text, p_state_digest text
) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE v_session provider_login_sessions%ROWTYPE;
BEGIN
  IF p_state_digest !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'invalid login state' USING ERRCODE='22023';
  END IF;
  SELECT * INTO v_session FROM provider_login_sessions
  WHERE operator_id=p_operator_id AND provider=p_provider AND state_digest=p_state_digest
    AND status='pending' AND expires_at>clock_timestamp()
  FOR UPDATE;
  IF NOT FOUND THEN
    PERFORM write_audit_event(NULL,NULL,NULL,'operator',p_operator_id::text,'provider.connection_callback_denied',
      'provider_login_session',COALESCE(p_state_digest,'invalid'),'denied',NULL,
      jsonb_build_object('provider',p_provider,'reason','state_not_found_or_expired'),p_operator_id::text);
    RAISE EXCEPTION 'GitHub login session is invalid, expired or already used' USING ERRCODE='55000';
  END IF;
  UPDATE provider_login_sessions SET status='consumed', consumed_at=clock_timestamp()
  WHERE id=v_session.id;
  RETURN jsonb_build_object('session_id',v_session.id,'provider',v_session.provider);
END; $$;

CREATE OR REPLACE FUNCTION create_pending_github_connection(
  p_operator_id uuid, p_installation_id text, p_setup_action text, p_correlation_id text
) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE v_existing provider_connections%ROWTYPE; v_id uuid; v_action text;
BEGIN
  IF p_installation_id !~ '^[0-9]+$' THEN
    RAISE EXCEPTION 'invalid GitHub installation id' USING ERRCODE='22023';
  END IF;
  SELECT * INTO v_existing FROM provider_connections
  WHERE operator_id=p_operator_id AND provider='github' AND external_installation_id=p_installation_id
  FOR UPDATE;
  v_action := CASE WHEN v_existing.id IS NULL THEN 'provider.connection_created' ELSE 'provider.reconnect_started' END;
  IF v_existing.id IS NULL THEN
    INSERT INTO provider_connections(operator_id, provider, auth_method, status, external_installation_id,
      native_credential_reference, version)
    VALUES(p_operator_id,'github','github_app','pending_finalize',p_installation_id,'github-app-private-key',1)
    RETURNING id INTO v_id;
  ELSE
    UPDATE provider_connections SET status='pending_finalize', broker_leased_by=NULL, broker_leased_until=NULL,
      last_failure_code='', last_failure_message='', verify_requested_at=NULL,
      updated_at=clock_timestamp(), version=version+1
    WHERE id=v_existing.id RETURNING id INTO v_id;
  END IF;
  PERFORM write_audit_event(NULL,NULL,NULL,'operator',p_operator_id::text,v_action,
    'provider_connection',v_id::text,'allowed',NULL,
    jsonb_build_object('provider','github','installation_id',p_installation_id,'setup_action',COALESCE(p_setup_action,'')),
    COALESCE(p_correlation_id,p_operator_id::text));
  RETURN v_id;
END; $$;

CREATE OR REPLACE FUNCTION activate_github_connection(
  p_connection_id uuid, p_worker_id text, p_account_label text, p_installation_label text,
  p_external_account_id text, p_permissions jsonb, p_repository_selection text
) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE v provider_connections%ROWTYPE;
BEGIN
  SELECT * INTO v FROM provider_connections WHERE id=p_connection_id FOR UPDATE;
  IF NOT FOUND OR v.provider<>'github' OR v.status='disconnected' THEN
    RAISE EXCEPTION 'github connection is not finalizable' USING ERRCODE='55000';
  END IF;
  UPDATE provider_connections SET status='connected',
    account_label=left(COALESCE(p_account_label,''),160),
    installation_label=left(COALESCE(p_installation_label,''),160),
    external_account_id=left(COALESCE(p_external_account_id,''),64),
    permissions=COALESCE(p_permissions,'{}'::jsonb),
    repository_selection=COALESCE(NULLIF(p_repository_selection,''),'selected'),
    last_verified_at=clock_timestamp(), verify_requested_at=NULL,
    last_failure_code='', last_failure_message='',
    broker_leased_by=NULL, broker_leased_until=NULL,
    updated_at=clock_timestamp(), version=version+1
  WHERE id=p_connection_id RETURNING * INTO v;
  PERFORM write_audit_event(NULL,NULL,NULL,'system',p_worker_id,'provider.connection_completed',
    'provider_connection',v.id::text,'allowed',NULL,
    jsonb_build_object('provider','github','installation_id',v.external_installation_id,
      'account_label',v.account_label,'repository_selection',v.repository_selection),v.id::text);
  RETURN jsonb_build_object('connection_id',v.id,'status',v.status,'last_verified_at',v.last_verified_at);
END; $$;

CREATE OR REPLACE FUNCTION fail_github_connection(
  p_connection_id uuid, p_worker_id text, p_failure_code text, p_failure_message text
) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE v provider_connections%ROWTYPE; v_status text;
BEGIN
  SELECT * INTO v FROM provider_connections WHERE id=p_connection_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'github connection is not found' USING ERRCODE='55000'; END IF;
  v_status := CASE WHEN p_failure_code IN ('installation_not_found','installation_revoked','app_not_installed')
    THEN 'expired' ELSE 'action_required' END;
  UPDATE provider_connections SET status=v_status,
    last_failure_code=left(COALESCE(p_failure_code,''),80),
    last_failure_message=left(COALESCE(regexp_replace(p_failure_message,'[[:cntrl:]]',' ','g'),''),500),
    broker_leased_by=NULL, broker_leased_until=NULL,
    last_verified_at=clock_timestamp(), updated_at=clock_timestamp(), version=version+1
  WHERE id=p_connection_id RETURNING * INTO v;
  PERFORM write_audit_event(NULL,NULL,NULL,'system',p_worker_id,'provider.connection_verification_failed',
    'provider_connection',v.id::text,'denied',NULL,
    jsonb_build_object('provider','github','failure_code',v.last_failure_code,'status',v.status),v.id::text);
  RETURN jsonb_build_object('connection_id',v.id,'status',v.status,'failure_code',v.last_failure_code);
END; $$;

CREATE OR REPLACE FUNCTION disconnect_github_connection(
  p_connection_id uuid, p_operator_id uuid, p_correlation_id text
) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE v provider_connections%ROWTYPE;
BEGIN
  SELECT * INTO v FROM provider_connections
  WHERE id=p_connection_id AND operator_id=p_operator_id AND provider='github' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'GitHub connection is unavailable' USING ERRCODE='55000'; END IF;
  IF v.status='disconnected' THEN RETURN jsonb_build_object('connection_id',v.id,'status','disconnected'); END IF;
  UPDATE provider_connections SET status='disconnected', broker_leased_by=NULL, broker_leased_until=NULL,
    verify_requested_at=NULL, updated_at=clock_timestamp(), version=version+1
  WHERE id=p_connection_id RETURNING * INTO v;
  PERFORM write_audit_event(NULL,NULL,NULL,'operator',p_operator_id::text,'provider.disconnected',
    'provider_connection',v.id::text,'allowed',NULL,
    jsonb_build_object('provider','github','installation_id',v.external_installation_id),
    COALESCE(p_correlation_id,v.id::text));
  RETURN jsonb_build_object('connection_id',v.id,'status',v.status);
END; $$;

CREATE OR REPLACE FUNCTION request_github_verify(
  p_connection_id uuid, p_operator_id uuid, p_correlation_id text
) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE v provider_connections%ROWTYPE;
BEGIN
  SELECT * INTO v FROM provider_connections
  WHERE id=p_connection_id AND operator_id=p_operator_id AND provider='github' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'GitHub connection is unavailable' USING ERRCODE='55000'; END IF;
  IF v.status='disconnected' THEN RAISE EXCEPTION 'Disconnected GitHub connections cannot be verified' USING ERRCODE='55000'; END IF;
  UPDATE provider_connections SET status='action_required', verify_requested_at=clock_timestamp(),
    broker_leased_by=NULL, broker_leased_until=NULL, updated_at=clock_timestamp(), version=version+1
  WHERE id=p_connection_id RETURNING * INTO v;
  PERFORM write_audit_event(NULL,NULL,NULL,'operator',p_operator_id::text,'provider.verify_requested',
    'provider_connection',v.id::text,'allowed',NULL,
    jsonb_build_object('provider','github','installation_id',v.external_installation_id),
    COALESCE(p_correlation_id,v.id::text));
  RETURN jsonb_build_object('connection_id',v.id,'status',v.status,'verify_requested_at',v.verify_requested_at);
END; $$;

CREATE OR REPLACE FUNCTION refresh_github_installation_repositories(
  p_connection_id uuid, p_worker_id text, p_repositories jsonb
) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE v_count integer; v_repo jsonb; v_rows integer := 0;
BEGIN
  IF NOT EXISTS(SELECT 1 FROM provider_connections WHERE id=p_connection_id AND provider='github') THEN
    RAISE EXCEPTION 'github connection is not found' USING ERRCODE='55000';
  END IF;
  IF jsonb_typeof(p_repositories)<>'array' THEN
    RAISE EXCEPTION 'repositories payload must be an array' USING ERRCODE='22023';
  END IF;
  DELETE FROM provider_installation_repositories WHERE connection_id=p_connection_id;
  FOR v_repo IN SELECT * FROM jsonb_array_elements(p_repositories) LOOP
    IF (v_repo->>'github_repository_id') ~ '^[0-9]+$'
       AND (v_repo->>'full_name') ~ '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$'
       AND (v_repo->>'clone_url') ~ '^https://github\.com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+(\.git)?$' THEN
      INSERT INTO provider_installation_repositories(connection_id, github_repository_id, full_name,
        private, archived, default_branch, clone_url, verified_at)
      VALUES(p_connection_id, (v_repo->>'github_repository_id')::bigint, v_repo->>'full_name',
        COALESCE((v_repo->>'private')::boolean,false), COALESCE((v_repo->>'archived')::boolean,false),
        left(COALESCE(v_repo->>'default_branch',''),120), v_repo->>'clone_url',
        COALESCE(NULLIF(v_repo->>'verified_at','')::timestamptz, clock_timestamp()))
      ON CONFLICT (connection_id, github_repository_id) DO UPDATE SET full_name=EXCLUDED.full_name,
        private=EXCLUDED.private, archived=EXCLUDED.archived, default_branch=EXCLUDED.default_branch,
        clone_url=EXCLUDED.clone_url, verified_at=EXCLUDED.verified_at;
      v_rows := v_rows + 1;
    END IF;
  END LOOP;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN jsonb_build_object('connection_id',p_connection_id,'repositories_refreshed',v_rows);
END; $$;

CREATE OR REPLACE FUNCTION claim_github_connection_work(
  p_worker_id text, p_limit integer DEFAULT 1, p_lease interval DEFAULT interval '90 seconds'
) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE v_result jsonb;
BEGIN
  WITH candidates AS (
    SELECT c.id, CASE WHEN c.status='pending_finalize' THEN 'finalize' ELSE 'verify' END AS work_kind
    FROM provider_connections c
    WHERE c.provider='github'
      AND (
        (c.status='pending_finalize')
        OR (c.status IN ('action_required','expired','connected')
            AND c.verify_requested_at IS NOT NULL
            AND c.verify_requested_at > COALESCE(c.last_verified_at, '-infinity'::timestamptz))
      )
      AND (c.broker_leased_until IS NULL OR c.broker_leased_until <= clock_timestamp())
    ORDER BY c.status='pending_finalize' DESC, c.verify_requested_at NULLS LAST, c.updated_at
    FOR UPDATE SKIP LOCKED LIMIT GREATEST(p_limit,0)
  ), claimed AS (
    UPDATE provider_connections SET broker_leased_by=p_worker_id, broker_leased_until=clock_timestamp()+p_lease,
      updated_at=clock_timestamp()
    FROM candidates WHERE provider_connections.id=candidates.id
    RETURNING provider_connections.id, candidates.work_kind
  )
  SELECT jsonb_agg(jsonb_build_object(
    'connection_id',c.id,'work_kind',c.work_kind,
    'installation_id',pc.external_installation_id,'operator_id',pc.operator_id,
    'account_label',pc.account_label,'current_status',pc.status)) INTO v_result
  FROM claimed c JOIN provider_connections pc ON pc.id=c.id;
  RETURN COALESCE(v_result,'[]'::jsonb);
END; $$;

CREATE OR REPLACE FUNCTION claim_github_app_clone_projects(
  p_worker_id text, p_limit integer DEFAULT 1
) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE v_result jsonb;
BEGIN
  WITH candidates AS (
    SELECT p.id FROM projects p
    WHERE p.credential_mode='github_app' AND p.status='needs_attention'
      AND (p.settings->>'provisioning_status'='pending'
           OR (p.settings->>'provisioning_status'='provisioning' AND p.updated_at<clock_timestamp()-interval '10 minutes'))
    ORDER BY p.created_at FOR UPDATE SKIP LOCKED LIMIT GREATEST(p_limit,0)
  ), claimed AS (
    UPDATE projects p SET
      settings=jsonb_set(p.settings,'{provisioning_status}','"provisioning"'::jsonb,true),
      updated_at=clock_timestamp()
    FROM candidates c WHERE p.id=c.id
    RETURNING p.id
  )
  SELECT jsonb_agg(jsonb_build_object(
    'project_id',p.id,'name',p.name,'workspace_path',p.workspace_path,
    'repository_url',p.repository_url,'default_branch',p.default_branch,
    'provider_connection_id',p.provider_connection_id,
    'github_repository_id',p.github_repository_id,
    'repository_full_name',p.repository_full_name,
    'installation_id',pc.external_installation_id,
    'connection_status',pc.status,
    'version',p.version)) INTO v_result
  FROM claimed c JOIN projects p ON p.id=c.id
  LEFT JOIN provider_connections pc ON pc.id=p.provider_connection_id;
  RETURN COALESCE(v_result,'[]'::jsonb);
END; $$;

CREATE OR REPLACE FUNCTION complete_github_app_clone(
  p_project_id uuid, p_worker_id text
) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE v_project projects%ROWTYPE;
BEGIN
  SELECT * INTO v_project FROM projects WHERE id=p_project_id AND credential_mode='github_app' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'github app clone project is not found' USING ERRCODE='55000'; END IF;
  UPDATE projects SET status='active', version=version+1, updated_at=clock_timestamp(),
    settings=jsonb_set(settings - 'provisioning_error','{provisioning_status}','"ready"'::jsonb,true)
  WHERE id=p_project_id RETURNING * INTO v_project;
  PERFORM append_event('project.provisioned',v_project.id,NULL,NULL,'system',p_worker_id,NULL,v_project.id::text,
    'github-app-provision:'||v_project.id,'project',v_project.id,v_project.version,
    jsonb_build_object('workspace_path',v_project.workspace_path,'repository_url',v_project.repository_url,
      'credential_mode','github_app','repository_full_name',v_project.repository_full_name));
  PERFORM write_audit_event(v_project.id,NULL,NULL,'system',p_worker_id,'provider.project_clone_completed',
    'project',v_project.id::text,'allowed',NULL,
    jsonb_build_object('credential_mode','github_app','repository_full_name',v_project.repository_full_name),v_project.id::text);
  RETURN jsonb_build_object('project_id',v_project.id,'status',v_project.status,'version',v_project.version);
END; $$;

CREATE OR REPLACE FUNCTION fail_github_app_clone(
  p_project_id uuid, p_worker_id text, p_error text
) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE v_project projects%ROWTYPE;
BEGIN
  SELECT * INTO v_project FROM projects WHERE id=p_project_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'github app clone project is not found' USING ERRCODE='55000'; END IF;
  UPDATE projects SET status='needs_attention', updated_at=clock_timestamp(),
    settings=jsonb_set(jsonb_set(settings,'{provisioning_status}','"failed"'::jsonb,true),
      '{provisioning_error}',to_jsonb(left(COALESCE(p_error,''),1000)),true)
  WHERE id=p_project_id RETURNING * INTO v_project;
  PERFORM write_audit_event(v_project.id,NULL,NULL,'system',p_worker_id,'provider.project_clone_failed',
    'project',v_project.id::text,'denied',NULL,
    jsonb_build_object('credential_mode','github_app','failure_code',left(COALESCE(p_error,''),80)),v_project.id::text);
  RETURN jsonb_build_object('project_id',v_project.id,'status',v_project.status,'error',v_project.settings->>'provisioning_error');
END; $$;

CREATE OR REPLACE FUNCTION get_operator_github_connections(p_operator_id uuid)
RETURNS jsonb LANGUAGE sql AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'connection_id',id,'status',status,'account_label',account_label,'installation_label',installation_label,
    'repository_selection',repository_selection,'permissions',permissions,
    'last_verified_at',last_verified_at,'verify_requested_at',verify_requested_at,
    'last_failure_code',last_failure_code,'last_failure_message',last_failure_message,
    'created_at',created_at,'updated_at',updated_at)
    ORDER BY (status='connected') DESC, created_at),'[]'::jsonb)
  FROM provider_connections
  WHERE operator_id=p_operator_id AND provider='github';
$$;

CREATE OR REPLACE FUNCTION list_operator_github_repositories(
  p_operator_id uuid, p_connection_id uuid, p_search text DEFAULT '', p_limit integer DEFAULT 100
) RETURNS jsonb LANGUAGE sql AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'connection_id',r.connection_id,'github_repository_id',r.github_repository_id,
    'full_name',r.full_name,'private',r.private,'archived',r.archived,
    'default_branch',r.default_branch,'clone_url',r.clone_url,'verified_at',r.verified_at)),'[]'::jsonb)
  FROM (
    SELECT r.* FROM provider_installation_repositories r
    JOIN provider_connections c ON c.id=r.connection_id
    WHERE c.operator_id=p_operator_id AND c.provider='github' AND c.status='connected'
      AND (p_connection_id IS NULL OR r.connection_id=p_connection_id)
      AND (p_search='' OR r.full_name ILIKE '%' || p_search || '%')
    ORDER BY r.archived, r.full_name
    LIMIT LEAST(GREATEST(p_limit,1),100)
  ) r;
$$;

ALTER FUNCTION start_provider_login_session(uuid,text,text,interval)
  SET search_path=control_plane,public,extensions,pg_temp;
ALTER FUNCTION consume_provider_login_session(uuid,text,text)
  SET search_path=control_plane,public,extensions,pg_temp;
ALTER FUNCTION create_pending_github_connection(uuid,text,text,text)
  SET search_path=control_plane,public,extensions,pg_temp;
ALTER FUNCTION activate_github_connection(uuid,text,text,text,text,jsonb,text)
  SET search_path=control_plane,public,extensions,pg_temp;
ALTER FUNCTION fail_github_connection(uuid,text,text,text)
  SET search_path=control_plane,public,extensions,pg_temp;
ALTER FUNCTION disconnect_github_connection(uuid,uuid,text)
  SET search_path=control_plane,public,extensions,pg_temp;
ALTER FUNCTION request_github_verify(uuid,uuid,text)
  SET search_path=control_plane,public,extensions,pg_temp;
ALTER FUNCTION refresh_github_installation_repositories(uuid,text,jsonb)
  SET search_path=control_plane,public,extensions,pg_temp;
ALTER FUNCTION claim_github_connection_work(text,integer,interval)
  SET search_path=control_plane,public,extensions,pg_temp;
ALTER FUNCTION claim_github_app_clone_projects(text,integer)
  SET search_path=control_plane,public,extensions,pg_temp;
ALTER FUNCTION complete_github_app_clone(uuid,text)
  SET search_path=control_plane,public,extensions,pg_temp;
ALTER FUNCTION fail_github_app_clone(uuid,text,text)
  SET search_path=control_plane,public,extensions,pg_temp;
ALTER FUNCTION get_operator_github_connections(uuid)
  SET search_path=control_plane,public,extensions,pg_temp;
ALTER FUNCTION list_operator_github_repositories(uuid,uuid,text,integer)
  SET search_path=control_plane,public,extensions,pg_temp;

COMMIT;
