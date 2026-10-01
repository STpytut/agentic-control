// The database half of limits and consumption (Stage 12; 0114). One call per
// function, the operator first; the parsing is ./usage.ts. A server whose
// database predates 0114 has neither function, and the cards then say so
// rather than failing the page.
import { executeJson, hasDatabaseConnection } from "@/lib/database";
import { operatorUsageFromJson, taskUsageFromJson, type OperatorUsage, type TaskUsage } from "@/lib/usage";

function missing(error: unknown) {
  return Boolean(error && typeof error === "object" && (error as { code?: unknown }).code === "42883");
}

export async function getOperatorUsageLimits(ownerId: string): Promise<OperatorUsage | null> {
  if (!hasDatabaseConnection()) return null;
  try {
    const value = await executeJson(`SELECT get_operator_usage_limits(:'owner_id'::uuid)::text;`, { owner_id: ownerId });
    return value ? operatorUsageFromJson(value) : null;
  } catch (error) {
    if (missing(error)) return null;
    throw error;
  }
}

export async function getTaskUsage(ownerId: string, projectId: string, taskId: string): Promise<TaskUsage | null> {
  if (!hasDatabaseConnection()) return null;
  try {
    const value = await executeJson(`SELECT get_task_usage(:'project_id'::uuid,:'task_id'::uuid,:'owner_id'::uuid)::text;`,
      { owner_id: ownerId, project_id: projectId, task_id: taskId });
    return taskUsageFromJson(value);
  } catch (error) {
    if (missing(error)) return null;
    throw error;
  }
}
