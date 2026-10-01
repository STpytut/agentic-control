import { isMain } from "./entrypoint.mjs";
import { queryJsonRows, closePool } from "./db.mjs";
import { runPollLoop, shutdownSignal } from "./worker-loop.mjs";

export async function reconcileOnce({
  reconcilerId = process.env.RECONCILER_ID ?? `reconciler-${process.pid}`,
  batchSize = Number(process.env.RECONCILER_BATCH_SIZE ?? 20),
} = {}) {
  const reconciled = await queryJsonRows(
    `SELECT reconcile_expired_workspace_locks(
      :'reconciler_id', :'batch_size'::integer
    )::text;`,
    { reconciler_id: reconcilerId, batch_size: batchSize },
  );
  return { reconcilerId, reconciled };
}

export function runReconciler({ signal, once = false } = {}) {
  return runPollLoop({
    name: "reconciler", pollMs: Number(process.env.RECONCILER_POLL_MS ?? 60_000), signal, once,
    fallbackMessage: "The reconciler cycle failed.",
    tick: async () => {
      const result = await reconcileOnce();
      return result.reconciled.length > 0 ? result : undefined;
    },
  });
}

async function main() {
  if (process.argv[2] === "once") {
    process.stdout.write(`${JSON.stringify(await reconcileOnce())}\n`);
    return;
  }
  await runReconciler({ signal: shutdownSignal() });
}

if (isMain(import.meta.url)) {
  try { await main(); } finally { await closePool(); }
}
