import { ProjectStart } from "@/components/project-start";
import { ChatView, type CentreViewName } from "@/components/chat-view";
import { getProjectWorkspace, getProjectReadiness, getProjectTeam, getRuntimeReadiness , getIssueIntake } from "@/lib/product-data";
import { getOperatorModels } from "@/lib/model-checks";
import { getOperatorUsageLimits } from "@/lib/usage-data";
import { getSidebarProjects } from "@/lib/sidebar-data";
import { requireOperator } from "@/lib/auth";
import { notFound } from "next/navigation";

export const dynamic = "force-dynamic";

export async function generateMetadata({ searchParams }: { searchParams: Promise<{ task?: string; new?: string }> }) {
  const query = await searchParams;
  return { title: query.task && query.new !== "1" ? "Chat · infra-cod" : "New chat · infra-cod" };
}

const views = new Set<CentreViewName>(["changes", "log", "checks"]);

export default async function ProjectChatPage({ params, searchParams }: { params: Promise<{ projectId: string }>; searchParams: Promise<{ task?: string; new?: string; view?: string }> }) {
  const [{ projectId }, query] = await Promise.all([params, searchParams]);
  const operator = await requireOperator();
  const [workspace, runtimeReadiness] = await Promise.all([getProjectWorkspace(operator.userId,projectId, query.task), getRuntimeReadiness()]);
  if (!workspace) notFound();
  // After the workspace: project_readiness checks the owner itself and refuses
  // a project that is not theirs, which the workspace read has just answered
  // with a 404 rather than an error.
  const projectReadiness = await getProjectReadiness(projectId, operator.userId);
  // A chat is addressed through its latest task (?task=…), the address every
  // event and notification uses. Without one, the project's start screen.
  const activeTask = query.task && query.new !== "1" ? workspace.activeTask : null;
  const [projectTeam, operatorModels] = await Promise.all([getProjectTeam(projectId, operator.userId), getOperatorModels(operator.userId)]);
  if (activeTask) {
    // The limits strip: the operator's connections.
    const operatorUsage = await getOperatorUsageLimits(operator.userId);
    const view = views.has(query.view as CentreViewName) ? query.view as CentreViewName : undefined;
    return <ChatView operator={operator} workspace={workspace} activeTask={activeTask} writeEnabled view={view}
      runtimeReadiness={runtimeReadiness} projectReadiness={projectReadiness} projectTeam={projectTeam}
      operatorModels={operatorModels} operatorUsage={operatorUsage}/>;
  }
  const [sidebar, operatorUsage, issueIntake] = await Promise.all([getSidebarProjects(operator.userId), getOperatorUsageLimits(operator.userId), getIssueIntake(projectId, operator.userId)]);
  const waiting = sidebar.find((project) => project.id === projectId)?.chats.filter((chat) => chat.needsOperator) ?? [];
  return <ProjectStart operator={operator} workspace={workspace} writeEnabled runtimeReadiness={runtimeReadiness}
    projectReadiness={projectReadiness} projectTeam={projectTeam} operatorModels={operatorModels} waiting={waiting} operatorUsage={operatorUsage} waitingIssues={issueIntake?.enabled ? issueIntake.waiting : []}/>;
}
