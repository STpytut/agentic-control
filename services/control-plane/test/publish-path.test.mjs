// Sprint B P1 (0085): the publish path against a stub GitHub.
//
// What is real: the database and its functions, git on both sides, the smart
// HTTP protocol (`git http-backend` behind a server that checks the token the
// way GitHub does), the broker's publish code (github-app-worker.mjs
// processPublishIntent, github-publish.mjs) and the supervisor's export
// (publish-export.mjs). What is stubbed: GitHub's REST API for pull requests,
// the token mint, and the supervisor's socket — the stub supervisor asks the
// database for the claimed intent exactly as server.mjs does and exports with
// the same function.
//
// The plan's list: a push and a PR; a refused non-fast-forward; a token that
// expires mid-operation; plus a workspace whose HEAD moved, an existing PR, a
// disconnected connection, a project that is not a GitHub App repository, and
// the token found nowhere it must not be.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { rm, writeFile } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";

import { closePool, queryJson } from "../db.mjs";
import { failureReason } from "../failure.mjs";
import { createPullRequest } from "../github-app-client.mjs";
import { processPublishIntent } from "../github-app-worker.mjs";
import { pushApprovedCommit } from "../github-publish.mjs";
import { exportApprovedCommit } from "../../runtime-supervisor/publish-export.mjs";
import { runProcess } from "../../runtime-supervisor/review-evidence.mjs";

const adminDatabaseUrl = process.env.DATABASE_URL;
const psqlBin = process.env.PSQL_BIN ?? "psql";
const has = (bin, args) => { try { return spawnSync(bin, args, { stdio: "ignore" }).status === 0; } catch { return false; } };
const hasPsql = has("sh", ["-c", `command -v ${JSON.stringify(psqlBin)}`]);
const hasHttpBackend = has("git", ["http-backend", "-h"]) || spawnSync("git", ["--exec-path"], { encoding: "utf8" }).status === 0;
const skip = !adminDatabaseUrl ? "DATABASE_URL is not set" : !hasPsql ? "psql is not available"
  : !hasHttpBackend ? "git http-backend is not available" : false;

const root = path.resolve(import.meta.dirname, "../../..");
const WORKER = "publish-broker-test";
let scratchDb = "";
let url = "";
let dir = "";

