import { requireOperatorApi } from "@/lib/auth";
import { getOperatorCodexState } from "@/lib/codex-connections";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET() {
  const operator = await requireOperatorApi();
  if (operator instanceof Response) return operator;
  const state = await getOperatorCodexState(operator.userId);
  return NextResponse.json({ ok: true, ...state });
}
