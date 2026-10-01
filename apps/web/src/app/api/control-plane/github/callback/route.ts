import { redirect } from "next/navigation";
import { NextResponse } from "next/server";
import { requireOperatorApi } from "@/lib/auth";
import { encryptGitHubOAuthCode, getGitHubAppConfig, stateDigest } from "@/lib/github-connections";
import { executeJson } from "@/lib/database";

export const dynamic = "force-dynamic";

function settingsRedirect(outcome: "connecting" | "error" | "updated") {
  redirect(`/settings?github=${outcome}`);
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const state = url.searchParams.get("state") ?? "";
  const installationId = url.searchParams.get("installation_id") ?? "";
  const setupAction = url.searchParams.get("setup_action") ?? "";
  const code = url.searchParams.get("code") ?? "";
  const operator = await requireOperatorApi();

  if (operator instanceof Response) {
    return new NextResponse(
      `<!doctype html><meta charset="utf-8"><title>GitHub connection</title>` +
      `<style>body{font:14px/1.5 system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem}` +
      `a{color:#2563eb}</style>` +
      `<h1>Sign in to complete the GitHub connection</h1>` +
      `<p>Return to Settings after signing in and choose Connect GitHub again.</p>` +
      `<p><a href="/login">Go to sign in</a></p>`,
      { headers: { "content-type": "text/html; charset=utf-8" } },
    );
  }

  // Back from changing which repositories the App reaches (Stage 12 G1): GitHub
  // sends the installation and no code, and nothing needs exchanging — the
  // settings page asks the broker to read the repositories again.
  if (!code && setupAction === "update" && /^[0-9]+$/.test(installationId)) {
    return settingsRedirect("updated");
  }

  if (!state || (installationId && !/^[0-9]+$/.test(installationId))) {
    return settingsRedirect("error");
  }

  const clientId = (await getGitHubAppConfig())?.clientId ?? "";
  if (!code || !clientId) {
    return new NextResponse(
      `<!doctype html><meta charset="utf-8"><title>GitHub connection</title>` +
      `<style>body{font:14px/1.5 system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem}</style>` +
      `<h1>GitHub App OAuth is required</h1>` +
      `<p>The GitHub App must be configured to request user authorization during installation. ` +
      `Re-enable that option in the GitHub App settings and reconnect.</p>`,
      { headers: { "content-type": "text/html; charset=utf-8" } },
    );
  }

  // The login session + oauth code are recorded atomically so a failure of
  // the second step does not silently consume the one-time state.
  try {
    const digest = stateDigest(state);
    const encryptedCode = encryptGitHubOAuthCode(code);
    await executeJson(
      `SELECT jsonb_build_object(
         'code_id',consume_session_and_record_github_oauth(:'operator_id'::uuid,:'state_digest',:'installation_id',:'setup_action',
           :'code_ciphertext',:'code_iv',:'code_tag',:'client_id')
       )::text;`,
      { operator_id: operator.userId, state_digest: digest, installation_id: installationId,
        setup_action: setupAction, code_ciphertext: encryptedCode.ciphertext,
        code_iv: encryptedCode.iv, code_tag: encryptedCode.tag, client_id: clientId },
    );
  } catch (error) {
    // Not a bare catch. This swallowed the reason once already: the callback
    // failed because `consume_session_and_record_github_oauth` was not granted
    // to `infra_web`, and all anyone could see was `?github=error` — no audit
    // row, no log line, nothing to act on. Finding it took reading the function
    // grants by hand on the host.
    //
    // The message only: the parameters carry the encrypted authorization code,
    // and a stack trace would carry the query that bound it. What reaches the
    // journal is what PostgreSQL said and what the operator is, which is enough
    // to name a missing grant and not enough to be a leak.
    process.stderr.write(`${JSON.stringify({
      type: "github.callback_failed",
      operator_id: operator.userId,
      reason: (error instanceof Error ? error.message : String(error)).slice(0, 300),
    })}\n`);
    return settingsRedirect("error");
  }
  return settingsRedirect("connecting");
}
