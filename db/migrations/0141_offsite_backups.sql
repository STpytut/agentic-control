-- Off-site backups (rc.129).
--
-- infra-vps is the only host, and every backup lived on it: a lost disk or a
-- closed account would take the panel and all its backups together. The
-- owner names an S3-compatible bucket (Cloudflare R2 by default); after every
-- backup, infra-cod-offsite-backup uploads the encrypted file — already
-- gpg-encrypted with the host's backup passphrase — and keeps the newest
-- fourteen there.
--
-- The bucket's secret key is handled as the Telegram token and OpenCode keys
-- are: the browser encrypts it under the broker's public key and only that
-- envelope is stored. The uploader decrypts it on the VPS.

SET search_path TO control_plane, public, extensions;

INSERT INTO failure_reasons(reason, code, note) VALUES
  ('offsite_backup_invalid','invalid_argument','the bucket, its endpoint or its key is not in the form an S3-compatible store takes'),
  ('offsite_backup_owner_only','permission_denied','only the owner sets where backups go')
ON CONFLICT (reason) DO NOTHING;

CREATE TABLE offsite_backup_target (
  id smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  endpoint text NOT NULL CHECK (endpoint ~ '^https://[A-Za-z0-9.-]+(:[0-9]+)?$'),
  bucket text NOT NULL CHECK (bucket ~ '^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$'),
  prefix text NOT NULL DEFAULT 'infra-cod/' CHECK (prefix ~ '^[A-Za-z0-9._/-]{0,100}$'),
  region text NOT NULL DEFAULT 'auto' CHECK (region ~ '^[a-z0-9-]{2,32}$'),
  access_key_id text NOT NULL CHECK (access_key_id ~ '^[A-Za-z0-9]{16,128}$'),
  secret_envelope jsonb NOT NULL,
  set_by uuid REFERENCES users(id) ON DELETE SET NULL,
  set_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  last_attempt_at timestamptz,
  last_upload_at timestamptz,
  last_object text,
  last_bytes bigint,
  last_error text CHECK (last_error IS NULL OR char_length(last_error) <= 500)
);

CREATE FUNCTION offsite_owner_check(p_owner_id uuid)
RETURNS void LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path TO control_plane, public, extensions, pg_temp
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM users WHERE id=p_owner_id AND role='owner') THEN
    PERFORM refuse('offsite_backup_owner_only', 'only the owner sets where backups go', '42501');
  END IF;
END $$;

