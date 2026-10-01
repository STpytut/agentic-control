#!/usr/bin/env node
// Moves a host from the proof-of-concept layout to the product's (WP-5c).
//
//   codex-poc, /home/codex-poc               -> codex-worker, /home/codex-worker
//   /srv/infra-cod-handoff-poc/{workspaces,gate-smoke}
//                                            -> /srv/infra-cod/{workspaces,gate-smoke}
//
// The account is renamed, not recreated: `usermod -l … -m` and `groupmod -n`
// keep UID and GID, so no file changes owner, nothing is chowned, and there is
// never a second account that could run beside the first. The directories are
// renamed on the same filesystem, which is atomic per directory.
//
// Codex's own state records absolute paths under the old home — every thread
// in its state database is `paginated`, and for those Codex trusts the stored
// rollout path rather than searching (thread_rollout_resolver.rs at
// rust-v0.154.0). A root-owned link /home/codex-poc -> codex-worker keeps them
// valid, so an existing conversation resumes its native session; nothing in
// Codex's database is rewritten.
//
// Who runs it: deploy/run-production-migrations.sh, from the release being
// installed, before the SQL migrations and all-or-nothing with them. `0065` is
// declared backward-incompatible, so the coordinator has stopped every service
// before the runner starts. Every step is journalled in
// /etc/infra-cod/layout-migration.json after it completes; `revert` undoes the
// completed steps in reverse order.
//
//   node layout-migration.mjs plan      what it would do, changing nothing
//   node layout-migration.mjs apply     idempotent: a migrated host is a no-op
//   node layout-migration.mjs revert    undo a journalled apply
//
// Two compatibility links remain after a move, both root-owned:
// /home/codex-poc -> codex-worker and /srv/infra-cod-handoff-poc/workspaces ->
// ../infra-cod/workspaces. They exist because both runtimes record absolute
// paths in their own databases — Codex its threads' rollout files and cwd,
// OpenCode its sessions' directory — and those records are not ours to rewrite.

