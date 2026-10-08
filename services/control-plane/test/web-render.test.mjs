// The panel's pages render (rc.137).
//
// rc.136 handed a function from a server page to a client component; React
// cannot serialise one, and every chat with a task answered "This page couldn't
// load". The data loaders all worked — the post-update self-test runs those,
// and passed — so nothing that checks data could see it. This renders the pages
// themselves: a real panel against a scratch database, signed in as its owner,
// connected as `infra_web` as on the host, and every page shape the operator
// opens — the project list, a project's start, a chat with a task running, a
// chat with a review and an analyst's answer, the project's settings pages and
// the operator's — must answer 200 without the error page.
//
// It starts `next dev` against apps/web, like route-authorization.test.mjs, and
// shares its build directory: the two never run at the same time.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "../../..");
const databaseUrl = process.env.DATABASE_URL;
const pepper = process.env.INFRA_COD_AUTH_PEPPER ?? "web-render-test-pepper";
const skip = databaseUrl ? false : "DATABASE_URL is not set";
const DIST_DIR = ".next-route-test";

function databaseAt(name, role = null) {
  const url = new URL(databaseUrl);
  url.pathname = `/${name}`;
  // %20, not URLSearchParams' "+": libpq reads the option verbatim.
  // The role's own settings (its search_path) apply at login, not on SET ROLE,
  // so they are given here as the host's login gives them.
  return role ? `${url.toString().replace(/\?.*$/, "")}?options=${encodeURIComponent(`-c role=${role} -c search_path=control_plane,public,extensions`)}` : url.toString();
}