CREATE FUNCTION set_offsite_backup(p_owner_id uuid, p_endpoint text, p_bucket text, p_access_key_id text, p_envelope jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO control_plane, public, extensions, pg_temp
AS $$
BEGIN
  PERFORM offsite_owner_check(p_owner_id);
  IF p_envelope IS NULL OR jsonb_typeof(p_envelope) <> 'object'
     OR NOT (p_envelope ?& ARRAY['ciphertext','iv','tag','key_wrap']) THEN
    PERFORM refuse('offsite_backup_invalid', 'the secret key must arrive encrypted by the panel', '22023');
  END IF;
  BEGIN
    INSERT INTO offsite_backup_target(id, endpoint, bucket, access_key_id, secret_envelope, set_by)
    VALUES (1, rtrim(p_endpoint,'/'), p_bucket, p_access_key_id,
      jsonb_build_object('ciphertext',p_envelope->>'ciphertext','iv',p_envelope->>'iv','tag',p_envelope->>'tag','key_wrap',p_envelope->>'key_wrap'),
      p_owner_id)
    ON CONFLICT (id) DO UPDATE SET endpoint=EXCLUDED.endpoint, bucket=EXCLUDED.bucket, access_key_id=EXCLUDED.access_key_id,
      secret_envelope=EXCLUDED.secret_envelope, set_by=EXCLUDED.set_by, set_at=clock_timestamp(),
      last_attempt_at=NULL, last_error=NULL;
  EXCEPTION WHEN check_violation THEN
    PERFORM refuse('offsite_backup_invalid', 'the endpoint must be https://<account>.r2.cloudflarestorage.com, the bucket a lowercase bucket name, and the key id its letters and digits', '22023');
  END;
  PERFORM write_audit_event(NULL,NULL,NULL,'operator',p_owner_id::text,'backup.offsite_set',
    'offsite_backup_target','1','allowed',NULL,jsonb_build_object('endpoint',rtrim(p_endpoint,'/'),'bucket',p_bucket),'offsite:'||p_owner_id);
  RETURN jsonb_build_object('status','set');
END $$;

-- What the panel shows: never the secret.
CREATE FUNCTION get_offsite_backup(p_owner_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path TO control_plane, public, extensions, pg_temp
AS $$
BEGIN
  PERFORM offsite_owner_check(p_owner_id);
  RETURN COALESCE((SELECT jsonb_build_object('configured',true,'endpoint',t.endpoint,'bucket',t.bucket,'prefix',t.prefix,
      'access_key_id',t.access_key_id,'set_at',t.set_at,'last_attempt_at',t.last_attempt_at,'last_upload_at',t.last_upload_at,
      'last_object',t.last_object,'last_bytes',t.last_bytes,'last_error',t.last_error)
    FROM offsite_backup_target t WHERE t.id=1), jsonb_build_object('configured',false));
END $$;

CREATE FUNCTION disable_offsite_backup(p_owner_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO control_plane, public, extensions, pg_temp
AS $$
BEGIN
  PERFORM offsite_owner_check(p_owner_id);
  DELETE FROM offsite_backup_target WHERE id=1;
  PERFORM write_audit_event(NULL,NULL,NULL,'operator',p_owner_id::text,'backup.offsite_disabled',
    'offsite_backup_target','1','allowed',NULL,'{}'::jsonb,'offsite:'||p_owner_id);
  RETURN jsonb_build_object('status','disabled');
END $$;

-- The uploader's view, the envelope included.
CREATE FUNCTION offsite_backup_for_upload()
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO control_plane, public, extensions, pg_temp
AS $$
  SELECT jsonb_build_object('endpoint',t.endpoint,'bucket',t.bucket,'prefix',t.prefix,'region',t.region,
    'access_key_id',t.access_key_id,'envelope',t.secret_envelope,'last_object',t.last_object)
  FROM offsite_backup_target t WHERE t.id=1;
$$;

CREATE FUNCTION record_offsite_upload(p_object text, p_bytes bigint, p_error text)
RETURNS void LANGUAGE sql SECURITY DEFINER
SET search_path TO control_plane, public, extensions, pg_temp
AS $$
  UPDATE offsite_backup_target SET last_attempt_at=clock_timestamp(),
    last_upload_at=CASE WHEN p_error IS NULL THEN clock_timestamp() ELSE last_upload_at END,
    last_object=CASE WHEN p_error IS NULL THEN p_object ELSE last_object END,
    last_bytes=CASE WHEN p_error IS NULL THEN p_bytes ELSE last_bytes END,
    last_error=left(p_error,500)
  WHERE id=1;
$$;

-- For the health snapshot: whether an off-site copy is configured and how old
-- the newest one is. No endpoint, no key.
CREATE FUNCTION offsite_backup_status()
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO control_plane, public, extensions, pg_temp
AS $$
  SELECT COALESCE((SELECT jsonb_build_object('configured',true,'last_upload_at',t.last_upload_at,'last_error',t.last_error,
      'set_at',t.set_at) FROM offsite_backup_target t WHERE t.id=1), jsonb_build_object('configured',false));
$$;

REVOKE ALL ON offsite_backup_target FROM PUBLIC;
REVOKE ALL ON FUNCTION offsite_owner_check(uuid), set_offsite_backup(uuid,text,text,text,jsonb), get_offsite_backup(uuid),
  disable_offsite_backup(uuid), offsite_backup_for_upload(), record_offsite_upload(text,bigint,text), offsite_backup_status() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION set_offsite_backup(uuid,text,text,text,jsonb), get_offsite_backup(uuid), disable_offsite_backup(uuid) TO infra_web;
GRANT EXECUTE ON FUNCTION offsite_backup_for_upload(), record_offsite_upload(text,bigint,text), offsite_backup_status() TO infra_worker;
