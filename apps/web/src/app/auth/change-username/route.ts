import {
  authSiteUrl,
  changeOperatorUsername,
  CsrfError,
  csrfFailureResponse,
  requireCsrf,
  requireSession,
} from "@/lib/auth";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

// POST /auth/change-username
//
// A rename ends every session, including the caller's, so the operator is sent
// back to /login rather than to a page whose cookie is already dead.
export async function POST(request: Request) {
  const session = await requireSession();

  const settingsError = (reason: string) =>
    NextResponse.redirect(new URL(`/settings?account=${reason}`, authSiteUrl(request)), 303);

  // Before the body is read: `requireCsrf` clones the request to read a form
  // field, and a clone is unusable once the original body has been consumed.
  try {
    await requireCsrf(request, session);
  } catch (error) {
    if (error instanceof CsrfError) return csrfFailureResponse();
    throw error;
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return settingsError("username-invalid");
  }

  const username = String(form.get("username") ?? "");
  let result;
  try {
    result = await changeOperatorUsername({ username, session });
  } catch {
    result = { status: "denied" as const, reason: "unavailable" as const };
  }

  if (result.status !== "changed") {
    // A rename that collides with an existing username surfaces as a database
    // error, which is the same answer to the operator as "not allowed".
    const reason = result.reason === "invalid" ? "username-invalid" : "username-taken";
    return settingsError(reason);
  }

  // The rename itself is audited inside `changeOperatorUsername`, together with
  // the number of sessions it ended.
  return NextResponse.redirect(new URL("/login?error=renamed", authSiteUrl(request)), 303);
}
