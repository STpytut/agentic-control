// An OpenCode orchestrator's turns, end to end, offline (Stage 11.2 N5).
//
// The real supervisor (`server.mjs`, as root), the real dispatcher and the
// real orchestrator worker (`once`), a migrated PostgreSQL, the accounts and
// layout the product uses — and a stand-in `opencode` that records how it was
// started and behaves as a turn would: it answers, and when asked it calls
// delegate_task over the run's socket with the capability from its
// environment. The stand-in also tries to write the workspace, directly and
// through a shell it starts, which is what the kernel must refuse.
//
// Two turns in one conversation:
//
//   1. an answer, in a new session: the session the run named is bound, the
//      answer is the conversation's reply, the workspace is back with its
//      resting owner and unchanged;
//   2. Stop run, as the panel asks for it, on a turn that holds its process:
//      the supervisor delivers it from the run's mailbox to the run's cgroup,
//      the command is acknowledged with the runtime's receipt, the run is
//      interrupted and the job finished — within seconds, not the timeout;
//   3. a delegation, resuming that session by id: `--session` on the command
//      line, `delegate_task` answered by the database under the worker's
//      lease, the task delegated to its executor.
//
// It changes the machine — accounts, /srv, /usr/local/bin — so it runs only
// in the gate's disposable container, which says so with
// INFRA_COD_GATE_CONTAINER=1; anywhere else it skips and says why.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, rmdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

import { RUNTIME_HEALTH_UPSERT_SQL } from "../../operations/health-state.mjs";
import { READY, snapshotOf } from "../../control-plane/test/runtime-job-fixture.mjs";

const ROOT = path.resolve(import.meta.dirname, "../../..");
const adminDatabaseUrl = process.env.DATABASE_URL;

function landlockAbi() {
  if (process.platform !== "linux") return 0;
  const probe = spawnSync("python3", ["-c",
    "import ctypes;l=ctypes.CDLL(None);print(l.syscall(444,None,ctypes.c_size_t(0),ctypes.c_uint32(1)))"], { encoding: "utf8" });
  return probe.status === 0 ? Number(probe.stdout.trim()) : 0;
}
// The isolation the supervisor can have here. The gate's container mounts the
// cgroup filesystem read-only, so the supervisor is started with the process
// group it had before K1 and says so; where the cgroup subtree is writable —
// a privileged container, the host — it runs as the product does, and the
// receipt names the cgroup (run-cgroup.test.mjs proves the cgroup itself).
function isolationAvailable() {
  if (process.platform !== "linux") return "process_group";
  try {
    const own = readFileSync("/proc/self/cgroup", "utf8").split("\n").find((line) => line.startsWith("0::"));
    const root = path.posix.join("/sys/fs/cgroup", own.slice(3).trim());
    const probe = path.join(root, `probe-${randomUUID()}`);
    mkdirSync(probe);
    rmdirSync(probe);
    return "cgroup";
  } catch {
    return "process_group";
  }
}
const isolation = isolationAvailable();
const skip = process.env.INFRA_COD_GATE_CONTAINER !== "1" ? "runs only in the gate's disposable container (INFRA_COD_GATE_CONTAINER=1)"
  : process.getuid?.() !== 0 ? "needs root, as the supervisor runs"
    : !adminDatabaseUrl ? "DATABASE_URL is not set"
      : landlockAbi() < 1 ? "needs a kernel with Landlock" : false;

const WORKSPACE = "/srv/infra-cod/workspaces/e2e-orchestrator";
const RECORDS = "/tmp/e2e-opencode";
const SOCKET = "/run/infra-cod/runtime-supervisor.sock";
const WORKER = "e2e-orchestrator-worker";
const SESSION = "ses_e2e_orchestrator";

