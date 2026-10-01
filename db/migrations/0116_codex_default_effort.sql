-- The model's default reasoning level, for a runtime whose level sticks to its
-- thread (Stage 12, reasoning levels).
--
-- Codex keeps a turn's `effort` for the turns after it on the same thread, and
-- a Codex thread spans the tasks of a conversation. A member at "Default" that
-- sent nothing would therefore run at whatever an earlier task chose; so for
-- Codex, "Default" sends the catalog's default level for the model explicitly.

SET search_path TO control_plane, public, extensions;

CREATE FUNCTION catalog_default_reasoning(p_entry_id uuid)
RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO control_plane, public, extensions, pg_temp
AS $$
  SELECT NULLIF(default_reasoning_effort, '') FROM provider_model_catalog WHERE id = p_entry_id;
$$;

REVOKE EXECUTE ON FUNCTION catalog_default_reasoning(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION catalog_default_reasoning(uuid) TO infra_worker;
