import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import readline from "node:readline";
import { queryControlPlane, queryControlPlaneJson } from "./control-plane-db.mjs";
import { dispatchOnce } from "../../services/control-plane/dispatcher.mjs";
import { RuntimeSupervisorClient } from "../../services/runtime-supervisor/client.mjs";

if (process.getuid?.() !== 0) {
  throw new Error("The handoff PoC must run as root supervisor");
}

const here = path.dirname(fileURLToPath(import.meta.url));
const artifacts = path.join(here, "artifacts");
const workspaceRoot =
  process.env.HANDOFF_POC_WORKSPACE_ROOT ?? "/srv/infra-cod-handoff-poc/workspaces";
const codexModel = process.env.CODEX_POC_MODEL ?? "gpt-5.4";
const workerModel =
  process.env.OPENCODE_POC_MODEL ?? "opencode/north-mini-code-free";
const ids = {
  user: randomUUID(),
  project: randomUUID(),
  codexRuntime: randomUUID(),
  workerRuntime: randomUUID(),
  codexAgent: randomUUID(),
  workerAgent: randomUUID(),
  codexSession: randomUUID(),
  workerSession: randomUUID(),
  task: randomUUID(),
};
const workspace = path.join(workspaceRoot, ids.project);
const workerOutput = path.join(workspace, "worker-output.txt");
let handoffId = null;
const taskArguments = {
  task_id: ids.task,
  assignee: "opencode",
  objective: "Create the exact worker proof file in the shared workspace",
  revision_number: 1,
  acceptance_criteria: [
    "worker-output.txt contains WORKER_IMPLEMENTATION_OK and the durable handoff ID",
  ],
};
const revisionArguments = {
  task_id: ids.task,
  changes_required: ["Add a third line REVISION_OK to worker-output.txt"],
  acceptance_criteria: taskArguments.acceptance_criteria,
};

await mkdir(artifacts, { recursive: true });
await mkdir(workspace, { recursive: true });
await rm(workerOutput, { force: true });
await writeFile(
  path.join(workspace, "AGENTS.md"),
  [
    "# Shared Handoff PoC",
    "",
    "- Only the current workspace owner may modify files.",
    "- OpenCode may only create worker-output.txt when explicitly delegated.",
    "- Codex reviews the worker output and must not implement the worker task.",
    "- Do not modify files outside this workspace.",
    "",
  ].join("\n"),
);
try {
  execFileSync("git", ["-C", workspace, "rev-parse", "--git-dir"], {
    stdio: "ignore",
  });
} catch {
  execFileSync("git", ["-C", workspace, "init", "-q"]);
}

queryControlPlane(
  `
  BEGIN;
  INSERT INTO users(id, display_name) VALUES (:'user_id'::uuid, 'Handoff E2E');
  INSERT INTO projects(id, owner_id, name, slug, workspace_path)
  VALUES (:'project_id'::uuid, :'user_id'::uuid, 'Handoff E2E', :'project_slug', :'workspace');
  INSERT INTO runtime_profiles(id, runtime_type, adapter_version, runtime_version, provider_type, model)
  VALUES
    (:'codex_runtime_id'::uuid, 'codex', 'app-server-poc', :'codex_version', 'openai', :'codex_model'),
    (:'worker_runtime_id'::uuid, 'opencode', 'cli-poc', :'worker_version', 'opencode-free', :'worker_model');
  INSERT INTO agents(id, name, role, runtime_profile_id)
  VALUES
    (:'codex_agent_id'::uuid, :'codex_agent_name', 'architect', :'codex_runtime_id'::uuid),
    (:'worker_agent_id'::uuid, :'worker_agent_name', 'implementer', :'worker_runtime_id'::uuid);
  INSERT INTO agent_sessions(id, project_id, agent_id, runtime_profile_id, purpose)
  VALUES
    (:'codex_session_id'::uuid, :'project_id'::uuid, :'codex_agent_id'::uuid, :'codex_runtime_id'::uuid, 'primary'),
    (:'worker_session_id'::uuid, :'project_id'::uuid, :'worker_agent_id'::uuid, :'worker_runtime_id'::uuid, 'implementation');
  INSERT INTO tasks(id, project_id, title, objective, status, active_agent_id, created_by)
  VALUES (
    :'task_id'::uuid, :'project_id'::uuid, 'Durable Codex to OpenCode handoff',
    'Verify PostgreSQL-backed handoff execution', 'ready', :'codex_agent_id'::uuid, 'e2e-poc'
  );
  COMMIT;
  SELECT :'task_id';
  `,
  {
    user_id: ids.user,
    project_id: ids.project,
    project_slug: `handoff-e2e-${ids.project}`,
    workspace,
    codex_runtime_id: ids.codexRuntime,
    worker_runtime_id: ids.workerRuntime,
    codex_version: "0.144.5",
    worker_version: "1.18.3",
    codex_model: codexModel,
    worker_model: workerModel,
    codex_agent_id: ids.codexAgent,
    worker_agent_id: ids.workerAgent,
    codex_agent_name: `codex-${ids.project}`,
    worker_agent_name: `opencode-${ids.project}`,
    codex_session_id: ids.codexSession,
    worker_session_id: ids.workerSession,
    task_id: ids.task,
  },
);

