import { readFileSync } from "node:fs";
import { timingSafeEqual } from "node:crypto";
import { queryJsonRows } from "@/lib/database";
import { getProjects, getProjectWorkspace, getProjectReadiness, getProjectTeam, getRuntimeReadiness, getIssueIntake } from "@/lib/product-data";
import { getOperatorModels } from "@/lib/model-checks";
import { getOperatorUsageLimits } from "@/lib/usage-data";
import { getSidebarProjects } from "@/lib/sidebar-data";
import { getTelegramConnection } from "@/lib/telegram-connection";
import { getOperatorClaudeState } from "@/lib/claude-connections";
import { getOperatorCodexState } from "@/lib/codex-connections";
import { getOperatorOpenCodeState } from "@/lib/opencode-connections";
import { getOperatorGitHubConnections } from "@/lib/github-connections";

// The panel's self-test after an update (rc.128).
//
// `infra-cod update` proved the processes and `/login`, and nothing else: on
// rc.127 every chat with a review failed with "permission denied" while the
// update reported a healthy stack. A signed-in check would need the update to
// hold an operator credential, which it deliberately does not. This runs the
// same data loaders the pages run, as infra_web, for every owner's projects and
// their latest chats, and answers only which loaders failed — never data.
//
// It is reachable only with the one-time token the update writes to a file
// only this service can read, and only from the host itself.
export const SELFTEST_TOKEN_PATH = process.env.INFRA_COD_SELFTEST_TOKEN_PATH ?? "/run/infra-cod-selftest.token";

export function selftestAuthorized(presented: string | null, path = SELFTEST_TOKEN_PATH) {
  if (!presented) return false;
  let expected: string;
  try {
    expected = readFileSync(path, "utf8").trim();
  } catch {
    return false;
  }
  if (expected.length < 32 || presented.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(presented), Buffer.from(expected));
}

type Failure = { loader: string; error: string };

async function check(failures: Failure[], loader: string, work: () => Promise<unknown>) {
  try {
    await work();
  } catch (error) {
    // The database's own sentence ("permission denied for table …") says what
    // broke; no row is in it.
    failures.push({ loader, error: (error instanceof Error ? error.message : String(error)).slice(0, 300) });
  }
}

export async function runSelftest() {
  const failures: Failure[] = [];
  let checked = 0;
  const owners = await queryJsonRows(`SELECT jsonb_build_object('id',owner_id)::text FROM (SELECT DISTINCT owner_id FROM projects) o;`, {});
  await check(failures, "getRuntimeReadiness", () => getRuntimeReadiness());
  for (const owner of owners) {
    const ownerId = String(owner.id);
    for (const [loader, work] of [
      ["getProjects", () => getProjects(ownerId)],
      ["getSidebarProjects", () => getSidebarProjects(ownerId)],
      ["getOperatorModels", () => getOperatorModels(ownerId)],
      ["getOperatorUsageLimits", () => getOperatorUsageLimits(ownerId)],
      ["getTelegramConnection", () => getTelegramConnection(ownerId)],
      ["getOperatorClaudeState", () => getOperatorClaudeState(ownerId)],
      ["getOperatorCodexState", () => getOperatorCodexState(ownerId)],
      ["getOperatorOpenCodeState", () => getOperatorOpenCodeState(ownerId)],
      ["getOperatorGitHubConnections", () => getOperatorGitHubConnections(ownerId)],
    ] as const) {
      checked += 1;
      await check(failures, loader, work);
    }
    // Each project's start screen, its newest chat, and its newest chat that
    // has a review: the three shapes the chat page takes.
    const chats = await queryJsonRows(`SELECT jsonb_build_object('project',p.id,
        'latest',(SELECT t.id FROM tasks t WHERE t.project_id=p.id ORDER BY t.created_at DESC LIMIT 1),
        'reviewed',(SELECT e.task_id FROM review_evidence e WHERE e.project_id=p.id ORDER BY e.recorded_at DESC LIMIT 1))::text
      FROM projects p WHERE p.owner_id=:'owner_id'::uuid AND p.status NOT IN ('archived','deleting','deletion_failed','deleted');`,
      { owner_id: ownerId });
    for (const chat of chats) {
      const projectId = String(chat.project);
      for (const taskId of [undefined, chat.latest, chat.reviewed]) {
        if (taskId === null) continue;
        checked += 1;
        await check(failures, `getProjectWorkspace(${taskId ? "chat" : "start"})`,
          () => getProjectWorkspace(ownerId, projectId, taskId ? String(taskId) : undefined));
      }
      for (const [loader, work] of [
        ["getProjectReadiness", () => getProjectReadiness(projectId, ownerId)],
        ["getProjectTeam", () => getProjectTeam(projectId, ownerId)],
        ["getIssueIntake", () => getIssueIntake(projectId, ownerId)],
      ] as const) {
        checked += 1;
        await check(failures, loader, work);
      }
    }
  }
  return { ok: failures.length === 0, checked, failures };
}
