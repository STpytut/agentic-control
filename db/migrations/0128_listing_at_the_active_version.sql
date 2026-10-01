-- Which runtime version a refreshed model list is recorded at (Codex 0.159.3).
--
-- 0099's catalog_listing_version took the version the refresh reported first.
-- For Codex that is the connection's runtime_version, written when it logged
-- in — 0.158.0 — so the first refresh after promoting 0.159.3, a second later,
-- recorded gpt-6.1-sol (which only 0.159.3 lists) as listed at 0.158.0, and
-- the model stayed "not listed at the active version" with a passed check. The
-- active version is a fact the promotion writes at once (runtime_active_versions,
-- 0099); it comes first, and the reported one is the fallback it was meant to be.

SET search_path TO control_plane, public, extensions;

CREATE OR REPLACE FUNCTION catalog_listing_version(p_runtime text, p_reported text)
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO control_plane, public, extensions, pg_temp
AS $$
DECLARE v_version text;
BEGIN
  v_version := active_runtime_version(p_runtime);
  IF COALESCE(v_version,'') = '' THEN v_version := NULLIF(p_reported, ''); END IF;
  IF COALESCE(v_version,'') = '' THEN v_version := runtime_health_reading(p_runtime)->>'version'; END IF;
  IF COALESCE(v_version,'') = '' THEN
    SELECT w.active_version INTO v_version FROM runtime_watch_state w WHERE w.runtime_type = p_runtime;
  END IF;
  RETURN left(COALESCE(v_version,''), 64);
END $$;
