-- Every function the web role can execute runs as its owner — restored, and
-- held by a guard that runs after every migration.
--
-- CREATE OR REPLACE FUNCTION resets every attribute its statement does not
-- repeat, SECURITY DEFINER included. 0038 made the web tier's functions definers
-- with separate ALTER statements, and two later migrations redefined one each
-- without repeating it:
--
--   0058 request_revision            "Request changes" in the panel
--   0061 resolve_worker_interaction  answering an implementation's question
--
-- infra_web has no DML, so as invoker both fail on their first write. On the
-- production host both were broken and neither had been used since: no operator
-- change request after 0058 was applied, and no input request ever answered.
--
-- db/tests/0026 checked five web-facing functions by name, and neither of these
-- was among the five. A list has to be remembered; an invariant does not.
-- assert_web_functions_run_as_definer() checks every function infra_web can
-- execute, and services/control-plane/migrate.mjs runs it after each migration
-- the way it runs assert_no_public_function_execute(), so the next redefinition
-- that drops the attribute fails its update instead of a button.
SET search_path TO control_plane, public, extensions;

CREATE OR REPLACE FUNCTION assert_web_functions_run_as_definer()
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE v_offenders text[];
BEGIN
  SELECT array_agg(p.proname||'('||pg_get_function_identity_arguments(p.oid)||')' ORDER BY p.proname)
  INTO v_offenders
  FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname='control_plane'
    AND has_function_privilege('infra_web', p.oid, 'EXECUTE')
    AND (NOT p.prosecdef
         OR p.proconfig IS NULL
         OR NOT EXISTS (SELECT 1 FROM unnest(p.proconfig) c WHERE c LIKE 'search_path=%'));
  IF v_offenders IS NOT NULL THEN
    RAISE EXCEPTION 'functions the web role can execute do not run as their owner with a pinned search_path: %',
      array_to_string(v_offenders,', ')
      USING ERRCODE='42501',
      DETAIL='A CREATE OR REPLACE of a web-facing function must repeat SECURITY DEFINER, or be followed by ALTER FUNCTION ... SECURITY DEFINER.';
  END IF;
  RETURN jsonb_build_object('checked',(SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='control_plane' AND has_function_privilege('infra_web', p.oid, 'EXECUTE')),'checked_at',clock_timestamp());
END $$;

ALTER FUNCTION request_revision(uuid,uuid,uuid,jsonb,jsonb,text,bigint,text) SECURITY DEFINER;
ALTER FUNCTION resolve_worker_interaction(uuid,text,jsonb,text) SECURITY DEFINER;

ALTER FUNCTION assert_web_functions_run_as_definer()
  SET search_path=control_plane,public,extensions,pg_temp;
REVOKE EXECUTE ON FUNCTION assert_web_functions_run_as_definer() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION assert_web_functions_run_as_definer() TO infra_worker;

-- The migration proves itself: it does not commit if any web function still
-- runs as its caller.
SELECT assert_web_functions_run_as_definer();
