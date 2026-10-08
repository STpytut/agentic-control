import test from "node:test";
import assert from "node:assert/strict";
import { checkResult, outputTail, runProjectCheck } from "../project-check.mjs";

test("a passing check, a failing one, a stopped one and one that could not run", async () => {
  let clock = 0;
  const now = () => clock;
  const pass = await runProjectCheck({ command: "npm test", timeoutSeconds: 600, now,
    spawnCheck: async (args, { timeout }) => { assert.deepEqual(args, ["-c", "npm test"]); assert.equal(timeout, 600_000); clock += 4200; return { code: 0, stdout: "tests 12, pass 12", stderr: "" }; } });
  assert.equal(pass.status, "passed");
  assert.match(pass.detail, /passed in 4\.2 s/);
  assert.equal(pass.output, "tests 12, pass 12");

  const fail = await runProjectCheck({ command: "npm test", timeoutSeconds: 600, now,
    spawnCheck: async () => ({ code: 1, stdout: "not ok 3", stderr: "npm ERR!" }) });
  assert.equal(fail.status, "failed");
  assert.match(fail.detail, /exited 1/);
  assert.match(fail.output, /not ok 3[\s\S]*npm ERR!/);

  const stopped = await runProjectCheck({ command: "npm test", timeoutSeconds: 30, now,
    spawnCheck: async () => { throw new Error("/usr/sbin/runuser exceeded 30000 ms"); } });
  assert.equal(stopped.status, "failed");
  assert.match(stopped.detail, /did not finish within 30 s/);

  const broken = await runProjectCheck({ command: "npm test", timeoutSeconds: 30, now,
    spawnCheck: async () => { throw new Error("spawn ENOENT"); } });
  assert.equal(broken.status, "failed");
  assert.match(broken.detail, /could not run: spawn ENOENT/);
});

test("only the end of a long output is kept", () => {
  const long = "x".repeat(5000) + "SUMMARY";
  const tail = outputTail(long, "", 100);
  assert.equal(tail.length, 101);
  assert.ok(tail.endsWith("SUMMARY"));
  assert.equal(checkResult({ command: "c", code: 0, seconds: 1, timeoutSeconds: 30 }).output, "");
});