function adminUrl(database) {
  const parsed = new URL(adminDatabaseUrl);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

function psql(sql, target = url) {
  const input = `SET search_path TO control_plane, public, extensions;\n${sql}`;
  const result = spawnSync(psqlBin, ["-X", "-qAt", "-v", "ON_ERROR_STOP=1", target], { encoding: "utf8", input });
  if (result.status !== 0) throw new Error(result.stderr.trim() || `psql exited ${result.status}`);
  return result.stdout.trim();
}

const GIT_ENV = {
  PATH: process.env.PATH, HOME: tmpdir(), GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t",
};
function git(cwd, ...args) {
  const result = spawnSync("git", args, { cwd, env: GIT_ENV, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}
function commit(cwd, file, content) {
  writeFileSync(path.join(cwd, file), content);
  git(cwd, "add", file);
  git(cwd, "commit", "-q", "-m", `change ${file}`);
  return git(cwd, "rev-parse", "HEAD");
}

// ------------------------------------------------------------------ the stub GitHub

const github = {
  server: null, port: 0, gitRoot: "",
  gitToken: null, apiToken: null,
  pulls: [], requests: [],
};

function unauthorized(res, realm) {
  res.writeHead(401, { "WWW-Authenticate": `Basic realm="${realm}"`, "Content-Type": "application/json" });
  res.end(JSON.stringify({ message: "Bad credentials" }));
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}

// Smart HTTP, as GitHub serves it: a token as the password of x-access-token.
async function serveGit(req, res, pathname, query) {
  const expected = github.gitToken ? `Basic ${Buffer.from(`x-access-token:${github.gitToken}`).toString("base64")}` : null;
  if (!expected || req.headers.authorization !== expected) return unauthorized(res, "GitHub");
  const body = await readBody(req);
  const child = spawn("git", ["http-backend"], {
    env: {
      ...GIT_ENV, GIT_PROJECT_ROOT: github.gitRoot, GIT_HTTP_EXPORT_ALL: "1", REMOTE_USER: "x-access-token",
      REQUEST_METHOD: req.method, PATH_INFO: pathname.replace(/^\/git/, ""), QUERY_STRING: query,
      CONTENT_TYPE: req.headers["content-type"] ?? "", CONTENT_LENGTH: String(body.length),
      HTTP_CONTENT_ENCODING: req.headers["content-encoding"] ?? "", GIT_PROTOCOL: req.headers["git-protocol"] ?? "",
      REMOTE_ADDR: "127.0.0.1",
    },
  });
  child.stdin.end(body);
  const out = [];
  for await (const chunk of child.stdout) out.push(chunk);
  const raw = Buffer.concat(out);
  const split = raw.indexOf("\r\n\r\n");
  const head = raw.subarray(0, split).toString("utf8");
  const headers = {};
  let status = 200;
  for (const line of head.split("\r\n")) {
    const at = line.indexOf(":");
    const name = line.slice(0, at).trim();
    const value = line.slice(at + 1).trim();
    if (/^status$/i.test(name)) status = Number(value.split(" ")[0]);
    else headers[name] = value;
  }
  res.writeHead(status, headers);
  res.end(raw.subarray(split + 4));
}

async function serveApi(req, res, pathname, query) {
  if (req.headers.authorization !== `Bearer ${github.apiToken}`) {
    res.writeHead(401, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ message: "Bad credentials" }));
  }
  const match = pathname.match(/^\/api\/repos\/([^/]+)\/([^/]+)\/pulls$/);
  if (!match) { res.writeHead(404); return res.end("{}"); }
  const repository = `${match[1]}/${match[2]}`;
  if (req.method === "POST") {
    const payload = JSON.parse((await readBody(req)).toString("utf8"));
    github.requests.push(payload);
    if (github.pulls.some((pr) => pr.repository === repository && pr.head === payload.head && pr.state === "open")) {
      res.writeHead(422, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ message: "Validation Failed", errors: [{ message: `A pull request already exists for ${match[1]}:${payload.head}.` }] }));
    }
    const pr = { number: github.pulls.length + 1, repository, head: payload.head, base: payload.base, title: payload.title, state: "open" };
    github.pulls.push(pr);
    res.writeHead(201, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ number: pr.number, html_url: `https://github.test/${repository}/pull/${pr.number}` }));
  }
  const head = new URLSearchParams(query).get("head") ?? "";
  const open = github.pulls.filter((pr) => pr.repository === repository && `${match[1]}:${pr.head}` === head && pr.state === "open");
  res.writeHead(200, { "Content-Type": "application/json" });
  return res.end(JSON.stringify(open.map((pr) => ({ number: pr.number, html_url: `https://github.test/${repository}/pull/${pr.number}` }))));
}

const apiFetch = (input, init) => fetch(String(input).replace("https://api.github.com", `http://127.0.0.1:${github.port}/api`), init);
const remoteUrl = () => `http://127.0.0.1:${github.port}/git/acme/widget.git`;

// ------------------------------------------------------------------ the stub supervisor

// The broker's view of the supervisor: the same authorization query and the
// same export function as server.mjs, against a workspace on this disk.
function stubSupervisor(workspace) {
  const exports = path.join(dir, "exports");
  return {
    released: [],
    async connect() {},
    close() {},
    async exportPublishCommit({ intentId }) {
      const target = await queryJson(`SELECT publish_export_target(:'id'::uuid)::text;`, { id: intentId });
      if (!target) throw new Error("publish export authorization failed");
      const exported = await exportApprovedCommit({
        runGit: (args, { input } = {}) => runProcess("git", args, { cwd: workspace, env: GIT_ENV, input }),
        headSha: target.head_commit_sha,
      });
      if (exported.refused) return exported;
      spawnSync("mkdir", ["-p", exports]);
      const file = path.join(exports, `${intentId}.pack`);
      await writeFile(file, exported.pack, { mode: 0o440 });
      return { pack_path: file, head_ref: exported.head_ref, head_sha: exported.head_sha };
    },
    async releasePublishExport({ intentId }) {
      this.released.push(intentId);
      await rm(path.join(exports, `${intentId}.pack`), { force: true });
    },
  };
}

// ------------------------------------------------------------------ fixture