import { spawnSync } from "node:child_process";
import {
  existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmdirSync, symlinkSync,
  unlinkSync, writeFileSync, readdirSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { adapterFor } from "./runtime-adapters.mjs";
import { INSTALLATION_LAYOUT } from "./installation-layout.mjs";
import { ETC_ROOT, sys } from "./release-inventory.mjs";

// The layout this moves away from. The only place in running code where the
// proof of concept's names remain, and only so a host still on them can be
// recognised and moved.
export const LEGACY_LAYOUT = Object.freeze({
  user: "codex-poc",
  home: "/home/codex-poc",
  srvParent: "/srv/infra-cod-handoff-poc",
  workspaceRoot: "/srv/infra-cod-handoff-poc/workspaces",
  gateSmokeRoot: "/srv/infra-cod-handoff-poc/gate-smoke",
});

export const LAYOUT_JOURNAL = path.join(ETC_ROOT, "layout-migration.json");
const JOURNAL_SCHEMA = "infra-cod/layout-migration/1";
const RUNTIMES_RECORD = path.join(ETC_ROOT, "runtimes.json");

export class LayoutError extends Error {
  constructor(message, { detail = null } = {}) {
    super(message);
    this.name = "LayoutError";
    this.detail = detail;
  }
}

function target() {
  const codex = adapterFor("codex");
  return {
    user: codex.user,
    home: codex.home,
    srvParent: path.dirname(INSTALLATION_LAYOUT.workspaceRoot.path),
    workspaceRoot: INSTALLATION_LAYOUT.workspaceRoot.path,
    gateSmokeRoot: INSTALLATION_LAYOUT.gateSmokeRoot.path,
  };
}

function run(binary, args) {
  const result = spawnSync(binary, args, { encoding: "utf8", timeout: 60_000 });
  return {
    ok: result.status === 0,
    status: result.status,
    stdout: (result.stdout ?? "").trim(),
    stderr: (result.stderr ?? result.error?.message ?? "").trim(),
  };
}

function must(binary, args, what) {
  const result = run(binary, args);
  if (!result.ok) throw new LayoutError(`${what} failed: ${binary} ${args.join(" ")}: ${result.stderr || `exit ${result.status}`}`);
  return result;
}

const accountExists = (name) => run("getent", ["passwd", name]).ok;
const groupExists = (name) => run("getent", ["group", name]).ok;

function kind(file) {
  try {
    const stat = lstatSync(file);
    if (stat.isSymbolicLink()) return "link";
    if (stat.isDirectory()) return "directory";
    return "other";
  } catch {
    return "absent";
  }
}

// ------------------------------------------------------------------ state

// What layout the host is on. `legacy` and `current` are the two a host may be
// on; `fresh` has neither account (a new installation creates the current one
// itself); anything else is `mixed` and is reported with what is where.
export function detectLayout() {
  const legacy = LEGACY_LAYOUT;
  const next = target();
  const facts = {
    legacyAccount: accountExists(legacy.user),
    currentAccount: accountExists(next.user),
    legacyHome: kind(sys(legacy.home)),
    currentHome: kind(sys(next.home)),
    legacyWorkspaces: kind(sys(legacy.workspaceRoot)),
    currentWorkspaces: kind(sys(next.workspaceRoot)),
    legacyGateSmoke: kind(sys(legacy.gateSmokeRoot)),
    currentGateSmoke: kind(sys(next.gateSmokeRoot)),
  };
  const isLegacy = facts.legacyAccount && !facts.currentAccount
    && facts.legacyHome === "directory" && facts.currentHome === "absent"
    && facts.legacyWorkspaces === "directory" && facts.currentWorkspaces === "absent"
    && facts.currentGateSmoke === "absent";
  const isCurrent = facts.currentAccount && !facts.legacyAccount
    && facts.currentHome === "directory" && ["link", "absent"].includes(facts.legacyHome)
    && ["link", "absent"].includes(facts.legacyWorkspaces) && facts.legacyGateSmoke === "absent";
  const isFresh = !facts.legacyAccount && !facts.currentAccount
    && facts.legacyHome === "absent" && facts.legacyWorkspaces === "absent";
  const layout = isLegacy ? "legacy" : isCurrent ? "current" : isFresh ? "fresh" : "mixed";
  return { layout, facts, legacy, target: next };
}

function readJournal() {
  if (!existsSync(LAYOUT_JOURNAL)) return null;
  const journal = JSON.parse(readFileSync(LAYOUT_JOURNAL, "utf8"));
  if (journal.schema !== JOURNAL_SCHEMA) throw new LayoutError(`${LAYOUT_JOURNAL} is not a layout journal this code reads`);
  return journal;
}

function writeJournal(journal) {
  mkdirSync(path.dirname(LAYOUT_JOURNAL), { recursive: true });
  const temporary = `${LAYOUT_JOURNAL}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(journal, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, LAYOUT_JOURNAL);
}

// ------------------------------------------------------------------ fence

// Nothing may be running as the account or out of the trees about to move.
// The coordinator stops every unit before the runner starts; this checks it
// rather than assuming it.
function assertFenced(legacy) {
  const processes = run("pgrep", ["-u", legacy.user]);
  if (processes.ok) {
    throw new LayoutError(`processes are running as ${legacy.user} (${processes.stdout.split("\n").join(", ")}); the layout cannot move under them`);
  }
  if (processes.status !== 1) {
    throw new LayoutError(`whether anything runs as ${legacy.user} could not be determined: ${processes.stderr || `exit ${processes.status}`}`);
  }
  const supervisor = run("systemctl", ["is-active", "infra-cod-runtime-supervisor.service"]);
  if (supervisor.stdout === "active" || supervisor.stdout === "activating") {
    throw new LayoutError("the runtime supervisor is running; the layout moves only with every service stopped");
  }
}

// ------------------------------------------------------------------ steps

// Each step: `apply` returns what `revert` needs; both are idempotent against
// the facts, so a revert after a crash between two statements still converges.
const STEPS = [
  {
    name: "account",
    describe: ({ legacy, next }) => `rename the account and group ${legacy.user} to ${next.user}, moving ${legacy.home} to ${next.home}`,
    apply({ legacy, next }) {
      must("usermod", ["-l", next.user, "-d", next.home, "-m", legacy.user], "renaming the account");
      must("groupmod", ["-n", next.user, legacy.user], "renaming the group");
      return {};
    },
    revert({ legacy, next }) {
      if (groupExists(next.user)) must("groupmod", ["-n", legacy.user, next.user], "renaming the group back");
      if (accountExists(next.user)) must("usermod", ["-l", legacy.user, "-d", legacy.home, "-m", next.user], "renaming the account back");
    },
  },
  {
    name: "home-link",
    describe: ({ legacy, next }) => `link ${legacy.home} -> ${path.basename(next.home)}, so Codex's recorded paths still resolve`,
    apply({ legacy, next }) {
      symlinkSync(path.basename(next.home), sys(legacy.home));
      return {};
    },
    revert({ legacy }) {
      if (kind(sys(legacy.home)) === "link") unlinkSync(sys(legacy.home));
    },
  },
  {
    name: "roots",
    describe: ({ legacy, next }) => `move ${legacy.workspaceRoot} to ${next.workspaceRoot} and ${legacy.gateSmokeRoot} to ${next.gateSmokeRoot}, linking the old workspace root to the new`,
    // The old workspace root stays as a link: OpenCode records each session's
    // absolute directory (the `session.directory` column of its database), as
    // Codex records its threads' cwd, and a resumed session must still find
    // it. Gate scratch space is disposable and is not linked.
    apply({ legacy, next }) {
      const createdParent = kind(sys(next.srvParent)) === "absent";
      if (createdParent) mkdirSync(sys(next.srvParent), { mode: 0o755 });
      renameSync(sys(legacy.workspaceRoot), sys(next.workspaceRoot));
      const movedGateSmoke = kind(sys(legacy.gateSmokeRoot)) === "directory";
      if (movedGateSmoke) renameSync(sys(legacy.gateSmokeRoot), sys(next.gateSmokeRoot));
      symlinkSync(path.relative(path.dirname(legacy.workspaceRoot), next.workspaceRoot), sys(legacy.workspaceRoot));
      return { createdParent, movedGateSmoke };
    },
    // From the facts, not from what was recorded: a step that failed half-way
    // recorded nothing, and has to be undone all the same.
    revert({ legacy, next }) {
      if (kind(sys(legacy.srvParent)) === "absent") mkdirSync(sys(legacy.srvParent), { mode: 0o755 });
      if (kind(sys(legacy.workspaceRoot)) === "link") unlinkSync(sys(legacy.workspaceRoot));
      for (const key of ["workspaceRoot", "gateSmokeRoot"]) {
        if (kind(sys(next[key])) === "directory" && kind(sys(legacy[key])) === "absent") {
          renameSync(sys(next[key]), sys(legacy[key]));
        }
      }
      if (kind(sys(next.srvParent)) === "directory" && readdirSync(sys(next.srvParent)).length === 0) {
        rmdirSync(sys(next.srvParent));
      }
    },
  },
  {
    name: "runtimes-record",
    describe: ({ legacy, next }) => `record ${next.user} as Codex's user in ${RUNTIMES_RECORD}`,
    apply({ legacy, next }) {
      if (!existsSync(RUNTIMES_RECORD)) return { previous: null };
      const previous = readFileSync(RUNTIMES_RECORD, "utf8");
      const record = JSON.parse(previous);
      if (record.runtimes?.codex?.user === legacy.user) {
        record.runtimes.codex.user = next.user;
        const temporary = `${RUNTIMES_RECORD}.tmp`;
        writeFileSync(temporary, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o644 });
        renameSync(temporary, RUNTIMES_RECORD);
      }
      return { previous };
    },
    revert(_context, done) {
      if (typeof done?.previous === "string") writeFileSync(RUNTIMES_RECORD, done.previous, { mode: 0o644 });
    },
  },
];

