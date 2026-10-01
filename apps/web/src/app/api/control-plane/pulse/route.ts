import { getPulse } from "@/lib/pulse";
import { requireOperatorApi } from "@/lib/auth";

export const dynamic = "force-dynamic";

export async function GET() {
  const operator = await requireOperatorApi();
  if (operator instanceof Response) return operator;
  return Response.json({ pulse: await getPulse(operator.userId) }, { headers: { "Cache-Control": "no-store" } });
}
