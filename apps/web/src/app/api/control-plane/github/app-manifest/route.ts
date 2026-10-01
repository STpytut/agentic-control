import { redirect } from "next/navigation";
import { NextResponse } from "next/server";
import { requireOperatorApi } from "@/lib/auth";
import { encryptGitHubOAuthCode, stateDigest } from "@/lib/github-connections";
import { executeJson } from "@/lib/database";

export const dynamic = "force-dynamic";

// Where GitHub sends the owner after "Create GitHub App" (Stage 12 G1): a
// one-hour code that converts into the App, key and all. It is sealed here and
// handed to the GitHub broker, which converts it; the web never holds the App's
// secrets. The state ties the code to the operator who pressed the button.
export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code") ?? "";
  const state = url.searchParams.get("state") ?? "";
  const operator = await requireOperatorApi();
  if (operator instanceof Response) {
    return new NextResponse(
      `<!doctype html><meta charset="utf-8"><title>GitHub App</title>` +
      `<style>body{font:14px/1.5 system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem}a{color:#2563eb}</style>` +
      `<h1>Sign in to finish creating the GitHub App</h1>` +
      `<p>GitHub created the App, but this panel needs you signed in to take it over. Sign in and create it again from Settings → Connections; the App GitHub made can be deleted in its settings.</p>` +
      `<p><a href="/login">Go to sign in</a></p>`,
      { headers: { "content-type": "text/html; charset=utf-8" } },
    );
  }
  if (!/^[A-Za-z0-9_-]{8,200}$/.test(code) || !/^[0-9a-f]{64}$/.test(state)) {
    redirect("/settings/connections?github=app_error");
  }
  try {
    const sealed = encryptGitHubOAuthCode(code);
    await executeJson(
      `SELECT record_github_app_manifest_code(:'operator_id'::uuid,:'state_digest',:'ciphertext',:'iv',:'tag')::text;`,
      { operator_id: operator.userId, state_digest: stateDigest(state), ciphertext: sealed.ciphertext, iv: sealed.iv, tag: sealed.tag },
    );
  } catch (error) {
    process.stderr.write(`${JSON.stringify({
      type: "github.app_manifest_failed",
      operator_id: operator.userId,
      reason: (error instanceof Error ? error.message : String(error)).slice(0, 300),
    })}\n`);
    redirect("/settings/connections?github=app_error");
  }
  redirect("/settings/connections?github=app_creating");
}
