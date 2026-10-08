import { isMain } from "./entrypoint.mjs";
import { queryJson, queryJsonRows, closePool } from "./db.mjs";
import { RuntimeSupervisorClient } from "../runtime-supervisor/client.mjs";
import { deferReasonFor, issueWorkspaceGrant } from "../runtime-supervisor/workspace-grant.mjs";
import { driverFor, surfaceOf } from "../runtime-supervisor/drivers/index.mjs";
import { adapterFor } from "../operations/runtime-adapters.mjs";
import { PLATFORM_COMMAND_TOOLS } from "../runtime-supervisor/drivers/tool-contracts.mjs";
import { DeliveryOutcomeUnknown, startMailbox } from "../runtime-supervisor/run-mailbox.mjs";
import { launchProvenance } from "../runtime-supervisor/provenance.mjs";
import { launchReasoningLevel } from "../runtime-supervisor/drivers/reasoning.mjs";
import { runLeasedJob, runPollLoop, shutdownSignal } from "./worker-loop.mjs";
import { describeOperatorChangeRequests, describeRepositoryContext, describeReviewEvidence, ORCHESTRATOR_INSTRUCTIONS, workflowUpdates } from "./turn-prompts.mjs";

// A review turn under either name until 11.2 N6 (migration 0073).
const REVIEW_JOB_TYPES = new Set(["resume_orchestrator"]);
const defaultWorkerId = `orchestrator-worker-${process.pid}`;

function requireStringArray(value, name, { nonEmpty = false } = {}) {
  if (!Array.isArray(value) || (nonEmpty && value.length === 0)
      || value.some((item) => typeof item !== "string" || !item.trim())) {
    throw new Error(`${name} must be ${nonEmpty ? "a non-empty" : "an"} array of non-empty strings`);
  }
  return value;
}

// A tool call as the driver's bridge reads it, bound to the turn this job is
// running: a call from another thread or turn is stale or foreign, whatever it
// asks for.
async function invokePlatformTool(message, { driver, job, workerId, threadId, turnId }) {
  const params = driver.toolBridge.call(message);
  if (!params || params.sessionId !== threadId
      || params.turnId !== turnId || !params.callId || params.namespace !== "platform") {
    throw new Error("stale, foreign, or unsupported platform tool request");
  }
  const args = params.arguments;
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    throw new Error("platform tool arguments must be an object");
  }
  if (params.tool === "delegate_task") {
    if (typeof args.objective !== "string" || args.objective.trim().length < 4) {
      throw new Error("objective must contain at least four characters");
    }
    const receipt = await queryJson(
      `SELECT invoke_delegate_task(
        :'job_id'::bigint, :'worker_id', :'call_id', :'objective',
        :'instructions'::jsonb, :'relevant_paths'::jsonb
      )::text;`,
      {
        job_id: job.id, worker_id: workerId, call_id: params.callId,
        objective: args.objective.trim(),
        instructions: JSON.stringify(requireStringArray(args.instructions, "instructions")),
        relevant_paths: JSON.stringify(requireStringArray(args.relevant_paths, "relevant_paths")),
      },
    );
    return driver.toolBridge.answer(receipt);
  }
  if (params.tool === "request_revision") {
    const receipt = await queryJson(
      `SELECT invoke_request_revision(
        :'job_id'::bigint, :'worker_id', :'call_id', :'changes_required'::jsonb
      )::text;`,
      {
        job_id: job.id, worker_id: workerId, call_id: params.callId,
        changes_required: JSON.stringify(requireStringArray(
          args.changes_required, "changes_required", { nonEmpty: true },
        )),
      },
    );
    return driver.toolBridge.answer(receipt);
  }
  throw new Error(`unsupported platform tool: ${params.tool}`);
}

async function claimJobs({ workerId, batchSize, lease }) {
  return await queryJsonRows(
    `SELECT to_jsonb(j)::text FROM claim_orchestrator_jobs(
      :'worker_id', :'batch_size'::integer, :'lease'::interval
    ) j;`,
    { worker_id: workerId, batch_size: batchSize, lease },
  );
}

