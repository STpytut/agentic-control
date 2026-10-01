import { isMain } from "./entrypoint.mjs";
import { queryJson, queryJsonRows, closePool } from "./db.mjs";
import { runPollLoop, shutdownSignal } from "./worker-loop.mjs";

const defaultDispatcherId = `dispatcher-${process.pid}`;

export async function dispatchOnce({
  dispatcherId = process.env.DISPATCHER_ID ?? defaultDispatcherId,
  batchSize = Number(process.env.DISPATCHER_BATCH_SIZE ?? 20),
  lease = process.env.DISPATCHER_LEASE ?? "30 seconds",
  retryDelay = process.env.DISPATCHER_RETRY_DELAY ?? "10 seconds",
  maxAttempts = Number(process.env.DISPATCHER_MAX_ATTEMPTS ?? 10),
} = {}) {
  const messages = await queryJsonRows(
    `SELECT to_jsonb(m)::text
     FROM claim_outbox(:'dispatcher_id', :'batch_size'::integer, :'lease'::interval) m;`,
    { dispatcher_id: dispatcherId, batch_size: batchSize, lease },
  );
  const routed = [];
  const failed = [];

  for (const message of messages) {
    try {
      routed.push(
        await queryJson(
          `SELECT route_outbox_message(:'message_id'::bigint, :'dispatcher_id')::text;`,
          { message_id: message.id, dispatcher_id: dispatcherId },
        ),
      );
    } catch (error) {
      const status = await queryJson(
        `SELECT to_jsonb(retry_outbox_message(
          :'message_id'::bigint, :'dispatcher_id', :'error',
          :'retry_delay'::interval, :'max_attempts'::integer
        ))::text;`,
        {
          message_id: message.id,
          dispatcher_id: dispatcherId,
          error: error.message,
          retry_delay: retryDelay,
          max_attempts: maxAttempts,
        },
      );
      failed.push({ messageId: message.id, error: error.message, status });
    }
  }
  return { dispatcherId, claimed: messages.length, routed, failed };
}

// The cycle line is written only when the cycle did something; a dispatcher
// polling every 15 seconds would otherwise fill the journal with proof that the
// outbox was empty.
export function runDispatcher({ signal, once = false } = {}) {
  return runPollLoop({
    name: "dispatcher", pollMs: Number(process.env.DISPATCHER_POLL_MS ?? 15_000), signal, once,
    fallbackMessage: "The dispatcher cycle failed.",
    tick: async () => {
      const result = await dispatchOnce();
      return result.claimed > 0 || result.failed.length > 0 ? result : undefined;
    },
  });
}

async function main() {
  if (process.argv[2] === "once") {
    process.stdout.write(`${JSON.stringify(await dispatchOnce())}\n`);
    return;
  }
  await runDispatcher({ signal: shutdownSignal() });
}

if (isMain(import.meta.url)) {
  try { await main(); } finally { await closePool(); }
}
