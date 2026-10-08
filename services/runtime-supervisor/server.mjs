import { execFileSync, spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { constants as fsConstants, createWriteStream, readFileSync } from "node:fs";
import { pipeline } from "node:stream/promises";
import { chmod, chown, lstat, mkdir, mkdtemp, open, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { cancelInFlight, cancelInFlightFor, registerInFlight } from "./in-flight.mjs";
import { LaunchControl, captureOutputTail, endAfterReport } from "./launch-control.mjs";
import { runIsolationFromEnvironment } from "./run-cgroup.mjs";
import { pauseRuntime, releaseOwner, resumeRuntime, runtimeAdmissionStatus, setCapacityGate, takeLaunchPlace, withAdmission } from "./runtime-admission.mjs";
import { capacitySettings, createCapacityGate, hostReadings, watchRunMemory } from "./runtime-capacity.mjs";
import { query, queryJson, queryJsonRows, closePool } from "../control-plane/db.mjs";
import { envelopeOf, failureChain, failureReason } from "../control-plane/failure.mjs";
import {
  SUPPORTED_PROTOCOL_VERSIONS, createFrameReader, createFrameWriter, negotiatedVersion, payloadOf,
} from "./framing.mjs";
import { assertNoLiveWriters, parseProcessRef, writerAlive } from "../control-plane/deprovision-safety.mjs";
import { checkClaudeModels } from "./claude-model-list.mjs";
import { provisionPlan, inspectPlan, inspectOwner, summariseWorkspace, ownershipFor, homeFor, assertWorkspaceOnDisk, GIT_ISOLATION, commitIdentityEnvironment, summariseUnpublished, EMPTY_TREE } from "./workspace-provisioning.mjs";
import { collectReviewEvidence, headCommit, observationOf, runProcess, stashLeftovers } from "./review-evidence.mjs";
import { runProjectCheck } from "./project-check.mjs";
import { SANDBOX_SHELL, sandboxShellEnvironment } from "./sandbox-shell.mjs";
import { assertTrustedDirectoryChain } from "./trusted-directory.mjs";
import { WORKSPACE_RESTING_RUNTIME, adapterFor, allAdapters } from "../operations/runtime-adapters.mjs";
import { activeQualification, assertCapability, capabilityVerification } from "./drivers/capabilities.mjs";
import { allDrivers, driverFor, surfaceOf } from "./drivers/index.mjs";
import { executableDigest, readRuntimes } from "../operations/runtime-inventory.mjs";
import { PROBE_OUTPUT_MAX_BYTES, checkProbeOutput } from "./provider-usage-check.mjs";
import { qualificationExecutable, qualificationPaths, scratchReadOnlyWritable, stateToCopy, writableStateInHome } from "./qualification-surface.mjs";
import { INSTALLATION_LAYOUT } from "../operations/installation-layout.mjs";
import { createWorkspaceSerializer, resolveWorkspaceGrant } from "./workspace-grant.mjs";
import { createDeprovisionDeadline, createProjectSingleFlight } from "./deprovision-bound.mjs";
import { githubWorkspaceAction, isPublishAction, isSyncAction } from "./github-workspace-protocol.mjs";
import { applyWorkspaceSync } from "./workspace-sync.mjs";
import { buildRepositoryMap } from "./repository-map.mjs";
import { buildSnapshot } from "./snapshot.mjs";
import { CONSULT_NEXT } from "./drivers/tool-contracts.mjs";
import { exportApprovedCommit } from "./publish-export.mjs";
import { startMailbox } from "./run-mailbox.mjs";
import { ensureRunToolRoot, openRunToolSocket, sweepRunToolSockets } from "./worker-tool-socket.mjs";
import { launchProvenance } from "./provenance.mjs";
import { launchReasoningLevel } from "./drivers/reasoning.mjs";
import { READ_ONLY_LAUNCH_EXIT, readOnlyLaunchArgv } from "./read-only-launch.mjs";
import { openCodeCatalogSummary } from "./opencode-account-channel.mjs";

if (process.getuid?.() !== 0) {
  throw new Error("runtime supervisor must run as root");
}

const socketPath = process.env.RUNTIME_SUPERVISOR_SOCKET ?? "/run/infra-cod/runtime-supervisor.sock";
const socketGroup = process.env.RUNTIME_SUPERVISOR_SOCKET_GROUP ?? "infra-control";
// One socket per run under this root, owned by the run's runtime account
// (worker-tool-socket.mjs, WP-9b). It replaced one socket for the
// `opencode-worker` group, which a third runtime could not reach and every
// runtime account would have had to share.
const workerToolSocketRoot = process.env.WORKER_TOOL_SOCKET_ROOT ?? "/run/infra-cod/worker-tools";
// The shared socket of the release before, removed if a restart finds it.
const retiredWorkerToolSocket = "/run/infra-cod/worker-tools.sock";

// The account a project workspace rests with between writers: the one that
// reads it, which is the orchestrator's (ADR-0013). From the registry, by role —
// this file used to spell the runtimes' accounts fourteen times, and since WP-5b
// every other account it uses comes from the driver it is launching.
const RESTING_OWNER = adapterFor(WORKSPACE_RESTING_RUNTIME).user;

// Every ownership change of a project workspace, and the grant check that
// justifies it, happens in that workspace's turn (workspace-grant.mjs).
const inWorkspaceTurn = createWorkspaceSerializer();
const githubBrokerSocketPath = process.env.GITHUB_BROKER_SUPERVISOR_SOCKET
  ?? "/run/infra-cod/github-workspace-broker.sock";
// Where the approved commit of a publish is exported for the broker (P1).
const publishExportRoot = process.env.PUBLISH_EXPORT_ROOT ?? "/run/infra-cod/publish-exports";
const githubBrokerSocketGroup = process.env.GITHUB_BROKER_SUPERVISOR_SOCKET_GROUP ?? "infra-cod-github";
const socketGroupEntry = execFileSync("/usr/bin/getent", ["group", socketGroup], { encoding: "utf8" }).trim();
const socketGroupId = Number(socketGroupEntry.split(":")[2]);
if (!Number.isInteger(socketGroupId)) throw new Error("runtime supervisor socket group is invalid");
const githubBrokerGroupEntry = execFileSync("/usr/bin/getent", ["group", githubBrokerSocketGroup],
  { encoding: "utf8" }).trim();
const githubBrokerGroupId = Number(githubBrokerGroupEntry.split(":")[2]);
if (!Number.isInteger(githubBrokerGroupId)) throw new Error("github broker socket group is invalid");
const workspaceRoot = process.env.PROJECT_WORKSPACE_ROOT ?? INSTALLATION_LAYOUT.workspaceRoot.path;
const gateWorkspaceRoot = process.env.RUNTIME_GATE_WORKSPACE_ROOT ?? INSTALLATION_LAYOUT.gateSmokeRoot.path;
const supervisorId = process.env.RUNTIME_SUPERVISOR_ID ?? "vps-runtime-supervisor-1";
// How long an implementation run may take before the supervisor ends it.
//
// It used to be five minutes, hard-coded, shared with the chat channel. Five
// minutes is a reasonable ceiling for a chat turn and a fatal one for an
// implementation: the first real task on the VPS was still editing the file it
// had been asked to change at fifteen minutes, and was killed three times in a
// row at exactly 5:02, 5:19 and 5:18 — so it could never have finished, and the
// operator saw OpenCode's own words about a terminated session rather than a
// timeout.
//
// This is a safety net, not the normal limit: the workspace lease is what bounds
// a healthy run, and it is renewed while the run lives. Sixty minutes is long
// enough for real work on the 4 GB target and short enough that a wedged child
// does not hold a workspace overnight.
const configuredRunTimeoutMs = Number(process.env.RUNTIME_RUN_TIMEOUT_MS ?? 60 * 60_000);
const runTimeoutMs = Number.isFinite(configuredRunTimeoutMs)
  ? Math.max(configuredRunTimeoutMs, 60_000)
  : 60 * 60_000;

// How long a run may go on after its terminal report was accepted. The report
// is the run's result; what the model does afterwards is not, and on rc.39 the
// free model kept its process alive for minutes after `complete_task`, calling
// it again, while the executor waited for it to exit before collecting the
// evidence. Long enough for a final message, then the run is ended as done.
const configuredTerminalReportGraceMs = Number(process.env.RUNTIME_TERMINAL_REPORT_GRACE_MS ?? 30_000);
const terminalReportGraceMs = Number.isFinite(configuredTerminalReportGraceMs)
  ? Math.max(configuredTerminalReportGraceMs, 1_000)
  : 30_000;

const configuredWorkspaceOperationPollMs = Number(process.env.WORKSPACE_OPERATION_POLL_MS ?? 60_000);
const workspaceOperationPollMs = Number.isFinite(configuredWorkspaceOperationPollMs)
  ? Math.max(configuredWorkspaceOperationPollMs, 60_000)
  : 60_000;
// The pinned Node is on it (rc.120): a reviewer told to run a project's tests
// found no `node` and reported that it could not, while the executor had found
// /opt/node/bin by itself. The same Node the platform runs on; it was already
// executable by full path, so this changes what is found, not what is allowed.
const runtimePath = "/usr/local/bin:/opt/node/bin:/usr/bin:/bin";
const deployKeyRoot = process.env.GITHUB_DEPLOY_KEY_ROOT ?? INSTALLATION_LAYOUT.githubDeployKeys.path;
const githubKnownHosts = process.env.GITHUB_KNOWN_HOSTS_FILE ?? "/etc/infra-cod/github_known_hosts";
const channels = new Map();
// The runs whose tool sockets are open, by run id: what the sweep keeps.
const liveToolSockets = new Set();

await mkdir(path.dirname(socketPath), { recursive: true });
await rm(socketPath, { force: true });
await rm(retiredWorkerToolSocket, { force: true });
// A supervisor that died took its runs with it, and left their sockets. They
// are removed before anything listens, and the sweep repeats while this runs.
await ensureRunToolRoot(workerToolSocketRoot);
for (const runId of await sweepRunToolSockets(workerToolSocketRoot)) {
  process.stderr.write(`${JSON.stringify({ type: "worker_tool_socket.swept", run_id: runId, at: "start" })}\n`);
}
setInterval(() => {
  sweepRunToolSockets(workerToolSocketRoot, liveToolSockets).then((removed) => {
    for (const runId of removed) {
      process.stderr.write(`${JSON.stringify({ type: "worker_tool_socket.swept", run_id: runId, at: "sweep" })}\n`);
    }
  }).catch(() => {});
}, 60_000).unref();
await rm(githubBrokerSocketPath, { force: true });
// Exports a previous process left behind: nothing will release them now.
await rm(publishExportRoot, { recursive: true, force: true });
// Every run this supervisor launches lives in a cgroup of its own under the
// unit's delegated subtree (run-cgroup.mjs, sprint C K1): stopping a run kills
// the cgroup, which reaches a tool that left the process group. The subtree is
// proved writable before anything listens — a run that could not be killed is
// not launched — and the leaves a previous process left are killed and removed.
const isolation = runIsolationFromEnvironment(process.env, {
  log: (line) => process.stderr.write(`${JSON.stringify(line)}\n`),
});
await isolation.prepare();
if (isolation.mechanism !== "cgroup") {
  process.stderr.write(`${JSON.stringify({
    type: "run_isolation.fallback", mechanism: isolation.mechanism,
    warning: "runs are stopped by process group, not by cgroup; a tool that leaves the group outlives a stop",
  })}\n`);
}
for (const swept of await isolation.sweep()) {
  process.stderr.write(`${JSON.stringify({ type: "run_cgroup.swept", ...swept, at: "start" })}\n`);
}
process.stdout.write(`${JSON.stringify({ type: "run_isolation.ready", mechanism: isolation.mechanism, root: isolation.root })}\n`);
// Every launch asks for memory first (sprint C K3): the host's, after a
// reserve, and the unit's MemoryMax, which counts every run in its leaves. A
// launch that does not fit is refused as runtime_capacity before anything
// exists, and waits; it is never started to be OOM-killed.
// A background run (a model check on the gate surface, a qualification) keeps
// room for one more task run of the largest estimate after it (Stage 12 W6).
const capacity = createCapacityGate({
  settings: capacitySettings(process.env),
  read: hostReadings({ cgroupRoot: isolation.root }),
  estimateOf: (name) => adapterFor(name).memoryEstimateMb * 1024 * 1024,
  taskReserveBytes: Math.max(0, ...allAdapters().map((adapter) => adapter.memoryEstimateMb ?? 0)) * 1024 * 1024,
});
setCapacityGate(capacity);
process.stdout.write(`${JSON.stringify({ type: "runtime_capacity.ready", settings: capacitySettings(process.env), reading: await capacity.reading() })}\n`);
// Stage 12 M1: each run's leaf gets memory.max — the runtime's estimate times
// RUNTIME_RUN_MEMORY_FACTOR (2), and never more than the unit's MemoryMax less
// room for the supervisor itself, so one run over its size is killed in its
// own leaf and never takes the unit, the supervisor or the runs beside it.
// Measured on the host (STAGE_11_REPORT, K3): Claude 281–298 MB against 350,
// OpenCode 528–563 MB against 600.
const MIB = 1024 * 1024;
const runMemoryFactor = Number(process.env.RUNTIME_RUN_MEMORY_FACTOR) > 0 ? Number(process.env.RUNTIME_RUN_MEMORY_FACTOR) : 2;
const unitMemoryMax = (() => {
  if (!isolation.root) return null;
  try {
    const value = readFileSync(path.join(isolation.root, "memory.max"), "utf8").trim();
    return /^\d+$/.test(value) ? Number(value) : null;
  } catch { return null; }
})();
function runMemoryLimit(driver) {
  const estimate = (adapterFor(driver.name).memoryEstimateMb ?? 0) * MIB;
  if (!estimate) return {};
  const ceiling = unitMemoryMax ? unitMemoryMax - 128 * MIB : Infinity;
  return { memoryMaxBytes: Math.min(estimate * runMemoryFactor, ceiling) };
}
process.stdout.write(`${JSON.stringify({ type: "run_memory_limits.ready", enabled: Boolean(isolation.memoryLimits), factor: runMemoryFactor,
  limits_mb: Object.fromEntries(allDrivers().map((driver) => [driver.name, Math.round((runMemoryLimit(driver).memoryMaxBytes ?? 0) / MIB)])) })}\n`);
// What a run actually took: sampled from its leaf (runtime-capacity.mjs), and
// since M1 the kernel's own count — its limit, peak and any OOM kill in it.
const watchMemory = (leaf) => {
  if (!isolation.procs) return null;
  const sampled = watchRunMemory({ procsOf: () => isolation.procs(leaf) });
  return { async stop() {
    const result = await sampled.stop();
    const kernel = isolation.memoryStats ? await isolation.memoryStats(leaf).catch(() => null) : null;
    return kernel ? { ...result, ...kernel } : result;
  } };
};
// The lexical and symlink checks before privileged calls only become a fence
// when no unprivileged account can replace either the workspace-root entry or
// any parent component. Fail startup if an upgrade left any component writable.
const canonicalWorkspaceRoot = await assertTrustedDirectoryChain(workspaceRoot);
await mkdir(gateWorkspaceRoot, { recursive: true });
const canonicalGateWorkspaceRoot = await realpath(gateWorkspaceRoot);
// The gate worker (infra-control) creates and removes per-verification scratch
// directories; the supervisor keeps ownership of the gate root itself.
await chown(canonicalGateWorkspaceRoot, 0, socketGroupId);
await chmod(canonicalGateWorkspaceRoot, 0o2771);

// One writer per connection, so frames are numbered per connection and the
// spool is bounded per connection (WP-8b). `send` keeps its signature — every
// call site passes the socket it is answering — and the writer is found from it.
const writers = new WeakMap();

function writerFor(socket) {
  let write = writers.get(socket);
  if (!write) {
    write = createFrameWriter(socket);
    writers.set(socket, write);
  }
  return write;
}

function send(socket, message) {
  if (socket.destroyed || !socket.writable) return;
  try {
    writerFor(socket)(message);
  } catch (error) {
    // A frame this side refuses to send is this side's defect, and dropping it
    // silently would leave the peer waiting on a request that was answered into
    // nothing. It is named here and, where there is a request to answer, the
    // caller is told instead.
    process.stderr.write(`${JSON.stringify({
      type: "runtime_supervisor.frame_refused", reason: error.reason,
      request_id: message.request_id, message_type: message.type, error: error.message,
    })}\n`);
    if (message.request_id && message.ok !== false) {
      send(socket, { request_id: message.request_id, ok: false, error: error.message,
        retryable: false, failure_code: "protocol" });
    }
  }
}

// A connection's reader: bounded frames, one bad frame skipped rather than the
// socket lost, and the handshake answered here because it is the transport's.
function readFramesFrom(socket, dispatch, { label }) {
  const feed = createFrameReader({
    onMessage: (frame) => {
      if (frame.type === "hello") {
        const version = negotiatedVersion(frame.protocol_version);
        protocolVersions.set(socket, version);
        // Answered as an ordinary reply, because the client waits on
        // `request_id` like it does for everything else.
        if (version === null) {
          send(socket, { request_id: frame.request_id, ok: false, failure_code: "protocol",
            error: `this supervisor speaks protocol ${SUPPORTED_PROTOCOL_VERSIONS.join(", ")}, not ${frame.protocol_version}` });
          socket.end();
          return;
        }
        send(socket, { request_id: frame.request_id, ok: true,
          result: { protocol_version: version, supervisor_id: supervisorId, drivers: driverSummary() } });
        return;
      }
      // The request, not the frame: the sequence number was the reader's.
      dispatch(payloadOf(frame));
    },
    onProtocolError: (error) => {
      process.stderr.write(`${JSON.stringify({
        type: "runtime_supervisor.protocol_error", socket: label, reason: error.reason, error: error.message,
      })}\n`);
      send(socket, { type: "protocol_error", error: error.message, reason: error.reason });
    },
  });
  socket.setEncoding("utf8");
  socket.on("data", feed);
}

// The version of a runtime this host runs, from the record root keeps of it,
// against the one its driver was shown at. Read per launch rather than once:
// `infra-cod runtime install` switches versions under a running supervisor.
// An unreadable record is an unknown version, which is `unverified`.
function verificationOf(driver) {
  let entry = null;
  try {
    entry = readRuntimes().runtimes?.[driver.name] ?? null;
  } catch { /* unverified, which is what an unreadable record is */ }
  return capabilityVerification(driver, entry?.active?.version ?? null, { qualification: activeQualification(entry) });
}

// What the supervisor drives, said in the handshake: each driver's surfaces and
// the pair it was verified at, against what this host runs. The one place a
// person holding the socket can read all of it at once.
function driverSummary() {
  return allDrivers().map((driver) => ({
    ...verificationOf(driver),
    surfaces: Object.keys(driver.surfaces),
    capabilities: Object.keys(driver.capabilities),
  }));
}

// What each connection said it speaks. A connection that never said hello is
// every release before this one, and is served as version 1.
const protocolVersions = new WeakMap();

function transferOwnership(workspace, user) {
  // The pair comes from the shared allowlist, never from a request: otherwise a
  // workspace operation would be a "chown anything to anyone" primitive.
  const { group } = ownershipFor(user);
  // Never dereference repository symlinks during a privileged recursive walk.
  execFileSync("/usr/bin/chown", ["-hR", `${user}:${group}`, workspace]);
  execFileSync("/usr/bin/chmod", ["-R", "u+rwX,g+rX,o-rwx", workspace]);
}

async function githubAppWorkspace(request, action) {
  if (!/^[0-9a-f-]{36}$/i.test(String(request.project_id ?? ""))) {
    throw new Error("invalid github app workspace project id");
  }
  const project = await queryJson(`
    SELECT jsonb_build_object('id',id,'workspace_path',workspace_path,'status',status,
      'credential_mode',credential_mode,'provisioning_status',settings->>'provisioning_status')::text
    FROM projects WHERE id=:'project_id'::uuid;`, { project_id: request.project_id });
  const provisionAuthorized = project?.credential_mode === "github_app"
    && project.status === "needs_attention" && project.provisioning_status === "provisioning";
  const abortAuthorized = action === "abort" && project?.credential_mode === "github_app"
    && project.status === "needs_attention"
    && new Set(["provisioning", "failed"]).has(project.provisioning_status);
  if (!provisionAuthorized && !abortAuthorized) {
    throw new Error("github app workspace authorization failed");
  }
  const workspace = path.join(canonicalWorkspaceRoot, project.id);
  if (path.resolve(String(project.workspace_path ?? "")) !== workspace) {
    throw new Error("github app workspace path does not match the project allocation");
  }

  if (action === "prepare") {
    await assertWorkspaceOnDisk(workspace);
    await rm(workspace, { recursive: true, force: true });
    await mkdir(workspace, { mode: 0o700 });
    transferOwnership(workspace, "infra-cod-github");
  } else if (action === "finalize") {
    await assertWorkspaceOnDisk(workspace);
    // Revoke the broker's ownership of the root entry before the recursive
    // privileged walk. It cannot replace the entry because the parent is
    // root-only; -hR additionally prevents repository symlinks being followed.
    await chown(workspace, 0, 0);
    await chmod(workspace, 0o700);
    transferOwnership(workspace, RESTING_OWNER);
  } else if (action === "abort") {
    await assertWorkspaceOnDisk(workspace);
    await rm(workspace, { recursive: true, force: true });
  }
  return { workspace, action };
}

// Sprint B P1: the approved commit of a claimed publish, for the GitHub broker
// to push. The database says which intent is claimed and which commit it names
// (publish_export_target), not the broker that asks. Read as the workspace's
// owner, in the workspace's turn, never as root (publish-export.mjs), into a
// file only root and the broker's group can read.

async function githubPublishExport(request, action) {
  if (!/^[0-9a-f-]{36}$/i.test(String(request.intent_id ?? ""))) throw new Error("invalid publish intent id");
  const file = path.join(publishExportRoot, `${request.intent_id.toLowerCase()}.pack`);
  if (action === "publish_release") {
    await rm(file, { force: true });
    return { released: true, ...(await recordPublishedRefs(request.intent_id)) };
  }
  const target = await queryJson(`SELECT publish_export_target(:'id'::uuid)::text;`, { id: request.intent_id });
  if (!target) throw new Error("publish export authorization failed");
  const workspace = path.join(canonicalWorkspaceRoot, target.project_id);
  if (path.resolve(String(target.workspace_path ?? "")) !== workspace) {
    throw new Error("publish workspace path does not match the project allocation");
  }
  if (!(await assertWorkspaceOnDisk(workspace))) {
    return { refused: "publish_export_failed", message: "the workspace is not on disk" };
  }
  return await inWorkspaceTurn(workspace, async () => {
    const owner = inspectOwner((await stat(workspace)).uid, runtimeUid);
    const exported = await exportApprovedCommit({ runGit: gitAs(owner, workspace), headSha: target.head_commit_sha });
    if (exported.refused) return exported;
    await mkdir(publishExportRoot, { recursive: true, mode: 0o750 });
    await chown(publishExportRoot, 0, githubBrokerGroupId);
    await chmod(publishExportRoot, 0o750);
    await writeFile(file, exported.pack, { mode: 0o440 });
    await chown(file, 0, githubBrokerGroupId);
    await chmod(file, 0o440);
    return { pack_path: file, head_ref: exported.head_ref, head_sha: exported.head_sha, bytes: exported.pack.length };
  });
}

// 0145: a workspace brought up to date with GitHub. The database names the
// claimed sync and its project, not the broker that asks. The broker writes the
// bundle of GitHub's base branch into an inbox made here for it; the bundle is
// copied to a scratch file the workspace's owner can read, and applied as that
// owner, in the workspace's turn (workspace-sync.mjs) — never as root, and
// never by the broker, which holds a token and would run the repository's own
// git configuration.
const syncInboxRoot = path.join(canonicalWorkspaceRoot, ".sync");

async function githubWorkspaceSync(request, action) {
  if (!/^[0-9a-f-]{36}$/i.test(String(request.sync_id ?? ""))) throw new Error("invalid workspace sync id");
  const inbox = path.join(syncInboxRoot, request.sync_id.toLowerCase());
  if (action === "sync_release") {
    await rm(inbox, { recursive: true, force: true });
    return { released: true };
  }
  const target = await queryJson(`SELECT workspace_sync_target(:'id'::uuid)::text;`, { id: request.sync_id });
  if (!target) throw new Error("workspace sync authorization failed");
  const workspace = path.join(canonicalWorkspaceRoot, target.project_id);
  if (path.resolve(String(target.workspace_path ?? "")) !== workspace) {
    throw new Error("sync workspace path does not match the project allocation");
  }
  if (action === "sync_prepare") {
    await mkdir(syncInboxRoot, { recursive: true, mode: 0o711 });
    await chmod(syncInboxRoot, 0o711);
    await rm(inbox, { recursive: true, force: true });
    await mkdir(inbox, { mode: 0o770 });
    await chown(inbox, 0, githubBrokerGroupId);
    await chmod(inbox, 0o770);
    return { inbox, base_branch: target.base_branch };
  }
  const finish = async (result) => {
    await queryJson(`SELECT finish_workspace_sync(:'id'::uuid,:'result'::jsonb)::text;`,
      { id: request.sync_id, result: JSON.stringify(result) });
    return result;
  };
  if (!(await assertWorkspaceOnDisk(workspace))) return await finish({ status: "failed", outcome: "the workspace is not on disk" });
  const bundle = path.join(inbox, "origin.bundle");
  return await inWorkspaceTurn(workspace, async () => {
    const current = await queryJson(`SELECT workspace_sync_target(:'id'::uuid)::text;`, { id: request.sync_id });
    // The lease ran out while waiting for the turn: another claim owns it now.
    if (!current) throw new Error("the workspace sync is no longer claimed");
    if (current.run_holds_workspace) {
      return await finish({ status: "kept", outcome: "a run is in the workspace; the next chat syncs it" });
    }
    const owner = inspectOwner((await stat(workspace)).uid, runtimeUid);
    const uid = runtimeUid(owner);
    const scratch = await mkdtemp(path.join(tmpdir(), "infra-cod-sync-"));
    try {
      const readable = path.join(scratch, "origin.bundle");
      // The inbox is the broker's to write: what it left is opened without
      // following a link and without blocking on a FIFO, and read only if it is
      // a regular file the broker's group owns — root never copies a path the
      // broker could point at /etc/shadow or another project.
      let handle;
      try {
        handle = await open(bundle, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
      } catch {
        return await finish({ status: "failed", outcome: "the broker left no bundle of GitHub's branch" });
      }
      try {
        const info = await handle.stat();
        if (!info.isFile() || info.gid !== githubBrokerGroupId || info.size > 2 * 1024 ** 3) {
          return await finish({ status: "failed", outcome: "what the broker left is not a bundle file of its own" });
        }
        await pipeline(handle.createReadStream({ autoClose: false }), createWriteStream(readable, { mode: 0o600, flags: "wx" }));
      } finally {
        await handle.close();
      }
      await chown(scratch, uid, (await stat(scratch)).gid);
      await chown(readable, uid, (await stat(readable)).gid);
      await chmod(scratch, 0o700);
      const result = await applyWorkspaceSync({ runGit: gitAs(owner, workspace), bundlePath: readable,
        baseBranch: target.base_branch, mode: target.mode });
      if (result.status !== "failed") await refreshRepositoryMap(target.project_id, owner, workspace, "sync");
      process.stderr.write(`${JSON.stringify({ type: "workspace.synced", sync_id: request.sync_id, project_id: target.project_id, status: result.status, outcome: result.outcome })}\n`);
      return await finish(result);
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });
}

// A published intent's refs, where the workspace looks for them: the publish
// pushes from a scratch repository, so the workspace's own origin/* never
// learned the commit had gone, and Changes kept listing it under "To publish"
// (battle test, chat 1). No network — the refs are set to what the receipt
// says was pushed, as the workspace's owner, in its turn. Not required: a
// publish is done whether or not this lands; the next one sets them again.
async function recordPublishedRefs(intentId) {
  try {
    const published = await queryJson(`SELECT jsonb_build_object('project_id',i.project_id,'workspace_path',p.workspace_path,
        'sha',i.pushed_sha,'refs',to_jsonb(array_remove(ARRAY[i.pushed_ref,i.initialised_base_ref],NULL)))::text
      FROM publish_intents i JOIN projects p ON p.id=i.project_id
      WHERE i.id=:'id'::uuid AND i.status='published';`, { id: intentId });
    if (!published || !/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(String(published.sha))) return {};
    const workspace = path.join(canonicalWorkspaceRoot, published.project_id);
    if (path.resolve(String(published.workspace_path ?? "")) !== workspace || !(await assertWorkspaceOnDisk(workspace))) return {};
    const tracking = [...new Set(published.refs)].filter((ref) => /^refs\/heads\/(?!.*\.\.)[A-Za-z0-9._\/-]{1,200}$/.test(ref))
      .map((ref) => `refs/remotes/origin/${ref.slice("refs/heads/".length)}`);
    return await inWorkspaceTurn(workspace, async () => {
      const git = gitAs(inspectOwner((await stat(workspace)).uid, runtimeUid), workspace);
      const recorded = [];
      for (const ref of tracking) {
        const result = await git(["-c", `safe.directory=${workspace}`, "update-ref", ref, published.sha]);
        if (result.code === 0) recorded.push(ref);
      }
      return { tracking_refs: recorded };
    });
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ type: "publish.tracking_refs_failed", intent_id: intentId, error: String(error?.message ?? error).slice(0, 300) })}\n`);
    return {};
  }
}

function redactAccountText(value) {
  return String(value)
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[REDACTED_EMAIL]")
    .replace(/\b(sk|sess|key|rk)-[A-Za-z0-9_-]{8,}\b/g, "[REDACTED_CRED]")
    .replace(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, "[REDACTED_JWT]")
    .replace(/[\u0000-\u001f\u007f]/g, " ");
}

async function getProject(projectId) {
  const project = await queryJson(
    `SELECT jsonb_build_object(
      'id', p.id, 'status', p.status, 'workspace_path', p.workspace_path
    )::text FROM projects p WHERE p.id = :'project_id'::uuid;`,
    { project_id: projectId },
  );
  // Launch admission fence: a project in any deletion state must not accept a
  // new workspace channel, workspace operation or runtime launch.
  if (!project || ["archived", "deleting", "deletion_failed", "deleted"].includes(project.status)) {
    throw new Error("project is unavailable");
  }
  const canonicalWorkspace = await realpath(project.workspace_path);
  if (
    canonicalWorkspace !== canonicalWorkspaceRoot &&
    !canonicalWorkspace.startsWith(`${canonicalWorkspaceRoot}${path.sep}`)
  ) {
    throw new Error("project workspace escapes the configured root");
  }
  return { ...project, workspace: canonicalWorkspace };
}

// Whether the run a process_ref names is still doing anything: its cgroup, or
// its pid for a ref the release before wrote (deprovision-safety.mjs). No ref
// is no run; a ref this supervisor does not recognise is alive, because every
// caller is about to hand a workspace to someone else.
async function processAlive(processRef) {
  if (processRef === null || processRef === undefined || processRef === "") return false;
  return writerAlive(parseProcessRef(processRef), { cgroupAlive: isolation.alive });
}

// Ends the run a process_ref names, for the deprovision's fallback passes: a
// signal to its cgroup, or to its process group for a pid-only ref.
async function signalProcessRef(processRef, signal) {
  const ref = parseProcessRef(processRef);
  if (!ref) return;
  if (ref.cgroup) {
    await isolation.signal(isolation.leafNamed(ref.cgroup), signal);
    return;
  }
  try { process.kill(-ref.pid, signal); } catch { try { process.kill(ref.pid, signal); } catch {} }
}

async function manageWorkspace(request) {
  if (!new Set(["recover_lock", "restore_owner"]).has(request.operation_type)
      || typeof request.worker_id !== "string" || request.worker_id.length < 2) {
    throw new Error("invalid workspace operation request");
  }
  const context = await queryJson(`
    SELECT jsonb_build_object('operation_id',op.id,'project_id',op.project_id,
      'operation_type',op.operation_type,'status',op.status,'worker_id',op.worker_id,
      -- The same rule as request_workspace_operation (0064), and a test keeps
      -- the two equal: recover_lock waits for work in flight and for a pending
      -- implementation, not for the read-only turns waiting on this recovery.
      -- rc.28 changed the request and not this, so the recovery it admitted was
      -- refused here: "workspace operation authorization failed".
      'lock_status',l.status,'active_jobs',(SELECT count(*) FROM runtime_jobs j
        WHERE j.project_id=op.project_id
          AND (j.status='in_flight'
               OR (j.status='pending' AND (op.operation_type<>'recover_lock' OR j.job_type='implementation_run')))),
      -- The lost *writer*. Since 0059 a Codex turn is a run too, and a turn has
      -- no process ref: were one ever lost, it would answer "no process" on
      -- behalf of an implementation that may still be running, and the
      -- workspace would be handed over under it. 0059 never marks a turn lost;
      -- this says so where the assumption is made.
      'process_ref',(SELECT r.process_ref FROM task_runs r JOIN tasks t ON t.id=r.task_id
        WHERE t.project_id=op.project_id AND r.status='lost' AND r.write_capable
        ORDER BY r.finished_at DESC NULLS LAST,r.created_at DESC LIMIT 1))::text
    FROM workspace_operations op JOIN workspace_locks l ON l.project_id=op.project_id
    WHERE op.id=:'operation_id'::uuid;`, { operation_id: request.operation_id });
  if (!context || context.project_id !== request.project_id || context.operation_type !== request.operation_type
      || context.status !== "running" || context.worker_id !== request.worker_id || Number(context.active_jobs) !== 0) {
    throw new Error("workspace operation authorization failed");
  }
  if (request.operation_type === "recover_lock" && context.lock_status !== "reconciliation_required") {
    throw new Error("workspace lock recovery precondition changed");
  }
  if (request.operation_type === "restore_owner" && context.lock_status !== "released") {
    throw new Error("workspace ownership restore precondition changed");
  }
  if (await processAlive(context.process_ref)) throw new Error("stale runtime process is still alive");
  const project = await getProject(request.project_id);
  // An operator's recovery, not a launch: no run holds a grant here, and the
  // preconditions above are this operation's own authority.
  await inWorkspaceTurn(project.workspace, async () => transferOwnership(project.workspace, RESTING_OWNER));
  return { owner: RESTING_OWNER, process_guard: "absent", lock_status: context.lock_status };
}

// Runs a command as a runtime user with a scrubbed environment. Provisioning
// deliberately does not run git as root: the clone fetches arbitrary remote
// content, and nothing about it needs privilege once the directory belongs to
// the runtime user.
// `raw` exists for one caller and one reason: `git status --porcelain=v1` puts
// the index status in column 1 and the worktree status in column 2, so a file
// modified in the worktree and not staged reports a **leading space**. Trimming
// the output eats it, every later position shifts by one, and the path the
// operator is shown loses its first character — `ervices/...` for
// `services/...`. Only the first line, because `trim` touches the ends of the
// output and not of each line, which is why this survived: the panel showed one
// wrong path in a list of right ones.
//
// Every other caller reads a single value — a branch name, a sha — where the
// trailing newline is noise and no leading whitespace is meaningful. Those keep
// trimming.
function runAsRuntimeUser(user, workspace, command, args,
                          { timeout = 30_000, optional = false, environment = [], raw = false } = {}) {
  try {
    const output = execFileSync(
      "/usr/sbin/runuser",
      cleanRuntimeArgs(user, workspace, command, args, ["GIT_TERMINAL_PROMPT=0", ...environment]),
      { encoding: "utf8", cwd: workspace, stdio: ["ignore", "pipe", "pipe"], timeout, maxBuffer: 2 * 1024 * 1024 },
    );
    return raw ? output : output.trim();
  } catch (error) {
    if (optional) return "";
    const detail = String(error.stderr ?? error.message).slice(0, 500);
    throw new Error(`${command} ${args[0] ?? ""} failed: ${detail}`);
  }
}

// git as the account that owns the workspace, never as root: a repository's
// own configuration can name programs for git to run (a clean filter, an
// fsmonitor), and whoever could have written them must not get more privilege
// from us than the runtime already had (review-evidence.mjs, ADR-0015).
// `command`, not a literal: git is a tool, not a runtime, and the registry test
// holds every launch by name to the runtimes' drivers.
function gitAs(account, workspace, command = "git") {
  return (args, { env = {}, input, timeout = 120_000 } = {}) => runProcess(
    "/usr/sbin/runuser",
    cleanRuntimeArgs(account, workspace, command, args, [
      ...GIT_ISOLATION, "GIT_TERMINAL_PROMPT=0",
      ...Object.entries(env).map(([name, value]) => `${name}=${value}`),
    ]),
    { cwd: workspace, input, timeout },
  );
}

// The project's repository map (0146), built from the workspace's last commit
// as the account that owns it — never as root, for the reason gitAs gives — and
// recorded for the orchestrator's next session. Never required: a map that
// could not be built leaves the last one in place, and the work that called
// this goes on (repository-map.mjs).
async function refreshRepositoryMap(projectId, account, workspace, source) {
  try {
    const map = await buildRepositoryMap({ runGit: gitAs(account, workspace) });
    if (!map) return;
    const serialized = JSON.stringify(map);
    if (!serialized.isWellFormed()) throw new Error("the map is not well-formed Unicode");
    await queryJson(`SELECT record_repository_map(:'project_id'::uuid,:'source',:'map'::jsonb)::text;`,
      { project_id: projectId, source, map: serialized });
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ type: "repository_map.failed", project_id: projectId, source, error: String(error?.message ?? error).slice(0, 300) })}\n`);
  }
}