// ------------------------------------------------------------------ commands

export function planLayout() {
  const state = detectLayout();
  const context = { legacy: state.legacy, next: state.target };
  const actions = state.layout === "legacy" ? STEPS.map((step) => step.describe(context)) : [];
  return { ...state, actions, journal: readJournal() };
}

export function applyLayout({ reporter = null } = {}) {
  const journal = readJournal();
  if (journal?.state === "applying") {
    throw new LayoutError(`${LAYOUT_JOURNAL} records an apply that did not finish; run \`revert\` before applying again`);
  }
  const state = detectLayout();
  if (state.layout === "current" || state.layout === "fresh") {
    reporter?.log?.(`layout: already ${state.layout}; nothing to move`);
    return { moved: false, layout: state.layout };
  }
  if (state.layout === "mixed") {
    throw new LayoutError("the host is on neither layout; refusing to move anything", { detail: state.facts });
  }
  assertFenced(state.legacy);

  const context = { legacy: state.legacy, next: state.target };
  const record = { schema: JOURNAL_SCHEMA, state: "applying", startedAt: new Date().toISOString(), from: state.legacy, to: state.target, steps: [] };
  writeJournal(record);
  try {
    for (const step of STEPS) {
      // Journalled before it runs as well as after: a step that fails half-way
      // is undone with the ones before it.
      record.steps.push({ name: step.name, done: null, started: true });
      writeJournal(record);
      record.steps.at(-1).done = step.apply(context);
      writeJournal(record);
      reporter?.log?.(`layout: ${step.describe(context)}`);
    }
  } catch (error) {
    reporter?.warn?.(`layout: ${error.message}; reverting`);
    revertSteps(record, context, reporter);
    record.state = "reverted";
    record.error = error.message;
    writeJournal(record);
    throw error;
  }
  record.state = "applied";
  record.finishedAt = new Date().toISOString();
  writeJournal(record);
  const after = detectLayout();
  if (after.layout !== "current") {
    throw new LayoutError(`the move finished but the host reads as ${after.layout}`, { detail: after.facts });
  }
  // The migration runner reads this line to know it has a move to revert if
  // the SQL migrations then fail.
  reporter?.log?.("layout: moved");
  return { moved: true, layout: after.layout };
}

