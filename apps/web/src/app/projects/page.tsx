import Link from "next/link";
import { redirect } from "next/navigation";
import { ControlPlaneShell } from "@/components/control-plane-shell";
import { getProjects, getRuntimeCatalog } from "@/lib/product-data";
import { getOperatorCodexConnection } from "@/lib/codex-connections";
import { getOperatorClaudeState } from "@/lib/claude-connections";
import { getOperatorGitHubConnections } from "@/lib/github-connections";
import { requireOperator } from "@/lib/auth";
import { SetupRefresh } from "@/components/setup-refresh";

export const dynamic = "force-dynamic";

// There are no project tiles any more (Stage 12): the projects are in the
// sidebar, their list with deletion in Settings → Projects. /projects opens the
// start screen of the project worked in last; with none, the first-run steps.
//
// The steps (rc.123): the first install on a clean server reached this page
// and then had to find each connection in Settings by itself. Each step says
// whether it is done, from the same state the settings pages read, and links
// to where it is done.
type Step = { title: string; body: string; done: boolean; href: string; action: string };

export default async function ProjectsPage() {
  const operator = await requireOperator();
  const projects = await getProjects(operator.userId);
  if (projects[0]) redirect(`/projects/${projects[0].id}`);

  const [codex, claude, github, catalog] = await Promise.all([
    getOperatorCodexConnection(operator.userId).catch(() => null),
    getOperatorClaudeState(operator.userId).catch(() => null),
    getOperatorGitHubConnections(operator.userId).catch(() => []),
    getRuntimeCatalog(operator.userId).catch(() => []),
  ]);
  const codexConnected = codex?.status === "connected";
  const claudeConnected = claude?.connection?.status === "connected";
  const githubConnected = github.some((connection) => connection.status === "connected");
  const orchestrators = catalog.filter((choice) => choice.canOrchestrate).length;
  const executors = catalog.filter((choice) => choice.canExecute).length;
  const agentsDone = codexConnected || claudeConnected;

  const steps: Step[] = [
    {
      title: "Sign in your agents",
      body: [
        codexConnected ? "Codex is connected." : "Codex: sign in with ChatGPT. Allow it in ChatGPT first: Settings → Security → device code authorization for Codex.",
        claudeConnected ? "Claude Code is connected." : "Claude Code: Sign in with Claude and paste the code it shows.",
      ].join(" "),
      done: codexConnected && claudeConnected,
      href: "/settings/connections",
      action: "Connections",
    },
    {
      title: "Connect GitHub",
      body: githubConnected
        ? "The GitHub App is installed."
        : "Create the GitHub App in Connections and choose the repositories it may use. The team works on a branch and opens a pull request.",
      done: githubConnected,
      href: "/settings/connections",
      action: "Connections",
    },
    {
      title: "Let the models be checked",
      body: orchestrators > 0 && executors > 0
        ? `${orchestrators} model${orchestrators === 1 ? "" : "s"} can plan and review, ${executors} can write code.`
        : agentsDone
          ? "Each model is checked once with one short turn. It takes a minute or two after an agent signs in."
          : "Starts by itself once an agent is signed in.",
      done: orchestrators > 0 && executors > 0,
      href: "/settings/models",
      action: "Models",
    },
  ];
  const ready = steps.every((step) => step.done);
  const waiting = agentsDone && !(orchestrators > 0 && executors > 0);

  return <ControlPlaneShell operator={operator}>
    <header className="cp-topbar"><div className="cp-breadcrumbs"><strong>Welcome</strong></div></header>
    {waiting && <SetupRefresh/>}
    <div className="flex justify-center px-8 pt-16 pb-14 text-ink phone:px-3.5 phone:pt-8">
      <div className="grid w-full max-w-[620px] gap-6">
        <div className="grid gap-3">
          <h1 className="type-page-title m-0 text-[2.5rem] leading-tight phone:text-[1.875rem]">Get the team ready</h1>
          <p className="type-app-body m-0 text-muted">Three steps, then your first project: an orchestrator plans each chat, an executor writes on a task branch, and you approve.</p>
        </div>
        <ol className="m-0 grid list-none gap-3 p-0">
          {steps.map((step, index) => (
            <li key={step.title} className="flex items-start gap-4 rounded-lg border border-line p-5">
              <span aria-hidden="true" className={`mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[0.875rem] font-medium ${step.done ? "bg-ink text-on-ink" : "border border-line-strong text-muted"}`}>
                {step.done ? "✓" : index + 1}
              </span>
              <div className="grid min-w-0 flex-1 gap-1.5">
                <h2 className="type-card-title m-0">{step.title}<span className="sr-only">{step.done ? " (done)" : " (to do)"}</span></h2>
                <p className="type-app-body m-0 text-muted">{step.body}</p>
              </div>
              {!step.done && (
                <Link href={step.href} className="touch-target inline-flex h-9 shrink-0 items-center rounded-md border border-line-strong px-3.5 text-[0.875rem] font-medium text-ink transition-colors duration-150 hover:border-ink hover:bg-ink hover:text-on-ink">{step.action}</Link>
              )}
            </li>
          ))}
        </ol>
        <div className="flex flex-wrap items-center gap-3">
          <Link href="/projects/new" className={`touch-target inline-flex h-10 items-center rounded-md px-4 text-[0.9375rem] font-medium transition-colors duration-150 ${ready ? "bg-ink text-on-ink hover:bg-accent hover:text-on-accent" : "border border-line-strong text-ink hover:border-ink"}`}>＋ Create the first project</Link>
          {!ready && <span className="type-meta text-muted">You can create it now; the team needs the steps above before it can start.</span>}
        </div>
      </div>
    </div>
  </ControlPlaneShell>;
}
