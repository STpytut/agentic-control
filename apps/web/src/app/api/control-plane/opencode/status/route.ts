import { requireOperatorApi } from "@/lib/auth";
import { getOperatorOpenCodeState } from "@/lib/opencode-connections";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET() {
  const operator = await requireOperatorApi();
  if (operator instanceof Response) return operator;
  const state = await getOperatorOpenCodeState(operator.userId);
  return NextResponse.json({ ok: true, ...state });
}
