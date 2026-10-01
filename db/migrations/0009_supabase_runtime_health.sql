BEGIN;
SET search_path TO control_plane,public,extensions;

CREATE TABLE IF NOT EXISTS runtime_health (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  status text NOT NULL CHECK (status IN ('healthy','degraded','critical','unknown')),
  snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  observed_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

ALTER FUNCTION submit_command(uuid,uuid,text,text,text,text,jsonb,bigint,text)
  SET search_path=control_plane,public,extensions,pg_temp;
ALTER FUNCTION compute_action_fingerprint(text,jsonb)
  SET search_path=control_plane,public,extensions,pg_temp;

REVOKE ALL ON runtime_health FROM PUBLIC;

COMMIT;
