import type { RuntimeActivation, RuntimeNewerVersion, RuntimeQualification, RuntimeReadiness, RuntimeReadinessReport, RuntimeUpdateRequest, RuntimeVersionWatch } from "@/lib/product-data";
import { dispatchBlockers } from "@/lib/product-data";
import { runtimeLabel } from "@/lib/runtime-labels";
import { Badge, Card } from "@agentic/design-system";
import { Notice } from "@/components/ui/notice";
import { CopyCommand } from "@/components/ui/copy-command";
import { RuntimeUpdateButton } from "@/components/runtime-update-button";
import { Spinner } from "@/components/ui/spinner";

// The four readiness states, kept apart.
//
// Stage 11.1 is explicit that the UI may not collapse them: `installed`,
// `authenticated`, `capability_verified` and `ready` fail for different reasons
// and are fixed by different commands. A single green dot would tell an operator
// that everything is fine right up until the first task fails with ENOENT —
// which is exactly how the installation this stage exists to repair was accepted.
//
// `capability_verified` is `false` on every host today: the capability gate is
// 11.2/11.4 work and has not run. It is shown as pending rather than hidden,
// because a state that is missing from the page is a state nobody is waiting for.

function StateChip({ label, state }: { label: string; state: "yes" | "no" | "pending" }) {
  return <Badge dot tone={state === "yes" ? "success" : state === "no" ? "danger" : "neutral"}>{label}</Badge>;
}

// What the operator sees about versions (Stage 12 W7; docs/RUNTIMES_AND_MODELS_DESIGN.md
// §3.6, R9): per runtime, the active version and what verified it, the newer
// versions with their latest qualification (a failed check in one line each,
// and the full list behind a disclosure), the last promotion or rollback, and
// the exact command to run next. The panel reads; the CLI acts — the commands
// are shown to be copied, not run from here.

const day = (value: string | null) => (value ? new Date(value).toISOString().slice(0, 10) : "—");
const minute = (value: string | null) => (value ? `${new Date(value).toISOString().slice(0, 16).replace("T", " ")} UTC` : "later");

function versionParts(version: string) {
  return version.split(".").map((part) => Number.parseInt(part, 10) || 0);
}
export function compareVersions(a: string, b: string) {
  const left = versionParts(a); const right = versionParts(b);
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference) return difference;
  }
  return 0;
}

function duration(q: RuntimeQualification) {
  if (!q.startedAt || !q.finishedAt) return null;
  const seconds = Math.max(0, Math.round((new Date(q.finishedAt).getTime() - new Date(q.startedAt).getTime()) / 1000));
  return seconds < 90 ? `${seconds} s` : `${Math.round(seconds / 60)} min`;
}

const QUALIFICATION_WORDS: Record<string, string> = {
  passed: "qualified", failed: "failed qualification", incomplete: "qualification incomplete", refused: "refused", running: "qualifying",
};

// How the active version came to be trusted: an explicit override (R10), the
// version this release's driver was verified at (the release baseline, R15,
// which the host reports and 0105 records), or a passed qualification on this
// host. None of them is said as such: the version is then unverified.
function activeVerification(active: string, watch: RuntimeVersionWatch | undefined, activations: RuntimeActivation[],
  qualifications: RuntimeQualification[]) {
  const record = activations.find((entry) => entry.version === active);
  const passed = qualifications.find((entry) => entry.version === active && entry.result === "passed");
  const baseline = watch?.baselineVersion ?? null;
  if (record?.acceptedUnqualified) {
    return { text: `accepted without qualification${record.reason ? `: ${record.reason}` : ""}`, tone: "text-warning", since: record.at };
  }
  if (baseline === active || watch?.verifiedBy === "baseline") {
    return { text: "verified (release baseline)", tone: "text-success", since: record?.at ?? null };
  }
  const baselineNote = baseline ? `; the release baseline is ${baseline}` : "";
  if (passed || watch?.verifiedBy?.startsWith("host qualification")) {
    return { text: `verified (host qualification${passed?.finishedAt ? `, ${day(passed.finishedAt)}` : ""})${baselineNote}`, tone: "text-success", since: record?.at ?? null };
  }
  if (!baseline && !watch?.verifiedBy) return { text: "verification not reported yet", tone: "text-muted", since: record?.at ?? null };
  return { text: `not verified at this version${baselineNote}`, tone: "text-warning", since: record?.at ?? null };
}

