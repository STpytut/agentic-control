import { requireOperatorApi } from "@/lib/auth";
import { getOperatorUsageLimits } from "@/lib/usage-data";

export const dynamic = "force-dynamic";

// Settings → Limits & usage, polled while the page is open (Stage 12, 0114).
export async function GET() {
  const operator = await requireOperatorApi();
  if (operator instanceof Response) return operator;
  const usage = await getOperatorUsageLimits(operator.userId);
  return Response.json({ usage }, { headers: { "Cache-Control": "no-store" } });
}
