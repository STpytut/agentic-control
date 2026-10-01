-- The database follows the host to the product's layout (WP-5c).
--
--   /srv/infra-cod-handoff-poc/workspaces/… -> /srv/infra-cod/workspaces/…
--   codex-home:codex-poc                     -> codex-home:codex-worker
--
-- The host side — the account renamed with its home, the roots moved — is done
-- by services/operations/layout-migration.mjs, which the release's migration
-- runner calls before this file and reverts if this file fails. The two move
-- together or not at all, which is why this migration is declared
-- backward-incompatible: the coordinator stops every service before the
-- runner, and a release from before it would look for the old paths.
--
-- Rewritten: what running code reads — each project's workspace path, the
-- stored Codex credential reference, and the workspace reference a handoff
-- carries forward into its revisions. Not rewritten: history. Audit rows,
-- domain events, commands, receipts and finished operations say where things
-- were at the time, and stay true.
--
-- The two functions that write the credential reference are redefined from
-- their own definitions with the one literal replaced, so body, SECURITY
-- DEFINER, search_path and grants are exactly what they were.
SET search_path TO control_plane, public, extensions;

DO $$
DECLARE v_function regprocedure; v_definition text;
BEGIN
  FOR v_function IN
    SELECT p.oid::regprocedure FROM pg_proc p
    WHERE p.pronamespace='control_plane'::regnamespace AND p.prosrc LIKE '%codex-home:codex-poc%'
  LOOP
    v_definition:=replace(pg_get_functiondef(v_function),'codex-home:codex-poc','codex-home:codex-worker');
    EXECUTE v_definition;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_proc p WHERE p.pronamespace='control_plane'::regnamespace
             AND p.prosrc LIKE '%codex-poc%') THEN
    RAISE EXCEPTION 'a function still names codex-poc after the rewrite';
  END IF;
END $$;

UPDATE provider_connections
SET native_credential_reference='codex-home:codex-worker', updated_at=clock_timestamp()
WHERE native_credential_reference='codex-home:codex-poc';

UPDATE projects
SET workspace_path='/srv/infra-cod/workspaces'||substr(workspace_path,length('/srv/infra-cod-handoff-poc/workspaces')+1)
WHERE workspace_path LIKE '/srv/infra-cod-handoff-poc/workspaces/%';

UPDATE handoffs
SET workspace_ref='/srv/infra-cod/workspaces'||substr(workspace_ref,length('/srv/infra-cod-handoff-poc/workspaces')+1)
WHERE workspace_ref LIKE '/srv/infra-cod-handoff-poc/workspaces/%';

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM projects WHERE workspace_path LIKE '/srv/infra-cod-handoff-poc/%')
     OR EXISTS (SELECT 1 FROM provider_connections WHERE native_credential_reference LIKE '%codex-poc%')
     OR EXISTS (SELECT 1 FROM handoffs WHERE workspace_ref LIKE '/srv/infra-cod-handoff-poc/%') THEN
    RAISE EXCEPTION 'a live row still names the legacy layout after the rewrite';
  END IF;
END $$;

SELECT assert_web_functions_run_as_definer();
