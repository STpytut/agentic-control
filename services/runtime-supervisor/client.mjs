import { EventEmitter } from "node:events";
import net from "node:net";
import { PassThrough, Writable } from "node:stream";
import { randomUUID } from "node:crypto";

import { FAILURE_CODES, wrapFailure } from "../control-plane/failure.mjs";
import { PROTOCOL_VERSION, createFrameReader, createFrameWriter, negotiatedVersion } from "./framing.mjs";
import { githubPublishRequest, githubWorkspaceRequest } from "./github-workspace-protocol.mjs";
import { driverFor, surfaceOf } from "./drivers/index.mjs";

// How long to wait for a run the supervisor is still executing.
//
// This was ten minutes while the supervisor's own cap was five, so the client
// never reached it. Raising the supervisor to an hour left the client as the
// binding limit, and the failure it produces is the worst kind: the worker gives
// up, retries, and the run it abandoned is still going — two OpenCode processes
// in one workspace, which is the single-writer rule broken by the machinery that
// exists to keep it.
//
// So it tracks the supervisor's cap and adds a margin, from the same variable
// and the same default. The margin matters: the supervisor's timer must be the
// one that fires, because it can name itself and stop the child, and this side
// can only stop waiting.
//
// A host that raises `RUNTIME_RUN_TIMEOUT_MS` must set it for both units; the
// margin means a small divergence costs nothing.
const configuredRunTimeoutMs = Number(process.env.RUNTIME_RUN_TIMEOUT_MS ?? 60 * 60_000);
const supervisorRunCapMs = Number.isFinite(configuredRunTimeoutMs)
  ? Math.max(configuredRunTimeoutMs, 60_000)
  : 60 * 60_000;
// Plus the project's check, which the supervisor runs after the executor has
// exited and before it answers (0143): up to 30 minutes of its own.
const PROJECT_CHECK_CAP_MS = 30 * 60_000;
const runRequestTimeoutMs = supervisorRunCapMs + PROJECT_CHECK_CAP_MS + 2 * 60_000;

// The gate run is a capability smoke test and the supervisor caps it at five
// minutes of its own, so this side waits that plus the same margin. It is a
// separate number because it bounds a different thing: borrowing the hour-long
// one would work and would say something untrue about how long a gate may take.
const gateRequestTimeoutMs = 5 * 60_000 + 2 * 60_000;

// Which budget a run waits on, by the kind of workspace its surface runs in —
// a fenced task run, or a gate's scratch run. Named, never a literal: the
// supervisor's cap and this one have to move together (defect 98).
const RUN_BUDGETS = Object.freeze({
  grant: runRequestTimeoutMs,
  gate: gateRequestTimeoutMs,
});

// An account operation can start a loopback server and wait on a provider.
const accountRequestTimeoutMs = 120_000;

// A surface of a driver, carried the way this call carries it — refused here,
// before a frame is sent, rather than by the supervisor after a round trip.
function surfaceFor(runtime, surface, transport) {
  const spec = surfaceOf(driverFor(runtime), surface);
  if (spec.transport !== transport) {
    throw Object.assign(new Error(`${runtime}'s ${surface} surface is a ${spec.transport}, not a ${transport}`), {
      code: "unsupported_surface", retryable: false,
    });
  }
  return spec;
}

export { githubWorkspaceRequest } from "./github-workspace-protocol.mjs";

// Waits out a runtime installation instead of recording one as a failure.
//
// A refusal carrying `retryable` means the runtime is being replaced right now:
// the supervisor is holding launches for the length of one install, which is
// seconds to a couple of minutes. The first attempt at this deferred the work
// and let the lease lapse, on the assumption that an expired lease is requeued.
// It mostly is not — a catalog entry comes back as `discovered` with its
// `gate_requested_at` already cleared so nothing picks it up again, a refresh
// job becomes `failed`, a Codex login is leased until its own `expires_at` and
// then expires, an OpenCode enrollment stays `claimed`. Four different
// lifecycles, three of which quietly lost the work.
//
// Waiting needs none of that to be true. If the fence outlasts the budget, the
// caller's own failure path runs, which is right: a fence held that long is a
// real problem and should be reported as one.
// The shortest lease any of these workers holds while it calls the supervisor.
// The retry budget has to stay inside it, so this is the ceiling everything
// else is derived from.
export const SHORTEST_WORKER_LEASE_MS = 90_000;

// A margin for the work that still has to happen after the call returns —
// finishing the operation and recording the result — plus clock skew between
// this process and the database.
const LEASE_SAFETY_MS = 30_000;

