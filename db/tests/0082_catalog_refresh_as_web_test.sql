-- The web role can run the query behind "Refresh now" (0135).
\set ON_ERROR_STOP on

BEGIN;
SET search_path TO control_plane, public, extensions;

SET LOCAL ROLE infra_web;
-- The columns the catalog_refresh action filters on, as that action reads them.
SELECT count(*) FROM provider_connections c
WHERE c.operator_id = gen_random_uuid()
  AND c.connection_kind = 'model_access'
  AND c.status = 'connected';
RESET ROLE;

ROLLBACK;