// The stand-in. Python, at /usr/local/bin like the real one's shim, because
// the supervisor's PATH for a runtime starts with /usr/local/bin.
const STAND_IN = String.raw`#!/usr/bin/python3
import json, os, socket, subprocess, sys, time
args = sys.argv[1:]
session = args[args.index("--session") + 1] if "--session" in args else None
prompt = args[-1]
record = {"argv": args, "uid": os.getuid(), "cwd": os.getcwd(), "env": {k: os.environ.get(k) for k in (
    "OPENCODE_CONFIG_CONTENT", "OPENCODE_DISABLE_PROJECT_CONFIG", "INFRA_WORKER_TOOL_SOCKET", "INFRA_WORKER_RUN_ID")}}
try:
    record["read"] = open("README.md").read()
except Exception as error:
    record["read"] = repr(error)
try:
    open("INTRUSION.txt", "w").write("x")
    record["write_errno"] = 0
except OSError as error:
    record["write_errno"] = error.errno
record["shell_write_status"] = subprocess.run(["/bin/sh", "-c", "echo y >> README.md"], capture_output=True).returncode
sid = session or "${SESSION}"
def emit(event):
    print(json.dumps(event), flush=True)
emit({"type": "step_start", "sessionID": sid})
if "HOLD_FOR_STOP" in prompt:
    open(os.path.join("${RECORDS}", "holding"), "w").write(str(os.getpid()))
    time.sleep(120)
answer = "E2E: answered."
if "DELEGATE_NOW" in prompt:
    client = socket.socket(socket.AF_UNIX)
    client.connect(os.environ["INFRA_WORKER_TOOL_SOCKET"])
    client.sendall((json.dumps({"type": "delegate_task", "capability": os.environ["INFRA_WORKER_CAPABILITY"],
        "native_session_id": sid, "call_id": "m_delegate:delegate_task",
        "arguments": {"objective": "Create e2e.md", "instructions": ["write one line"], "relevant_paths": ["e2e.md"]}}) + "\n").encode())
    data = b""
    while True:
        chunk = client.recv(65536)
        if not chunk:
            break
        data += chunk
    record["tool_answer"] = json.loads(data.decode().strip())
    emit({"type": "tool_use", "sessionID": sid, "part": {"tool": "delegate_task",
        "state": {"status": "completed" if record["tool_answer"].get("ok") else "error"}}})
    answer = "E2E: delegated."
emit({"type": "text", "sessionID": sid, "part": {"messageID": "m_final", "text": answer}})
emit({"type": "step_finish", "sessionID": sid, "part": {"reason": "stop", "tokens": {"input": 10, "output": 2}}})
with open(os.path.join("${RECORDS}", "%d.json" % time.time_ns()), "w") as out:
    json.dump(record, out)
`;

let scratch = "";
let url = "";
let supervisor = null;
let supervisorLog = "";
let fixture = null;

