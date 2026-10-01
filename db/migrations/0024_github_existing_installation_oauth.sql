BEGIN;
SET search_path TO control_plane, public, extensions;

-- A standalone GitHub App OAuth authorization returns `code` and `state`, but
-- does not identify an installation. Allow the broker to resolve the sole
-- installation visible to the authorized user and bind it while holding the
-- exchange lease. New installations may still provide an installation id.

ALTER TABLE github_oauth_codes
  DROP CONSTRAINT github_oauth_codes_installation_id_check,
  ADD CONSTRAINT github_oauth_codes_installation_id_check
    CHECK (installation_id = '' OR installation_id ~ '^[0-9]+$');

CREATE OR REPLACE FUNCTION record_github_oauth_callback(
  p_operator_id uuid, p_state_digest text, p_installation_id text, p_setup_action text,
  p_authorization_code_ciphertext text, p_authorization_code_iv text, p_authorization_code_tag text,
  p_client_id text, p_ttl interval DEFAULT interval '10 minutes'
) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE v_id uuid;
BEGIN
  IF p_state_digest !~ '^[0-9a-f]{64}$'
     OR (COALESCE(p_installation_id,'') <> '' AND p_installation_id !~ '^[0-9]+$')
     OR length(trim(p_authorization_code_ciphertext))<8 OR length(p_client_id)<8 THEN
    RAISE EXCEPTION 'invalid github oauth callback parameters' USING ERRCODE='22023';
  END IF;
  INSERT INTO github_oauth_codes(operator_id, state_digest, installation_id, setup_action,
    authorization_code_ciphertext, authorization_code_iv, authorization_code_tag, client_id, expires_at)
  VALUES(p_operator_id, p_state_digest, COALESCE(p_installation_id,''), p_setup_action,
    decode(p_authorization_code_ciphertext,'base64'), decode(p_authorization_code_iv,'base64'),
    decode(p_authorization_code_tag,'base64'), p_client_id, clock_timestamp()+p_ttl)
  RETURNING id INTO v_id;
  RETURN v_id;
END; $$;

CREATE OR REPLACE FUNCTION select_github_oauth_installation(
  p_code_id uuid, p_worker_id text, p_installation_id text
) RETURNS jsonb LANGUAGE plpgsql AS $$
BEGIN
  IF p_installation_id !~ '^[0-9]+$' THEN
    RAISE EXCEPTION 'invalid GitHub installation id' USING ERRCODE='22023';
  END IF;
  UPDATE github_oauth_codes
  SET installation_id=p_installation_id, updated_at=clock_timestamp()
  WHERE id=p_code_id AND broker_leased_by=p_worker_id
    AND broker_leased_until>clock_timestamp() AND status='exchanging'
    AND installation_id='';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'oauth installation is not selectable' USING ERRCODE='55000';
  END IF;
  RETURN jsonb_build_object('code_id',p_code_id,'installation_selected',true);
END; $$;

ALTER FUNCTION record_github_oauth_callback(uuid,text,text,text,text,text,text,text,interval)
  SET search_path=control_plane,public,extensions,pg_temp;
ALTER FUNCTION select_github_oauth_installation(uuid,text,text)
  SET search_path=control_plane,public,extensions,pg_temp;

COMMIT;
