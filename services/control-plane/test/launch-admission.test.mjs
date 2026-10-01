import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";

// Launch-admission integration test: a live `launching` reservation must be
// visible to the deprovision writer scan (fail-closed), so cleanup cannot
// enter the filesystem phase between reserve_runtime_launch and
// complete_runtime_launch. Also proves reserve fails for a deleting project.
// Skipped only when DATABASE_URL or psql is genuinely unavailable.

const databaseUrl = process.env.DATABASE_URL;
const psqlBin = process.env.PSQL_BIN ?? "psql";
let hasPsql = false;
try {
  execFileSync("sh", ["-c", `command -v ${JSON.stringify(psqlBin)}`], { stdio: "ignore" });
  hasPsql = true;
} catch {}

function runPsql(sql) {
  return new Promise((resolve, reject) => {
    const child = spawn(psqlBin, [databaseUrl, "-X", "-qAt", "-v", "ON_ERROR_STOP=1", "-c", sql], {
      env: { ...process.env, DATABASE_URL: databaseUrl },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.once("close", (code) => code === 0 ? resolve(stdout.trim()) : reject(new Error(stderr.trim() || `psql exited ${code}`)));
  });
}

async function cleanupAdmissionFixture(slug, ownerName, model, agentPrefix) {
  await runPsql(`SET search_path TO control_plane,public,extensions;
    DELETE FROM runtime_launch_reservations WHERE project_id=(SELECT id FROM projects WHERE slug='${slug}');
    DELETE FROM runtime_activity_events WHERE project_id=(SELECT id FROM projects WHERE slug='${slug}');
    DELETE FROM runtime_jobs WHERE project_id=(SELECT id FROM projects WHERE slug='${slug}');
    DELETE FROM handoffs WHERE task_id IN (SELECT id FROM tasks WHERE project_id=(SELECT id FROM projects WHERE slug='${slug}'));
    DELETE FROM task_runs WHERE task_id IN (SELECT id FROM tasks WHERE project_id=(SELECT id FROM projects WHERE slug='${slug}'));
    DELETE FROM outbox_messages WHERE event_id IN (SELECT id FROM domain_events WHERE project_id=(SELECT id FROM projects WHERE slug='${slug}'));
    -- Past the append-only trigger for this session only. ALTER TABLE ... DISABLE
    -- TRIGGER took an exclusive lock on the table, queued behind any other test's
    -- open transaction, and every writer queued behind it: that was the
    -- conversation-order flake (sprint B, B0).
    SET session_replication_role = replica;
    DELETE FROM domain_events WHERE project_id=(SELECT id FROM projects WHERE slug='${slug}');
    SET session_replication_role = origin;
    DELETE FROM task_runtime_snapshots WHERE task_id IN (SELECT id FROM tasks WHERE project_id=(SELECT id FROM projects WHERE slug='${slug}'));
    DELETE FROM task_executor_assignments WHERE task_id IN (SELECT id FROM tasks WHERE project_id=(SELECT id FROM projects WHERE slug='${slug}'));
    DELETE FROM tasks WHERE project_id=(SELECT id FROM projects WHERE slug='${slug}');
    DELETE FROM conversations WHERE project_id=(SELECT id FROM projects WHERE slug='${slug}');
    DELETE FROM project_agent_assignments WHERE project_id=(SELECT id FROM projects WHERE slug='${slug}');
    -- Past the append-only trigger for this session only. ALTER TABLE ... DISABLE
    -- TRIGGER took an exclusive lock on the table, queued behind any other test's
    -- open transaction, and every writer queued behind it: that was the
    -- conversation-order flake (sprint B, B0).
    SET session_replication_role = replica;
    DELETE FROM audit_events WHERE project_id=(SELECT id FROM projects WHERE slug='${slug}');
    SET session_replication_role = origin;
    DELETE FROM projects WHERE slug='${slug}';
    DELETE FROM agents WHERE name='${agentPrefix}' || replace('${slug}'::text,'-','');
    DELETE FROM runtime_profiles rp WHERE rp.model='${model}' AND NOT EXISTS(
      SELECT 1 FROM agents a WHERE a.runtime_profile_id=rp.id
    );
    DELETE FROM users WHERE display_name='${ownerName}';`);
}

test("launch reservation blocks the deprovision writer scan until cleared", { skip: !databaseUrl || !hasPsql }, async (t) => {
  const slug = `admission-race-${Date.now()}-${Math.floor(Math.random() * 100000)}`;
  t.after(() => cleanupAdmissionFixture(
    slug, "Admission race owner", "admission-race-codex", "admission-race-orchestrator-",
  ));
  const setup = await runPsql(`
    SET search_path TO control_plane,public,extensions;
    BEGIN;
    DO \$\$
    DECLARE v_owner uuid; v_project uuid; v_task uuid; v_event uuid; v_job bigint; v_run uuid;
    BEGIN
      INSERT INTO users(display_name) VALUES('Admission race owner') RETURNING id INTO v_owner;
      INSERT INTO projects(owner_id,name,slug,workspace_path,default_branch)
      VALUES(v_owner,'Admission race','${slug}','/fixture/workspaces/${slug}','main')
      RETURNING id INTO v_project;
      INSERT INTO runtime_profiles(runtime_type,adapter_version,runtime_version,provider_type,model,enabled)
      VALUES('codex','0.5.0','0.5.0','openai','admission-race-codex',true)
      ON CONFLICT DO NOTHING;
      INSERT INTO agents(name,role,runtime_profile_id)
      SELECT 'admission-race-orchestrator-' || replace('${slug}'::text,'-',''),'architect',rp.id
      FROM runtime_profiles rp WHERE rp.model='admission-race-codex' AND rp.enabled LIMIT 1;
      INSERT INTO project_agent_assignments(project_id,agent_id,runtime_profile_id,assignment_role,is_default)
      SELECT v_project,a.id,a.runtime_profile_id,'orchestrator',true
      FROM agents a WHERE a.name='admission-race-orchestrator-' || replace('${slug}'::text,'-','') AND a.enabled LIMIT 1;
      INSERT INTO tasks(project_id,title,objective,status,created_by)
      VALUES(v_project,'Admission race task','Objective','ready',v_owner::text)
      RETURNING id INTO v_task;
      INSERT INTO domain_events(
        event_type,project_id,task_id,actor_type,actor_id,
        correlation_id,aggregate_type,aggregate_id,aggregate_version,payload
      ) VALUES('implementation.requested',v_project,v_task,'system','race',
        'race-correlation','task',v_task,1,'{}'::jsonb)
      RETURNING id INTO v_event;
      INSERT INTO runtime_jobs(source_event_id,job_type,project_id,task_id,payload)
      VALUES(v_event,'implementation_run',v_project,v_task,'{}'::jsonb)
      RETURNING id INTO v_job;
      UPDATE runtime_jobs SET status='in_flight', leased_by='admission-race-supervisor',
        leased_until=clock_timestamp()+interval '2 minutes' WHERE id=v_job;
      INSERT INTO task_runs(task_id,agent_id,phase,status,write_capable,workspace_fencing_token)
      SELECT v_task,pa.agent_id,'running','running',true,1
      FROM project_agent_assignments pa
      WHERE pa.project_id=v_project AND pa.assignment_role='orchestrator' LIMIT 1
      RETURNING id INTO v_run;
      UPDATE runtime_jobs SET run_id=v_run WHERE id=v_job;
      PERFORM reserve_runtime_launch(v_run,v_project,v_job,'admission-race-supervisor',interval '90 seconds');
      PERFORM request_project_deletion(v_project,v_owner,1,'race-delete',true);
    END \$\$;
    COMMIT;
  `);

  // Deprovision scan must see the live reservation as an active writer.
  const reservations = await runPsql(`SET search_path TO control_plane,public,extensions;
    SELECT count(*) FROM runtime_launch_reservations
    WHERE project_id=(SELECT id FROM projects WHERE slug='${slug}')
      AND state='reserved' AND expires_at>clock_timestamp();`);
  assert.equal(Number(reservations), 1, "the live reservation must be visible");

  // And the supervisor's scan query (used by deprovision_project) returns it.
  const scan = await runPsql(`SET search_path TO control_plane,public,extensions;
    SELECT count(*) FROM runtime_launch_reservations res
    WHERE res.project_id=(SELECT id FROM projects WHERE slug='${slug}')
      AND res.state='reserved' AND res.expires_at>clock_timestamp();`);
  assert.equal(Number(scan), 1, "the deprovision scan query must return the reservation");

  // A new reservation cannot be registered for the deleting project.
  await assert.rejects(
    runPsql(`SET search_path TO control_plane,public,extensions;
      SELECT reserve_runtime_launch(
        (SELECT id FROM task_runs WHERE task_id=(SELECT id FROM tasks WHERE project_id=(SELECT id FROM projects WHERE slug='${slug}')) LIMIT 1),
        (SELECT id FROM projects WHERE slug='${slug}'),
        (SELECT id FROM runtime_jobs WHERE project_id=(SELECT id FROM projects WHERE slug='${slug}') LIMIT 1),
        'admission-race-supervisor', interval '90 seconds');`),
    /being deleted/,
  );

});

test("reserve-vs-delete is serialized by the project row lock (two sessions)", { skip: !databaseUrl || !hasPsql }, async (t) => {
  const slug = `admission-lock-${Date.now()}-${Math.floor(Math.random() * 100000)}`;
  t.after(() => cleanupAdmissionFixture(
    slug, "Admission lock owner", "admission-lock-codex", "admission-lock-orchestrator-",
  ));
  await runPsql(`
    SET search_path TO control_plane,public,extensions;
    BEGIN;
    DO \$\$
    DECLARE v_owner uuid; v_project uuid; v_task uuid; v_event uuid; v_job bigint; v_run uuid;
    BEGIN
      INSERT INTO users(display_name) VALUES('Admission lock owner') RETURNING id INTO v_owner;
      INSERT INTO projects(owner_id,name,slug,workspace_path,default_branch)
      VALUES(v_owner,'Admission lock','${slug}','/fixture/workspaces/${slug}','main')
      RETURNING id INTO v_project;
      INSERT INTO runtime_profiles(runtime_type,adapter_version,runtime_version,provider_type,model,enabled)
      VALUES('codex','0.5.0','0.5.0','openai','admission-lock-codex',true)
      ON CONFLICT DO NOTHING;
      INSERT INTO agents(name,role,runtime_profile_id)
      SELECT 'admission-lock-orchestrator-' || replace('${slug}'::text,'-',''),'architect',rp.id
      FROM runtime_profiles rp WHERE rp.model='admission-lock-codex' AND rp.enabled LIMIT 1;
      INSERT INTO project_agent_assignments(project_id,agent_id,runtime_profile_id,assignment_role,is_default)
      SELECT v_project,a.id,a.runtime_profile_id,'orchestrator',true
      FROM agents a WHERE a.name='admission-lock-orchestrator-' || replace('${slug}'::text,'-','') AND a.enabled LIMIT 1;
      INSERT INTO tasks(project_id,title,objective,status,created_by)
      VALUES(v_project,'Admission lock task','Objective','ready',v_owner::text)
      RETURNING id INTO v_task;
      INSERT INTO domain_events(
        event_type,project_id,task_id,actor_type,actor_id,
        correlation_id,aggregate_type,aggregate_id,aggregate_version,payload
      ) VALUES('implementation.requested',v_project,v_task,'system','lock',
        'lock-correlation','task',v_task,1,'{}'::jsonb)
      RETURNING id INTO v_event;
      INSERT INTO runtime_jobs(source_event_id,job_type,project_id,task_id,payload)
      VALUES(v_event,'implementation_run',v_project,v_task,'{}'::jsonb)
      RETURNING id INTO v_job;
      UPDATE runtime_jobs SET status='in_flight', leased_by='admission-lock-supervisor',
        leased_until=clock_timestamp()+interval '2 minutes' WHERE id=v_job;
      INSERT INTO task_runs(task_id,agent_id,phase,status,write_capable,workspace_fencing_token)
      SELECT v_task,pa.agent_id,'running','running',true,1
      FROM project_agent_assignments pa
      WHERE pa.project_id=v_project AND pa.assignment_role='orchestrator' LIMIT 1
      RETURNING id INTO v_run;
      UPDATE runtime_jobs SET run_id=v_run WHERE id=v_job;
      -- No direct reservation insert here: the holder session reserves.
    END \$\$;
    COMMIT;
  `);

  // Session A holds the project row lock (reserve), session B must block on
  // request_project_deletion until A commits. A transaction-level advisory
  // marker, acquired only after reserve returns, lets a third session prove
  // that the holder reached this point without relying on buffered psql
  // stdout.
  const holder = spawn(psqlBin, [databaseUrl, "-X", "-qAt", "-v", "ON_ERROR_STOP=1", "-c", `
    SET search_path TO control_plane,public,extensions;
    BEGIN;
    SELECT reserve_runtime_launch(
      (SELECT id FROM task_runs WHERE task_id=(SELECT id FROM tasks WHERE project_id=(SELECT id FROM projects WHERE slug='${slug}')) LIMIT 1),
      (SELECT id FROM projects WHERE slug='${slug}'),
      (SELECT id FROM runtime_jobs WHERE project_id=(SELECT id FROM projects WHERE slug='${slug}') LIMIT 1),
      'admission-lock-supervisor', interval '90 seconds');
    SELECT pg_advisory_xact_lock(hashtextextended('${slug}',0));
    SELECT pg_sleep(3);
    COMMIT;`], {
    env: { ...process.env, DATABASE_URL: databaseUrl },
  });
  let holderErr = "";
  let holderOut = "";
  holder.stdout.on("data", (c) => (holderOut += c));
  holder.stderr.on("data", (c) => (holderErr += c));

  // Wait until the advisory marker is held. If pg_try_advisory_lock succeeds,
  // release it in the same statement and keep polling; a true result means
  // session A owns it and therefore has already reserved the launch while its
  // transaction (and project row lock) remains open.
  let holderReady = false;
  const lockDeadline = Date.now() + 5000;
  while (Date.now() < lockDeadline) {
    const markerHeld = await runPsql(`
      WITH attempt AS (
        SELECT pg_try_advisory_lock(hashtextextended('${slug}',0)) AS acquired
      )
      SELECT CASE WHEN acquired
        THEN NOT pg_advisory_unlock(hashtextextended('${slug}',0))
        ELSE true END
      FROM attempt;`);
    if (markerHeld === "t") { holderReady = true; break; }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(holderReady, true,
    `holder never acquired the lock: err=${holderErr.slice(0, 300)} out=${holderOut.slice(0, 300)}`);

  const blocked = spawn(psqlBin, [databaseUrl, "-X", "-qAt", "-v", "ON_ERROR_STOP=1", "-c", `
    SET search_path TO control_plane,public,extensions;
    SELECT request_project_deletion(
      (SELECT id FROM projects WHERE slug='${slug}'),
      (SELECT id FROM users WHERE display_name='Admission lock owner' ORDER BY created_at DESC LIMIT 1),
      1, 'lock-delete', true);`], {
    env: { ...process.env, DATABASE_URL: databaseUrl },
  });
  let blockedDone = false;
  let blockedOut = "";
  let blockedErr = "";
  blocked.stdout.on("data", (c) => (blockedOut += c));
  blocked.stderr.on("data", (c) => (blockedErr += c));
  blocked.once("close", (code) => { blockedDone = true; blocked.code = code; });

  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.equal(blockedDone, false,
    `request_project_deletion must block while reserve holds the row lock (holderErr=${holderErr.slice(0, 200)}, holderOut=${holderOut.slice(0, 120)})`);

  // Commit the holder; the blocked deletion now proceeds and sees an
  // unchanged (active) project, so it is serialized after reserve.
  holder.stdout.on("data", () => undefined);
  holder.stderr.on("data", () => undefined);
  holder.once("close", () => undefined);
  const holderExit = await new Promise((resolve) => holder.once("close", resolve));
  assert.equal(holderExit, 0, "reserve holder failed");

  const blockedExit = await new Promise((resolve) => blocked.once("close", resolve));
  assert.equal(blockedExit, 0, `blocked deletion failed: ${blockedErr}`);
  assert.equal(blockedDone, true);

  // After the deletion committed, a fresh reserve for the same run fails
  // (the project is now deleting) — proving both directions serialize.
  await assert.rejects(
    runPsql(`SET search_path TO control_plane,public,extensions;
      SELECT reserve_runtime_launch(
        (SELECT id FROM task_runs WHERE task_id=(SELECT id FROM tasks WHERE project_id=(SELECT id FROM projects WHERE slug='${slug}')) LIMIT 1),
        (SELECT id FROM projects WHERE slug='${slug}'),
        (SELECT id FROM runtime_jobs WHERE project_id=(SELECT id FROM projects WHERE slug='${slug}') LIMIT 1),
        'admission-lock-supervisor', interval '90 seconds');`),
    /being deleted/,
  );

});