async function heartbeat(jobId, workerId, lease) {
  await queryJson(
    `SELECT to_jsonb(heartbeat_runtime_job(
      :'job_id'::bigint, :'worker_id', :'lease'::interval
    ))::text;`,
    { job_id: jobId, worker_id: workerId, lease },
  );
}

async function updateActivity(jobId, workerId, phase, detail) {
  await queryJson(
    `SELECT to_jsonb(update_runtime_job_activity(
      :'job_id'::bigint, :'worker_id', :'phase', :'detail'
    ))::text;`,
    { job_id: jobId, worker_id: workerId, phase, detail },
  );
}

// Runtime events arrive from a synchronous readline callback, one per stdout
// line, and the activity feed reads them back in order. The psql version was
// synchronous, so ordering came for free; an async write would let two events
// race and land reversed. Chaining serialises them without blocking the reader.
// The catch stays on the chain: a rejection here must not become an unhandled
// rejection and take the worker down.
let activityChain = Promise.resolve();

function recordActivityEvent(jobId, workerId, runtime, event) {
  activityChain = activityChain
    .then(() => queryJson(`SELECT append_runtime_activity_event(:'job_id'::bigint,:'worker_id',:'runtime_type',
      :'event_type',:'phase',:'summary',:'details'::jsonb)::text;`, {
      job_id: jobId, worker_id: workerId, runtime_type: runtime, event_type: event.eventType, phase: event.phase,
      summary: event.summary, details: JSON.stringify(event.details ?? {}),
    }))
    .catch((error) => {
      process.stderr.write(`${JSON.stringify({ type: "orchestrator.activity_event_failed", jobId, error: error.message })}\n`);
    });
  return activityChain;
}

// What the orchestrator is told about its task, whichever runtime it is: a
// channel runtime receives it as developer instructions, a batch runtime at the
// head of its prompt.
function developerInstructionsFor(context) {
  return [
    ORCHESTRATOR_INSTRUCTIONS,
    `Active task: ${context.task_title} (${context.task_id}).`,
    `Task state: ${context.task_status}; task version: ${context.task_version}.`,
    `Stored objective: ${context.task_objective}`,
    `Stored acceptance criteria: ${JSON.stringify(context.task_acceptance_criteria)}`,
    // Empty for a task nobody revised from the panel, so nothing is added.
    describeOperatorChangeRequests(context.task_operator_change_requests),
    context.followup_of_task_id
      ? `Follow-up contract: this is a new planning task derived from terminal task ${context.followup_of_task_id}. Never reopen or revise the terminal source. Translate the user's requested corrections into the active follow-up contract and call platform.delegate_task for this active task. Do not call platform.request_revision until this follow-up has its own completed implementation.`
      : "This task is not a terminal-task follow-up.",
    context.executor
      ? `Selected executor: ${context.executor.agent_name} (${context.executor.runtime_type}, ${context.executor.model}).`
      : "No enabled executor is assigned to this task.",
  ].filter(Boolean).join("\n");
}

// What the turn is given besides the message: what happened in this
// conversation since the orchestrator last spoke — a writer finishing while
// this message waited, say — read in the database's order (turn-prompts.mjs;
// acceptance P-4); and, for a review turn, the evidence of what it reviews,
// whose delivery is recorded against this turn's run (WP-7). The verdict it
// may give is bound to that evidence by the database, not by this text.
async function turnPreamble(job, context, workerId) {
  const updates = workflowUpdates(await queryJsonRows(
    `SELECT jsonb_build_object('event_type',e.event_type,'payload',e.payload)::text
     FROM domain_events e JOIN tasks t ON t.conversation_id=e.conversation_id
     WHERE t.id=:'task_id'::uuid
       AND e.conversation_sequence > COALESCE((
         SELECT max(a.conversation_sequence) FROM domain_events a
         WHERE a.conversation_id=t.conversation_id AND a.event_type='chat.agent_message'),0)
     ORDER BY e.conversation_sequence;`,
    { task_id: context.task_id },
  ));
  const evidence = REVIEW_JOB_TYPES.has(job.job_type)
    ? describeReviewEvidence(await queryJson(
      `SELECT deliver_review_evidence(:'job_id'::bigint, :'worker_id')::text;`,
      { job_id: job.id, worker_id: workerId },
    ))
    : "";
  return [await repositoryBriefing(job, context, workerId), updates, evidence].filter(Boolean).join("\n");
}

