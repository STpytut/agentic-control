import { getConversationUsage } from "@/lib/product-data";
import { getTaskUsage } from "@/lib/usage-data";
import { requireOperatorApi } from "@/lib/auth";

export const dynamic = "force-dynamic";

// The task view's consumption, polled every few seconds while a run is going
// (Stage 12): per member from run_usage (0114), and the per-runtime usage the
// card read before it, kept for a panel of the previous release.
export async function GET(request: Request, { params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  const operator = await requireOperatorApi();
  if (operator instanceof Response) return operator;
  const taskId = new URL(request.url).searchParams.get("taskId");
  if (!taskId) return Response.json({ error: "taskId is required" }, { status: 400 });
  const [usage, taskUsage] = await Promise.all([
    getConversationUsage(operator.userId,projectId,taskId),
    getTaskUsage(operator.userId,projectId,taskId),
  ]);
  return Response.json({ projectId,taskId,usage,taskUsage },{ headers: { "Cache-Control": "no-store" } });
}
