BEGIN;

SET search_path TO control_plane, public;

DO $$
DECLARE
  v_owner uuid;
  v_project_id uuid;
  v_task_id uuid;
  v_event_id uuid;
  v_job_id bigint;
  v_heartbeat timestamptz;
  v_job runtime_jobs%ROWTYPE;
BEGIN
  INSERT INTO users(display_name) VALUES('Runtime activity test owner') RETURNING id INTO v_owner;
  INSERT INTO projects(owner_id,name,slug,workspace_path,default_branch)
  VALUES(v_owner,'Runtime activity fixture','runtime-activity-fixture',
         '/fixture/workspaces/runtime-activity-fixture','main')
  RETURNING id INTO v_project_id;
  INSERT INTO tasks(project_id,title,objective,status,created_by)
  VALUES(v_project_id,'Fixture task','Fixture objective','draft','runtime-activity-test')
  RETURNING id INTO v_task_id;
  INSERT INTO domain_events(
    event_type,project_id,task_id,actor_type,actor_id,
    correlation_id,aggregate_type,aggregate_id,aggregate_version,payload
  ) VALUES(
    'implementation.requested',v_project_id,v_task_id,'system','runtime-activity-test',
    'runtime-activity-fixture-correlation','task',v_task_id,1,'{}'::jsonb
  ) RETURNING id INTO v_event_id;

  INSERT INTO runtime_jobs(source_event_id,job_type,project_id,task_id,payload)
  VALUES(v_event_id,'orchestrator_turn',v_project_id,v_task_id,'{}'::jsonb)
  RETURNING id INTO v_job_id;

  UPDATE runtime_jobs SET status='in_flight',leased_by='activity-test',
    leased_until=clock_timestamp()+interval '5 minutes',completed_at=NULL,
    activity_phase='starting_runtime',activity_detail=NULL,started_at=NULL,heartbeat_at=NULL
  WHERE id=v_job_id;

  SELECT update_runtime_job_activity(v_job_id,'activity-test','running_turn','Processing test turn')
    INTO v_heartbeat;
  SELECT * INTO v_job FROM runtime_jobs WHERE id=v_job_id;
  IF v_job.activity_phase<>'running_turn' OR v_job.activity_detail<>'Processing test turn'
     OR v_job.started_at IS NULL OR v_job.heartbeat_at IS NULL THEN
    RAISE EXCEPTION 'runtime activity telemetry was not persisted';
  END IF;

  PERFORM heartbeat_runtime_job(v_job_id,'activity-test',interval '5 minutes');
  IF (SELECT heartbeat_at FROM runtime_jobs WHERE id=v_job_id)<=v_heartbeat THEN
    RAISE EXCEPTION 'runtime heartbeat timestamp did not advance';
  END IF;

  BEGIN
    PERFORM update_runtime_job_activity(v_job_id,'activity-test','invented_phase','invalid');
    RAISE EXCEPTION 'invalid phase unexpectedly accepted';
  EXCEPTION WHEN SQLSTATE '22023' THEN NULL;
  END;
END;
$$;

ROLLBACK;
