import { getControlPlaneSnapshot } from "@/lib/control-plane";
import { requireOperatorApi } from "@/lib/auth";

export const dynamic = "force-dynamic";

export async function GET() {
  const operator = await requireOperatorApi();
  if (operator instanceof Response) return operator;
  const snapshot = await getControlPlaneSnapshot(operator.userId);
  return Response.json(snapshot, {
    headers: { "Cache-Control": "no-store" },
  });
}