function psql(url, sql) {
  const result = spawnSync("psql", ["-X", "-qAt", "-v", "ON_ERROR_STOP=1", url], { encoding: "utf8", input: sql });
  if (result.status !== 0) throw new Error(result.stderr.trim() || `psql exited ${result.status}`);
  return result.stdout.trim();
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

// A project with a running chat, a reviewed chat with an analyst's answer, and
// a team's analyst: the shapes the pages draw.
function seed(url, owner) {
  return JSON.parse(psql(url, `
SET search_path TO control_plane, public, extensions;
DO $$
DECLARE v_project uuid; v_running uuid; v_reviewed uuid; v_agent uuid; v_run uuid; v_entry uuid; v_connection uuid;
  v_codex_profile uuid; v_claude_profile uuid; v_codex uuid; v_claude uuid; v_orchestrator uuid; v_executor uuid;
BEGIN
  INSERT INTO projects(owner_id,name,slug,workspace_path,status,default_branch)
    VALUES('${owner}','Render','render','/srv/infra-cod/workspaces/render','active','main') RETURNING id INTO v_project;
  INSERT INTO provider_connections(operator_id,provider,auth_method,status,access_gateway,billing_boundary,native_credential_reference)
    VALUES('${owner}','claude','native','connected','claude_subscription','subscription','claude-home:claude-worker') RETURNING id INTO v_connection;
  INSERT INTO provider_model_catalog(operator_id,connection_id,runtime_type,provider_id,model_id,display_name,discovery_source,status,last_verified_at,verification_id)
    VALUES('${owner}',v_connection,'claude','anthropic','claude-haiku-5-5','Claude Haiku 5.5','claude_aliases','verified',clock_timestamp(),gen_random_uuid())
    RETURNING id INTO v_entry;
  -- The team: a chat lists only tasks its orchestrator holds.
  INSERT INTO runtime_profiles(runtime_type,adapter_version,runtime_version,provider_type,model,last_verified_at)
    VALUES('codex','test','test','openai','gpt-6-luna',clock_timestamp()) RETURNING id INTO v_codex_profile;
  INSERT INTO runtime_profiles(runtime_type,adapter_version,runtime_version,provider_type,model,last_verified_at)
    VALUES('claude','test','test','anthropic','sonnet',clock_timestamp()) RETURNING id INTO v_claude_profile;
  INSERT INTO agents(name,runtime_profile_id) VALUES('render-codex',v_codex_profile) RETURNING id INTO v_codex;
  INSERT INTO agents(name,runtime_profile_id) VALUES('render-claude',v_claude_profile) RETURNING id INTO v_claude;
  INSERT INTO project_agent_assignments(project_id,agent_id,runtime_profile_id,role_definition_id,is_default)
    VALUES(v_project,v_codex,v_codex_profile,(SELECT id FROM role_definitions WHERE builtin_key='orchestrator'),true) RETURNING id INTO v_orchestrator;
  INSERT INTO project_agent_assignments(project_id,agent_id,runtime_profile_id,role_definition_id)
    VALUES(v_project,v_claude,v_claude_profile,(SELECT id FROM role_definitions WHERE builtin_key='executor')) RETURNING id INTO v_executor;
  INSERT INTO project_analysts(project_id,name,instructions,catalog_entry_id,runtime_type)
    VALUES(v_project,'Code reader','Explain how it works today.',v_entry,'claude');

  INSERT INTO tasks(project_id,title,objective,status,created_by,orchestrator_assignment_id,active_agent_id)
    VALUES(v_project,'Running chat','Do it.','planning','test',v_orchestrator,v_codex) RETURNING id INTO v_running;
  PERFORM append_event('chat.user_message',v_project,v_running,NULL,'user','${owner}',NULL,'render','render:running:1','message',gen_random_uuid(),1,
    '{"content":"Add a streak counter."}');
  PERFORM append_event('chat.agent_message',v_project,v_running,NULL,'agent','orchestrator',NULL,'render','render:running:2','message',gen_random_uuid(),1,
    '{"content":"Planning it.","agent_name":"orchestrator","runtime_type":"codex","source_job_type":"orchestrator_turn"}');

  INSERT INTO tasks(project_id,title,objective,status,created_by,orchestrator_assignment_id,active_agent_id)
    VALUES(v_project,'Reviewed chat','Do it.','awaiting_review','test',v_orchestrator,v_codex) RETURNING id INTO v_reviewed;
  PERFORM append_event('chat.user_message',v_project,v_reviewed,NULL,'user','${owner}',NULL,'render','render:reviewed:1','message',gen_random_uuid(),1,
    '{"content":"Clear the history."}');
  PERFORM append_event('consultation.requested',v_project,v_reviewed,NULL,'agent','orchestrator',NULL,'render','render:reviewed:2','consultation',gen_random_uuid(),1,
    '{"analyst":"Code reader","runtime_type":"claude","question":"Where is the history stored?"}');
  PERFORM append_event('consultation.answered',v_project,v_reviewed,NULL,'agent','analyst:Code reader',NULL,'render','render:reviewed:3','consultation',gen_random_uuid(),1,
    '{"analyst":"Code reader","runtime_type":"claude","model":"claude-haiku-5-5","question":"Where is the history stored?","answer":"In **localStorage**, src/history.js:24."}');
  PERFORM append_event('chat.agent_message',v_project,v_reviewed,NULL,'agent','orchestrator',NULL,'render','render:reviewed:4','message',gen_random_uuid(),1,
    '{"content":"Review passed.","agent_name":"orchestrator","runtime_type":"codex","source_job_type":"resume_orchestrator"}');
  SET LOCAL session_replication_role = replica;
  INSERT INTO agents(name, runtime_profile_id) VALUES ('render-executor', gen_random_uuid()) RETURNING id INTO v_agent;
  INSERT INTO task_runs(task_id, agent_id, phase, status, finished_at) VALUES (v_reviewed, v_agent, 'implementation', 'completed', clock_timestamp()) RETURNING id INTO v_run;
  INSERT INTO review_evidence(project_id,task_id,run_id,fencing_token,base_commit_sha,head_commit_sha,
    worktree_digest,patch_digest,evidence_digest,algorithm,object_format,worktree_committed,changed_files,
    diffstat,diff,truncation,executor_reported_checks,platform_verified_checks,recorded_by)
  VALUES(v_project,v_reviewed,v_run,1,repeat('a',40),repeat('b',40),'sha256:'||repeat('c',64),'sha256:'||repeat('d',64),
    'sha256:'||repeat('e',64),'{"worktree":"infra-cod-worktree-v1","patch":"infra-cod-patch-v1"}','sha1',true,
    '[{"path":"src/app.js","status":"M","added":3,"deleted":1,"binary":false}]','{"files_changed":1,"insertions":3,"deletions":1}',
    'diff --git a/src/app.js b/src/app.js','{}','{}','[{"name":"project_checks","status":"passed","detail":"npm test"}]','render');
  SET LOCAL session_replication_role = origin;
  CREATE TEMP TABLE render_ids AS SELECT v_project AS project, v_running AS running, v_reviewed AS reviewed;
END $$;
SELECT jsonb_build_object('project',project,'running',running,'reviewed',reviewed)::text FROM render_ids;`).split("\n").at(-1));
}

test("every page the operator opens renders, as infra_web, signed in", { skip, timeout: 900_000 }, async () => {
  const scratch = `infra_cod_render_${randomUUID().slice(0, 8)}`;
  const credentialsDir = path.join(os.tmpdir(), `infra-cod-render-${process.pid}`);
  mkdirSync(credentialsDir, { recursive: true });
  psql(databaseAt("postgres"), `CREATE DATABASE ${scratch};`);
  const url = databaseAt(scratch);
  let server = null;
  try {
    const migrate = spawnSync(process.execPath, [path.join(root, "services/control-plane/migrate.mjs")], {
      encoding: "utf8", env: { ...process.env, DATABASE_URL: url },
    });
    assert.equal(migrate.status, 0, `migrate failed: ${migrate.stderr}`);
    const bootstrap = spawnSync(process.execPath, [path.join(root, "services/cli/admin.mjs"), "bootstrap", "--stdin"], {
      encoding: "utf8", input: "web-render-operator-password\n",
      env: { ...process.env, DATABASE_URL: url, INFRA_COD_AUTH_PEPPER: pepper, INFRA_COD_CREDENTIALS_DIR: credentialsDir },
    });
    assert.equal(bootstrap.status, 0, `bootstrap failed: ${bootstrap.stderr}`);
    const owner = psql(url, "SELECT id FROM control_plane.users LIMIT 1;");
    psql(url, `UPDATE control_plane.users SET must_change_password=false WHERE id='${owner}';`);
    const ids = seed(url, owner);

    const token = randomBytes(32).toString("base64url");
    const digest = (value) => createHash("sha256").update(value).digest("hex");
    psql(url, `INSERT INTO control_plane.web_sessions(user_id,token_digest,csrf_digest,expires_at,absolute_expires_at)
      VALUES ('${owner}', decode('${digest(token)}','hex'), decode('${digest(randomBytes(32).toString("base64url"))}','hex'),
        clock_timestamp()+interval '12 hours', clock_timestamp()+interval '30 days');`);

    const port = await freePort();
    const base = `http://127.0.0.1:${port}`;
    server = spawn(process.execPath, [path.join(root, "apps/web/node_modules/next/dist/bin/next"), "dev", "--port", String(port)], {
      cwd: path.join(root, "apps/web"),
      env: {
        ...process.env, NODE_ENV: "development",
        // As on the host: the panel's role, not the migrating superuser.
        DATABASE_URL: databaseAt(scratch, "infra_web"),
        INFRA_COD_AUTH_PEPPER: pepper, INFRA_COD_INSECURE_COOKIES: "1", INFRA_COD_SITE_URL: base,
        PORT: String(port), NEXT_DIST_DIR: DIST_DIR, NEXT_TELEMETRY_DISABLED: "1",
      },
      stdio: ["ignore", "pipe", "pipe"], detached: true,
    });
    let log = "";
    server.stdout.on("data", (chunk) => { log += chunk.toString(); });
    server.stderr.on("data", (chunk) => { log += chunk.toString(); });
    const deadline = Date.now() + 180_000;
    for (;;) {
      try { if ((await fetch(`${base}/login`, { redirect: "manual" })).status < 500) break; } catch {}
      if (Date.now() > deadline) throw new Error(`the panel never became ready\n${log.slice(-3000)}`);
      await new Promise((resolve) => setTimeout(resolve, 500));
    }

    const pages = [
      "/projects",
      `/projects/${ids.project}`,
      `/projects/${ids.project}?task=${ids.running}`,
      `/projects/${ids.project}?task=${ids.reviewed}`,
      `/projects/${ids.project}/settings/team`,
      `/projects/${ids.project}/settings/workspace`,
      "/settings/models",
      "/settings/runtimes",
      "/settings/account",
    ];
    const failures = [];
    for (const page of pages) {
      const before = log.length;
      const response = await fetch(`${base}${page}`, { headers: { cookie: `infra_cod_session_dev=${token}` }, redirect: "manual" });
      const body = await response.text();
      // The project list sends a single project's owner straight to it.
      const redirectedInside = page === "/projects" && response.status === 307 && !/\/login/.test(response.headers.get("location") ?? "");
      // A render error in development can stream after a 200: the server's own
      // log and the payload say so even when the status does not.
      await new Promise((resolve) => setTimeout(resolve, 300));
      // A chat page is checked for its own first message: a page that drew only
      // the sidebar is not a chat that rendered.
      if (page.includes("?task=") && !/Add a streak counter|Clear the history/.test(body)) {
        failures.push(`${page}: the chat's messages are not on the page`);
      }
      const errors = log.slice(before).split("\n").filter((line) => /⨯|Error:|Functions cannot be passed/.test(line));
      if ((response.status !== 200 && !redirectedInside) || errors.length
          || /This page couldn.t load|Application error|Functions cannot be passed|Switched to client rendering/.test(body)) {
        failures.push(`${page}: ${response.status} ${response.headers.get("location") ?? ""}\n${errors.slice(0, 6).join("\n")}`);
      }
    }
    assert.deepEqual(failures, [], `pages that did not render:\n${failures.join("\n\n")}\n--- panel log ---\n${log.slice(-2500)}`);
  } finally {
    if (server) { try { process.kill(-server.pid, "SIGTERM"); } catch {} }
    try { psql(databaseAt("postgres"), `DROP DATABASE IF EXISTS ${scratch} WITH (FORCE);`); } catch {}
    rmSync(credentialsDir, { recursive: true, force: true });
  }
});
