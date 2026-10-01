import test from "node:test";
import assert from "node:assert/strict";
import { INSTALL_RETRIES, nextQualification, runRuntimeUpdates, USAGE_CEILING_PERCENT } from "../runtime-updates.mjs";
import { LockError } from "../update-lock.mjs";

const NOW = Date.parse("2026-10-01T09:00:00Z");
const base = {
  active: { codex: "0.158.0", claude: "2.1.270" },
  adapterVersions: { codex: "1.2.0", claude: "1.1.0" },
  versions: [
    { runtime: "codex", version: "0.159.0", published_at: "2026-09-29T08:13:00Z" },
    { runtime: "codex", version: "0.159.2", published_at: "2026-09-30T00:04:00Z" },
    { runtime: "codex", version: "0.157.1", published_at: "2026-09-26T01:14:00Z" },
  ],
  qualifications: [],
  usage: [],
  now: NOW,
};

test("the newest version newer than the active one is qualified, at once after its publication", () => {
  assert.deepEqual(nextQualification(base), { runtime: "codex", version: "0.159.2", skipped: [] });
});

test("a version tried under this adapter is not tried again by itself; under another adapter it is", () => {
  const tried = { ...base, qualifications: [{ runtime: "codex", version: "0.159.2", adapter_version: "1.2.0", result: "failed" }] };
  assert.equal(nextQualification(tried).runtime, null);
  const older = { ...base, qualifications: [{ runtime: "codex", version: "0.159.2", adapter_version: "1.1.0", result: "passed" }] };
  assert.equal(nextQualification(older).version, "0.159.2");
});

test("a qualification that failed to install the candidate is tried again, later and a bounded number of times", () => {
  // rc.109: EXDEV moving the unpacked tree — the host's fault, not the version's.
  const failedInstall = (minutesAgo) => ({ runtime: "codex", version: "0.159.2", adapter_version: "1.2.0", result: "failed",
    summary: "the candidate could not be installed: EXDEV: cross-device link not permitted",
    finished_at: new Date(NOW - minutesAgo * 60_000).toISOString() });
  const soon = nextQualification({ ...base, qualifications: [failedInstall(5)] });
  assert.equal(soon.runtime, null);
  assert.match(soon.skipped[0].why, /could not finish/);
  const incomplete = { runtime: "codex", version: "0.159.2", adapter_version: "1.2.0", result: "incomplete",
    summary: "codex 0.159.2 checked beside 0.158.0", finished_at: new Date(NOW - 45 * 60_000).toISOString() };
  assert.equal(nextQualification({ ...base, qualifications: [incomplete] }).version, "0.159.2", "an incomplete qualification is retried");
  assert.equal(nextQualification({ ...base, qualifications: [failedInstall(45)] }).version, "0.159.2");
  const many = Array.from({ length: INSTALL_RETRIES }, (_, index) => failedInstall(60 * (index + 1)));
  assert.equal(nextQualification({ ...base, qualifications: many }).runtime, null);
  const suite = { runtime: "codex", version: "0.159.2", adapter_version: "1.2.0", result: "failed", summary: "write.commit failed",
    finished_at: new Date(NOW - 3600_000).toISOString() };
  assert.equal(nextQualification({ ...base, qualifications: [suite] }).runtime, null, "a version that failed its suite is not retried by itself");
});

test("nothing is qualified while the subscription is at the ceiling, or while a qualification runs", () => {
  const full = { ...base, usage: [{ runtime: "codex", read_at: "2026-10-01T08:30:00Z",
    windows: [{ key: "primary", used_percent: 12 }, { key: "secondary", used_percent: USAGE_CEILING_PERCENT }] }] };
  const waiting = nextQualification(full);
  assert.equal(waiting.runtime, null);
  assert.match(waiting.skipped[0].why, /secondary window is at 80/);
  const stale = { ...full, usage: [{ ...full.usage[0], read_at: "2026-09-30T01:00:00Z" }] };
  assert.equal(nextQualification(stale).version, "0.159.2", "a reading hours old does not hold an update back");
  const running = { ...base, qualifications: [{ runtime: "codex", version: "0.159.0", adapter_version: "1.2.0", result: "running" }] };
  assert.equal(nextQualification(running).runtime, null);
});