// The project briefing (0146), until the orchestrator has answered in this
// conversation: then its session holds the briefing already. Not "no session
// yet": a first turn that failed after its session was bound is retried with
// one, and the turn the model answers would have gone unbriefed. Never
// required — a turn without it explores, as every turn did before.
async function repositoryBriefing(job, context, workerId) {
  try {
    const answered = await queryJson(
      `SELECT to_jsonb(EXISTS (SELECT 1 FROM domain_events e JOIN tasks t ON t.conversation_id=e.conversation_id
         WHERE t.id=:'task_id'::uuid AND e.event_type='chat.agent_message'))::text;`,
      { task_id: context.task_id },
    );
    if (answered && context.native_session_id) return "";
    return describeRepositoryContext(await queryJson(
      `SELECT orchestrator_repository_context(:'job_id'::bigint, :'worker_id')::text;`,
      { job_id: job.id, worker_id: workerId },
    ));
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ type: "orchestrator.briefing_failed", jobId: job.id, error: error.message })}\n`);
    return "";
  }
}

// A turn on a runtime whose project surface is a batch (11.2 N4): one run in
// the conversation's session, driven to its end by the supervisor. The run is
// read-only by the kernel there; the platform's commands come back through the
// run's socket to the same functions the channel path calls, under this
// worker's lease; the answer is the run's last message. The session is bound
// once the run has named it — a first turn's session exists only then.
async function executeBatchTurn(job, context, { driver, label, grant, workerId, lease }) {
  const supervisor = new RuntimeSupervisorClient();
  await supervisor.connect();
  const heartbeatTimer = setInterval(() => {
    heartbeat(job.id, workerId, lease).catch((error) => {
      process.stderr.write(`${JSON.stringify({ type: "orchestrator.heartbeat_failed", jobId: job.id, error: error.message })}\n`);
    });
  }, 30_000);
  try {
    const preamble = await turnPreamble(job, context, workerId);
    await updateActivity(job.id, workerId, "running_turn", context.native_session_id
      ? `${label} is processing the latest message in the task's session`
      : `${label} is processing the latest message in a new session`);
    const result = await supervisor.run({
      runtime: driver.name, surface: "project", jobId: job.id, projectId: context.project_id,
      grantToken: grant.token, workerId,
      prompt: [developerInstructionsFor(context), preamble, context.content].filter(Boolean).join("\n\n"),
    });
    if (result.interrupted) {
      return await queryJson(`SELECT finalize_runtime_interrupt(:'job_id'::bigint,:'worker_id',:'thread_id')::text;`,
        { job_id: job.id, worker_id: workerId, thread_id: result.native_session_id ?? "" });
    }
    if (result.exit_code !== 0) {
      const reason = result.failure || result.stderr?.trim().split("\n").at(-1) || "";
      throw new Error(`${label} exited with code ${result.exit_code}${reason ? `: ${reason}` : ""}`);
    }
    if (!result.native_session_id) throw new Error(`${label} ended the turn without naming its session`);
    await queryJson(
      `SELECT to_jsonb(bind_orchestrator_session(:'job_id'::bigint, :'worker_id', :'thread_id'))::text;`,
      { job_id: job.id, worker_id: workerId, thread_id: result.native_session_id },
    );
    if (!result.response?.trim()) throw new Error(`${label} turn completed without an agent message`);
    await updateActivity(job.id, workerId, "finalizing", "Saving the response and native session receipt");
    return await queryJson(
      `SELECT complete_orchestrator_job(:'job_id'::bigint, :'worker_id', :'thread_id', :'turn_id', :'content')::text;`,
      { job_id: job.id, worker_id: workerId, thread_id: result.native_session_id,
        turn_id: `job-${job.id}-attempt-${job.attempt_count}`, content: result.response },
    );
  } finally {
    clearInterval(heartbeatTimer);
    supervisor.close();
    await activityChain;
  }
}

