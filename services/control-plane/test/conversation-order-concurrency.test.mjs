import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";

// Two writers in one conversation (ADR-0014, migration 0063). Writer A appends
// to the parent task and keeps its transaction open; writer B appends to the
// follow-up, reads the clock, and waits on the conversation A holds; only then
// does A append again and commit. B's clock reading falls between A's two
// events, but B can only take its number after A commits. The chat must show
// A, A, B — the order the conversation received them — where an order by
// occurred_at shows A, B, A.
//
// Each step waits for the one before it in pg_stat_activity rather than for a
// timer: a timer passed on a fast machine and lost the race in the gate's
// emulated container, where starting psql alone took longer.
// "B waits on a lock" was not enough either: B can wait a moment on an
// unrelated lock before it reads the clock. A continues only once B is blocked
// by A's own transaction, which is the conversation row — on a transaction id
// or on the row's tuple, whichever PostgreSQL reports: the gate once saw neither
// match `transactionid` alone.
// Skipped only when DATABASE_URL or psql is genuinely unavailable.

const databaseUrl = process.env.DATABASE_URL;
const psqlBin = process.env.PSQL_BIN ?? "psql";
let hasPsql = false;
try {
  execFileSync("sh", ["-c", `command -v ${JSON.stringify(psqlBin)}`], { stdio: "ignore" });
  hasPsql = true;
} catch {}

function runPsql(sql, appName = "order-race") {
  return new Promise((resolve, reject) => {
    const child = spawn(psqlBin, [databaseUrl, "-X", "-qAt", "-v", "ON_ERROR_STOP=1", "-c", sql], {
      env: { ...process.env, PGAPPNAME: appName },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.once("close", (code) => code === 0 ? resolve(stdout.trim()) : reject(new Error(stderr.trim() || `psql exited ${code}`)));
  });
}

const PATH = "SET search_path TO control_plane,public,extensions;";
// Each run names its own fixture and its own sessions.
const RUN = `order-race-${process.pid}-${Date.now()}`;
const append = (task, label, version) => `SELECT append_event('chat.user_message',t.project_id,t.id,NULL,'user','order-race',NULL,'order-race',
    'order-race-${label}-'||gen_random_uuid(),'task',t.id,${version},jsonb_build_object('content','${label}'))
  FROM tasks t WHERE t.title='order-race-${task}' AND t.created_by='${RUN}';`;
// Blocks inside the calling transaction until another session matches.
const waitFor = (condition, what) => `DO $$
  BEGIN
    FOR i IN 1..400 LOOP
      IF EXISTS (SELECT 1 FROM pg_stat_activity WHERE ${condition}) THEN RETURN; END IF;
      PERFORM pg_sleep(0.05);
      -- Inside a transaction pg_stat_activity is a snapshot taken once.
      PERFORM pg_stat_clear_snapshot();
    END LOOP;
    RAISE EXCEPTION 'gave up waiting: ${what}';
  END $$;`;

test("the conversation orders events by when it received them, not by the writers' clocks", { skip: !databaseUrl || !hasPsql }, async () => {
  await runPsql(`${PATH}
    DO $$
    DECLARE v_owner uuid; v_project uuid; v_parent uuid;
    BEGIN
      INSERT INTO users(display_name) VALUES('${RUN}') RETURNING id INTO v_owner;
      INSERT INTO projects(owner_id,name,slug,workspace_path)
        VALUES(v_owner,'Order race','${RUN}','/srv/${RUN}') RETURNING id INTO v_project;
      INSERT INTO tasks(project_id,title,objective,status,created_by)
        VALUES(v_project,'order-race-parent','x','approved','${RUN}') RETURNING id INTO v_parent;
      INSERT INTO tasks(project_id,title,objective,status,created_by,followup_of_task_id)
        VALUES(v_project,'order-race-followup','x','planning','${RUN}',v_parent);
    END $$;`);

  try {
    const writerA = runPsql(`${PATH} BEGIN;
      ${append("parent", "A1", 1)}
      SELECT set_config('application_name','${RUN}-A-holding',false);
      ${waitFor(`application_name='${RUN}-B' AND wait_event_type='Lock' AND pg_backend_pid()=ANY(pg_blocking_pids(pid))`, "B blocked by A")}
      ${append("parent", "A2", 2)}
      COMMIT;`, `${RUN}-A`);
    // B starts only once A has appended A1 and holds the conversation.
    await runPsql(waitFor(`application_name='${RUN}-A-holding'`, "A holding the conversation"), `${RUN}-watch`);
    const writerB = runPsql(`${PATH} ${append("followup", "B", 1)}`, `${RUN}-B`);
    await Promise.all([writerA, writerB]);

    // The order the panel reads the chat in (apps/web/src/lib/product-data.ts).
    const bySequence = await runPsql(`${PATH}
      SELECT string_agg(e.payload->>'content', ',' ORDER BY e.conversation_sequence)
      FROM domain_events e JOIN tasks t ON t.id=e.task_id
      WHERE t.created_by='${RUN}' AND e.conversation_id=t.conversation_id;`);
    assert.equal(bySequence, "A1,A2,B", "the conversation did not keep the order it received events in");

    const byClock = await runPsql(`${PATH}
      SELECT string_agg(e.payload->>'content', ',' ORDER BY e.occurred_at)
      FROM domain_events e JOIN tasks t ON t.id=e.task_id WHERE t.created_by='${RUN}';`);
    assert.equal(byClock, "A1,B,A2", "the writers' clocks were expected to disagree with the conversation order");

    const numbers = await runPsql(`${PATH}
      SELECT string_agg(e.conversation_sequence::text, ',' ORDER BY e.conversation_sequence)
        || '|' || count(DISTINCT e.conversation_id)
        || '|' || (SELECT c.last_sequence FROM conversations c JOIN tasks t ON t.conversation_id=c.id
                   WHERE t.title='order-race-parent' AND t.created_by='${RUN}')
      FROM domain_events e JOIN tasks t ON t.id=e.task_id WHERE t.created_by='${RUN}';`);
    assert.equal(numbers, "1,2,3|1|3", "numbers are not one gapless sequence of one conversation");
  } finally {
    await runPsql(`${PATH}
      DELETE FROM outbox_messages WHERE event_id IN (SELECT id FROM domain_events WHERE project_id=(SELECT id FROM projects WHERE slug='${RUN}'));
      -- Past the append-only trigger for this session only. ALTER TABLE ... DISABLE
      -- TRIGGER took an exclusive lock on the table, queued behind any other test's
      -- open transaction, and every writer queued behind it: that was the
      -- conversation-order flake (sprint B, B0).
      SET session_replication_role = replica;
      DELETE FROM domain_events WHERE project_id=(SELECT id FROM projects WHERE slug='${RUN}');
      SET session_replication_role = origin;
      DELETE FROM tasks WHERE project_id=(SELECT id FROM projects WHERE slug='${RUN}') AND followup_of_task_id IS NOT NULL;
      DELETE FROM tasks WHERE project_id=(SELECT id FROM projects WHERE slug='${RUN}');
      DELETE FROM conversations WHERE project_id=(SELECT id FROM projects WHERE slug='${RUN}');
      DELETE FROM projects WHERE slug='${RUN}';
      DELETE FROM users WHERE display_name='${RUN}';`).catch(() => undefined);
  }
});
