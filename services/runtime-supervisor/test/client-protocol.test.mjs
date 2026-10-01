import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { RuntimeSupervisorClient, supervisorError } from "../client.mjs";
import { createFrameReader, createFrameWriter, payloadOf } from "../framing.mjs";
import { githubPublishRequest, githubWorkspaceAction, githubWorkspaceRequest } from "../github-workspace-protocol.mjs";
import { driverFor } from "../drivers/index.mjs";

test("preserves retryable supervisor errors", () => {
  const retryable = supervisorError({ error: "workspace busy", retryable: true });
  assert.equal(retryable.message, "workspace busy");
  assert.equal(retryable.retryable, true);

  const terminal = supervisorError({ error: "stale operation", retryable: false });
  assert.equal(terminal.retryable, undefined);
});

test("GitHub staging protocol is an explicit three-operation allowlist", () => {
  assert.deepEqual(githubWorkspaceRequest("prepare_github_app_workspace", "p"), {
    type: "prepare_github_app_workspace", project_id: "p",
  });
  assert.deepEqual(githubWorkspaceRequest("finalize_github_app_workspace", "p"), {
    type: "finalize_github_app_workspace", project_id: "p",
  });
  assert.deepEqual(githubWorkspaceRequest("abort_github_app_workspace", "p"), {
    type: "abort_github_app_workspace", project_id: "p",
  });
  assert.throws(() => githubWorkspaceRequest("deprovision_project", "p"), /unsupported/);
  assert.equal(githubWorkspaceAction("deprovision_project"), null,
    "the broker socket must not expose the main supervisor's privileged operations");
});

test("the broker's publish requests name an intent, and only the two publish operations do", () => {
  assert.deepEqual(githubPublishRequest("export_publish_commit", "i"), { type: "export_publish_commit", intent_id: "i" });
  assert.deepEqual(githubPublishRequest("release_publish_export", "i"), { type: "release_publish_export", intent_id: "i" });
  // Neither kind of request can be dressed as the other: a project id cannot
  // reach the export, and an intent id cannot reach workspace staging.
  assert.throws(() => githubWorkspaceRequest("export_publish_commit", "p"), /unsupported/);
  assert.throws(() => githubPublishRequest("prepare_github_app_workspace", "i"), /unsupported/);
  assert.throws(() => githubPublishRequest("deprovision_project", "i"), /unsupported/);
});

test("every long-running request waits on a named budget, not a literal", () => {
  // A one-line patch went into the wrong method: `runOpenCodeGate` got the
  // hour-long budget and `runOpenCode` — the one that needed it — kept its ten
  // minutes. Nothing failed locally, because nothing here runs for ten minutes,
  // and the audit that followed read the file assuming the edit had landed where
  // it was aimed. The host is what said otherwise.
  //
  // So the wiring is asserted rather than assumed: a request that can outlive a
  // minute names the budget it waits on, and a literal there is the mistake
  // wearing its original shape.
  //
  // Since WP-5b one method carries every run, and the budget is chosen by the
  // kind of workspace the surface runs in — so the assertion is on that table
  // and on the one call that uses it.
  const source = readFileSync(path.join(import.meta.dirname, "../client.mjs"), "utf8");
  const table = source.slice(source.indexOf("const RUN_BUDGETS"), source.indexOf("});", source.indexOf("const RUN_BUDGETS")));
  assert.match(table, /grant: runRequestTimeoutMs,/, "a fenced task run waits on the supervisor's run cap");
  assert.match(table, /gate: gateRequestTimeoutMs,/, "a gate run waits on the gate's budget");
  assert.doesNotMatch(table, /\d+ \* 60_000/, "a budget in the table is a literal");
  for (const surface of Object.values(driverFor("opencode").surfaces).concat(Object.values(driverFor("codex").surfaces))) {
    if (surface.transport === "batch") assert.ok(["grant", "gate"].includes(surface.workspace), surface.workspace);
  }
  const start = source.indexOf("  async run({");
  assert.notEqual(start, -1, "run must exist");
  const rest = source.slice(start);
  const body = rest.slice(0, rest.indexOf("\n  async ", 10));
  assert.match(body, /\n\s+RUN_BUDGETS\[spec\.workspace\],/, "run must wait on the named budget for its surface");
  assert.doesNotMatch(body, /\n\s+\d+ \* 60_000,/, "run passes a hard-coded timeout");
});

// ------------------------------------------------------------ driver requests
//
// The client's vendor methods are gone (WP-5b): a caller names a runtime and a
// surface, and the frame that goes out says the same. Checked over a real
// socket against a stand-in supervisor that records what it was sent.

