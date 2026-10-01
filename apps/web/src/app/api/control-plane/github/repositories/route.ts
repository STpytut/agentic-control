import { requireOperatorApi } from "@/lib/auth";
import { getOperatorGitHubConnections, listOperatorGitHubRepositories } from "@/lib/github-connections";
import { isGitHubVerifying } from "@/lib/github-connections-shared";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const operator = await requireOperatorApi();
  if (operator instanceof Response) return operator;
  const url = new URL(request.url);
  const search = (url.searchParams.get("search") ?? "").slice(0, 80);
  const connectionId = (url.searchParams.get("connectionId") ?? "").slice(0, 64);
  try {
    const [repositories, connections] = await Promise.all([
      listOperatorGitHubRepositories(operator.userId, connectionId || null, search),
      getOperatorGitHubConnections(operator.userId),
    ]);
    // While a verify runs the connection is not `connected`, so the list comes
    // back empty: the form keeps what it had and waits for the check to end.
    const connection = connections.find((item) => item.connectionId === connectionId) ?? connections[0];
    return NextResponse.json({
      ok: true,
      repositories,
      verifying: isGitHubVerifying(connection),
      lastVerifiedAt: connection?.lastVerifiedAt ?? "",
    });
  } catch {
    return NextResponse.json({ ok: true, repositories: [], verifying: false, lastVerifiedAt: "" });
  }
}
