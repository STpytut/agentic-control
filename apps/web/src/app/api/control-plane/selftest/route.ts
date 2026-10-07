import { runSelftest, selftestAuthorized } from "@/lib/selftest";

export const dynamic = "force-dynamic";

// The post-update self-test (lib/selftest.ts). From the host only: a request
// that came through Caddy carries X-Forwarded-For and is refused before the
// token is even read.
export async function POST(request: Request) {
  if (request.headers.get("x-forwarded-for") || request.headers.get("x-forwarded-host")) {
    return Response.json({ ok: false, error: "not found" }, { status: 404 });
  }
  if (!selftestAuthorized(request.headers.get("x-infra-cod-selftest"))) {
    return Response.json({ ok: false, error: "not found" }, { status: 404 });
  }
  const result = await runSelftest();
  return Response.json(result, { status: result.ok ? 200 : 500, headers: { "Cache-Control": "no-store" } });
}
