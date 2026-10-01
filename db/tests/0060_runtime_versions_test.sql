-- Upstream runtime versions as the daily watch records them (migration 0095).
\set ON_ERROR_STOP on

BEGIN;
SET search_path TO control_plane, public, extensions;

DO $$
DECLARE v_view jsonb; v_codex jsonb;
BEGIN
  -- Two newer versions, one of them published an hour ago; one older than the
  -- active version; one deprecated.
  PERFORM record_runtime_watch('codex', '0.154.0', jsonb_build_array(
    jsonb_build_object('version','0.153.0','published_at',clock_timestamp()-interval '30 days'),
    jsonb_build_object('version','0.158.0','published_at',clock_timestamp()-interval '3 days'),
    jsonb_build_object('version','0.159.0','published_at',clock_timestamp()-interval '1 hour'),
    jsonb_build_object('version','0.157.0','published_at',clock_timestamp()-interval '5 days','deprecated',true)
  ));
  v_view := get_runtime_versions();
  SELECT e INTO v_codex FROM jsonb_array_elements(v_view) e WHERE e->>'runtime'='codex';
  IF v_codex->>'active_version' <> '0.154.0' OR v_codex->>'error' IS NOT NULL THEN
    RAISE EXCEPTION 'watch state read wrongly: %', v_codex;
  END IF;
  -- Newer only, newest first, the withdrawn one left out, numeric order.
  IF (SELECT jsonb_agg(n->>'version') FROM jsonb_array_elements(v_codex->'newer') n) <> '["0.159.0","0.158.0"]'::jsonb THEN
    RAISE EXCEPTION 'newer versions wrong: %', v_codex->'newer';
  END IF;
  -- Offered once published (0127; the 48 hours before it are gone).
  IF NOT (v_codex->'newer'->0->>'offered')::boolean OR NOT (v_codex->'newer'->1->>'offered')::boolean THEN
    RAISE EXCEPTION 'a published version is not offered: %', v_codex->'newer';
  END IF;

  -- A failed look records the failure and keeps the versions it already knew.
  PERFORM record_runtime_watch('codex', '0.154.0', '[]'::jsonb, 'registry timed out');
  SELECT e INTO v_codex FROM jsonb_array_elements(get_runtime_versions()) e WHERE e->>'runtime'='codex';
  IF v_codex->>'error' <> 'registry timed out' OR jsonb_array_length(v_codex->'newer') <> 2 THEN
    RAISE EXCEPTION 'a failed watch lost or hid state: %', v_codex;
  END IF;

  -- Numeric, not lexical: 1.18.31 is newer than 1.9.0.
  PERFORM record_runtime_watch('opencode', '1.9.0', jsonb_build_array(
    jsonb_build_object('version','1.18.31','published_at',clock_timestamp()-interval '10 days')));
  SELECT e INTO v_codex FROM jsonb_array_elements(get_runtime_versions()) e WHERE e->>'runtime'='opencode';
  IF jsonb_array_length(v_codex->'newer') <> 1 THEN RAISE EXCEPTION 'version order is lexical: %', v_codex; END IF;

  BEGIN
    PERFORM record_runtime_watch('codex', '0.154.0', jsonb_build_array(jsonb_build_object('version','latest')));
    RAISE EXCEPTION 'a non-exact version was stored';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    PERFORM record_runtime_watch('codex', '0.154.0', (SELECT jsonb_agg(jsonb_build_object('version', '0.0.'||g)) FROM generate_series(1,51) g));
    RAISE EXCEPTION 'an unbounded list was stored';
  EXCEPTION WHEN SQLSTATE '22023' THEN NULL;
  END;
  RAISE NOTICE 'the watch records newer runtime versions and offers them once published';
END $$;

ROLLBACK;
