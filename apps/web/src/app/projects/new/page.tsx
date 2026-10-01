import { ControlPlaneShell } from "@/components/control-plane-shell";
import { ProjectCreateForm } from "@/components/project-create-form";
import { getRuntimeCatalog } from "@/lib/product-data";
import { getOperatorGitHubConnections } from "@/lib/github-connections";
import { requireOperator } from "@/lib/auth";

export const dynamic = "force-dynamic";

export const metadata = { title: "New project · infra-cod" };

// The sidebar's New project: the create form, in the centre.
export default async function NewProjectPage() {
  const operator = await requireOperator();
  const [runtimeCatalog, githubConnections] = await Promise.all([getRuntimeCatalog(operator.userId), getOperatorGitHubConnections(operator.userId)]);
  return <ControlPlaneShell operator={operator}>
    <header className="cp-topbar"><div className="cp-breadcrumbs"><strong>New project</strong></div></header>
    <div className="flex justify-center px-8 pt-10 pb-14 text-ink phone:px-3.5 phone:pt-5 phone:pb-10">
      <ProjectCreateForm enabled runtimeCatalog={runtimeCatalog} githubConnections={githubConnections} presentation="page" closeHref="/projects"/>
    </div>
  </ControlPlaneShell>;
}