const FIXTURE = `
CREATE FUNCTION publish_fixture(p_tag text, p_head text, p_mode text) RETURNS jsonb LANGUAGE plpgsql
SET search_path=control_plane,public,extensions AS $$
DECLARE v_user uuid; v_connection uuid; v_project uuid; v_task uuid; v_preparation uuid;
BEGIN
  INSERT INTO users(display_name) VALUES('Publish '||p_tag) RETURNING id INTO v_user;
  INSERT INTO provider_connections(operator_id,provider,auth_method,status,external_installation_id)
    VALUES(v_user,'github','github_app','connected','4242') RETURNING id INTO v_connection;
  IF p_mode='github_app' THEN
    INSERT INTO projects(owner_id,name,slug,workspace_path,repository_url,default_branch,credential_mode,
        provider_connection_id,github_repository_id,repository_full_name)
      VALUES(v_user,'Publish '||p_tag,'publish-'||p_tag,'/srv/infra-cod/workspaces/publish-'||p_tag,
        'https://github.com/acme/widget.git','main','github_app',v_connection,99,'acme/widget') RETURNING id INTO v_project;
  ELSE
    INSERT INTO projects(owner_id,name,slug,workspace_path,default_branch,credential_mode)
      VALUES(v_user,'Publish '||p_tag,'publish-'||p_tag,'/srv/infra-cod/workspaces/publish-'||p_tag,
        'main',p_mode) RETURNING id INTO v_project;
  END IF;
  INSERT INTO tasks(project_id,title,objective,status,created_by,acceptance_criteria)
    VALUES(v_project,'Add the widget '||p_tag,'Make the widget exist.','approved','test','["the widget exists"]')
    RETURNING id INTO v_task;
  -- The preparation the approval made and the supervisor prepared (0069). Its
  -- verdict and evidence are that path's to prove; here only the prepared row.
  SET LOCAL session_replication_role = replica;
  INSERT INTO publish_preparations(project_id,task_id,verdict_id,evidence_id,evidence_digest,requested_by,
      idempotency_key,correlation_id,status,observed,head_commit_sha,finished_at)
    VALUES(v_project,v_task,gen_random_uuid(),gen_random_uuid(),'sha256:test','test','prep:'||p_tag,'corr:'||p_tag,
      'prepared','{}'::jsonb,p_head,clock_timestamp()) RETURNING id INTO v_preparation;
  SET LOCAL session_replication_role = origin;
  RETURN jsonb_build_object('owner',v_user,'connection',v_connection,'project',v_project,'task',v_task,
    'preparation',v_preparation);
END $$;`;

let counter = 0;
function repositories() {
  // The remote as GitHub holds it, and the workspace cloned from it with the
  // approved commit on top.
  counter += 1;
  const remote = path.join(github.gitRoot, "acme", "widget.git");
  rmSync(remote, { recursive: true, force: true });
  const seed = mkdtempSync(path.join(dir, "seed-"));
  git(seed, "init", "-q", "-b", "main");
  const base = commit(seed, "README.md", "widget\n");
  git(dir, "clone", "-q", "--bare", seed, remote);
  git(remote, "config", "http.receivepack", "true");
  const workspace = mkdtempSync(path.join(dir, "workspace-"));
  git(workspace, "clone", "-q", seed, ".");
  const head = commit(workspace, `widget-${counter}.txt`, `widget ${counter}\n`);
  return { remote, seed, workspace, base, head };
}

function fixture(head, mode = "github_app") {
  return JSON.parse(psql(`SELECT publish_fixture('${counter}-${randomUUID().slice(0, 6)}','${head}','${mode}')::text;`));
}

const request = (f) => queryJson(`SELECT request_publish(:'id'::uuid,:'owner'::uuid,'operator',:'corr')::text;`,
  { id: f.preparation, owner: f.owner, corr: `corr-${randomUUID()}` });
const claim = () => queryJson(`SELECT claim_publish_intent(:'worker','1 minute'::interval)::text;`, { worker: WORKER });

function tokens() {
  const token = `ghs_${randomBytes(18).toString("hex")}`;
  github.gitToken = token;
  github.apiToken = token;
  return token;
}

async function publish(intent, workspace, token, overrides = {}) {
  const supervisor = stubSupervisor(workspace);
  const result = await processPublishIntent(intent, {
    worker: WORKER,
    mintToken: async () => token,
    revokeToken: async () => {},
    supervisor,
    push: (options) => pushApprovedCommit({ ...options, allowHttp: true, tmpRoot: dir }),
    openPullRequest: (options) => createPullRequest({ ...options, fetchImpl: apiFetch }),
    remoteUrlFor: () => remoteUrl(),
    ...overrides,
  });
  return { result, supervisor };
}

