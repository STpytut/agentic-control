import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { provisionOnce } from "../project-provisioner.mjs";
import { queryJson, query, closePool } from "../db.mjs";

// Drives the coordination the provisioner now depends on: it requests a
// workspace operation and waits, and a supervisor elsewhere completes it. The
// real supervisor cannot run here — it needs root and the runtime users — so
// this stands in for it, which is enough to prove the handshake rather than the
// filesystem work.
// Skipped only when DATABASE_URL is genuinely unavailable.

const skip = process.env.DATABASE_URL ? false : "DATABASE_URL is not set";

// Runs against a scratch database rather than cleaning up after itself.
// domain_events and audit_events are append-only by design, so the rows this
// test creates cannot be deleted, and the project cannot be deleted while they
// reference it. Subverting that invariant to tidy up would be worse than
// isolating; an earlier version swallowed the resulting errors and quietly left
// three projects behind for the next run to pick up as real work.
const scratch = `infra_cod_coord_${randomUUID().slice(0, 8).replace(/-/g, "")}`;
const psqlBin = process.env.PSQL_BIN ?? "psql";
const root = path.resolve(import.meta.dirname, "../../..");

function adminUrl(database) {
  const url = new URL(process.env.DATABASE_URL);
  url.pathname = `/${database}`;
  return url.toString();
}

if (!skip) {
  const maintenance = adminUrl("postgres");
  execFileSync(psqlBin, ["-X", "-qAt", "-v", "ON_ERROR_STOP=1", maintenance,
    "-c", `CREATE DATABASE ${scratch};`], { stdio: "ignore" });
  const scratchUrl = adminUrl(scratch);
  execFileSync(process.execPath, [path.join(root, "services/control-plane/migrate.mjs")],
    { env: { ...process.env, DATABASE_URL: scratchUrl }, stdio: "ignore" });
  // db.mjs resolves DATABASE_URL when the pool is first used, not at import,
  // so pointing it here is enough for everything below.
  process.env.DATABASE_URL = scratchUrl;
}

test.after(async () => {
  if (skip) return;
  await closePool();
  execFileSync(psqlBin, ["-X", "-qAt", "-v", "ON_ERROR_STOP=1", adminUrl("postgres"),
    "-c", `DROP DATABASE IF EXISTS ${scratch} WITH (FORCE);`], { stdio: "ignore" });
});

async function seedProject() {
  const owner = await queryJson(
    `INSERT INTO users(display_name) VALUES('Provisioner Coordination')
     RETURNING jsonb_build_object('id',id)::text;`);
  const projectId = randomUUID();
  await queryJson(
    `INSERT INTO projects(id,owner_id,name,slug,workspace_path,default_branch,status,settings,credential_mode)
     VALUES(:'id'::uuid,:'owner'::uuid,'Coordination','coord-'||left(:'id'::text,8),
            '/srv/test/'||:'id'::text,'main','needs_attention',
            '{"provisioning_status":"pending"}'::jsonb,'empty')
     RETURNING jsonb_build_object('id',id)::text;`,
    { id: projectId, owner: owner.id });
  await query(`INSERT INTO workspace_locks(project_id) VALUES(:'id'::uuid);`, { id: projectId });
  return { projectId, ownerId: owner.id };
}

// Stands in for the Runtime Supervisor: claims the pending operation and
// finishes it with the given result.
async function completeNextOperation(projectId, { success = true, result = {}, error = null } = {}) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const claimed = await queryJson(
      `SELECT claim_workspace_operation('fake-supervisor')::text;`);
    if (claimed && claimed.project_id === projectId) {
      await queryJson(
        `SELECT finish_workspace_operation(
           :'id'::uuid,'fake-supervisor',:'ok'::boolean,:'result'::jsonb,NULLIF(:'error',''))::text;`,
        { id: claimed.id, ok: String(success), result: JSON.stringify(result), error: error ?? "" });
      return claimed;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("no workspace operation was requested");
}

test("provisioning waits for the supervisor and then activates the project", { skip }, async () => {
  const seeded = await seedProject();
  try {
    const running = provisionOnce();
    const claimed = await completeNextOperation(seeded.projectId,
      { result: { owner: "codex-worker", recreated: true, steps: ["init", "seed"] } });

    assert.equal(claimed.operation_type, "provision_workspace");
    // Everything the supervisor needs comes from the claim, not from the request.
    assert.equal(claimed.workspace_path, `/srv/test/${seeded.projectId}`);
    assert.equal(claimed.default_branch, "main");

    const outcome = await running;
    assert.equal(outcome.claimed, true);
    assert.equal(outcome.error, undefined, `provisioning failed: ${outcome.error}`);

    const project = await queryJson(
      `SELECT jsonb_build_object('status',status,'provisioning',settings->>'provisioning_status')::text
       FROM projects WHERE id=:'id'::uuid;`, { id: seeded.projectId });
    assert.equal(project.status, "active");
    assert.equal(project.provisioning, "ready");
  } finally {
    // Archived so a later test in this file cannot claim it as pending work.
    await query(`UPDATE projects SET status='archived' WHERE id=:'id'::uuid;`,
      { id: seeded.projectId });
  }
});

test("a failed workspace operation leaves the project needing attention", { skip }, async () => {
  const seeded = await seedProject();
  try {
    const running = provisionOnce();
    await completeNextOperation(seeded.projectId,
      { success: false, error: "clone failed: repository not found" });

    const outcome = await running;
    assert.match(outcome.error ?? "", /repository not found/,
      "the supervisor's error did not reach the provisioner");

    const project = await queryJson(
      `SELECT jsonb_build_object('status',status,'provisioning',settings->>'provisioning_status',
         'error',settings->>'provisioning_error')::text
       FROM projects WHERE id=:'id'::uuid;`, { id: seeded.projectId });
    assert.equal(project.status, "needs_attention");
    assert.equal(project.provisioning, "failed");
    assert.match(project.error, /repository not found/);
  } finally {
    // Archived so a later test in this file cannot claim it as pending work.
    await query(`UPDATE projects SET status='archived' WHERE id=:'id'::uuid;`,
      { id: seeded.projectId });
  }
});

test("a project already being worked on is released rather than failed", { skip }, async () => {
  // One operation per project is a database invariant. Hitting it means the
  // supervisor is busy, not that provisioning failed, so the project must go
  // back to pending for the next cycle instead of being marked needs_attention.
  const seeded = await seedProject();
  try {
    await queryJson(
      `SELECT request_workspace_provisioning(:'id'::uuid,'inspect_workspace','someone-else')::text;`,
      { id: seeded.projectId });

    const outcome = await provisionOnce();
    assert.equal(outcome.busy, true, "a conflicting operation was not reported as busy");

    const project = await queryJson(
      `SELECT jsonb_build_object('status',status,'provisioning',settings->>'provisioning_status')::text
       FROM projects WHERE id=:'id'::uuid;`, { id: seeded.projectId });
    assert.equal(project.status, "needs_attention");
    assert.equal(project.provisioning, "pending",
      "the project was not released back for the next cycle");
  } finally {
    // Archived so a later test in this file cannot claim it as pending work.
    await query(`UPDATE projects SET status='archived' WHERE id=:'id'::uuid;`,
      { id: seeded.projectId });
  }
});