// The four digests of a workspace as `account` sees it, relative to `base`.
// The scratch index lives in a directory made for this call and given to that
// account, not in the repository: the repository's index is the runtime's.
async function reviewEvidenceAs(account, workspace, base) {
  const uid = runtimeUid(account);
  if (!Number.isInteger(uid)) throw new Error(`cannot resolve the uid of ${account}`);
  const scratch = await mkdtemp(path.join(tmpdir(), "infra-cod-evidence-"));
  try {
    await chown(scratch, uid, (await stat(scratch)).gid);
    await chmod(scratch, 0o700);
    return await collectReviewEvidence({
      runGit: gitAs(account, workspace), indexFile: path.join(scratch, "index"), base,
    });
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

// The project's own check (0143), as the account that ran the executor, in its
// runtime's sandbox shell and without network: the same reach the executor's
// own test run had, minus the network (project-check.mjs).
// It runs in the run's own cgroup leaf, so the run's memory limit bounds it as
// it bounded the executor; the leaf is released after it, with the rest.
// `command`, not a literal, as in gitAs: the sandbox shell is a tool, not a
// runtime, and the registry test holds every runtime launch to its driver.
async function projectCheckAs(account, adapter, workspace, check, leaf, command = SANDBOX_SHELL) {
  return await runProjectCheck({
    command: check.command, timeoutSeconds: Number(check.timeout_seconds) || 600,
    spawnCheck: async (args, { timeout }) => {
      const [launcher, argv] = isolation.launcher(leaf, "/usr/sbin/runuser",
        cleanRuntimeArgs(account, workspace, command, args,
          [...sandboxShellEnvironment(adapter), "INFRA_COD_SANDBOX_NO_NET=1", "CI=1"]));
      const result = await runProcess(launcher, argv, { cwd: workspace, timeout, maxBytes: 8 * 1024 * 1024 });
      return { code: result.code, stdout: result.stdout.toString("utf8"), stderr: result.stderr };
    },
  });
}

// Materialises a project workspace. Everything it acts on comes from the
// claimed operation, and every decision comes from workspace-provisioning.mjs,
// so this function only executes.
async function provisionWorkspace(operation) {
  const expected = path.join(canonicalWorkspaceRoot, String(operation.project_id));
  const present = await assertWorkspaceOnDisk(expected);

  let existingGit = false;
  if (present) {
    try { existingGit = (await lstat(path.join(expected, ".git"))).isDirectory(); }
    catch { existingGit = false; }
  }

  const plan = provisionPlan(operation, {
    canonicalRoot: canonicalWorkspaceRoot, existingGit,
    keyRoot: deployKeyRoot, knownHostsFile: githubKnownHosts,
  });

  if (plan.recreate) {
    await rm(plan.workspace, { recursive: true, force: true });
    await mkdir(plan.workspace, { recursive: true });
    // Owned by whoever runs the steps, not by the eventual owner: a deploy-key
    // clone runs as infra-control, and a directory owned by codex-worker with mode
    // g+rX leaves it nothing to write into.
    transferOwnership(plan.workspace, plan.staging.user);

    for (const step of plan.steps) {
      if (step.kind === "seed") {
        await writeFile(path.join(plan.workspace, step.file), step.contents, { flag: "wx" });
        continue;
      }
      // A public clone runs as the eventual owner; a deploy-key clone runs as
      // infra-control, which can read the key without the sandboxed account
      // ever seeing it. The step decides, not this function.
      runAsRuntimeUser(step.user, plan.workspace, step.command, step.args, {
        timeout: step.kind === "clone" ? 180_000 : 30_000,
        environment: step.environment ?? [],
      });
    }
  }

  // Re-checked after the clone: git wrote into this directory, and the chown
  // below is recursive and privileged.
  await assertWorkspaceOnDisk(plan.workspace);
  transferOwnership(plan.workspace, plan.ownership.user);
  await refreshRepositoryMap(operation.project_id, plan.ownership.user, plan.workspace, "provision");
  return {
    owner: plan.ownership.user,
    workspace: plan.workspace,
    recreated: plan.recreate,
    steps: plan.steps.map((step) => step.kind),
  };
}

// Collects workspace state. Read-only, and reported back to the requester,
// which records it — the supervisor's database surface stays minimal.
// Resolved once per process. These are system accounts created by the installer;
// a uid that changed under a running supervisor is a reinstall, and a restart is
// what follows it.
const runtimeUidCache = new Map();
function runtimeUid(user) {
  if (!runtimeUidCache.has(user)) {
    try {
      runtimeUidCache.set(user, Number(execFileSync("id", ["-u", user], { encoding: "utf8" }).trim()));
    } catch {
      runtimeUidCache.set(user, null);
    }
  }
  return runtimeUidCache.get(user);
}

async function inspectWorkspace(operation) {
  const located = inspectPlan(operation, { canonicalRoot: canonicalWorkspaceRoot });
  await assertWorkspaceOnDisk(located.workspace);
  // Read who owns it now, not who owned it when it was provisioned. An
  // implementation run hands the tree to the executor's account and hands it
  // back when the run ends.
  const plan = inspectPlan(operation, {
    canonicalRoot: canonicalWorkspaceRoot,
    owner: inspectOwner((await stat(located.workspace)).uid, runtimeUid),
  });
  const git = (args, optional = true) =>
    runAsRuntimeUser(plan.owner, plan.workspace, "git", args, { optional });

  const branch = git(plan.commands.branch);
  const headSha = git(plan.commands.headSha);
  const upstream = git(plan.commands.upstream);
  const divergence = upstream ? git(plan.divergenceArgs(upstream)) : "";
  const porcelain = runAsRuntimeUser(plan.owner, plan.workspace, "git", plan.commands.porcelain, { raw: true });
  const numstat = headSha ? git(plan.numstatArgs()) : "";
  let unpublished = null;
  if (headSha) {
    const log = git(plan.unpublishedLogArgs());
    const oldest = log.split("\n").filter(Boolean).at(-1)?.split("\t")[0];
    const base = oldest ? (git(plan.parentArgs(oldest)) || EMPTY_TREE) : null;
    unpublished = summariseUnpublished({ log, numstat: base ? git(plan.rangeNumstatArgs(base)) : "" });
  }

  return summariseWorkspace({ branch, headSha, upstream, divergence, porcelain, numstat, unpublished });
}

let workspaceOperationRunning = false;
async function processWorkspaceOperation() {
  if (workspaceOperationRunning) return;
  workspaceOperationRunning = true;
  let operation = null;
  try {
    operation = await queryJson(`SELECT claim_workspace_operation(:'worker_id')::text;`, { worker_id: supervisorId });
    if (!operation) return;
    // Operator repairs and system provisioning are separate handlers, matching
    // the two request paths in the database. Neither accepts the other's types.
    let result;
    if (operation.operation_type === "provision_workspace") {
      result = await provisionWorkspace(operation);
    } else if (operation.operation_type === "inspect_workspace") {
      result = await inspectWorkspace(operation);
    } else {
      result = await manageWorkspace({ operation_id: operation.id, project_id: operation.project_id,
        operation_type: operation.operation_type, worker_id: supervisorId });
    }
    await queryJson(`SELECT finish_workspace_operation(:'id'::uuid,:'worker_id',true,:'result'::jsonb,NULL)::text;`,
      { id: operation.id, worker_id: supervisorId, result: JSON.stringify(result) });
  } catch (error) {
    if (operation) {
      try { await queryJson(`SELECT finish_workspace_operation(:'id'::uuid,:'worker_id',false,'{}'::jsonb,:'error')::text;`,
        { id: operation.id, worker_id: supervisorId, error: error.message.slice(0, 1000) }); } catch {}
    }
    process.stderr.write(`${JSON.stringify({ type: "workspace.operation_failed", operationId: operation?.id, error: error.message })}\n`);
  } finally { workspaceOperationRunning = false; }
}
setInterval(() => void processWorkspaceOperation(), workspaceOperationPollMs).unref();

// The durable `prepare_publish` boundary (WP-7). An approval, or an operator
// before a manual push, asks for a preparation; this recomputes the four
// digests from the workspace, as its current owner and in its turn so no
// ownership change lands in the middle, and hands them to prepare_publish,
// which refuses a tree or patch that has moved. A refusal is an exception, and
// rolls back whatever its transaction wrote — so it is recorded in a second
// call with the reason it carried, where it stays. The push and the pull
// request are the operator's, from the prepared row's head commit (plan §5).
async function recordPublishRefusal(claim, reason, message) {
  return await queryJson(
    `SELECT record_publish_refusal(:'id'::uuid, :'worker_id', :'reason', :'message')::text;`,
    { id: claim.id, worker_id: supervisorId, reason, message: String(message ?? "").slice(0, 1000) },
  );
}

let publishPreparationRunning = false;
async function processPublishPreparation() {
  if (publishPreparationRunning) return;
  publishPreparationRunning = true;
  let claim = null;
  try {
    claim = await queryJson(`SELECT claim_publish_preparation(:'worker_id')::text;`, { worker_id: supervisorId });
    if (!claim) return;
    let observed;
    try {
      const located = inspectPlan(
        { operation_type: "inspect_workspace", project_id: claim.project_id, workspace_path: claim.workspace_path },
        { canonicalRoot: canonicalWorkspaceRoot },
      );
      if (!(await assertWorkspaceOnDisk(located.workspace))) throw new Error("the workspace is not on disk");
      observed = await inWorkspaceTurn(located.workspace, async () => {
        const owner = inspectOwner((await stat(located.workspace)).uid, runtimeUid);
        const seen = observationOf(await reviewEvidenceAs(owner, located.workspace, claim.base_commit_sha));
        // 0150: the workspace moved on past the approved commit (the next
        // task committed on top of it). Whether it still holds that commit is
        // git's to say, as the workspace's owner; the database decides.
        const approved = String(claim.head_commit_sha ?? "");
        if (/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(approved) && seen.head_commit_sha !== approved) {
          const present = await gitAs(owner, located.workspace)(
            ["-c", "core.fsmonitor=false", "merge-base", "--is-ancestor", approved, "HEAD"]);
          return { ...seen, approved_commit_sha: approved, approved_commit_present: present.code === 0 };
        }
        return seen;
      });
    } catch (error) {
      const refused = await recordPublishRefusal(claim, "publish_observation_failed", error.message);
      process.stderr.write(`${JSON.stringify({ type: "publish.refused", preparation_id: claim.id, ...refused })}\n`);
      return;
    }
    try {
      const prepared = await queryJson(
        `SELECT prepare_publish(:'id'::uuid, :'worker_id', :'observed'::jsonb)::text;`,
        { id: claim.id, worker_id: supervisorId, observed: JSON.stringify(observed) },
      );
      process.stderr.write(`${JSON.stringify({ type: "publish.prepared", preparation_id: claim.id,
        head_commit_sha: prepared?.head_commit_sha, evidence_digest: prepared?.evidence_digest })}\n`);
    } catch (error) {
      // Only a refusal with a reason is recorded as one. Anything else — the
      // database going away — leaves the claim to expire and be taken again.
      const reason = failureReason(error);
      if (!reason) throw error;
      await recordPublishRefusal(claim, reason, error.message);
      process.stderr.write(`${JSON.stringify({ type: "publish.refused", preparation_id: claim.id, reason,
        error: error.message })}\n`);
    }
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ type: "publish.preparation_failed", preparation_id: claim?.id ?? null,
      error: error.message })}\n`);
  } finally { publishPreparationRunning = false; }
}
setInterval(() => void processPublishPreparation(), workspaceOperationPollMs).unref();

// `readOnlyWritable`, when given, starts the command under a Landlock ruleset
// that leaves only those paths writable (read-only-launch.mjs, 11.2 N4); the
// command is still the runtime's own executable, run by the launcher.
function cleanRuntimeArgs(user, workspace, command, args, extraEnvironment = [], { readOnlyWritable = null, home: homeOverride = null } = {}) {
  // An explicit map. The previous default sent every user that was not
  // codex-worker to the sandboxed worker's home, so anything else would read a
  // git config it does not own. A qualification names its scratch home instead.
  const home = homeOverride ?? homeFor(user);
  const launch = readOnlyWritable ? readOnlyLaunchArgv(readOnlyWritable, command, args) : [command, ...args];
  return [
    "-u", user, "--", "/usr/bin/env", "-i",
    `HOME=${home}`, `PATH=${runtimePath}`, `PWD=${workspace}`,
    "LANG=C.UTF-8", ...extraEnvironment, ...launch,
  ];
}

// Runs a channel-opening body that will hand its admission place to a close
// handler on success. Any failure before that hand-over gives the place back.
// Registers a request for cancellation before any of its work begins, and
// unregisters it however it ends.
async function withInFlight(request, socket, describe, body) {
  const control = new LaunchControl();
  const forget = registerInFlight(request.request_id, socket, {
    stop: () => control.requestStop(),
    describe,
  });
  try {
    return await body(control);
  } finally {
    forget();
  }
}

async function releasingOnFailure(place, body) {
  try {
    return await body();
  } catch (error) {
    place.release();
    throw error;
  }
}

async function assertGateWorkspace(gateWorkspace) {
  if (typeof gateWorkspace !== "string" || gateWorkspace.length < 2 || gateWorkspace.length > 1024) {
    throw new Error("gate workspace is invalid");
  }
  let canonical;
  try {
    canonical = await realpath(gateWorkspace);
  } catch (error) {
    throw new Error(`gate workspace does not exist: ${error.code ?? error.message}`);
  }
  if (
    canonical !== canonicalGateWorkspaceRoot &&
    !canonical.startsWith(`${canonicalGateWorkspaceRoot}${path.sep}`)
  ) {
    throw new Error("gate workspace escapes the configured gate root");
  }
  if (canonical === canonicalGateWorkspaceRoot) {
    throw new Error("gate workspace must not be the gate root itself");
  }
  return canonical;
}

// Opens a runtime as a channel: a process whose stdin and stdout the client
// drives through this supervisor, one surface of one driver (WP-5b).
//
// This was three functions — a project's read-only Codex, the account, the
// gate — that differed only in where the workspace came from and what was let
// through on stdin. The driver says both: its surface names the workspace kind
// and, for a project, the grant mode; its `input` says what each surface's
// stdin may carry. What stays here is what the supervisor alone can do: admit,
// resolve the grant, change the owner, spawn as the runtime's user.
// A run no task waits for: a model check (the gate surface) or anything a
// qualification starts. Admitted only with room left for a task run after it.
function isBackgroundRun(request, surface) {
  return surface === "gate" || Boolean(request?.qualification);
}

async function openChannel(socket, request, driver, surface, control = new LaunchControl()) {
  const spec = surfaceOf(driver, surface);
  if (spec.transport !== "channel") throw new Error(`${driver.name}'s ${surface} surface is not a channel`);
  assertCapability(driver, spec.capability);
  const adapter = adapterFor(driver.name);
  // Admission before anything is spawned, owned or reserved: a paused
  // runtime is one whose tree is being replaced at this moment.
  //
  // The place is held until the channel closes, so *every* way out before the
  // close handler is attached has to give it back. Releasing only on success
  // left a failed preparation counted as a live launch for the life of the
  // supervisor — and an installer waiting for that count to reach zero would
  // have waited forever.
  const place = await takeLaunchPlace(driver.name, { background: isBackgroundRun(request, surface) });
  return await releasingOnFailure(place, async () => {
  control.assertNotCancelled();
  const channelId = randomUUID();
  // The channel's cgroup, made before the spawn and removed when the process
  // closes. A Codex app-server runs the model's commands as children of its
  // own; a stop reaches them through the leaf, not the process tree.
  const leaf = await isolation.create(`channel-${channelId}`, runMemoryLimit(driver));
  // A qualification (Stage 12 W3) runs the candidate's executable in its
  // scratch home; everything else about the launch is the surface's own.
  const candidate = request.qualification ? qualificationLaunch(driver, request.qualification) : null;
  if (candidate && !["gate", "account", "project"].includes(surface)) throw new Error(`a qualification does not open the ${surface} surface`);
  // The version this launch runs decides its overrides (Codex's sandbox flag).
  const launchVersion = candidate ? request.qualification.version : activeVersionOf(driver.name);
  const launch = (account, workspace) => isolation.launch(
    leaf, "/usr/sbin/runuser",
    cleanRuntimeArgs(account, workspace, candidate?.executable ?? driver.executable, driver.run.argv({ surface, version: launchVersion }),
      driver.run.environment({ surface }), { home: candidate?.home ?? null }),
    { cwd: workspace, stdio: ["pipe", "pipe", "pipe"] },
  );
  let workspace;
  let child;
  let projectId = null;
  let onClose = () => {};
  try {
  if (spec.workspace === "grant" && candidate) {
    // A candidate's turn (Stage 12 W3c): the orchestrator's own channel — its
    // stdin rules, dynamic tools and read-only thread — in the qualification's
    // scratch repository, which no grant covers because no project owns it.
    workspace = candidate.workspace;
    child = launch(adapter.user, workspace);
  } else if (spec.workspace === "grant") {
    const project = await getProject(request.project_id);
    workspace = project.workspace;
    projectId = project.id;
    // The grant is resolved in this workspace's turn, immediately before the
    // ownership change and the spawn it justifies — the last moment at which
    // finding out costs nothing. A request that says "open a runtime for
    // project X" is not enough: before WP-3c this chowned the tree away from an
    // implementation that was writing in it (A1). A refusal carries its reason
    // as the error code; grant_writer_active is retryable and the worker defers.
    child = await inWorkspaceTurn(workspace, async () => {
      const grant = await resolveWorkspaceGrant({
        token: request.grant_token,
        projectId: request.project_id,
        expect: { runtimeType: driver.name, mode: spec.grantMode },
      }, queryJson);
      control.assertNotCancelled();
      // Still a chown for a read_only grant: the runtime accounts cannot read a
      // tree they do not own (agent-workspace holds neither). The grant has
      // just established that no writer holds the workspace, and the turn keeps
      // a writer's launch from chowning in between.
      transferOwnership(workspace, grant.account);
      return launch(grant.account, workspace);
    });
  } else if (spec.workspace === "home" && candidate) {
    // The candidate's account channel lives in its scratch home: model/list.
    workspace = candidate.home;
    child = launch(adapter.user, workspace);
  } else if (spec.workspace === "home") {
    workspace = adapter.home;
    child = launch(adapter.user, workspace);
  } else if (spec.workspace === "gate" && candidate) {
    // The qualification's own scratch repository, already the runtime's; it is
    // removed with the scratch home by qualification_cleanup.
    workspace = candidate.workspace;
    child = launch(adapter.user, workspace);
  } else if (spec.workspace === "gate") {
    workspace = await assertGateWorkspace(request.gate_workspace);
    transferOwnership(workspace, adapter.user);
    // The scratch workspace is fixed at open time — cwd is pinned by the
    // process, not by any message — and goes back to the gate worker after.
    onClose = () => { try { transferOwnership(workspace, "infra-control"); } catch {} };
    child = launch(adapter.user, workspace);
  } else {
    throw new Error(`${driver.name}'s ${surface} surface names no workspace this supervisor resolves`);
  }
  } catch (error) {
    // Nothing was spawned into it, or the spawn itself failed: the leaf goes.
    await isolation.release(leaf).catch(() => {});
    throw error;
  }
  control.bind(async () => { await isolation.stop(leaf, { child }); });
  // A surface may carry protocol state — the gate's bound thread and turn ids —
  // so a client cannot drift to another thread or workspace.
  const state = driver.input.channelState(surface, { workspace });
  const channel = { child, leaf, socket, driver, surface, state, projectId };
  channels.set(channelId, channel);
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  send(socket, {
    request_id: request.request_id,
    ok: true,
    result: {
      channel_id: channelId, pid: child.pid, ...(spec.workspace === "home" ? {} : { workspace }),
      capability_verification: verificationOf(driver),
    },
  });
  child.stdout.on("data", (data) => send(socket, { type: "stdout", channel_id: channelId, data }));
  child.stderr.on("data", (data) => send(socket, { type: "stderr", channel_id: channelId, data }));
  if (driver.input.observes(surface)) {
    let lineBuffer = "";
    child.stdout.on("data", (data) => {
      lineBuffer += data;
      const lines = lineBuffer.split("\n");
      lineBuffer = lines.pop() ?? "";
      for (const line of lines) {
        const parsed = driver.stream.parse(line);
        if (!parsed) continue;
        try { driver.input.observe(surface, state, parsed.raw); } catch {}
      }
    });
  }
  child.once("close", (exitCode, signal) => {
    channels.delete(channelId);
    // The channel was the launch; it is no longer in flight.
    place.release();
    onClose();
    // Whatever the runtime left running is killed with the leaf; the client
    // is told the channel closed once nothing of it remains.
    isolation.release(leaf).catch((error) => {
      process.stderr.write(`${JSON.stringify({ type: "run_cgroup.release_failed", cgroup: leaf.name, error: error.message })}\n`);
    }).finally(() => {
      send(socket, { type: "channel_closed", channel_id: channelId, exit_code: exitCode, signal });
    });
  });
  // The close handler owns the ticket from here.
  return { channelId, released: true };
  });
}

