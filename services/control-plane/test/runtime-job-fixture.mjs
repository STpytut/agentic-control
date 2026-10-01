// A project with Codex orchestrating and OpenCode executing, a task delegated
// to the executor and the delegation routed to its job, and the host's report
// of the runtimes — shared by the 3.8 race and the dead-letter recovery tests,
// which start from the same place.
import { driverFor } from "../../runtime-supervisor/drivers/index.mjs";

// The snapshot the timer writes, reduced to what the gate reads. Everything
// else in it (services, backup, disk) is not what dispatch asks.
export function snapshotOf(runtimes) {
  const observedAt = new Date().toISOString();
  return {
    status: "healthy",
    observed_at: observedAt,
    snapshot: JSON.stringify({
      type: "health.snapshot", observed_at: observedAt,
      runtimes: Object.entries(runtimes).map(([runtime, state]) => ({
        runtime, version: state.version ?? driverFor(runtime).verified.runtimeVersion,
        installed: state.installed, authenticated: state.authenticated,
        capability_verified: false, self_update_managed: true, ready: false,
      })),
    }),
  };
}

export const READY = { codex: { installed: true, authenticated: true }, opencode: { installed: true, authenticated: true } };


// A project with Codex orchestrating and OpenCode executing, a task delegated
// to the executor, and the delegation routed to its job — the "selected" point.
// The 0042 fixture, which is the product's own path from request_implementation
// to a job.
export const FIXTURE_FUNCTION = `
CREATE FUNCTION race_fixture(p_tag text) RETURNS jsonb LANGUAGE plpgsql
SET search_path=control_plane,public,extensions AS $$
DECLARE v_user uuid; v_project uuid; v_codex_profile uuid; v_executor_profile uuid; v_codex uuid; v_worker uuid;
  v_orchestrator uuid; v_executor uuid; v_session uuid; v_task uuid; v_request jsonb; v_message outbox_messages;
BEGIN
  INSERT INTO users(display_name) VALUES('Race '||p_tag) RETURNING id INTO v_user;
  INSERT INTO projects(owner_id,name,slug,workspace_path)
    VALUES(v_user,'Race '||p_tag,'race-'||p_tag,'/srv/infra-cod/workspaces/race-'||p_tag) RETURNING id INTO v_project;
  INSERT INTO workspace_locks(project_id) VALUES(v_project) ON CONFLICT DO NOTHING;
  INSERT INTO runtime_profiles(runtime_type,adapter_version,runtime_version,provider_type,model)
    VALUES('codex','test','test','openai','codex-'||p_tag) RETURNING id INTO v_codex_profile;
  INSERT INTO runtime_profiles(runtime_type,adapter_version,runtime_version,provider_type,model)
    VALUES('opencode','test','test','opencode-free','opencode-'||p_tag) RETURNING id INTO v_executor_profile;
  INSERT INTO agents(name,role,runtime_profile_id) VALUES('race-codex-'||p_tag,'architect',v_codex_profile) RETURNING id INTO v_codex;
  INSERT INTO agents(name,role,runtime_profile_id) VALUES('race-worker-'||p_tag,'implementer',v_executor_profile) RETURNING id INTO v_worker;
  INSERT INTO project_agent_assignments(project_id,agent_id,runtime_profile_id,assignment_role,is_default)
    VALUES(v_project,v_codex,v_codex_profile,'orchestrator',true) RETURNING id INTO v_orchestrator;
  INSERT INTO project_agent_assignments(project_id,agent_id,runtime_profile_id,assignment_role)
    VALUES(v_project,v_worker,v_executor_profile,'executor') RETURNING id INTO v_executor;
  INSERT INTO agent_sessions(project_id,agent_id,runtime_profile_id,purpose,native_session_id)
    VALUES(v_project,v_worker,v_executor_profile,'implementation','ses_race_'||p_tag) RETURNING id INTO v_session;
  INSERT INTO tasks(project_id,title,objective,status,active_agent_id,orchestrator_assignment_id,created_by,acceptance_criteria)
    VALUES(v_project,'Race '||p_tag,'test','ready',v_codex,v_orchestrator,'test','["done"]') RETURNING id INTO v_task;
  v_request:=request_implementation(v_project,v_task,v_codex,v_worker,1,'Implement','[]','[]','["done"]','[]',
    '/srv/infra-cod/workspaces/race-'||p_tag,'delegate:'||v_task,1,v_task::text);
  UPDATE handoffs SET executor_assignment_id=v_executor WHERE id=(v_request->>'handoff_id')::uuid;
  v_message:=claim_outbox_event((v_request->>'event_id')::uuid,'race-dispatcher',interval '1 minute');
  PERFORM route_outbox_message(v_message.id,'race-dispatcher');
  RETURN jsonb_build_object('project',v_project,'task',v_task,'session',v_session,'codex',v_codex,
    'event',v_request->>'event_id',
    'job',(SELECT id FROM runtime_jobs WHERE source_event_id=(v_request->>'event_id')::uuid AND job_type='implementation_run'));
END $$;`;