async function intentState(id) {
  return queryJson(`SELECT jsonb_build_object('status',status,'reason',failure_reason,'message',failure_message,
      'pushed_ref',pushed_ref,'pushed_sha',pushed_sha,'pr_number',pr_number,'pr_url',pr_url,'attempt',attempt_count,
      'authorization',(SELECT status FROM github_clone_authorizations a WHERE a.id=i.authorization_id))::text
    FROM publish_intents i WHERE id=:'id'::uuid;`, { id });
}

async function events(task) {
  return (await queryJson(`SELECT COALESCE(jsonb_agg(jsonb_build_object('type',event_type,'message',payload->>'message')
      ORDER BY occurred_at, aggregate_version),'[]')::text FROM domain_events WHERE task_id=:'task'::uuid AND event_type LIKE 'publish.%';`,
    { task })).map((event) => event.type);
}

async function assertTokenNowhere(token) {
  const found = await queryJson(`SELECT jsonb_build_object(
      'events',(SELECT count(*) FROM domain_events WHERE payload::text LIKE '%'||:'token'||'%'),
      'audit',(SELECT count(*) FROM audit_events WHERE details::text LIKE '%'||:'token'||'%'),
      'intents',(SELECT count(*) FROM publish_intents WHERE to_jsonb(publish_intents)::text LIKE '%'||:'token'||'%'))::text;`,
  { token });
  assert.deepEqual(found, { events: 0, audit: 0, intents: 0 }, "the installation token was written to the database");
}

// ------------------------------------------------------------------ setup

test.before(async () => {
  if (skip) return;
  dir = mkdtempSync(path.join(tmpdir(), "infra-cod-publish-test-"));
  github.gitRoot = path.join(dir, "github");
  spawnSync("mkdir", ["-p", path.join(github.gitRoot, "acme")]);
  github.server = http.createServer((req, res) => {
    const parsed = new URL(req.url, "http://stub");
    const handler = parsed.pathname.startsWith("/git/") ? serveGit : serveApi;
    handler(req, res, parsed.pathname, parsed.search.replace(/^\?/, "")).catch((error) => {
      res.writeHead(500); res.end(String(error.message));
    });
  });
  await new Promise((resolve) => github.server.listen(0, "127.0.0.1", resolve));
  github.port = github.server.address().port;

  scratchDb = `infra_cod_publish_${randomUUID().slice(0, 8)}`;
  psql(`CREATE DATABASE ${scratchDb};`, adminUrl("postgres"));
  url = adminUrl(scratchDb);
  const migrate = spawnSync(process.execPath, [path.join(root, "services/control-plane/migrate.mjs")], {
    encoding: "utf8", env: { ...process.env, DATABASE_URL: url },
  });
  if (migrate.status !== 0) throw new Error(`migrate failed: ${migrate.stderr}`);
  process.env.DATABASE_URL = url;
  psql(FIXTURE);
});

test.after(async () => {
  if (skip) return;
  await closePool();
  github.server?.close();
  spawnSync(psqlBin, ["-X", "-qAt", adminUrl("postgres")], { encoding: "utf8", input: `DROP DATABASE IF EXISTS ${scratchDb} WITH (FORCE);` });
  rmSync(dir, { recursive: true, force: true });
});

test.beforeEach(() => {
  if (skip) return;
  github.pulls = [];
  github.requests = [];
  // Every test claims only its own intent.
  psql(`UPDATE publish_intents SET status='failed',failure_reason='publish_push_failed',finished_at=clock_timestamp(),
          leased_by=NULL,leased_until=NULL WHERE status IN ('requested','claimed');`);
});

// ------------------------------------------------------------------ the path

