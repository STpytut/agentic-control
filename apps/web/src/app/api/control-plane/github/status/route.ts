import { requireOperatorApi } from "@/lib/auth";
import { getGitHubAppConfig, getGitHubAppManifestStatus, getOperatorGitHubOAuthStatus } from "@/lib/github-connections";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET() {
  const operator = await requireOperatorApi();
  if (operator instanceof Response) return operator;
  const [status, app, manifest] = await Promise.all([
    getOperatorGitHubOAuthStatus(operator.userId), getGitHubAppConfig(), getGitHubAppManifestStatus(operator.userId),
  ]);
  return NextResponse.json({ ok: true, status, app, manifest });
}
