import { PASSWORD_MIN_LENGTH } from "../../../../../services/control-plane/password.mjs";
import { Button, Card, Field, Logo, TextInput } from "@agentic/design-system";
import { readSessionCsrfToken, requireOperator } from "@/lib/auth";
import { Notice } from "@/components/ui/notice";

export const dynamic = "force-dynamic";

const ERRORS: Record<string, string> = {
  current: "The current password is not correct",
  policy: `The new password must be at least ${PASSWORD_MIN_LENGTH} characters`,
  mismatch: "The two new passwords do not match",
  same: "The new password must be different from the current one",
  csrf: "Your session page expired. Please sign in again.",
  unavailable: "The password could not be changed. Please try again.",
};

// The one page a first-login operator can reach: bootstrap sets
// must_change_password, so without this screen the panel is unreachable.
export default async function ChangePasswordPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const operator = await requireOperator({ allowPasswordChange: true });
  const { error } = await searchParams;
  const csrfToken = await readSessionCsrfToken();

  return <main className="grid min-h-screen place-items-center bg-canvas p-6 text-ink phone:p-4">
    <Card as="section" className="w-full max-w-[400px]">
      <div className="grid gap-7 p-2 sm:p-4">
        <Logo product="control"/>
        <div>
          <p className="type-eyebrow text-muted">INFRA-COD</p>
          <h1 className="type-section-title mt-2 mb-0 text-ink">Choose a new password</h1>
          <p className="type-app-body mt-2 text-muted">
            {operator.mustChangePassword
              ? "This account was created with a generated password. Replace it before continuing."
              : `Signed in as ${operator.username}.`}
          </p>
        </div>
        <form method="post" action="/auth/change-password" className="grid gap-4">
          <input type="hidden" name="csrf_token" value={csrfToken}/>
          <Field label="Current password" htmlFor="change-current-password"><TextInput id="change-current-password" type="password" name="current_password" autoComplete="current-password" required/></Field>
          <Field label="New password" htmlFor="change-new-password"><TextInput id="change-new-password" type="password" name="new_password" autoComplete="new-password" required minLength={PASSWORD_MIN_LENGTH} maxLength={256}/></Field>
          <Field label="Repeat new password" htmlFor="change-confirm-password"><TextInput id="change-confirm-password" type="password" name="confirm_password" autoComplete="new-password" required minLength={PASSWORD_MIN_LENGTH} maxLength={256}/></Field>
          {error && ERRORS[error] && <Notice tone="danger" role="alert">{ERRORS[error]}</Notice>}
          <Button type="submit" className="mt-1 w-full">Change password</Button>
        </form>
        <form method="post" action="/auth/logout" className="-mt-3 flex justify-center">
          <input type="hidden" name="csrf_token" value={csrfToken}/>
          <button type="submit" className="touch-target inline-flex h-8 items-center px-2 type-meta text-muted underline-offset-4 transition-colors duration-150 hover:text-ink hover:underline">Sign out</button>
        </form>
      </div>
    </Card>
  </main>;
}
