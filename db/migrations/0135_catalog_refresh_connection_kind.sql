-- "Refresh now" on Settings → Models failed with "permission denied for table
-- provider_connections": the web action selects the owner's model-access
-- connections by connection_kind, a column the web role had never been granted.
-- Nobody had pressed the button on the author's host; the first install on a
-- clean server did, within its first hour.

SET search_path TO control_plane, public, extensions;

GRANT SELECT (connection_kind) ON provider_connections TO infra_web;
