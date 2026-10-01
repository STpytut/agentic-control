BEGIN;

SET search_path TO control_plane, public;

ALTER TABLE users
  ADD COLUMN auth_user_id uuid,
  ADD COLUMN email text,
  ADD COLUMN role text NOT NULL DEFAULT 'owner';

ALTER TABLE users
  ADD CONSTRAINT users_auth_user_id_unique UNIQUE(auth_user_id),
  ADD CONSTRAINT users_email_normalized CHECK (email IS NULL OR email=lower(email)),
  ADD CONSTRAINT users_role_check CHECK (role IN ('owner'));

CREATE UNIQUE INDEX users_owner_email_unique ON users(lower(email)) WHERE email IS NOT NULL;

COMMIT;
