-- Remove the Supabase identity from the operator record.
--
-- Supabase Auth is gone from the application: 0037 introduced a local username
-- and password, and every authorization decision now goes through
-- `web_sessions`. `auth_user_id` is the last piece of the old model, and leaving
-- it behind would leave a second, unpopulated identity column that a future
-- reader could mistake for the real one.
--
-- `email` stays. It is nullable, still covered by `users_owner_email_unique`, and
-- is a legitimate contact field for an operator; it simply no longer has
-- anything to do with signing in.
--
-- The unique constraint is dropped with the column, and with it the column-level
-- SELECT grant that 0038 made to infra_web. Nothing else references either:
-- `authenticate_lookup`, `bootstrap_local_owner` and `write_operator_audit` were
-- all written against the local model.

SET search_path TO control_plane, public, extensions;

ALTER TABLE users DROP CONSTRAINT IF EXISTS users_auth_user_id_unique;
ALTER TABLE users DROP COLUMN IF EXISTS auth_user_id;

DO $assert$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='control_plane' AND table_name='users' AND column_name='auth_user_id'
  ) THEN
    RAISE EXCEPTION 'users.auth_user_id survived the drop';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_proc p
    JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='control_plane' AND p.prokind='f'
      AND pg_get_functiondef(p.oid) LIKE '%auth_user_id%'
  ) THEN
    RAISE EXCEPTION 'a control_plane function still references users.auth_user_id';
  END IF;
END $assert$;
