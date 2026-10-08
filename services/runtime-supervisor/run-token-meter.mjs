// A member's token limit per run (rc.142, 0152), metered from the run's own
// stream while it goes.
//
// The count is the usage panel's: input, output, reasoning, cache read and
// write (usage-limits.mjs). Each runtime says it at a different moment, and
// the meter can stop a run only as early as its runtime speaks:
//
// | Runtime        | read from                                | when                 |
// | Claude Code    | each assistant message's `usage`, once   | every model call     |
// |                | per message id (a message's blocks       |                      |
// |                | arrive as separate events, same usage)   |                      |
// | OpenCode       | `step_finish` part.tokens                | every model step     |
// | Codex (`exec`) | `turn.completed` usage                   | the end of the turn  |
//
// So a Codex executor is held to its limit only after its turn: a run past it
// that has not reported is ended as over the limit, one that has reported is
// done. The meter is pure: the supervisor feeds it lines and stops the run.

import { claudeTokens, openCodeTokens } from "./usage-limits.mjs";
import { codexExecTokens } from "./runtime-events.mjs";

const obj = (value) => (value && typeof value === "object" && !Array.isArray(value) ? value : null);

// The tokens one raw event adds, by runtime. `seen` is the run's own memory
// (Claude Code's message ids).
const READERS = Object.freeze({
  claude: (raw, seen) => {
    if (raw?.type !== "assistant") return 0;
    const message = obj(raw.message);
    const id = typeof message?.id === "string" ? message.id : null;
    if (!message?.usage || !id || seen.has(id)) return 0;
    seen.add(id);
    return claudeTokens(message.usage).total;
  },
  opencode: (raw) => (raw?.type === "step_finish" ? openCodeTokens(raw.part?.tokens)?.total ?? 0 : 0),
  codex: (raw) => (raw?.type === "turn.completed" ? codexExecTokens(raw.usage)?.total ?? 0 : 0),
});

export const RUN_TOKEN_LIMIT_MIN = 10_000;
export const RUN_TOKEN_LIMIT_MAX = 1_000_000_000;

// A limit as the database hands it: an integer in range, or none.
export function runTokenLimit(value) {
  const number = typeof value === "string" && /^\d{1,10}$/.test(value) ? Number(value) : value;
  return Number.isInteger(number) && number >= RUN_TOKEN_LIMIT_MIN && number <= RUN_TOKEN_LIMIT_MAX ? number : null;
}

export function createTokenMeter(runtime, limit) {
  const read = READERS[runtime] ?? (() => 0);
  const cap = runTokenLimit(limit);
  const seen = new Set();
  let total = 0;
  let exceeded = false;
  return {
    get limit() { return cap; },
    get total() { return total; },
    get exceeded() { return exceeded; },
    // True the first time the run goes past its limit, and only then.
    add(raw) {
      total += read(raw, seen);
      if (cap === null || exceeded || total <= cap) return false;
      exceeded = true;
      return true;
    },
    describe() {
      return `the run used ${total.toLocaleString("en-US")} tokens, past this member's limit of ${cap?.toLocaleString("en-US")} per run, and was stopped`;
    },
  };
}
