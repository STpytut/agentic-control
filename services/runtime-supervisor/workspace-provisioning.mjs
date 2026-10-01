// Decisions behind workspace provisioning, kept separate from the privileged
// execution that acts on them.
//
// The Runtime Supervisor runs as root, so everything it is asked to do has to
// be decided from an allowlist rather than from the request. These functions
// are that allowlist. They are pure, so the rules can be tested without a
// machine that has the runtime users, and server.mjs stays a thin executor.

import path from "node:path";
import { adapterFor, allAdapters } from "../operations/runtime-adapters.mjs";
import { lstat, realpath } from "node:fs/promises";

// The runtime accounts, as the adapter registry names them. Read from the
// registry rather than spelled here: they are the PoC account names 11.1b is
// retiring (WP-5c), and a rename has to happen in one place, not in every file
// that once wrote the string.
const CODEX = adapterFor("codex");

// The single OS account a provisioned workspace may belong to. A claimed
// operation cannot ask for a different owner: the database never carries one.
export const PROVISIONED_WORKSPACE_OWNER = CODEX.user;

// Ownership pairs the supervisor is allowed to hand to chown. Without this a
// workspace operation would be a "chown anything to anyone" primitive.
//
// Every runtime the registry provisions may hold a workspace for its run, with
// the workspace group: a runtime added to the registry is one here too. Claude
// Code's gate was refused on the host until this stopped naming them one by
// one (sprint C K2, rc.64).
const OWNERSHIP = new Map([
  ...allAdapters().map((adapter) => [adapter.user, "agent-workspace"]),
  ["infra-control", "infra-control"],
  ["infra-cod-github", "infra-cod-github"],
]);

// Home directories, explicitly. cleanRuntimeArgs used to send everyone who was
// not codex-worker to /home/opencode-worker, so a deploy-key clone running as
// infra-control would read the sandboxed worker's global git config — a
// configuration-injection path, and a permissions failure besides.
const HOMES = new Map([
  ...allAdapters().map((adapter) => [adapter.user, adapter.home]),
  ["infra-control", "/var/lib/infra-control"],
  ["infra-cod-github", "/var/lib/infra-cod-github"],
]);

export function homeFor(user) {
  const home = HOMES.get(user);
  if (!home) throw new Error(`no home directory is defined for ${user}`);
  return home;
}

// Provisioning must not read any git configuration it did not put there.
// Pointing both scopes at /dev/null is how git is told to ignore them.
export const GIT_ISOLATION = ["GIT_CONFIG_GLOBAL=/dev/null", "GIT_CONFIG_SYSTEM=/dev/null"];

// Who the seed commit of an empty workspace is by: the platform, not a person.
export const SEED_AUTHOR = Object.freeze({ name: "infra-cod", email: "infra-cod@localhost" });

// Who an executor's commits are by (0124: the GitHub App's bot, else the seed
// author). As the environment, because GIT_AUTHOR_* and GIT_COMMITTER_* win over
// `git -c user.email=…`: left to itself, Claude Code committed as the
// subscription's email (battle test, chat 1). What the database answers is
// checked before it reaches an environment; anything else is the seed author.
const IDENTITY_NAME = /^[A-Za-z0-9][A-Za-z0-9 ._[\]-]{0,99}$/;
const IDENTITY_EMAIL = /^[A-Za-z0-9._+[\]-]{1,128}@[A-Za-z0-9.-]{1,128}$/;
export function commitIdentityEnvironment(identity) {
  const { name, email } = IDENTITY_NAME.test(String(identity?.name ?? "")) && IDENTITY_EMAIL.test(String(identity?.email ?? ""))
    ? identity : SEED_AUTHOR;
  return [`GIT_AUTHOR_NAME=${name}`, `GIT_AUTHOR_EMAIL=${email}`, `GIT_COMMITTER_NAME=${name}`, `GIT_COMMITTER_EMAIL=${email}`];
}

export function ownershipFor(user) {
  const group = OWNERSHIP.get(user);
  if (!group) throw new Error(`runtime user ${user} is not allowed to own a workspace`);
  return { user, group };
}

// V1 clones only GitHub repositories. Checked here as well as at creation time:
// the supervisor must not hand an arbitrary string to git.
const GITHUB_HTTPS = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/;