const timestamp = new Date().toISOString().replaceAll(":", "-");
const codexJsonlPath = path.join(artifacts, `codex-${timestamp}.jsonl`);
const codexStderrPath = path.join(artifacts, `codex-${timestamp}.stderr.log`);
const workerJsonlPath = path.join(artifacts, `opencode-${timestamp}.jsonl`);
const workerStderrPath = path.join(artifacts, `opencode-${timestamp}.stderr.log`);
const reportPath = path.join(artifacts, "latest-result.json");

const rawMessages = [];
const messages = [];
const pending = new Map();
const waiters = new Set();
let nextId = 1;
let codexStderr = "";
let activeContext = null;
let toolCall = null;
let revisionToolCall = null;
let workerRun = null;
let requestReceipt = null;
let outboxClaim = null;
let startReceipt = null;
let completionReceipt = null;
let pipelinePromise = null;
let startJob = null;
let resumeJob = null;
let revisionReceipt = null;
let revisionPipelinePromise = null;
let revisionCycle = null;
let dispatcherCycles = [];
let heartbeatCount = 0;
let acceptedReceiptAt = null;
let workerStartedAt = null;
let completionPersistedAt = null;
let workerOwnerUid = null;
let returnedOwnerUid = null;

const runtimeSupervisor = new RuntimeSupervisorClient();
await runtimeSupervisor.connect();
const supervisorProbe = await runtimeSupervisor.ping();
const codex = await runtimeSupervisor.openCodexAppServer({ projectId: ids.project });
const initialOwnerUid = (await stat(workspace)).uid;
const codexClosed = new Promise((resolve) => codex.once("close", resolve));
codex.stderr.setEncoding("utf8");
codex.stderr.on("data", (chunk) => {
  codexStderr += chunk;
  process.stderr.write(chunk);
});

const lines = readline.createInterface({ input: codex.stdout });
lines.on("line", (line) => {
  if (!line.trim()) return;
  rawMessages.push(line);
  const message = JSON.parse(line);
  messages.push(message);

  if (message.method && message.id !== undefined) {
    void handleServerRequest(message);
  } else if (message.id !== undefined) {
    const entry = pending.get(String(message.id));
    if (entry) {
      clearTimeout(entry.timer);
      pending.delete(String(message.id));
      if (message.error) entry.reject(new Error(JSON.stringify(message.error)));
      else entry.resolve(message.result);
    }
  }

  for (const waiter of [...waiters]) {
    if (waiter.predicate(message)) {
      clearTimeout(waiter.timer);
      waiters.delete(waiter);
      waiter.resolve(message);
    }
  }
  process.stdout.write(`${message.method ?? `response:${message.id}`}\n`);
});

function send(message) {
  codex.stdin.write(`${JSON.stringify(message)}\n`);
}

function request(method, params, timeoutMs = 60_000) {
  const id = nextId++;
  send({ method, id, params });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(String(id));
      reject(new Error(`Timed out waiting for ${method}`));
    }, timeoutMs);
    pending.set(String(id), { resolve, reject, timer });
  });
}

function waitFor(predicate, description, timeoutMs = 180_000) {
  const existing = messages.find(predicate);
  if (existing) return Promise.resolve(existing);
  return new Promise((resolve, reject) => {
    const waiter = { predicate, resolve, timer: null };
    waiter.timer = setTimeout(() => {
      waiters.delete(waiter);
      reject(new Error(`Timed out waiting for ${description}`));
    }, timeoutMs);
    waiters.add(waiter);
  });
}

function validateToolCall(params) {
  if (!activeContext) throw new Error("missing active context");
  if (
    params.threadId !== activeContext.threadId ||
    params.turnId !== activeContext.turnId
  ) {
    throw new Error("stale or foreign tool-call context");
  }
  if (params.namespace !== "platform" || !["delegate_task", "request_revision"].includes(params.tool)) {
    throw new Error("unsupported tool");
  }
  const expected = params.tool === "delegate_task" ? taskArguments : revisionArguments;
  if (JSON.stringify(params.arguments) !== JSON.stringify(expected)) {
    throw new Error("task contract mismatch");
  }
}