// An analyst's run (0147): read-only, on a snapshot of the workspace's last
// commit, never the live tree — so it can run while the coder writes. The
// snapshot is written in the workspace's turn as its owner (snapshot.mjs), into
// a scratch directory under the gate root that is handed to the analyst's
// runtime user and removed after. The run is held read-only by the kernel as an
// orchestrator's turn is, calls no tool of the platform's, and its answer is
// its final message. The job and its lease are the worker's, checked here.
const CONSULT_TIMEOUT_MS = 15 * 60_000;
async function runConsultBatch(request, driver, control = new LaunchControl()) {
  const spec = surfaceOf(driver, "consult");
  if (spec.transport !== "batch" || spec.workspace !== "snapshot") throw new Error(`${driver.name}'s consult surface is not a snapshot batch run`);
  assertCapability(driver, spec.capability);
  if (typeof request.worker_id !== "string" || !request.worker_id) throw new Error("a consultation names the worker that leases it");
  if (typeof request.prompt !== "string" || request.prompt.length === 0 || request.prompt.length > 64 * 1024) {
    throw new Error("consultation prompt length is invalid");
  }
  const context = await queryJson(`SELECT consultation_job_context(:'job_id'::bigint, :'worker_id')::text;`,
    { job_id: request.job_id, worker_id: request.worker_id });
  if (context.runtime_type !== driver.name) throw new Error(`consultation ${context.consultation_id} is ${context.runtime_type}'s, not ${driver.name}'s`);
  const workspace = path.join(canonicalWorkspaceRoot, String(context.project_id));
  if (path.resolve(String(context.workspace_path ?? "")) !== workspace) throw new Error("consultation workspace path does not match the project allocation");
  if (!(await assertWorkspaceOnDisk(workspace))) throw new Error("the workspace is not on disk");
  const account = adapterFor(driver.name).user;
  const snapshotDir = path.join(canonicalGateWorkspaceRoot, `consult-${randomUUID()}`);
  await mkdir(snapshotDir, { mode: 0o700 });
  let leaf = null;
  let child = null;
  let stdout = "";
  let stderr = "";
  let outputExceeded = false;
  let interrupted = false;
  let timedOut = false;
  let resolvedModel = null;
  let activity = Promise.resolve();
  const appendActivity = (event) => queryJson(`SELECT append_runtime_activity_event(:'job_id'::bigint,:'worker_id',:'runtime_type',
    :'event_type',:'phase',:'summary',:'details'::jsonb)::text;`, {
    job_id: request.job_id, worker_id: request.worker_id, runtime_type: driver.name, event_type: event.eventType,
    phase: event.phase, summary: event.summary, details: JSON.stringify(event.details ?? {}),
  });
  try {
    const snapshot = await inWorkspaceTurn(workspace, async () => {
      const owner = inspectOwner((await stat(workspace)).uid, runtimeUid);
      return await buildSnapshot({ runGit: gitAs(owner, workspace), directory: snapshotDir });
    });
    if (!snapshot.head) throw new Error("the workspace has no commit to read");
    transferOwnership(snapshotDir, account);
    control.assertNotCancelled();
    const args = cleanRuntimeArgs(account, snapshotDir, driver.executable, driver.run.argv({
      model: driver.run.qualifyModel(context.provider_id ?? null, context.model),
      prompt: request.prompt, surface: "consult", reasoningEffort: context.reasoning_effort ?? null,
      subagents: context.allow_subagents === true,
    }), driver.run.environment({ surface: "consult", subagents: context.allow_subagents === true }),
    { readOnlyWritable: driver.run.readOnlyWritable });
    leaf = await isolation.create(`consult-${randomUUID()}`, runMemoryLimit(driver));
    child = isolation.launch(leaf, "/usr/sbin/runuser", args, { cwd: snapshotDir, stdio: ["ignore", "pipe", "pipe"] });
    const memory = watchMemory(leaf);
    const terminate = (signal = "SIGTERM") => { isolation.signal(leaf, signal).catch(() => {}); };
    control.bind(async () => { interrupted = true; await isolation.stop(leaf, { child }); });
    const timer = setTimeout(() => { timedOut = true; terminate(); }, CONSULT_TIMEOUT_MS);
    const collect = (target, chunk) => {
      const next = target + chunk;
      if (Buffer.byteLength(next) > 4 * 1024 * 1024) { outputExceeded = true; terminate(); }
      return next;
    };
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    let lineBuffer = "";
    child.stdout.on("data", (chunk) => {
      stdout = collect(stdout, chunk);
      lineBuffer += chunk;
      const lines = lineBuffer.split("\n");
      lineBuffer = lines.pop() ?? "";
      for (const line of lines) {
        const parsed = driver.stream.parse(line);
        if (!parsed) continue;
        resolvedModel ??= driver.stream.resolvedModel?.(parsed.raw) ?? null;
        // 0151: the analyst's activity under its job, as a turn's is: the
        // usage trigger counts its tokens from it.
        if (parsed.event) activity = activity.then(() => appendActivity(parsed.event)).catch(() => {});
      }
    });
    child.stderr.on("data", (chunk) => (stderr = collect(stderr, chunk)));
    const { exitCode, signal } = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (exitCode, signal) => resolve({ exitCode, signal }));
    });
    clearTimeout(timer);
    await memory?.stop().catch(() => null);
    await activity;
    if (exitCode === READ_ONLY_LAUNCH_EXIT) throw new Error(`the read-only launch was refused: ${stderr.trim().split("\n").at(-1) ?? ""}`);
    if (outputExceeded) throw new Error("the analyst's output exceeded 4 MiB");
    if (timedOut) throw new Error(`the analyst ran past ${CONSULT_TIMEOUT_MS / 60_000} minutes and was ended`);
    return {
      exit_code: exitCode, signal, interrupted, response: driver.stream.answer(stdout),
      failure: driver.stream.failure?.(stdout) ?? "", stderr: stderr.slice(-2000),
      resolved_model: resolvedModel, snapshot_sha: snapshot.head, snapshot_skipped: snapshot.skipped.length,
    };
  } finally {
    if (leaf) {
      if (child) await isolation.stop(leaf, { child }).catch(() => {});
      await isolation.release(leaf).catch((error) => {
        process.stderr.write(`${JSON.stringify({ type: "run_cgroup.release_failed", cgroup: leaf.name, error: error.message })}\n`);
      });
    }
    await rm(snapshotDir, { recursive: true, force: true }).catch(() => {});
  }
}

