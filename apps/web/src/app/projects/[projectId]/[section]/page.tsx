import { notFound, redirect } from "next/navigation";
import { requireOperator } from "@/lib/auth";

// The project's old section URLs (before Stage 12): each lands where its
// content lives now. Overview and Tasks: the start screen (the sidebar lists
// the chats); the rest: the matching page of project settings.
const MOVED: Record<string, string> = {
  overview: "",
  tasks: "",
  workspace: "/settings/workspace",
  sessions: "/settings/activity?show=sessions",
  events: "/settings/activity",
  team: "/settings/team",
};

export default async function ProjectSectionPage({ params }: { params: Promise<{ projectId: string; section: string }> }) {
  const { projectId, section } = await params;
  await requireOperator();
  if (!(section in MOVED)) notFound();
  redirect(`/projects/${projectId}${MOVED[section]}`);
}
