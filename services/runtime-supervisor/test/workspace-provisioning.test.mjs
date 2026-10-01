import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { mkdtemp, mkdir, realpath, rm, symlink } from "node:fs/promises";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import {
  provisionPlan, inspectPlan, inspectOwner, resolveWorkspacePath, ownershipFor,
  summariseWorkspace, assertRealWorkspace, assertWorkspaceOnDisk, cloneCredential,
  homeFor, GIT_ISOLATION, commitIdentityEnvironment, SEED_AUTHOR, summariseUnpublished, EMPTY_TREE,
  PROVISIONED_WORKSPACE_OWNER,
} from "../workspace-provisioning.mjs";

// These rules decide what a root process does to the filesystem, so they are
// tested directly rather than through the supervisor, which cannot run here.

const ROOT = "/srv/infra-cod/workspaces";
const PROJECT = "3f2504e0-4f89-11d3-9a0c-0305e82c3301";

const KEY_ROOT = "/etc/infra-cod/github-deploy-keys";
const KNOWN_HOSTS = "/etc/infra-cod/github_known_hosts";
const PLAN_CONTEXT = { canonicalRoot: ROOT, keyRoot: KEY_ROOT, knownHostsFile: KNOWN_HOSTS };

function operation(overrides = {}) {
  return {
    operation_type: "provision_workspace",
    project_id: PROJECT,
    workspace_path: `${ROOT}/${PROJECT}`,
    repository_url: null,
    default_branch: "main",
    project_name: "Example",
    credential_locator: null,
    ...overrides,
  };
}

// --- the path ------------------------------------------------------------
// Provisioning removes this path recursively, so anything but the exact
// allocated directory has to be refused before any filesystem call.

test("accepts exactly the allocated workspace", () => {
  assert.equal(resolveWorkspacePath(ROOT, PROJECT, `${ROOT}/${PROJECT}`), `${ROOT}/${PROJECT}`);
});

test("refuses a path outside the workspace root", () => {
  for (const attempt of [
    "/etc/infra-cod",
    `${ROOT}/../../etc`,
    `${ROOT}/${PROJECT}/../another`,
    `${ROOT}/00000000-0000-0000-0000-000000000000`,
    "",
  ]) {
    assert.throws(() => resolveWorkspacePath(ROOT, PROJECT, attempt), /workspace path/, attempt);
  }
});

test("refuses a project id that is not a uuid", () => {
  // The id is a path segment, so "../.." would otherwise escape the root.
  assert.throws(() => resolveWorkspacePath(ROOT, "../..", `${ROOT}/../..`), /uuid/);
  assert.throws(() => resolveWorkspacePath(ROOT, "etc", `${ROOT}/etc`), /uuid/);
});

// --- ownership -----------------------------------------------------------

test("only allowlisted users may own a workspace", () => {
  assert.deepEqual(ownershipFor("codex-worker"), { user: "codex-worker", group: "agent-workspace" });
  assert.deepEqual(ownershipFor("infra-control"), { user: "infra-control", group: "infra-control" });
  assert.deepEqual(ownershipFor("infra-cod-github"),
    { user: "infra-cod-github", group: "infra-cod-github" });
  for (const user of ["root", "postgres", "nobody", "infra-web", ""]) {
    assert.throws(() => ownershipFor(user), /not allowed/, user);
  }
});

test("provisioning always targets the one allowed owner", () => {
  const plan = provisionPlan(operation(), { ...PLAN_CONTEXT, existingGit: false });
  assert.equal(plan.ownership.user, PROVISIONED_WORKSPACE_OWNER);
  assert.equal(plan.ownership.group, "agent-workspace");
});

// --- the plan ------------------------------------------------------------

test("an empty project is initialised, not cloned", () => {
  const plan = provisionPlan(operation(), { ...PLAN_CONTEXT, existingGit: false });
  assert.equal(plan.recreate, true);
  assert.deepEqual(plan.steps.map((step) => step.kind), ["init", "seed", "add", "commit"]);
  assert.deepEqual(plan.steps[0].args, ["init", "-q", "-b", "main"]);
  assert.match(plan.steps[1].contents, /managed by infra-cod/);
});

