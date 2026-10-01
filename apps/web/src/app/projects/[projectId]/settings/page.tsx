import { redirect } from "next/navigation";
import { requireOperator } from "@/lib/auth";

// Project settings open on their first page (Stage 12 N6).
export default async function ProjectSettingsIndex({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  await requireOperator();
  redirect(`/projects/${projectId}/settings/general`);
}