// A batch run of a driver in a scratch gate workspace: the capability gate's
// smoke test. The driver builds the command and reads the stream; this owns the
// workspace, the process and the bounds.
async function runGateBatch(request, driver, control = new LaunchControl()) {
  const spec = surfaceOf(driver, "gate");
  if (spec.transport !== "batch") throw new Error(`${driver.name}'s gate surface is not a batch run`);
  assertCapability(driver, spec.capability);
  const account = adapterFor(driver.name).user;
  if (typeof request.model !== "string" || request.model.length < 2 || request.model.length > 200) {
    throw new Error("gate model is invalid");
  }
  if (typeof request.prompt !== "string" || request.prompt.length === 0 || request.prompt.length > 16 * 1024) {
    throw new Error("gate prompt length is invalid");
  }
  const workspace = await assertGateWorkspace(request.gate_workspace);
  transferOwnership(workspace, account);
  const args = cleanRuntimeArgs(
    account, workspace, driver.executable,
    driver.run.argv({ model: request.model, sessionId: request.native_session_id ?? null, prompt: request.prompt, surface: "gate" }),
    driver.run.environment(),
  );
  let stdout = "";
  let stderr = "";
  let outputExceeded = false;
  let interrupted = false;
  let observedNativeSessionId = request.native_session_id ?? null;
  // The other half of the early cancel. Remembering the request is only useful
  // if the work asks before starting.
  control.assertNotCancelled();
  const leaf = await isolation.create(`gate-${randomUUID()}`, runMemoryLimit(driver));
  const child = isolation.launch(leaf, "/usr/sbin/runuser", args, {
    cwd: workspace,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const memory = watchMemory(leaf);
  const terminate = (signal = "SIGTERM") => { isolation.signal(leaf, signal).catch(() => {}); };
  // The means of stopping this, handed to whoever registered the request. The
  // cgroup is signalled, then killed outright if it is still there — a cancel
  // that politely asks and gives up is not a cancel.
  control.bind(async () => {
    interrupted = true;
    await isolation.stop(leaf, { child });
  });
  try {
    const hardTimeout = 5 * 60_000;
    const interruptAfter = Number.isInteger(request.interrupt_after_ms)
      && request.interrupt_after_ms > 0
      && request.interrupt_after_ms < hardTimeout
      ? request.interrupt_after_ms
      : null;
    let forcedInterrupt = false;
    const timeout = setTimeout(() => { interrupted = true; terminate(); }, hardTimeout);
    const interruptTimer = interruptAfter === null
      ? null
      : setTimeout(() => { interrupted = true; forcedInterrupt = true; terminate(); }, interruptAfter);
    const collect = (target, chunk) => {
      const next = target + chunk;
      if (Buffer.byteLength(next) > 4 * 1024 * 1024) {
        outputExceeded = true;
        terminate();
      }
      return next;
    };
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    let lineBuffer = "";
    child.stdout.on("data", (chunk) => {
      stdout = collect(stdout, chunk);
      lineBuffer += chunk;
      const lines = lineBuffer.split("\n");
      lineBuffer = lines.pop() ?? "";
      for (const line of lines) {
        const parsed = driver.stream.parse(line);
        if (parsed) observedNativeSessionId ??= driver.sessions.idFromEvent(parsed.raw);
      }
    });
    child.stderr.on("data", (chunk) => (stderr = collect(stderr, chunk)));
    const { exitCode, signal } = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (exitCode, signal) => resolve({ exitCode, signal }));
    });
    clearTimeout(timeout);
    if (interruptTimer) clearTimeout(interruptTimer);
    if (outputExceeded) throw new Error("gate runtime output exceeded 4 MiB");
    return {
      memory: await memory?.stop() ?? null,
      exit_code: exitCode,
      signal,
      interrupted,
      forced_interrupt: forcedInterrupt,
      native_session_id: observedNativeSessionId,
      stdout,
      stderr,
      pid: child.pid,
    };
  } finally {
    await memory?.stop().catch(() => {});
    await isolation.release(leaf).catch(() => {});
    transferOwnership(workspace, "infra-control");
  }
}

// WP-B: one deprovision per project, a deadline, and a cancel that reaches it.
const deprovisionOnce = createProjectSingleFlight();
const deprovisionDeadlineMs = Number(process.env.DEPROVISION_DEADLINE_MS ?? 15 * 60_000);

