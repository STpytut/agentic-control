import { attemptLogin, authSiteUrl, clearLoginCsrfCookie, verifyLoginCsrf } from "@/lib/auth";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

function loginRedirect(request: Request, error: string) {
  const url = new URL("/login", authSiteUrl(request));
  url.searchParams.set("error", error);
  return NextResponse.redirect(url, 303);
}

export async function POST(request: Request) {
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return loginRedirect(request, "invalid");
  }

  const username = String(form.get("username") ?? "").trim().toLowerCase();
  const password = String(form.get("password") ?? "");
  const csrfToken = String(form.get("csrf_token") ?? "");

  // Pre-auth double submit. An attacker who can post cross-site can neither
  // read the login cookie nor satisfy the Origin and Sec-Fetch-Site checks.
  if (!(await verifyLoginCsrf(request, csrfToken))) {
    return loginRedirect(request, "csrf");
  }
  if (!username || !password) return loginRedirect(request, "invalid");

  let result;
  try {
    result = await attemptLogin({ username, password, request });
  } catch {
    return loginRedirect(request, "unavailable");
  }

  if (result.status !== "success") {
    // A locked-out account and a wrong password produce the same code, the same
    // redirect and the same body. The lockout is per submitted username, known
    // or not, so saying "locked" would leak nothing about existence — but the
    // specification asks for one message, and one message is what it gets.
    return loginRedirect(request, result.reason === "locked" ? "invalid" : result.reason);
  }

  // The pre-auth token has done its job and must not linger alongside a session.
  await clearLoginCsrfCookie();

  const target = result.operator.mustChangePassword ? "/change-password" : "/projects";
  return NextResponse.redirect(new URL(target, authSiteUrl(request)), 303);
}