// Who runs the clone.
//
// A public clone runs as the eventual owner, so the checkout is correctly owned
// with no privileged step at all. A deploy-key clone cannot: the key is
// deliberately unreadable by the sandboxed runtime accounts, and copying it
// somewhere they can read would defeat that. It runs as infra-control, which
// reaches the key through the key root's group and is not a runtime account,
// and the result is chowned to the owner afterwards. Neither case runs git as
// root.
export function cloneCredential(operation, { keyRoot, knownHostsFile }) {
  const repository = String(operation.repository_url ?? "");
  const match = GITHUB_HTTPS.exec(repository);
  if (!match) throw new Error("repository URL is outside the V1 GitHub allowlist");

  if (!operation.credential_locator) {
    return { user: PROVISIONED_WORKSPACE_OWNER, url: repository, environment: [] };
  }

  // The locator is project-scoped. Anything else would let one project's clone
  // read another project's key.
  const expected = path.join(keyRoot, String(operation.project_id));
  if (path.resolve(String(operation.credential_locator)) !== expected) {
    throw new Error("GitHub deploy key locator is outside the project credential boundary");
  }

  return {
    user: "infra-control",
    // GitHub serves SSH on 443 for hosts where outbound 22 is blocked.
    url: `ssh://git@ssh.github.com:443/${match[1]}/${match[2]}.git`,
    environment: [
      `GIT_SSH_COMMAND=/usr/bin/ssh -i ${expected} -o IdentitiesOnly=yes -o BatchMode=yes`
      + " -o ConnectTimeout=10 -o ConnectionAttempts=1 -o HostKeyAlias=github.com"
      + ` -o StrictHostKeyChecking=yes -o UserKnownHostsFile=${knownHostsFile}`,
    ],
  };
}

// A workspace is always exactly <root>/<project id>. Anything else — a
// traversal, a symlink target, another project's directory — is refused before
// any filesystem call, because the next step removes the path recursively.
export function resolveWorkspacePath(canonicalRoot, projectId, workspacePath) {
  if (!/^[0-9a-f-]{36}$/i.test(String(projectId ?? ""))) {
    throw new Error("project id is not a uuid");
  }
  const expected = path.join(canonicalRoot, projectId);
  if (path.resolve(String(workspacePath ?? "")) !== expected) {
    throw new Error("workspace path does not match the allocated project id");
  }
  return expected;
}

// The lexical check above is not enough on its own. stat() follows symlinks,
// so a symlink at <root>/<uuid> pointing anywhere would be probed as if it were
// the workspace and then handed to a root chown -R. The caller supplies what
// lstat and realpath actually report, and this decides.
export function assertRealWorkspace(workspace, { exists, isSymlink, realPath }) {
  if (!exists) return;
  if (isSymlink) {
    throw new Error("workspace path is a symlink");
  }
  if (path.resolve(String(realPath ?? "")) !== workspace) {
    throw new Error("workspace path does not resolve to itself");
  }
}

function branchName(value) {
  const branch = String(value ?? "").trim();
  if (!branch) return "main";
  if (!/^[A-Za-z0-9._/-]{1,100}$/.test(branch) || branch.startsWith("-")) {
    throw new Error("default branch name is not allowed");
  }
  return branch;
}