test("a prepared commit is pushed to the task's branch and a pull request is opened, with receipts", { skip }, async () => {
  const repos = repositories();
  const f = fixture(repos.head);
  const requested = await request(f);
  assert.equal(requested.status, "requested");
  assert.equal((await request(f)).repeat, true, "a second click made a second intent");
  const intent = await claim();
  assert.equal(intent.id, requested.publish_intent_id);
  assert.equal(intent.branch, `infra-cod/${f.task}`);
  const token = tokens();
  const { result, supervisor } = await publish(intent, repos.workspace, token);
  assert.equal(result.status, "published", JSON.stringify(result));
  // On the remote: the task's branch at the approved commit; main untouched.
  assert.equal(git(repos.remote, "rev-parse", `refs/heads/infra-cod/${f.task}`), repos.head);
  assert.equal(git(repos.remote, "rev-parse", "refs/heads/main"), repos.base);
  assert.deepEqual(github.pulls.map((pr) => [pr.head, pr.base]), [[`infra-cod/${f.task}`, "main"]]);
  assert.match(github.requests[0].body, /Make the widget exist\./);
  assert.match(github.requests[0].body, new RegExp(repos.head));
  const state = await intentState(intent.id);
  assert.deepEqual(state, { status: "published", reason: null, message: null, pushed_ref: `refs/heads/infra-cod/${f.task}`,
    pushed_sha: repos.head, pr_number: 1, pr_url: "https://github.test/acme/widget/pull/1", attempt: 1, authorization: "consumed" });
  assert.deepEqual(await events(f.task), ["publish.requested", "publish.pushed", "publish.pull_request_opened"]);
  assert.deepEqual(supervisor.released, [intent.id], "the export was not released");
  await assertTokenNowhere(token);
  // A receipt: nothing changes a published intent.
  await assert.rejects(queryJson(`UPDATE publish_intents SET pr_number=2 WHERE id=:'id'::uuid RETURNING jsonb_build_object('id',id)::text;`,
    { id: intent.id }), (error) => failureReason(error) === "review_evidence_immutable");
});

test("an empty repository: the approved first commit becomes its main, and no pull request is asked for", { skip }, async () => {
  counter += 1;
  const remote = path.join(github.gitRoot, "acme", "widget.git");
  rmSync(remote, { recursive: true, force: true });
  git(dir, "init", "-q", "--bare", "-b", "main", remote);
  git(remote, "config", "http.receivepack", "true");
  const workspace = mkdtempSync(path.join(dir, "workspace-"));
  git(workspace, "init", "-q", "-b", "main");
  const head = commit(workspace, "package.json", "{}\n");
  const f = fixture(head);
  await request(f);
  const intent = await claim();
  const token = tokens();
  const { result } = await publish(intent, workspace, token);
  assert.equal(result.status, "published", JSON.stringify(result));
  assert.equal(git(remote, "rev-parse", "refs/heads/main"), head);
  assert.throws(() => git(remote, "rev-parse", "--verify", `refs/heads/infra-cod/${f.task}`), "a task branch was pushed as well");
  assert.deepEqual(github.pulls, [], "a pull request was asked for");
  const state = await intentState(intent.id);
  assert.equal(state.pushed_ref, "refs/heads/main");
  assert.equal(state.pr_number, null);
  assert.deepEqual(await events(f.task), ["publish.requested", "publish.base_initialised"]);
  await assertTokenNowhere(token);
});

test("a branch holding other commits is refused, not forced, and the ref is named; the retry is the operator's", { skip }, async () => {
  const repos = repositories();
  const f = fixture(repos.head);
  // Someone else's commit already on the task's branch.
  const other = commit(repos.seed, "other.txt", "other\n");
  git(repos.seed, "push", "-q", repos.remote, `${other}:refs/heads/infra-cod/${f.task}`);
  await request(f);
  const intent = await claim();
  const { result } = await publish(intent, repos.workspace, tokens());
  assert.equal(result.failure_reason, "publish_push_rejected");
  const state = await intentState(intent.id);
  assert.equal(state.status, "failed");
  assert.match(state.message, new RegExp(`refs/heads/infra-cod/${f.task}`));
  assert.equal(state.authorization, "revoked");
  assert.equal(git(repos.remote, "rev-parse", `refs/heads/infra-cod/${f.task}`), other, "the branch was overwritten");
  assert.equal(github.pulls.length, 0);
  assert.deepEqual(await events(f.task), ["publish.requested", "publish.failed"]);
  // The operator clears the branch on GitHub and retries: the same intent, the same commit.
  git(repos.remote, "update-ref", "-d", `refs/heads/infra-cod/${f.task}`);
  await assert.rejects(queryJson(`SELECT retry_publish_intent(:'id'::uuid,0,:'owner'::uuid,'operator','c')::text;`,
    { id: intent.id, owner: f.owner }), (error) => failureReason(error) === "publish_intent_not_failed",
    "a retry of an attempt the card did not show was accepted");
  const retried = await queryJson(`SELECT retry_publish_intent(:'id'::uuid,1,:'owner'::uuid,'operator','c')::text;`,
    { id: intent.id, owner: f.owner });
  assert.equal(retried.recovered_from, "publish_push_rejected");
  const again = await claim();
  assert.equal(again.id, intent.id);
  const { result: second } = await publish(again, repos.workspace, tokens());
  assert.equal(second.status, "published");
  assert.equal(git(repos.remote, "rev-parse", `refs/heads/infra-cod/${f.task}`), repos.head);
});