export async function retryWhileRuntimeBusy(body, {
  leaseExpiresAt = null,
  delayMs = 5_000,
  onWait = () => {},
  now = () => Date.now(),
  // How to stop the work when the lease runs out mid-call. The supervisor ends
  // every channel bound to a socket when the socket closes, so closing the
  // client is what reaches across.
  onExpiry = () => {},
} = {}) {
  // A budget longer than the lease is not a retry, it is a way of losing the
  // work twice. The first version waited up to 110 seconds against leases of 90.
  //
  // `leaseExpiresAt` is the absolute moment the claim expires, taken at claim
  // time and shared by every item in the batch — because the claim is what
  // grants it. Up to three jobs are claimed together and worked through one
  // after another, so the third does not get a fresh 90 seconds and must not
  // behave as though it did.
  const ceiling = now() + SHORTEST_WORKER_LEASE_MS - LEASE_SAFETY_MS;
  const fromLease = leaseExpiresAt === null
    ? Number.POSITIVE_INFINITY
    : new Date(leaseExpiresAt).getTime() - LEASE_SAFETY_MS;
  const until = Math.min(ceiling, fromLease);

  let lastError = null;
  for (let attempt = 1; ; attempt += 1) {
    // Checked *before* the call, not after it. Calling first and then noticing
    // the lease had gone is how a side effect happens outside the claim that
    // authorised it — and the call itself is bounded for the same reason: a
    // supervisor request may take two minutes, against a margin of thirty
    // seconds.
    const remaining = until - now();
    if (remaining <= 0) {
      throw lastError ?? new Error(
        "the lease for this work has no time left to call the runtime supervisor; "
        + "it will be claimed again rather than run outside the claim that authorised it",
      );
    }

    try {
      return await withDeadline(body(), remaining, { onExpiry });
    } catch (error) {
      // Only the admission refusal, and only by name. It is raised before
      // anything is spawned or owned, so repeating the call repeats nothing
      // that happened. Every other retryable refusal may already have had an
      // effect — a login, a logout — and repeating those is how one becomes two.
      // A refusal for memory (runtime_capacity, sprint C K3) is raised at the
      // same point, before anything exists, and is as safe to repeat.
      if (error?.code !== "runtime_paused" && error?.code !== "runtime_capacity") throw error;
      lastError = error;
      if (until - now() <= delayMs) throw error;
      onWait({ attempt, remainingMs: until - now(), error });
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

// Bounds the *wait*, and tears down the connection so the supervisor stops the
// work with it.
//
// `Promise.race` alone ends only this side's waiting: the request goes on
// executing in the supervisor, and the side effect lands after the caller has
// already given up on it. That was the first version, and it made a claim it
// could not keep.
//
// Closing the connection is what actually reaches the other end. The supervisor
// kills every channel bound to a socket when that socket closes, so a channel-
// based operation — which is what the account and gate paths use — is genuinely
// terminated rather than merely un-awaited.
//
// What this still cannot do is unwind an operation that has already had its
// effect at the moment the connection drops. A `login` that completed inside the
// supervisor stays completed. So the caller is told the outcome is *unknown*
// rather than failed, because recording a failure for something that may have
// succeeded is its own kind of wrong.
function withDeadline(promise, ms, { onExpiry = async () => ({ stopped: false }) } = {}) {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = setTimeout(async () => {
        // Ask, and find out. `stopped: true` means the supervisor signalled the
        // work and it is no longer running, so the job can be handed back
        // safely. Anything else means nobody knows what happened, and a caller
        // must not record a failure for that.
        let outcome = { stopped: false, reason: "no answer" };
        try {
          outcome = await onExpiry();
        } catch (error) {
          outcome = { stopped: false, reason: error.message };
        }
        reject(Object.assign(
          new Error(
            `the runtime supervisor did not answer within the remaining lease (${ms}ms); `
            + (outcome.stopped
              ? "the work was cancelled and confirmed stopped"
              : `the work could not be confirmed stopped (${outcome.reason ?? "unknown"}), so the outcome of this call is unknown`),
          ),
          { leaseExpired: true, cancelled: outcome.stopped === true, outcomeUnknown: outcome.stopped !== true },
        ));
      }, ms);
    }),
  ]);
}