function harness({ request = null, qualifyResult = { result: "passed", summary: "" }, throwOn = null } = {}) {
  const sql = [];
  const calls = [];
  const db = async (statement, params) => {
    sql.push({ statement, params });
    if (statement.includes("claim_runtime_update_request")) return request;
    if (statement.includes("FROM runtime_versions")) return base.versions;
    if (statement.includes("FROM runtime_qualifications")) return [];
    if (statement.includes("provider_usage_readings")) return [];
    return null;
  };
  const steps = [];
  const out = [];
  return {
    sql, calls, steps, out,
    run: (apply = true) => runRuntimeUpdates({
      apply, db, close: async () => {}, reporter: { step: (line) => steps.push(line) }, stdout: { write: (text) => out.push(text) },
      activeVersions: () => ({ codex: "0.158.0" }),
      qualify: async (args) => { calls.push(["qualify", args]); if (throwOn) throw throwOn; return qualifyResult; },
      promote: async (args) => { calls.push(["promote", args]); if (throwOn) throw throwOn; return { from: "0.158.0", version: args.version }; },
    }),
  };
}

test("a Promote pressed in the panel is promoted and its outcome written back", async () => {
  const h = harness({ request: { id: "r1", runtime: "codex", version: "0.159.2", kind: "promote", requested_by: "operator:x" } });
  await h.run();
  assert.deepEqual(h.calls.map(([kind, args]) => [kind, args.name, args.version]), [["promote", "codex", "0.159.2"]]);
  const finish = h.sql.find((call) => call.statement.includes("finish_runtime_update_request"));
  assert.match(finish.params.message, /0\.158\.0 → 0\.159\.2/);
  assert.ok(!h.calls.some(([kind]) => kind === "qualify"), "one action a pass");
});

test("a Qualify pressed in the panel reports its result; a busy host puts the request back", async () => {
  const failed = harness({ request: { id: "r2", runtime: "codex", version: "0.159.2", kind: "qualify" }, qualifyResult: { result: "failed", summary: "write.commit failed" } });
  await failed.run();
  const finish = failed.sql.find((call) => call.statement.includes("finish_runtime_update_request"));
  assert.equal(finish.params.ok, "false");
  assert.match(finish.params.message, /failed — write.commit failed/);

  const busy = harness({ request: { id: "r3", runtime: "codex", version: "0.159.2", kind: "promote" }, throwOn: new LockError("held") });
  await busy.run();
  assert.ok(busy.sql.some((call) => call.statement.includes("defer_runtime_update_request")));
  assert.ok(!busy.sql.some((call) => call.statement.includes("finish_runtime_update_request")));
});

test("with no request, the newer version is qualified on its own — and only said without --apply", async () => {
  const h = harness();
  await h.run();
  assert.deepEqual(h.calls.map(([kind, args]) => [kind, args.version, args.actor]), [["qualify", "0.159.2", "auto-qualify"]]);
  const dry = harness();
  await dry.run(false);
  assert.deepEqual(dry.calls, []);
  assert.match(dry.out.join(""), /would qualify codex 0\.159\.2/);
});

test("a Promote pressed twice: the second finds it done and says so, not failed", async () => {
  const h = harness({ request: { id: "r4", runtime: "claude", version: "2.1.286", kind: "promote" },
    throwOn: new Error("claude 2.1.286 is already the active version") });
  await h.run();
  const finish = h.sql.find((call) => call.statement.includes("finish_runtime_update_request"));
  assert.match(finish.statement, /,true,/);
  assert.match(finish.params.message, /already active/);
});
