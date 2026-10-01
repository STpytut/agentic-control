import Link from "next/link";
import { redirect } from "next/navigation";
import { ControlPlaneShell } from "@/components/control-plane-shell";
import { getProjects } from "@/lib/product-data";
import { requireOperator } from "@/lib/auth";

export const dynamic = "force-dynamic";

// There are no project tiles any more (Stage 12): the projects are in the
// sidebar, their list with deletion in Settings → Projects. /projects opens the
// start screen of the project worked in last; with none, the way to create one.
export default async function ProjectsPage() {
  const operator = await requireOperator();
  const projects = await getProjects(operator.userId);
  if (projects[0]) redirect(`/projects/${projects[0].id}`);
  return <ControlPlaneShell operator={operator}>
    <header className="cp-topbar"><div className="cp-breadcrumbs"><strong>Welcome</strong></div></header>
    <div className="flex justify-center px-8 pt-20 pb-14 text-ink phone:px-3.5 phone:pt-10">
      <div className="grid max-w-[560px] justify-items-start gap-4">
        <h1 className="type-page-title m-0 text-[2.5rem] leading-tight phone:text-[1.875rem]">Start with a project</h1>
        <p className="type-app-body m-0 text-muted">A project is a repository the team works in: an orchestrator plans each chat, executors write on a task branch, and you approve. Connect GitHub and a model provider first if you have not — both are in Settings → Connections.</p>
        <div className="flex flex-wrap gap-2">
          <Link href="/projects/new" className="touch-target inline-flex h-10 items-center rounded-md bg-ink px-4 text-[0.9375rem] font-medium text-on-ink transition-colors duration-150 hover:bg-accent hover:text-on-accent">＋ New project</Link>
          <Link href="/settings/connections" className="touch-target inline-flex h-10 items-center rounded-md border border-line-strong px-4 text-[0.9375rem] font-medium text-ink transition-colors duration-150 hover:border-ink hover:bg-ink hover:text-on-ink">Connections</Link>
        </div>
      </div>
    </div>
  </ControlPlaneShell>;
}
