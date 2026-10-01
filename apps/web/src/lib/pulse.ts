import { hasDatabaseConnection, queryJsonRows } from "@/lib/database";

// What the panel's pages show, reduced to one fingerprint (the owner,
// 2026-09-29: a new project stayed "pending" until the page was reloaded). The
// pulse (components/live-pulse.tsx) asks for it every few seconds and
// refreshes the page when it changes, so a project's setup, a chat's status, a
// run starting or ending and a connection's state reach whatever page is open.
//
// Only what changes when something the operator would see changes: each
// project's row (its status, version and settings, where setup keeps its
// progress), each chat's latest update, the work that is queued or running,
// the newest event, workspace operations, connections and runtime updates. A run's heartbeat is
// left out: it moves every few seconds and changes nothing on a page.
export async function getPulse(ownerId: string): Promise<string> {
  if (!hasDatabaseConnection()) return "demo";
  const rows = await queryJsonRows(`
    WITH mine AS (SELECT p.id FROM projects p WHERE p.owner_id=:'owner_id'::uuid)
    SELECT jsonb_build_object('pulse', md5(concat_ws('|',
      (SELECT string_agg(p.id::text||':'||p.version||':'||p.status||':'||md5(p.settings::text), ',' ORDER BY p.id)
         FROM projects p WHERE p.owner_id=:'owner_id'::uuid),
      (SELECT count(*)||':'||COALESCE(max(t.updated_at)::text,'') FROM tasks t WHERE t.project_id IN (SELECT id FROM mine)),
      (SELECT count(*)||':'||COALESCE(sum(hashtext(j.id::text||j.status))::text,'') FROM runtime_jobs j
         WHERE j.project_id IN (SELECT id FROM mine) AND j.status IN ('pending','in_flight','dead_letter')),
      (SELECT COALESCE(max(e.occurred_at)::text,'') FROM domain_events e WHERE e.project_id IN (SELECT id FROM mine)),
      (SELECT count(*)||':'||COALESCE(max(greatest(w.requested_at,w.started_at,w.completed_at))::text,'') FROM workspace_operations w
         WHERE w.project_id IN (SELECT id FROM mine)),
      (SELECT count(*)||':'||COALESCE(max(c.updated_at)::text,'')||':'||COALESCE(string_agg(c.status, ',' ORDER BY c.id),'')
         FROM provider_connections c WHERE c.operator_id=:'owner_id'::uuid),
      -- Qualify and Promote from Settings → Runtimes (0127): the page follows
      -- the host's answer without a reload.
      md5(get_runtime_update_requests()::text)
    )))::text;
  `, { owner_id: ownerId });
  return String(rows[0]?.pulse ?? "");
}