async function withSupervisor(answer, body) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "client-driver-"));
  const socketPath = path.join(directory, "s.sock");
  const frames = [];
  const server = net.createServer((socket) => {
    const write = createFrameWriter(socket);
    const feed = createFrameReader({
      expectSequence: false,
      onMessage: (frame) => {
        if (frame.type === "hello") {
          write({ request_id: frame.request_id, ok: true, result: { protocol_version: 2, supervisor_id: "test" } });
          return;
        }
        frames.push(payloadOf(frame));
        write({ request_id: frame.request_id, ok: true, result: answer(frame) });
      },
    });
    socket.setEncoding("utf8");
    socket.on("data", feed);
    socket.on("error", () => {});
  });
  await new Promise((resolve) => server.listen(socketPath, resolve));
  const client = new RuntimeSupervisorClient({ socketPath });
  try {
    await client.connect();
    return await body(client, frames);
  } finally {
    client.close();
    server.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

test("a channel is opened by runtime and surface, and comes back as a process", async () => {
  await withSupervisor(() => ({ channel_id: "ch-1", pid: 42,
    capability_verification: { runtime: "codex", status: "verified" } }), async (client, frames) => {
    const handle = await client.open({ runtime: "codex", surface: "project", projectId: "p", grantToken: "g" });
    assert.equal(handle.channelId, "ch-1");
    assert.equal(handle.pid, 42);
    assert.equal(handle.capabilityVerification.status, "verified");
    await client.open({ runtime: "codex", surface: "gate", gateWorkspace: "/srv/infra-cod/gate-smoke/v" });
    await client.open({ runtime: "codex", surface: "account" });
    const [project, gate, account] = frames.map(({ request_id: _id, ...frame }) => frame);
    assert.deepEqual(project, { type: "runtime_open", runtime: "codex", surface: "project", project_id: "p", grant_token: "g" });
    assert.deepEqual(gate, { type: "runtime_open", runtime: "codex", surface: "gate", gate_workspace: "/srv/infra-cod/gate-smoke/v" });
    assert.deepEqual(account, { type: "runtime_open", runtime: "codex", surface: "account" });
  });
});

test("a run and an account operation name their runtime and surface, and carry only their own fields", async () => {
  await withSupervisor(() => ({ exit_code: 0 }), async (client, frames) => {
    await client.run({ runtime: "opencode", surface: "task", jobId: 7, runId: "r", projectId: "p", fencingToken: 3,
      grantToken: "g", prompt: "do", model: "m", nativeSessionId: "ses_1" });
    await client.run({ runtime: "opencode", surface: "gate", gateWorkspace: "/g", prompt: "hi", model: "m",
      interruptAfterMs: 1500 });
    await client.account({ runtime: "opencode", operation: "provider_list", provider: "opencode-go" });
    const [task, gate, account] = frames.map(({ request_id: _id, ...frame }) => frame);
    assert.deepEqual(task, { type: "runtime_run", runtime: "opencode", surface: "task", job_id: 7, run_id: "r",
      project_id: "p", fencing_token: 3, grant_token: "g", prompt: "do", model: "m", native_session_id: "ses_1",
      terminal_report_session_id: null });
    assert.deepEqual(gate, { type: "runtime_run", runtime: "opencode", surface: "gate", gate_workspace: "/g",
      model: "m", prompt: "hi", native_session_id: null, interrupt_after_ms: 1500 });
    assert.deepEqual(account, { type: "runtime_account", runtime: "opencode", surface: "account",
      operation: "provider_list", provider: "opencode-go" });
  });
});

test("an orchestrator's read-only turn carries its job, its worker, its grant and its prompt, and nothing the job says", async () => {
  await withSupervisor(() => ({ exit_code: 0 }), async (client, frames) => {
    await client.run({ runtime: "opencode", surface: "project", jobId: 9, projectId: "p", grantToken: "g",
      workerId: "orchestrator-worker-1", prompt: "plan", model: "ignored", nativeSessionId: "ignored" });
    const [{ request_id: _id, ...turn }] = frames;
    assert.deepEqual(turn, { type: "runtime_run", runtime: "opencode", surface: "project", job_id: 9, project_id: "p",
      grant_token: "g", prompt: "plan", worker_id: "orchestrator-worker-1" });
  });
});

test("a surface a driver does not have, or carries another way, is refused before a frame is sent", async () => {
  await withSupervisor(() => ({}), async (client, frames) => {
    await assert.rejects(client.open({ runtime: "opencode", surface: "task" }),
      (error) => error.code === "unsupported_surface" && /opencode's task surface is a batch, not a channel/.test(error.message));
    await assert.rejects(client.run({ runtime: "codex", surface: "project" }), (error) => error.code === "unsupported_surface");
    // Codex writes since Stage 12 X2, as a batch: its task is not a channel.
    await assert.rejects(client.open({ runtime: "codex", surface: "task" }), /codex's task surface is a batch, not a channel/);
    await assert.rejects(client.run({ runtime: "claude", surface: "account" }), /claude has no "account" surface/);
    await assert.rejects(client.account({ runtime: "codex", operation: "status" }),
      /codex's account surface is a channel, not a local_server/);
    await assert.rejects(client.open({ runtime: "antigravity", surface: "project" }), (error) => error.code === "unknown_runtime");
    assert.deepEqual(frames, []);
  });
});
