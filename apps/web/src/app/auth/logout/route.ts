import { authSiteUrl, csrfFailureResponse, destroySession, getSession, requireCsrf } from "@/lib/auth";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

// POST /auth/logout
//
// CSRF-protected on purpose: without it any third-party page could force a
// logout with a cross-site form, which is a denial of service an attacker gets
// for free. The cookie is cleared whether or not a session was found, so a
// repeated logout is a no-op rather than an error, and a stale cookie from
// before the logout cannot be replayed.
export async function POST(request: Request) {
  const session = await getSession();

  if (session) {
    try {
      // Reads the header first and falls back to the form field, so both the
      // settings button and a JSON client are covered.
      await requireCsrf(request, session);
    } catch {
      return csrfFailureResponse();
    }
    await destroySession("logout");
  } else {
    await destroySession("logout");
  }

  return NextResponse.redirect(new URL("/login", authSiteUrl(request)), 303);
}
