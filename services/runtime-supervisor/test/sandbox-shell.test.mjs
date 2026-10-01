import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { statSync } from "node:fs";

import { adapterFor } from "../../operations/runtime-adapters.mjs";
import { SANDBOX_SHELL, hiddenState, sandboxShellEnvironment } from "../sandbox-shell.mjs";

// Stage 12 M0 (docs/STAGE_12_CREDENTIAL_ISOLATION.md). Bubblewrap itself is
// proven on the host — by `doctor` (runtime.sandbox_shell) and by a
// qualification's login.isolated; here, what the shell is told and that it
// fails closed.

test("each runtime's login is hidden relative to $HOME and under its real home", () => {
  assert.deepEqual(hiddenState(adapterFor("opencode")), [".local/share/opencode", "/home/opencode-worker/.local/share/opencode"]);
  assert.deepEqual(hiddenState(adapterFor("claude")), [".claude", ".claude.json", "/home/claude-worker/.claude", "/home/claude-worker/.claude.json"]);
  assert.deepEqual(sandboxShellEnvironment(adapterFor("opencode")), [
    `SHELL=${SANDBOX_SHELL}`, "INFRA_COD_HIDDEN_STATE=.local/share/opencode:/home/opencode-worker/.local/share/opencode",
  ]);
  assert.deepEqual(sandboxShellEnvironment(adapterFor("claude"), ["CLAUDE_CODE_SHELL", "SHELL"]), [
    `CLAUDE_CODE_SHELL=${SANDBOX_SHELL}`, `SHELL=${SANDBOX_SHELL}`,
    "INFRA_COD_HIDDEN_STATE=.claude:.claude.json:/home/claude-worker/.claude:/home/claude-worker/.claude.json",
    "INFRA_COD_KEPT_STATE=.claude/shell-snapshots",
  ]);
});

test("a login state that is not a plain path inside the home is refused", () => {
  for (const loginState of [["/etc/passwd"], ["../other"], ["a:b"], []]) {
    assert.throws(() => hiddenState({ name: "x", home: "/home/x", loginState }));
  }
});

test("the sandbox shell is executable and refuses to run a command with nothing declared to hide", () => {
  assert.ok(statSync(SANDBOX_SHELL).mode & 0o111, "sandbox-shell/bash is not executable");
  for (const env of [{ HOME: "/tmp", PATH: "/usr/bin:/bin" }, { HOME: "/tmp", PATH: "/usr/bin:/bin", INFRA_COD_HIDDEN_STATE: "" }]) {
    const result = spawnSync(SANDBOX_SHELL, ["-c", "echo RAN"], { env, encoding: "utf8" });
    assert.equal(result.status, 126);
    assert.doesNotMatch(result.stdout, /RAN/);
    assert.match(result.stderr, /nothing to hide is declared/);
  }
});