test("a token that expires between the push and the pull request: the push is on record, the retry opens the PR", { skip }, async () => {
  const repos = repositories();
  const f = fixture(repos.head);
  await request(f);
  const intent = await claim();
  const token = tokens();
  // GitHub stops accepting the token once the push is through.
  const { result } = await publish(intent, repos.workspace, token, {
    push: async (options) => {
      const pushed = await pushApprovedCommit({ ...options, allowHttp: true, tmpRoot: dir });
      github.apiToken = "expired";
      github.gitToken = "expired";
      return pushed;
    },
  });
  assert.equal(result.failure_reason, "publish_pull_request_failed");
  const failed = await intentState(intent.id);
  assert.equal(failed.pushed_sha, repos.head, "the push that landed is not on record");
  assert.equal(failed.pr_number, null);
  await assertTokenNowhere(token);
  await queryJson(`SELECT retry_publish_intent(:'id'::uuid,1,:'owner'::uuid,'operator','c')::text;`, { id: intent.id, owner: f.owner });
  const again = await claim();
  const { result: second } = await publish(again, repos.workspace, tokens());
  assert.equal(second.status, "published");
  assert.deepEqual(await events(f.task),
    ["publish.requested", "publish.pushed", "publish.failed", "publish.retried", "publish.pull_request_opened"]);
});

test("a token that expires before the push: the push fails as retryable and nothing is recorded as pushed", { skip }, async () => {
  const repos = repositories();
  const f = fixture(repos.head);
  await request(f);
  const intent = await claim();
  const token = tokens();
  github.gitToken = "expired";
  const { result } = await publish(intent, repos.workspace, token);
  assert.equal(result.failure_reason, "publish_push_failed");
  const state = await intentState(intent.id);
  assert.equal(state.pushed_sha, null);
  assert.doesNotMatch(state.message, new RegExp(token), "the token reached the failure message");
  await assertTokenNowhere(token);
});

test("a pull request already open for the branch is the answer, not a second one", { skip }, async () => {
  const repos = repositories();
  const f = fixture(repos.head);
  await request(f);
  const intent = await claim();
  github.pulls.push({ number: 7, repository: "acme/widget", head: `infra-cod/${f.task}`, base: "main", state: "open" });
  const { result } = await publish(intent, repos.workspace, tokens());
  assert.equal(result.status, "published");
  assert.equal(result.pr_number, 7);
  assert.equal(github.pulls.length, 1);
});

test("a workspace whose HEAD moved since prepare is refused, naming the ref and where it is", { skip }, async () => {
  const repos = repositories();
  const f = fixture(repos.head);
  const moved = commit(repos.workspace, "later.txt", "later\n");
  await request(f);
  const intent = await claim();
  const { result } = await publish(intent, repos.workspace, tokens());
  assert.equal(result.failure_reason, "publish_head_moved");
  const state = await intentState(intent.id);
  assert.match(state.message, new RegExp(`refs/heads/main is at ${moved}`));
  assert.equal(github.pulls.length, 0);
  assert.throws(() => git(repos.remote, "rev-parse", "--verify", `refs/heads/infra-cod/${f.task}`), "a branch was pushed");
});

// ------------------------------------------------------------------ what is refused before GitHub is asked

test("a project that is not a GitHub App repository stays prepare-only", { skip }, async () => {
  const f = fixture("a".repeat(40), "empty");
  await assert.rejects(request(f), (error) => failureReason(error) === "publish_unsupported_repository");
});

test("a connection disconnected after the request fails the publish at the claim, with the reason", { skip }, async () => {
  const repos = repositories();
  const f = fixture(repos.head);
  const requested = await request(f);
  psql(`UPDATE provider_connections SET status='disconnected' WHERE id='${f.connection}';`);
  assert.equal(await claim(), null, "a publish on a disconnected connection was handed out");
  const state = await intentState(requested.publish_intent_id);
  assert.equal(state.status, "failed");
  assert.equal(state.reason, "publish_connection_unavailable");
  await assert.rejects(queryJson(`SELECT retry_publish_intent(:'id'::uuid,1,:'owner'::uuid,'operator','c')::text;`,
    { id: requested.publish_intent_id, owner: f.owner }), (error) => failureReason(error) === "publish_connection_unavailable",
  "a retry was accepted while the connection is still disconnected");
});