async function handleServerRequest(message) {
  if (message.method !== "item/tool/call") {
    send({
      id: message.id,
      error: { code: -32601, message: `Unsupported request: ${message.method}` },
    });
    return;
  }

  try {
    validateToolCall(message.params);
    if (message.params.tool === "request_revision") {
      revisionToolCall = message;
      const current = queryControlPlaneJson(
        `SELECT jsonb_build_object('version', t.version, 'status', t.status)::text
         FROM tasks t WHERE t.id=:'task_id'::uuid;`, { task_id: ids.task },
      );
      revisionReceipt = queryControlPlaneJson(
        `SELECT request_revision(:'project_id'::uuid, :'task_id'::uuid, :'reviewer_id'::uuid,
          :'changes'::jsonb, :'acceptance'::jsonb, :'idempotency_key', :'expected_version'::bigint,
          :'correlation_id')::text;`,
        {
          project_id: ids.project, task_id: ids.task, reviewer_id: ids.codexAgent,
          changes: JSON.stringify(revisionArguments.changes_required),
          acceptance: JSON.stringify(revisionArguments.acceptance_criteria),
          idempotency_key: `revision:${ids.task}:2`, expected_version: current.version,
          correlation_id: ids.task,
        },
      );
      send({ id: message.id, result: { success: true, contentItems: [{ type: "inputText", text: JSON.stringify(revisionReceipt) }] } });
      revisionPipelinePromise = executeRevisionCycle();
      return;
    }
    toolCall = message;
    requestReceipt = queryControlPlaneJson(
      `SELECT request_implementation(
        :'project_id'::uuid, :'task_id'::uuid, :'from_agent_id'::uuid, :'to_agent_id'::uuid,
        :'revision'::integer, :'objective', '[]'::jsonb, '[]'::jsonb,
        :'acceptance_criteria'::jsonb, '["worker-output.txt"]'::jsonb, :'workspace',
        :'idempotency_key', 1, :'correlation_id'
      )::text;`,
      {
        project_id: ids.project,
        task_id: ids.task,
        from_agent_id: ids.codexAgent,
        to_agent_id: ids.workerAgent,
        revision: taskArguments.revision_number,
        objective: taskArguments.objective,
        acceptance_criteria: JSON.stringify(taskArguments.acceptance_criteria),
        workspace,
        idempotency_key: `delegate:${ids.task}:1`,
        correlation_id: ids.task,
      },
    );
    handoffId = requestReceipt.handoff_id;
    acceptedReceiptAt = new Date().toISOString();
    send({
      id: message.id,
      result: {
        success: true,
        contentItems: [
          {
            type: "inputText",
            text: JSON.stringify({
              status: "accepted",
              handoff_id: handoffId,
              command_id: requestReceipt.command_id,
              event_id: requestReceipt.event_id,
              idempotency_key: requestReceipt.idempotency_key,
            }),
          },
        ],
      },
    });
    pipelinePromise = executeAsyncHandoff();
  } catch (error) {
    returnedOwnerUid = (await stat(workspace)).uid;
    send({
      id: message.id,
      result: {
        success: false,
        contentItems: [{ type: "inputText", text: `Rejected: ${error.message}` }],
      },
    });
  }
}

async function executeAsyncHandoff() {
  const cycle = await executeWorkerCycle(requestReceipt, { revisionNumber: 1 });
  outboxClaim = cycle.outboxClaim;
  startJob = cycle.startJob;
  startReceipt = cycle.startReceipt;
  workerRun = cycle.workerRun;
  completionReceipt = cycle.completionReceipt;
  resumeJob = cycle.resumeJob;
  return { supervisorId: cycle.supervisorId, resumeJob };
}

async function executeRevisionCycle() {
  revisionCycle = await executeWorkerCycle(revisionReceipt.delegation, {
    revisionNumber: 2,
    nativeSessionId: workerRun.sessionId,
  });
  return revisionCycle;
}