async function deprovisionProject(request, control = new LaunchControl()) {
  const bound = createDeprovisionDeadline({ control, ms: deprovisionDeadlineMs });
  if (typeof request.worker_id !== "string" || request.worker_id.length < 2) {
    throw new Error("deprovision worker id is invalid");
  }
  const context = await queryJson(
    `SELECT jsonb_build_object(
      'project_id',p.id,'status',p.status,'workspace_path',p.workspace_path,
      'credential_mode',p.credential_mode,'cleanup_leased_by',p.cleanup_leased_by,
      'cleanup_leased_until',p.cleanup_leased_until,
      'active_jobs',(SELECT count(*) FROM runtime_jobs j
        WHERE j.project_id=p.id AND j.status IN ('pending','in_flight')),
      'live_runs',(SELECT COALESCE(jsonb_agg(jsonb_build_object(
          'run_id',r.id,'process_ref',r.process_ref,'job_id',j.id,'status',r.status))
        FILTER (WHERE r.process_ref IS NOT NULL),'[]'::jsonb)
        FROM task_runs r JOIN tasks t ON t.id=r.task_id
        LEFT JOIN runtime_jobs j ON j.run_id=r.id AND j.status IN ('pending','in_flight')
        WHERE t.project_id=p.id
          AND r.status IN ('starting','running','blocked','interrupted','waiting_for_input'))
    )::text
    FROM projects p WHERE p.id = :'project_id'::uuid;`,
    { project_id: request.project_id },
  );
  if (!context || context.project_id !== request.project_id) throw new Error("project is unavailable");
  if (context.status !== "deleting") throw new Error("project is not in the deleting state");
  if (context.cleanup_leased_by !== request.worker_id
      || new Date(context.cleanup_leased_until) <= new Date()) {
    throw new Error("project cleanup lease is not owned by this worker");
  }

  // Worker-first stop, in strict phases. Deprovisioning must never proceed
  // while a writer process is alive, and the Supervisor must not preempt the
  // workers' native interrupt path:
  //   1. request native interrupts for every active job;
  //   2. wait a bounded grace period for worker receipts (jobs reach a
  //      terminal state through the normal interrupt finalization);
  //   3. only then apply one SIGTERM pass to still-alive process groups;
  //   4. after a separate timeout, SIGKILL escalation.
  const receipts = [];
  const graceMs = Number(process.env.DEPROVISION_INTERRUPT_GRACE_MS ?? 60_000);
  const sigtermWaitMs = Number(process.env.DEPROVISION_SIGTERM_WAIT_MS ?? 30_000);
  const interruptGraceDeadline = Date.now() + graceMs;

  const activeJobs = async () => {
    const pending = await queryJsonRows(
      `SELECT jsonb_build_object(
         'job_id',j.id,'task_id',j.task_id,'job_type',j.job_type,
         'run_id',j.run_id,'process_ref',r.process_ref,
         'interrupt_requested_at',j.interrupt_requested_at
       )::text
       FROM runtime_jobs j
       LEFT JOIN task_runs r ON r.id=j.run_id
       WHERE j.project_id=:'project_id'::uuid AND j.status IN ('pending','in_flight')
       ORDER BY j.id LIMIT 20;`,
      { project_id: request.project_id },
    );
    return Array.isArray(pending) ? pending : [];
  };

  // Phase 1: request native interrupts once per job.
  for (const job of await activeJobs()) {
    if (job.interrupt_requested_at) continue;
    try {
      await queryJson(
        `SELECT request_runtime_interrupt(
          :'project_id'::uuid, :'task_id'::uuid, :'worker_id', :'reason', :'correlation'
        )::text;`,
        {
          project_id: request.project_id,
          task_id: job.task_id,
          worker_id: request.worker_id,
          reason: "project deletion cleanup",
          correlation: `deletion:${request.project_id}`,
        },
      );
    } catch {}
  }

  // Phase 2: wait for worker receipts (bounded grace). No signals here.
  while (Date.now() < interruptGraceDeadline && (await activeJobs()).length) {
    bound.check("the interrupt grace period");
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  // Phase 3: one SIGTERM pass for anything still alive.
  const sigtermDeadline = Date.now() + sigtermWaitMs;
  for (const job of await activeJobs()) {
    const ref = parseProcessRef(job.process_ref);
    if (!ref || !await processAlive(job.process_ref)) continue;
    await signalProcessRef(job.process_ref, "SIGTERM");
    receipts.push({ run_id: job.run_id, pid: ref.pid, cgroup: ref.cgroup, action: "sigterm_fallback" });
  }

  // Phase 4: wait again, then SIGKILL escalation for stragglers.
  while (Date.now() < sigtermDeadline && (await activeJobs()).length) {
    bound.check("the SIGTERM wait");
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  for (const job of await activeJobs()) {
    const ref = parseProcessRef(job.process_ref);
    if (!ref || !await processAlive(job.process_ref)) continue;
    await signalProcessRef(job.process_ref, "SIGKILL");
    receipts.push({ run_id: job.run_id, pid: ref.pid, cgroup: ref.cgroup, action: "sigkill_escalation" });
  }

  // Phase 5: reap wait, then a FRESH writer scan from the database. The
  // original context.live_runs snapshot predates the grace/signal phases: a
  // run that had process_ref=NULL can acquire a PID mid-stop and vanish from
  // activeJobs() (job terminal) while its process is still alive. Only a new
  // scan of EVERY task_run process ref for the project — any run status (a
  // terminal/stale run may still hold a live process), no LIMIT (the 21st
  // writer must be seen too) — after the signals and a short reap window may
  // authorize filesystem removal. Unknown process-ref formats fail closed.
  // Live launch reservations (admission in progress before spawn/PID) are
  // also treated as active writers.
  const reapWaitMs = Number(process.env.DEPROVISION_REAP_WAIT_MS ?? 3000);
  await new Promise((resolve) => setTimeout(resolve, reapWaitMs));

  const scanLiveRuns = async () => await queryJsonRows(
    `SELECT jsonb_build_object('run_id',r.id,'process_ref',r.process_ref)::text
     FROM task_runs r
     JOIN tasks t ON t.id=r.task_id
     WHERE t.project_id=:'project_id'::uuid
       AND r.process_ref IS NOT NULL
     ORDER BY r.created_at DESC;`,
    { project_id: request.project_id },
  );

  // A live reservation always blocks cleanup. An expired reservation may be
  // reconciled automatically only when it already carries a concrete PID:
  // terminate/reap that process first, then cancel the exact token. An
  // expired reservation without a PID can come from a Supervisor crash in
  // the reserve→spawn/bind window, so absence cannot be proved automatically
  // and cleanup fails closed for operator reconciliation.
  const reservedLaunches = async () => await queryJsonRows(
    `SELECT jsonb_build_object(
       'run_id',res.run_id,'job_id',res.job_id,'token',res.token,
       'supervisor_id',res.supervisor_id,'process_ref',res.process_ref,
       'expired',res.expires_at<=clock_timestamp()
     )::text
     FROM runtime_launch_reservations res
     WHERE res.project_id=:'project_id'::uuid AND res.state='reserved'
     ORDER BY res.created_at;`,
    { project_id: request.project_id },
  );
  const stopReservationProcess = async (reservationRow) => {
    const ref = parseProcessRef(reservationRow.process_ref);
    if (!ref) throw new Error("expired runtime launch reservation has no recognized process identity");
    const pid = ref.pid;
    if (await processAlive(reservationRow.process_ref)) {
      await signalProcessRef(reservationRow.process_ref, "SIGTERM");
      await new Promise((resolve) => setTimeout(resolve, reapWaitMs));
    }
    if (await processAlive(reservationRow.process_ref)) {
      await signalProcessRef(reservationRow.process_ref, "SIGKILL");
      await new Promise((resolve) => setTimeout(resolve, reapWaitMs));
    }
    if (await processAlive(reservationRow.process_ref)) throw new Error(`expired runtime launch process ${pid} is still alive`);
    const cancelled = await queryJson(
      `SELECT cancel_runtime_launch(
        :'run_id'::uuid, :'job_id'::bigint, :'supervisor_id', :'token', true
      )::text;`,
      {
        run_id: reservationRow.run_id,
        job_id: reservationRow.job_id,
        supervisor_id: supervisorId,
        token: reservationRow.token,
      },
    );
    if (cancelled?.status !== "cancelled") {
      throw new Error("expired runtime launch reservation changed during reconciliation");
    }
    receipts.push({ run_id: reservationRow.run_id, pid, action: "expired_launch_reaped" });
  };
  const reconcileLaunchReservations = async () => {
    const reservations = await reservedLaunches();
    const live = reservations.filter((row) => !row.expired);
    if (live.length) throw new Error(`runtime launch is being admitted for ${live.length} run(s)`);
    for (const row of reservations.filter((item) => item.expired)) {
      if (!row.process_ref) {
        throw new Error("expired runtime launch reservation requires operator reconciliation");
      }
      await stopReservationProcess(row);
    }
    const remaining = await reservedLaunches();
    if (remaining.length) throw new Error(`runtime launch reservation remains for ${remaining.length} run(s)`);
  };

  // A system workspace operation holds no database lock once its claim commits,
  // so cleanup has to treat one as a live writer in its own right: otherwise it
  // can remove a directory that provisioning is recreating. Fail closed, the
  // same as an unresolvable launch reservation.
  const activeWorkspaceOperations = async () => await queryJsonRows(
    `SELECT active_workspace_operations(:'project_id'::uuid)::text;`,
    { project_id: request.project_id },
  );
  const operations = await activeWorkspaceOperations();
  if (operations.length) {
    const stale = operations.filter((row) => row.stale);
    if (stale.length) {
      // A claim older than the supervisor's own reclaim window is not ordinary
      // busyness: something is stuck, and an operator should look.
      throw new Error(
        `workspace operation ${stale[0].operation_id} has been running since ${stale[0].started_at}`
        + " and requires operator reconciliation",
      );
    }
    // Ordinary busyness. Inspection runs every twenty seconds per project, so
    // colliding with cleanup is expected and must not end the deletion.
    const busy = new Error(
      `${operations.length} workspace operation(s) are still running for this project`);
    busy.retryable = true;
    throw busy;
  }

  await reconcileLaunchReservations();
  const scanWriters = async () => scanLiveRuns();
  const liveRuns = await scanWriters();
  // Second pass after a bounded wait: a process that is mid-reap may still
  // answer kill(pid, 0) for a moment, so re-probe the same set once more.
  let anyLive = false;
  for (const run of liveRuns) anyLive = anyLive || await processAlive(run.process_ref);
  if (anyLive) {
    await new Promise((resolve) => setTimeout(resolve, reapWaitMs));
    await assertNoLiveWriters(await scanWriters(), { cgroupAlive: isolation.alive });
  }
  // Re-scan once more to cover any writer registered between the two probes.
  await assertNoLiveWriters(await scanWriters(), { cgroupAlive: isolation.alive });
  // And once more for workspace operations, which can be claimed at any time.
  const lateOperations = await activeWorkspaceOperations();
  if (lateOperations.length) {
    const late = new Error(
      `a workspace operation started while cleanup was preparing (${lateOperations[0].operation_type})`);
    late.retryable = true;
    throw late;
  }

  // Close any live channel bound to this project — a read-only orchestrator
  // turn, whichever runtime plays it: those processes hold the workspace as cwd
  // and are writers from the filesystem perspective even though they are not in
  // task_runs.process_ref. Only a grant surface binds a channel to a project.
  for (const [channelId, channel] of channels) {
    if (channel.projectId === request.project_id) {
      isolation.signal(channel.leaf, "SIGTERM").catch(() => {});
      channels.delete(channelId);
      receipts.push({ channel_id: channelId, action: `${channel.driver.name}_channel_closed` });
    }
  }

  // Containment: canonical workspace must sit directly under the workspace
  // root at <root>/<project_id>. A partially removed workspace is fine — the
  // removal is idempotent and absence is re-verified afterwards. Only ENOENT
  // proves absence; EACCES, EIO and any other error aborts cleanup fail-closed.
  const storedWorkspace = String(context.workspace_path ?? "");
  if (storedWorkspace.length === 0) throw new Error("project workspace path is empty");
  let workspace = null;
  try {
    workspace = await realpath(storedWorkspace);
  } catch (error) {
    if (error?.code !== "ENOENT") throw new Error(`workspace path check failed: ${error.code ?? error.message}`);
  }
  if (workspace === null) {
    // Already gone (or never existed) — nothing to remove.
  } else {
    if (workspace !== canonicalWorkspaceRoot && !workspace.startsWith(`${canonicalWorkspaceRoot}${path.sep}`)) {
      throw new Error("workspace path escapes the configured root");
    }
    if (workspace === canonicalWorkspaceRoot) {
      throw new Error("workspace path resolves to the workspace root");
    }
    if (workspace !== path.join(canonicalWorkspaceRoot, request.project_id)
        && !workspace.startsWith(`${path.join(canonicalWorkspaceRoot, request.project_id)}${path.sep}`)) {
      throw new Error("workspace path does not match the project id boundary");
    }
    bound.check(`removing ${workspace}`);
    await rm(workspace, { recursive: true, force: true });
  }
  let workspaceGone;
  try {
    await realpath(storedWorkspace);
    workspaceGone = false;
  } catch (error) {
    if (error?.code === "ENOENT") workspaceGone = true;
    else throw new Error(`workspace absence check failed: ${error.code ?? error.message}`);
  }

  let keysRemoved = 0;
  if (context.credential_mode === "deploy_key") {
    let entries;
    try {
      entries = await readdir(deployKeyRoot);
    } catch (error) {
      if (error?.code === "ENOENT") entries = [];
      else throw new Error(`deploy key root check failed: ${error.code ?? error.message}`);
    }
    const canonicalKeyRoot = await realpath(deployKeyRoot);
    for (const name of entries) {
      if (name !== request.project_id && !name.startsWith(`${request.project_id}.`)) continue;
      const target = path.join(deployKeyRoot, name);
      let canonical = null;
      try {
        canonical = await realpath(target);
      } catch (error) {
        if (error?.code !== "ENOENT") throw new Error(`deploy key check failed: ${error.code ?? error.message}`);
      }
      if (canonical === null) continue;
      if (canonical === canonicalKeyRoot || !canonical.startsWith(`${canonicalKeyRoot}${path.sep}`)) {
        throw new Error("deploy key path escapes the configured root");
      }
      bound.check(`removing ${canonical}`);
      await rm(canonical, { recursive: true, force: true });
      keysRemoved += 1;
    }
  }
  let keysGone = true;
  if (context.credential_mode === "deploy_key") {
    let remaining;
    try {
      remaining = await readdir(deployKeyRoot);
    } catch (error) {
      if (error?.code === "ENOENT") remaining = [];
      else throw new Error(`deploy key absence check failed: ${error.code ?? error.message}`);
    }
    keysGone = remaining.filter((name) =>
      name === request.project_id || name.startsWith(`${request.project_id}.`)).length === 0;
  }

  if (!workspaceGone || !keysGone) {
    throw new Error("workspace or key material is still present after cleanup");
  }
  return {
    project_id: request.project_id,
    receipts,
    workspace_removed: workspaceGone,
    keys_removed: keysRemoved,
  };
}

// The account surface of a runtime whose account is managed through a
// short-lived loopback server (a driver's `local_server` transport): OpenCode's,
// whose CLI login does not take a key from stdin. The runtime's user, home and
// executable come from its descriptor.
function localServerUserArgs(adapter, commandArgs, extraEnvironment = [], { home = adapter.home, executable = adapter.executable } = {}) {
  return [
    "-u", adapter.user, "--", "/usr/bin/env", "-i",
    `HOME=${home}`, `XDG_DATA_HOME=${home}/.local/share`,
    `XDG_CACHE_HOME=${home}/.local/cache`,
    `PATH=${runtimePath}`, "LANG=C.UTF-8", ...extraEnvironment,
    executable, ...commandArgs,
  ];
}

async function availableLoopbackPort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : null;
  await new Promise((resolve) => server.close(resolve));
  if (!Number.isInteger(port)) throw new Error("could not reserve an OpenCode broker port");
  return port;
}

function basicAuthorization(username, password) {
  return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
}

async function withLocalAccountServer(driver, callback, control = new LaunchControl(), candidate = null) {
  control.assertNotCancelled();
  const adapter = adapterFor(driver.name);
  const port = await availableLoopbackPort();
  // The server's fixed Basic Auth username, from the driver.
  const { username } = driver.input.localServer;
  const password = randomBytes(32).toString("base64url");
  const authorization = basicAuthorization(username, password);
  const leaf = await isolation.create(`account-${randomUUID()}`, runMemoryLimit(driver));
  const child = isolation.launch(
    leaf, "/usr/sbin/runuser",
    localServerUserArgs(
      adapter,
      driver.input.localServer.argv(port),
      driver.input.localServer.environment({ username, password }),
      candidate ? { home: candidate.home, executable: candidate.executable } : {},
    ),
    { cwd: candidate?.home ?? adapter.home, stdio: ["ignore", "pipe", "pipe"] },
  );
  // Stopping this means two things: no more waiting on the HTTP call, and no
  // more OpenCode server. Aborting the fetch alone would leave the process that
  // is doing the work running.
  const cancelled = new AbortController();
  control.bind(async () => {
    cancelled.abort(new Error("the request was cancelled"));
    await isolation.stop(leaf, { child });
  });

  const startupOutput = captureOutputTail(child);
  const url = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 30_000;
  let runtimeVersion = "";
  try {
    while (Date.now() < deadline) {
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new Error(`OpenCode account server exited during startup: ${redactAccountText(startupOutput())}`);
      }
      try {
        const response = await fetch(`${url}/global/health`, {
          headers: { authorization },
          signal: AbortSignal.timeout(2_000),
        });
        if (response.ok) {
          try {
            const health = await response.json();
            if (typeof health?.version === "string") runtimeVersion = health.version.slice(0, 64);
          } catch {}
          return await callback({ url, authorization, runtimeVersion });
        }
      } catch {
        // The localhost listener is still starting.
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`OpenCode account server startup timed out: ${redactAccountText(startupOutput())}`);
  } finally {
    await isolation.stop(leaf, { child, graceMs: 3_000 }).catch(() => {});
    await isolation.release(leaf).catch(() => {});
  }
}

function openCodeProviderSummary(payload, providerId) {
  const connected = Array.isArray(payload?.connected) && payload.connected.includes(providerId);
  const providers = payload?.all;
  const provider = Array.isArray(providers)
    ? providers.find((item) => item?.id === providerId)
    : providers?.[providerId];
  const modelsValue = provider?.models;
  const models = Array.isArray(modelsValue)
    ? modelsValue.map((item) => typeof item === "string" ? item : item?.id).filter(Boolean)
    : Object.keys(modelsValue ?? {});
  return { connected, models: models.slice(0, 500) };
}

async function fetchOpenCodeCatalogState(context, providerId) {
  const response = await fetch(`${context.url}/provider`, {
    headers: { authorization: context.authorization },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`OpenCode provider status returned HTTP ${response.status}`);
  return openCodeCatalogSummary(await response.json(), providerId);
}

async function fetchOpenCodeProviderState(context, providerId) {
  const response = await fetch(`${context.url}/provider`, {
    headers: { authorization: context.authorization },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`OpenCode provider status returned HTTP ${response.status}`);
  return openCodeProviderSummary(await response.json(), providerId);
}

async function runLocalAccountCli(driver, argv, control = new LaunchControl()) {
  control.assertNotCancelled();
  const adapter = adapterFor(driver.name);
  const leaf = await isolation.create(`account-${randomUUID()}`, runMemoryLimit(driver));
  const child = isolation.launch(
    leaf, "/usr/sbin/runuser",
    localServerUserArgs(adapter, argv),
    { cwd: adapter.home, stdio: ["ignore", "pipe", "pipe"] },
  );
  control.bind(async () => { await isolation.stop(leaf, { child }); });
  let stdout = "";
  let stderr = "";
  let outputExceeded = false;
  const collect = (target, chunk) => {
    const next = target + chunk;
    if (Buffer.byteLength(next) > 1024 * 1024) {
      outputExceeded = true;
      isolation.signal(leaf, "SIGKILL").catch(() => {});
    }
    return next;
  };
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => (stdout = collect(stdout, chunk)));
  child.stderr.on("data", (chunk) => (stderr = collect(stderr, chunk)));
  const timeout = setTimeout(() => { isolation.signal(leaf, "SIGKILL").catch(() => {}); }, 30_000);
  const { exitCode, signal } = await new Promise((resolve) => {
    child.once("error", (error) => resolve({ exitCode: -1, signal: null, error: error.message }));
    child.once("close", (exitCode, signal) => resolve({ exitCode, signal }));
  });
  clearTimeout(timeout);
  await isolation.release(leaf).catch(() => {});
  return {
    exit_code: exitCode ?? null,
    signal: signal ?? null,
    stdout: outputExceeded ? "[OUTPUT_EXCEEDED]" : redactAccountText(stdout),
    stderr: outputExceeded ? "[OUTPUT_EXCEEDED]" : redactAccountText(stderr).slice(0, 4096),
  };
}

// The fields a request carries for this supervisor rather than for the
// runtime. The rest goes to the driver's own validation, which refuses any
// field it does not name — so an unexpected field is still refused, not
// silently dropped.
function runtimeRequest(request) {
  // The qualification is the supervisor's to read (qualificationLaunch), not
  // the runtime's: the account validators refuse fields they do not know.
  const { type: _type, request_id: _requestId, runtime: _runtime, surface: _surface, qualification: _qualification, ...rest } = request;
  return rest;
}

async function runLocalServerAccount(request, driver, control = new LaunchControl()) {
  const surface = surfaceOf(driver, "account");
  if (surface.transport !== "local_server") throw new Error(`${driver.name}'s account surface is not a local server`);
  assertCapability(driver, surface.capability);
  const spec = driver.input.account(runtimeRequest(request));
  // A qualification (Stage 12 W3c) reads the candidate's model list, in its
  // scratch home, and does nothing else through this surface.
  const candidate = request.qualification ? qualificationLaunch(driver, request.qualification) : null;
  if (candidate && spec.operation !== "provider_list") throw new Error("a qualification only lists providers' models");
  if (spec.transport === "cli") {
    return { operation: spec.operation, ...await runLocalAccountCli(driver, spec.argv, control) };
  }
  return withLocalAccountServer(driver, async (context) => {
    if (spec.operation === "login") {
      const key = spec.key;
      spec.key = null;
      const response = await fetch(`${context.url}/auth/${spec.provider}`, {
        method: "PUT",
        headers: { authorization: context.authorization, "content-type": "application/json" },
        body: JSON.stringify({ type: "api", key }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok || await response.text() !== "true") {
        throw new Error(`OpenCode login returned HTTP ${response.status}`);
      }
    }
    if (spec.operation === "provider_list") {
      const providerIds = spec.provider ? [spec.provider] : driver.input.localServer.catalogProviders;
      const providers = [];
      let anyConnected = false;
      for (const providerId of providerIds) {
        const state = await fetchOpenCodeCatalogState(context, providerId);
        if (state.connected) anyConnected = true;
        providers.push({ ...state, runtime_version: context.runtimeVersion });
      }
      return {
        operation: spec.operation,
        exit_code: anyConnected ? 0 : 1,
        signal: null,
        stdout: JSON.stringify({ providers }),
        stderr: "",
      };
    }
    const state = await fetchOpenCodeProviderState(context, spec.provider);
    const result = spec.operation === "models_list"
      ? { connected: state.connected, models: state.models }
      : { connected: state.connected, account_label: state.connected ? (driver.input.localServer.accountLabels?.[spec.provider] ?? "") : "" };
    return {
      operation: spec.operation,
      exit_code: state.connected ? 0 : 1,
      signal: null,
      stdout: JSON.stringify(result),
      stderr: "",
    };
  }, control, candidate);
}

async function validateExecutorLaunch(request) {
  const context = await queryJson(
    `SELECT jsonb_build_object(
      'job_id', j.id, 'job_status', j.status, 'leased_by', j.leased_by,
      'leased_until', j.leased_until, 'run_id', j.run_id,
      'project_id', j.project_id, 'workspace_path', p.workspace_path,
      'lock_status', l.status, 'lock_owner_run_id', l.owner_run_id,
      'fencing_token', l.fencing_token, 'lease_expires_at', l.lease_expires_at,
      -- resolve_executor_launch_model returns jsonb, not a composite, so its
      -- fields are keys and not columns. Written as columns, this query failed to
      -- parse -- "column lm.model does not exist" -- on every implementation run,
      -- which meant no executor had ever launched through this path. The job
      -- retried twice, dead-lettered, and the workspace lease then expired, so
      -- what an operator saw was run.lost / workspace_lease_expired and nothing
      -- about a column.
      'model', lm.launch->>'model',
      -- OpenCode's --model is provider/model; the catalog keeps the two apart
      -- and the snapshot authorizes an entry, so the provider is read from the
      -- entry the snapshot named. Passing the bare model id makes OpenCode answer
      -- UnknownError and exit 1 before it writes anything to its own log --
      -- proven on the host by running both spellings side by side.
      'provider', (SELECT c.provider_id FROM provider_model_catalog c
                   WHERE c.id = (lm.launch->>'snapshot_entry_id')::uuid),
      -- The member's reasoning level, from the same snapshot entry as the model
      -- (0111); null when the task runs it at the runtime's default.
      'reasoning_effort', lm.launch->>'reasoning_effort',
      'snapshot_authorized', (lm.launch->>'snapshot_authorized')::boolean,
      'snapshot_mismatch', (lm.launch->>'snapshot_mismatch')::boolean,
      'agent_id', a.id, 'task_id', t.id,
      'commit_identity', commit_identity_for(j.project_id),
      -- M7 (0151): the runtime's own subagents, as the operator set for this
      -- executor on the Team page; off unless allowed.
      'allow_subagents', COALESCE((pa.config->>'allow_subagents')::boolean, false)
    )::text
    FROM runtime_jobs j
    JOIN projects p ON p.id = j.project_id
    JOIN workspace_locks l ON l.project_id = j.project_id
    JOIN tasks t ON t.id = j.task_id
    JOIN agents a ON a.id = t.active_agent_id
    JOIN domain_events e ON e.id=j.source_event_id AND e.event_type='implementation.requested'
    JOIN handoffs h ON h.id=(e.payload->>'handoff_id')::uuid
    -- The assignment implements because its definition holds the permission
    -- (ADR-0017), not because of the word its projection column carries. This
    -- was the last SQL outside the database that decided on that word, and
    -- decisions-by-permission.test.mjs keeps it the last.
    JOIN project_agent_assignments pa ON pa.id=h.executor_assignment_id
      AND pa.project_id=j.project_id AND pa.agent_id=a.id
      AND role_holds(pa.role_definition_id,'implementation.execute') AND pa.enabled
    JOIN task_executor_assignments tea ON tea.task_id=t.id
      AND tea.project_agent_assignment_id=pa.id AND tea.enabled
    CROSS JOIN LATERAL resolve_executor_launch_model(j.id) AS lm(launch)
    WHERE j.id = :'job_id'::bigint AND j.job_type='implementation_run';`,
    { job_id: request.job_id },
  );
  if (!context) throw new Error("start runtime job not found");
  if (
    context.job_status !== "in_flight" || context.leased_by !== supervisorId ||
    new Date(context.leased_until) <= new Date()
  ) throw new Error("runtime job lease is not owned by this supervisor");
  if (
    context.project_id !== request.project_id || context.run_id !== request.run_id ||
    context.lock_status !== "held" || context.lock_owner_run_id !== request.run_id ||
    context.fencing_token !== request.fencing_token ||
    new Date(context.lease_expires_at) <= new Date()
  ) throw new Error("workspace fence validation failed");
  if (context.snapshot_mismatch === true) {
    throw new Error("task runtime snapshot does not match the executor assignment");
  }
  if (context.model !== request.model) throw new Error("requested model differs from authorized runtime snapshot");
  const project = await getProject(request.project_id);
  return { ...context, workspace: project.workspace };
}

// An interrupt from the run's mailbox, for a batch run. SIGTERM to the run's
// cgroup, SIGKILL if the runtime outlives five seconds, and then — because the
// receipt says the run is over — the leaf is waited on, so a tool that stayed
// behind the runtime's exit is ended before the receipt says so. The receipt
// names the mechanism that actually stopped it, which is the cgroup on the
// product host and the process group only in the gate's container.
async function interruptRun({ command, leaf, child, childExit, terminate }) {
  const requestedAt = new Date().toISOString();
  terminate("SIGTERM");
  let escalated = false;
  const exit = await Promise.race([childExit, new Promise((resolve) => setTimeout(() => resolve(null), 5000))])
    ?? (escalated = true, terminate("SIGKILL"), await childExit);
  let leftovers = 0;
  if (isolation.mechanism === "cgroup") {
    ({ leftovers } = await isolation.release(leaf, { graceMs: 2_000 }).catch(() => ({ leftovers: -1 })));
  }
  return { mechanism: isolation.mechanism, cgroup: leaf.name, command_id: command.command_id, pid: child.pid,
    signal: "SIGTERM", escalated_to: escalated ? "SIGKILL" : null, requested_at: requestedAt,
    exited_at: new Date().toISOString(), exit_code: exit.code, exit_signal: exit.signal,
    ...(leftovers ? { leftover_processes_killed: leftovers } : {}) };
}

// An executor's run: a driver's batch surface in the project's workspace,
// under a read_write grant bound to the run's fencing token. Everything about
// the run's lifecycle — the reservation, the process_ref, the worker tool
// capability, the terminal report — is the executor role's and stays here; the
// command, the environment, the stream and the session come from the driver.
async function runFencedBatch(request, driver, control = new LaunchControl()) {
  const spec = surfaceOf(driver, "task");
  if (spec.transport !== "batch" || spec.workspace !== "grant") {
    throw new Error(`${driver.name}'s task surface is not a fenced batch run`);
  }
  assertCapability(driver, spec.capability);
  assertCapability(driver, "tools.worker_report");
  if (typeof request.prompt !== "string" || request.prompt.length === 0 || request.prompt.length > 64 * 1024) {
    throw new Error("worker prompt length is invalid");
  }
  const context = await validateExecutorLaunch(request);

  // Admission BEFORE any mutation (ownership, capability, spawn): register a
  // fail-closed `reserved` reservation atomically with the lifecycle check
  // and a project-row lock, and obtain the one-time admission token. If this
  // fails, nothing has been changed yet.
  let reservation = null;
  try {
    reservation = await queryJson(
      `SELECT reserve_runtime_launch(
        :'run_id'::uuid, :'project_id'::uuid, :'job_id'::bigint, :'supervisor_id',
        interval '90 seconds'
      )::text;`,
      {
        run_id: request.run_id,
        project_id: request.project_id,
        job_id: request.job_id,
        supervisor_id: supervisorId,
      },
    );
  } catch (error) {
    throw new Error(`runtime launch is not admitted: ${error.message}`);
  }
  if (reservation?.status !== "reserved" || typeof reservation.token !== "string") {
    throw new Error("runtime launch reservation failed");
  }
  const launchToken = reservation.token;

  // Only after admission do we mutate workspace ownership, create a worker
  // capability and spawn. All setup mutations are covered by one failure
  // guard, including synchronous/asynchronous spawn failures.
  let ownershipTransferred = false;
  let workerOwnerUid = null;
  let evidenceAccount = null;
  let capability = null;
  let toolSocket = null;
  // This launch's record in runtime_dispatch_attempts (WP-9c), and how it ended.
  let dispatchAttemptId = null;
  const nativeResult = { status: "not_started" };
  const closeToolSocket = async () => {
    if (!toolSocket) return;
    const closing = toolSocket;
    toolSocket = null;
    liveToolSockets.delete(request.run_id);
    await closing.close();
  };
  let child = null;
  // The run's cgroup: made before the spawn, named for the run, removed in
  // this function's `finally` however the run ends.
  let leaf = null;
  let taskMemory = null;
  // Whether this run's terminal report was accepted, and who to tell.
  const reportGate = { accepted: false, onAccepted: null };
  let stdout = "";
  let stderr = "";
  let outputExceeded = false;
  let interrupted = false;
  let observedNativeSessionId = request.native_session_id ?? null;
  // The model an alias resolved to, when the driver reads one from the stream
  // (Claude Code's init event): recorded with the attempt, where the catalog
  // compares it with its last check's (design §2.4, alias drift).
  let resolvedModel = null;

  const cancelReservation = async () => await queryJson(
    `SELECT cancel_runtime_launch(
      :'run_id'::uuid, :'job_id'::bigint, :'supervisor_id', :'token', false
    )::text;`,
    {
      run_id: request.run_id,
      job_id: request.job_id,
      supervisor_id: supervisorId,
      token: launchToken,
    },
  );
  const signalChild = (target, signal) => {
    if (!leaf) return;
    isolation.signal(leaf, signal).catch(() => {});
  };
  // A launch that failed after the spawn: the run's cgroup is ended and
  // removed, and a member that survives SIGKILL is the error.
  const terminateAndReap = async (target) => {
    if (!leaf) return;
    try {
      if (target) await isolation.stop(leaf, { child: target, graceMs: 3_000, killWaitMs: 3_000 });
      await isolation.release(leaf);
    } catch (error) {
      throw new Error(`runtime run ${leaf.name} survived SIGTERM and SIGKILL: ${error.message}`);
    }
  };
  const finishDispatchAttempt = async () => {
    if (!dispatchAttemptId) return;
    const id = dispatchAttemptId;
    dispatchAttemptId = null;
    if (resolvedModel) nativeResult.resolved_model = resolvedModel;
    try {
      await queryJson(
        `SELECT finish_runtime_dispatch_attempt(:'attempt_id'::bigint, :'supervisor_id', :'result'::jsonb, :'native_session_id')::text;`,
        { attempt_id: id, supervisor_id: supervisorId, result: JSON.stringify(nativeResult),
          native_session_id: observedNativeSessionId ?? "" },
      );
    } catch (error) {
      process.stderr.write(`${JSON.stringify({
        type: "runtime_dispatch.result_failed", run_id: request.run_id, reason: String(error?.message ?? error).slice(0, 200),
      })}\n`);
    }
  };
  const cleanupFailedLaunch = async () => {
    await terminateAndReap(child);
    await closeToolSocket();
    if (ownershipTransferred) {
      await inWorkspaceTurn(context.workspace, async () => transferOwnership(context.workspace, RESTING_OWNER));
    }
    const cancelled = await cancelReservation();
    if (!new Set(["cancelled", "not_reserved"]).has(cancelled?.status)) {
      throw new Error("runtime launch reservation could not be cancelled");
    }
  };

  try {
    // The grant is the authority for the chown, resolved in the workspace's
    // turn so that no Codex channel can resolve its own grant and chown in
    // between. validateOpenCodeLaunch and the reservation above already checked
    // the lease and the fencing token; the grant checks them again at this
    // moment, and ties them to the run and project this launch names.
    const grant = await inWorkspaceTurn(context.workspace, async () => {
      const resolved = await resolveWorkspaceGrant({
        token: request.grant_token,
        projectId: request.project_id,
        expect: { runtimeType: driver.name, mode: spec.grantMode, runId: request.run_id, fencingToken: request.fencing_token },
      }, queryJson);
      transferOwnership(context.workspace, resolved.account);
      return resolved;
    });
    ownershipTransferred = true;
    workerOwnerUid = (await stat(context.workspace)).uid;
    evidenceAccount = grant.account;
    // A task's first run — no base recorded for the task yet — starts on a
    // clean tree: what an earlier task left uncommitted is stashed under a
    // name, and the feed says so. A later revision keeps its tree; what is
    // uncommitted there is this task's own work.
    if (!(await queryJson(`SELECT to_jsonb(review_evidence_base(:'run_id'::uuid))::text;`, { run_id: request.run_id }))) {
      const stashed = await stashLeftovers({ runGit: gitAs(grant.account, context.workspace), taskId: context.task_id });
      if (stashed) {
        await queryJson(`SELECT append_runtime_activity_event(:'job_id'::bigint,:'worker_id',:'runtime_type',
          :'event_type',:'phase',:'summary',:'details'::jsonb)::text;`, {
          job_id: request.job_id, worker_id: supervisorId, runtime_type: driver.name,
          event_type: "runtime.workspace.leftovers_stashed", phase: "preparing",
          summary: `Set aside ${stashed.entries} uncommitted change(s) an earlier task left, as stash "${stashed.message}"`,
          details: JSON.stringify(stashed),
        });
      }
    }
    // The commit this run starts from, under its fencing token, before the
    // executor can move it. The first run of a task fixes the base every later
    // review of the task is relative to (WP-7); a run whose base is recorded
    // cannot complete without evidence. Refused here means not launched.
    await queryJson(
      `SELECT record_review_base(
        :'job_id'::bigint, :'supervisor_id', :'run_id'::uuid, :'fencing_token'::bigint, :'head'
      )::text;`,
      {
        job_id: request.job_id, supervisor_id: supervisorId, run_id: request.run_id,
        fencing_token: request.fencing_token, head: await headCommit(gitAs(grant.account, context.workspace)),
      },
    );
    // What runs (WP-9c): the job's selection, recorded by its first launch and
    // reused by every later one — the implementation and its finalizers alike —
    // and this launch appended. Refused, it is not launched.
    dispatchAttemptId = (await queryJson(
      `SELECT record_runtime_dispatch(:'job_id'::bigint, :'supervisor_id', :'launch'::jsonb)::text;`,
      { job_id: request.job_id, supervisor_id: supervisorId, launch: JSON.stringify(launchProvenance(driver,
        verificationOf(driver), { surface: "task", model: request.model, nativeSessionId: request.native_session_id ?? null,
          reasoningEffort: launchReasoningLevel(driver, context.reasoning_effort) })) },
    ))?.attempt_id ?? null;
    capability = randomUUID();
    // The run's own socket, as the account it runs as. Opened before the spawn
    // that is told its path, removed in this function's `finally` however the
    // run ends.
    const runContext = {
      projectId: context.project_id, taskId: context.task_id, runId: context.run_id,
      agentId: context.agent_id, fencingToken: context.fencing_token, jobId: request.job_id,
      reportNativeSessionId: request.terminal_report_session_id ?? null,
      // The session the stream named, for a runtime that names its own after
      // the run starts (Codex's `thread.started`): its report bridge cannot
      // know it (Stage 12 X2).
      observedSession: () => observedNativeSessionId,
    };
    liveToolSockets.add(request.run_id);
    toolSocket = await openRunToolSocket({
      root: workerToolSocketRoot, runId: request.run_id, uid: runtimeUid(grant.account), gid: 0, capability,
      // Every worker tool is terminal: a run reports exactly once. Only an
      // accepted report counts — a refusal throws before this line.
      serve: async (toolRequest) => {
        const result = await serveWorkerTool(runContext, toolRequest);
        reportGate.accepted = true;
        reportGate.onAccepted?.();
        return result;
      },
      log: (line) => process.stderr.write(`${JSON.stringify(line)}\n`),
    });
    // Qualified where the catalog knows the provider, and bare where it does not
    // — a snapshot taken before provenance was recorded has no entry to read.
    // Bare is what used to be sent always, so this is the older behaviour kept as
    // the fallback rather than a new guess.
    // A runtime whose sessions the supervisor names (Claude Code) is told the
    // new one's id, and so is its report bridge (Stage 12 X1); OpenCode names
    // its own and ignores both.
    const newSessionId = !request.native_session_id && driver.sessions.newId ? driver.sessions.newId() : null;
    const args = cleanRuntimeArgs(
      grant.account, context.workspace, driver.executable,
      driver.run.argv({
        model: driver.run.qualifyModel(context.provider, request.model),
        sessionId: request.native_session_id ?? null,
        newSessionId,
        prompt: request.prompt,
        surface: "task",
        reasoningEffort: context.reasoning_effort ?? null,
        version: activeVersionOf(driver.name),
        subagents: context.allow_subagents === true,
      }),
      [...driver.run.environment({
        surface: "task",
        subagents: context.allow_subagents === true,
        toolBridge: driver.toolBridge.environment({ socket: toolSocket.path, capability, runId: context.run_id,
          sessionId: request.native_session_id ?? newSessionId }),
      }), ...commitIdentityEnvironment(context.commit_identity)],
    );
    control.assertNotCancelled();
    leaf = await isolation.create(`task-${request.run_id}`, runMemoryLimit(driver));
    child = isolation.launch(leaf, "/usr/sbin/runuser", args, {
      cwd: context.workspace,
      stdio: ["ignore", "pipe", "pipe"],
    });
    await new Promise((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
    if (!Number.isInteger(child.pid)) throw new Error("runtime child pid is unavailable");
    // A task run is the longest-lived of these, and the one most worth being
    // able to stop: the client's authority to be waiting on it is bounded by a
    // lease, and the work is not.
    control.bind(async () => { await isolation.stop(leaf, { child }); });
    taskMemory = watchMemory(leaf);
    const processRef = isolation.refOf(leaf, child.pid);

    // Attach the spawned PID to the reservation right away via CAS on the
    // token: an expired or cancelled reservation cannot accept a PID.
    await queryJson(
      `SELECT bind_runtime_launch_pid(
        :'run_id'::uuid, :'token', :'supervisor_id', :'process_ref'
      )::text;`,
      {
        run_id: request.run_id,
        token: launchToken,
        supervisor_id: supervisorId,
        process_ref: processRef,
      },
    );
    // Atomic writer registration: complete_runtime_launch performs a second
    // lifecycle check (project row locked), CAS on the reservation token and
    // the task_runs.process_ref write in one transaction, so a project that
    // entered deleting after reserve cannot register a writer.
    await queryJson(
      `SELECT complete_runtime_launch(
        :'run_id'::uuid, :'project_id'::uuid, :'job_id'::bigint, :'supervisor_id',
        :'token', :'process_ref'
      )::text;`,
      {
        run_id: request.run_id,
        project_id: request.project_id,
        job_id: request.job_id,
        supervisor_id: supervisorId,
        token: launchToken,
        process_ref: processRef,
      },
    );
  } catch (error) {
    await cleanupFailedLaunch();
    Object.assign(nativeResult, { status: "launch_failed", error: String(error?.message ?? error).slice(0, 500) });
    await finishDispatchAttempt();
    throw new Error(`runtime launch setup failed: ${error.message}`);
  }
  const terminate = (signal = "SIGTERM") => signalChild(child, signal);
  const processRef = isolation.refOf(leaf, child.pid);
  let timedOut = false;
  const timeout = setTimeout(() => { timedOut = true; terminate(); }, runTimeoutMs);
  // After an accepted terminal report the run is done whatever the model does
  // next: a grace for its closing message, then SIGTERM, then SIGKILL. The exit
  // that follows is the run ending as reported, not a failure.
  const reportEnd = endAfterReport(terminate, { graceMs: terminalReportGraceMs });
  reportGate.onAccepted = reportEnd.arm;
  if (reportGate.accepted) reportEnd.arm();
  // Serialises the activity-event writes issued from the stdout handler below.
  let activityChain = Promise.resolve();
  // The run's mailbox (WP-9a). This supervisor holds the job's lease, so it
  // delivers the run's commands. OpenCode's interrupt is its cgroup, as its
  // driver declares: SIGTERM, then SIGKILL if it outlives the grace, and the
  // receipt is how the process ended — the runtime's answer, not ours.
  const childExit = new Promise((resolve) => child.once("close", (code, signal) => resolve({ code, signal })));
  const mailbox = startMailbox({
    jobId: request.job_id, workerId: supervisorId, driver, query: queryJson,
    onCommand: (command) => { if (command.command_kind === "interrupt") interrupted = true; },
    deliver: {
      interrupt: async (command) => interruptRun({ command, leaf, child, childExit, terminate }),
    },
  });
  const collect = (target, chunk) => {
    const next = target + chunk;
    if (Buffer.byteLength(next) > 4 * 1024 * 1024) {
      outputExceeded = true;
      terminate();
    }
    return next;
  };
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  let lineBuffer = "";
  child.stdout.on("data", (chunk) => {
    stdout = collect(stdout, chunk);
    lineBuffer += chunk;
    const lines = lineBuffer.split("\n");
    lineBuffer = lines.pop() ?? "";
    for (const line of lines) {
      // Raw and normalised, from the driver. The raw line stays in `stdout`,
      // bounded, and is returned whole; the normalised event, carrying its
      // native type, goes to the activity feed. A line the driver does not
      // normalise is still in `stdout` — a native extension the feed skips.
      const parsed = driver.stream.parse(line);
      if (!parsed) continue;
      observedNativeSessionId ??= driver.sessions.idFromEvent(parsed.raw);
      resolvedModel ??= driver.stream.resolvedModel?.(parsed.raw) ?? null;
      const { event } = parsed;
      // Written from a synchronous stdout handler, one per line, and read
      // back in order by the activity feed. psql was synchronous so ordering
      // was free; chaining keeps it without blocking the reader.
      if (event) {
        activityChain = activityChain
          .then(() => queryJson(`SELECT append_runtime_activity_event(:'job_id'::bigint,:'worker_id',:'runtime_type',
            :'event_type',:'phase',:'summary',:'details'::jsonb)::text;`, {
            job_id: request.job_id, worker_id: supervisorId, runtime_type: driver.name, event_type: event.eventType,
            phase: event.phase, summary: event.summary, details: JSON.stringify(event.details ?? {}),
          }))
          .catch(() => {});
      }
    }
  });
  child.stderr.on("data", (chunk) => (stderr = collect(stderr, chunk)));
  try {
    const exited = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (exitCode, signal) => resolve({ exitCode, signal }));
    });
    // Ended by the supervisor after its report was accepted: the run finished
    // as it reported, so it exits as a success. An interrupt or a timeout that
    // arrived first keeps its own meaning.
    const endedAsReported = reportEnd.ended() && !interrupted && !timedOut;
    const exitCode = endedAsReported ? 0 : exited.exitCode;
    const signal = endedAsReported ? null : exited.signal;
    Object.assign(nativeResult, { status: "exited", exit_code: exitCode, signal, interrupted, timed_out: timedOut,
      output_exceeded: outputExceeded, pid: child.pid, ended_on_report: endedAsReported,
      memory: await taskMemory?.stop() ?? null });
    if (outputExceeded) throw new Error("runtime output exceeded 4 MiB");
    // Named, because the alternative is what happened: the child was killed and
    // the only account of it was OpenCode's own "Session terminated, killing
    // shell", which describes the symptom and names neither the timer nor its
    // length.
    if (timedOut) {
      throw new Error(
        `runtime run exceeded ${Math.round(runTimeoutMs / 60_000)} minutes and was ended by the supervisor`,
      );
    }
    // The acknowledgement is written before the run is reported ended.
    await mailbox.stop();
    if (interrupted) return {
      exit_code: exitCode, signal, interrupted: true, native_session_id: observedNativeSessionId,
      stdout, stderr, pid: child.pid, process_ref: processRef, worker_owner_uid: workerOwnerUid,
      run_commands: mailbox.delivered.map(({ command_id, command_kind, status }) => ({ command_id, command_kind, status })),
    };
    let completionReport = null;
    let completionResult = null;
    let interactionReport = null;
    let interactionResult = null;
    if (exitCode === 0) {
      completionReport = await queryJson(
        `SELECT jsonb_build_object('report_id', r.id, 'native_session_id', r.native_session_id,
          'status', r.status)::text FROM worker_completion_reports r
         WHERE r.run_id = :'run_id'::uuid AND r.status = 'submitted';`,
        { run_id: context.run_id },
      );
      interactionReport = await queryJson(
        `SELECT jsonb_build_object('report_id', r.id, 'native_session_id', r.native_session_id,
          'status', r.status, 'report_type', r.report_type)::text FROM worker_interaction_reports r
         WHERE r.run_id = :'run_id'::uuid AND r.status = 'submitted';`,
        { run_id: context.run_id },
      );
      if (completionReport && interactionReport) {
        throw new Error("OpenCode must call exactly one terminal worker tool");
      }
      if (!completionReport && !interactionReport) {
        return {
          exit_code: exitCode,
          signal,
          stdout,
          stderr,
          pid: child.pid,
          process_ref: processRef,
          worker_owner_uid: workerOwnerUid,
          native_session_id: observedNativeSessionId,
          missing_terminal_report: true,
        };
      }
      const terminalReport = completionReport ?? interactionReport;
      const nativeSessionIds = new Set(
        stdout.split("\n").map((line) => driver.stream.parse(line))
          .map((parsed) => parsed && driver.sessions.idFromEvent(parsed.raw)).filter(Boolean),
      );
      if (nativeSessionIds.size !== 1) {
        throw new Error("terminal worker tool session does not match runtime output");
      }
      const expectedReportSessionId = request.terminal_report_session_id ?? [...nativeSessionIds][0];
      if (terminalReport.native_session_id !== expectedReportSessionId) {
        throw new Error("terminal worker report is not bound to the authorized native session");
      }
      if (request.native_session_id && !request.terminal_report_session_id
          && request.native_session_id !== terminalReport.native_session_id) {
        throw new Error("resumed OpenCode session continuity validation failed");
      }
      if (completionReport) {
        // What the executor produced, taken while its run still holds the
        // workspace and as the account it ran as — before the completion is
        // accepted, which releases both. The database takes the executor's
        // claims about its checks from its own report, not from here.
        const base = await queryJson(
          `SELECT to_jsonb(review_evidence_base(:'run_id'::uuid))::text;`, { run_id: request.run_id },
        );
        const evidence = await reviewEvidenceAs(evidenceAccount, context.workspace, base);
        // The owner's check command, run by the platform while the run still
        // holds the workspace (0143). Its outcome is a platform check: the
        // reviewer reads it as a fact, and a failure blocks the publish.
        // A fault of the platform's own here — the database read, the sandbox
        // setup — is a failed check, not a run that loses its accepted report.
        let projectCheck = null;
        let outcome = null;
        try {
          projectCheck = await queryJson(`SELECT project_check_for_run(:'run_id'::uuid)::text;`, { run_id: request.run_id });
          if (projectCheck?.command) outcome = await projectCheckAs(evidenceAccount, adapterFor(driver.name), context.workspace, projectCheck, leaf);
        } catch (error) {
          outcome = { name: "project_checks", status: "failed", command: projectCheck?.command ?? "",
            detail: `the platform could not run the check: ${String(error?.message ?? error).slice(0, 300)}`, output: "" };
        }
        if (outcome) {
          evidence.platform_verified_checks = [...(evidence.platform_verified_checks ?? []), outcome];
          process.stderr.write(`${JSON.stringify({ type: "project_check.finished", run_id: request.run_id, status: outcome.status, detail: outcome.detail })}\n`);
        }
        await queryJson(
          `SELECT record_review_evidence(
            :'job_id'::bigint, :'supervisor_id', :'run_id'::uuid, :'fencing_token'::bigint, :'evidence'::jsonb
          )::text;`,
          {
            job_id: request.job_id, supervisor_id: supervisorId, run_id: request.run_id,
            fencing_token: request.fencing_token, evidence: JSON.stringify(evidence),
          },
        );
        // The map follows the implementation, taken while the run still holds
        // the workspace, so the next chat starts from what this one made.
        await refreshRepositoryMap(context.project_id, evidenceAccount, context.workspace, "implementation");
        completionResult = await queryJson(
          `SELECT finalize_worker_completion(:'report_id'::uuid, :'job_id'::bigint, :'supervisor_id')::text;`,
          { report_id: completionReport.report_id, job_id: request.job_id, supervisor_id: supervisorId },
        );
      } else {
        interactionResult = await queryJson(
          `SELECT finalize_worker_interaction(:'report_id'::uuid, :'job_id'::bigint, :'supervisor_id')::text;`,
          { report_id: interactionReport.report_id, job_id: request.job_id, supervisor_id: supervisorId },
        );
      }
    }
    return {
      exit_code: exitCode,
      signal,
      stdout,
      stderr,
      pid: child.pid,
      process_ref: processRef,
      worker_owner_uid: workerOwnerUid,
      completion_report: completionReport,
      completion_result: completionResult,
      interaction_report: interactionReport,
      interaction_result: interactionResult,
    };
  } finally {
    clearTimeout(timeout);
    reportEnd.clear();
    await mailbox.stop();
    await taskMemory?.stop().catch(() => {});
    // The runtime has exited; what it left running goes with its cgroup,
    // before the workspace is handed to the next owner.
    await isolation.release(leaf).catch((error) => {
      process.stderr.write(`${JSON.stringify({ type: "run_cgroup.release_failed", run_id: request.run_id, cgroup: leaf.name, error: error.message })}\n`);
    });
    await closeToolSocket();
    // Handed back to the resting owner, the orchestrator's account: the only
    // way the orchestrator can read the result until the layout gives it a read
    // path. In the workspace's
    // turn, like every other ownership change.
    await inWorkspaceTurn(context.workspace, async () => transferOwnership(context.workspace, RESTING_OWNER));
    // The child has exited, so the launch is over and the reservation must not
    // outlive it. Without this it stays `completed`, and `reserve_runtime_launch`
    // — which re-reserves only a `cancelled` or `released` row — refuses every
    // retry of the same run. A job whose run failed then dead-lettered on
    // "runtime launch reservation already exists", which is the record of the
    // attempt that failed preventing the next one.
    //
    // Best effort, and deliberately: a release that fails must not replace the
    // reason the run ended. It is reported instead, because a slot that stayed
    // held is something an operator has to be able to find.
    try {
      const released = await queryJson(
        `SELECT release_runtime_launch(
          :'run_id'::uuid, :'job_id'::bigint, :'supervisor_id', :'token'
        )::text;`,
        {
          run_id: request.run_id,
          job_id: request.job_id,
          supervisor_id: supervisorId,
          token: launchToken,
        },
      );
      if (released?.status !== "released" && released?.status !== "not_released") {
        process.stderr.write(`${JSON.stringify({
          type: "runtime_launch.release_unexpected", run_id: request.run_id, status: released?.status ?? null,
        })}\n`);
      }
    } catch (error) {
      process.stderr.write(`${JSON.stringify({
        type: "runtime_launch.release_failed",
        run_id: request.run_id,
        reason: String(error?.message ?? error).slice(0, 200),
      })}\n`);
    }
    // The activity writes are fire-and-forget by design; wait for them here so
    // the last events of a run are durable before it is reported finished.
    await activityChain;
    await finishDispatchAttempt();
  }
}

// A worker tool request, on its run's socket, whose capability that socket has
// already checked (worker-tool-socket.mjs). What it answers is the database's.
// An orchestrator's turn as one batch run (11.2 N4).
//
// For a runtime whose project surface is a batch rather than a channel —
// OpenCode, where Codex's is app-server. The worker holds the job's lease and
// names itself; everything else is read here, from the job it leases: the
// workspace, the model and its provider, the conversation's native session.
// The client says which job and which prompt, not what the job is.
//
// Read-only twice over (D5). The grant is read_only and resolved in the
// workspace's turn, like a Codex channel's; the process runs under a Landlock
// ruleset that leaves the runtime its own state and nothing else to write
// (read-only-launch.mjs); and the run's config denies edits and the shell.
// The platform's commands reach it as tool files calling this run's socket,
// which accepts only them, answers each with the same function the Codex
// path calls under the same lease, and is not spent by an answer: a turn may
// delegate and then say so.
async function runReadOnlyBatch(request, driver, control = new LaunchControl()) {
  const spec = surfaceOf(driver, request.surface);
  if (spec.transport !== "batch" || spec.workspace !== "grant" || spec.grantMode !== "read_only") {
    throw new Error(`${driver.name}'s ${request.surface} surface is not a read-only batch run`);
  }
  assertCapability(driver, spec.capability);
  assertCapability(driver, "tools.platform");
  if (typeof request.prompt !== "string" || request.prompt.length === 0 || request.prompt.length > 256 * 1024) {
    throw new Error("turn prompt length is invalid");
  }
  if (typeof request.worker_id !== "string" || !request.worker_id) throw new Error("a turn names the worker that leases it");
  const workerId = request.worker_id;
  const context = await queryJson(`SELECT orchestrator_job_context(:'job_id'::bigint, :'worker_id')::text;`,
    { job_id: request.job_id, worker_id: workerId });
  if (!context?.workspace_path) throw new Error(`job ${request.job_id} is not a turn leased by ${workerId}`);
  if (context.runtime_type !== driver.name) {
    throw new Error(`job ${request.job_id} is ${context.runtime_type}'s turn, not ${driver.name}'s`);
  }
  const leased = await queryJson(`SELECT jsonb_build_object('run_id',j.run_id,
      'provider',(SELECT c.provider_id FROM provider_model_catalog c WHERE c.id=NULLIF(:'entry_id','')::uuid))::text
    FROM runtime_jobs j WHERE j.id=:'job_id'::bigint AND j.status='in_flight' AND j.leased_by=:'worker_id';`,
  { job_id: request.job_id, worker_id: workerId, entry_id: context.snapshot_entry_id ?? "" });
  if (!leased?.run_id) throw new Error(`job ${request.job_id} has no turn run under ${workerId}'s lease`);
  const workspace = context.workspace_path;
  const runId = leased.run_id;

  let toolSocket = null;
  let child = null;
  let leaf = null;
  let turnMemory = null;
  let owned = false;
  let dispatchAttemptId = null;
  let stdout = "";
  let stderr = "";
  let outputExceeded = false;
  let interrupted = false;
  let timedOut = false;
  // A runtime that takes its session id from the supervisor (Claude Code) is
  // given one for a conversation's first turn: its tool bridge then knows the
  // session before the runtime reports it. Resumed turns use the recorded one.
  const newSessionId = !context.native_session_id && driver.sessions.newId ? driver.sessions.newId() : null;
  let observedNativeSessionId = context.native_session_id ?? newSessionId;
  // As for a task run: the model the alias resolved to, when the driver says.
  let resolvedModel = null;
  const nativeResult = { status: "not_started" };
  const append = (event) => queryJson(`SELECT append_runtime_activity_event(:'job_id'::bigint,:'worker_id',:'runtime_type',
    :'event_type',:'phase',:'summary',:'details'::jsonb)::text;`, {
    job_id: request.job_id, worker_id: workerId, runtime_type: driver.name, event_type: event.eventType,
    phase: event.phase, summary: event.summary, details: JSON.stringify(event.details ?? {}),
  });
  const servePlatformTool = async (toolRequest) => {
    // A command from another session than this turn's is not this turn's.
    if (observedNativeSessionId && toolRequest.native_session_id !== observedNativeSessionId) {
      throw Object.assign(new Error("the command came from another session than this turn's"), { reason: "orchestration_job_not_leased" });
    }
    const args = toolRequest.arguments;
    const strings = (value, { nonEmpty = false } = {}) => Array.isArray(value) && (!nonEmpty || value.length > 0)
      && value.every((item) => typeof item === "string" && item.trim());
    if (typeof toolRequest.call_id !== "string" || !toolRequest.call_id || !args || typeof args !== "object") {
      throw new Error("a platform command needs a call id and its arguments");
    }
    try {
      if (toolRequest.type === "delegate_task") {
        if (typeof args.objective !== "string" || args.objective.trim().length < 4
            || !strings(args.instructions) || !strings(args.relevant_paths)) {
          throw new Error("delegate_task needs an objective and instructions and relevant_paths as string arrays");
        }
        return await queryJson(`SELECT invoke_delegate_task(:'job_id'::bigint, :'worker_id', :'call_id', :'objective',
          :'instructions'::jsonb, :'relevant_paths'::jsonb)::text;`, {
          job_id: request.job_id, worker_id: workerId, call_id: toolRequest.call_id, objective: args.objective.trim(),
          instructions: JSON.stringify(args.instructions), relevant_paths: JSON.stringify(args.relevant_paths),
        });
      }
      if (toolRequest.type === "consult") {
        if (typeof args.question !== "string" || args.question.trim().length < 10) throw new Error("consult needs a question");
        return { ...await queryJson(`SELECT invoke_consult(:'job_id'::bigint, :'worker_id', :'call_id', :'member', :'question')::text;`, {
          job_id: request.job_id, worker_id: workerId, call_id: toolRequest.call_id,
          member: typeof args.member === "string" ? args.member : "", question: args.question,
        }), next: CONSULT_NEXT };
      }
      if (toolRequest.type !== "request_revision") throw new Error(`unsupported platform command: ${toolRequest.type}`);
      if (!strings(args.changes_required, { nonEmpty: true })) throw new Error("request_revision needs changes_required");
      return await queryJson(`SELECT invoke_request_revision(:'job_id'::bigint, :'worker_id', :'call_id',
        :'changes_required'::jsonb)::text;`, {
        job_id: request.job_id, worker_id: workerId, call_id: toolRequest.call_id,
        changes_required: JSON.stringify(args.changes_required),
      });
    } catch (error) {
      const envelope = envelopeOf(error);
      throw Object.assign(new Error(error.message), { reason: failureReason(error) ?? undefined, failureCode: envelope.code });
    }
  };

  try {
    const grant = await inWorkspaceTurn(workspace, async () => {
      const resolved = await resolveWorkspaceGrant({
        token: request.grant_token, projectId: context.project_id,
        expect: { runtimeType: driver.name, mode: spec.grantMode },
      }, queryJson);
      control.assertNotCancelled();
      // A chown, as for a Codex channel: the runtime's user cannot read a tree
      // it does not own. Writing it is what the ruleset below refuses.
      transferOwnership(workspace, resolved.account);
      return resolved;
    });
    owned = true;
    dispatchAttemptId = (await queryJson(
      `SELECT record_runtime_dispatch(:'job_id'::bigint, :'worker_id', :'launch'::jsonb)::text;`,
      { job_id: request.job_id, worker_id: workerId, launch: JSON.stringify(launchProvenance(driver,
        verificationOf(driver), { surface: request.surface, model: context.model, nativeSessionId: context.native_session_id ?? null,
          reasoningEffort: launchReasoningLevel(driver, context.reasoning_effort) })) },
    ))?.attempt_id ?? null;
    const capability = randomUUID();
    liveToolSockets.add(runId);
    toolSocket = await openRunToolSocket({
      root: workerToolSocketRoot, runId, uid: runtimeUid(grant.account), gid: 0, capability,
      tools: driver.toolBridge.platformTools, terminal: false, serve: servePlatformTool,
      log: (line) => process.stderr.write(`${JSON.stringify(line)}\n`),
    });
    const args = cleanRuntimeArgs(grant.account, workspace, driver.executable, driver.run.argv({
      model: driver.run.qualifyModel(leased.provider ?? context.provider_type ?? null, context.model),
      sessionId: context.native_session_id ?? null,
      newSessionId,
      prompt: request.prompt,
      surface: request.surface,
      reasoningEffort: context.reasoning_effort ?? null,
    }), driver.run.environment({
      surface: request.surface,
      toolBridge: driver.toolBridge.environment({ socket: toolSocket.path, capability, runId,
        sessionId: context.native_session_id ?? newSessionId }),
    }), { readOnlyWritable: driver.run.readOnlyWritable });
    control.assertNotCancelled();
    leaf = await isolation.create(`turn-${runId}`, runMemoryLimit(driver));
    child = isolation.launch(leaf, "/usr/sbin/runuser", args, { cwd: workspace, stdio: ["ignore", "pipe", "pipe"] });
    await new Promise((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
    control.bind(async () => { await isolation.stop(leaf, { child }); });
    turnMemory = watchMemory(leaf);
  } catch (error) {
    if (leaf) {
      if (child) await isolation.stop(leaf, { child }).catch(() => {});
      await isolation.release(leaf).catch(() => {});
    }
    if (toolSocket) { liveToolSockets.delete(runId); await toolSocket.close().catch(() => {}); }
    if (owned) await inWorkspaceTurn(workspace, async () => transferOwnership(workspace, RESTING_OWNER)).catch(() => {});
    Object.assign(nativeResult, { status: "launch_failed", error: String(error?.message ?? error).slice(0, 500) });
    if (dispatchAttemptId) await queryJson(`SELECT finish_runtime_dispatch_attempt(:'attempt_id'::bigint, :'worker_id', :'result'::jsonb, :'native_session_id')::text;`,
      { attempt_id: dispatchAttemptId, worker_id: workerId, result: JSON.stringify(nativeResult), native_session_id: "" }).catch(() => {});
    throw new Error(`runtime launch setup failed: ${error.message}`);
  }

  const terminate = (signal = "SIGTERM") => { isolation.signal(leaf, signal).catch(() => {}); };
  const timeout = setTimeout(() => { timedOut = true; terminate(); }, runTimeoutMs);
  const childExit = new Promise((resolve) => child.once("close", (code, signal) => resolve({ code, signal })));
  // The turn's mailbox, delivered here because the process is here; the lease
  // is the worker's, and the worker's id is what the database checks.
  const mailbox = startMailbox({
    jobId: request.job_id, workerId, driver, query: queryJson,
    onCommand: (command) => { if (command.command_kind === "interrupt") interrupted = true; },
    deliver: {
      interrupt: async (command) => interruptRun({ command, leaf, child, childExit, terminate }),
    },
  });
  let activityChain = Promise.resolve();
  const collect = (target, chunk) => {
    const next = target + chunk;
    if (Buffer.byteLength(next) > 4 * 1024 * 1024) { outputExceeded = true; terminate(); }
    return next;
  };
  let lineBuffer = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout = collect(stdout, chunk);
    lineBuffer += chunk;
    const lines = lineBuffer.split("\n");
    lineBuffer = lines.pop() ?? "";
    for (const line of lines) {
      const parsed = driver.stream.parse(line);
      if (!parsed) continue;
      observedNativeSessionId ??= driver.sessions.idFromEvent(parsed.raw);
      resolvedModel ??= driver.stream.resolvedModel?.(parsed.raw) ?? null;
      if (parsed.event) activityChain = activityChain.then(() => append(parsed.event)).catch(() => {});
    }
  });
  child.stderr.on("data", (chunk) => (stderr = collect(stderr, chunk)));
  try {
    const exited = await childExit;
    await activityChain;
    await mailbox.stop();
    Object.assign(nativeResult, { status: "exited", exit_code: exited.code, signal: exited.signal, interrupted,
      timed_out: timedOut, output_exceeded: outputExceeded, pid: child.pid, memory: await turnMemory?.stop() ?? null });
    if (exited.code === READ_ONLY_LAUNCH_EXIT) {
      throw new Error(`the read-only launch was refused: ${stderr.trim().split("\n").at(-1) ?? ""}`);
    }
    if (outputExceeded) throw new Error("runtime output exceeded 4 MiB");
    if (timedOut) throw new Error(`runtime run exceeded ${Math.round(runTimeoutMs / 60_000)} minutes and was ended by the supervisor`);
    return {
      exit_code: exited.code, signal: exited.signal, interrupted, native_session_id: observedNativeSessionId,
      response: driver.stream.answer(stdout), failure: driver.stream.failure?.(stdout) ?? "",
      stderr: stderr.slice(-4000), pid: child.pid,
      run_commands: mailbox.delivered.map(({ command_id, command_kind, status }) => ({ command_id, command_kind, status })),
    };
  } catch (error) {
    if (nativeResult.status === "not_started") Object.assign(nativeResult, { status: "failed" });
    nativeResult.error = String(error?.message ?? error).slice(0, 500);
    throw error;
  } finally {
    clearTimeout(timeout);
    await mailbox.stop().catch(() => {});
    await turnMemory?.stop().catch(() => {});
    await isolation.release(leaf).catch((error) => {
      process.stderr.write(`${JSON.stringify({ type: "run_cgroup.release_failed", run_id: runId, cgroup: leaf.name, error: error.message })}\n`);
    });
    liveToolSockets.delete(runId);
    await toolSocket.close().catch(() => {});
    await inWorkspaceTurn(workspace, async () => transferOwnership(workspace, RESTING_OWNER)).catch((error) => {
      process.stderr.write(`${JSON.stringify({ type: "runtime_run.restore_owner_failed", job_id: request.job_id, error: error.message })}\n`);
    });
    if (dispatchAttemptId) {
      if (resolvedModel) nativeResult.resolved_model = resolvedModel;
      await queryJson(`SELECT finish_runtime_dispatch_attempt(:'attempt_id'::bigint, :'worker_id', :'result'::jsonb, :'native_session_id')::text;`,
        { attempt_id: dispatchAttemptId, worker_id: workerId, result: JSON.stringify(nativeResult),
          native_session_id: observedNativeSessionId ?? "" })
        .catch((error) => process.stderr.write(`${JSON.stringify({ type: "runtime_dispatch.result_failed", job_id: request.job_id, reason: error.message })}\n`));
    }
  }
}

async function serveWorkerTool(context, request) {
  try {
    return request.type === "complete_task" ? await queryJson(
      `SELECT submit_worker_completion(
        :'project_id'::uuid, :'task_id'::uuid, :'run_id'::uuid, :'agent_id'::uuid,
        :'fencing_token'::bigint, :'native_session_id', :'result_summary'::jsonb,
        :'checks_summary'::jsonb, :'notes', :'idempotency_key'
      )::text;`,
      {
        project_id: context.projectId, task_id: context.taskId, run_id: context.runId,
        agent_id: context.agentId, fencing_token: context.fencingToken,
        native_session_id: context.reportNativeSessionId ?? request.native_session_id ?? context.observedSession?.() ?? null,
        result_summary: JSON.stringify(request.result_summary),
        checks_summary: JSON.stringify(request.checks_summary), notes: request.notes ?? "",
        idempotency_key: request.idempotency_key,
      },
    ) : await queryJson(
      `SELECT submit_worker_interaction(
        :'project_id'::uuid, :'task_id'::uuid, :'run_id'::uuid, :'agent_id'::uuid,
        :'fencing_token'::bigint, :'native_session_id', :'report_type', :'payload'::jsonb,
        :'idempotency_key'
      )::text;`,
      {
        project_id: context.projectId, task_id: context.taskId, run_id: context.runId,
        agent_id: context.agentId, fencing_token: context.fencingToken,
        native_session_id: context.reportNativeSessionId ?? request.native_session_id ?? context.observedSession?.() ?? null,
        report_type: request.type === "report_blocker" ? "blocker" : "input_request",
        payload: JSON.stringify(request.payload), idempotency_key: request.idempotency_key,
      },
    );
  } catch (error) {
    // Logged as well as answered (the socket logs the refusal with its run).
    // Since 0067 the database says which refusal it is, so the answer carries
    // the reason rather than the sentence alone: the tool prints it, and the
    // normaliser carries it into the activity feed.
    const envelope = envelopeOf(error);
    throw Object.assign(new Error(error.message), {
      reason: failureReason(error) ?? undefined, failureCode: envelope.code,
    });
  }
}

// The driver a runtime request names, on a connection that negotiated the
// protocol these requests belong to. A peer that never said hello speaks
// version 1, which had no runtime requests — it had one method per vendor,
// and those are gone (WP-5b).
function driverOfRequest(socket, request) {
  if ((protocolVersions.get(socket) ?? 1) < 2) {
    throw Object.assign(new Error(`${request.type} needs protocol 2; this connection did not negotiate it`), {
      code: "protocol_version", retryable: false,
    });
  }
  if (typeof request.runtime !== "string" || typeof request.surface !== "string") {
    throw new Error(`${request.type} must name a runtime and a surface`);
  }
  return driverFor(request.runtime);
}

// What a request is called in the in-flight registry and in the log: the
// runtime, the surface and the verb, e.g. `opencode task run`.
function describeRequest(request) {
  return `${request.runtime} ${request.surface} ${request.type.replace(/^runtime_/, "")}`;
}

// ---------------------------------------------------------------------------
// Qualification (Stage 12 W3, qualification-surface.mjs)
// ---------------------------------------------------------------------------

// The OpenCode Go usage probe (ADR-0019), run as the runtime's user with a
// scrubbed environment, no arguments and no stdin. Its stderr is not read; its
// stdout is capped and checked against the closed schema, and a line that does
// not fit is dropped whole. One at a time: a second request while one runs is
// answered "busy" rather than queued.
const PROVIDER_USAGE_PROBE = path.join(path.dirname(fileURLToPath(import.meta.url)), "provider-usage.mjs");
let providerUsageProbeRunning = false;

async function runProviderUsageProbe({ timeoutMs = 20_000 } = {}) {
  if (providerUsageProbeRunning) return { status: "busy" };
  providerUsageProbeRunning = true;
  try {
    const adapter = adapterFor("opencode");
    const child = spawn("/usr/sbin/runuser", ["-u", adapter.user, "--", "/usr/bin/env", "-i",
      `HOME=${adapter.home}`, `PATH=${runtimePath}`, "LANG=C.UTF-8", process.execPath, PROVIDER_USAGE_PROBE],
    { cwd: adapter.home, stdio: ["ignore", "pipe", "ignore"] });
    let stdout = "";
    let tooLong = false;
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (Buffer.byteLength(stdout, "utf8") > PROBE_OUTPUT_MAX_BYTES) { tooLong = true; child.kill("SIGKILL"); }
    });
    const exitCode = await new Promise((resolve) => {
      const timer = setTimeout(() => { child.kill("SIGKILL"); resolve("timeout"); }, timeoutMs);
      child.once("error", () => { clearTimeout(timer); resolve("error"); });
      child.once("close", (code) => { clearTimeout(timer); resolve(code); });
    });
    if (exitCode === "timeout") return { status: "recorded", reading: { error_class: "timeout" } };
    const reading = tooLong ? null : checkProbeOutput(stdout);
    return reading ? { status: "recorded", reading } : { status: "rejected_output" };
  } finally {
    providerUsageProbeRunning = false;
  }
}

// The models Claude's subscription offers, read as claude-worker by the
// release's probe (claude-models.mjs). Only ids and names come back, checked
// here: the probe holds the login, and nothing of it is in its output.
const CLAUDE_MODELS_PROBE = path.join(path.dirname(fileURLToPath(import.meta.url)), "claude-models.mjs");
let claudeModelsRunning = false;
async function runClaudeModelList({ timeoutMs = 25_000 } = {}) {
  if (claudeModelsRunning) return { error: "busy" };
  claudeModelsRunning = true;
  try {
    const adapter = adapterFor("claude");
    const child = spawn("/usr/sbin/runuser", ["-u", adapter.user, "--", "/usr/bin/env", "-i",
      `HOME=${adapter.home}`, `PATH=${runtimePath}`, "LANG=C.UTF-8", process.execPath, CLAUDE_MODELS_PROBE],
    { cwd: adapter.home, stdio: ["ignore", "pipe", "ignore"] });
    let stdout = "";
    let tooLong = false;
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (Buffer.byteLength(stdout, "utf8") > 256 * 1024) { tooLong = true; child.kill("SIGKILL"); }
    });
    const exitCode = await new Promise((resolve) => {
      const timer = setTimeout(() => { child.kill("SIGKILL"); resolve("timeout"); }, timeoutMs);
      child.once("error", () => { clearTimeout(timer); resolve("error"); });
      child.once("close", (code) => { clearTimeout(timer); resolve(code); });
    });
    if (exitCode === "timeout") return { error: "timeout" };
    return tooLong ? { error: "unparsed" } : checkClaudeModels(stdout);
  } finally {
    claudeModelsRunning = false;
  }
}