// Describes what provisioning should do, without doing any of it. `existingGit`
// is the only piece of filesystem state it needs, so the caller probes once and
// the decision stays testable.
export function provisionPlan(operation, { canonicalRoot, existingGit, keyRoot, knownHostsFile }) {
  if (operation.operation_type !== "provision_workspace") {
    throw new Error(`provisionPlan called for ${operation.operation_type}`);
  }
  const workspace = resolveWorkspacePath(canonicalRoot, operation.project_id, operation.workspace_path);
  const ownership = ownershipFor(PROVISIONED_WORKSPACE_OWNER);

  if (existingGit) {
    // An existing checkout is never destroyed by provisioning; only ownership
    // is reasserted. Discarding a workspace with local work is the deprovision
    // path's decision, not this one's.
    return { workspace, ownership, staging: ownership, recreate: false, steps: [] };
  }

  const repository = operation.repository_url ? String(operation.repository_url) : "";
  if (!repository && operation.credential_locator) {
    throw new Error("a deploy key was supplied for a project with no repository");
  }

  const clone = repository ? cloneCredential(operation, { keyRoot, knownHostsFile }) : null;

  const steps = clone
    ? [{
        kind: "clone", command: "git", user: clone.user,
        environment: [...GIT_ISOLATION, ...clone.environment],
        args: ["clone", "--no-tags", "--origin", "origin", clone.url, "."],
      }]
    : [
        { kind: "init", command: "git", user: ownership.user, environment: GIT_ISOLATION,
          args: ["init", "-q", "-b", branchName(operation.default_branch)] },
        { kind: "seed", file: "AGENTS.md", contents: agentsFile(operation.project_name) },
        // The seed is the repository's first commit. Left untracked, it was in
        // every first run's tree and in no commit, so the evidence said
        // `worktree_committed: false` and the first publish of every empty
        // project was refused, whatever the executor committed (rc.47).
        { kind: "add", command: "git", user: ownership.user, environment: GIT_ISOLATION,
          args: ["add", "--", "AGENTS.md"] },
        { kind: "commit", command: "git", user: ownership.user, environment: GIT_ISOLATION,
          args: ["-c", `user.name=${SEED_AUTHOR.name}`, "-c", `user.email=${SEED_AUTHOR.email}`,
            "commit", "-q", "--no-verify", "-m", "Initialise the workspace"] },
      ];

  // The directory has to belong to whoever runs the steps, which is not always
  // the eventual owner: a deploy-key clone runs as infra-control, and a
  // workspace owned by codex-worker with mode g+rX gives it no way to write. The
  // final chown to `ownership` happens once the steps are done.
  const stagingUser = steps.find((step) => step.user)?.user ?? ownership.user;
  return { workspace, ownership, staging: ownershipFor(stagingUser), recreate: true, steps };
}

function agentsFile(projectName) {
  return [
    `# ${String(projectName ?? "Project").slice(0, 200)}`,
    "",
    "This workspace is managed by infra-cod.",
    "Only the current workspace-lock owner may modify project files.",
    "",
  ].join("\n");
}

// Read-only git invocations for inspect_workspace, in the order their output is
// consumed. `safe.directory` is needed because the checkout belongs to the
// runtime user while git may be invoked from another account.
// Who the inspection runs as.
//
// This used to be `PROVISIONED_WORKSPACE_OWNER` unconditionally, which is only
// the owner while nothing is running. An implementation run hands the tree to
// the executor's account, so for the whole length of every run the inspection
// ran as a user with no access to it:
//
//   drwxr-x--- opencode-worker agent-workspace  .git
//   id codex-worker -> groups=982(codex-worker)
//
// Neither the owner nor in the group, so every read was refused — and git
// reports a directory it cannot read as `fatal: not a git repository`, which
// the supervisor recorded as a failed operation. 98 of them in one day, each
// telling the operator a repository that exists does not.
//
// The owner is a fact on disk, so it is read rather than assumed. It is still
// checked against OWNERSHIP: this decides which account git runs as, and that
// must stay a closed set no matter who a directory has come to belong to.
export function inspectOwner(uid, resolveName) {
  for (const candidate of OWNERSHIP.keys()) {
    if (resolveName(candidate) === uid) return candidate;
  }
  throw new Error(`workspace is owned by uid ${uid}, which is not a runtime account`);
}

export function inspectPlan(operation, { canonicalRoot, owner = PROVISIONED_WORKSPACE_OWNER }) {
  if (operation.operation_type !== "inspect_workspace") {
    throw new Error(`inspectPlan called for ${operation.operation_type}`);
  }
  ownershipFor(owner);
  const workspace = resolveWorkspacePath(canonicalRoot, operation.project_id, operation.workspace_path);
  const safe = ["-c", `safe.directory=${workspace}`];
  return {
    workspace,
    owner,
    commands: {
      branch: [...safe, "symbolic-ref", "--quiet", "--short", "HEAD"],
      headSha: [...safe, "rev-parse", "--verify", "HEAD"],
      upstream: [...safe, "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"],
      porcelain: [...safe, "status", "--porcelain=v1", "--untracked-files=all"],
    },
    divergenceArgs: (upstream) => [...safe, "rev-list", "--left-right", "--count", `HEAD...${upstream}`],
    numstatArgs: () => [...safe, "diff", "--numstat", "HEAD"],
    // What a publish would push: every commit on HEAD that no remote-tracking
    // branch has (an empty repository's clone has none, so all of them), and
    // their diff taken together. The oldest one's parent is the base, or the
    // empty tree when it is the root.
    unpublishedLogArgs: () => [...safe, "log", "--format=%H%x09%s", "HEAD", "--not", "--remotes"],
    parentArgs: (sha) => [...safe, "rev-parse", "--verify", "--quiet", `${sha}^`],
    rangeNumstatArgs: (base) => [...safe, "diff", "--numstat", base, "HEAD"],
  };
}