async function executeWorkerCycle(delegationReceipt, { revisionNumber, nativeSessionId = null }) {
  const dispatcherId = "handoff-async-dispatcher";
  const supervisorId = supervisorProbe.supervisor_id;
  const firstCycle = dispatchOnce({ dispatcherId, batchSize: 100, lease: "2 minutes" });
  dispatcherCycles.push(firstCycle);
  const cycleOutboxClaim = firstCycle.routed.find(
    (item) => item.event_id === delegationReceipt.event_id,
  ) ?? (await waitForRuntimeJob(delegationReceipt.event_id, "start_implementation"));

  const cycleStartJob = queryControlPlaneJson(
    `SELECT to_jsonb(claim_runtime_job_for_event(
      :'event_id'::uuid, 'start_implementation', :'supervisor_id', interval '2 minutes'
    ))::text;`,
    { event_id: delegationReceipt.event_id, supervisor_id: supervisorId },
  );
  const cycleStartReceipt = queryControlPlaneJson(
    `SELECT start_implementation_job(
      :'job_id'::bigint, :'session_id'::uuid, :'supervisor_id', interval '2 minutes'
    )::text;`,
    { job_id: cycleStartJob.id, session_id: ids.workerSession, supervisor_id: supervisorId },
  );

  const heartbeat = () => {
    queryControlPlane(
      `SELECT heartbeat_runtime_job(
        :'job_id'::bigint, :'supervisor_id', interval '2 minutes'
      );
      SELECT heartbeat_workspace_lock(
        :'project_id'::uuid, :'run_id'::uuid, :'fencing_token'::bigint, interval '2 minutes'
      );`,
      {
        job_id: cycleStartJob.id,
        supervisor_id: supervisorId,
        project_id: ids.project,
        run_id: cycleStartReceipt.run_id,
        fencing_token: cycleStartReceipt.fencing_token,
      },
    );
    heartbeatCount += 1;
  };
  heartbeat();
  const heartbeatTimer = setInterval(heartbeat, 20_000);
  try {
    workerStartedAt = new Date().toISOString();
    var cycleWorkerRun = await runWorker({
      durableHandoffId: delegationReceipt.handoff_id,
      job: cycleStartJob,
      start: cycleStartReceipt,
      revisionNumber,
      nativeSessionId,
    });
  } finally {
    clearInterval(heartbeatTimer);
  }
  if (cycleWorkerRun.exitCode !== 0 || !cycleWorkerRun.outputValid) {
    throw new Error("OpenCode worker did not complete the task contract");
  }

  const cycleCompletionReceipt = cycleWorkerRun.completionResult;
  if (!cycleCompletionReceipt || cycleWorkerRun.completionReport?.status !== "submitted") {
    throw new Error("structured complete_task report was not finalized by the supervisor");
  }
  completionPersistedAt = new Date().toISOString();
  queryControlPlane(
    `SELECT acknowledge_runtime_job(
      :'job_id'::bigint, :'supervisor_id', :'result'::jsonb
    );`,
    {
      job_id: cycleStartJob.id,
      supervisor_id: supervisorId,
      result: JSON.stringify(cycleCompletionReceipt),
    },
  );

  const secondCycle = dispatchOnce({ dispatcherId, batchSize: 100, lease: "2 minutes" });
  dispatcherCycles.push(secondCycle);
  await waitForRuntimeJob(cycleCompletionReceipt.event_id, "resume_codex");
  const cycleResumeJob = queryControlPlaneJson(
    `SELECT to_jsonb(claim_runtime_job_for_event(
      :'event_id'::uuid, 'resume_codex', :'supervisor_id', interval '2 minutes'
    ))::text;`,
    { event_id: cycleCompletionReceipt.event_id, supervisor_id: supervisorId },
  );
  return {
    supervisorId, outboxClaim: cycleOutboxClaim, startJob: cycleStartJob,
    startReceipt: cycleStartReceipt, workerRun: cycleWorkerRun,
    completionReceipt: cycleCompletionReceipt, resumeJob: cycleResumeJob,
  };
}

async function waitForRuntimeJob(sourceEventId, jobType, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  do {
    const job = queryControlPlaneJson(
      `SELECT jsonb_build_object(
        'job_id', j.id, 'job_type', j.job_type, 'event_id', j.source_event_id,
        'routed', true
      )::text
      FROM runtime_jobs j
      WHERE j.source_event_id = :'event_id'::uuid AND j.job_type = :'job_type';`,
      { event_id: sourceEventId, job_type: jobType },
    );
    if (job) return job;
    await new Promise((resolve) => setTimeout(resolve, 100));
  } while (Date.now() < deadline);
  throw new Error(`runtime job ${jobType} was not routed for event ${sourceEventId}`);
}

