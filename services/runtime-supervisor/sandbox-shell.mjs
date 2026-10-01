// The environment that makes a runtime's commands run in sandbox-shell/bash
// (Stage 12 M0, docs/STAGE_12_CREDENTIAL_ISOLATION.md): bash in bubblewrap
// with the runtime's login covered. For a runtime that takes its tools' shell
// from the environment — OpenCode reads $SHELL.
//
// Pure: a driver imports it on both sides.

import path from "node:path";
import { fileURLToPath } from "node:url";

export const SANDBOX_SHELL = fileURLToPath(new URL("./sandbox-shell/bash", import.meta.url));

// Each `loginState` entry twice: relative, for whatever $HOME the launch has (a
// qualification's scratch home), and under the adapter's real home, which the
// runtime's user can read from a scratch home too.
export function hiddenState(adapter) {
  const entries = adapter.loginState ?? [];
  if (!entries.length) throw new Error(`${adapter.name} declares no login state to hide`);
  for (const entry of entries) {
    if (path.isAbsolute(entry) || entry.split("/").includes("..") || entry.includes(":")) {
      throw new Error(`${adapter.name}: login state ${entry} is not a plain path inside the home`);
    }
  }
  return [...entries, ...entries.map((entry) => path.posix.join(adapter.home, entry))];
}

// What inside the hidden state the shell must still reach (`shellKeptState`,
// relative to the home): bound back over the cover.
export function keptState(adapter) {
  const entries = adapter.shellKeptState ?? [];
  for (const entry of entries) {
    if (path.isAbsolute(entry) || entry.split("/").includes("..") || entry.includes(":")) {
      throw new Error(`${adapter.name}: kept state ${entry} is not a plain path inside the home`);
    }
  }
  return entries;
}

// `variables` names every variable the runtime takes its shell from: OpenCode
// reads SHELL; Claude Code reads CLAUDE_CODE_SHELL (and SHELL for the rest).
export function sandboxShellEnvironment(adapter, variables = ["SHELL"]) {
  const names = Array.isArray(variables) ? variables : [variables];
  const kept = keptState(adapter);
  return [
    ...names.map((name) => `${name}=${SANDBOX_SHELL}`),
    `INFRA_COD_HIDDEN_STATE=${hiddenState(adapter).join(":")}`,
    ...(kept.length ? [`INFRA_COD_KEPT_STATE=${kept.join(":")}`] : []),
  ];
}
