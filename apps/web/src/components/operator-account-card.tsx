import type { Operator } from "@/lib/auth";
import { formatTimestamp } from "@/lib/format-timestamp";
import { Button, ButtonLink, Card, TextInput, cx } from "@agentic/design-system";
import { Notice } from "@/components/ui/notice";

const block = "grid content-start gap-2.5";
const textButton = "touch-target type-meta inline-flex min-h-8 items-center px-1 font-medium underline-offset-4 transition-colors duration-150 hover:underline";

export type OperatorSessionRow = {
  session_id: string;
  created_at: string;
  last_seen_at: string;
  expires_at: string;
  absolute_expires_at: string;
  is_current: boolean;
};

const NOTICES: Record<string, { text: string; kind: "ok" | "bad" }> = {
  "username-changed": { text: "Username changed. Sign in again with the new one.", kind: "ok" },
  "username-invalid": { text: "A username must be 3-32 characters: lowercase letters, digits, dot, dash or underscore.", kind: "bad" },
  "username-taken": { text: "That username is already in use.", kind: "bad" },
  "session-revoked": { text: "The session was revoked.", kind: "ok" },
  "session-missing": { text: "That session was already gone.", kind: "bad" },
  "sessions-revoked": { text: "Every other session was revoked.", kind: "ok" },
  "csrf": { text: "The form expired. Reload the page and try again.", kind: "bad" },
};

// Server-rendered on purpose. Every control here is a plain form POST carrying a
// hidden CSRF token, so no account mutation depends on client JavaScript being
// loaded and none of them can be replayed cross-site.
export function OperatorAccountCard({
  operator,
  csrfToken,
  sessions,
  notice,
}: {
  operator: Operator;
  csrfToken: string;
  sessions: OperatorSessionRow[];
  notice?: string;
}) {
  const message = notice ? NOTICES[notice] : undefined;
  const others = sessions.filter((session) => !session.is_current).length;

  return (
    <Card as="section" className="grid gap-5">
      <header>
        <p className="type-eyebrow text-muted">SIGN-IN</p>
        <h2 className="type-section-title mt-1.5">Operator account</h2>
        <p className="type-app-body mt-1.5 text-muted">This installation has one local owner account. Its password and username live in the local database.</p>
      </header>

      {message && (
        <Notice tone={message.kind === "ok" ? "success" : "danger"} role="status">{message.text}</Notice>
      )}

      <div className="grid grid-cols-[repeat(auto-fit,minmax(260px,1fr))] gap-x-8 gap-y-5 border-t border-line pt-5">
        <div className={block}>
          <h3 className="type-card-title">Username</h3>
          <p className="type-meta m-0">Signed in as <strong className="font-medium">{operator.username || "owner"}</strong></p>
          <form method="post" action="/auth/change-username" className="grid gap-2.5">
            <input type="hidden" name="csrf_token" value={csrfToken}/>
            <label className="grid gap-1.5"><span className="type-meta font-medium">New username</span>
              <TextInput type="text" name="username" required minLength={3} maxLength={32} autoCapitalize="none" spellCheck={false} placeholder="admin-k7m2xq"/>
            </label>
            <p className="type-meta m-0 text-muted">Changing the username ends every session, including this one. You will be asked to sign in again.</p>
            <Button size="sm" className="justify-self-start" type="submit">Change username</Button>
          </form>
        </div>

        <div className={block}>
          <h3 className="type-card-title">Password</h3>
          <p className="type-meta m-0">Argon2id, verified against the local database.</p>
          <p className="type-meta m-0 text-muted">Changing the password revokes every other session and rotates this one.</p>
          <ButtonLink size="sm" className="justify-self-start" href="/change-password">Change password</ButtonLink>
        </div>
      </div>

      <div className={cx(block, "border-t border-line pt-5")}>
        <h3 className="type-card-title">Active sessions</h3>
        <p className="type-meta m-0 text-muted">
          {sessions.length === 1 ? "This is the only active session." : `${sessions.length} active sessions.`}
        </p>
        <ul className="m-0 grid list-none divide-y divide-line border-y border-line p-0">
          {sessions.map((session) => (
            <li key={session.session_id} className={cx("flex items-center justify-between gap-3 py-3", session.is_current && "-mx-2 rounded-md bg-wash px-2")}>
              <div className="type-meta grid gap-0.5">
                <strong className="font-medium">{session.is_current ? "This session" : "Session"}</strong>
                <span className="text-muted tabular-nums">Started {formatTimestamp(session.created_at)}</span>
                <span className="text-muted tabular-nums">Last seen {formatTimestamp(session.last_seen_at)}</span>
                <span className="text-muted tabular-nums">Expires {formatTimestamp(session.expires_at)}</span>
              </div>
              <form method="post" action={session.is_current ? "/auth/logout" : "/auth/revoke-session"}>
                <input type="hidden" name="csrf_token" value={csrfToken}/>
                <input type="hidden" name="session_id" value={session.session_id}/>
                <button type="submit" className={textButton}>
                  {session.is_current ? "Sign out" : "Revoke"}
                </button>
              </form>
            </li>
          ))}
        </ul>
        {others > 0 && (
          <form method="post" action="/auth/revoke-other-sessions">
            <input type="hidden" name="csrf_token" value={csrfToken}/>
            <Button size="sm" type="submit">Revoke all other sessions</Button>
          </form>
        )}
      </div>

      <form method="post" action="/auth/logout" className="border-t border-line pt-4">
        <input type="hidden" name="csrf_token" value={csrfToken}/>
        <button type="submit" className={textButton}>Sign out</button>
      </form>
    </Card>
  );
}