function adminUrl(database) {
  const parsed = new URL(adminDatabaseUrl);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

function psql(sql, target = url) {
  const input = target === url ? `SET search_path TO control_plane, public, extensions;\n${sql}` : sql;
  const result = spawnSync("psql", ["-X", "-qAt", "-v", "ON_ERROR_STOP=1", target], { encoding: "utf8", input });
  if (result.status !== 0) throw new Error(result.stderr.trim() || `psql exited ${result.status}`);
  return result.stdout.trim();
}

function sh(command) {
  execFileSync("/bin/sh", ["-c", command], { stdio: ["ignore", "ignore", "inherit"] });
}

function ensureUser(name, groups = []) {
  if (spawnSync("id", ["-u", name]).status !== 0) {
    execFileSync("useradd", ["--system", "--create-home", "--home-dir", `/home/${name}`, "--shell", "/usr/sbin/nologin",
      ...(groups.length ? ["--groups", groups.join(",")] : []), name]);
  }
}

function records() {
  return readdirSync(RECORDS).sort().map((name) => JSON.parse(readFileSync(path.join(RECORDS, name), "utf8")));
}

function node(script, args, extraEnv) {
  return spawnSync(process.execPath, [path.join(ROOT, script), ...args], {
    encoding: "utf8", timeout: 120_000,
    env: { ...process.env, DATABASE_URL: url, ...extraEnv },
  });
}

// One chat message, routed by the real dispatcher and turned by the real
// orchestrator worker, once each.
function turn(message) {
  psql(`SELECT record_task_chat_message('${fixture.project}','${fixture.task}',${literal(message)},'e2e','e2e');`);
  const dispatched = node("services/control-plane/dispatcher.mjs", ["once"], { DISPATCHER_ID: "e2e-dispatcher" });
  assert.equal(dispatched.status, 0, dispatched.stderr);
  const worked = node("services/control-plane/orchestrator-worker.mjs", ["once"], {
    RUNTIME_SUPERVISOR_SOCKET: SOCKET, ORCHESTRATOR_WORKER_ID: WORKER,
  });
  assert.equal(worked.status, 0, `${worked.stdout}\n${worked.stderr}\n--- supervisor ---\n${supervisorLog.slice(-4000)}`);
  return JSON.parse(psql(`SELECT jsonb_build_object('id',j.id,'job_type',j.job_type,'status',j.status,'last_error',j.last_error)::text
    FROM runtime_jobs j WHERE j.task_id='${fixture.task}' AND j.job_type='orchestrator_turn' ORDER BY j.id DESC LIMIT 1;`));
}

function literal(text) {
  return `'${String(text).replaceAll("'", "''")}'`;
}

function ownerOf(target) {
  return execFileSync("stat", ["-c", "%U", target], { encoding: "utf8" }).trim();
}

test.before(async () => {
  if (skip) return;
  // The accounts and layout of a host (installation-layout.mjs, runtime-adapters.mjs).
  sh("getent group infra-control >/dev/null || groupadd --system infra-control");
  sh("getent group agent-workspace >/dev/null || groupadd --system agent-workspace");
  sh("getent group infra-cod-github >/dev/null || groupadd --system infra-cod-github");
  ensureUser("codex-worker");
  ensureUser("opencode-worker");
  for (const directory of [".local/share/opencode", ".cache/opencode", ".config/opencode/tools"]) {
    mkdirSync(`/home/opencode-worker/${directory}`, { recursive: true });
  }
  sh("chown -R opencode-worker:opencode-worker /home/opencode-worker && chmod 0750 /home/opencode-worker");
  mkdirSync("/srv/infra-cod/workspaces", { recursive: true });
  mkdirSync("/run/infra-cod", { recursive: true });
  mkdirSync("/var/lib/infra-cod/runtime-fence", { recursive: true });
  rmSync(RECORDS, { recursive: true, force: true });
  mkdirSync(RECORDS);
  chmodSync(RECORDS, 0o1777);
  writeFileSync("/usr/local/bin/opencode", STAND_IN, { mode: 0o755 });

  rmSync(WORKSPACE, { recursive: true, force: true });
  mkdirSync(WORKSPACE);
  writeFileSync(path.join(WORKSPACE, "README.md"), "e2e workspace\n");
  sh(`cd ${WORKSPACE} && git init -q -b main && git -c user.name=e2e -c user.email=e2e@localhost add README.md `
    + `&& git -c user.name=e2e -c user.email=e2e@localhost commit -q -m init && chown -R codex-worker:codex-worker ${WORKSPACE}`);

  scratch = `infra_cod_e2e_${randomUUID().slice(0, 8)}`;
  psql(`CREATE DATABASE ${scratch};`, adminUrl("postgres"));
  url = adminUrl(scratch);
  const migrate = spawnSync(process.execPath, [path.join(ROOT, "services/control-plane/migrate.mjs")], {
    encoding: "utf8", env: { ...process.env, DATABASE_URL: url },
  });
  assert.equal(migrate.status, 0, migrate.stderr);
  const health = snapshotOf(READY);
  psql(RUNTIME_HEALTH_UPSERT_SQL.replace(":'status'", literal(health.status))
    .replace(":'snapshot'", literal(health.snapshot)).replace(":'observed_at'", literal(health.observed_at)));
  fixture = JSON.parse(psql(`
    CREATE FUNCTION e2e_fixture() RETURNS jsonb LANGUAGE plpgsql SET search_path=control_plane,public,extensions AS $$
    DECLARE v_user uuid; v_project uuid; v_orchestrator_profile uuid; v_executor_profile uuid;
      v_orchestrator uuid; v_worker uuid; v_orchestrator_assignment uuid; v_executor_assignment uuid; v_task uuid;
    BEGIN
      INSERT INTO users(display_name) VALUES('E2E') RETURNING id INTO v_user;
      INSERT INTO projects(owner_id,name,slug,workspace_path)
        VALUES(v_user,'E2E orchestrator','e2e-orchestrator','${WORKSPACE}') RETURNING id INTO v_project;
      INSERT INTO workspace_locks(project_id) VALUES(v_project) ON CONFLICT DO NOTHING;
      INSERT INTO runtime_profiles(runtime_type,adapter_version,runtime_version,provider_type,model)
        VALUES('opencode','1.0.0','1.18.31','opencode-go','e2e-orchestrator-model') RETURNING id INTO v_orchestrator_profile;
      INSERT INTO runtime_profiles(runtime_type,adapter_version,runtime_version,provider_type,model)
        VALUES('opencode','1.0.0','1.18.31','opencode','e2e-executor-model') RETURNING id INTO v_executor_profile;
      INSERT INTO agents(name,role,runtime_profile_id) VALUES('e2e-orchestrator','architect',v_orchestrator_profile) RETURNING id INTO v_orchestrator;
      INSERT INTO agents(name,role,runtime_profile_id) VALUES('e2e-worker','implementer',v_executor_profile) RETURNING id INTO v_worker;
      INSERT INTO project_agent_assignments(project_id,agent_id,runtime_profile_id,assignment_role,is_default)
        VALUES(v_project,v_orchestrator,v_orchestrator_profile,'orchestrator',true) RETURNING id INTO v_orchestrator_assignment;
      INSERT INTO project_agent_assignments(project_id,agent_id,runtime_profile_id,assignment_role)
        VALUES(v_project,v_worker,v_executor_profile,'executor') RETURNING id INTO v_executor_assignment;
      INSERT INTO tasks(project_id,title,objective,constraints,acceptance_criteria,status,
        active_agent_id,orchestrator_assignment_id,created_by)
        VALUES(v_project,'E2E','Plan with OpenCode','[]','["delegated"]','planning',v_orchestrator,v_orchestrator_assignment,'e2e')
        RETURNING id INTO v_task;
      INSERT INTO task_executor_assignments(task_id,project_agent_assignment_id,priority) VALUES(v_task,v_executor_assignment,10);
      RETURN jsonb_build_object('project',v_project,'task',v_task);
    END $$;
    SELECT e2e_fixture()::text;`));

  supervisor = spawn(process.execPath, [path.join(ROOT, "services/runtime-supervisor/server.mjs")], {
    env: {
      ...process.env, DATABASE_URL: url, RUNTIME_SUPERVISOR_SOCKET: SOCKET, RUNTIME_SUPERVISOR_SOCKET_GROUP: "infra-control",
      WORKER_TOOL_SOCKET_ROOT: "/run/infra-cod/worker-tools", PROJECT_WORKSPACE_ROOT: "/srv/infra-cod/workspaces",
      RUNTIME_SUPERVISOR_ID: "e2e-supervisor", WORKSPACE_OPERATION_POLL_MS: "600000",
      RUNTIME_RUN_ISOLATION: isolation,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  supervisor.stdout.on("data", (chunk) => { supervisorLog += chunk; });
  supervisor.stderr.on("data", (chunk) => { supervisorLog += chunk; });
  const deadline = Date.now() + 20_000;
  while (!existsSync(SOCKET) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100));
  assert.ok(existsSync(SOCKET), `the supervisor did not listen:\n${supervisorLog}`);
});

test.after(async () => {
  if (skip) return;
  supervisor?.kill("SIGTERM");
  await new Promise((resolve) => setTimeout(resolve, 500));
  spawnSync("psql", ["-X", "-qAt", adminUrl("postgres")], { encoding: "utf8",
    input: `DROP DATABASE IF EXISTS ${scratch} WITH (FORCE);` });
});

test("an OpenCode turn answers in a new session, read-only, and gives the workspace back", { skip }, () => {
  const job = turn("Summarise the workspace.");
  assert.equal(job.job_type, "orchestrator_turn");
  assert.equal(job.status, "completed", job.last_error);

  const [run] = records();
  assert.equal(run.uid, Number(execFileSync("id", ["-u", "opencode-worker"], { encoding: "utf8" })), "the turn did not run as opencode-worker");
  assert.equal(run.cwd, WORKSPACE);
  assert.ok(!run.argv.includes("--session"), "a first turn claimed to resume a session");
  assert.ok(run.argv.includes("opencode-go/e2e-orchestrator-model"), `the model was not qualified: ${run.argv.join(" ")}`);
  assert.equal(run.read, "e2e workspace\n", "the turn could not read the workspace");
  // The kernel, twice: the runtime's own write, and a shell it started.
  assert.equal(run.write_errno, 13, "the turn wrote the workspace");
  assert.notEqual(run.shell_write_status, 0, "a shell the turn started wrote the workspace");
  assert.equal(run.env.OPENCODE_DISABLE_PROJECT_CONFIG, "true");
  assert.deepEqual(JSON.parse(run.env.OPENCODE_CONFIG_CONTENT).permission, {
    // Stage 12 M0: the login directory is refused to OpenCode's file tools.
    read: { "*/.local/share/opencode": "deny", "*/.local/share/opencode/*": "deny" },
    external_directory: { "*/.local/share/opencode": "deny", "*/.local/share/opencode/*": "deny" },
    edit: "deny", bash: { "*": "deny", "git status": "allow" }, webfetch: "deny",
  });
  // A turn's shell runs under Landlock, where bubblewrap cannot mount: no sandbox shell.
  assert.equal(run.env.SHELL, undefined);
  assert.ok(!existsSync(path.join(WORKSPACE, "INTRUSION.txt")));
  assert.equal(readFileSync(path.join(WORKSPACE, "README.md"), "utf8"), "e2e workspace\n");
  assert.equal(ownerOf(WORKSPACE), "codex-worker", "the workspace was not given back to its resting owner");

  const reply = psql(`SELECT payload->>'content' FROM domain_events WHERE task_id='${fixture.task}'
    AND event_type='chat.agent_message' ORDER BY occurred_at DESC LIMIT 1;`);
  assert.equal(reply, "E2E: answered.");
  const session = psql(`SELECT native_session_id||' '||session_namespace FROM agent_sessions
    WHERE project_id='${fixture.project}' AND role='chat' AND active;`);
  assert.equal(session, `${SESSION} opencode`);
  const events = psql(`SELECT string_agg(e.event_type, ',' ORDER BY e.id) FROM runtime_activity_events e
    WHERE e.job_id=${job.id} AND e.runtime_type='opencode';`);
  assert.match(events, /runtime\.turn\.started/);
  const attempt = psql(`SELECT surface||' '||access_mode FROM runtime_dispatch_attempts WHERE job_id=${job.id};`);
  assert.equal(attempt, "project read_only");
});

test("Stop run ends an OpenCode turn through the run's mailbox", { skip }, async () => {
  psql(`SELECT record_task_chat_message('${fixture.project}','${fixture.task}','HOLD_FOR_STOP','e2e','e2e');`);
  const dispatched = node("services/control-plane/dispatcher.mjs", ["once"], { DISPATCHER_ID: "e2e-dispatcher" });
  assert.equal(dispatched.status, 0, dispatched.stderr);
  const worker = spawn(process.execPath, [path.join(ROOT, "services/control-plane/orchestrator-worker.mjs"), "once"], {
    env: { ...process.env, DATABASE_URL: url, RUNTIME_SUPERVISOR_SOCKET: SOCKET, ORCHESTRATOR_WORKER_ID: WORKER },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  worker.stdout.on("data", (chunk) => { output += chunk; });
  worker.stderr.on("data", (chunk) => { output += chunk; });
  const exited = new Promise((resolve) => worker.once("close", resolve));
  const holding = path.join(RECORDS, "holding");
  const deadline = Date.now() + 60_000;
  while (!existsSync(holding) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100));
  assert.ok(existsSync(holding), `the turn never started:\n${output}\n${supervisorLog.slice(-3000)}`);

  const stoppedAt = Date.now();
  psql(`SELECT request_runtime_interrupt('${fixture.project}','${fixture.task}','e2e','stop the turn','e2e-stop');`);
  const timer = setTimeout(() => worker.kill("SIGKILL"), 60_000);
  assert.equal(await exited, 0, output);
  clearTimeout(timer);
  assert.ok(Date.now() - stoppedAt < 30_000, `the stop took ${Date.now() - stoppedAt} ms`);

  const job = JSON.parse(psql(`SELECT jsonb_build_object('id',j.id,'status',j.status,'result',j.result)::text FROM runtime_jobs j
    WHERE j.task_id='${fixture.task}' AND j.job_type='orchestrator_turn' ORDER BY j.id DESC LIMIT 1;`));
  assert.equal(job.status, "completed");
  assert.equal(job.result.status, "interrupted");
  const command = JSON.parse(psql(`SELECT jsonb_build_object('status',status,'receipt',native_receipt)::text FROM run_commands
    WHERE job_id=${job.id} AND command_kind='interrupt';`));
  assert.equal(command.status, "acknowledged");
  assert.equal(command.receipt.mechanism, isolation);
  assert.equal(psql(`SELECT status FROM task_runs WHERE id=(SELECT run_id FROM runtime_jobs WHERE id=${job.id});`), "interrupted");
  const pid = Number(readFileSync(holding, "utf8"));
  assert.notEqual(spawnSync("kill", ["-0", String(pid)]).status, 0, "the stand-in outlived the stop");
  rmSync(holding);
  assert.equal(ownerOf(WORKSPACE), "codex-worker");
});

test("the next turn resumes that session and delegates through the run's socket", { skip }, () => {
  const job = turn("DELEGATE_NOW: hand this to the executor.");
  assert.equal(job.status, "completed", job.last_error);

  const run = records().at(-1);
  assert.deepEqual(run.argv.slice(run.argv.indexOf("--session"), run.argv.indexOf("--session") + 2), ["--session", SESSION]);
  assert.equal(run.tool_answer.ok, true, JSON.stringify(run.tool_answer));
  assert.equal(run.tool_answer.result.status, "accepted");
  assert.equal(run.write_errno, 13);

  const task = JSON.parse(psql(`SELECT jsonb_build_object('status',status)::text FROM tasks WHERE id='${fixture.task}';`));
  assert.equal(task.status, "implementation_requested");
  assert.equal(psql(`SELECT count(*) FROM handoffs WHERE task_id='${fixture.task}';`), "1");
  const reply = psql(`SELECT payload->>'content' FROM domain_events WHERE task_id='${fixture.task}'
    AND event_type='chat.agent_message' ORDER BY occurred_at DESC LIMIT 1;`);
  assert.equal(reply, "E2E: delegated.");
  assert.ok(!existsSync(path.join(WORKSPACE, "INTRUSION.txt")));
  assert.equal(ownerOf(WORKSPACE), "codex-worker");
});
