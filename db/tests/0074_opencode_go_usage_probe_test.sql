-- OpenCode Go's usage probe (migration 0117, ADR-0019): its classes are kept,
-- anything else is not, and a Go connection is due at most once per interval.
\set ON_ERROR_STOP on

BEGIN;
SET search_path TO control_plane, public, extensions;

DO $$
DECLARE v jsonb;
BEGIN
  v := usage_reading_clean('{"error_class":"not_subscribed"}');
  IF v->>'error_class' IS DISTINCT FROM 'not_subscribed' THEN RAISE EXCEPTION 'not_subscribed was not kept: %', v; END IF;
  v := usage_reading_clean('{"error_class":"sk-live-something"}');
  IF v->'error_class' <> 'null'::jsonb THEN RAISE EXCEPTION 'an unknown error class was kept: %', v; END IF;
  v := usage_reading_clean('{"windows":[{"key":"rolling","used_percent":12.3,"window_minutes":300,"resets_at":1790683200}],"status":"allowed"}');
  IF v->'windows'->0->>'key' <> 'rolling' OR (v->'windows'->0->>'used_percent')::numeric <> 12.3 THEN
    RAISE EXCEPTION 'a Go window was not kept: %', v;
  END IF;
  -- Due for no one on an empty host; the function answers a list either way.
  IF jsonb_typeof(opencode_go_usage_reads_due(interval '5 minutes')) <> 'array' THEN RAISE EXCEPTION 'due is not a list'; END IF;
  RAISE NOTICE 'the Go probe''s readings keep only their schema';
END $$;

-- The table's own check agrees with the cleaner.
DO $$
BEGIN
  PERFORM 1 FROM pg_constraint WHERE conname = 'provider_usage_readings_error_class_check'
    AND pg_get_constraintdef(oid) LIKE '%not_subscribed%';
  IF NOT FOUND THEN RAISE EXCEPTION 'the error class check does not allow not_subscribed'; END IF;
END $$;

ROLLBACK;
