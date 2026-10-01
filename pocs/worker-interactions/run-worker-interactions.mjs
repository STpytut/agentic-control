import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { queryControlPlane, queryControlPlaneJson } from "../codex-opencode-handoff/control-plane-db.mjs";
import { dispatchOnce } from "../../services/control-plane/dispatcher.mjs";
import { RuntimeSupervisorClient } from "../../services/runtime-supervisor/client.mjs";

if (process.getuid?.() !== 0) throw new Error("worker interaction PoC must run as root");
const here = path.dirname(fileURLToPath(import.meta.url));
const model = process.env.OPENCODE_POC_MODEL ?? "opencode/north-mini-code-free";
const ids = { user:randomUUID(),project:randomUUID(),runtime:randomUUID(),codex:randomUUID(),worker:randomUUID(),session:randomUUID() };
const workspace = `/srv/infra-cod-handoff-poc/workspaces/${ids.project}`;
await mkdir(workspace,{recursive:true});
await writeFile(path.join(workspace,"AGENTS.md"),"# Worker interaction test\nDo not modify files. Use the requested terminal platform tool exactly once.\n");
queryControlPlane(`BEGIN;
 INSERT INTO users(id,display_name) VALUES(:'user'::uuid,'Worker Signals');
 INSERT INTO projects(id,owner_id,name,slug,workspace_path) VALUES(:'project'::uuid,:'user'::uuid,'Worker Signals',:'slug',:'workspace');
 INSERT INTO runtime_profiles(id,runtime_type,adapter_version,runtime_version,provider_type,model) VALUES(:'runtime'::uuid,'opencode','signals-poc','1.18.3','opencode-free',:'model');
 INSERT INTO agents(id,name,role,runtime_profile_id) VALUES(:'codex'::uuid,:'codex_name','architect',:'runtime'::uuid),(:'worker'::uuid,:'worker_name','implementer',:'runtime'::uuid);
 INSERT INTO agent_sessions(id,project_id,agent_id,runtime_profile_id,purpose) VALUES(:'session'::uuid,:'project'::uuid,:'worker'::uuid,:'runtime'::uuid,'implementation');
 COMMIT; SELECT 'ok';`,{...ids,slug:`worker-signals-${ids.project}`,workspace,model,codex_name:`codex-${ids.project}`,worker_name:`worker-${ids.project}`});

const client=new RuntimeSupervisorClient(); await client.connect(); const probe=await client.ping();
const results=[];
let nativeSessionId=null;
for (const type of ["blocker","input_request"]) {
 const task=randomUUID();
 queryControlPlane(`INSERT INTO tasks(id,project_id,title,objective,status,active_agent_id,created_by)
  VALUES(:'task'::uuid,:'project'::uuid,:'title','Exercise structured worker signal','ready',:'codex'::uuid,'poc'); SELECT 'ok';`,
  {task,project:ids.project,title:`Worker ${type}`,codex:ids.codex});
 const request=queryControlPlaneJson(`SELECT request_implementation(:'project'::uuid,:'task'::uuid,:'codex'::uuid,:'worker'::uuid,1,
  'Signal only','[]','[]','["structured signal persisted"]','[]',:'workspace',:'key',1,:'task')::text;`,
  {project:ids.project,task,codex:ids.codex,worker:ids.worker,workspace,key:`delegate:${task}:1`});
 dispatchOnce({dispatcherId:"worker-signals-dispatcher",batchSize:100,lease:"2 minutes"});
 const job=queryControlPlaneJson(`SELECT to_jsonb(claim_runtime_job_for_event(:'event'::uuid,'start_implementation',:'supervisor',interval '2 minutes'))::text;`,
  {event:request.event_id,supervisor:probe.supervisor_id});
 const start=queryControlPlaneJson(`SELECT start_implementation_job(:'job'::bigint,:'session'::uuid,:'supervisor',interval '2 minutes')::text;`,
  {job:job.id,session:ids.session,supervisor:probe.supervisor_id});
 const prompt=type==="blocker"
  ? "Do not modify files. Call report_blocker exactly once with reason='Required dependency is unavailable', attempted=['Inspected task contract'], requested_action='Provide dependency'. Then stop."
  : "Do not modify files. Call request_user_input exactly once with question='Which supported option should be used?', sensitivity='normal', context='A user decision is required'. Then stop.";
 const timer=setInterval(()=>queryControlPlane(`SELECT heartbeat_runtime_job(:'job'::bigint,:'supervisor',interval '2 minutes'); SELECT heartbeat_workspace_lock(:'project'::uuid,:'run'::uuid,:'fence'::bigint,interval '2 minutes');`,
  {job:job.id,supervisor:probe.supervisor_id,project:ids.project,run:start.run_id,fence:start.fencing_token}),20_000);
 let runtime;
 try { runtime=await client.runOpenCode({jobId:job.id,runId:start.run_id,projectId:ids.project,fencingToken:start.fencing_token,prompt,model,nativeSessionId}); }
 finally { clearInterval(timer); }
 queryControlPlane(`SELECT acknowledge_runtime_job(:'job'::bigint,:'supervisor',:'result'::jsonb);`,
  {job:job.id,supervisor:probe.supervisor_id,result:JSON.stringify(runtime.interaction_result)});
 nativeSessionId=runtime.interaction_report.native_session_id;
 const state=queryControlPlaneJson(`SELECT jsonb_build_object(
  'task_status',(SELECT status FROM tasks WHERE id=:'task'::uuid),
  'run_status',(SELECT status FROM task_runs WHERE id=:'run'::uuid),
  'lock_status',(SELECT status FROM workspace_locks WHERE project_id=:'project'::uuid),
  'event_type',(SELECT event_type FROM domain_events WHERE id=(:'result'::jsonb->>'event_id')::uuid),
  'audit_count',(SELECT count(*) FROM audit_events WHERE run_id=:'run'::uuid))::text;`,
  {task,run:start.run_id,project:ids.project,result:JSON.stringify(runtime.interaction_result)});
 results.push({type,exitCode:runtime.exit_code,report:runtime.interaction_report,result:runtime.interaction_result,state});
}
client.close();
const checks={
 blocker:results[0].report?.report_type==="blocker"&&results[0].state.event_type==="implementation.blocked",
 inputRequest:results[1].report?.report_type==="input_request"&&results[1].state.event_type==="run.input_requested",
 sessionContinuity:results[0].report?.native_session_id===results[1].report?.native_session_id,
 safeState:results.every((r)=>r.exitCode===0&&r.state.task_status==="needs_attention"&&r.state.run_status==="blocked"&&r.state.lock_status==="released"&&r.state.audit_count===1),
};
const report={passed:Object.values(checks).every(Boolean),model,projectId:ids.project,results,checks,testedAt:new Date().toISOString()};
await writeFile(path.join(here,"latest-result.json"),`${JSON.stringify(report,null,2)}\n`);
process.stdout.write(`${JSON.stringify(report,null,2)}\n`);
if(!report.passed) process.exit(1);
