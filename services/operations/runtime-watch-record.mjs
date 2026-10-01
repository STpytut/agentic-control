// The database half of `infra-cod runtime watch --record` (Stage 12 W2), kept
// out of runtime.mjs so the command that installs runtimes never loads a
// database client unless it is asked to record.

import { closePool, queryJson } from "../control-plane/db.mjs";

export async function recordRuntimeWatch(results) {
  try {
    for (const result of results) {
      await queryJson(
        "SELECT record_runtime_watch(:'runtime', :'active', :'versions'::jsonb, :'error')::text;",
        { runtime: result.runtime, active: result.activeVersion ?? "", versions: JSON.stringify(result.versions), error: result.error },
      );
    }
  } finally {
    await closePool();
  }
}