export const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

// The commits a publish would push and what they change, for the panel's
// Changes (battle test, chat 1: everything was committed, so the working tree
// said nothing and neither did the page). Kept inside diff_summary, whose row
// takes 8 KB: entries stop being added once the object would pass UNPUBLISHED_BUDGET.
const UNPUBLISHED_BUDGET = 6000;
export function summariseUnpublished({ log, numstat }) {
  const commits = String(log ?? "").split("\n").filter(Boolean).map((line) => {
    const tab = line.indexOf("\t");
    return { sha: (tab < 0 ? line : line.slice(0, tab)).slice(0, 12), subject: tab < 0 ? "" : line.slice(tab + 1, tab + 121) };
  });
  const files = [];
  let additions = 0;
  let deletions = 0;
  for (const line of String(numstat ?? "").split("\n").filter(Boolean)) {
    const [added, deleted, ...rest] = line.split("\t");
    const file = { path: rest.join("\t").slice(0, 200), additions: /^\d+$/.test(added) ? Number(added) : null,
      deletions: /^\d+$/.test(deleted) ? Number(deleted) : null };
    additions += file.additions ?? 0;
    deletions += file.deletions ?? 0;
    files.push(file);
  }
  const out = { commit_count: commits.length, file_count: files.length, additions, deletions, commits: [], files: [] };
  for (const [list, into] of [[commits, out.commits], [files, out.files]]) {
    for (const entry of list) {
      if (JSON.stringify(out).length + JSON.stringify(entry).length + 1 > UNPUBLISHED_BUDGET) break;
      into.push(entry);
    }
  }
  return out;
}

// Shapes the raw git output into the row record_project_workspace_state expects.
export function summariseWorkspace({ branch, headSha, upstream, divergence, porcelain, numstat, unpublished = null }) {
  const [ahead = 0, behind = 0] = String(divergence ?? "").split(/\s+/).filter(Boolean).map(Number);
  const lines = String(porcelain ?? "").split("\n").filter(Boolean);
  // `XY<space>path`, both columns always present. Matched rather than sliced at
  // a fixed offset: a line of any other shape means the output was reshaped on
  // the way here — which is what trimming the leading space of ` M` did — and a
  // fixed offset answers that by quietly dropping a character. This keeps the
  // whole line instead, so a malformed row is visible rather than plausible.
  const files = lines.slice(0, 200).map((line) => {
    const match = /^(..) (.*)$/.exec(line);
    if (!match) return { status: "?", path: line.slice(0, 1000) };
    return { status: match[1].trim() || "?", path: match[2].slice(0, 1000) };
  });
  let additions = 0;
  let deletions = 0;
  for (const line of String(numstat ?? "").split("\n").filter(Boolean)) {
    const [added, deleted] = line.split("\t");
    if (/^\d+$/.test(added)) additions += Number(added);
    if (/^\d+$/.test(deleted)) deletions += Number(deleted);
  }
  return {
    branch: branch || (headSha ? "detached" : "unborn"),
    head_sha: headSha ?? "",
    upstream: upstream ?? "",
    ahead: Number.isFinite(ahead) ? ahead : 0,
    behind: Number.isFinite(behind) ? behind : 0,
    dirty: files.length > 0,
    files,
    summary: {
      files: files.length,
      additions,
      deletions,
      untracked: files.filter((file) => file.status === "??").length,
      truncated: lines.length > files.length,
      ...(unpublished ? { unpublished } : {}),
    },
  };
}

// Reads what the filesystem actually reports and applies assertRealWorkspace.
// Called immediately before anything privileged touches the path, and again
// after a clone has written into it, because the chown that follows is
// recursive and runs as root. Returns whether the workspace already exists.
export async function assertWorkspaceOnDisk(workspace) {
  let facts = { exists: false, isSymlink: false, realPath: workspace };
  try {
    const entry = await lstat(workspace);
    facts = { exists: true, isSymlink: entry.isSymbolicLink(), realPath: workspace };
    if (!entry.isSymbolicLink()) facts.realPath = await realpath(workspace);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  assertRealWorkspace(workspace, facts);
  return facts.exists;
}
