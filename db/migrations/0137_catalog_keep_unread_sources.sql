-- A Claude model list that could not be read keeps the models it listed before.
--
-- On 2026-10-07 the Claude Code token on the host had expired. The supervisor
-- answered the model list with {"error":"expired"} by design (it does not
-- refresh tokens), discovery returned the aliases alone, and the refresh's end
-- marked every model the list had named before — claude-sonnet-5-5,
-- claude-opus-5-5 — unavailable. Their checks then refused them as "not in the
-- connection's current model list", and teams pinned to them stopped, though
-- nothing about the models had changed: only the list had not been read.
--
-- A list not read says nothing about what it would have named. The refresh now
-- names the discovery sources it did not read, and entries from those sources
-- keep their status. The default keeps the old meaning, so a caller of the
-- four-argument form is unchanged.

SET search_path TO control_plane, public, extensions;

DROP FUNCTION complete_catalog_refresh(uuid, text, uuid[], text);

CREATE FUNCTION complete_catalog_refresh(
  p_refresh_id uuid, p_worker_id text, p_seen_entry_ids uuid[],
  p_missing_status text DEFAULT 'unavailable',
  p_unread_sources text[] DEFAULT '{}'
) RETURNS jsonb
LANGUAGE plpgsql
SET search_path TO control_plane, public, extensions, pg_temp
AS $$
DECLARE v_job catalog_refresh_jobs%ROWTYPE; v_missing integer;
BEGIN
  IF p_missing_status NOT IN ('stale','unavailable') THEN
    RAISE EXCEPTION 'invalid catalog missing status' USING ERRCODE='22023',
      DETAIL=jsonb_build_object('reason','catalog_entry_invalid')::text;
  END IF;
  SELECT * INTO v_job FROM catalog_refresh_jobs
  WHERE id=p_refresh_id AND status='in_progress'
    AND leased_by=p_worker_id AND leased_until>clock_timestamp()
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'catalog refresh lease is unavailable' USING ERRCODE='55000',
    DETAIL=jsonb_build_object('reason','catalog_refresh_not_leased')::text; END IF;

  UPDATE provider_model_catalog SET
    status='unavailable', stale_at=clock_timestamp(),
    verification_id=NULL, verified_lease_until=NULL,
    gate_requested_at=NULL,
    updated_at=clock_timestamp(), version=version+1
  WHERE connection_id=v_job.connection_id
    AND superseded_by IS NULL
    AND status IN ('discovered','verified','rejected')
    AND NOT (id = ANY(COALESCE(p_seen_entry_ids,'{}'::uuid[])))
    AND NOT (discovery_source = ANY(COALESCE(p_unread_sources,'{}'::text[])));
  GET DIAGNOSTICS v_missing = ROW_COUNT;

  UPDATE catalog_refresh_jobs SET
    status='completed', completed_at=clock_timestamp(),
    leased_by=NULL, leased_until=NULL
  WHERE id=v_job.id;
  PERFORM write_audit_event(NULL,NULL,NULL,'system',p_worker_id,
    'catalog.refresh_completed','provider_connection',v_job.connection_id::text,
    'allowed',NULL,jsonb_build_object('entries_seen',v_job.entries_seen,'missing',v_missing,
      'unread_sources',to_jsonb(COALESCE(p_unread_sources,'{}'::text[]))),
    v_job.id::text);
  RETURN jsonb_build_object(
    'refresh_id',v_job.id,'status','completed','entries_seen',v_job.entries_seen,
    'missing_marked',v_missing
  );
END; $$;

REVOKE ALL ON FUNCTION complete_catalog_refresh(uuid,text,uuid[],text,text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION complete_catalog_refresh(uuid,text,uuid[],text,text[]) TO infra_worker;
