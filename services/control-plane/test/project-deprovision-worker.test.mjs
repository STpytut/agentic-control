import test from "node:test";
import assert from "node:assert/strict";
import { releaseCleanupClaim } from "../project-deprovision-worker.mjs";

const project = { project_id: "3f2504e0-4f89-11d3-9a0c-0305e82c3301" };

test("reports cleanup deferred only after the lease was actually released", async () => {
  const result = await releaseCleanupClaim(project, "busy", async () => ({ released: true }));
  assert.equal(result.kind, "project_cleanup_deferred");
});

test("does not mask a release query failure as deferred", async () => {
  const result = await releaseCleanupClaim(project, "busy", async () => {
    throw new Error("database unavailable");
  });
  assert.equal(result.kind, "project_cleanup_release_failed");
  assert.match(result.error, /database unavailable/);
});

test("reports a lost lease instead of claiming it was deferred", async () => {
  const result = await releaseCleanupClaim(project, "busy", async () => null);
  assert.equal(result.kind, "project_cleanup_lease_lost");
});