async function runWorker({ durableHandoffId, job, start, revisionNumber, nativeSessionId }) {
  const prompt = revisionNumber === 1 ? [
    `Implement handoff ${durableHandoffId}.`,
    "Create worker-output.txt with exactly two lines:",
    "WORKER_IMPLEMENTATION_OK",
    `HANDOFF_ID=${durableHandoffId}`,
    "Do not modify any other file.",
    "After the file is complete, call complete_task exactly once with changed_files=[\"worker-output.txt\"],",
    "checks={\"exact_output\":\"passed\"}, and a concise summary. Then confirm briefly.",
  ].join("\n") : [
    `Continue handoff ${durableHandoffId} in this same session.`,
    "Revise worker-output.txt by preserving its first two lines and adding exactly this third line:",
    "REVISION_OK",
    "Do not modify any other file.",
    "After the revision is complete, call complete_task exactly once with changed_files=[\"worker-output.txt\"],",
    "checks={\"revision_output\":\"passed\"}, and a concise summary. Then confirm briefly.",
  ].join("\n");
  const runtimeResult = await runtimeSupervisor.runOpenCode({
    jobId: job.id,
    runId: start.run_id,
    projectId: ids.project,
    fencingToken: start.fencing_token,
    prompt,
    model: workerModel,
    nativeSessionId,
  });
  const stdout = runtimeResult.stdout;
  const stderr = runtimeResult.stderr;
  const exitCode = runtimeResult.exit_code;
  workerOwnerUid = runtimeResult.worker_owner_uid;

  const events = stdout
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
  const sessionIds = [...new Set(events.map((event) => event.sessionID).filter(Boolean))];
  const contents = await readFile(workerOutput, "utf8").catch(() => null);
  const expectedOutput = revisionNumber === 1
    ? `WORKER_IMPLEMENTATION_OK\nHANDOFF_ID=${durableHandoffId}`
    : `WORKER_IMPLEMENTATION_OK\nHANDOFF_ID=${handoffId}\nREVISION_OK`;
  const outputValid = contents?.trimEnd() === expectedOutput;
  await writeFile(workerJsonlPath, stdout);
  await writeFile(workerStderrPath, stderr);

  returnedOwnerUid = (await stat(workspace)).uid;

  return {
    exitCode,
    processRef: runtimeResult.process_ref,
    sessionId: sessionIds[0] ?? null,
    sessionIds,
    eventTypes: events.map((event) => event.type),
    outputContents: contents,
    outputValid,
    completionReport: runtimeResult.completion_report,
    completionResult: runtimeResult.completion_result,
  };
}

const platformTools = [
  {
    type: "namespace",
    name: "platform",
    description: "Validated control-plane handoff commands.",
    tools: [
      {
        type: "function",
        name: "delegate_task",
        description: "Delegate an implementation task to OpenCode and await its receipt.",
        inputSchema: {
          type: "object",
          properties: {
            task_id: { type: "string" },
            assignee: { type: "string", enum: ["opencode"] },
            objective: { type: "string" },
            revision_number: { type: "integer", minimum: 1 },
            acceptance_criteria: { type: "array", items: { type: "string" } },
          },
          required: Object.keys(taskArguments),
          additionalProperties: false,
        },
      },
      {
        type: "function",
        name: "request_revision",
        description: "Request a constrained revision while preserving the acceptance criteria.",
        inputSchema: {
          type: "object",
          properties: {
            task_id: { type: "string" },
            changes_required: { type: "array", minItems: 1, items: { type: "string" } },
            acceptance_criteria: { type: "array", items: { type: "string" } },
          },
          required: Object.keys(revisionArguments),
          additionalProperties: false,
        },
      },
    ],
  },
];

