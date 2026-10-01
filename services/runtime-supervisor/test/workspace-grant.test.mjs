import test from "node:test";
import assert from "node:assert/strict";
import { adapterFor } from "../../operations/runtime-adapters.mjs";
import { GrantRefusedError, createWorkspaceSerializer, deferReasonFor, issueWorkspaceGrant, resolveWorkspaceGrant } from "../workspace-grant.mjs";

const token = "a".repeat(64);
const projectId = "11111111-1111-4111-8111-111111111111";
const runId = "22222222-2222-4222-8222-222222222222";

const resolved = (overrides = {}) => async () => ({
  grant_id: "g", project_id: projectId, job_id: 7, run_id: runId, assignment_id: "a",
  runtime_type: "codex", mode: "read_only", fencing_token: null, expires_at: "later", ...overrides,
});
const refusedWith = (detail) => async () => {
  const error = new Error(`the workspace access grant does not hold: ${detail}`);
  error.detail = detail;
  error.code = "55000";
  throw error;
};

test("a launch without a well-formed token is refused before the database is asked", async () => {
  let asked = false;
  await assert.rejects(
    resolveWorkspaceGrant({ token: "not-a-token", projectId, expect: { runtimeType: "codex", mode: "read_only" } },
      async () => { asked = true; }),
    (error) => error instanceof GrantRefusedError && error.code === "grant_malformed" && error.retryable === false,
  );
  assert.equal(asked, false);
});

test("a busy writer is a refusal that clears on its own, and says so", async () => {
  await assert.rejects(
    resolveWorkspaceGrant({ token, projectId, expect: { runtimeType: "codex", mode: "read_only" } }, refusedWith("grant_writer_active")),
    (error) => error.code === "grant_writer_active" && error.retryable === true,
  );
});

test("a grant that is wrong does not become right by waiting", async () => {
  for (const reason of ["grant_expired", "grant_revoked", "grant_run_inactive", "grant_job_not_leased", "grant_project_mismatch", "grant_unknown", "grant_lock_not_held"]) {
    await assert.rejects(
      resolveWorkspaceGrant({ token, projectId, expect: { runtimeType: "codex", mode: "read_only" } }, refusedWith(reason)),
      (error) => error.code === reason && error.retryable === false,
      reason,
    );
  }
});

test("a failure of the check itself is not dressed up as a refusal", async () => {
  const broken = async () => { throw new Error("connection terminated unexpectedly"); };
  await assert.rejects(
    resolveWorkspaceGrant({ token, projectId, expect: { runtimeType: "codex", mode: "read_only" } }, broken),
    (error) => !(error instanceof GrantRefusedError) && /connection terminated/.test(error.message),
  );
});

test("a valid grant for a different launch is refused", async () => {
  const cases = [
    [{ project_id: "33333333-3333-4333-8333-333333333333" }, { runtimeType: "codex", mode: "read_only" }, "project"],
    [{ runtime_type: "opencode" }, { runtimeType: "codex", mode: "read_only" }, "runtime"],
    [{ mode: "read_write", fencing_token: 4 }, { runtimeType: "codex", mode: "read_only" }, "mode"],
    [{ runtime_type: "opencode", mode: "read_write", fencing_token: 4 }, { runtimeType: "opencode", mode: "read_write", runId: "44444444-4444-4444-8444-444444444444", fencingToken: 4 }, "run"],
    [{ runtime_type: "opencode", mode: "read_write", fencing_token: 4 }, { runtimeType: "opencode", mode: "read_write", runId, fencingToken: 5 }, "fencing token"],
  ];
  for (const [grant, expect, what] of cases) {
    await assert.rejects(
      resolveWorkspaceGrant({ token, projectId, expect }, resolved(grant)),
      (error) => error.code === "grant_launch_mismatch" && error.message.endsWith(what) && error.retryable === false,
      what,
    );
  }
});

test("the account comes from the adapter registry, not from the grant or the request", async () => {
  const codex = await resolveWorkspaceGrant({ token, projectId, expect: { runtimeType: "codex", mode: "read_only" } }, resolved());
  assert.equal(codex.account, adapterFor("codex").user);
  const writer = await resolveWorkspaceGrant(
    { token, projectId, expect: { runtimeType: "opencode", mode: "read_write", runId, fencingToken: "4" } },
    resolved({ runtime_type: "opencode", mode: "read_write", fencing_token: 4 }),
  );
  assert.equal(writer.account, adapterFor("opencode").user);
});

test("ownership changes of one workspace never interleave", async () => {
  const inTurn = createWorkspaceSerializer();
  const trace = [];
  const step = (name, ms) => inTurn("/srv/w1", async () => {
    trace.push(`${name}:check`);
    await new Promise((resolve) => setTimeout(resolve, ms));
    trace.push(`${name}:chown`);
  });
  await Promise.all([step("codex", 30), step("opencode", 1)]);
  assert.deepEqual(trace, ["codex:check", "codex:chown", "opencode:check", "opencode:chown"]);
});

test("different workspaces do not wait for each other, and a failed turn releases it", async () => {
  const inTurn = createWorkspaceSerializer();
  const order = [];
  const slow = inTurn("/srv/a", async () => { await new Promise((r) => setTimeout(r, 40)); order.push("a"); });
  const fast = inTurn("/srv/b", async () => { order.push("b"); });
  await Promise.all([slow, fast]);
  assert.deepEqual(order, ["b", "a"]);

  await assert.rejects(inTurn("/srv/a", async () => { throw new Error("chown failed"); }), /chown failed/);
  let ran = false;
  await inTurn("/srv/a", async () => { ran = true; });
  assert.equal(ran, true);
});

test("a worker asks for a grant without naming a mode, and a refusal comes back as a code", async () => {
  let asked;
  const grant = await issueWorkspaceGrant(7, "codex-chat-worker-1", async (sql, params) => {
    asked = { sql, params };
    return { grant_id: "g", token, mode: "read_only", run_id: runId, expires_at: "later" };
  });
  assert.equal(grant.token, token);
  assert.deepEqual(Object.keys(asked.params).sort(), ["job_id", "ttl", "worker_id"]);
  assert.doesNotMatch(asked.sql, /mode/);

  await assert.rejects(issueWorkspaceGrant(7, "w", refusedWith("grant_writer_active")),
    (error) => error instanceof GrantRefusedError && error.code === "grant_writer_active" && error.retryable === true);
  await assert.rejects(issueWorkspaceGrant(7, "w", async () => ({ grant_id: "g" })), /no grant token/);
});

test("only a busy writer and a closed fence are deferred; everything else is retried or failed", () => {
  assert.equal(deferReasonFor(new GrantRefusedError("grant_writer_active")), "grant_writer_active");
  assert.equal(deferReasonFor(Object.assign(new Error("paused"), { code: "runtime_paused" })), "runtime_paused");
  for (const code of ["grant_expired", "grant_lock_not_held", "grant_launch_mismatch", "55000", undefined]) {
    assert.equal(deferReasonFor(Object.assign(new Error("x"), { code })), null, String(code));
  }
  assert.equal(deferReasonFor(null), null);
});
