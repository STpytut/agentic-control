import { redirect } from "next/navigation";
import { requireOperator } from "@/lib/auth";

// Settings are pages now (Stage 12 N7); /settings opens Account. A notice the
// account and GitHub routes send back here (?account=…, ?github=…) goes on to
// the page it is about.
export default async function SettingsIndex({ searchParams }: { searchParams: Promise<{ github?: string; account?: string }> }) {
  const [{ github, account }] = await Promise.all([searchParams, requireOperator()]);
  if (github) redirect(`/settings/connections?github=${encodeURIComponent(github)}`);
  redirect(account ? `/settings/account?account=${encodeURIComponent(account)}` : "/settings/account");
}
