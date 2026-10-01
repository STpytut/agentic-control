import { ControlPlaneShell } from "@/components/control-plane-shell";
import { getProjectWorkspace } from "@/lib/product-data";
import { requireOperator } from "@/lib/auth";
import { chatsOf } from "@/components/ui/conversations";
import { chatStatusDot, chatStatusLabel } from "@/components/ui/chat-status";
import { formatTimestamp } from "@/lib/format-timestamp";
import { ButtonLink, PageHeader, cx } from "@agentic/design-system";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ProjectMark } from "@/components/ui/project-mark";

export const dynamic = "force-dynamic";

export const metadata = { title: "All chats · infra-cod" };

// Every chat of a project, archived ones included: where the sidebar's
// "All N chats" leads.
export default async function ProjectChatsPage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  const operator = await requireOperator();
  const workspace = await getProjectWorkspace(operator.userId, projectId);
  if (!workspace) notFound();
  const { project } = workspace;
  const chats = chatsOf(workspace.tasks);
  return <ControlPlaneShell operator={operator} projectId={project.id}>
    <header className="cp-topbar">
      <div className="cp-breadcrumbs"><Link href={`/projects/${project.id}`} className="flex items-center gap-2 font-medium"><ProjectMark id={project.id} name={project.name} size={20}/>{project.name}</Link><span>›</span><strong>All chats</strong></div>
      <ButtonLink as={Link} size="sm" href={`/projects/${project.id}`}>＋ New chat</ButtonLink>
    </header>
    <div className="mx-auto w-full max-w-[960px] px-8 pt-10 pb-14 text-ink phone:px-3.5 phone:pt-7 phone:pb-10">
      <PageHeader eyebrow={project.name} title="All chats" description="Every chat of this project, newest first. An archived chat stays readable." action={<span className="type-meta text-muted">{chats.length}</span>} className="mb-7"/>
      <ul className="overflow-hidden rounded-lg border border-line">
        {chats.map((chat) => <li key={chat.conversationId} className="border-b border-line last:border-b-0">
          <Link href={`/projects/${project.id}?task=${chat.latest.id}`} className="flex min-h-14 min-w-0 items-center gap-3 px-4 py-2.5 transition-colors duration-150 hover:bg-wash">
            <span className={cx("h-2 w-2 shrink-0 rounded-full", chatStatusDot(chat.latest.status))} aria-hidden="true"/>
            <span className="flex min-w-0 flex-1 flex-col"><strong className="type-meta truncate font-medium text-ink">{chat.title}</strong><small className="type-meta truncate text-muted">{chatStatusLabel(chat.latest.status)}</small></span>
            <time className="type-meta shrink-0 text-muted tabular-nums">{formatTimestamp(chat.updatedAt)}</time>
          </Link>
        </li>)}
        {!chats.length && <li className="type-meta px-4 py-9 text-center text-muted">No chats yet. <Link href={`/projects/${project.id}`} className="font-medium text-ink underline underline-offset-4">Start the first one</Link>.</li>}
      </ul>
    </div>
  </ControlPlaneShell>;
}
