import { requireOperatorApi } from "@/lib/auth";
import { searchOperatorModelCatalog, SEARCH_LIMIT } from "@/lib/model-checks";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// The Models card's and the Team picker's search of one connection's list
// (search_operator_model_catalog): server-side, capped at 50, by id and name,
// with the vendor and "checked only" filters. A read, so a GET — it writes
// nothing and needs no CSRF token; the session guard is the boundary, and the
// database refuses a connection the operator does not own.
export async function GET(request: Request) {
  const operator = await requireOperatorApi();
  if (operator instanceof Response) return operator;
  const params = new URL(request.url).searchParams;
  const connectionId = params.get("connection") ?? "";
  if (!uuidPattern.test(connectionId)) return NextResponse.json({ ok: false, error: "connection is invalid" }, { status: 400 });
  const vendor = (params.get("vendor") ?? "").slice(0, 80);
  const limit = Number.parseInt(params.get("limit") ?? "", 10);
  try {
    const search = await searchOperatorModelCatalog(operator.userId, connectionId, params.get("q") ?? "",
      { vendor: vendor || null, checkedOnly: params.get("checked") === "1" },
      Number.isInteger(limit) ? limit : SEARCH_LIMIT);
    return NextResponse.json({ ok: true, ...search });
  } catch (error) {
    const message = error instanceof Error ? error.message : "The search failed";
    return NextResponse.json({ ok: false, error: message }, { status: message.includes("resource is unavailable") ? 404 : 400 });
  }
}
