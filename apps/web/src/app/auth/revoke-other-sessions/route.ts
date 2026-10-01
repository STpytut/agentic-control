import {
  authSiteUrl,
  CsrfError,
  csrfFailureResponse,
  requireCsrf,
  requireSession,
  revokeOtherOperatorSessions,
} from "@/lib/auth";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

// POST /auth/revoke-other-sessions
//
// "All others" is scoped by the database function to the account holding the
// presented token, and the caller's own row is spared, so this cannot be widened
// into "everyone" by a parameter.
export async function POST(request: Request) {
  const session = await requireSession();

  try {
    await requireCsrf(request, session);
  } catch (error) {
    if (error instanceof CsrfError) return csrfFailureResponse();
    throw error;
  }

  try {
    await revokeOtherOperatorSessions();
  } catch {
    // Nothing to report: the page reloads and shows whatever is left.
  }
  return NextResponse.redirect(new URL("/settings?account=sessions-revoked", authSiteUrl(request)), 303);
}