test("only the operator makes an intent: the worker role cannot, and a stranger's preparation is not theirs", { skip }, async () => {
  const privileges = await queryJson(`SELECT jsonb_build_object(
      'worker_request',has_function_privilege('infra_worker','request_publish(uuid,uuid,text,text)','EXECUTE'),
      'worker_insert',has_table_privilege('infra_worker','publish_intents','INSERT'),
      'web_request',has_function_privilege('infra_web','request_publish(uuid,uuid,text,text)','EXECUTE'),
      'web_claim',has_function_privilege('infra_web','claim_publish_intent(text,interval)','EXECUTE'))::text;`);
  assert.deepEqual(privileges, { worker_request: false, worker_insert: false, web_request: true, web_claim: false });
  // The panel reads what it shows as infra_web; rc.56 shipped the card without
  // the grant and every project page with an active task failed.
  const reads = await queryJson(`SELECT jsonb_build_object(
      'preparations',has_table_privilege('infra_web','publish_preparations','SELECT'),
      'intents',has_table_privilege('infra_web','publish_intents','SELECT'))::text;`);
  assert.deepEqual(reads, { preparations: true, intents: true });
  const repos = repositories();
  const f = fixture(repos.head);
  await assert.rejects(queryJson(`SELECT request_publish(:'id'::uuid,gen_random_uuid(),'operator','c')::text;`, { id: f.preparation }),
    (error) => failureReason(error) === "publish_not_prepared");
});

// "Approve & open PR" (0138): the approving operator's request rides on the
// preparation, and is made in their name when the host finishes it.
const onApproval = (f) => queryJson(
  `SELECT request_publish_on_approval(:'project'::uuid,:'task'::uuid,:'owner'::uuid,'operator',:'corr')::text;`,
  { project: f.project, task: f.task, owner: f.owner, corr: `corr-${randomUUID()}` });
const intentFor = (f) => psql(`SELECT count(*) FROM publish_intents WHERE task_id='${f.task}';`);

test("approve & open PR: a preparation already done is published at once", { skip }, async () => {
  const f = fixture("b".repeat(40));
  const answer = await onApproval(f);
  assert.equal(answer.when, "now");
  assert.ok(answer.publish_intent_id, JSON.stringify(answer));
  assert.equal(intentFor(f), "1");
});

test("approve & open PR: a preparation in progress is published when the host finishes it", { skip }, async () => {
  const f = fixture("c".repeat(40));
  // A second, newer preparation still in progress: the one the approval opened.
  const pending = psql(`SET session_replication_role = replica;
    INSERT INTO publish_preparations(project_id,task_id,verdict_id,evidence_id,evidence_digest,requested_by,idempotency_key,correlation_id)
      VALUES('${f.project}','${f.task}',gen_random_uuid(),gen_random_uuid(),'sha256:test','test','prep:later-${randomUUID()}','corr') RETURNING id;`)
    .split("\n").pop();
  const answer = await onApproval(f);
  assert.equal(answer.when, "prepared", JSON.stringify(answer));
  assert.equal(answer.publish_preparation_id, pending);
  assert.equal(intentFor(f), "0", "published before the host prepared it");
  psql(`UPDATE publish_preparations SET status='prepared', observed='{}'::jsonb, head_commit_sha='${"c".repeat(40)}',
    finished_at=clock_timestamp() WHERE id='${pending}';`);
  assert.equal(psql(`SELECT count(*) FROM publish_intents WHERE preparation_id='${pending}' AND requested_by='operator';`), "1");
});

test("approve & open PR: a refusal is answered, not raised, and the approval's transaction goes on", { skip }, async () => {
  const f = fixture("d".repeat(40), "empty");
  const answer = await onApproval(f);
  assert.match(String(answer.refused), /GitHub App/);
  assert.equal(intentFor(f), "0");
  const grants = await queryJson(`SELECT jsonb_build_object(
      'web',has_function_privilege('infra_web','request_publish_on_approval(uuid,uuid,uuid,text,text)','EXECUTE'),
      'worker',has_function_privilege('infra_worker','request_publish_on_approval(uuid,uuid,uuid,text,text)','EXECUTE'))::text;`);
  assert.deepEqual(grants, { web: true, worker: false });
});
