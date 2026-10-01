import { hasDatabaseConnection, queryJsonRows } from "@/lib/database";

type Json = Record<string, unknown>;

// A chat is a conversation (ADR-0014): a line of tasks in one project. The
// sidebar names it by its first task's title, shows its newest task's status,
// and links to it through that newest task — `/projects/[id]?task=…` is the
// address every event and notification already uses.
export type SidebarChat = {
  conversationId: string;
  taskId: string;
  title: string;
  status: string;
  updatedAt: string;
  needsOperator: boolean;
};

export type SidebarProject = {
  id: string;
  name: string;
  /** What the delete dialog confirms against and sends: the slug and the row version. */
  slug: string;
  version: number;
  /** The repository's URL, when the project has one (an empty workspace has none). */
  repositoryUrl: string | null;
  /** Chats that are not archived (their newest task is not cancelled). */
  chatCount: number;
  /** Chats that wait for the operator: review, input, a dead letter, a failure. */
  attentionCount: number;
  /** GitHub issues waiting to be started as chats (0132), with intake on. */
  issuesWaiting: number;
  /** The most recent chats that are not archived, newest first, at most 30. */
  chats: SidebarChat[];
};

export const SIDEBAR_CHAT_LIMIT = 30;

// What a chat waits for the operator on: its newest task awaiting review, needing
// attention or failed, or any of its tasks with an unanswered input request or
// block, or an unresolved dead letter.
const ATTENTION_STATUSES = ["awaiting_review", "needs_attention", "failed"];

function chatFromRow(row: Json): SidebarChat {
  return {
    conversationId: String(row.conversation_id),
    taskId: String(row.task_id),
    title: String(row.title ?? ""),
    status: String(row.status ?? ""),
    updatedAt: String(row.updated_at ?? ""),
    needsOperator: Boolean(row.needs_operator),
  };
}

export async function getSidebarProjects(ownerId: string): Promise<SidebarProject[]> {
  if (!hasDatabaseConnection()) {
    const now = new Date().toISOString();
    return [{ id: "demo", name: "infra-cod", chatCount: 1, attentionCount: 0, issuesWaiting: 0,
      slug: "infra-cod", version: 1, repositoryUrl: null, chats: [{ conversationId: "demo-conversation", taskId: "demo-task", title: "Describe the next change", status: "draft", updatedAt: now, needsOperator: false }] }];
  }
  const [projectRows, chatRows] = await Promise.all([
    queryJsonRows(`
      SELECT jsonb_build_object('id',p.id,'name',p.name,'slug',p.slug,'version',p.version,'repository_url',p.repository_url,
        'issues_waiting',(SELECT count(*) FROM issue_links l JOIN issue_intake_settings s ON s.project_id=l.project_id AND s.enabled
          WHERE l.project_id=p.id AND l.status='waiting'))::text
      FROM projects p
      WHERE p.owner_id=:'owner_id'::uuid
        AND p.status NOT IN ('archived','deleting','deletion_failed','deleted')
      ORDER BY p.updated_at DESC;
    `, { owner_id: ownerId }),
    queryJsonRows(`
      WITH chats AS (
        SELECT t.project_id,t.conversation_id,
          (array_agg(t.id ORDER BY t.created_at DESC,t.id DESC))[1] AS task_id,
          (array_agg(t.status ORDER BY t.created_at DESC,t.id DESC))[1] AS status,
          (array_agg(t.title ORDER BY t.created_at,t.id))[1] AS title,
          max(t.updated_at) AS updated_at,
          bool_or(EXISTS (SELECT 1 FROM worker_interaction_reports r
                    WHERE r.task_id=t.id AND r.status='finalized' AND r.resolved_at IS NULL)
               OR EXISTS (SELECT 1 FROM runtime_jobs j
                    WHERE j.task_id=t.id AND j.status='dead_letter' AND j.resolved_at IS NULL)) AS blocked
        FROM tasks t JOIN projects p ON p.id=t.project_id
        WHERE p.owner_id=:'owner_id'::uuid AND t.conversation_id IS NOT NULL
          AND p.status NOT IN ('archived','deleting','deletion_failed','deleted')
        GROUP BY t.project_id,t.conversation_id
      ), ranked AS (
        SELECT c.*,
          c.status IN (${ATTENTION_STATUSES.map((status) => `'${status}'`).join(",")}) OR c.blocked AS needs_operator,
          row_number() OVER (PARTITION BY c.project_id ORDER BY c.updated_at DESC,c.conversation_id) AS position,
          count(*) OVER (PARTITION BY c.project_id) AS chat_count,
          count(*) FILTER (WHERE c.status IN (${ATTENTION_STATUSES.map((status) => `'${status}'`).join(",")}) OR c.blocked)
            OVER (PARTITION BY c.project_id) AS attention_count
        FROM chats c WHERE c.status<>'cancelled'
      )
      SELECT jsonb_build_object('project_id',r.project_id,'conversation_id',r.conversation_id,
        'task_id',r.task_id,'title',r.title,'status',r.status,'updated_at',r.updated_at,
        'needs_operator',r.needs_operator,'chat_count',r.chat_count,'attention_count',r.attention_count)::text
      FROM ranked r WHERE r.position<=${SIDEBAR_CHAT_LIMIT}
      ORDER BY r.project_id,r.position;
    `, { owner_id: ownerId }),
  ]);
  const byProject = new Map<string, Json[]>();
  for (const row of chatRows) {
    const key = String(row.project_id);
    byProject.set(key, [...(byProject.get(key) ?? []), row]);
  }
  return projectRows.map((row) => {
    const rows = byProject.get(String(row.id)) ?? [];
    return {
      id: String(row.id),
      name: String(row.name),
      slug: String(row.slug ?? ""),
      version: Number(row.version ?? 0),
      repositoryUrl: typeof row.repository_url === "string" && row.repository_url ? row.repository_url : null,
      chatCount: Number(rows[0]?.chat_count ?? 0),
      attentionCount: Number(rows[0]?.attention_count ?? 0),
      issuesWaiting: Number(row.issues_waiting ?? 0),
      chats: rows.map(chatFromRow),
    };
  });
}

// Archived projects (0120): out of the sidebar, listed in Settings → Projects
// with Restore. Their version is what unarchive_project is fenced on.
export type ArchivedProject = { id: string; name: string; version: number; archivedAt: string };

export async function getArchivedProjects(ownerId: string): Promise<ArchivedProject[]> {
  if (!hasDatabaseConnection()) return [];
  const rows = await queryJsonRows(`
    SELECT jsonb_build_object('id',p.id,'name',p.name,'version',p.version,'archived_at',p.archived_at)::text
    FROM projects p
    WHERE p.owner_id=:'owner_id'::uuid AND p.status='archived'
    ORDER BY p.archived_at DESC NULLS LAST, p.name;
  `, { owner_id: ownerId });
  return rows.map((row) => ({ id: String(row.id), name: String(row.name), version: Number(row.version ?? 0), archivedAt: String(row.archived_at ?? "") }));
}