function revertSteps(record, context, reporter) {
  for (const done of [...record.steps].reverse()) {
    const step = STEPS.find((candidate) => candidate.name === done.name);
    step.revert(context, done.done);
    reporter?.log?.(`layout: reverted ${step.name}`);
  }
}

export function revertLayout({ reporter = null } = {}) {
  const record = readJournal();
  if (!record || !["applied", "applying"].includes(record.state)) {
    throw new LayoutError("there is no applied layout move to revert");
  }
  const context = { legacy: record.from, next: record.to };
  // Revert moves the account back, so the same fence applies to the new name.
  assertFenced(record.to);
  revertSteps(record, context, reporter);
  record.state = "reverted";
  record.revertedAt = new Date().toISOString();
  writeJournal(record);
  return { reverted: true, layout: detectLayout().layout };
}

// ------------------------------------------------------------------- CLI

function invokedDirectly() {
  if (!process.argv[1]) return false;
  try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
}

if (invokedDirectly()) {
  const [command] = process.argv.slice(2);
  const reporter = { log: (line) => process.stdout.write(`${line}\n`), warn: (line) => process.stderr.write(`${line}\n`) };
  try {
    if (command === "plan") process.stdout.write(`${JSON.stringify(planLayout(), null, 2)}\n`);
    else if (command === "apply") applyLayout({ reporter });
    else if (command === "revert") revertLayout({ reporter });
    else { process.stderr.write("usage: layout-migration.mjs plan|apply|revert\n"); process.exitCode = 2; }
  } catch (error) {
    process.stderr.write(`layout-migration: ${error.message}${error.detail ? `\n${JSON.stringify(error.detail)}` : ""}\n`);
    process.exitCode = 1;
  }
}