function asRuntimeUser(user, command) {
  return execFileSync("/usr/sbin/runuser", ["-u", user, "--", ...command], { encoding: "utf8", timeout: 60_000 });
}

// The candidate's executable and its scratch paths, resolved for one launch.
// The active version of a runtime, as the inventory records it; null when the
// record cannot be read, which launches with every override as before.
function activeVersionOf(name) {
  try {
    return readRuntimes().runtimes?.[name]?.active?.version ?? null;
  } catch {
    return null;
  }
}

function qualificationLaunch(driver, qualification) {
  const adapter = adapterFor(driver.name);
  const paths = qualificationPaths(canonicalGateWorkspaceRoot, qualification?.id);
  const executable = qualificationExecutable(adapter, qualification?.version,
    { inventory: readRuntimes().runtimes, digestOf: executableDigest });
  return { ...paths, executable };
}

async function prepareQualification(request) {
  const driver = driverFor(String(request.runtime ?? ""));
  const adapter = adapterFor(driver.name);
  const { root, workspace, home, executable } = qualificationLaunch(driver, { id: request.qualification_id, version: request.version });
  await rm(root, { recursive: true, force: true });
  await mkdir(workspace, { recursive: true, mode: 0o755 });
  await mkdir(home, { mode: 0o700 });
  // A small repository with one commit: something to read, to log, and to
  // refuse writing to.
  const git = (...args) => execFileSync("/usr/bin/git", ["-C", workspace, "-c", "user.name=infra-cod qualification",
    "-c", "user.email=qualification@infra-cod.invalid", "-c", "commit.gpgsign=false", ...args], { timeout: 30_000 });
  git("init", "-q", "-b", "main");
  await writeFile(path.join(workspace, "NOTE.md"), `qualification ${request.qualification_id}\nQUALIFICATION_NOTE_OK\n`);
  git("add", "NOTE.md");
  git("commit", "-q", "-m", "qualification scratch repository");
  transferOwnership(workspace, adapter.user);
  const { group } = ownershipFor(adapter.user);
  execFileSync("/usr/bin/chown", [`${adapter.user}:${group}`, home]);
  // The login and configuration, copied by the runtime's own user: this
  // process never holds a credential's bytes.
  const copied = [];
  for (const relative of stateToCopy(adapter)) {
    const source = path.join(adapter.home, relative);
    const target = path.join(home, relative);
    asRuntimeUser(adapter.user, ["/bin/mkdir", "-p", path.dirname(target)]);
    const present = asRuntimeUser(adapter.user, ["/bin/sh", "-c", '[ -e "$1" ] || { echo absent; exit 0; }; /bin/cp -a "$1" "$2" && echo copied', "copy", source, target]).trim();
    copied.push({ path: relative, copied: present === "copied" });
  }
  // The writable state's directories, empty, where the active home has them.
  const created = [];
  for (const relative of writableStateInHome(adapter)) {
    const made = asRuntimeUser(adapter.user, ["/bin/sh", "-c", '[ -d "$1" ] || { echo absent; exit 0; }; /bin/mkdir -p "$2" && echo created',
      "writable", path.join(adapter.home, relative), path.join(home, relative)]).trim();
    if (made === "created") created.push(relative);
  }
  // Stage 12 M0: a canary beside the scratch login, made by the runtime's user.
  // The checks ask the model to print it; the nonce must never come back. Its
  // name says nothing about credentials: asked to `cat credential-canary.txt`,
  // Codex's model declined to run the command at all (rc.94 on the host), and a
  // command that never runs proves nothing.
  let canary = null;
  const loginDirectory = (adapter.loginState ?? [])[0];
  if (loginDirectory) {
    const file = path.join(home, loginDirectory, "session-note.txt");
    const nonce = `NOTE-${randomBytes(8).toString("hex")}`;
    const made = asRuntimeUser(adapter.user, ["/bin/sh", "-c", '[ -d "$(dirname "$1")" ] || { echo absent; exit 0; }; umask 077; printf "%s\\n" "$2" > "$1" && echo made',
      "canary", file, nonce]).trim();
    if (made === "made") canary = { path: file, nonce };
  }
  return { workspace, home, executable, copied, created, canary };
}

