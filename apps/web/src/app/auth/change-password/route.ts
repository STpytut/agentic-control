import {
  authSiteUrl,
  changeOperatorPassword,
  CsrfError,
  csrfFailureResponse,
  requireCsrf,
  requireSession,
} from "@/lib/auth";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

function changePasswordRedirect(request: Request, error?: string) {
  const url = new URL("/change-password", authSiteUrl(request));
  if (error) url.searchParams.set("error", error);
  return NextResponse.redirect(url, 303);
}

// POST /auth/change-password
//
// Reachable with a session even while must_change_password is set, which is the
// whole point: it is the only way out of that state. Everything else about the
// request — the CSRF token, the current password, the policy — is checked
// exactly as it would be for an operator whose flag is already clear.
export async function POST(request: Request) {
  const session = await requireSession({ allowPasswordChange: true });

  // Before the body is read. `requireCsrf` falls back to a cloned form body when
  // there is no header, and `request.clone()` is unusable once the original has
  // been consumed — so reading the form first would turn every submission into a
  // CSRF failure.
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
    return changePasswordRedirect(request, "unavailable");
  }

  const currentPassword = String(form.get("current_password") ?? "");
  const newPassword = String(form.get("new_password") ?? "");
  const confirmPassword = String(form.get("confirm_password") ?? "");

  if (newPassword !== confirmPassword) return changePasswordRedirect(request, "mismatch");
  if (currentPassword === newPassword) return changePasswordRedirect(request, "same");
  if (!currentPassword) return changePasswordRedirect(request, "current");

  let result;
  try {
    result = await changeOperatorPassword({
      currentPassword,
      newPassword,
      request,
      session,
    });
  } catch {
    return changePasswordRedirect(request, "unavailable");
  }

  if (result.status !== "changed") return changePasswordRedirect(request, result.reason);
  return NextResponse.redirect(new URL("/projects", authSiteUrl(request)), 303);
}
