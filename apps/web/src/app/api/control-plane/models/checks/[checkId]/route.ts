import { requireOperatorApi } from "@/lib/auth";
import { getModelCheck } from "@/lib/model-checks";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// One model check, as the Team dialog and the Models card poll it (every 2 s)
// after a pick, a pin or "Check again" (get_model_check). A read: the database
// answers only for a check of the operator's own.
export async function GET(_request: Request, { params }: { params: Promise<{ checkId: string }> }) {
  const operator = await requireOperatorApi();
  if (operator instanceof Response) return operator;
  const { checkId } = await params;
  if (!uuidPattern.test(checkId)) return NextResponse.json({ ok: false, error: "check is invalid" }, { status: 400 });
  try {
    const check = await getModelCheck(operator.userId, checkId);
    if (!check) return NextResponse.json({ ok: false, error: "Model resource is unavailable" }, { status: 404 });
    return NextResponse.json({ ok: true, check });
  } catch (error) {
    const message = error instanceof Error ? error.message : "The check could not be read";
    return NextResponse.json({ ok: false, error: message }, { status: message.includes("resource is unavailable") ? 404 : 400 });
  }
}