// Removes the scratch tree. A login the candidate refreshed is copied back
// first, by the runtime's user, when it is newer than the active version's.
async function cleanupQualification(request) {
  const driver = driverFor(String(request.runtime ?? ""));
  const adapter = adapterFor(driver.name);
  const { root, home } = qualificationPaths(canonicalGateWorkspaceRoot, request.qualification_id);
  const copiedBack = [];
  const login = adapter.authEvidence?.path ?? stateToCopy(adapter)[0];
  if (login && request.copy_back_login !== false) {
    const scratch = path.join(home, login);
    const active = path.join(adapter.home, login);
    const answer = asRuntimeUser(adapter.user, ["/bin/sh", "-c",
      '[ -f "$1" ] && [ -f "$2" ] && [ "$1" -nt "$2" ] && ! /usr/bin/cmp -s "$1" "$2" || { echo unchanged; exit 0; }; /bin/cp -p "$1" "$2.qualification-tmp" && /bin/mv "$2.qualification-tmp" "$2" && echo copied',
      "copy-back", scratch, active]).trim();
    if (answer === "copied") copiedBack.push(login);
  }
  await rm(root, { recursive: true, force: true });
  return { removed: true, copied_back: copiedBack };
}

// One batch run of a candidate on a task's or a turn's surface, in the scratch
// repository and home. The platform's tools answer from a stub that records
// the call and creates nothing; the result says which tools were called.
async function runQualificationBatch(request, driver, control = new LaunchControl()) {
  const spec = surfaceOf(driver, request.surface);
  if (spec.transport !== "batch" || spec.workspace !== "grant") {
    throw new Error(`${driver.name}'s ${request.surface} surface is not a task or turn batch run`);
  }
  assertCapability(driver, spec.capability);
  if (typeof request.model !== "string" || request.model.length < 2 || request.model.length > 200) throw new Error("qualification model is invalid");
  if (typeof request.prompt !== "string" || request.prompt.length === 0 || request.prompt.length > 16 * 1024) throw new Error("qualification prompt length is invalid");
  const adapter = adapterFor(driver.name);
  const { workspace, home, executable } = qualificationLaunch(driver, request.qualification);
  const readOnly = spec.grantMode === "read_only";
  const runId = randomUUID();
  const capability = randomUUID();
  const toolCalls = [];
  liveToolSockets.add(runId);
  const toolSocket = await openRunToolSocket({
    root: workerToolSocketRoot, runId, uid: runtimeUid(adapter.user), gid: 0, capability,
    tools: readOnly ? driver.toolBridge.platformTools : driver.toolBridge.tools, terminal: !readOnly,
    serve: async (toolRequest) => {
      toolCalls.push({ tool: String(toolRequest.type ?? ""), arguments: Object.keys(toolRequest.arguments ?? {}).slice(0, 20) });
      return { status: "recorded", qualification: true };
    },
    log: (line) => process.stderr.write(`${JSON.stringify(line)}\n`),
  });
  const newSessionId = !request.native_session_id && driver.sessions.newId ? driver.sessions.newId() : null;
  let observedNativeSessionId = request.native_session_id ?? newSessionId;
  const args = cleanRuntimeArgs(adapter.user, workspace, executable, driver.run.argv({
    model: request.model, sessionId: request.native_session_id ?? null, newSessionId, prompt: request.prompt, surface: request.surface,
    version: request.qualification?.version ?? null,
  }), driver.run.environment({
    surface: request.surface,
    toolBridge: driver.toolBridge.environment({ socket: toolSocket.path, capability, runId, sessionId: observedNativeSessionId }),
  }), { home, readOnlyWritable: readOnly ? scratchReadOnlyWritable(driver, adapter, home) : null });
  let stdout = "";
  let stderr = "";
  let interrupted = false;
  const leaf = await isolation.create(`qualification-${runId}`, runMemoryLimit(driver));
  try {
    control.assertNotCancelled();
    const child = isolation.launch(leaf, "/usr/sbin/runuser", args, { cwd: workspace, stdio: ["ignore", "pipe", "pipe"] });
    control.bind(async () => { interrupted = true; await isolation.stop(leaf, { child }); });
    const memory = watchMemory(leaf);
    const terminate = () => { isolation.signal(leaf, "SIGTERM").catch(() => {}); };
    const hardTimeout = setTimeout(() => { interrupted = true; terminate(); }, 5 * 60_000);
    const interruptAfter = Number.isInteger(request.interrupt_after_ms) && request.interrupt_after_ms > 0 && request.interrupt_after_ms < 5 * 60_000
      ? setTimeout(() => { interrupted = true; terminate(); }, request.interrupt_after_ms) : null;
    let lineBuffer = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      if (stdout.length < 4 * 1024 * 1024) stdout += chunk; else terminate();
      lineBuffer += chunk;
      const lines = lineBuffer.split("\n");
      lineBuffer = lines.pop() ?? "";
      for (const line of lines) {
        const parsed = driver.stream.parse(line);
        if (parsed) observedNativeSessionId ??= driver.sessions.idFromEvent(parsed.raw);
      }
    });
    child.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-8000); });
    const { exitCode, signal } = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (exitCode, signal) => resolve({ exitCode, signal }));
    });
    clearTimeout(hardTimeout);
    if (interruptAfter) clearTimeout(interruptAfter);
    return {
      exit_code: exitCode, signal, interrupted, native_session_id: observedNativeSessionId,
      read_only_refused: exitCode === READ_ONLY_LAUNCH_EXIT,
      stdout, stderr: stderr.slice(-4000), tool_calls: toolCalls, memory: await memory?.stop() ?? null,
    };
  } finally {
    await isolation.release(leaf).catch(() => {});
    liveToolSockets.delete(runId);
    await toolSocket.close().catch(() => {});
  }
}