// What a qualification's read of the candidate's model list found against the
// active one's: "adds gpt-6-sol, gpt-6-luna; drops …".
function catalogChange(q: RuntimeQualification) {
  if (!q.catalog || (!q.catalog.added.length && !q.catalog.removed.length)) return null;
  const names = (list: string[]) => (list.length <= 4 ? list.join(", ") : `${list.slice(0, 4).join(", ")} and ${list.length - 4} more`);
  return [q.catalog.added.length ? `adds ${names(q.catalog.added)}` : "", q.catalog.removed.length ? `drops ${names(q.catalog.removed)}` : ""]
    .filter(Boolean).join("; ");
}

function QualificationChecks({ q }: { q: RuntimeQualification }) {
  const failed = q.checks.filter((check) => check.result === "failed" || check.result === "inconclusive");
  // Checks that stopped for one shared reason are one line, not a column of
  // red crosses that all say the same (the first clean install: eleven).
  const reasons = new Set(failed.map((check) => `${check.failureClass ?? ""}|${check.detail ?? ""}`));
  const oneReason = failed.length > 1 && reasons.size === 1;
  return <>
    {oneReason && <p className="type-meta mt-1 text-danger [overflow-wrap:anywhere]">
      {failed.length} checks did not run{failed[0].detail ? `: ${failed[0].detail}` : ""}.</p>}
    {!oneReason && failed.length > 0 && <ul className="type-meta mt-1 grid list-none gap-0.5 p-0">
      {failed.map((check) => <li key={check.check} className="text-danger [overflow-wrap:anywhere]">
        <span aria-hidden="true">✕ </span><span className="font-medium">{check.check}</span>
        {check.failureClass ? ` · ${check.failureClass}` : ""}{check.detail ? ` — ${check.detail}` : ""}
      </li>)}
    </ul>}
    {q.summary && failed.length === 0 && q.result !== "passed" && <p className="type-meta mt-1 text-muted [overflow-wrap:anywhere]">{q.summary}</p>}
    {q.checks.length > 0 && <details className="group mt-1">
      <summary className="type-meta flex min-h-8 cursor-pointer list-none items-center gap-1.5 text-muted [&::-webkit-details-marker]:hidden">
        <span aria-hidden="true" className="inline-block transition-transform duration-150 group-open:rotate-90">▸</span>All {q.checks.length} checks
      </summary>
      <ul className="type-meta m-0 grid list-none gap-0.5 p-0 pl-4">
        {q.checks.map((check) => <li key={check.check} className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-2 [overflow-wrap:anywhere]">
          <span><span className={check.result === "passed" ? "text-success" : check.result === "skipped" ? "text-muted" : "text-danger"}>{check.result}</span>
            {" "}{check.check}{check.failureClass ? ` · ${check.failureClass}` : ""}{check.detail ? ` — ${check.detail}` : ""}</span>
          <span className="tabular-nums text-muted">{check.durationMs !== null ? `${(check.durationMs / 1000).toFixed(1)} s` : ""}</span>
        </li>)}
      </ul>
    </details>}
  </>;
}

// What a Qualify or Promote press asked for, and how the host answered (0127).
function RequestLine({ request }: { request: RuntimeUpdateRequest }) {
  const verb = request.kind === "promote" ? "Promotion" : "Qualification";
  if (request.status === "requested") return <p className="type-meta mt-1 flex items-center gap-1.5 text-info"><Spinner/>{verb} requested — the host starts it within five minutes</p>;
  if (request.status === "running") return <p className="type-meta mt-1 flex items-center gap-1.5 text-info"><Spinner/>{request.kind === "promote" ? "Promoting" : "Qualifying"} on the host…</p>;
  if (request.status === "failed") return <p className="type-meta mt-1 text-danger">{verb} from the panel failed: {request.message}</p>;
  return null;
}

