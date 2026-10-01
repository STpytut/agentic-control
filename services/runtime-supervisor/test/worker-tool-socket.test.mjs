// The worker tool transport against the operating system (WP-9b, prework A6).
//
// Real accounts, real sockets, real connect(): the boundary is the kernel's,
// so a stand-in would prove nothing. Two system accounts are created if they
// do not exist, and every client runs as one of them through runuser — the way
// the supervisor launches a runtime. Root is needed to create accounts and to
// chown a socket; the offline gate runs as root, and so does the supervisor.
//
// The five negative tests the plan requires, each failing closed:
//
//   1. another runtime's uid cannot open the socket;
//   2. a capability belonging to a different run is refused;
//   3. a terminal capability presented again is refused;
//   4. the socket is removed when the run ends, and when it crashes;
//   5. a stale socket is recovered by the sweep, and reported before that.
//
// And the mutations: with the socket made 0666, or given to the wrong uid,
// test 1's assertion fails — it is the file's owner and mode that hold it.
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, lstatSync } from "node:fs";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  RUN_TOOL_SOCKET_MODE, openRunToolSocket, staleRunToolSockets, sweepRunToolSockets, withRunToolSocket,
} from "../worker-tool-socket.mjs";

const isRoot = process.getuid?.() === 0;
const skip = isRoot ? false : "needs root: it creates accounts and chowns sockets, as the supervisor does";
const RUNTIME = "infra-cod-t-runtime";
const OTHER = "infra-cod-t-other";
const moduleUrl = new URL("../worker-tool-socket.mjs", import.meta.url).href;

function ensureAccount(name) {
  if (spawnSync("id", ["-u", name]).status !== 0) {
    execFileSync("useradd", ["--system", "--no-create-home", "--shell", "/usr/sbin/nologin", name]);
  }
  return Number(execFileSync("id", ["-u", name], { encoding: "utf8" }).trim());
}

