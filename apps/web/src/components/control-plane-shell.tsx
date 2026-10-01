import type { Operator } from "@/lib/auth";
import { getSidebarProjects } from "@/lib/sidebar-data";
import { AppSidebar } from "@/components/app-sidebar";
import { NavigationProgress } from "@/components/navigation-progress";
import { LivePulse } from "@/components/live-pulse";
import { Suspense } from "react";

// Every signed-in page: the projects-and-chats sidebar (Stage 12 N1) and the
// page beside it. The sidebar reads its own data, so a page names only where
// it is: the project, the chat (by its conversation) or the settings.
export async function ControlPlaneShell({ operator, projectId, activeConversationId, settingsActive = false, nav, children }: {
  operator: Operator;
  /** A navigation of its own in the sidebar's place: Settings' menu (N7). */
  nav?: React.ReactNode;
  projectId?: string;
  activeConversationId?: string;
  settingsActive?: boolean;
  children: React.ReactNode;
}) {
  if (nav) return (
    <main className="min-h-screen bg-canvas">
      <Suspense><NavigationProgress/></Suspense>
      <LivePulse/>
      {nav}
      <section className="ml-[280px] min-h-screen phone:ml-0">{children}</section>
    </main>
  );
  const projects = await getSidebarProjects(operator.userId);
  // New chat opens the start screen of the project in view, else of the one
  // worked in last; with no project at all, the way to create one.
  const newChatProject = projectId ?? projects[0]?.id;
  const newChatHref = newChatProject ? `/projects/${newChatProject}` : "/projects/new";
  return (
    <main className="min-h-screen bg-canvas">
      <Suspense><NavigationProgress/></Suspense>
      <LivePulse/>
      <AppSidebar projects={projects} currentProjectId={projectId} activeConversationId={activeConversationId}
        operatorName={operator.displayName} settingsActive={settingsActive} newChatHref={newChatHref}/>
      <section className="ml-[280px] min-h-screen phone:ml-0">{children}</section>
    </main>
  );
}