async function executeJob(job, { workerId, lease }) {
  const context = await queryJson(
    `SELECT orchestrator_job_context(:'job_id'::bigint, :'worker_id')::text;`,
    { job_id: job.id, worker_id: workerId },
  );
  if (!context?.content) throw new Error("orchestrator job has no message content");

  // A read-only grant for this turn. Refused while a writer holds the
  // workspace, which the claim already avoided — but the writer may have taken
  // it since, and then this turn is deferred, not failed.
  const grant = await issueWorkspaceGrant(job.id, workerId, queryJson);
  // The runtime the task's orchestrator assignment runs on (11.2 N4) — a job
  // type is served by every runtime that plays the orchestrator, so it no
  // longer says which — and the driver that speaks to it (WP-5b).
  const driver = driverFor(context.runtime_type);
  if (!adapterFor(driver.name).roles.includes("orchestrator")) {
    throw new Error(`${driver.name} does not play the orchestrator`);
  }
  // What the operator reads is the runtime's own name, from the registry.
  const label = adapterFor(driver.name).display.label;
  await updateActivity(job.id, workerId, "starting_runtime", `Opening the isolated ${label} runtime`);
  if (surfaceOf(driver, "project").transport === "batch") {
    return await executeBatchTurn(job, context, { driver, label, grant, workerId, lease });
  }
  // The orchestrator's reasoning level from the task's snapshot (0111), held to
  // the driver's values before anything is opened; null sends none.
  let reasoningEffort = launchReasoningLevel(driver, context.reasoning_effort);
  // A runtime whose level sticks to its thread (Codex) would carry an earlier
  // task's level into a member at "Default": send the model's default instead.
  if (!reasoningEffort && driver.reasoning?.sticky && context.snapshot_entry_id) {
    const fallback = await queryJson("SELECT to_jsonb(catalog_default_reasoning(:'entry'::uuid))::text;", { entry: context.snapshot_entry_id }).catch(() => null);
    reasoningEffort = launchReasoningLevel(driver, fallback);
  }
  const supervisor = new RuntimeSupervisorClient();
  await supervisor.connect();
  const processHandle = await supervisor.open({
    runtime: driver.name, surface: "project", projectId: context.project_id, grantToken: grant.token,
  });
  let dispatch = null;
  const nativeResult = { status: "not_started" };
  const activeTurn = { threadId: null, turnId: null };
  let mailbox = null;
  let interruptRequested = false;
  const appServer = driver.stream.connect(processHandle, {
    onServerRequest: (message) => invokePlatformTool(message, {
      driver, job, workerId, threadId: activeTurn.threadId, turnId: activeTurn.turnId,
    }),
    // The normalised half goes to the activity feed; the native half stays in
    // the session, where the answer is read from.
    onRuntimeEvent: ({ event }) => { if (event) recordActivityEvent(job.id, workerId, driver.name, event); },
  });
  // Async now, so the rejection has to be caught on the promise; a surrounding
  // try/catch would catch nothing.
  const heartbeatTimer = setInterval(() => {
    heartbeat(job.id, workerId, lease).catch((error) => {
      process.stderr.write(`${JSON.stringify({ type: "orchestrator.heartbeat_failed", jobId: job.id, error: error.message })}\n`);
    });
  }, 30_000);

  try {
    // What ran (WP-9c): the job's selection, recorded on its first launch and
    // reused by every retry, and this attempt appended to it. The assignment,
    // access mode and grant are the database's to say; the driver and the
    // version the host runs are the launch's.
    dispatch = await queryJson(
      `SELECT record_runtime_dispatch(:'job_id'::bigint, :'worker_id', :'launch'::jsonb)::text;`,
      { job_id: job.id, worker_id: workerId, launch: JSON.stringify(launchProvenance(driver,
        processHandle.capabilityVerification, { surface: "project", model: context.model,
          nativeSessionId: context.native_session_id ?? null, reasoningEffort })) },
    );
    await appServer.initialize({ name: "infra_cod", title: "infra_cod orchestrator worker", version: "0.1.0" });

    await updateActivity(job.id, workerId, "opening_session", context.native_session_id
      ? `Resuming the task's native ${label} session`
      : `Creating a native ${label} session for this task`);
    const developerInstructions = developerInstructionsFor(context);
    // Resumed when the task has a session, started when it does not — never a
    // new session called a resume (RUNTIME_CONTRACT §7).
    const threadId = await appServer.openSession({
      resume: context.native_session_id ?? null,
      cwd: context.workspace_path,
      model: context.model,
      instructions: developerInstructions,
      tools: driver.toolBridge.register(PLATFORM_COMMAND_TOOLS),
    });
    activeTurn.threadId = threadId;

    await queryJson(
      `SELECT to_jsonb(bind_orchestrator_session(
        :'job_id'::bigint, :'worker_id', :'thread_id'
      ))::text;`,
      { job_id: job.id, worker_id: workerId, thread_id: threadId },
    );

    const preamble = await turnPreamble(job, context, workerId);
    const turnId = await appServer.startTurn({
      sessionId: threadId,
      text: [preamble, context.content].filter(Boolean).join("\n"),
      clientMessageId: context.source_event_id,
      // The orchestrator's level from the task's snapshot, on every turn:
      // Codex keeps a turn's effort for the turns after it (0111).
      effort: reasoningEffort,
    });
    activeTurn.turnId = turnId;
    await updateActivity(job.id, workerId, "running_turn", `${label} is processing the latest message`);
    // The run's mailbox (WP-9a): commands to this turn, delivered in order by
    // this worker, which holds the job's lease. An interrupt is Codex's own
    // `turn/interrupt`, and its answer is the receipt. A kind the driver does
    // not declare is refused by the mailbox, never turned into a new prompt.
    mailbox = startMailbox({
      jobId: job.id, workerId, driver, query: queryJson,
      onCommand: (command) => { if (command.command_kind === "interrupt") interruptRequested = true; },
      deliver: {
        interrupt: async () => {
          let response;
          try {
            response = await appServer.interrupt({ sessionId: threadId, turnId });
          } catch (error) {
            // A timeout may have reached the runtime; a JSON-RPC error did,
            // and was refused by it.
            if (/^Timed out/.test(error.message)) {
              throw new DeliveryOutcomeUnknown(error.message, { method: "turn/interrupt" });
            }
            throw error;
          }
          return { mechanism: driver.interrupt.mechanism, method: driver.interrupt.request({ sessionId: threadId, turnId })[0],
            thread_id: threadId, turn_id: turnId, response: response ?? {} };
        },
      },
    });
    const completed = await appServer.completion({ sessionId: threadId, turnId });
    Object.assign(nativeResult, { status: completed.status, thread_id: threadId, turn_id: turnId,
      interrupted: interruptRequested || completed.status === "interrupted" });
    // The turn's last events are written before the job is finished, not after:
    // `turn/completed` is what resolves the wait above, and its activity write
    // is still on the chain. Awaited only in `finally`, it reached the database
    // after complete_orchestrator_job had released the lease, and was refused —
    // "runtime activity job is not actively leased" — so a turn with no tool
    // call lost its own ending from the feed.
    await activityChain;
    // A delivery in progress is finished — acknowledged or not — before the
    // run can end, so its receipt is not overtaken by the run's end.
    await mailbox.stop();
    if (interruptRequested || completed.status === "interrupted") {
      return await queryJson(`SELECT finalize_runtime_interrupt(:'job_id'::bigint,:'worker_id',:'thread_id')::text;`,
        { job_id: job.id, worker_id: workerId, thread_id: threadId });
    }
    if (completed.status !== "completed") {
      throw new Error(`${label} turn ended with status ${completed.status}`);
    }
    const response = completed.response;
    if (!response?.trim()) throw new Error(`${label} turn completed without an agent message`);

    await updateActivity(job.id, workerId, "finalizing", "Saving the response and native session receipt");
    return await queryJson(
      `SELECT complete_orchestrator_job(
        :'job_id'::bigint, :'worker_id', :'thread_id', :'turn_id', :'content'
      )::text;`,
      { job_id: job.id, worker_id: workerId, thread_id: threadId, turn_id: turnId, content: response },
    );
  } catch (error) {
    Object.assign(nativeResult, { status: "failed", error: String(error?.message ?? error).slice(0, 500) });
    throw error;
  } finally {
    await mailbox?.stop();
    clearInterval(heartbeatTimer);
    // The attempt's end, once. Best effort, like the activity chain: a failure
    // here must not replace the reason the turn ended, and it is logged.
    if (dispatch) await queryJson(`SELECT finish_runtime_dispatch_attempt(:'attempt_id'::bigint,:'worker_id',:'result'::jsonb,:'native_session_id')::text;`,
      { attempt_id: dispatch.attempt_id, worker_id: workerId, result: JSON.stringify(nativeResult),
        native_session_id: activeTurn.threadId ?? "" })
      .catch((error) => process.stderr.write(`${JSON.stringify({ type: "orchestrator.dispatch_result_failed", jobId: job.id, error: error.message })}\n`));
    appServer.close();
    supervisor.close();
    // The activity chain is fire-and-forget by design; wait for it here so the
    // last events of a turn are durable before the job is reported finished.
    await activityChain;
  }
}

