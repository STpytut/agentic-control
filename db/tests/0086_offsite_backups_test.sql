-- Migration 0141: off-site backups. Only the owner sets the bucket, the secret
-- is stored only as an envelope the panel cannot read back, and the uploader's
-- outcome is what the panel and the health snapshot see.
\set ON_ERROR_STOP on

BEGIN;
SET search_path TO control_plane, public, extensions;

DO $$
DECLARE
  v_owner uuid; v_viewer uuid; v_view jsonb;
  v_envelope jsonb := '{"ciphertext":"c2VjcmV0c2VjcmV0","iv":"aXZpdml2aXZpdg==","tag":"dGFndGFndGFndGFn","key_wrap":"a2V5d3JhcGtleXdyYXA="}';
BEGIN
  IF has_table_privilege('infra_web','offsite_backup_target','SELECT')
     OR has_function_privilege('infra_web','offsite_backup_for_upload()','EXECUTE')
     OR NOT has_function_privilege('infra_worker','offsite_backup_for_upload()','EXECUTE') THEN
    RAISE EXCEPTION 'the bucket secret is readable by the panel, or the uploader cannot read it';
  END IF;
  DELETE FROM offsite_backup_target;
  INSERT INTO users(display_name,role) VALUES('Backup owner','owner') RETURNING id INTO v_owner;
  v_viewer := gen_random_uuid();  -- not a user, so not the owner

  BEGIN
    PERFORM set_offsite_backup(v_viewer, 'https://acct.r2.cloudflarestorage.com', 'infra-backups', 'a1b2c3d4e5f6a7b8c9d0', v_envelope);
    RAISE EXCEPTION 'a non-owner set the bucket';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    PERFORM set_offsite_backup(v_owner, 'http://plain.example', 'infra-backups', 'a1b2c3d4e5f6a7b8c9d0', v_envelope);
    RAISE EXCEPTION 'a plain-http endpoint was accepted';
  EXCEPTION WHEN invalid_parameter_value THEN NULL;
  END;

  PERFORM set_offsite_backup(v_owner, 'https://acct.r2.cloudflarestorage.com/', 'infra-backups', 'a1b2c3d4e5f6a7b8c9d0', v_envelope);
  v_view := get_offsite_backup(v_owner);
  IF NOT (v_view->>'configured')::boolean OR v_view->>'endpoint' <> 'https://acct.r2.cloudflarestorage.com'
     OR v_view::text LIKE '%c2VjcmV0%' THEN
    RAISE EXCEPTION 'the panel read: %', v_view;
  END IF;
  IF offsite_backup_for_upload()->'envelope' IS NULL THEN RAISE EXCEPTION 'the uploader has no envelope'; END IF;

  PERFORM record_offsite_upload(NULL, NULL, 'listing the bucket failed: 403 AccessDenied');
  IF (offsite_backup_status()->>'last_error') IS NULL OR (offsite_backup_status()->>'last_upload_at') IS NOT NULL THEN
    RAISE EXCEPTION 'a failure is not visible: %', offsite_backup_status();
  END IF;
  PERFORM record_offsite_upload('infra-cod/b.tar.gpg', 1234, NULL);
  IF (offsite_backup_status()->>'last_error') IS NOT NULL OR (get_offsite_backup(v_owner)->>'last_bytes')::bigint <> 1234 THEN
    RAISE EXCEPTION 'a success is not recorded: %', get_offsite_backup(v_owner);
  END IF;

  PERFORM disable_offsite_backup(v_owner);
  IF (offsite_backup_status()->>'configured')::boolean THEN RAISE EXCEPTION 'still configured'; END IF;
  RAISE NOTICE 'off-site backup assertions passed';
END $$;

ROLLBACK;
