BEGIN;
SET search_path TO control_plane,public;

DO $$
DECLARE v_user uuid; v_project uuid; v_operation jsonb; v_claim jsonb; v_state jsonb;
BEGIN
  INSERT INTO users(display_name) VALUES('Workspace UX Test') RETURNING id INTO v_user;
  INSERT INTO projects(owner_id,name,slug,workspace_path,status,settings)
    VALUES(v_user,'Workspace UX','workspace-ux-test','/srv/workspace-ux-test','needs_attention','{"provisioning_status":"ready"}')
    RETURNING id INTO v_project;
  INSERT INTO workspace_locks(project_id,status,reason) VALUES(v_project,'reconciliation_required','lease_expired');
  v_state:=record_project_workspace_state(v_project,'test-collector','codex/test','abc123','origin/main',2,1,true,
    '[{"path":"src/app.ts","status":"M"}]','{"files":1,"additions":4,"deletions":2}');
  IF v_state->>'branch'<>'codex/test' OR (v_state->>'dirty')::boolean IS NOT TRUE THEN
    RAISE EXCEPTION 'workspace state was not recorded'; END IF;
  v_operation:=request_workspace_operation(v_project,'recover_lock','operator-test','Verified stale process is absent',v_project::text);
  v_claim:=claim_workspace_operation('workspace-test-worker');
  IF v_claim->>'id'<>v_operation->>'operation_id' THEN RAISE EXCEPTION 'workspace operation was not claimed'; END IF;
  PERFORM finish_workspace_operation((v_claim->>'id')::uuid,'workspace-test-worker',true,'{"owner":"codex-worker"}',NULL);
  IF (SELECT status FROM workspace_locks WHERE project_id=v_project)<>'released'
     OR (SELECT status FROM projects WHERE id=v_project)<>'active'
     OR NOT EXISTS(SELECT 1 FROM domain_events WHERE project_id=v_project AND event_type='workspace.recovered') THEN
    RAISE EXCEPTION 'workspace recovery was not finalized'; END IF;
  v_operation:=request_workspace_operation(v_project,'restore_owner','operator-test','Restore canonical read owner',v_project::text);
  v_claim:=claim_workspace_operation('workspace-test-worker');
  PERFORM finish_workspace_operation((v_claim->>'id')::uuid,'workspace-test-worker',false,'{}','simulated process guard');
  IF (SELECT status FROM workspace_operations WHERE id=(v_claim->>'id')::uuid)<>'failed' THEN
    RAISE EXCEPTION 'failed ownership operation was not recorded'; END IF;
END $$;
ROLLBACK;
