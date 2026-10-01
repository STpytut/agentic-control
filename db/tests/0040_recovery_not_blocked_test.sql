-- Recovering a stale lock is not refused by the Codex turn waiting for it
-- (migration 0064, found in the panel on rc.27). Called as the panel calls it,
-- as infra_web.
\set ON_ERROR_STOP on

BEGIN;
SET search_path TO control_plane, public, extensions;

CREATE TEMP TABLE recovery_fixture(project_id uuid, task_id uuid, event_id uuid) ON COMMIT DROP;
GRANT SELECT ON recovery_fixture TO infra_web;
CREATE TEMP TABLE recovery_result(label text PRIMARY KEY, outcome text) ON COMMIT DROP;
GRANT INSERT ON recovery_result TO infra_web;
DO $$
DECLARE v_user uuid; v_project uuid; v_task uuid; v_event domain_events;
BEGIN
  INSERT INTO users(display_name) VALUES('Recovery') RETURNING id INTO v_user;
  INSERT INTO projects(owner_id,name,slug,workspace_path)
    VALUES(v_user,'Recovery','recovery','/srv/recovery') RETURNING id INTO v_project;
  INSERT INTO workspace_locks(project_id,status,reason) VALUES(v_project,'reconciliation_required','lease_expired');
  INSERT INTO tasks(project_id,title,objective,status,created_by)
    VALUES(v_project,'waiting','x','planning','test') RETURNING id INTO v_task;
  v_event:=append_event('chat.user_message',v_project,v_task,NULL,'user','test',NULL,'recovery',
    'recovery-1','task',v_task,1,'{}'::jsonb);
  INSERT INTO recovery_fixture VALUES(v_project,v_task,v_event.id);
END $$;

CREATE FUNCTION pg_temp.recover(p_type text) RETURNS text LANGUAGE plpgsql AS $$
DECLARE v_project uuid;
BEGIN
  SELECT project_id INTO v_project FROM recovery_fixture;
  PERFORM request_workspace_operation(v_project,p_type,'operator','recovery test','recovery');
  RETURN 'accepted';
EXCEPTION WHEN SQLSTATE '55000' THEN
  RETURN 'refused: '||SQLERRM;
END $$;
GRANT EXECUTE ON FUNCTION pg_temp.recover(text) TO infra_web;

CREATE FUNCTION pg_temp.job(p_type text, p_status text) RETURNS bigint LANGUAGE plpgsql AS $$
DECLARE v_f recovery_fixture; v_id bigint;
BEGIN
  SELECT * INTO v_f FROM recovery_fixture;
  DELETE FROM runtime_jobs WHERE project_id=v_f.project_id;
  INSERT INTO runtime_jobs(source_event_id,job_type,project_id,task_id,status)
    VALUES(v_f.event_id,p_type,v_f.project_id,v_f.task_id,'pending') RETURNING id INTO v_id;
  IF p_status='in_flight' THEN
    -- claim-shaped: an in-flight Codex turn has a run (0059), an implementation a lease
    UPDATE runtime_jobs SET status='in_flight',leased_by='w',leased_until=clock_timestamp()+interval '5 minutes'
    WHERE id=v_id AND job_type='implementation_run';
  END IF;
  RETURN v_id;
END $$;

-- A Codex turn waiting for the lock does not block recovering it.
SELECT pg_temp.job('orchestrator_turn','pending');
SET ROLE infra_web;
INSERT INTO recovery_result VALUES('waiting_turn', pg_temp.recover('recover_lock'));
RESET ROLE;
DO $$ BEGIN
  IF (SELECT outcome FROM recovery_result WHERE label='waiting_turn') <> 'accepted' THEN RAISE EXCEPTION 'a waiting read-only turn blocked recovery: %', (SELECT outcome FROM recovery_result WHERE label='waiting_turn'); END IF;
END $$;
DELETE FROM workspace_operations WHERE project_id=(SELECT project_id FROM recovery_fixture);

-- A pending implementation is about to take the lock: recovery waits for it.
SELECT pg_temp.job('implementation_run','pending');
SET ROLE infra_web;
INSERT INTO recovery_result VALUES('pending_writer', pg_temp.recover('recover_lock'));
RESET ROLE;
DO $$ BEGIN
  IF (SELECT outcome FROM recovery_result WHERE label='pending_writer') NOT LIKE 'refused: workspace has active or pending runtime work%' THEN
    RAISE EXCEPTION 'recovery ran beside a pending implementation: %', (SELECT outcome FROM recovery_result WHERE label='pending_writer'); END IF;
END $$;

-- Work in flight: recovery waits.
SELECT pg_temp.job('implementation_run','in_flight');
SET ROLE infra_web;
INSERT INTO recovery_result VALUES('in_flight', pg_temp.recover('recover_lock'));
RESET ROLE;
DO $$ BEGIN
  IF (SELECT outcome FROM recovery_result WHERE label='in_flight') NOT LIKE 'refused: workspace has active or pending runtime work%' THEN
    RAISE EXCEPTION 'recovery ran beside work in flight: %', (SELECT outcome FROM recovery_result WHERE label='in_flight'); END IF;
END $$;

-- restore_owner keeps the 0017 rule: a pending turn blocks it.
UPDATE workspace_locks SET status='released', reason=NULL WHERE project_id=(SELECT project_id FROM recovery_fixture);
SELECT pg_temp.job('orchestrator_turn','pending');
SET ROLE infra_web;
INSERT INTO recovery_result VALUES('restore_owner', pg_temp.recover('restore_owner'));
RESET ROLE;
DO $$ BEGIN
  IF (SELECT outcome FROM recovery_result WHERE label='restore_owner') NOT LIKE 'refused: workspace has active or pending runtime work%' THEN
    RAISE EXCEPTION 'restore_owner ran beside a pending turn: %', (SELECT outcome FROM recovery_result WHERE label='restore_owner'); END IF;
  RAISE NOTICE 'a waiting read-only turn does not block recovering the lock; a writer, work in flight, and restore_owner still wait';
END $$;

ROLLBACK;
