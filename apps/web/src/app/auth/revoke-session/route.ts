import {
  authSiteUrl,
  CsrfError,
  csrfFailureResponse,
  destroySession,
  requireCsrf,
  requireSession,
  revokeOperatorSession,
} from "@/lib/auth";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

// POST /auth/revoke-session
//
// Revokes one of the caller's own sessions. `revoke_web_session_by_id` derives
// the owner from the presented token, so a session id belonging to somebody else
// is simply not found — this route cannot be used to log out another account.
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
    return settingsError("session-missing");
  }

  const sessionId = String(form.get("session_id") ?? "");
  if (!/^[0-9a-f-]{36}$/i.test(sessionId)) return settingsError("session-missing");

  if (sessionId === session.operator.sessionId) {
    // Revoking the session you are using is a logout; sending the caller back to
    // settings would leave a dead cookie on a page that needs a live one.
    await destroySession("logout");
    return NextResponse.redirect(new URL("/login", authSiteUrl(request)), 303);
  }

  let revoked = false;
  try {
    revoked = await revokeOperatorSession(sessionId);
  } catch {
    revoked = false;
  }
  return settingsError(revoked ? "session-revoked" : "session-missing");
}