// Asks the supervisor to stop the request this client is waiting on, and closes
// the connection either way.
//
// Closing alone was not enough: the socket-close handler ends the channels bound
// to a socket, and the OpenCode paths are not channels — they were ordinary
// promises that nothing recorded, so the work ran to completion for a client
// that had stopped listening. An explicit cancel reaches them, and its answer is
// what tells the caller whether it may hand the work back.
export async function cancelThrough(supervisor) {
  const requestId = supervisor.lastRequestId?.();
  let outcome = { stopped: false, reason: "no request to cancel" };
  if (requestId) {
    try {
      const answer = await supervisor.cancelRequest(requestId);
      outcome = { stopped: answer?.stopped === true, reason: answer?.reason ?? "not stopped" };
    } catch (error) {
      outcome = { stopped: false, reason: error.message };
    }
  }
  try {
    supervisor.close();
  } catch { /* the connection is going away regardless */ }
  return outcome;
}

// Where the chain used to stop. The client kept message, code and retryable and
// dropped everything else the supervisor knew, so a caller had a sentence and no
// way to ask what actually refused (prework B2).
//
// `code` keeps its meaning — the product reason a caller branches on, such as
// `grant_writer_active` — and the envelope arrives beside it.
export function supervisorError(message) {
  const error = new Error(message.error);
  if (message.retryable === true) error.retryable = true;
  if (typeof message.code === "string") error.code = message.code;
  if (typeof message.failure_code === "string") error.failureCode = message.failure_code;
  if (message.details && typeof message.details === "object") error.details = message.details;
  if (Array.isArray(message.cause)) error.supervisorCause = message.cause;
  if (typeof message.operation === "string") error.operation = message.operation;
  if (typeof message.correlation_id === "string") error.correlationId = message.correlation_id;
  return error;
}

// The supervisor's answer as an envelope this side can wrap. The chain it sent
// is flattened into `details.cause` rather than rebuilt as Error objects: it
// crossed a socket, and inventing stack frames for it would be a lie.
export function supervisorFailure(error, { operation } = {}) {
  return wrapFailure(error, {
    operation: operation ?? error.operation,
    code: FAILURE_CODES.includes(error.failureCode) ? error.failureCode : undefined,
    details: {
      ...(error.details ?? {}),
      ...(error.code ? { reason: error.details?.reason ?? error.code } : {}),
      ...(error.supervisorCause ? { cause: error.supervisorCause } : {}),
    },
  });
}

export class RuntimeSupervisorClient extends EventEmitter {
  constructor({ socketPath = process.env.RUNTIME_SUPERVISOR_SOCKET ?? "/run/infra-cod/runtime-supervisor.sock" } = {}) {
    super();
    this.socketPath = socketPath;
    this.socket = null;
    this.pending = new Map();
    this.channels = new Map();
  }

