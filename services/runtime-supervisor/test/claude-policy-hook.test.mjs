// The platform's policy hook for an executor's Claude Code run (rc.144): what
// it lets through, what it refuses and with which reason, and that it refuses
// what it cannot read.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { hookAnswer, policyDecision, runHook, simpleCommands } from "../claude-hooks/policy.mjs";
import { normalizeClaudeEvent } from "../runtime-events.mjs";
import { driverFor } from "../drivers/index.mjs";

const WORKSPACE = "/srv/infra-cod/workspaces/p1";
// The file system as the policy sees it: a workspace with a repository and a
// few paths, so `git checkout src/a.js` is a path and `git checkout main` is not.
const PATHS = new Set([`${WORKSPACE}/.git`, `${WORKSPACE}/src/a.js`, `${WORKSPACE}/src`, `${WORKSPACE}/packages/app`]);
const exists = (file) => PATHS.has(file);
const bash = (command, cwd = WORKSPACE) => policyDecision({ tool_name: "Bash", tool_input: { command }, cwd }, { exists });
const write = (file_path, tool_name = "Write", cwd = WORKSPACE) => policyDecision({ tool_name, tool_input: { file_path }, cwd }, { exists });

test("the executor's ordinary work goes through", () => {
  for (const command of [
    "npm test", "git status --short", "git add src/a.js && git commit -m 'Add a'", "git diff HEAD~1", "git log --oneline -5",
    "git reset", "git reset --hard", "git reset --hard HEAD", "git checkout -- src/a.js", "git restore src/a.js",
    "git config user.name", "git config --get user.email", "git config --list", "git branch", "git branch --show-current",
    "git tag --list", "git stash && git stash pop", "echo 'git push is not run here' > notes.txt", "ls -la 2>&1 | head",
    // Commit messages and heredocs are data: Claude Code writes its commits this way.
    'git commit -m "Fix build && git push origin later"',
    "git commit -m \"$(cat <<'EOF'\nDescribe the change\n\ngit push is done by the platform, not here\ngit rebase docs\nEOF\n)\"",
    'git commit -m "Describe\ngit rebase workflow docs"',
    "git reset src/a.js", "git reset HEAD -- src/a.js", "git checkout src/a.js", "git checkout .", "git checkout HEAD~1 -- src/a.js",
    "git tag -n", "git tag --sort=-v:refname", "grep -rn hooksPath docs/", "cat .git/hooks/pre-commit.sample", "ls .git/hooks",
    "git config core.hooksPath", "bash -c 'npm test'", "if npm test; then echo ok; fi", "timeout 60 npm test",
  ]) assert.equal(bash(command), null, command);
  for (const file of ["src/a.js", `${WORKSPACE}/README.md`, "/tmp/scratch.txt", "docs/.gitignore", ".github/workflows/ci.yml"]) {
    assert.equal(write(file), null, file);
  }
  assert.equal(policyDecision({ tool_name: "Read", tool_input: { file_path: "/etc/passwd" }, cwd: WORKSPACE }), null, "only the registered tools are judged");
});

test("pushing, remotes, config, history, branches and git hooks are refused, however the command is dressed", () => {
  const refused = {
    push: ["git push", "git push origin HEAD", "cd sub && git push -f", "FOO=1 git push", "env git push", "git -C . push",
      "/usr/bin/git push", "npm test; git push", "echo $(git push)", "git -c core.x=y push origin main"],
    remote: ["git remote add up https://x", "git remote set-url origin https://evil"],
    config: ["git config user.email me@x", "git config --global user.name X", "git config --unset user.name"],
    history: ["git rebase -i HEAD~3", "git commit --amend -m x", "git reset --hard HEAD~1", "git reset --soft abc1234",
      "git filter-branch --tree-filter x", "git update-ref refs/heads/main HEAD"],
    branch: ["git switch -c feature", "git checkout -b feature", "git branch feature", "git branch -D main", "git tag v1"],
    hooks: ["echo x > .git/hooks/pre-commit", "git config core.hooksPath tools", "git -c core.hooksPath=x commit -m y",
      "cp hook.sh .git/hooks/pre-commit", "printf x >>.git/hooks/post-commit"],
    wrapped: ['bash -c "git push"', "sh -c 'git push'", "xargs git push", "timeout 60 git push", "env -i git push",
      "if git push; then echo ok; fi", "{ git push; }", "! git push", "for b in x; do git push; done", 'echo "$(git push)"',
      "echo `git push`"],
    moreHistory: ["git reset HEAD~1", "git reset HEAD~", "git reset abc1234", "git pull --rebase", "git symbolic-ref HEAD refs/heads/x"],
    moreBranch: ["git checkout main", "git checkout feature/x", "git stash branch nb", "git tag -a v1 -m x"],
    identity: ['git commit --author="X <y@z>" -m m', "GIT_AUTHOR_NAME=x git commit -m m", "git -c user.email=x commit -m m"],
    gitdir: ["echo x > .git/config", "sed -i s/a/b/ .git/config"],
  };
  for (const [kind, commands] of Object.entries(refused)) {
    for (const command of commands) assert.ok(bash(command), `${kind}: ${command}`);
  }
  assert.match(bash("git push"), /publishes the approved commit itself/);
  assert.match(bash("git commit --amend"), /do not rewrite history/);
});