// One request from `user`, through the kernel: what connect() said, or the
// gateway's answer. Asynchronous: the gateway is in this process, and a
// synchronous spawn would stop it from answering.
async function asUser(user, socketPath, request) {
  const script = `
    const net = require("node:net");
    const socket = net.createConnection(process.argv[1]);
    let data = "";
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.write(process.argv[2] + "\\n"));
    socket.on("data", (chunk) => { data += chunk; });
    socket.on("error", (error) => { process.stdout.write(JSON.stringify({ connect_error: error.code })); process.exit(0); });
    socket.on("close", () => { process.stdout.write(data.trim() || JSON.stringify({ closed: true })); });`;
  const child = spawn("/usr/sbin/runuser", ["-u", user, "--", process.execPath, "-e", script,
    socketPath, JSON.stringify(request)], { stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const timer = setTimeout(() => child.kill("SIGKILL"), 20_000);
  const code = await new Promise((resolve) => child.once("close", resolve));
  clearTimeout(timer);
  assert.equal(code, 0, stderr);
  return JSON.parse(stdout);
}

let root;
let runtimeUid;
let otherUid;
const served = [];
const serve = async (request) => { served.push(request); return { accepted: request.type }; };
const runA = "0a0a0a0a-0000-4000-8000-00000000000a";
const runB = "0b0b0b0b-0000-4000-8000-00000000000b";
const capA = "capability-of-run-a-0123456789";
const capB = "capability-of-run-b-0123456789";
const report = (capability, type = "complete_task") => ({ type, capability, result_summary: {}, checks_summary: {} });

test.before(async () => {
  if (!isRoot) return;
  runtimeUid = ensureAccount(RUNTIME);
  otherUid = ensureAccount(OTHER);
  // Traversable by every account, as /run/infra-cod is: otherwise every
  // client is refused by the parent, the negative tests pass for the wrong
  // reason, and the positive one is what says so.
  const parent = await mkdtemp(path.join(tmpdir(), "infra-cod-tool-sockets-"));
  await chmod(parent, 0o755);
  root = path.join(parent, "worker-tools");
});

test.after(async () => { if (root) await rm(path.dirname(root), { recursive: true, force: true }); });

test("the run's own account reaches its socket, and the socket is exactly what was made", { skip }, async () => {
  await withRunToolSocket({ root, runId: runA, uid: runtimeUid, capability: capA, serve }, async (socket) => {
    const info = lstatSync(socket.path);
    assert.equal(info.isSocket(), true);
    assert.equal(info.uid, runtimeUid);
    assert.equal(info.gid, 0);
    assert.equal(info.mode & 0o777, RUN_TOOL_SOCKET_MODE);
    assert.equal(lstatSync(root).mode & 0o777, 0o711);
    assert.equal(lstatSync(socket.directory).mode & 0o777, 0o711);
    assert.deepEqual(await asUser(RUNTIME, socket.path, report(capA)), { ok: true, result: { accepted: "complete_task" } });
  });
});

test("1. another runtime's uid cannot open the socket", { skip }, async () => {
  served.length = 0;
  await withRunToolSocket({ root, runId: runA, uid: runtimeUid, capability: capA, serve }, async (socket) => {
    // With the right capability, even: the kernel refuses before a byte is read.
    assert.deepEqual(await asUser(OTHER, socket.path, report(capA)), { connect_error: "EACCES" });
    assert.equal(served.length, 0);
  });
});

test("2. a capability belonging to a different run is refused", { skip }, async () => {
  served.length = 0;
  await withRunToolSocket({ root, runId: runA, uid: runtimeUid, capability: capA, serve }, async (a) => {
    await withRunToolSocket({ root, runId: runB, uid: runtimeUid, capability: capB, serve }, async (b) => {
      const refused = await asUser(RUNTIME, a.path, report(capB));
      assert.equal(refused.ok, false);
      assert.equal(refused.reason, "worker_capability_foreign");
      assert.equal((await asUser(RUNTIME, b.path, report(capA))).reason, "worker_capability_foreign");
      assert.equal(served.length, 0);
      assert.equal(a.spent, false, "a refused capability spent the run's own");
    });
  });
});

test("3. a terminal capability presented again is refused", { skip }, async () => {
  served.length = 0;
  let refuseFirst = true;
  const flaky = async (request) => {
    if (refuseFirst) { refuseFirst = false; throw Object.assign(new Error("run is not running"), { reason: "run_not_running" }); }
    return serve(request);
  };
  await withRunToolSocket({ root, runId: runA, uid: runtimeUid, capability: capA, serve: flaky }, async (socket) => {
    // A report the database refused does not spend the capability …
    assert.equal((await asUser(RUNTIME, socket.path, report(capA))).reason, "run_not_running");
    assert.equal(socket.spent, false);
    // … an accepted one does, and the same capability is refused after it,
    // for every terminal tool.
    assert.equal((await asUser(RUNTIME, socket.path, report(capA))).ok, true);
    for (const type of ["complete_task", "report_blocker", "request_user_input"]) {
      const again = await asUser(RUNTIME, socket.path, report(capA, type));
      assert.equal(again.ok, false, type);
      assert.equal(again.reason, "worker_capability_spent", type);
    }
    assert.equal(served.length, 1);
  });
});

test("4. the socket is removed when the run ends, and when it crashes", { skip }, async () => {
  let directory;
  await withRunToolSocket({ root, runId: runA, uid: runtimeUid, capability: capA, serve }, async (socket) => {
    directory = socket.directory;
    assert.equal(existsSync(socket.path), true);
  });
  assert.equal(existsSync(directory), false, "the socket outlived its run");

  // The runtime killed mid-request, and the run's body failing because of it.
  await assert.rejects(withRunToolSocket({ root, runId: runB, uid: runtimeUid, capability: capB, serve }, async (socket) => {
    directory = socket.directory;
    const child = spawn("/usr/sbin/runuser", ["-u", RUNTIME, "--", process.execPath, "-e",
      "require('node:net').createConnection(process.argv[1]).on('connect', () => setInterval(() => {}, 1000))",
      socket.path], { stdio: "ignore", detached: true });
    await new Promise((resolve) => setTimeout(resolve, 300));
    // The whole group, as the supervisor stops a run: runuser and the runtime.
    process.kill(-child.pid, "SIGKILL");
    await new Promise((resolve) => child.once("close", resolve));
    throw new Error("runtime crashed");
  }), /runtime crashed/);
  assert.equal(existsSync(directory), false, "the socket outlived a crashed run");
});

test("a process that outlives its run does not hold the run's end open", { skip }, async () => {
  let child;
  const started = Date.now();
  await withRunToolSocket({ root, runId: runA, uid: runtimeUid, capability: capA, serve }, async (socket) => {
    child = spawn("/usr/sbin/runuser", ["-u", RUNTIME, "--", process.execPath, "-e",
      "require('node:net').createConnection(process.argv[1]).on('connect', () => setInterval(() => {}, 1000)).on('error', () => {})",
      socket.path], { stdio: "ignore", detached: true });
    await new Promise((resolve) => setTimeout(resolve, 300));
  });
  assert.ok(Date.now() - started < 5000, "closing the run's socket waited for a connection a leftover process held");
  process.kill(-child.pid, "SIGKILL");
});

test("5. a stale socket is reported, and recovered by the sweep; a live one is neither", { skip }, async () => {
  // A supervisor that dies holding a run's socket: a separate process opens it
  // and is SIGKILLed, so no `finally` runs and the file stays.
  const script = `
    const { openRunToolSocket } = await import(${JSON.stringify(moduleUrl)});
    await openRunToolSocket({ root: process.argv[1], runId: process.argv[2], uid: Number(process.argv[3]),
      capability: "stale-capability-0123456789", serve: async () => ({}) });
    process.stdout.write("listening\\n");
    setInterval(() => {}, 1000);`;
  const dying = spawn(process.execPath, ["--input-type=module", "-e", script, root, runB, String(runtimeUid)],
    { stdio: ["ignore", "pipe", "inherit"] });
  await new Promise((resolve) => dying.stdout.once("data", resolve));
  dying.kill("SIGKILL");
  await new Promise((resolve) => dying.once("close", resolve));
  assert.equal(existsSync(path.join(root, runB, "tools.sock")), true, "fixture: the dead supervisor's socket should remain");

  await withRunToolSocket({ root, runId: runA, uid: runtimeUid, capability: capA, serve }, async () => {
    assert.deepEqual(await staleRunToolSockets(root), [runB], "doctor's check names the stale socket and only it");
    assert.deepEqual(await sweepRunToolSockets(root, new Set([runA])), [runB]);
    assert.equal(existsSync(path.join(root, runB)), false);
    assert.equal(existsSync(path.join(root, runA, "tools.sock")), true, "the sweep took a live run's socket");
    assert.deepEqual(await staleRunToolSockets(root), []);
  });
});

test("the account that owns the socket cannot widen it for another", { skip }, async () => {
  served.length = 0;
  await withRunToolSocket({ root, runId: runA, uid: runtimeUid, capability: capA, serve }, async (socket) => {
    execFileSync("/usr/sbin/runuser", ["-u", RUNTIME, "--", "/bin/chmod", "0666", socket.path]);
    // The kernel now lets the other account connect; the gateway does not serve it.
    assert.equal((await asUser(OTHER, socket.path, report(capA))).reason, "worker_tool_socket_tampered");
    assert.equal(served.length, 0);
  });
});

// ------------------------------------------------------------------ mutations
// The assertion of test 1, run against a socket made the wrong way. Each must
// let the other account through — so test 1 is held by the owner and the mode,
// and not passing for another reason.
test("mutation: a socket made 0666 lets another runtime's uid through", { skip }, async () => {
  served.length = 0;
  await withRunToolSocket({ root, runId: runA, uid: runtimeUid, capability: capA, serve, socketMode: 0o666 }, async (socket) => {
    assert.equal((await asUser(OTHER, socket.path, report(capA))).ok, true,
      "with the mode widened, test 1's refusal still held — something else is holding it");
  });
});

test("mutation: a socket given to the wrong uid lets that uid in and keeps the run's own out", { skip }, async () => {
  await withRunToolSocket({ root, runId: runA, uid: otherUid, capability: capA, serve }, async (socket) => {
    assert.equal((await asUser(OTHER, socket.path, report(capA))).ok, true);
    assert.deepEqual(await asUser(RUNTIME, socket.path, report(capA)), { connect_error: "EACCES" });
  });
});

test("the module refuses a socket with no runtime account or no capability", async () => {
  const base = { root: path.join(tmpdir(), "never-created"), runId: runA, capability: capA, serve };
  await assert.rejects(openRunToolSocket({ ...base, uid: 0 }), /needs a runtime uid/);
  await assert.rejects(openRunToolSocket({ ...base, uid: 1234, capability: "short" }), /needs its capability/);
  await assert.rejects(openRunToolSocket({ ...base, uid: 1234, runId: "../../etc" }), /invalid run id/);
});


// An orchestrator's run (11.2 N4): its socket accepts the platform's commands
// and nothing else, and an answer does not spend it — a turn may delegate and
// then answer, or be told a delegation was refused and try again. The default
// socket, an executor's, still refuses them.
test("an orchestrator's socket takes platform commands, more than once, and no terminal report", { skip }, async () => {
  served.length = 0;
  const command = (type) => ({ type, capability: capA, call_id: `m1:${type}`, arguments: {} });
  await withRunToolSocket({
    root, runId: runA, uid: runtimeUid, capability: capA, serve,
    tools: ["delegate_task", "request_revision"], terminal: false,
  }, async (socket) => {
    assert.deepEqual(await asUser(RUNTIME, socket.path, command("delegate_task")), { ok: true, result: { accepted: "delegate_task" } });
    assert.deepEqual(await asUser(RUNTIME, socket.path, command("request_revision")), { ok: true, result: { accepted: "request_revision" } });
    assert.equal((await asUser(RUNTIME, socket.path, report(capA))).reason, "worker_tool_unknown");
    assert.equal(socket.spent, false);
  });
  await withRunToolSocket({ root, runId: runB, uid: runtimeUid, capability: capB, serve }, async (socket) => {
    const refused = await asUser(RUNTIME, socket.path, { type: "delegate_task", capability: capB, call_id: "x", arguments: {} });
    assert.equal(refused.reason, "worker_tool_unknown");
  });
  assert.deepEqual(served.map((request) => request.type), ["delegate_task", "request_revision"]);
});