  async connect() {
    if (this.socket) return;
    this.socket = net.createConnection(this.socketPath);
    await new Promise((resolve, reject) => {
      this.socket.once("connect", resolve);
      this.socket.once("error", reject);
    });
    this.#write = createFrameWriter(this.socket);
    // A bad frame costs a frame. Before this the parse ran inside the `line`
    // handler, so one malformed byte threw there and took the socket — and every
    // request waiting on it — with it (WP-8b).
    const feed = createFrameReader({
      onMessage: (frame) => this.#handle(frame),
      onProtocolError: (error) => this.emit("protocol_error", error),
    });
    this.socket.setEncoding("utf8");
    this.socket.on("data", feed);
    this.socket.on("error", (error) => this.#failAll(error));
    this.socket.on("close", () => this.#failAll(new Error("runtime supervisor connection closed")));
    await this.#handshake();
  }

  // The version both sides speak. The supervisor and this client ship in one
  // release and restart together, so a mismatch means something is wrong — a
  // stale process, a half-finished update — and saying so beats speaking a
  // protocol the peer does not.
  //
  // A supervisor from before the handshake existed answers `hello` as an
  // unsupported request; that is not an error here, it is version 1.
  async #handshake() {
    try {
      const hello = await this.#request({ type: "hello", protocol_version: PROTOCOL_VERSION }, 10_000);
      this.protocolVersion = negotiatedVersion(hello?.protocol_version) ?? 1;
    } catch {
      this.protocolVersion = 1;
    }
    // Said out loud, because a silent fallback to version 1 — a stale
    // supervisor, a half-finished update — looks exactly like success from
    // outside. Found on the host after rc.36: the only way to see the
    // negotiated version was to open the socket and ask.
    this.emit("protocol_version", this.protocolVersion);
    if (this.protocolVersion !== PROTOCOL_VERSION) {
      process.stderr.write(`${JSON.stringify({
        type: "runtime_supervisor.protocol_downgraded",
        negotiated: this.protocolVersion, expected: PROTOCOL_VERSION,
      })}\n`);
    }
  }

  async ping() {
    return this.#request({ type: "ping" });
  }

  // A channel onto one surface of a runtime's driver: a process the caller
  // drives through its stdin and stdout. For a `grant` surface the grant token
  // is the launch's authority over the workspace; the supervisor resolves it
  // and refuses without one. Replaces openCodexAppServer, openCodexAccountServer
  // and openCodexGateServer (WP-5b).
  async open({ runtime, surface, projectId = null, grantToken = null, gateWorkspace = null, qualification = null }) {
    const spec = surfaceFor(runtime, surface, "channel");
    const message = { type: "runtime_open", runtime, surface };
    if (spec.workspace === "grant") Object.assign(message, { project_id: projectId, grant_token: grantToken });
    if (spec.workspace === "gate") message.gate_workspace = gateWorkspace;
    // Stage 12 W3: the candidate's executable in its scratch home.
    if (qualification) message.qualification = qualification;
    return this.#request(message);
  }

  // Stage 12 W3: a candidate's scratch repository and home, before its checks
  // and after them.
  // OpenCode Go's usage windows, read by the release's probe as opencode-worker
  // (ADR-0019). The answer is the schema-checked reading, or why there is none.
  async probeProviderUsage() {
    return this.#request({ type: "provider_usage_probe", runtime: "opencode" });
  }

  // The models Claude's subscription offers, read as claude-worker by the
  // release's probe: ids and names, or why there are none.
  async listClaudeModels() {
    return this.#request({ type: "claude_model_list", runtime: "claude" });
  }

  async prepareQualification({ runtime, version, qualificationId }) {
    return this.#request({ type: "qualification_prepare", runtime, surface: "gate", version, qualification_id: qualificationId });
  }

  async cleanupQualification({ runtime, qualificationId, copyBackLogin = true }) {
    return this.#request({ type: "qualification_cleanup", runtime, surface: "gate", qualification_id: qualificationId, copy_back_login: copyBackLogin });
  }

  // One batch run of a candidate on a task's or a turn's surface (Stage 12 W3).
  async runQualification({ runtime, surface, qualification, model, prompt, nativeSessionId = null, interruptAfterMs = null }) {
    surfaceFor(runtime, surface, "batch");
    return this.#request({
      type: "runtime_run", runtime, surface, qualification, model, prompt,
      native_session_id: nativeSessionId, interrupt_after_ms: interruptAfterMs,
    }, RUN_BUDGETS.gate);
  }

  // A run the supervisor drives to its end: an executor's task in its fenced
  // workspace, or a gate's smoke run in a scratch one. Replaces runOpenCode and
  // runOpenCodeGate.
  async run({ runtime, surface, jobId, runId, projectId, fencingToken, grantToken, gateWorkspace, prompt, model,
    nativeSessionId = null, terminalReportSessionId = null, interruptAfterMs = null, workerId = null }) {
    const spec = surfaceFor(runtime, surface, "batch");
    // An orchestrator's read-only turn (11.2 N4): the job and the worker that
    // leases it, and the prompt. The supervisor reads the rest from the job.
    const message = spec.workspace === "grant" && spec.grantMode === "read_only"
      ? { job_id: jobId, project_id: projectId, grant_token: grantToken, prompt, worker_id: workerId }
      : spec.workspace === "grant"
      ? {
        job_id: jobId,
        run_id: runId,
        project_id: projectId,
        fencing_token: fencingToken,
        grant_token: grantToken,
        prompt,
        model,
        native_session_id: nativeSessionId,
        terminal_report_session_id: terminalReportSessionId,
      }
      : {
        gate_workspace: gateWorkspace,
        model,
        prompt,
        native_session_id: nativeSessionId,
        interrupt_after_ms: interruptAfterMs,
      };
    return this.#request(
      { type: "runtime_run", runtime, surface, ...message },
      RUN_BUDGETS[spec.workspace],
    );
  }

  async deprovisionProject({ projectId, workerId }) {
    return this.#request(
      {
        type: "deprovision_project",
        project_id: projectId,
        worker_id: workerId,
      },
      10 * 60_000,
    );
  }

  async prepareGithubAppWorkspace({ projectId }) {
    return this.#request(githubWorkspaceRequest("prepare_github_app_workspace", projectId));
  }

  async finalizeGithubAppWorkspace({ projectId }) {
    return this.#request(githubWorkspaceRequest("finalize_github_app_workspace", projectId));
  }

  async abortGithubAppWorkspace({ projectId }) {
    return this.#request(githubWorkspaceRequest("abort_github_app_workspace", projectId));
  }

  // Sprint B P1: the approved commit of a claimed publish, as a pack file the
  // broker can read, and its removal.
  async exportPublishCommit({ intentId }) {
    return this.#request(githubPublishRequest("export_publish_commit", intentId));
  }

  async releasePublishExport({ intentId }) {
    return this.#request(githubPublishRequest("release_publish_export", intentId));
  }

  // An account operation on a runtime whose account surface is a loopback
  // server. The driver's own validation refuses any field it does not name.
  // Replaces opencodeAccount and opencodeProviderList.
  async account({ runtime, operation, provider = null, key = null, qualification = null }) {
    surfaceFor(runtime, "account", "local_server");
    const message = { type: "runtime_account", runtime, surface: "account", operation };
    if (provider) message.provider = provider;
    if (key !== null) message.key = key;
    // Stage 12 W3c: a candidate's model list, in its scratch home.
    if (qualification) message.qualification = qualification;
    return this.#request(message, accountRequestTimeoutMs);
  }

  close() {
    this.socket?.end();
  }

  sendMessage(message) {
    // Throws on a frame this client should not be sending — over the limit, or
    // into a connection whose unsent spool is already full. A caller that gets
    // this has a message it cannot send, which is worth knowing at the call
    // site rather than after a timeout.
    this.#write(message);
  }

  // Cancels a request this client made, and reports whether the supervisor
  // confirms it stopped. Used when the caller's lease runs out mid-call: the
  // difference between "stopped" and "nobody knows" is the difference between
  // handing the work back and leaving it alone.
  async cancelRequest(cancelRequestId, { timeoutMs = 10_000 } = {}) {
    return this.#request({ type: "cancel_request", cancel_request_id: cancelRequestId }, timeoutMs);
  }

  // The id of the request this client is currently waiting on, so a deadline can
  // name it when it asks for cancellation.
  lastRequestId() {
    return this.#lastRequestId;
  }

  #lastRequestId = null;
  #write = null;
  protocolVersion = null;

  #request(message, timeoutMs = 60_000) {
    const requestId = randomUUID();
    if (message.type !== "cancel_request") this.#lastRequestId = requestId;
    this.sendMessage({ ...message, request_id: requestId });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error(`runtime supervisor request timed out: ${message.type}`));
      }, timeoutMs);
      this.pending.set(requestId, { resolve, reject, timer, requestType: message.type });
    });
  }

  #handle(message) {
    if (message.type === "protocol_error") {
      this.emit("protocol_error", new Error(message.error));
      return;
    }
    if (message.type === "stdout" || message.type === "stderr" || message.type === "channel_closed") {
      const channel = this.channels.get(message.channel_id);
      if (!channel) return;
      if (message.type === "stdout") channel.stdout.write(message.data);
      if (message.type === "stderr") channel.stderr.write(message.data);
      if (message.type === "channel_closed") {
        channel.stdout.end();
        channel.stderr.end();
        channel.emit("close", message.exit_code, message.signal);
        this.channels.delete(message.channel_id);
      }
      return;
    }
    const pending = this.pending.get(message.request_id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(message.request_id);
    if (message.ok === false) {
      // Distinguishes "not now" from "this failed", so callers can retry
      // instead of recording a terminal outcome.
      pending.reject(supervisorError(message));
    } else if (pending.requestType === "runtime_open") {
      const processHandle = new SupervisorProcess(
        this,
        message.result.channel_id,
        message.result.pid,
      );
      processHandle.capabilityVerification = message.result.capability_verification ?? null;
      this.channels.set(message.result.channel_id, processHandle);
      pending.resolve(processHandle);
    } else {
      pending.resolve(message.result);
    }
  }

  #failAll(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

class SupervisorProcess extends EventEmitter {
  constructor(client, channelId, pid) {
    super();
    this.client = client;
    this.channelId = channelId;
    this.pid = pid;
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    this.stdin = new Writable({
      write: (chunk, _encoding, callback) => {
        client.sendMessage({ type: "stdin", channel_id: channelId, data: chunk.toString() });
        callback();
      },
      final: (callback) => {
        client.sendMessage({ type: "close_channel", channel_id: channelId });
        callback();
      },
    });
  }

  kill() {
    this.client.sendMessage({ type: "close_channel", channel_id: this.channelId });
  }
}