function Candidate({ runtime, version, watch, q, open, last }: {
  runtime: string; version: string; watch?: RuntimeNewerVersion; q?: RuntimeQualification;
  open?: RuntimeUpdateRequest; last?: RuntimeUpdateRequest;
}) {
  const mine = open && open.version === version ? open : null;
  const finished = last && last.version === version && last.status === "failed" ? last : null;
  // A button only while nothing is asked of this runtime: one request at a time.
  const idle = !open;
  if (!q) {
    if (watch && !watch.offered) {
      return <li className="type-meta text-muted"><span className="font-medium text-ink">{version}</span> published {watch.publishedAt ? day(watch.publishedAt) : "recently"} — offered from {minute(watch.offeredFrom)}</li>;
    }
    return <li className="type-meta"><span className="font-medium">{version}</span> <span className="text-muted">available · not qualified yet — the host qualifies it on its own</span>
      {mine ? <RequestLine request={mine}/> : finished && <RequestLine request={finished}/>}
      {idle && <RuntimeUpdateButton runtime={runtime} version={version} kind="qualify" label="Qualify now"/>}</li>;
  }
  const passedCount = q.checks.filter((check) => check.result === "passed").length;
  const took = duration(q);
  const tone = q.result === "passed" ? "text-success" : q.result === "running" ? "text-info" : "text-danger";
  return <li className="type-meta">
    <p className="flex flex-wrap items-baseline gap-x-1.5">
      <span className="font-medium">{version}</span>
      <span className={tone}>{QUALIFICATION_WORDS[q.result] ?? q.result} {q.result === "running" ? `since ${minute(q.startedAt)}` : day(q.finishedAt)}</span>
      {q.result !== "running" && q.checks.length > 0 && <span className="text-muted tabular-nums">· {passedCount}/{q.checks.length} checks passed{took ? ` · ${took}` : ""}</span>}
    </p>
    {q.result !== "running" && catalogChange(q) && <p className="type-meta mt-0.5 text-info [overflow-wrap:anywhere]">
      Its model list {catalogChange(q)}</p>}
    {q.result !== "running" && <QualificationChecks q={q}/>}
    {mine ? <RequestLine request={mine}/> : finished && <RequestLine request={finished}/>}
    {idle && (q.result === "passed"
      ? <RuntimeUpdateButton runtime={runtime} version={version} kind="promote" label={`Update to ${version}`} primary/>
      : q.result !== "running" && <RuntimeUpdateButton runtime={runtime} version={version} kind="qualify" label="Qualify again"/>)}
    {q.result === "passed" && <CopyCommand className="mt-1" label="or on the server" command={`infra-cod runtime promote ${runtime} --version ${version}`}/>}
  </li>;
}

function VersionDetail({ runtime, active, watch, qualifications, activations, requests }: {
  runtime: string; active: string | null; watch?: RuntimeVersionWatch;
  qualifications: RuntimeQualification[]; activations: RuntimeActivation[]; requests: RuntimeUpdateRequest[];
}) {
  const open = requests.find((request) => request.status === "requested" || request.status === "running");
  const lastRequest = requests.find((request) => request.status === "done" || request.status === "failed");
  const verification = active ? activeVerification(active, watch, activations, qualifications) : null;
  const byVersion = new Map(qualifications.map((q) => [q.version, q]));
  const newer = new Map((watch?.newer ?? []).map((entry) => [entry.version, entry]));
  // A runtime that is not installed has no versions to choose between: it is
  // installed, at the version the release recommends, and that is all it says.
  const candidates = !active ? [] : [...new Set([...newer.keys(), ...qualifications.map((q) => q.version)])]
    .filter((version) => compareVersions(version, active) > 0)
    .sort((a, b) => compareVersions(b, a));
  const shown = candidates.slice(0, 4);
  const last = activations[0];
  return <div className="mt-2 grid gap-2">
    {active && verification && <p className="type-meta">
      <span className="font-medium">{active}</span> active{verification.since ? ` since ${day(verification.since)}` : ""}
      {" · "}<span className={verification.tone}>{verification.text}</span>
    </p>}
    {watch?.error && <p className="type-meta text-muted">Registry not read at the last check: {watch.error}</p>}
    {shown.length > 0
      ? <ul className="m-0 grid list-none gap-2 border-l border-line p-0 pl-3">
        {shown.map((version) => <Candidate key={version} runtime={runtime} version={version} watch={newer.get(version)} q={byVersion.get(version)} open={open} last={lastRequest}/>)}
        {candidates.length > shown.length && <li className="type-meta text-muted">and {candidates.length - shown.length} older newer version{candidates.length - shown.length === 1 ? "" : "s"}</li>}
      </ul>
      : !active ? <CopyCommand className="mt-1" label="Not installed. Install it on the server" command={`infra-cod runtime install ${runtime}`}/>
      : watch?.checkedAt && !watch.error ? <p className="type-meta text-muted">Up to date as of {day(watch.checkedAt)}.</p>
      : !watch?.error && <p className="type-meta text-muted">Newer versions not checked yet; the host looks within the hour.</p>}
    {last && <div className="type-meta">
      <p className="text-muted">Last change: {last.kind === "rollback" ? "rolled back" : "promoted"} {last.from} → {last.version} on {day(last.at)} by {last.actor}
        {last.acceptedUnqualified ? " without a qualification" : ""}{last.reason ? ` (${last.reason})` : ""}</p>
      {last.kind === "promote" && <CopyCommand className="mt-1" label="roll back" command={`infra-cod runtime rollback ${runtime}`}/>}
      {activations.length > 1 && <details className="group mt-1">
        <summary className="flex min-h-8 cursor-pointer list-none items-center gap-1.5 text-muted [&::-webkit-details-marker]:hidden">
          <span aria-hidden="true" className="inline-block transition-transform duration-150 group-open:rotate-90">▸</span>History ({activations.length})
        </summary>
        <ul className="m-0 grid list-none gap-0.5 p-0 pl-4 text-muted">
          {activations.map((entry, index) => <li key={`${entry.at}-${index}`}>{day(entry.at)} {entry.kind === "rollback" ? "rolled back" : "promoted"} {entry.from} → {entry.version} by {entry.actor}{entry.acceptedUnqualified ? `, without a qualification${entry.reason ? `: ${entry.reason}` : ""}` : ""}</li>)}
        </ul>
      </details>}
    </div>}
  </div>;
}