test("the workspace is the repository the run is in, wherever it cd'd", () => {
  assert.equal(write(`${WORKSPACE}/README.md`, "Write", `${WORKSPACE}/packages/app`), null);
  assert.match(write("/home/claude-worker/.bashrc", "Write", `${WORKSPACE}/packages/app`), /only inside the workspace/);
  assert.equal(bash("git checkout a.js", `${WORKSPACE}/src`), null, "a path relative to where the shell is");
});

test("writes inside .git or outside the workspace are refused", () => {
  assert.match(write(".git/hooks/post-commit"), /hooks|inside \.git/);
  assert.match(write(`${WORKSPACE}/.git/config`, "Edit"), /inside \.git/);
  assert.match(write("sub/.git/HEAD"), /inside \.git/);
  assert.match(write("/home/claude-worker/.bashrc"), /only inside the workspace/);
  assert.match(write("../other-project/a.js"), /only inside the workspace/);
  assert.match(write(`${WORKSPACE}-evil/a.js`), /only inside the workspace/, "a sibling with the same prefix is outside");
  assert.ok(policyDecision({ tool_name: "Write", tool_input: { file_path: "a.js" } }), "no working directory, no write");
});

test("a command line is read as its simple commands", () => {
  const commands = simpleCommands("A=1 git push && npm test | tee x; echo `git push`").map((words) => words.join(" "));
  assert.deepEqual(commands.sort(), ["echo `", "git push", "git push", "npm test", "tee x"]);
  assert.deepEqual(simpleCommands(`git commit -m "a && b; c"`), [["git", "commit", "-m", "a && b; c"]]);
  assert.deepEqual(simpleCommands("cat <<EOF\ngit push\nEOF\nnpm test").map((words) => words[0]), ["cat", "npm"]);
});

test("the hook answers Claude Code's PreToolUse shape, and refuses what it cannot read", () => {
  assert.deepEqual(hookAnswer(null), {});
  assert.deepEqual(hookAnswer("no").hookSpecificOutput, { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "no" });
  for (const input of [null, [], { tool_name: "Bash", tool_input: null, cwd: WORKSPACE }, { tool_name: "Bash", tool_input: { command: 7 } },
    { tool_name: "Write", tool_input: [], cwd: "relative" }]) {
    assert.doesNotThrow(() => policyDecision(input, { exists }), JSON.stringify(input));
  }
  let out = "";
  runHook({ read: () => "{not json", write: (text) => { out = text; } });
  assert.equal(JSON.parse(out).hookSpecificOutput.permissionDecision, "deny");
  const script = fileURLToPath(new URL("../claude-hooks/policy.mjs", import.meta.url));
  const run = spawnSync(process.execPath, [script], { input: JSON.stringify({ tool_name: "Bash", tool_input: { command: "git push" }, cwd: WORKSPACE }), encoding: "utf8" });
  assert.equal(run.status, 0);
  assert.match(JSON.parse(run.stdout).hookSpecificOutput.permissionDecisionReason, /do not push/);
});

test("only an executor's run carries the policy, and a refusal is an activity event", () => {
  const claude = driverFor("claude");
  const settingsOf = (surface) => {
    const argv = claude.run.argv({ model: "opus", prompt: "x", surface });
    return argv.includes("--settings") ? JSON.parse(argv[argv.indexOf("--settings") + 1]) : null;
  };
  const task = settingsOf("task");
  assert.equal(task.hooks.PreToolUse[0].matcher, "Bash|Edit|Write|MultiEdit|NotebookEdit");
  assert.match(task.hooks.PreToolUse[0].hooks[0].command, /claude-hooks\/policy\.mjs'$/);
  assert.ok(claude.run.argv({ model: "opus", prompt: "x", surface: "task" }).includes("--include-hook-events"));
  for (const surface of ["project", "consult", "gate"]) assert.equal(settingsOf(surface), null, surface);

  const refusal = normalizeClaudeEvent({ type: "system", subtype: "hook_response", hook_event: "PreToolUse", hook_name: "PreToolUse:Bash",
    stdout: JSON.stringify(hookAnswer("The platform publishes the approved commit itself; do not push.")), exit_code: 0, outcome: "success" });
  assert.equal(refusal.eventType, "runtime.policy.refused");
  assert.equal(refusal.details.tool, "Bash");
  assert.match(refusal.summary, /^Platform policy refused Bash: The platform publishes/);
  assert.equal(normalizeClaudeEvent({ type: "system", subtype: "hook_response", hook_event: "PreToolUse", hook_name: "PreToolUse:Bash", stdout: "{}" }), null);
  assert.equal(normalizeClaudeEvent({ type: "system", subtype: "hook_started", hook_event: "PreToolUse" }), null);
  // The first host probe: the hook could not be run, and the call went on.
  const failed = normalizeClaudeEvent({ type: "system", subtype: "hook_response", hook_event: "PreToolUse", hook_name: "PreToolUse:Bash",
    stdout: "", stderr: "/bin/sh: 1: /x/policy.mjs: Permission denied\n", exit_code: 126, outcome: "error" });
  assert.equal(failed.eventType, "runtime.policy.failed");
  assert.match(failed.summary, /did not run: \/bin\/sh: 1: \/x\/policy\.mjs: Permission denied$/);
  // A path with a space or a quote stays one word for the shell that runs the hook.
  const settings = JSON.parse(claude.run.argv({ model: "opus", prompt: "x", surface: "task" })[claude.run.argv({ model: "opus", prompt: "x", surface: "task" }).indexOf("--settings") + 1]);
  const words = simpleCommands(settings.hooks.PreToolUse[0].hooks[0].command);
  assert.equal(words.length, 1);
  assert.equal(words[0].length, 2, "node and the script, each one word");
});
