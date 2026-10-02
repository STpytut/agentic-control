// The database half of `infra-cod runtime qualify` (Stage 12 W3): the evidence
// goes to runtime_qualifications and its checks (0096), where the database
// derives the result. Kept apart so runtime.mjs never loads a database client.

import { closePool, queryJson } from "../control-plane/db.mjs";

// Root reaches PostgreSQL by peer, mapped to infra_worker — the role that holds
// these functions — as the console does (console.mjs, consoleDatabaseRole).
export function qualificationDatabaseRole(env = process.env, uid = process.getuid?.()) {
  if (env.DATABASE_URL || env.PGUSER || uid !== 0) return null;
  return "infra_worker";
}

export function databaseRecorder() {
  const role = qualificationDatabaseRole();
  if (role) process.env.PGUSER = role;
  return {
    async begin({ runtime, version, adapterVersion, releaseVersion, actor, facts }) {
      const value = await queryJson(
        "SELECT to_jsonb(begin_runtime_qualification(:'runtime', :'version', :'adapter', :'release', :'actor', :'facts'::jsonb))::text;",
        { runtime, version, adapter: adapterVersion, release: releaseVersion, actor, facts: JSON.stringify(facts ?? {}) },
      );
      return String(value);
    },
    async check(id, row) {
      await queryJson(
        "SELECT '{}'::text FROM (SELECT record_qualification_check(:'id'::uuid, :'key', :'capability', :'result', :'class', :'duration'::int, :'detail', :'evidence'::jsonb)) recorded;",
        { id, key: row.key, capability: row.capability, result: row.result, class: row.failureClass, duration: String(row.durationMs), detail: row.detail, evidence: JSON.stringify(row.evidence ?? {}) },
      );
    },
    async finish(id, { suite, refused, summary = "" }) {
      return queryJson(
        "SELECT finish_runtime_qualification(:'id'::uuid, :'suite'::text[], :'refused'::boolean, :'summary')::text;",
        { id, suite: `{${suite.join(",")}}`, refused: String(Boolean(refused)), summary },
      );
    },
    // The models a runtime's teams use today: project defaults and open tasks'
    // snapshots. The qualification checks each on the candidate, so a
    // promotion never leaves a team without a checked model.
    async modelsInUse(runtime) {
      const value = await queryJson(`WITH used AS (
          SELECT m.runtime_type, m.provider_id, m.model_id FROM project_runtime_defaults d
            JOIN projects p ON p.id=d.project_id AND p.status NOT IN ('deleted','deleting')
            JOIN provider_model_catalog m ON m.id=d.orchestrator_entry_id
          UNION SELECT m.runtime_type, m.provider_id, m.model_id FROM project_runtime_default_executors e
            JOIN projects p ON p.id=e.project_id AND p.status NOT IN ('deleted','deleting')
            JOIN provider_model_catalog m ON m.id=e.catalog_entry_id
          UNION SELECT s.orchestrator->>'runtime_type', s.orchestrator->>'provider_id', s.orchestrator->>'model_id'
            FROM task_runtime_snapshots s JOIN tasks t ON t.id=s.task_id AND t.status NOT IN ('approved','cancelled','failed')
          UNION SELECT x->>'runtime_type', x->>'provider_id', x->>'model_id'
            FROM task_runtime_snapshots s JOIN tasks t ON t.id=s.task_id AND t.status NOT IN ('approved','cancelled','failed'),
              jsonb_array_elements(s.executors) x)
        SELECT COALESCE(jsonb_agg(jsonb_build_object('provider', provider_id, 'model', model_id) ORDER BY provider_id, model_id), '[]')::text
        FROM used WHERE runtime_type = :'runtime' AND model_id IS NOT NULL;`, { runtime });
      if (Array.isArray(value) && value.length) return value.slice(0, 8);
      // A new host has no team yet, and a qualification that found nothing to
      // run turns with ended incomplete — so the update that a too-old runtime
      // needed was never offered (rc.124, the first clean install). One model
      // this host has checked stands in, the smallest one there is.
      const fallback = await queryJson(`SELECT COALESCE(jsonb_agg(jsonb_build_object('provider', provider_id, 'model', model_id)), '[]')::text
        FROM (SELECT provider_id, model_id FROM provider_model_catalog
              WHERE runtime_type = :'runtime' AND status = 'verified' AND model_id IS NOT NULL
              ORDER BY (model_id ~* '(haiku|mini|flash|nano|small)') DESC, model_id LIMIT 1) m;`, { runtime });
      return Array.isArray(fallback) ? fallback : [];
    },
    async close() { await closePool(); },
  };
}
