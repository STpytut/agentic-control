import { redirect } from "next/navigation";
import { Button, Card, Field, Logo, TextInput } from "@agentic/design-system";
import { loginCsrfTokenForRender, getOperator } from "@/lib/auth";
import { Notice } from "@/components/ui/notice";

export const dynamic = "force-dynamic";

// One message for a wrong password, an unknown username and a locked-out
// account alike. The status of an account is not something an unauthenticated
// page is allowed to report, and a lockout is not an exception: it is keyed by
// the submitted username whether or not that username exists, so a distinct
// message would hand back a probe. The route therefore maps every credential
// refusal onto `invalid`, and `locked` is deliberately not a key here.
const ERRORS: Record<string, string> = {
  invalid: "Invalid username or password",
  csrf: "Your sign-in page expired. Please try again.",
  unavailable: "Sign-in is temporarily unavailable. Please try again.",
  password: "Your password was changed. Sign in with the new password.",
  renamed: "Your username was changed. Sign in with the new one.",
};

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const operator = await getOperator();
  if (operator) redirect(operator.mustChangePassword ? "/change-password" : "/projects");

  const { error } = await searchParams;
  // Read-or-mint, and never throw: this render must produce a page even when the
  // cookie cannot be set, or the sign-in page answers 500 instead of a form.
  const csrfToken = await loginCsrfTokenForRender();

  return <main className="grid min-h-screen place-items-center bg-canvas p-6 text-ink phone:p-4">
    <Card as="section" className="w-full max-w-[400px]">
      <div className="grid gap-7 p-2 sm:p-4">
        <Logo product="control"/>
        <div><p className="type-eyebrow text-muted">INFRA-COD</p><h1 className="type-section-title mt-2 mb-0 text-ink">Sign in</h1><p className="type-app-body mt-2 text-muted">Enter the operator username and password created during installation.</p></div>
        <form method="post" action="/auth/login" className="grid gap-4">
          <input type="hidden" name="csrf_token" value={csrfToken}/>
          <Field label="Username" htmlFor="login-username"><TextInput id="login-username" type="text" name="username" autoComplete="username" required minLength={3} maxLength={32} autoCapitalize="none" spellCheck={false}/></Field>
          <Field label="Password" htmlFor="login-password"><TextInput id="login-password" type="password" name="password" autoComplete="current-password" required minLength={1}/></Field>
          {error && ERRORS[error] && <Notice tone="danger" role="alert">{ERRORS[error]}</Notice>}
          <Button type="submit" className="mt-1 w-full">Sign in</Button>
        </form>
      </div>
    </Card>
  </main>;
}
