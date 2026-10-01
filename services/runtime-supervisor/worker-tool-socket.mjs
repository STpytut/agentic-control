// The worker tool transport: one socket per run, owned by the run's runtime
// account (WP-9b, prework A6).
//
// It used to be one socket, `/run/infra-cod/worker-tools.sock`, mode 0660, group
// `opencode-worker`. The capability it carries was already per run — one
// `INFRA_WORKER_CAPABILITY` per launch — but the transport was per group: a
// third executor runtime could not reach it, and letting it in would have given
// every runtime account a way to every run's channel, which is the opposite of
// what a capability is.
//
// Now each run gets `<root>/<run id>/tools.sock`:
//
//   * <root> is root's, 0711: an account can reach the directory of a run it was
//     told about and cannot list the others;
//   * <run id>/ is root's, 0711, for the same reason;
//   * tools.sock is the run's runtime account's, group root, 0600 — the kernel
//     refuses connect() to every other account with EACCES, before a byte is
//     read. Root is not refused, and root is the supervisor.
//
// Behind the file mode, three more checks, each of which a test takes away:
//
//   * at every accept the socket's owner and mode are read again — the account
//     owns the inode and could chmod it wider; a socket that is not exactly
//     what was made serves nothing until the run ends;
//   * the capability presented must be this run's, compared in constant time —
//     another run's capability on this socket is refused;
//   * a terminal tool accepted spends the capability, and presenting it again
//     is refused.
//
// The socket is removed when its run ends however it ends (`withRunToolSocket`),
// and a socket whose supervisor died with it is found by `sweepRunToolSockets`
// at the next start and reported by `staleRunToolSockets` in doctor.

import { timingSafeEqual } from "node:crypto";
import { lstatSync } from "node:fs";
import { chmod, chown, lstat, mkdir, readdir, rm } from "node:fs/promises";
import net from "node:net";
import path from "node:path";

import { createFrameReader, payloadOf } from "./framing.mjs";

export const RUN_TOOL_SOCKET_NAME = "tools.sock";
export const RUN_TOOL_SOCKET_MODE = 0o600;
export const TERMINAL_TOOLS = Object.freeze(["complete_task", "report_blocker", "request_user_input"]);

const RUN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export class ToolSocketRefusal extends Error {
  constructor(message, reason) {
    super(message);
    this.reason = reason;
  }
}

function sameSecret(expected, presented) {
  if (typeof presented !== "string") return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(presented);
  return a.length === b.length && timingSafeEqual(a, b);
}

// The root every run's directory lives under. Root's, 0711, recreated if a
// cleanup took it.
export async function ensureRunToolRoot(root) {
  await mkdir(root, { recursive: true, mode: 0o711 });
  await chown(root, 0, 0);
  await chmod(root, 0o711);
}