let report;
try {
  const initialize = await request("initialize", {
    clientInfo: {
      name: "infra_cod_handoff_poc",
      title: "infra_cod Codex OpenCode handoff PoC",
      version: "0.1.0",
    },
    capabilities: { experimentalApi: true },
  });
  send({ method: "initialized", params: {} });
  const thread = await request("thread/start", {
    model: codexModel,
    cwd: workspace,
    approvalPolicy: "never",
    sandbox: "read-only",
    dynamicTools: platformTools,
  });
  const threadId = thread.thread.id;
  const turn = await request("turn/start", {
    threadId,
    input: [
      {
        type: "text",
        text: [
          "Call platform.delegate_task exactly once with these exact JSON arguments:",
          JSON.stringify(taskArguments),
          "Do not implement the worker task yourself.",
          "The tool returns an accepted receipt before the worker starts.",
          "After the accepted receipt, do not read the output yet.",
          "Reply with a line containing CODEX_DELEGATION_ACCEPTED and the returned command_id.",
        ].join("\n"),
        text_elements: [],
      },
    ],
  });
  const turnId = turn.turn.id;
  activeContext = { threadId, turnId };
  const delegationCompleted = await waitFor(
    (message) =>
      message.method === "turn/completed" &&
      message.params?.threadId === threadId &&
      message.params?.turn?.id === turnId,
    `turn/completed for ${turnId}`,
  );
  const delegationMessages = messages
    .filter(
      (message) =>
        message.method === "item/completed" &&
        message.params?.turnId === turnId &&
        message.params?.item?.type === "agentMessage",
    )
    .map((message) => message.params.item.text);
  const delegationReply = delegationMessages.at(-1) ?? "";
  const delegationCompletedAt = new Date().toISOString();

  const pipeline = await pipelinePromise;
  const revisionTurn = await request("turn/start", {
    threadId,
    input: [
      {
        type: "text",
        text: [
          "A durable implementation.completed event is ready for review.",
          JSON.stringify({
            ...completionReceipt,
            worker_session_id: workerRun.sessionId,
            changed_files: ["worker-output.txt"],
            checks: ["exact worker output verified by supervisor"],
          }),
          "Read worker-output.txt, then call platform.request_revision exactly once with these exact JSON arguments:",
          JSON.stringify(revisionArguments),
          "Do not edit the file yourself. After the tool receipt, reply with CODEX_REVISION_REQUESTED and its revision_number.",
        ].join("\n"),
        text_elements: [],
      },
    ],
  });
  const revisionTurnId = revisionTurn.turn.id;
  activeContext = { threadId, turnId: revisionTurnId };
  queryControlPlane(
    `SELECT acknowledge_runtime_job(
      :'job_id'::bigint, :'supervisor_id', :'result'::jsonb
    );`,
    {
      job_id: resumeJob.id,
      supervisor_id: pipeline.supervisorId,
      result: JSON.stringify({ thread_id: threadId, turn_id: revisionTurnId }),
    },
  );
  const revisionTurnCompleted = await waitFor(
    (message) =>
      message.method === "turn/completed" &&
      message.params?.threadId === threadId &&
      message.params?.turn?.id === revisionTurnId,
    `turn/completed for revision request ${revisionTurnId}`,
  );
  const completedRevisionCycle = await revisionPipelinePromise;
  const finalTurn = await request("turn/start", {
    threadId,
    input: [{
      type: "text",
      text: [
        "A durable revision.completed event is ready for final review.",
        JSON.stringify({
          ...completedRevisionCycle.completionReceipt,
          worker_session_id: completedRevisionCycle.workerRun.sessionId,
          expected_contents: `WORKER_IMPLEMENTATION_OK\\nHANDOFF_ID=${handoffId}\\nREVISION_OK`,
        }),
        "Read worker-output.txt and verify the three exact lines and the same worker_session_id.",
        "Reply with one standalone line: CODEX_REVIEW_OK followed by the worker_session_id.",
      ].join("\n"),
      text_elements: [],
    }],
  });
  const resumeTurnId = finalTurn.turn.id;
  queryControlPlane(
    `SELECT acknowledge_runtime_job(:'job_id'::bigint, :'supervisor_id', :'result'::jsonb);`,
    {
      job_id: completedRevisionCycle.resumeJob.id,
      supervisor_id: completedRevisionCycle.supervisorId,
      result: JSON.stringify({ thread_id: threadId, turn_id: resumeTurnId }),
    },
  );
  const reviewCompleted = await waitFor(
    (message) => message.method === "turn/completed" && message.params?.threadId === threadId
      && message.params?.turn?.id === resumeTurnId,
    `turn/completed for final review ${resumeTurnId}`,
  );
  const reviewMessages = messages
    .filter(
      (message) =>
        message.method === "item/completed" &&
        message.params?.turnId === resumeTurnId &&
        message.params?.item?.type === "agentMessage",
    )
    .map((message) => message.params.item.text);
  const finalReview = reviewMessages.at(-1) ?? "";

  queryControlPlane(
    `UPDATE agent_sessions
     SET native_session_id = CASE
       WHEN id = :'codex_session_id'::uuid THEN :'codex_native_session_id'
       WHEN id = :'worker_session_id'::uuid THEN :'worker_native_session_id'
       ELSE native_session_id
     END,
     last_resumed_at = clock_timestamp(),
     updated_at = clock_timestamp(),
     version = version + 1
     WHERE id IN (:'codex_session_id'::uuid, :'worker_session_id'::uuid);
     SELECT 'updated';`,
    {
      codex_session_id: ids.codexSession,
      worker_session_id: ids.workerSession,
      codex_native_session_id: threadId,
    worker_native_session_id: completedRevisionCycle.workerRun.sessionId,
    },
  );

  const databaseState = queryControlPlaneJson(
    `SELECT jsonb_build_object(
      'task', (
        SELECT jsonb_build_object('status', t.status, 'version', t.version, 'active_agent_id', t.active_agent_id)
        FROM tasks t WHERE t.id = :'task_id'::uuid
      ),
      'run', (
        SELECT jsonb_build_object(
          'id', r.id, 'status', r.status, 'fencing_token', r.workspace_fencing_token,
          'native_run_id', r.native_run_id, 'process_ref', r.process_ref
        ) FROM task_runs r WHERE r.id = :'run_id'::uuid
      ),
      'lock', (
        SELECT jsonb_build_object(
          'status', l.status, 'owner_run_id', l.owner_run_id,
          'fencing_token', l.fencing_token, 'lease_expires_at', l.lease_expires_at
        ) FROM workspace_locks l WHERE l.project_id = :'project_id'::uuid
      ),
      'commands', (
        SELECT jsonb_agg(jsonb_build_object(
          'type', c.command_type, 'status', c.status, 'idempotency_key', c.idempotency_key
        ) ORDER BY c.created_at) FROM commands c WHERE c.task_id = :'task_id'::uuid
      ),
      'events', (
        SELECT jsonb_agg(jsonb_build_object(
          'type', e.event_type, 'version', e.aggregate_version, 'run_id', e.run_id
        ) ORDER BY e.aggregate_version) FROM domain_events e WHERE e.task_id = :'task_id'::uuid
      ),
      'outbox', (
        SELECT jsonb_agg(jsonb_build_object(
          'event_type', e.event_type, 'status', o.status, 'attempt_count', o.attempt_count
        ) ORDER BY o.id)
        FROM outbox_messages o
        JOIN domain_events e ON e.id = o.event_id
        WHERE e.task_id = :'task_id'::uuid
      ),
      'runtime_jobs', (
        SELECT jsonb_agg(jsonb_build_object(
          'id', j.id, 'job_type', j.job_type, 'status', j.status,
          'attempt_count', j.attempt_count, 'run_id', j.run_id
        ) ORDER BY j.id)
        FROM runtime_jobs j
        WHERE j.task_id = :'task_id'::uuid
      )
    )::text;`,
    { project_id: ids.project, task_id: ids.task, run_id: completedRevisionCycle.startReceipt.run_id },
  );

  report = {
    interface: "Asynchronous outbox → runtime job → Codex resume handoff",
    codexModel,
    workerModel,
    runtimeSupervisor: supervisorProbe,
    threadId,
    delegationTurnId: turnId,
    revisionTurnId,
    resumeTurnId,
    toolCall: toolCall?.params ?? null,
    workerRun,
    revisionWorkerRun: completedRevisionCycle.workerRun,
    controlPlane: {
      requestReceipt,
      outboxClaim,
      startReceipt,
      completionReceipt,
      revisionReceipt,
      revisionCycle: completedRevisionCycle,
      dispatcherCycles,
      startJob,
      resumeJob,
      state: databaseState,
    },
    delegationReply,
    finalReview,
    ownership: { initialOwnerUid, workerOwnerUid, returnedOwnerUid },
    capabilities: {
      runtimeSupervisorConnected:
        supervisorProbe.status === "ok" &&
        supervisorProbe.supervisor_id === "vps-runtime-supervisor-1",
      codexInitialized: Boolean(initialize?.userAgent),
      delegateToolCalled: toolCall?.params?.tool === "delegate_task",
      taskContractValidated:
        JSON.stringify(toolCall?.params?.arguments) === JSON.stringify(taskArguments),
      acceptedReceiptReturnedBeforeWorker:
        delegationReply.includes("CODEX_DELEGATION_ACCEPTED") &&
        delegationReply.includes(requestReceipt.command_id) &&
        acceptedReceiptAt <= workerStartedAt,
      delegationTurnCompletedBeforeWorkerCompletion:
        delegationCompleted.params?.turn?.status === "completed" &&
        delegationCompletedAt <= completionPersistedAt,
      durableCommandPersisted:
        databaseState.commands?.length === 5 &&
        databaseState.commands.every((command) => command.status === "completed"),
      requestRevisionToolCalled:
        revisionToolCall?.params?.tool === "request_revision" &&
        JSON.stringify(revisionToolCall?.params?.arguments) === JSON.stringify(revisionArguments),
      requestedOutboxDispatched:
        databaseState.outbox?.some(
          (message) =>
            message.event_type === "implementation.requested" &&
            message.status === "published" &&
            message.attempt_count === 1,
        ),
      workspaceFencePersisted:
        databaseState.run?.fencing_token === completedRevisionCycle.startReceipt?.fencing_token &&
        databaseState.lock?.fencing_token === completedRevisionCycle.startReceipt?.fencing_token,
      workspaceOwnershipTransferred:
        workerOwnerUid !== null && workerOwnerUid !== initialOwnerUid,
      openCodeStarted: workerRun?.exitCode === 0 && completedRevisionCycle.workerRun?.exitCode === 0,
      openCodeSessionCaptured:
        Boolean(workerRun?.sessionId) && workerRun.sessionId === completedRevisionCycle.workerRun?.sessionId,
      openCodeStructuredEvents:
        completedRevisionCycle.workerRun?.eventTypes.includes("tool_use") &&
        completedRevisionCycle.workerRun?.eventTypes.includes("step_finish"),
      workerOutputVerified:
        workerRun?.outputValid === true && completedRevisionCycle.workerRun?.outputValid === true,
      completionPersisted:
        databaseState.task?.status === "awaiting_review" &&
        databaseState.run?.status === "completed" &&
        databaseState.events?.some(
          (event) => event.type === "implementation.completed",
        ) && databaseState.events?.some((event) => event.type === "revision.completed"),
      structuredWorkerCompletion:
        workerRun?.completionReport?.status === "submitted" &&
        workerRun?.completionResult?.status === "awaiting_review" &&
        completedRevisionCycle.workerRun?.completionReport?.status === "submitted" &&
        completedRevisionCycle.workerRun?.completionResult?.event_type === "revision.completed",
      workspaceLeaseReleased:
        databaseState.lock?.status === "released" &&
        databaseState.lock?.owner_run_id === null,
      workspaceOwnershipReturned: returnedOwnerUid === initialOwnerUid,
      runtimeJobsCompleted:
        databaseState.runtime_jobs?.length === 4 &&
        databaseState.runtime_jobs.every((job) => job.status === "completed"),
      runtimeJobsLeasedToSupervisor:
        startJob.leased_by === supervisorProbe.supervisor_id &&
        resumeJob.leased_by === supervisorProbe.supervisor_id &&
        completedRevisionCycle.startJob.leased_by === supervisorProbe.supervisor_id &&
        completedRevisionCycle.resumeJob.leased_by === supervisorProbe.supervisor_id,
      runtimeProcessReceiptPersisted:
        databaseState.run?.process_ref === completedRevisionCycle.workerRun?.processRef,
      leaseHeartbeatsSucceeded: heartbeatCount >= 1,
      receiptReturnedToCodex: messages.some(
        (message) =>
          message.method === "item/completed" &&
          message.params?.item?.type === "dynamicToolCall" &&
          message.params.item.success === true,
      ),
      codexReviewedWorkerOutput:
        finalReview
          .split("\n")
          .some(
            (line) =>
              line.trim() ===
              `CODEX_REVIEW_OK ${completedRevisionCycle.workerRun?.sessionId ?? "missing-session"}`,
          ),
      codexResumedInSeparateTurn:
        resumeTurnId !== turnId && reviewCompleted.params?.turn?.status === "completed",
    },
    artifacts: {
      codexJsonl: path.relative(here, codexJsonlPath),
      codexStderr: path.relative(here, codexStderrPath),
      workerJsonl: path.relative(here, workerJsonlPath),
      workerStderr: path.relative(here, workerStderrPath),
    },
    testedAt: new Date().toISOString(),
  };
} finally {
  codex.stdin.end();
  const exitCode = await Promise.race([
    codexClosed,
    new Promise((resolve) =>
      setTimeout(() => {
        codex.kill("SIGTERM");
        resolve(null);
      }, 2_000),
    ),
  ]);
  if (report) report.codexAppServerExitCode = exitCode;
  await writeFile(codexJsonlPath, `${rawMessages.join("\n")}\n`);
  await writeFile(codexStderrPath, codexStderr);
  if (report) await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  runtimeSupervisor.close();
}

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
const failures = Object.entries(report.capabilities)
  .filter(([, passed]) => passed !== true)
  .map(([name]) => name);
if (failures.length > 0) {
  process.stderr.write(`Failed capabilities: ${failures.join(", ")}\n`);
  process.exit(1);
}
