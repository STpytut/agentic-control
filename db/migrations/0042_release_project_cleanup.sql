-- Lets a cleanup claim be handed back without recording a failure.
--
-- Every error out of the supervisor's deprovision path currently reaches
-- fail_project_cleanup, which parks the project in deletion_failed for an
-- operator to retry. 0041 made cleanup refuse to run while a system workspace
-- operation is active, which is correct — but inspection runs every twenty
-- seconds per project, so an ordinary collision would turn a routine deletion
-- into something needing manual intervention.
--
-- Releasing returns the project to the claimable pool with its lease cleared,
-- leaving deletion_requested_at and the rest untouched, so the next cycle picks
-- it up as if nothing had happened.

SET search_path TO control_plane, public, extensions;

CREATE OR REPLACE FUNCTION release_project_cleanup(
  p_project_id uuid, p_worker_id text, p_reason text DEFAULT ''
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_project projects%ROWTYPE;
BEGIN
  UPDATE projects SET cleanup_leased_by=NULL, cleanup_leased_until=NULL,
    updated_at=clock_timestamp()
  WHERE id=p_project_id AND cleanup_leased_by=p_worker_id AND status='deleting'
  RETURNING * INTO v_project;

  IF NOT FOUND THEN RETURN NULL; END IF;

  -- Recorded, so a project that keeps colliding is visible rather than merely
  -- slow. The attempt count is deliberately not raised: nothing was attempted.
  PERFORM write_audit_event(p_project_id,NULL,NULL,'system',p_worker_id,
    'project.cleanup_deferred','project',p_project_id::text,'not_required',NULL,
    jsonb_build_object('reason',left(coalesce(p_reason,''),500)),'');

  RETURN jsonb_build_object('project_id',v_project.id,'status',v_project.status,
                            'released',true);
END $$;

ALTER FUNCTION release_project_cleanup(uuid,text,text)
  SET search_path=control_plane,public,extensions,pg_temp;

REVOKE ALL ON FUNCTION release_project_cleanup(uuid,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION release_project_cleanup(uuid,text,text) TO infra_worker;
