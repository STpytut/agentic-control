// The database half of `infra-cod runtime promote` and `rollback` (Stage 12
// W4): the switch goes to runtime_activations (0097), with the qualification
// that earned it. Kept apart so runtime.mjs never loads a database client.

import { closePool, queryJson } from "../control-plane/db.mjs";
import { qualificationDatabaseRole } from "./runtime-qualify-record.mjs";

export async function recordRuntimeActivation({ kind, name, version, from, qualification = null, acceptedUnqualified = false, reason = null, actor }) {
  const role = qualificationDatabaseRole();
  if (role) process.env.PGUSER = role;
  try {
    return await queryJson(
      "SELECT to_jsonb(record_runtime_activation(:'runtime', :'kind', :'version', :'from', NULLIF(:'qualification','')::uuid, :'accepted'::boolean, :'reason', :'actor'))::text;",
      { runtime: name, kind, version, from, qualification: qualification ?? "", accepted: String(Boolean(acceptedUnqualified)), reason: reason ?? "", actor },
    );
  } finally {
    await closePool();
  }
}

// Probation (Stage 12 W4b, 0104): the database's verdict on each runtime's
// open probation, and closing one that passed.
export async function probationVerdicts(runtimes) {
  const role = qualificationDatabaseRole();
  if (role) process.env.PGUSER = role;
  try {
    const verdicts = [];
    for (const runtime of runtimes) {
      verdicts.push(await queryJson("SELECT runtime_probation_verdict(:'runtime')::text;", { runtime }));
    }
    return verdicts;
  } finally {
    await closePool();
  }
}

export async function endProbation(activationId, detail) {
  const role = qualificationDatabaseRole();
  if (role) process.env.PGUSER = role;
  try {
    return await queryJson("SELECT end_runtime_probation(:'id'::uuid, :'detail')::text;", { id: activationId, detail });
  } finally {
    await closePool();
  }
}