// rc.47: the seeded AGENTS.md was never committed, so every empty project's
// first run had a file in its tree that no commit held, and its first publish
// was refused. The plan's own steps, run by real git as the supervisor runs
// them, leave a clean tree on a first commit.
test("an empty project's seed is its first commit, and the tree is clean", () => {
  const plan = provisionPlan(operation(), { ...PLAN_CONTEXT, existingGit: false });
  const directory = mkdtempSync(path.join(tmpdir(), "seed-commit-"));
  try {
    for (const step of plan.steps) {
      if (step.kind === "seed") { writeFileSync(path.join(directory, step.file), step.contents); continue; }
      const env = { PATH: process.env.PATH, HOME: directory,
        ...Object.fromEntries(step.environment.map((entry) => entry.split("=", 2))) };
      const result = spawnSync(step.command, step.args, { cwd: directory, env, encoding: "utf8" });
      assert.equal(result.status, 0, `${step.kind}: ${result.stderr}`);
    }
    const git = (...args) => spawnSync("git", args, { cwd: directory, encoding: "utf8" }).stdout.trim();
    assert.equal(git("status", "--porcelain"), "", "the seed is left outside a commit");
    assert.equal(git("log", "--format=%an <%ae>|%s"), "infra-cod <infra-cod@localhost>|Initialise the workspace");
    assert.equal(git("ls-files"), "AGENTS.md");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a repository project is cloned", () => {
  const plan = provisionPlan(
    operation({ repository_url: "https://github.com/example/repo" }),
    { ...PLAN_CONTEXT, existingGit: false },
  );
  assert.deepEqual(plan.steps.map((step) => step.kind), ["clone"]);
  assert.deepEqual(plan.steps[0].args,
    ["clone", "--no-tags", "--origin", "origin", "https://github.com/example/repo", "."]);
});

test("an existing checkout is never destroyed", () => {
  // Discarding a workspace that may hold uncommitted work is the deprovision
  // path's decision, not provisioning's.
  const plan = provisionPlan(operation(), { ...PLAN_CONTEXT, existingGit: true });
  assert.equal(plan.recreate, false);
  assert.deepEqual(plan.steps, []);
});

test("only public GitHub HTTPS remotes are accepted", () => {
  for (const url of [
    "git@github.com:example/repo.git",
    "ssh://git@github.com/example/repo.git",
    "https://gitlab.com/example/repo",
    "https://github.com/example/repo/../../evil",
    "file:///etc/passwd",
    "https://github.com/example/repo; rm -rf /",
  ]) {
    assert.throws(
      () => provisionPlan(operation({ repository_url: url }), { ...PLAN_CONTEXT, existingGit: false }),
      /allowlist/, url,
    );
  }
});

test("a branch name cannot smuggle an option into git init", () => {
  assert.throws(
    () => provisionPlan(operation({ default_branch: "--upload-pack=evil" }),
      { ...PLAN_CONTEXT, existingGit: false }),
    /branch name/,
  );
});

// --- deploy keys ---------------------------------------------------------
// A project-scoped read-only deploy key is how private repositories were
// cloned before this moved into the supervisor, and that capability has to
// survive the move. What must not survive is the key becoming readable by the
// sandboxed runtime accounts.

test("a public clone runs as the account that will own the checkout", () => {
  const plan = provisionPlan(
    operation({ repository_url: "https://github.com/example/repo" }),
    { ...PLAN_CONTEXT, existingGit: false },
  );
  assert.equal(plan.steps[0].user, PROVISIONED_WORKSPACE_OWNER);
  // No credential material: only the git config isolation every step carries.
  assert.deepEqual(plan.steps[0].environment, GIT_ISOLATION);
  assert.ok(!plan.steps[0].environment.some((entry) => entry.startsWith("GIT_SSH_COMMAND=")));
});

test("a deploy-key clone runs as infra-control, never as a runtime account", () => {
  const project = "3f2504e0-4f89-11d3-9a0c-0305e82c3301";
  const plan = provisionPlan(
    operation({
      repository_url: "https://github.com/example/repo",
      credential_locator: `${KEY_ROOT}/${project}`,
    }),
    { ...PLAN_CONTEXT, existingGit: false },
  );
  const [clone] = plan.steps;
  assert.equal(clone.user, "infra-control");
  assert.notEqual(clone.user, PROVISIONED_WORKSPACE_OWNER,
    "the sandboxed account would be able to read the deploy key");
  // The checkout still ends up owned by the runtime account.
  assert.equal(plan.ownership.user, PROVISIONED_WORKSPACE_OWNER);
});

test("a deploy-key clone pins the host key and uses SSH over 443", () => {
  const project = "3f2504e0-4f89-11d3-9a0c-0305e82c3301";
  const credential = cloneCredential(
    { project_id: project, repository_url: "https://github.com/example/repo",
      credential_locator: `${KEY_ROOT}/${project}` },
    { keyRoot: KEY_ROOT, knownHostsFile: KNOWN_HOSTS },
  );
  assert.equal(credential.url, "ssh://git@ssh.github.com:443/example/repo.git");
  const [ssh] = credential.environment;
  assert.match(ssh, /StrictHostKeyChecking=yes/);
  assert.match(ssh, new RegExp(`UserKnownHostsFile=${KNOWN_HOSTS}`));
  assert.match(ssh, /IdentitiesOnly=yes/);
  assert.match(ssh, /BatchMode=yes/);
  assert.match(ssh, new RegExp(`-i ${KEY_ROOT}/${project}\\b`));
});

test("a deploy key from outside the project boundary is refused", () => {
  // Otherwise one project's clone could read another project's key.
  const project = "3f2504e0-4f89-11d3-9a0c-0305e82c3301";
  for (const locator of [
    `${KEY_ROOT}/00000000-0000-0000-0000-000000000000`,
    `${KEY_ROOT}/../database.env`,
    "/etc/infra-cod/github-app/private-key.pem",
    "/root/.ssh/id_ed25519",
  ]) {
    assert.throws(
      () => cloneCredential(
        { project_id: project, repository_url: "https://github.com/example/repo",
          credential_locator: locator },
        { keyRoot: KEY_ROOT, knownHostsFile: KNOWN_HOSTS }),
      /credential boundary/, locator,
    );
  }
});

test("a deploy key with no repository is refused", () => {
  assert.throws(
    () => provisionPlan(operation({ credential_locator: `${KEY_ROOT}/x` }),
      { ...PLAN_CONTEXT, existingGit: false }),
    /no repository/,
  );
});

// --- the path on disk ----------------------------------------------------
// The lexical check cannot see a symlink, and stat() follows one. Provisioning
// then probes the target as if it were the workspace and hands the path to a
// root chown -R.

test("a symlink at the workspace path is refused", () => {
  const workspace = `${ROOT}/${PROJECT}`;
  assert.throws(
    () => assertRealWorkspace(workspace,
      { exists: true, isSymlink: true, realPath: "/tmp/elsewhere" }),
    /symlink/,
  );
});

test("a path that does not resolve to itself is refused", () => {
  // Covers a symlinked parent component, which lstat on the leaf cannot see.
  const workspace = `${ROOT}/${PROJECT}`;
  assert.throws(
    () => assertRealWorkspace(workspace,
      { exists: true, isSymlink: false, realPath: "/srv/elsewhere/x" }),
    /resolve to itself/,
  );
});

test("a real directory at the expected path is accepted", () => {
  const workspace = `${ROOT}/${PROJECT}`;
  assert.doesNotThrow(() =>
    assertRealWorkspace(workspace, { exists: true, isSymlink: false, realPath: workspace }));
});

test("an absent workspace is accepted, since provisioning creates it", () => {
  const workspace = `${ROOT}/${PROJECT}`;
  assert.doesNotThrow(() =>
    assertRealWorkspace(workspace, { exists: false, isSymlink: false, realPath: workspace }));
});

test("each plan refuses the other operation type", () => {
  assert.throws(() => provisionPlan(operation({ operation_type: "inspect_workspace" }),
    { ...PLAN_CONTEXT, existingGit: false }), /provisionPlan called for/);
  assert.throws(() => inspectPlan(operation(), PLAN_CONTEXT), /inspectPlan called for/);
});

// --- inspection ----------------------------------------------------------

test("inspection is read-only", () => {
  const plan = inspectPlan(operation({ operation_type: "inspect_workspace" }), PLAN_CONTEXT);
  const writing = /\b(clone|init|fetch|pull|push|checkout|reset|clean|commit|merge|rebase)\b/;
  for (const [name, args] of Object.entries(plan.commands)) {
    assert.ok(!args.some((arg) => writing.test(arg)), `${name} is not read-only: ${args.join(" ")}`);
  }
  assert.equal(plan.owner, PROVISIONED_WORKSPACE_OWNER);
});

test("summarises git output into the recorded state", () => {
  const state = summariseWorkspace({
    branch: "main", headSha: "abc123", upstream: "origin/main",
    divergence: "2\t3",
    porcelain: " M src/a.ts\n?? new.ts",
    numstat: "4\t1\tsrc/a.ts",
  });
  assert.equal(state.ahead, 2);
  assert.equal(state.behind, 3);
  assert.equal(state.dirty, true);
  assert.equal(state.summary.files, 2);
  assert.equal(state.summary.untracked, 1);
  assert.equal(state.summary.additions, 4);
  assert.equal(state.summary.deletions, 1);
});

// The existing summary test asserted counts and never a path, which is exactly
// how the panel came to show `ervices/runtime-supervisor/server.mjs` for a file
// named `services/runtime-supervisor/server.mjs`: the supervisor trimmed the
// porcelain output, the leading space of ` M` went with it, and a fixed slice at
// offset 3 started one character late. Only the first line, because `trim`
// works on the ends of the output, not of each line.
test("the path of a worktree modification survives, first line included", () => {
  const state = summariseWorkspace({
    branch: "main", headSha: "abc123",
    porcelain: " M services/runtime-supervisor/server.mjs\n M second.ts\n?? third.ts",
  });
  assert.deepEqual(
    state.files,
    [
      { status: "M", path: "services/runtime-supervisor/server.mjs" },
      { status: "M", path: "second.ts" },
      { status: "??", path: "third.ts" },
    ],
  );
});

// Both columns carry meaning, and a staged-and-then-modified file uses both.
test("both status columns are read", () => {
  const state = summariseWorkspace({
    branch: "main", headSha: "abc",
    porcelain: "M  staged.ts\nMM both.ts\nA  added.ts\n D deleted.ts",
  });
  assert.deepEqual(state.files.map((file) => [file.status, file.path]), [
    ["M", "staged.ts"],
    ["MM", "both.ts"],
    ["A", "added.ts"],
    ["D", "deleted.ts"],
  ]);
});

// A line that is not `XY<space>path` means something reshaped the output on the
// way here. Keeping the whole line makes that visible; slicing at a fixed offset
// made it look like an ordinary path with a typo.
test("a reshaped line keeps its characters instead of losing one", () => {
  const state = summariseWorkspace({
    branch: "main", headSha: "abc",
    porcelain: "M services/a.ts",
  });
  assert.deepEqual(state.files, [{ status: "?", path: "M services/a.ts" }]);
});

// The parser above is only half the fix. The other half is that the supervisor
// must hand it the bytes git produced: `runAsRuntimeUser` trims by default,
// which is right for a branch name and wrong for a positional format whose
// first column can be a space. Asserted on the source because the alternative
// is a live `runuser`, and what is being checked is which option that one call
// site passes.
test("the supervisor reads the porcelain without trimming it", () => {
  const source = readFileSync(
    path.join(import.meta.dirname, "../server.mjs"),
    "utf8",
  );
  const call = /const porcelain = runAsRuntimeUser\(([^;]*?)\);/s.exec(source);
  assert.ok(call, "server.mjs no longer reads the porcelain through runAsRuntimeUser");
  assert.match(
    call[1],
    /raw:\s*true/,
    "the porcelain is trimmed, so the leading space of ` M` is lost and every path on the first line starts one character late",
  );
});

// The inspection used to run as the provisioning owner no matter who held the
// tree. An implementation run chowns the workspace to the executor's account,
// and `codex-worker` is in no group that reaches it, so for the whole length of
// every run each inspection was refused — and git reports a directory it cannot
// read as `fatal: not a git repository`, which was recorded as a failed
// operation about a repository that exists.
test("the inspection runs as whoever owns the tree now", () => {
  const uids = { "codex-worker": 993, "opencode-worker": 990, "infra-control": 991, "infra-cod-github": 992 };
  const resolve = (user) => uids[user] ?? null;
  assert.equal(inspectOwner(990, resolve), "opencode-worker");
  assert.equal(inspectOwner(993, resolve), "codex-worker");
});

// Reading the owner off disk must not become "run git as whoever happens to own
// this directory". The set stays closed.
test("an owner outside the runtime accounts is refused, not obeyed", () => {
  const resolve = (user) => ({ "codex-worker": 993, "opencode-worker": 990 })[user] ?? null;
  assert.throws(() => inspectOwner(0, resolve), /not a runtime account/);
  assert.throws(() => inspectOwner(1000, resolve), /not a runtime account/);
});

// An account that cannot be resolved must not match an unresolvable uid.
test("an unresolvable account matches nothing", () => {
  assert.throws(() => inspectOwner(990, () => null), /not a runtime account/);
});

test("the inspection plan carries the owner it was given", () => {
  const operation = {
    operation_type: "inspect_workspace",
    project_id: "941510ad-0000-4000-9000-000000000001",
    workspace_path: "/srv/w/941510ad-0000-4000-9000-000000000001",
  };
  const plan = inspectPlan(operation, { canonicalRoot: "/srv/w", owner: "opencode-worker" });
  assert.equal(plan.owner, "opencode-worker");
  assert.throws(
    () => inspectPlan(operation, { canonicalRoot: "/srv/w", owner: "root" }),
    /not allowed to own a workspace/,
  );
});

test("an unborn branch is reported rather than left empty", () => {
  const state = summariseWorkspace({ branch: "", headSha: "", porcelain: "" });
  assert.equal(state.branch, "unborn");
  assert.equal(state.dirty, false);
});

test("a detached head is reported", () => {
  const state = summariseWorkspace({ branch: "", headSha: "abc123", porcelain: "" });
  assert.equal(state.branch, "detached");
});

test("a very large change set is truncated and says so", () => {
  const porcelain = Array.from({ length: 250 }, (_, i) => ` M file${i}.ts`).join("\n");
  const state = summariseWorkspace({ branch: "main", headSha: "a", porcelain });
  assert.equal(state.files.length, 200);
  assert.equal(state.summary.truncated, true);
});

// --- the check against a real filesystem ---------------------------------
// assertRealWorkspace decides; this is the reading it decides on. Exercised
// against actual symlinks, because that is the shape that reached a root
// chown -R before the guard existed.

test("rejects a real symlink planted at the workspace path", async () => {
  const base = await realpath(await mkdtemp(path.join(tmpdir(), "infra-cod-ws-")));
  try {
    const outside = path.join(base, "outside");
    const workspace = path.join(base, "root", PROJECT);
    await mkdir(path.join(outside, ".git"), { recursive: true });
    await mkdir(path.dirname(workspace), { recursive: true });
    await symlink(outside, workspace);

    await assert.rejects(() => assertWorkspaceOnDisk(workspace), /symlink/);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("accepts a real directory and reports that it exists", async () => {
  const base = await realpath(await mkdtemp(path.join(tmpdir(), "infra-cod-ws-")));
  try {
    const workspace = path.join(base, PROJECT);
    await mkdir(workspace, { recursive: true });
    assert.equal(await assertWorkspaceOnDisk(workspace), true);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("accepts an absent workspace and reports that it does not exist", async () => {
  const base = await realpath(await mkdtemp(path.join(tmpdir(), "infra-cod-ws-")));
  try {
    assert.equal(await assertWorkspaceOnDisk(path.join(base, PROJECT)), false);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

// --- who owns the directory while the steps run --------------------------
// The clone user is not always the eventual owner, and a directory owned by
// codex-worker with mode g+rX gives infra-control nothing to write into. The plan
// therefore names a staging owner separately from the final one.

test("a public clone stages the directory to its own owner", () => {
  const plan = provisionPlan(
    operation({ repository_url: "https://github.com/example/repo" }),
    { ...PLAN_CONTEXT, existingGit: false },
  );
  assert.equal(plan.staging.user, PROVISIONED_WORKSPACE_OWNER);
  assert.equal(plan.staging.user, plan.steps[0].user);
});

test("a deploy-key clone stages the directory to the account that runs it", () => {
  const project = "3f2504e0-4f89-11d3-9a0c-0305e82c3301";
  const plan = provisionPlan(
    operation({
      repository_url: "https://github.com/example/repo",
      credential_locator: `${KEY_ROOT}/${project}`,
    }),
    { ...PLAN_CONTEXT, existingGit: false },
  );
  // Without this the clone runs as infra-control into a codex-worker directory
  // and simply cannot write.
  assert.equal(plan.staging.user, "infra-control");
  assert.equal(plan.staging.user, plan.steps[0].user);
  // The checkout still ends up with the runtime account.
  assert.equal(plan.ownership.user, PROVISIONED_WORKSPACE_OWNER);
  assert.notEqual(plan.staging.user, plan.ownership.user);
});

test("an untouched checkout stages to its owner", () => {
  const plan = provisionPlan(operation(), { ...PLAN_CONTEXT, existingGit: true });
  assert.equal(plan.staging.user, plan.ownership.user);
});

// --- environment ---------------------------------------------------------

test("each account has its own home", () => {
  // The previous default sent everyone who was not codex-worker to the sandboxed
  // worker's home, so a deploy-key clone read a git config it does not own.
  assert.equal(homeFor("codex-worker"), "/home/codex-worker");
  assert.equal(homeFor("opencode-worker"), "/home/opencode-worker");
  assert.equal(homeFor("infra-control"), "/var/lib/infra-control");
  assert.equal(homeFor("infra-cod-github"), "/var/lib/infra-cod-github");
  assert.notEqual(homeFor("infra-control"), homeFor("opencode-worker"));
  assert.throws(() => homeFor("root"), /no home directory/);
  assert.throws(() => homeFor("nobody"), /no home directory/);
});

test("provisioning git steps ignore global and system config", () => {
  const project = "3f2504e0-4f89-11d3-9a0c-0305e82c3301";
  const plans = [
    provisionPlan(operation(), { ...PLAN_CONTEXT, existingGit: false }),
    provisionPlan(operation({ repository_url: "https://github.com/example/repo" }),
      { ...PLAN_CONTEXT, existingGit: false }),
    provisionPlan(operation({ repository_url: "https://github.com/example/repo",
      credential_locator: `${KEY_ROOT}/${project}` }), { ...PLAN_CONTEXT, existingGit: false }),
  ];
  for (const plan of plans) {
    for (const step of plan.steps.filter((item) => item.command === "git")) {
      for (const setting of GIT_ISOLATION) {
        assert.ok(step.environment.includes(setting),
          `${step.kind} does not set ${setting}`);
      }
    }
  }
});

test("the deploy-key ssh command survives alongside the config isolation", () => {
  const project = "3f2504e0-4f89-11d3-9a0c-0305e82c3301";
  const plan = provisionPlan(
    operation({ repository_url: "https://github.com/example/repo",
      credential_locator: `${KEY_ROOT}/${project}` }),
    { ...PLAN_CONTEXT, existingGit: false },
  );
  assert.ok(plan.steps[0].environment.some((entry) => entry.startsWith("GIT_SSH_COMMAND=")));
});

// Found on the host with rc.64: Claude Code's first gate run was refused,
// "runtime user claude-worker is not allowed to own a workspace", because the
// owners and homes named Codex and OpenCode one by one. Every runtime the
// registry provisions is one here, and nothing else is.
test("every provisioned runtime may hold a workspace and has its home, and only those", async () => {
  const { allAdapters } = await import("../../operations/runtime-adapters.mjs");
  for (const adapter of allAdapters()) {
    assert.deepEqual(ownershipFor(adapter.user), { user: adapter.user, group: "agent-workspace" });
    assert.equal(homeFor(adapter.user), adapter.home);
  }
  assert.deepEqual(ownershipFor("claude-worker"), { user: "claude-worker", group: "agent-workspace" });
  assert.throws(() => ownershipFor("claude-poc"), /not allowed to own a workspace/);
  assert.throws(() => homeFor("root"), /no home directory/);
});

test("an executor commits as the identity the database names, and as the seed author when it names nothing usable", () => {
  const bot = { name: "infra-cod[bot]", email: "308131237+infra-cod[bot]@users.noreply.github.com" };
  assert.deepEqual(commitIdentityEnvironment(bot), [
    `GIT_AUTHOR_NAME=${bot.name}`, `GIT_AUTHOR_EMAIL=${bot.email}`,
    `GIT_COMMITTER_NAME=${bot.name}`, `GIT_COMMITTER_EMAIL=${bot.email}`,
  ]);
  const seed = [
    `GIT_AUTHOR_NAME=${SEED_AUTHOR.name}`, `GIT_AUTHOR_EMAIL=${SEED_AUTHOR.email}`,
    `GIT_COMMITTER_NAME=${SEED_AUTHOR.name}`, `GIT_COMMITTER_EMAIL=${SEED_AUTHOR.email}`,
  ];
  for (const identity of [null, {}, { name: "x\nGIT_DIR=/", email: "a@b" }, { name: "bot", email: "no-at-sign" }, { name: "bot", email: "a@b\nX=1" }]) {
    assert.deepEqual(commitIdentityEnvironment(identity), seed, JSON.stringify(identity));
  }
});

test("the snapshot names the commits a publish would push, all of them when the remote has none", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "unpublished-"));
  try {
    const run = (...args) => spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: dir, encoding: "utf8" }).stdout.trim();
    run("init", "-q", "-b", "main");
    writeFileSync(path.join(dir, "a.txt"), "one\ntwo\n");
    run("add", "."); run("commit", "-q", "-m", "first");
    writeFileSync(path.join(dir, "a.txt"), "one\n");
    writeFileSync(path.join(dir, "b.txt"), "b\n");
    run("add", "."); run("commit", "-q", "-m", "second");
    const plan = inspectPlan({ operation_type: "inspect_workspace", project_id: PROJECT, workspace_path: `${ROOT}/${PROJECT}` }, { canonicalRoot: ROOT });
    const git = (args) => run(...args.slice(2));
    const log = git(plan.unpublishedLogArgs());
    const oldest = log.split("\n").at(-1).split("\t")[0];
    const base = git(plan.parentArgs(oldest)) || EMPTY_TREE;
    assert.equal(base, EMPTY_TREE, "the root commit has no parent");
    const unpublished = summariseUnpublished({ log, numstat: git(plan.rangeNumstatArgs(base)) });
    assert.equal(unpublished.commit_count, 2);
    assert.deepEqual(unpublished.commits.map((commit) => commit.subject), ["second", "first"]);
    assert.deepEqual(unpublished.files, [
      { path: "a.txt", additions: 1, deletions: 0 }, { path: "b.txt", additions: 1, deletions: 0 },
    ]);
    assert.equal(unpublished.additions, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the unpublished summary stays inside the snapshot's size", () => {
  const log = Array.from({ length: 400 }, (_, i) => `${"a".repeat(40)}\tcommit ${i} ${"x".repeat(200)}`).join("\n");
  const numstat = Array.from({ length: 400 }, (_, i) => `1\t2\tsrc/${"d".repeat(250)}/${i}.ts`).join("\n");
  const unpublished = summariseUnpublished({ log, numstat });
  assert.equal(unpublished.commit_count, 400);
  assert.equal(unpublished.file_count, 400);
  assert.equal(unpublished.deletions, 800);
  assert.ok(JSON.stringify(unpublished).length <= 6000);
  assert.ok(unpublished.commits.length > 0 && unpublished.commits.length < 400);
});