export function runOrchestratorWorker({ signal, once = false } = {}) {
  const workerId = process.env.ORCHESTRATOR_WORKER_ID ?? defaultWorkerId;
  const pollMs = Number(process.env.ORCHESTRATOR_POLL_MS ?? 15_000);
  const batchSize = Number(process.env.ORCHESTRATOR_BATCH_SIZE ?? 1);
  const lease = process.env.ORCHESTRATOR_LEASE ?? "5 minutes";
  const retryDelay = process.env.ORCHESTRATOR_RETRY_DELAY ?? "15 seconds";
  const maxAttempts = Number(process.env.ORCHESTRATOR_MAX_ATTEMPTS ?? 5);
  const deferDelay = process.env.ORCHESTRATOR_DEFER_DELAY ?? "30 seconds";

  return runPollLoop({
    name: "orchestrator", pollMs, signal, once,
    fallbackMessage: "The orchestrator worker cycle failed.",
    tick: async () => {
      for (const job of await claimJobs({ workerId, batchSize, lease })) {
        await runLeasedJob({
          name: "orchestrator",
          job,
          handle: async (claimed) => ({ outcome: "completed", detail: await executeJob(claimed, { workerId, lease }) }),
          // A writer holding the workspace, or a runtime being installed, is
          // "not now". Retrying spends an attempt per poll, and a long
          // implementation turned a message that would have been answered later
          // into a dead letter (defect 35's shape). Deferral gives the attempt
          // back; everything else is still a retry.
          classify: (error) => {
            const reason = deferReasonFor(error);
            return reason ? { outcome: "deferred", reason } : "retryable";
          },
          report: (result, claimed) => result.outcome === "deferred"
            ? queryJson(
              `SELECT defer_runtime_job(:'job_id'::bigint, :'worker_id', :'reason', :'delay'::interval)::text;`,
              { job_id: claimed.id, worker_id: workerId, reason: result.reason, delay: deferDelay },
            )
            : result.outcome === "retryable"
              ? queryJson(
                `SELECT to_jsonb(retry_runtime_job(
                  :'job_id'::bigint, :'worker_id', :'error', :'delay'::interval, :'max_attempts'::integer
                ))::text;`,
                { job_id: claimed.id, worker_id: workerId, error: result.error.message, delay: retryDelay, max_attempts: maxAttempts },
              )
              : undefined,
        });
      }
      // The per-job lines are this cycle's log; the cycle itself has nothing to add.
      return undefined;
    },
  });
}

async function main() {
  await runOrchestratorWorker({ signal: shutdownSignal(), once: process.argv[2] === "once" });
}

if (isMain(import.meta.url)) {
  try { await main(); } finally { await closePool(); }
}
