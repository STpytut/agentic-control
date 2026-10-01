-- A reconnected model connection brings its catalog back (sprint C backlog).
--
-- A connection that is disconnected or expires marks its catalog unavailable
-- (mark_catalog_unavailable_on_connection_change). Connected again, nothing
-- asked for the models back: on the host, reconnecting OpenRouter after the A4
-- run left all 299 entries unavailable until the operator clicked "Update model
-- list" (docs/STAGE_11_2_ACCEPTANCE.md, rc.58). Now the return to connected
-- queues the refresh itself, which brings each model the provider still lists
-- back to discovered. Verification is asked for again, deliberately: the
-- credential behind the connection may be a different one.

SET search_path TO control_plane, public, extensions;

CREATE FUNCTION queue_catalog_refresh_on_reconnect()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO control_plane, public, extensions, pg_temp
AS $$
BEGIN
  IF NEW.status='connected' AND OLD.status IS DISTINCT FROM 'connected'
     AND NEW.connection_kind='model_access'
     AND NOT EXISTS (SELECT 1 FROM catalog_refresh_jobs j
                     WHERE j.connection_id=NEW.id AND j.status IN ('pending','in_progress')) THEN
    INSERT INTO catalog_refresh_jobs(operator_id, connection_id, reason)
    VALUES (NEW.operator_id, NEW.id, 'reconnected');
  END IF;
  RETURN NULL;
END $$;

REVOKE EXECUTE ON FUNCTION queue_catalog_refresh_on_reconnect() FROM PUBLIC;

CREATE TRIGGER provider_connections_catalog_on_reconnect
  AFTER UPDATE OF status ON provider_connections
  FOR EACH ROW EXECUTE FUNCTION queue_catalog_refresh_on_reconnect();