// Opens one run's socket. `serve(request, context)` answers a request whose
// capability has been checked; it resolves to `{ ok, result }` or throws.
// `socketMode` exists for the mutation tests and nothing else.
// `tools` are what this run may call; `terminal` says whether an accepted call
// spends the capability. An executor's tools are its terminal reports, called
// once. An orchestrator's platform tools (11.2 N4) are commands a turn may give
// more than one of — delegate, then answer — and each is idempotent by its call
// id in the database, so the capability stays good for the life of the run.
export async function openRunToolSocket({
  root, runId, uid, gid = 0, capability, serve, log = () => {}, socketMode = RUN_TOOL_SOCKET_MODE,
  tools = TERMINAL_TOOLS, terminal = true,
}) {
  if (!RUN_ID.test(String(runId))) throw new Error(`invalid run id for a tool socket: ${runId}`);
  if (!Number.isInteger(uid) || uid <= 0) throw new Error(`a run's tool socket needs a runtime uid, not ${uid}`);
  if (typeof capability !== "string" || capability.length < 16) throw new Error("a run's tool socket needs its capability");
  await ensureRunToolRoot(root);
  const directory = path.join(root, runId);
  // A directory left by a supervisor that died is this run's only if it is
  // empty of live listeners, which a fresh run id never has: removed, not reused.
  await rm(directory, { recursive: true, force: true });
  await mkdir(directory, { mode: 0o700 });
  const socketPath = path.join(directory, RUN_TOOL_SOCKET_NAME);
  let spent = false;

  const refuse = (socket, message, reason) => {
    log({ type: "worker_tool_gateway.refused", run_id: runId, reason, error: message });
    socket.end(`${JSON.stringify({ ok: false, error: message, reason, failure_code: "permission_denied" })}\n`);
  };

  const connections = new Set();
  const server = net.createServer((socket) => {
    socket.on("error", () => {});
    connections.add(socket);
    socket.once("close", () => connections.delete(socket));
    // The inode as it is now, not as it was made.
    let current;
    try { current = lstatSync(socketPath); } catch { current = null; }
    if (!current?.isSocket() || current.uid !== uid || (current.mode & 0o777) !== socketMode) {
      refuse(socket, "the run's tool socket is not as the supervisor made it", "worker_tool_socket_tampered");
      return;
    }
    let answered = false;
    const feed = createFrameReader({
      expectSequence: false,
      onProtocolError: (error) => {
        if (answered) return;
        answered = true;
        socket.end(`${JSON.stringify({ ok: false, error: error.message, failure_code: "protocol" })}\n`);
      },
      onMessage: (frame) => {
        if (answered) return;
        answered = true;
        const request = payloadOf(frame);
        if (!sameSecret(capability, request?.capability)) {
          refuse(socket, "invalid worker capability", "worker_capability_foreign");
          return;
        }
        if (!tools.includes(request.type)) {
          refuse(socket, "invalid worker capability", "worker_tool_unknown");
          return;
        }
        if (spent) {
          refuse(socket, "this run's terminal report was already accepted; the capability is spent", "worker_capability_spent");
          return;
        }
        void (async () => {
          try {
            const answer = await serve(request);
            // Spent only by an accepted terminal report: a refused one leaves
            // the run able to report correctly.
            if (terminal) spent = true;
            socket.end(`${JSON.stringify({ ok: true, result: answer })}\n`);
          } catch (error) {
            const reason = error?.reason ?? null;
            log({ type: "worker_tool_gateway.refused", run_id: runId, tool: request.type, reason, error: error.message });
            socket.end(`${JSON.stringify({
              ok: false, error: reason ? `${error.message} (${reason})` : error.message,
              failure_code: error?.failureCode ?? "internal", ...(reason ? { reason } : {}),
            })}\n`);
          }
        })();
      },
    });
    socket.setEncoding("utf8");
    socket.on("data", feed);
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => { server.off("error", reject); resolve(); });
  });
  // Made root's and unreachable, then given: there is no moment at which the
  // socket exists with a mode another account can use.
  await chmod(socketPath, socketMode);
  await chown(socketPath, uid, gid);
  await chmod(directory, 0o711);

  let closed = false;
  return {
    path: socketPath,
    directory,
    get spent() { return spent; },
    async close() {
      if (closed) return;
      closed = true;
      // A connection still open when the run ends is a process that outlived
      // it, and server.close() waits for every connection: the run's end would
      // wait on it for ever. The run is over, so they are cut.
      const closing = new Promise((resolve) => server.close(() => resolve()));
      for (const socket of connections) socket.destroy();
      await closing;
      await rm(directory, { recursive: true, force: true });
    },
  };
}

// A run's socket for exactly as long as `body` runs, removed however it ends.
export async function withRunToolSocket(options, body) {
  const socket = await openRunToolSocket(options);
  try {
    return await body(socket);
  } finally {
    await socket.close();
  }
}

// Every run directory under the root that is not a live run of this process:
// left by a supervisor that died without its `finally`. Removed at start and on
// every sweep; what was removed is returned so it can be logged.
export async function sweepRunToolSockets(root, liveRunIds = new Set()) {
  let entries;
  try { entries = await readdir(root); } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  const removed = [];
  for (const entry of entries) {
    if (liveRunIds.has(entry)) continue;
    const directory = path.join(root, entry);
    const info = await lstat(directory).catch(() => null);
    if (!info) continue;
    await rm(directory, { recursive: true, force: true });
    removed.push(entry);
  }
  return removed;
}

// What doctor reports: run sockets nobody is listening on. A listener answers
// connect(); a socket left by a dead supervisor refuses it. Read-only.
export async function staleRunToolSockets(root, { timeoutMs = 1000 } = {}) {
  let entries;
  try { entries = await readdir(root); } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  const stale = [];
  for (const entry of entries) {
    const socketPath = path.join(root, entry, RUN_TOOL_SOCKET_NAME);
    const alive = await new Promise((resolve) => {
      const probe = net.createConnection(socketPath);
      const timer = setTimeout(() => { probe.destroy(); resolve(true); }, timeoutMs);
      probe.once("connect", () => { clearTimeout(timer); probe.destroy(); resolve(true); });
      probe.once("error", (error) => {
        clearTimeout(timer);
        // Refused or gone is stale; anything else (EACCES as a non-root
        // caller) is not evidence either way, and doctor runs as root.
        resolve(!["ECONNREFUSED", "ENOENT"].includes(error.code));
      });
    });
    if (!alive) stale.push(entry);
  }
  return stale;
}
