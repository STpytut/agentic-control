import { getTaskActivity } from "@/lib/product-data";
import { requireOperatorApi } from "@/lib/auth";

export const dynamic = "force-dynamic";

export async function GET(request: Request, { params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  const operator = await requireOperatorApi();
  if (operator instanceof Response) return operator;
  const taskId = new URL(request.url).searchParams.get("taskId");
  if (!taskId) return Response.json({ error: "taskId is required" }, { status: 400 });
  const activity = await getTaskActivity(operator.userId,projectId,taskId);
  return Response.json({ projectId, taskId, activity }, { headers: { "Cache-Control": "no-store" } });
}
