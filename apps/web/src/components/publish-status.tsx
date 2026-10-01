import type { PublishState } from "@/lib/product-data";
import { Spinner } from "@/components/ui/spinner";

// Where an approved task's publish stands, in the chat under its steps (battle
// test, chat 2: after Approve nothing happened on screen for a minute, and it
// looked broken). "Ready to publish" and "Publish stopped" ask for a click and
// stay action cards; this card says everything between and after them. The
// page refreshes itself as the stages change (LivePulse).

export function PublishStatusCard({ state }: { state: PublishState }) {
  if (!state || state.stage === "ready" || state.stage === "failed") return null;
  const shell = "mb-6 ml-11 flex min-w-0 items-start gap-3 rounded-lg border px-4 py-3 phone:ml-0 phone:px-3";
  if (state.stage === "preparing") {
    return <section role="status" className={`${shell} border-line bg-canvas`}>
      <Spinner className="mt-1 text-info"/>
      <div className="min-w-0"><strong className="type-meta font-medium">Preparing to publish…</strong>
        <p className="type-meta mt-0.5 text-muted">The host is checking that the workspace still holds exactly the approved commit. Publish to GitHub appears here in a moment.</p></div>
    </section>;
  }
  if (state.stage === "publishing") {
    return <section role="status" className={`${shell} border-line bg-canvas`}>
      <Spinner className="mt-1 text-info"/>
      <div className="min-w-0"><strong className="type-meta font-medium">Publishing {state.sha}…</strong>
        <p className="type-meta mt-0.5 text-muted">Pushing the approved commit to {state.repository || "GitHub"} and opening a pull request. The GitHub worker picks it up within a minute.</p></div>
    </section>;
  }
  if (state.stage === "refused") {
    return <section role="alert" className={`${shell} border-danger/40 bg-danger-soft`}>
      <span aria-hidden="true" className="type-meta font-semibold text-danger">!</span>
      <div className="min-w-0"><strong className="type-meta font-medium text-danger">This approval cannot be published</strong>
        <p className="type-meta mt-0.5 text-ink/80">{state.message}</p></div>
    </section>;
  }
  if (state.stage === "unavailable") {
    return <section className={`${shell} border-line bg-canvas`}>
      <span aria-hidden="true" className="type-meta text-muted">i</span>
      <div className="min-w-0"><strong className="type-meta font-medium">Approved — not published</strong>
        <p className="type-meta mt-0.5 text-muted">This project is not connected to its repository through the GitHub App, so the work stays in the workspace. Projects created from a repository the App reaches can publish pull requests.</p></div>
    </section>;
  }
  return <section role="status" className={`${shell} border-success/40 bg-success-soft`}>
    <span aria-hidden="true" className="type-meta font-semibold text-success">✓</span>
    <div className="min-w-0"><strong className="type-meta font-medium text-success">
      {state.prUrl ? <>Published · <a className="underline underline-offset-2" href={state.prUrl} target="_blank" rel="noreferrer">pull request #{state.prNumber}</a></> : `Published · ${state.sha} is now ${state.initialisedBase || "the base branch"}`}
    </strong>
      <p className="type-meta mt-0.5 text-ink/80">{state.prUrl
        ? `Merge it on GitHub when it is right. The next message in this chat starts a follow-up step.`
        : `The repository was empty, so the approved commit became its ${state.initialisedBase || "base branch"}. The next publish opens a pull request.`}</p></div>
  </section>;
}
