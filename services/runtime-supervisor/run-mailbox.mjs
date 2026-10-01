// The active-run mailbox, delivered (WP-9a, migration 0070).
//
// Whoever holds a job's lease delivers the commands addressed to its run: the
// Codex chat worker for a turn, the supervisor for an OpenCode run. Both used to
// poll `runtime_interrupt_request` and act on a flag; both now take commands
// from `run_commands`, one at a time and in the run's order, and report what
// the runtime answered.
//
// What this module decides, and what it does not:
//
//   * which capability a command needs — a kind the driver does not declare is
//     `failed` with `run_command_unsupported`, and never becomes a fresh prompt
//     (prework A4: that would replace the agent's session);
//   * how a delivery ends — `acknowledged` with the runtime's receipt, `failed`
//     when it is known nothing reached the runtime, `outcome_unknown` when it
//     may have;
//
// and not how a runtime is interrupted. That is the caller's `deliver`, because
// it is the runtime's: a JSON-RPC request for Codex, a process group for
// OpenCode.

import { hasCapability } from "./drivers/capabilities.mjs";

// The capability each kind of command needs from the run's driver.
export const COMMAND_CAPABILITY = Object.freeze({
  interrupt: "interrupt",
  steer: "input.steer",
  input_response: "input.respond",
});

// A delivery that may have reached the runtime and whose answer did not come
// back. Thrown by a `deliver` that cannot say either way; anything else it
// throws is a refusal, and nothing reached the runtime.
export class DeliveryOutcomeUnknown extends Error {
  constructor(message, detail = {}) {
    super(message);
    this.name = "DeliveryOutcomeUnknown";
    this.detail = detail;
  }
}

// Polls the mailbox of one job's run while the run lives.
//
// `deliver[kind](command)` performs the delivery and resolves to the native
// receipt. `onCommand(command)` is told what was taken, before delivery — the
// caller needs to know an interrupt is under way before the runtime's own end
// arrives. `stop()` ends the polling and waits for a delivery in progress: a run
// must not be finalized while its interrupt is still being acknowledged, or the
// run's end would mark the command `outcome_unknown` a moment before its receipt.
export function startMailbox({
  jobId, workerId, driver, query, deliver, onCommand = () => {}, pollMs = 500, log = defaultLog,
}) {
  let stopped = false;
  let current = Promise.resolve();
  let busy = false;
  const delivered = [];

  async function finish(command, status, reason, detail) {
    await query(`SELECT finish_run_command(:'command_id'::bigint,:'worker_id',:'status',:'reason',:'detail'::jsonb)::text;`,
      { command_id: command.command_id, worker_id: workerId, status, reason, detail: JSON.stringify(detail ?? {}) });
  }

  async function handle(command) {
    const kind = command.command_kind;
    const capability = COMMAND_CAPABILITY[kind];
    onCommand(command);
    if (!capability || !hasCapability(driver, capability) || typeof deliver[kind] !== "function") {
      await finish(command, "failed", "run_command_unsupported",
        { runtime: driver.name, capability: capability ?? null, kind });
      delivered.push({ ...command, status: "failed", reason: "run_command_unsupported" });
      log({ type: "run_command.unsupported", job_id: jobId, command_id: command.command_id, kind, runtime: driver.name });
      return;
    }
    let receipt;
    try {
      receipt = await deliver[kind](command);
    } catch (error) {
      const unknown = error instanceof DeliveryOutcomeUnknown;
      await finish(command, unknown ? "outcome_unknown" : "failed",
        unknown ? "run_command_delivery_lost" : "run_command_delivery_failed",
        { error: String(error?.message ?? error).slice(0, 500), ...(error?.detail ?? {}) });
      delivered.push({ ...command, status: unknown ? "outcome_unknown" : "failed" });
      log({ type: "run_command.not_acknowledged", job_id: jobId, command_id: command.command_id, kind,
        outcome: unknown ? "outcome_unknown" : "failed", error: String(error?.message ?? error).slice(0, 200) });
      return;
    }
    await query(`SELECT acknowledge_run_command(:'command_id'::bigint,:'worker_id',:'receipt'::jsonb)::text;`,
      { command_id: command.command_id, worker_id: workerId, receipt: JSON.stringify(receipt) });
    delivered.push({ ...command, status: "acknowledged", native_receipt: receipt });
    log({ type: "run_command.acknowledged", job_id: jobId, command_id: command.command_id, kind });
  }

  const timer = setInterval(() => {
    if (stopped || busy) return;
    busy = true;
    current = (async () => {
      try {
        const command = await query(`SELECT claim_run_command(:'job_id'::bigint,:'worker_id')::text;`,
          { job_id: jobId, worker_id: workerId });
        if (command && !stopped) await handle(command);
        // Taken as the run was ending: nothing was sent to the runtime.
        else if (command) await finish(command, "failed", "run_command_run_ended", { stopped: true });
      } catch (error) {
        log({ type: "run_command.poll_failed", job_id: jobId, error: String(error?.message ?? error).slice(0, 200) });
      } finally {
        busy = false;
      }
    })();
  }, pollMs);
  timer.unref?.();

  return {
    delivered,
    async stop() {
      stopped = true;
      clearInterval(timer);
      await current;
    },
  };
}

function defaultLog(line) {
  process.stderr.write(`${JSON.stringify(line)}\n`);
}