function RuntimeRow({ runtime, watch, qualifications, activations, requests }: {
  runtime: RuntimeReadiness; watch?: RuntimeVersionWatch; qualifications: RuntimeQualification[]; activations: RuntimeActivation[];
  requests: RuntimeUpdateRequest[];
}) {
  return <section className="border-t border-line pt-2.5 first-of-type:border-t-0 first-of-type:pt-0">
    <header className="type-meta flex justify-between gap-2">
      <strong className="font-medium">{runtimeLabel(runtime.runtime)}</strong>
      <small className="type-mono-small text-muted">{runtime.version ?? "no version recorded"}</small>
    </header>
    <div className="mt-2 flex flex-wrap gap-1.5">
      <StateChip label="installed" state={runtime.installed ? "yes" : "no"}/>
      <StateChip label="authenticated" state={runtime.authenticated ? "yes" : "no"}/>
      {/* Pending, not failed: nothing has asked the question yet. */}
      <StateChip label="capability verified" state={runtime.capabilityVerified ? "yes" : "pending"}/>
      <StateChip label="ready" state={runtime.ready ? "yes" : "pending"}/>
    </div>
    {runtime.installed && !runtime.selfUpdateManaged
      && <p className="type-meta mt-2 text-warning">Self-update is unmanaged: this runtime&rsquo;s version can change without an operator asking.</p>}
    <VersionDetail runtime={runtime.runtime} active={runtime.version ?? watch?.activeVersion ?? null} watch={watch}
      qualifications={qualifications} activations={activations} requests={requests}/>
  </section>;
}

// The card states what the host reported. It does not repeat the blockers: the
// warning beside the composer carries those, and the same three sentences twice
// in one column is noise, not emphasis.
export function RuntimeReadinessCard({ report, versions = [], qualifications = [], activations = [], requests = [] }: {
  report: RuntimeReadinessReport; versions?: RuntimeVersionWatch[];
  qualifications?: RuntimeQualification[]; activations?: RuntimeActivation[]; requests?: RuntimeUpdateRequest[];
}) {
  return <Card className="grid min-w-0 gap-2.5">
    <div className="flex flex-wrap items-baseline justify-between gap-x-2 gap-y-0.5">
      <p className="type-eyebrow text-muted">AGENT RUNTIMES</p>
      <small className="type-meta text-muted">{report.observedAt ? `reported ${new Date(report.observedAt).toISOString().slice(11, 16)} UTC` : "never reported"}</small>
    </div>
    {report.unreported
      ? <p className="type-meta text-warning">This host has not reported which agent runtimes can run.</p>
      : report.runtimes.map((runtime) => <RuntimeRow key={runtime.runtime} runtime={runtime}
        watch={versions.find((entry) => entry.runtime === runtime.runtime)}
        qualifications={qualifications.filter((entry) => entry.runtime === runtime.runtime)}
        activations={activations.filter((entry) => entry.runtime === runtime.runtime)}
        requests={requests.filter((entry) => entry.runtime === runtime.runtime)}/>)}
    {report.stale && !report.unreported
      && <p className="type-meta text-warning">This report is out of date; the host has stopped sending health snapshots.</p>}
    <p className="type-meta text-muted">The host qualifies a new version on its own as soon as it is published. Update switches to a qualified one; probation rolls it back on a runtime failure. Rolling back by hand is the command shown.</p>
  </Card>;
}

// The line shown where work is started, rather than where health is read.
//
// Deliberately not a disabled button. The operator may have a reason to try, the
// database is the boundary that actually refuses, and a control that is greyed
// out with no sentence attached is the worst of both: it neither explains nor
// permits.
export function RuntimeDispatchWarning({ report }: { report: RuntimeReadinessReport }) {
  const blockers = dispatchBlockers(report);
  if (blockers.length === 0) return null;
  return <Notice tone="danger" role="status" className="mb-3">
    <strong className="block font-medium">New chats will be refused</strong>
    <ul className="mt-1.5 list-disc pl-4">{blockers.map((blocker) => <li key={blocker} className="[&+&]:mt-0.5">{blocker}</li>)}</ul>
  </Notice>;
}
