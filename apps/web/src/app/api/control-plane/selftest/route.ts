import { runSelftest, selftestAuthorized } from "@/lib/selftest";

export const dynamic = "force-dynamic";

// The post-update self-test (lib/selftest.ts). Caddy does not serve this path
// (deploy/caddy/Caddyfile), so only the host reaches it, and only with the
// one-time token. Not X-Forwarded-For: Next's own server sets it on every
// request, a direct one from the host included, which refused rc.128's
// update its own self-test.
export async function POST(request: Request) {
  if (!selftestAuthorized(request.headers.get("x-infra-cod-selftest"))) {
    return Response.json({ ok: false, error: "not found" }, { status: 404 });
  }
  const result = await runSelftest();
  return Response.json(result, { status: result.ok ? 200 : 500, headers: { "Cache-Control": "no-store" } });
}