// The body that carries a run or an account request, chosen by how the
// driver's surface is carried — not by the runtime's name.
function runnerFor(request, driver) {
  const spec = surfaceOf(driver, request.surface);
  if (request.type === "runtime_run" && request.qualification && spec.transport === "batch") return runQualificationBatch;
  if (request.type === "runtime_account" && spec.transport === "local_server") return runLocalServerAccount;
  if (request.type === "runtime_run" && spec.transport === "batch" && spec.workspace === "grant") {
    return spec.grantMode === "read_only" ? runReadOnlyBatch : runFencedBatch;
  }
  if (request.type === "runtime_run" && spec.transport === "batch" && spec.workspace === "gate") return runGateBatch;
  if (request.type === "runtime_run" && spec.transport === "batch" && spec.workspace === "snapshot") return runConsultBatch;
  throw Object.assign(
    new Error(`${driver.name}'s ${request.surface} surface is carried by ${spec.transport}, not by ${request.type}`),
    { code: "unsupported_surface", retryable: false },
  );
}

async function handle(socket, request) {
  try {
    if (request.type === "ping") {
      send(socket, { request_id: request.request_id, ok: true, result: { status: "ok", supervisor_id: supervisorId } });
    } else if (request.type === "runtime_open") {
      // A channel onto one surface of one driver. Registered here, before the
      // first `await`: the channel map only learns about this once the child
      // exists, and a socket closing in between used to leave the work with
      // nothing watching it.
      const driver = driverOfRequest(socket, request);
      await withInFlight(request, socket, describeRequest(request),
        (control) => openChannel(socket, request, driver, request.surface, control));
    } else if (request.type === "runtime_run" || request.type === "runtime_account") {
      // A run the supervisor drives to its end, or an account operation. The
      // driver's surface says which body serves it; the body is the same for
      // every runtime whose surface is carried the same way.
      //
      // Registered before it starts, so a client that runs out of lease can
      // stop it and be told whether it stopped — and so a closing socket takes
      // it along instead of leaving it to finish for nobody.
      const driver = driverOfRequest(socket, request);
      const run = runnerFor(request, driver);
      const control = new LaunchControl();
      const forget = registerInFlight(request.request_id, socket, {
        // The control, not a closure over a mutable field. A cancel arriving
        // before the child exists is remembered and applied when it does — and
        // until then the body refuses to start rather than being told it was
        // stopped and starting anyway.
        stop: () => control.requestStop(),
        describe: describeRequest(request),
      });
      try {
        const result = await withAdmission(driver.name, () => run(request, driver, control),
          { background: isBackgroundRun(request, request.surface) });
        send(socket, { request_id: request.request_id, ok: true,
          result: { ...result, capability_verification: verificationOf(driver) } });
      } finally {
        forget();
      }
    } else if (request.type === "provider_usage_probe") {
      // ADR-0019: OpenCode Go's windows, read as opencode-worker by the probe
      // shipped in this release. Only the line the schema allows comes back.
      send(socket, { request_id: request.request_id, ok: true, result: await runProviderUsageProbe() });
    } else if (request.type === "claude_model_list") {
      send(socket, { request_id: request.request_id, ok: true, result: await runClaudeModelList() });
    } else if (request.type === "qualification_prepare" || request.type === "qualification_cleanup") {
      // Stage 12 W3: the scratch repository and home a candidate runs in, made
      // before its checks and removed after them.
      const result = request.type === "qualification_prepare"
        ? await prepareQualification(request) : await cleanupQualification(request);
      send(socket, { request_id: request.request_id, ok: true, result });
    } else if (request.type === "deprovision_project") {
      // Registered like every other long request (WP-B): a cancel or a closed
      // socket reaches it, and a second request for the same project is
      // refused while the first runs.
      const result = await withInFlight(request, socket, "deprovision_project",
        (control) => deprovisionOnce(request.project_id, () => deprovisionProject(request, control)));
      send(socket, { request_id: request.request_id, ok: true, result });
    } else if (request.type === "cancel_request") {
      // A client asking for work to stop because its own authority to do the
      // work has run out. The answer says whether it actually stopped, because
      // that is the difference between "this can be handed back" and "nobody
      // knows what happened".
      const outcome = await cancelInFlight(request.cancel_request_id, socket);
      send(socket, { request_id: request.request_id, ok: true, result: outcome });
    } else if (request.type === "runtime_maintenance") {
      // The fence a runtime installation uses. It refuses new launches of one
      // runtime and reports how many are still open; it never ends anything
      // that is running, and it never touches the other runtime.
      //
      // Stopping this whole unit was the previous answer, and it was worse than
      // the problem: the unit is shared, its shutdown terminates every child
      // channel, and installing Codex would have killed a live OpenCode
      // session.
      driverFor(request.runtime);
      // The connection is the owner. It is released when this socket closes —
      // whether the installer finished, crashed, or was killed — and no other
      // connection can release it.
      const result = request.action === "pause"
        ? pauseRuntime(request.runtime, request.reason ?? "runtime installation", socket)
        : request.action === "resume"
          ? resumeRuntime(request.runtime, socket)
          : request.action === "status"
            ? runtimeAdmissionStatus(request.runtime)
            : (() => { throw new Error("unsupported maintenance action"); })();
      // `supervisor_id` lets the holder notice it is talking to a different
      // supervisor than the one that granted the fence.
      send(socket, { request_id: request.request_id, ok: true, result: { ...result, supervisor_id: supervisorId } });
    } else if (request.type === "stdin") {
      const channel = channels.get(request.channel_id);
      if (!channel || channel.socket !== socket) throw new Error("channel not found");
      // What this surface's stdin may carry is the driver's to say.
      channel.driver.input.validate(channel.surface, request.data, channel.state);
      channel.child.stdin.write(request.data);
    } else if (request.type === "close_channel") {
      const channel = channels.get(request.channel_id);
      if (!channel || channel.socket !== socket) throw new Error("channel not found");
      channel.child.stdin.end();
    } else {
      throw new Error("unsupported supervisor request");
    }
  } catch (error) {
    if (request.request_id) {
      // Retryable means "not now", not "this will never work". Cleanup must be
      // able to tell the two apart: a project that is merely busy has to be
      // tried again, not parked in deletion_failed for an operator.
      // `code` stays exactly what it was: a product reason the caller already
      // branches on (`grant_writer_active` defers a job, 0061). The envelope is
      // added beside it — `failure_code` is the family, `cause` the chain down
      // to what actually refused. Before this the client kept message, code and
      // retryable and the chain stopped there, which is how `OpenCode exited
      // with code 1: ` reached an operator whose real problem was EROFS (93).
      const envelope = envelopeOf(error);
      const chain = failureChain(error);
      send(socket, {
        request_id: request.request_id, ok: false, error: error.message,
        retryable: error.retryable === true || envelope.retryable,
        code: typeof error.code === "string" ? error.code : undefined,
        failure_code: envelope.code,
        ...(envelope.details && Object.keys(envelope.details).length ? { details: envelope.details } : {}),
        ...(chain.length > 1 ? { cause: chain.slice(1) } : {}),
        ...(request.type ? { operation: request.type } : {}),
      });
    }
    else send(socket, { type: "protocol_error", error: error.message });
  }
}

const server = net.createServer((socket) => {
  socket.on("error", () => {});
  readFramesFrom(socket, (frame) => void handle(socket, frame), { label: "infra-control" });
  socket.on("close", () => {
    // A fence dies with the connection that asked for it. An installer that was
    // killed cannot leave a runtime fenced off forever, because this runs
    // whatever became of it.
    void cancelInFlightFor(socket).then((stopped) => {
      for (const describe of stopped) {
        process.stderr.write(`runtime-supervisor: stopped ${describe} because the connection that asked for it closed\n`);
      }
    });
    for (const name of releaseOwner(socket)) {
      process.stderr.write(`runtime-supervisor: ${name} launches admitted again; the holding connection closed\n`);
    }
    for (const [channelId, channel] of channels) {
      if (channel.socket === socket) {
        isolation.signal(channel.leaf, "SIGTERM").catch(() => {});
        channels.delete(channelId);
      }
    }
  });
});

// Separate socket and request allowlist for the credential broker. Membership
// in infra-cod-github must not grant access to runtime launch, account, or
// deprovision operations exposed on the infra-control socket.
const githubBrokerServer = net.createServer((socket) => {
  socket.on("error", () => {});
  readFramesFrom(socket, (request) => {
    void (async () => {
      try {
        const action = githubWorkspaceAction(request.type);
        if (!action) throw new Error("unsupported github broker request");
        const result = isPublishAction(action)
          ? await githubPublishExport(request, action)
          : isSyncAction(action)
            ? await githubWorkspaceSync(request, action)
            : await githubAppWorkspace(request, action);
        send(socket, { request_id: request.request_id, ok: true, result });
      } catch (error) {
        send(socket, { request_id: request?.request_id, ok: false, error: error.message });
      }
    })();
  }, { label: "github-broker" });
});

server.listen(socketPath, async () => {
  await chmod(socketPath, 0o660);
  await chown(socketPath, 0, socketGroupId);
  process.stdout.write(`${JSON.stringify({ type: "runtime_supervisor.ready", socketPath, supervisorId })}\n`);
});
process.stdout.write(`${JSON.stringify({ type: "worker_tool_gateway.ready", socketRoot: workerToolSocketRoot })}\n`);
githubBrokerServer.listen(githubBrokerSocketPath, async () => {
  await chmod(githubBrokerSocketPath, 0o660);
  await chown(githubBrokerSocketPath, 0, githubBrokerGroupId);
  process.stdout.write(`${JSON.stringify({
    type: "github_workspace_broker.ready", socketPath: githubBrokerSocketPath,
  })}\n`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    // systemd ends the rest of the subtree at the unit's stop; this is the
    // polite word first. Every channel's leaf is signalled, not its leader.
    for (const channel of channels.values()) isolation.signal(channel.leaf, "SIGTERM").catch(() => {});
    githubBrokerServer.close();
    server.close(() => { closePool().finally(() => process.exit(0)); });
  });
}
