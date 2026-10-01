# Models and runtime updates — design

Stage 12, items 8 and 9 of [STAGE_12_PLAN.md](STAGE_12_PLAN.md), per
[RUNTIMES_AND_MODELS_BRIEF.md](RUNTIMES_AND_MODELS_BRIEF.md). Revision 1,
2026-09-28, branch `feat/stage-12-runtimes`. **A design for the owner's decisions,
not code:** nothing here changes code, migrations, `apps/web` or `deploy/`. The
wider Paperclip survey it draws on is [PAPERCLIP_SURVEY.md](PAPERCLIP_SURVEY.md).

> **Decided 2026-09-28:** the owner accepted all fifteen recommendations (R1–R15, §7) and the work packages W1–W8 (§6). Delivery order: W1, W2, then W3–W4; W8 after the owner has applied R13 on the host; W5–W7 after that. Review notes for revision 2 are at the end of this document.

**The idea in one paragraph.** Both problems are the same question — *does this
thing work on this host, at this version?* — so both get one answer: a
**qualification**, recorded as evidence, which the database reads to decide what
is eligible. A runtime version is qualified once by a fixed suite of checks, run
beside the active version and never instead of it; a model is qualified by one
short call at the runtime version it will run on. Models the operator uses, pins
or picks are checked automatically; nothing is offered until it passes; nothing
new is used until it has been shown to work (the survey's first idea). The
operator's job shrinks to *choosing*: which model a member runs, and whether to
promote a runtime version that has already passed.

Contents: [1 Paperclip findings](#1-paperclip-findings) ·
[2 Model catalog](#2-model-catalog-target-model) ·
[3 Runtime updates](#3-runtime-updates-target-routine) ·
[4 How the two meet](#4-how-the-two-meet) ·
[5 Data](#5-data-and-migrations) · [6 Work packages](#6-work-packages) ·
[7 Decisions](#7-decisions-for-the-owner) · [8 Risks](#8-risks)

---

## 0. Where we are (what this design replaces)

Facts from the code on this branch, so every change below has a "from".

- **Catalog rows are per runtime version.** `provider_model_catalog`'s identity is
  `(connection_id, provider_id, model_id, adapter_version, runtime_version)`
  (0027 lines 76–77). A refresh under a new runtime version inserts new rows and
  marks the old ones `stale` (0083 `upsert_catalog_entries`, lines 807–814).
  Project defaults point at **row ids** (`project_runtime_defaults.orchestrator_entry_id`,
  `project_runtime_default_executors.catalog_entry_id`, 0028 lines 22–38), so a
  runtime update silently strands every team on stale rows until someone
  re-verifies and re-picks (0094 exists because the read had to survive that).
- **Two manual steps.** "Update model list" queues `catalog_refresh_jobs`; the
  refresh worker polls every 60 s (`CATALOG_POLL_MS`) and also refreshes every
  24 h and on reconnect (0093). "Verify model" calls
  `request_catalog_gate_allowlist` (0038 lines 72–112: at most 8 entries, writes
  `catalog_gate_allowlist`, then `request_catalog_verification`); the gate worker
  polls every 60 s, one entry per batch, and is capped per operator at 2 in
  flight and 20 per 24 h (0083 `claim_catalog_verifications`, lines 603–611).
- **A model check costs two model calls and tests the runtime, not the model.**
  Codex: a `PARITY_OK` turn, then a `sleep 60` turn interrupted, then
  `thread/resume` (catalog-gate-worker.mjs lines 162–270). OpenCode and Claude: a
  `PARITY_OK` batch run and an interrupted one (lines 274–320). Interrupt and
  resume are properties of the runtime version, re-proven for every model.
- **Where lists come from.** Codex: app-server `model/list` over the account
  channel (5 models at 0.154.0, 7 at 0.158.0). OpenCode: the loopback
  `opencode serve` provider read for Zen, Go or OpenRouter (299 OpenRouter entries
  of today's 319). Claude: three aliases written by the worker (`haiku`,
  `sonnet`, `opus`), the gate recording what each resolved to.
- **Runtime versions** are pinned in code: each driver's
  `verified: { adapterVersion, runtimeVersion, evidence }` (codex.mjs lines
  270–285: 0.154.0; opencode.mjs: 1.18.31; claude.mjs: 2.1.270).
  `infra-cod runtime install <name> --version <exact>` resolves the platform
  package, verifies the npm registry signature with the pinned key, unpacks into
  an immutable `/opt/infra-cod/runtimes/<name>/<version>`, and swings the active
  link under the fence (runtime.mjs `installRuntime`, from line 510). Installing
  *is* activating. `doctor` warns `runtime.driver_verified.<name>` when the active
  version is not the driver's pair, fails `runtime.self_update.<name>` when the
  control is not recorded — and OpenCode has none (`autoUpdate.mechanism: null`,
  runtime-adapters.mjs lines 265–277).
- **Codex 0.158.0** (2026-09-28): the install went well, the refresh saw two new
  models, the gate passed them in about 40 s, a delegate-only task passed — and
  every read-only shell command panicked (`filesystem-restricted execution
  requires bubblewrap`). Nothing in the gate ran a shell command in a read-only
  sandbox. Rolled back by hand.

---

## 1. Paperclip findings

Commit `0f14d261233c545aa6a8a38ec253c498a5130fff`. Ideas only; no code is taken.

**Their answers to the brief's questions.**
- *Dynamic or curated?* Both. Codex: a **curated list per adapter release** plus
  free-text "manual" ids. Claude: the Anthropic `/v1/models` list when an API key
  exists (60 s cache), else a curated list; Bedrock curated. OpenCode:
  `opencode models` discovered live (60 s cache), curated fallback for remote
  hosts. Curated lists are maintained by hand in dated audit documents.
- *Verify before offering?* **No.** There is no per-model verification. An
  agent's "Test environment" runs coded checks and one "Respond with hello."
  probe for the agent's configured model; OpenCode runs a best-effort
  availability pre-flight that never blocks a run.
- *How they learn a new CLI version exists, and what stops a broken one?* They
  do not watch agent CLIs at all. Their runtime images install
  `@anthropic-ai/claude-code@latest`; the CLI version is whatever is installed.
  Per-model minimum versions and `--help` feature probes refuse a known-too-old
  CLI; **nothing stops a broken new one.** They do watch *their own* package: a
  daily registry check, `update --check`, an atomic install store with rollback
  and automatic rollback when post-switch validation fails.
- *What the operator sees:* a searchable model combobox (curated + discovered +
  "use manual model"), a "Detect model" button, and the test's coded results.

| # | Idea | Where (at `0f14d26`) | Fits? | Our version |
| --- | --- | --- | --- | --- |
| P1 | Curated model list per adapter release, plus manual ids | `packages/adapters/codex-local/src/index.ts` line 109 (`models`), lines 86–95 (`isCodexLocalManualModel`) | **no** | Our list comes from the runtime itself (`model/list`), which is truer per account and per version; free-text ids would bypass "the database decides". |
| P2 | Provider model API with a short cache and a curated fallback | `packages/adapters/claude-local/src/server/models.ts` lines 5–7, 111–148 | **no** | Needs an API key; our Claude runs on a subscription whose CLI takes aliases. Keep the aliases; record what each resolved to. |
| P3 | On a cached "model not listed", refresh the list once before rejecting | `packages/adapters/opencode-local/src/server/models.ts` lines 320–351 | **adapt** | When a real run fails with "model not found", queue a list refresh and one re-check before the entry is marked rejected. |
| P4 | Availability probe is best-effort and never fatal, because probes on the run path crashed runs | same file, lines 296–318 | **no** | Our checks are off the run path entirely, so a failing probe can never cost a task its run; eligibility stays a database fact. |
| P5 | Minimum CLI version per model | `packages/adapters/claude-local/src/server/cli-capabilities.ts` lines 38–44 | **adapt** | Learned, not hand-kept: `model_listings` records which runtime versions list a model and `model_checks` which passed. |
| P6 | Feature probes of the installed CLI (`--help` contains `--effort`), cached per target, degrading to the conservative path | same file, lines 112–166 | **adapt** | The qualification suite's `config.keys` check: every flag and config key the adapter relies on is probed on the candidate, not assumed. |
| P7 | Read the CLI version uncached so an upgrade is noticed without a restart | same file, lines 97–110 | **yes** | Already true of `doctor`; the qualification record stores what `--version` printed, not what was asked for. |
| P8 | "Test environment": a list of coded checks with levels (info/warn/error) and a hint, plus one hello probe | `packages/adapters/codex-local/src/server/test.ts` lines 258–461 | **adapt** | The report format of the qualification suite (code, result, failure class, detail) and the model check's single call. |
| P9 | Daily update notice from registry metadata, cached, 2.5 s timeout, opt-out | `cli/src/update-notice.ts` lines 7–19 | **adapt** | The runtime watch (§3.1): exact versions, not dist-tags; a minimum age before a version is offered. |
| P10 | `update --check` exits 10 when an update exists | `cli/src/commands/update.ts` line 222 | **yes** | `infra-cod runtime watch --check` exits non-zero when a qualified-but-not-promoted or newer version exists, for scripts and `doctor`. |
| P11 | Install store: immutable payload directories, an atomically flipped `current` link, a manifest keeping two `previous`; rollback flips to `previous[0]` | `cli/src/commands/update.ts` lines 128–140, 252–260; `cli/src/install-store.ts` | **yes** | We have the same store (`/opt/infra-cod/runtimes`, active link, inventory). Add: keep the previous active version until the new one leaves probation (§3.4). |
| P12 | Automatic rollback when validation right after the switch fails | `cli/src/commands/update.ts` lines 149–165, 261–271 | **adapt** | Probation (§3.4): the first real runs after a promotion are watched; a failure of a class the suite also checks rolls back by itself. |
| P13 | Backup before update; rollback does not reverse state migrations | same file, lines 51–68, 178 | **adapt** | Back up the runtime's state directories (`adapter.backup`) before promotion; say plainly that a newer runtime may have migrated its session store. |
| P14 | `doctor` checks of the install store: payload exists, link matches manifest, orphaned payloads | `cli/src/checks/managed-install-check.ts` | **yes** | We have `runtime.record_agrees`; add the executable's digest against the inventory (catches any self-update) and candidate directories left behind. |
| P15 | Runtime images built from `@latest`, signed after the fact | `docker/agent-runtime/Dockerfile.claude` line 6; `.github/workflows/agent-runtime-images.yml` | **no** | The counterexample: a signature proves who built it, not that it works. |
| P16 | Codex wrapped in their own bubblewrap sandbox; `sandbox_mode="workspace-write"` forced unless flags say otherwise | `packages/adapters/codex-local/src/server/execute.ts` lines 996–1016; `codex-args.ts` lines 56–68 | **no / informs R13** | They depend on user namespaces — exactly what Ubuntu 24.04 restricts here. It confirms Codex ≥ 0.155's prerequisite is real, and it is option (d) of R13 (an outer sandbox). |
| P17 | Subscription quota read without a model call: Codex `account/rateLimits/read` on the app-server; Claude's OAuth usage endpoint | `packages/adapters/codex-local/src/server/quota.ts` line 557; `claude-local/src/server/quota.ts` lines 212–330 | **adapt** | Codex: read through the account channel before automatic checks, defer above a threshold (§2.6). Claude: not read (it needs the token outside the runtime); a 429 is classified *inconclusive*, never *rejected*. |
| P18 | Probe homes seeded with a copy of the credential; a refreshed token copied back atomically | `packages/adapters/codex-local/src/server/codex-auth-copyback.ts`; `test.ts` lines 97–231 | **adapt** | A candidate runs in a scratch state home so it cannot migrate the active version's session store (§3.2); if it refreshes the login, the new credential is copied back by the runtime user, atomically. |
| P19 | Failure taxonomy; complete vs partial campaigns | `doc/evals.md` lines 109–165 | **yes** | Every check carries `failure_class`; only a *complete* passing qualification may promote. |
| P20 | Automated proof and live proof reported separately | `doc/plans/chat-adapters/2026-09-06-live-qualification-addendum.md` lines 1–6 | **yes** | The code baseline (container gate) and the host qualification are two kinds of evidence, named as such. |
| P21 | Changed-tool quarantine: something new on refresh is unusable until reviewed | `doc/MCP-ACCESS-GOVERNANCE.md` lines 190–202 | **adapt** | A new model or runtime version is unusable until qualified — but qualification runs by itself; only *promotion* needs the operator. |
| P22 | Dated, hand-written adapter/model audit with sources | `doc/adapter-model-audit-2026-09-22.md` | **adapt** | Our audit is generated: the qualification and check records *are* the audit. |

---

## 2. Model catalog, target model

### 2.1 Three facts kept apart

Today one row carries three facts at once. They change at different speeds, so
they get separate homes:

| Fact | Changes when | Where it lives |
| --- | --- | --- |
| **The model exists for this connection** (id, name, badges, efforts, tiers) | the provider or the runtime lists something new | `provider_model_catalog`, identity `(connection_id, provider_id, model_id)` — stable across runtime versions |
| **Which runtime versions list it** | a runtime version changes (Codex builds its list from its own version) | `model_listings` |
| **It worked, here, at this version, with this credential** | a check runs | `model_checks` |

**Eligible** (selectable, what the database decides) =
listed at the **active** runtime version **and** a *passed* check for the active
runtime version **and** for the connection's current `credential_generation`
**and** the connection is `connected` **and** no failure has invalidated it since.
Eligibility is a function (`model_eligibility`); the existing `status` column is
kept as its maintained projection (`verified` ⇔ eligible), so every reader written
since 0027 — the Team tab (0089), snapshots (0028), readiness (0088) — keeps
working unchanged (§5.3).

### 2.2 Where the list comes from, per runtime

| Runtime | Source | When refreshed | Cost |
| --- | --- | --- | --- |
| Codex | app-server `model/list` over the account channel, **per runtime version** | connection (re)connected; daily; **every qualification of a candidate** (run against the candidate binary, §3.2); promotion | no model call |
| OpenCode (Zen, Go, OpenRouter) | the loopback `opencode serve` provider read for the connection's gateway | connection (re)connected; daily; qualification of a candidate; a run failing with "model not found" (P3) | no model call |
| Claude Code | the aliases `haiku`, `sonnet`, `opus` — a list the adapter declares, since the CLI has none | adapter release; each check records the model the alias resolved to | no model call |

"Update model list" stops being a step: every trigger above is automatic. The
panel keeps a small **Refresh now** link for the impatient, and shows when the
list was last read.

### 2.3 How a model becomes usable without two steps

Options the brief named, weighed:

| Option | Operator effort | Model calls | Verdict |
| --- | --- | --- | --- |
| a. Check **everything** on discovery | none | one per entry per version: 319 today, 299 of them OpenRouter and **metered** | **no** — spends money and subscription windows on models nobody will use |
| b. Curated per-runtime-version allowlists shipped with the release | none | none at release; still needs a host check | **no** — a release cannot know what an account's plan includes; Codex's list is per account and version (P1's weakness) |
| c. Lazy check **on first use** (a task starts, fails clearly) | none | one, at the worst moment | **no** — the failure lands in a task, which is what the catalog exists to prevent |
| d. Checks tied to a runtime version, inherited across patch versions | none | fewer | **partly** — inheritance is decided by *evidence*, not by version arithmetic: Codex broke inside 0.x minors; a runtime qualification (§3.2) is what carries checks forward |
| **e. Automatic checks for a bounded set: small subscription lists, models in use, pinned models, a model being picked** | **one click (pick or pin)** | bounded, counted (§2.6) | **recommended** |

**Rule (R2).** A check starts by itself — no button — for:

1. **Small subscription and free lists, whole.** A connection whose list has at
   most `CATALOG_AUTO_CHECK_MAX` entries (default 12) and whose billing boundary is
   `subscription` or `free`: Codex (5–7 models), Claude (3 aliases), OpenCode Go.
   One call per model per runtime version.
2. **Models in use** — any model a project team or an open task's snapshot names.
   Re-checked on the *candidate* during a runtime qualification (§3.2), so a
   promotion never leaves a team without a checked model.
3. **Pinned models** — the operator's favourites (§2.5). Pinning *is* the intent
   that bounds the cost.
4. **The model being picked** in Team (§2.7) — the check starts on the pick, the
   dialog shows its progress, the member is added when it passes.

Everything else — the rest of OpenRouter, a large Zen list — is listed and
searchable, marked "not checked", and costs nothing until pinned or picked.

### 2.4 What "checked" means, and when it expires

**A model check** is one short turn at the model: the same prompt as today
(`Reply with exactly the word PARITY_OK`), through the runtime's gate surface in a
scratch workspace, against the exact `(connection, provider, model)` at the
**active** runtime version (or the candidate's, during qualification). It proves:
the credential reaches the provider, the plan includes the model, the runtime
accepts the id, the stream parses, and — for Claude — which model the alias
resolved to. **One model call** instead of today's two: interrupt, resume and
streaming belong to the runtime version and are proven once per version by the
qualification (§3.2), not per model (R4).

**Results** carry a `failure_class` (P19):

| Result | Meaning | Effect |
| --- | --- | --- |
| `passed` | the model answered | eligible (with the other conditions) |
| `rejected` — class `model` | the provider or runtime said no: not found, not in plan, unsupported | not eligible; the reason is shown on the row; re-checked only on a new list, a new credential or a new runtime version |
| `inconclusive` — class `infrastructure` | rate or usage limit, network, lease lost, no memory, fence | **eligibility unchanged**; retried with backoff (5 min, 30 min, 2 h); never shown as a failure of the model |
| `failed` — class `runtime` or `harness` | the runtime crashed, the stream did not parse, our code failed | not eligible at this version; points at the runtime's qualification, not the model |

**Expiry (R3).** A passed check stops counting when:

- **the active runtime version changes** — unless the promotion carried it forward
  because the qualification re-checked that model on the candidate (§3.2);
- **the connection's credential changes** (`credential_generation`: reconnect,
  replaced key, new login) — the same reason 0093 re-verifies after a reconnect;
- **the model leaves the list** at the active version (row `unavailable`);
- **a real run proves it wrong**: a task run that fails with a model-class error
  (P3: after one list refresh and one re-check) records a `rejected` check;
- **a Claude alias drifts**: a real run's init event reports a different resolved
  model than the check recorded → the row says "sonnet now resolves to …" and a
  background re-check is queued (no loss of eligibility meanwhile — the alias
  still works);
- **age**, as a safety net only: checks of *in-use* models older than 30 days are
  re-run in the background at a quiet hour; everything else simply stays as it
  was checked, with its date shown.

### 2.5 The 299 OpenRouter models (R6)

OpenRouter is metered and wide. The panel does not show 299 rows; the database
keeps them (cheap, bounded, already normalized).

- **Default view:** the connection shows its **pinned** models and the models **in
  use**, and a count: "297 more — search".
- **Search** across id and display name, with filters (vendor, "checked only"),
  capped at 50 results per query; server-side, through one read function.
- **Pin** (☆) adds a model to the connection's favourites and **starts its
  check** — one click to "ready".
- A **pin is how the owner says "offer this in Team"**: Team's pickers list
  checked models first, then pinned-but-failed with their reason, then "search
  all".
- Existing `catalog_gate_allowlist` rows become pins in the migration: every
  model the operator ever asked to verify was a statement of intent.

### 2.6 What it costs, counted

Every check is one short turn. **Automatic checks are budgeted** per operator:
`CATALOG_AUTO_CHECKS_PER_DAY` (default 30, R5); pin and pick checks are the
operator's own clicks and are counted but not refused below a hard ceiling of 60
per day. The panel shows "12 checks today".

Before automatic checks on a **Codex** connection, the check lane reads the
subscription's windows through the account channel (`account/rateLimits/read`,
P17 — no model call, no credential leaves the runtime user) and **defers** if the
primary window is above 80 % used. Claude's window is not read (it would need the
token outside the runtime); a limit answer is `inconclusive` and backs off.

| Event | Checks, worst case today's host |
| --- | --- |
| Codex connection (re)connected | 5–7 (its list) |
| Claude connection (re)connected | 3 |
| OpenRouter connection (re)connected | pinned only (0 on a fresh connection) |
| Runtime candidate qualified | the suite's own turns (§3.2) + models in use on that runtime (2–6 today) |
| Operator pins or picks | 1 |
| Daily refresh with nothing new | 0 |

### 2.7 What the operator sees

**`/settings` → Models** (one card per connection, grouped as the redesign has
them — Anthropic, OpenAI, Other vendors). Model names, versions, dates and counts
in this and the other sketches are illustrative, not the host's state:

```
Models                                                    12 checks today · list read 2 h ago  [Refresh now]

ChatGPT (Codex 0.154.0) · subscription · Plus
  ● gpt-6.2                 ready   checked 2 h ago
  ● gpt-6.2-mini            ready   checked 2 h ago
  ◌ gpt-6.2-nano            checking… (Codex, about 40 s)
  ✕ gpt-5.6-pro             not in your plan (checked 2 h ago)
  Codex 0.158.0 would add gpt-6-sol, gpt-6-luna — see Runtimes

Claude (Claude Code 2.1.270) · subscription
  ● haiku → claude-haiku-4-5    ready   checked yesterday
  ● sonnet → claude-sonnet-5    ready   checked yesterday
  ● opus → claude-opus-5-5      ready   checked yesterday

OpenRouter (OpenCode 1.18.31) · metered
  ★ ● deepseek/deepseek-v4        ready    in use: coder, project "infra"
  ★ ● qwen/qwen3.5-coder          ready
  ★ ✕ openai/gpt-6-luna           provider refused: no endpoint for your key
  [ Search 296 more models…            ]  ☐ checked only
```

States have one word each: **ready**, **checking…**, **not checked**, **refused
(reason)**, **waiting (reason)** — e.g. "waiting: usage limit, retry at 14:20".
There is no "Verify" button; a failed row offers **Check again** (one click, the
same check), which is the only manual action left besides pin and search.

**`/settings` → Runtimes** — see §3.6.

**Team → Add member / Change model:**

```
Add member
  Role      [ Tester (checker) ▾ ]
  Model     [ search models…                        ]
            ── Ready on OpenCode ──────────────────────────
            deepseek/deepseek-v4 · OpenRouter · metered
            qwen/qwen3.5-coder   · OpenRouter · metered
            opencode-go/kimi-k3  · Go · plan
            ── Not checked (checked when you pick it, ~40 s) ──
            mistral/devstral-3   · OpenRouter · metered
            ── Not available for this role ────────────────
            haiku (Claude) — Claude cannot hold the checker surface (T6)
  [ Add ]                     ◌ Checking mistral/devstral-3… (18 s)
```

Picking a not-checked model starts its check; the **Add** completes when it
passes, or the dialog shows the refusal with its reason and keeps the choice
open. Closing the dialog does not cancel the check — the model will simply be
ready next time. The database still refuses an unchecked model; the dialog
waits instead of the operator (R7). A member is never in a half-added state.

### 2.8 The check lane — not waiting for a worker

Item 8 of the plan: a check should start when asked, not behind task work.

- **Wake, not poll.** `request_model_check` issues `NOTIFY model_checks`; the check
  worker `LISTEN`s and claims within a second (the 60 s poll stays as a fallback).
- **Its own lane.** One check at a time, claimed in priority order
  *pick > pin > in-use re-check > automatic*. It never shares a job queue with
  task runs.
- **Background admission (K3).** A check is a run like any other and is admitted
  by memory — with one rule added for every background run (checks *and*
  qualifications): it is admitted only if, after it, the host still has room for
  **one more task run of the largest estimate** (600 MB, OpenCode). A check never
  takes the memory a task was about to need; it waits, visibly ("waiting: memory"),
  instead. With M1 it also gets its own `memory.max`.

---

## 3. Runtime updates, target routine

The routine, for Codex, OpenCode and Claude Code alike:

```
 watch ──► candidate ──► qualify ──► qualified ──► promote ──► probation ──► active
 (daily,    (installed    (fixed       (evidence    (operator,   (first runs   (previous kept
  no         beside,       suite, beside  recorded)   fenced)      watched)      until next
  download)  inactive)     the active)       │                          │         promotion)
                               ▼             │                          ▼
                            refused ◄────────┘ (any check red)       rolled back (one command,
                         (reason per check)                           or by itself on a
                                                                      runtime-class failure)
```

### 3.1 Watch — notice without updating

- A daily root timer, `infra-cod runtime watch`, reads the npm registry
  **metadata** for each adapter's platform package (`packageFor`: the Codex
  `…-linux-x64` build, `opencode-linux-x64`, `@anthropic-ai/claude-code-linux-x64`)
  — the same source and pinned key the installer uses. **No tarball is fetched.**
- It records every exact version newer than the active one in `runtime_versions`
  (state `available`, publish time), skipping pre-releases.
- **Minimum age (R8):** a version younger than 48 h is shown as "published
  yesterday — offered from Thursday" and is not offered for qualification yet;
  upstream hotfixes usually land in that window.
- A version the registry later deprecates or withdraws is marked `withdrawn`.
- The runtime never looks itself: Codex `check_for_update_on_startup=false`,
  Claude `DISABLE_AUTOUPDATER`/`DISABLE_UPDATES` stay; OpenCode gets its control
  in W1 (§3.7). `watch --check` exits non-zero when something is waiting (P10).

### 3.2 Qualify — a fixed suite, beside the active version

`infra-cod runtime qualify <name> --version <exact>` (R9: from the CLI first):

1. **Install as a candidate.** The existing resolve → signature → integrity →
   unpack path into `/opt/infra-cod/runtimes/<name>/<version>`, recorded in the
   inventory's `installed` list — **without swinging the active link**
   (`installRuntime` gains `activate: false`). Nothing running changes.
2. **Host prerequisites.** The adapter declares, per version range, what the host
   must provide (§3.5). `doctor`'s prerequisite checks run for the candidate's
   version; a missing one **refuses the qualification here**, before any model
   call, with the prerequisite's name and the owner decision it needs.
3. **The suite.** Run by the supervisor on a new **qualification surface**: the
   candidate's executable, chosen by version from the inventory (a closed set —
   only versions the inventory recorded, never a path from outside), launched as
   the runtime's own user, in a scratch git repository under the gate root, with
   a **scratch state home** (P18): a copy of the credential, nothing else of the
   active version's state — so a candidate that migrates its session store
   migrates a copy. If the candidate refreshes the login, the new credential is
   copied back atomically by the runtime user before the active version next
   needs it. Admitted by memory as a background run (§2.8). One qualification at
   a time on the host.
4. **Evidence.** Every check writes a row (§5.2); the qualification is `passed`
   only if it is **complete** (every check in the suite ran) and every check
   passed. A lost lease, a limit or a timeout makes it `inconclusive`, never
   `passed` — it can be re-run, it cannot promote.

**The suite — one check per capability the driver claims**, so the list follows
the drivers and nothing a driver promises goes unchecked (unclaimed capabilities
are `skipped`, and the record says so):

| Check | Capability | What it does | Codex | OpenCode | Claude |
| --- | --- | --- | --- | --- | --- |
| `package.signature` | — | registry signature with the pinned key, integrity, the executable is a regular file where the adapter says (today's `check-runtime-adapters`, run on the host) | ✓ | ✓ | ✓ |
| `version.reports` | — | `--version` as the runtime user prints the candidate's version | ✓ | ✓ | ✓ |
| `config.keys` | — | every setting the adapter passes is accepted and in effect (P6): Codex `features.use_legacy_landlock`, `check_for_update_on_startup`; OpenCode its self-update key; Claude `DISABLE_AUTOUPDATER` (`claude update` refused) | ✓ | ✓ | ✓ |
| `auth.present` | `account.*` | the auth probe answers "authenticated" with the copied credential (no login is run) | ✓ | ✓ | ✓ |
| `read_only.shell` | `run.read_only` | **a read-only turn that runs `cat NOTE.md` and `git log -1` itself and quotes both**, then tries to write `probe.txt` — the read must succeed, the write must be refused, the repository must be unchanged. *The check that would have refused Codex 0.158.0.* For Claude, which has no shell there, the same with its `Read` tool and a refused `Write` | ✓ | ✓ | ✓ |
| `write.commit` | `run.workspace_write` | a writing turn creates a file and commits it; the commit exists, the author is the platform's | — | ✓ | — |
| `tools.platform` | `tools.platform` | the turn calls `delegate_task` through the platform tool; a **stub socket** (no real task) records a well-formed call | ✓ | ✓ | ✓ |
| `tools.report` | `tools.worker_report` | the terminal report tool reaches the worker socket stub | — | ✓ | — |
| `stream.parse` | `stream.structured`, `events.raw` | every event of the turns above is recognized by the driver's normalizer; an unknown required event type fails | ✓ | ✓ | ✓ |
| `usage.report` | `usage.report` | the turn's tokens are reported | — | ✓ | ✓ |
| `session.resume` | `sessions.create`, `.resume` | a second turn resumes the first session and repeats a nonce from it | ✓ | ✓ | ✓ |
| `session.resume_from_active` | `sessions.resume` | a session **created by the active version** is resumed by the candidate — what a task in flight at promotion will do | ✓ | ✓ | ✓ |
| `interrupt` | `interrupt` | a turn running `sleep 60` (Claude: a long answer) is interrupted and ends `interrupted` within 10 s | ✓ | ✓ | ✓ |
| `catalog.list` | `catalog.models` | the candidate's model list is read; the **diff against the active version's list** is recorded (added, removed) | ✓ | ✓ | — |
| `models.in_use` | `gate.smoke` | one model check (§2.4) for each model in use on this runtime, **at the candidate** — carried forward if promoted | ✓ | ✓ | ✓ |
| `memory.peak` | — | the suite's peak memory, recorded against the adapter's estimate; never a failure, a warning above 120 % | ✓ | ✓ | ✓ |

**Cost:** Codex about 7 short turns plus one per model in use; OpenCode about 8;
Claude about 6. The prompts are a few lines and a scratch repository of three
files. One suite is minutes, not hours, and runs only when a candidate is asked
for.

### 3.3 Promote or refuse

- **Refused:** any red check. The candidate stays installed and inactive; the
  panel and `runtime list` say which check failed and why in one line — for
  0.158.0: *"read-only shell: `filesystem-restricted execution requires
  bubblewrap` — host prerequisite `bwrap.userns` not met (decision R13)"*.
  `runtime remove --version` removes it as today.
- **Promote** (R9, R10): `infra-cod runtime promote <name> --version <exact>`.
  Refused unless the database holds a **complete, passed** qualification of that
  exact version **under the adapter version this release ships**. It backs up the
  runtime's state directories (`adapter.backup`, P13), then runs the existing
  fenced switch — the supervisor stops admitting new launches of that runtime,
  waits for the ones in flight, swings the link, releases the fence. Running
  tasks keep their snapshot; their next turn launches the new version and was
  proven by `session.resume_from_active`. After the switch: models checked in
  `models.in_use` carry forward, a list refresh at the new version runs, and the
  small-list automatic checks for the new version start.
- **The driver's verified pair follows the host.** `capabilityVerification`
  today compares the active version with the constant in the driver. It becomes:
  *verified* if the version is the driver's **baseline** (the code constant,
  proven in the container gate and at release — "automated proof", P20) **or** the
  inventory records a complete passed host qualification for
  `(adapterVersion, version)` ("live proof"). The inventory (root-owned, read by
  the supervisor and `doctor`) and the database (read by the panel) carry the
  same qualification id and digest. `runtime.driver_verified.<name>` passes on
  either, and says which.
- **A release that changes a driver** (new `adapterVersion`) invalidates host
  qualifications made under the old adapter: `doctor` warns, and the owner
  re-runs `qualify` for the active version (minutes) — or the release's baseline
  is the active version and nothing is needed.
- **Override** (R10): `promote --accept-unqualified --reason "…"` exists for an
  emergency, recorded with the actor and reason, exactly like
  `--accept-unmanaged-updates`; `doctor` then warns until a qualification passes.

### 3.4 Roll back, and probation

- **One command:** `infra-cod runtime rollback <name>` — the fenced switch back to
  the previous active version, which is **kept installed** until the new one has
  left probation *and* been superseded (R12). The record says who rolled back and
  why.
- **Probation** (R11): after a promotion, the runtime's first **3 task runs or 24
  hours**, whichever is later. Each run's outcome is already recorded
  (`record_runtime_dispatch`, 0071, carries the runtime version); a failure is
  classified. A failure whose class the suite checks — launch crash, sandbox
  error in a read-only turn, stream the driver cannot parse, resume refused — is a
  **runtime-class** failure: the watch timer (running every 10 minutes during
  probation) rolls back by itself, fenced, and the panel shows a red line with the
  failed run. A model- or infrastructure-class failure never triggers a rollback.
- **What a rollback cannot undo:** a session the new version created and wrote in
  a newer format may not resume on the old one. Sessions created during probation
  are marked with the version; after a rollback their next turn starts a fresh
  native session with the conversation replayed as context, and the task says so.
  The state backup from the promotion is kept until probation ends.

### 3.5 Host prerequisites, declared and checked

Adapters gain `hostRequirements`: a list of named prerequisites with the version
range that needs them and a probe `doctor` can run without changing anything:

| Name | Needed by | Probe (read-only) | Today on `infra-vps` |
| --- | --- | --- | --- |
| `landlock` | Codex ≤ 0.154 (legacy Landlock), OpenCode and Claude read-only launches | `landlock` in `/sys/kernel/security/lsm` | met |
| `bwrap.userns` | Codex ≥ 0.155 (filesystem-restricted policies require bubblewrap) | a bubblewrap binary exists, and an unprivileged user namespace can be created *by that binary under its AppArmor profile* (`kernel.apparmor_restrict_unprivileged_userns`, the profile's `userns` rule) | **not met** (P-2, rc.30) |
| `cgroup.delegated` | every runtime (K3, M1) | the supervisor's delegated subtree | met |

`doctor` reports each as `runtime.host_requirement.<name>` with *which installed
or available versions need it*. The qualification refuses early on an unmet one
(§3.2 step 2). **The design does not change the host.** Meeting `bwrap.userns` is
a security configuration the owner decides (R13); the options are listed there.

### 3.6 What the operator sees — `/settings` → Runtimes

```
Runtimes

Codex          0.154.0 active since 2026-08-30 · verified (host qualification #14)
               0.158.0 available · refused 2026-09-28
                 ✕ read-only shell — needs host prerequisite "bubblewrap user namespaces" (owner decision R13)
                 adds models: gpt-6-sol, gpt-6-luna
               0.159.0 published yesterday — offered from 2026-09-30

OpenCode       1.18.31 active · verified (release baseline)
               1.19.2 available · qualified 2026-09-28 ✓ 12/12 checks · 4 min · 6 turns
                 promote: infra-cod runtime promote opencode --version 1.19.2
               self-update: disabled (autoupdate=false, verified at 1.18.31)

Claude Code    2.1.270 active · verified (release baseline)
               2.1.281 available · not qualified yet
                 qualify: infra-cod runtime qualify claude --version 2.1.281

[History]  2026-09-28 codex 0.158.0 installed by hand, rolled back (before this routine)
```

Each qualification opens to its check list (check, result, class, one line of
detail, duration). The commands are shown because in the first packages the
panel reads and the CLI acts (R9); the buttons come when the routine has run
twice on the host.

### 3.7 OpenCode's self-update, managed

Three layers, because the first two need proof and the third needs none:

1. **The setting.** Establish OpenCode's own control from the source of the pinned
   tag — the configuration schema's `autoupdate` key (and the flag module, if it
   documents an environment variable) — then write it into the root-owned
   configuration the adapter installs, like Codex's `config.toml` key. Recorded
   with `verifiedAgainst: "<tag> <file>"`, as the other two are. W1 establishes it;
   until then the record keeps saying "unverified".
2. **Proof per version.** The `config.keys` check (§3.2) reads OpenCode's resolved
   configuration as the runtime user and requires the key in effect — so every
   candidate proves it still honours the setting.
3. **It cannot matter anyway.** The supervisor launches the absolute path of the
   active link into a root-owned, immutable directory the runtime user cannot
   write; a self-update could only drop a binary somewhere nothing executes.
   `doctor` gains `runtime.executable_digest.<name>`: the active executable's
   SHA-256 against the digest recorded at install (P14) — any change, by anyone,
   is a failure.

---

## 4. How the two meet

- **A runtime version change re-lists and re-checks, in qualification, not after.**
  The candidate's own model list is read (`catalog.list`) and the models in use are
  checked on the candidate (`models.in_use`). At promotion: `model_listings` gains
  the new version's list, checks for in-use models carry forward, rows the new
  version does not list become `unavailable` *for that version* (the row stays;
  its history stays; teams pointing at it see "not offered by Codex 0.158.0").
  A team's choice is a row id that survives the upgrade; nothing is re-picked.
- **New models arrive with the version that lists them.** For 0.158.0 the panel
  says *"Codex 0.158.0 would add gpt-6-sol, gpt-6-luna"* on the Models card —
  the owner's original question answered where it was asked. They become ready
  after promotion by the small-list automatic checks.
- **A model list change never needs a runtime update.** A daily refresh at the
  same version that finds a new OpenRouter or Go model just adds a row
  (`not checked`, or checked automatically if the list is small). No runtime
  work.
- **The open item from 2026-09-28 closes itself.** `gpt-6-sol` and `gpt-6-luna`
  were verified by the 0.158.0 gate and the host runs 0.154.0: under this model
  their checks are keyed by runtime version, 0.154.0 does not list them, so they
  are not eligible — no test of "can 0.154.0 run them" is needed.
- **A task keeps its team.** Snapshots are untouched. At dispatch, a snapshot's
  model that is not eligible at the *current* runtime version is a **waiting**
  job with a reason ("gpt-6.2 is not offered by Codex 0.158.0 — roll back or
  change the team"), never a failed run (survey §2, "a gate, not a failed run").

---

## 5. Data and migrations

Tables, columns and functions; no SQL yet. Each migration follows the repository's
expand/contract habit: add beside, backfill, switch readers, and only then remove.

### 5.1 Model catalog

**`provider_model_catalog` (changed).**
- Identity becomes `(connection_id, provider_id, model_id)`.
  `adapter_version`/`runtime_version` stay as *last seen at*, no longer identity.
- `status` stays, as the maintained projection of `model_eligibility`
  (`verified` ⇔ eligible; `discovered` → shown as "not checked"; `rejected`,
  `unavailable` unchanged; `stale` and `verifying` fall out of use).
- New: `pinned_at`, `last_check_id`, `resolved_model` (Claude alias).

**`model_listings` (new).** `entry_id`, `runtime_type`, `runtime_version`,
`first_seen_at`, `last_seen_at`. Which versions list the model.

**`model_checks` (new; supersedes the verification half of
`model_verification_receipts`, which is kept read-only as history).**
`id`, `entry_id`, `runtime_version`, `adapter_version`, `credential_generation`,
`trigger` (`auto_small_list | in_use | pin | pick | run_failure | ttl |
qualification`), `qualification_id` (when run inside one), `result` (`passed |
rejected | inconclusive | failed`), `failure_class` (`model | infrastructure |
runtime | harness`), `detail` (bounded, redacted), `resolved_model`,
`peak_memory_mb`, `requested_at`, `started_at`, `finished_at`, `retry_after`.
Append-only.

**`provider_connections` (changed).** `credential_generation` bigint, bumped by
every function that stores or replaces a credential and on every return to
`connected`.

**`catalog_gate_allowlist`** — rows migrate to `pinned_at` on their entries; the
table is dropped in the contract step.

**Functions.**
- `model_eligibility(entry_id) → {eligible, reason}` — the one definition of §2.1;
  a trigger keeps `status` in step when a check, a listing, a connection or the
  active runtime version changes.
- `request_model_check(operator, entry, trigger)` — owner-scoped, idempotent per
  `(entry, runtime_version, credential_generation)`, budget-checked (§2.6),
  `NOTIFY`s the lane. Replaces `request_catalog_gate_allowlist` and
  `request_catalog_verification` (kept as wrappers for one release).
- `claim_model_checks(worker, lease)` — priority order, one at a time, admission
  facts in the answer; replaces `claim_catalog_verifications`.
- `complete_model_check` / `defer_model_check` — `defer` for `inconclusive` with
  `retry_after`; replaces `complete_/fail_/defer_catalog_verification`.
- `pin_model` / `unpin_model` (starts a check on pin).
- `search_operator_model_catalog(operator, connection, query, filters, limit ≤ 50)`.
- `get_operator_model_catalog` — reshaped: per connection, in use, pinned, ready,
  and counts; never the whole 299.
- `upsert_catalog_entries` — writes the stable row and a `model_listings` row
  for the version it read; no more `stale` marking.
- `record_run_model_failure(job, class, detail)` — called by the dispatch outcome
  path for model-class failures (P3: one refresh, one re-check, then `rejected`).

**Migration W5-a (expand).** Add the new tables and columns. Backfill: collapse
rows with the same `(connection_id, provider_id, model_id)` into the **one
referenced by project defaults**, else the most recently verified, else the
newest; repoint `project_runtime_defaults.orchestrator_entry_id`,
`project_runtime_default_executors.catalog_entry_id` and
`model_verification_receipts.catalog_entry_id` to it; turn each old verified row
into a `model_checks` row (`trigger = 'legacy'`) at its runtime version; turn
each version seen into a `model_listings` row; allowlist → pins. Superseded rows
are **kept** with `status = 'unavailable'` and a `superseded_by` column, never
deleted (task snapshots are JSON and do not reference them, but audit and
receipts do). The unique index changes last, after the collapse.
*Backward compatibility:* every existing reader keeps working through `status`;
the old functions stay as wrappers. DB tests: every project default resolves
before and after; no eligible model becomes ineligible at the active version;
counts per connection match.

**Migration W5-b (contract, one release later).** Drop the wrappers,
`catalog_gate_allowlist`, and the `stale`/`verifying` values from the status
check. *Done in 0106, with the one-release backfill functions of 0098 and 0099.*

### 5.2 Runtime versions and qualifications

**`runtime_versions` (new).** `runtime_type`, `version` (exact), `published_at`,
`first_seen_at`, `state` (`available | withdrawn | candidate | qualifying |
qualified | refused | active | previous | retired`), `installed_directory`,
`install_digest`, `activated_at`, `activated_by`, `probation_until`,
`probation_runs_left`, `last_qualification_id`, `accepted_unqualified_reason`.
Unique `(runtime_type, version)`. The inventory file stays the host's truth for
*what is on disk*; this table is the panel's and the database's view, written
only by the root CLI through control-plane functions.

**`runtime_qualifications` (new).** `id`, `runtime_type`, `version`,
`adapter_version`, `release_version`, `requested_by`, `started_at`,
`finished_at`, `result` (`passed | failed | inconclusive`), `complete`,
`host_facts` (bounded: kernel, LSMs, the userns sysctl, the AppArmor state of the
bubblewrap profile — facts, never secrets), `summary`, `evidence_digest`.

**`runtime_qualification_checks` (new).** `qualification_id`, `check_key`,
`capability`, `result` (`passed | failed | skipped | inconclusive`),
`failure_class`, `duration_ms`, `detail` (bounded, redacted), `evidence`
(bounded JSON: exit codes, event counts, the model-list diff). Append-only.

**Functions.** `record_runtime_versions_seen(runtime, versions)`,
`begin_runtime_qualification`, `record_qualification_check`,
`finish_runtime_qualification`, `record_runtime_activation(runtime, version,
kind: promote | rollback | install, actor, reason)`,
`runtime_probation_verdict(runtime)` (reads 0071's dispatch records),
`get_operator_runtimes` (the Runtimes card), and `active_runtime_version(runtime)`
used by `model_eligibility`.

*Backward compatibility:* all new. The first `record_runtime_activation` of each
runtime is written by the migration from the inventory's active version (read by
the installer at deploy, the way the release already reconciles it), marked
`source = 'baseline'`.

### 5.3 Code, not tables

- `runtime-adapters.mjs`: `hostRequirements`; OpenCode's `autoUpdate` filled in
  (W1); `installRuntime({ activate })`.
- `runtime.mjs`: `qualify`, `promote`, `rollback`, `watch` commands; inventory
  entries gain `qualification: { id, adapterVersion, passedAt, digest }` per
  installed version.
- `drivers/capabilities.mjs`: `capabilityVerification` reads the inventory's
  qualification as well as the baseline.
- Supervisor: the `qualification` surface (candidate executable by version,
  scratch state home, stub platform sockets) and the background admission rule.
- `catalog-gate-worker.mjs` → the check lane (one call per check, `LISTEN`,
  failure classes); `catalog-refresh-worker.mjs` writes listings.
- `doctor.mjs`: `runtime.host_requirement.*`, `runtime.executable_digest.*`,
  `runtime.qualification.*` (a qualified candidate waiting, a probation running).

---

## 6. Work packages

In delivery order; each one release through the usual flow (build → container
gate → tag → the owner signs → deploy → host acceptance), each with its proof on
the host. W1–W4 are the runtime routine; W5–W7 the catalog; they can interleave
after W2, and W6 is best after M1 (per-run limits).

| # | Package | Proof on the host |
| --- | --- | --- |
| **W1** | **Host facts and self-update.** OpenCode's self-update control established from the pinned tag and written into its configuration; `runtime.executable_digest.*`; `hostRequirements` declared and `runtime.host_requirement.*` reported. No behaviour change. | `doctor`: `runtime.self_update.opencode` passes with its source; digests pass for all three; `bwrap.userns` reported *not met, needed by Codex ≥ 0.155*. |
| **W2** | **Watch.** `runtime_versions`; the daily timer; `watch --check`; the Runtimes card read-only. | The card shows Codex 0.158.0 (and newer) available with publish dates; nothing downloaded (the timer's journal shows metadata requests only). |
| **W3** | **Qualify.** Candidate install without activation; the qualification surface; the suite; evidence tables; the verified pair follows the host. | `qualify codex --version 0.158.0` is **refused** at the prerequisite (or at `read_only.shell` with the panic text) while 0.154.0 keeps serving a task; `qualify codex --version 0.154.0` passes and `doctor` shows *verified (host qualification)*; an OpenCode candidate qualifies or is refused with a named check. |
| **W4** | **Promote, roll back, probation.** `promote` (refuses unqualified), `rollback`, the previous version kept, probation with automatic rollback on runtime-class failures, the state backup. | Promote a qualified OpenCode or Claude candidate while a task is open; the task's next turn resumes on the new version; `rollback` in one command; re-promote. The automatic rollback is proven in the container gate with an injected runtime-class failure (not provoked on the host). |
| **W5** | **Stable catalog identity.** Migrations W5-a (expand, backfill, repoint) and the worker's listings; W5-b one release later. Behaviour visible to the operator: none, except that no rows go stale. | Before/after on the host: every project default resolves, the same models are eligible, counts per connection match; a refresh at the same version changes nothing; `db/tests` for the collapse. |
| **W6** | **Automatic checks.** `model_checks`, the policy of §2.3, the check lane (`LISTEN`, priorities, one call per check, failure classes, budget, Codex quota read), background admission, pins. | After a Claude reconnect the three aliases become ready with no click; a pinned OpenRouter model becomes ready from one click; a check refused by a usage limit shows *waiting*, not *refused* (container proof for the limit; host proof for the rest). |
| **W7** | **The panel.** Models card (in use, pinned, search, Check again), Runtimes card detail, Team's picker with check-on-pick. Lands on whatever version of the Team tab 12.2 has reached (sequenced with the redesign's step 7). | On the host: search the 299, pin one, it is ready without a second action; add a tester on a not-checked Go model — the dialog checks it and adds the member; 375 px and 1440 px checks as the redesign does them. |
| **W8** | **Codex past 0.154.0** — only after the owner's R13 decision is carried out on the host by the owner. `qualify` then `promote` Codex. | The suite passes including `read_only.shell`; promotion; a task where Codex runs `cat` and `git log -1` itself (task `cc37697f`'s turn) succeeds; `gpt-6-sol` and `gpt-6-luna` become ready by themselves. |

---

## 7. Decisions for the owner

| # | Question | Recommendation | Why |
| --- | --- | --- | --- |
| R1 | Model identity | **Stable per `(connection, provider, model)`; checks and listings per runtime version** | A runtime update must not strand teams on stale rows; version-dependence is real (Codex lists per version) and belongs in its own table. |
| R2 | What is checked without a click | **Whole small subscription/free lists (≤ 12), models in use, pinned models, the model being picked.** Large or metered lists only on pin or pick | No two-step job for the operator; no money spent on 299 metered models nobody chose. |
| R3 | When a check expires | **On runtime version change (unless carried forward by the qualification), credential change, delisting, a real model-class failure; a 30-day background re-check for in-use models only** | Expiry follows evidence of change, not the calendar; the TTL is a safety net where it matters. |
| R4 | What a model check is | **One short turn** (`PARITY_OK`); interrupt, resume and streaming move to the runtime qualification | Halves the cost; tests the model for what depends on the model. |
| R5 | Budget | **30 automatic checks per day, 60 in total; Codex checks deferred above 80 % of the primary window** | Bounded, visible, and it protects the subscription the tasks need. |
| R6 | 299 OpenRouter models | **Pins + search; default view shows pinned and in use only** | The operator names what to offer; pinning is the one click that makes it ready. |
| R7 | Team pick of a not-checked model | **The dialog checks and waits (~40 s), adds on pass; no half-added member** | Keeps team functions and "the database decides" unchanged. A `pending` member (Paperclip's limbo) can come later if waiting proves annoying. |
| R8 | Watching upstream | **Hourly registry metadata, no download; a version is offered once published** (was: daily, after 48 h — changed by the owner on 2026-10-01, 0127) | New releases are wanted at once; every qualification still checks the registry signature, and probation still rolls back. `INFRA_COD_RUNTIME_MIN_AGE_HOURS` brings a wait back. |
| R9 | Who qualifies and promotes | **The host qualifies a newer version on its own; Qualify and Promote are buttons in Settings → Runtimes** (0127, after the routine ran twice by hand). A press records a request; `infra-cod-runtime-update.timer` (root, every 5 min) runs it with the CLI's own code. Promoting stays a press; the CLI still works | The web stays unprivileged: it writes a request row, and the root unit decides and acts. Auto-qualify spends subscription calls, so it waits while the runtime's usage is at 80 % or more, and does not retry a version it tried. |
| R10 | Promoting without a passed qualification | **Refused, with an explicit `--accept-unqualified --reason` override, recorded and warned by `doctor`** | The same shape as `--accept-unmanaged-updates`; an emergency exit that is never silent. |
| R11 | Automatic rollback | **Yes, during probation (3 runs or 24 h), only for runtime-class failures** | Those are what the suite checks, so they are unambiguous; model and limit failures never roll a runtime back. |
| R12 | Keeping old versions | **Keep the previous active version until the next promotion has left probation; remove others by command** | One-command rollback needs the tree on disk; disk is finite (Codex ~320 MB compressed). |
| R13 | Codex ≥ 0.155's bubblewrap prerequisite | **(a) Install the distribution's `bubblewrap` and give *that binary only* an AppArmor profile allowing `userns`; keep `kernel.apparmor_restrict_unprivileged_userns=1` for everything else. The owner applies it; W8 follows.** Alternatives: (b) stay on 0.154.0 until Codex offers a namespace-free path again (costs the new models); (c) turn the sysctl off host-wide (**not recommended** — reopens unprivileged user namespaces for every process); (d) run Codex's commands with its sandbox off inside our own Landlock launch, as Claude and OpenCode are (keeps the filesystem read-only, **loses the per-command network block** Codex's seccomp gives today) | (a) is the narrowest change that gives Codex what it asks for; it is a security change to the host, so it is the owner's, and it must be re-checked by `doctor` after every OS upgrade. Whether Codex can be pointed at the system `bwrap` rather than its bundled one is to be read from its source at the candidate's tag in W3. |
| R14 | OpenCode self-update | **Its own config key, proven per version, plus the digest check** (§3.7) | Closes the last `unverified` in `doctor` with evidence, and makes the question harmless even if the key stops working. |
| R15 | Drivers' pinned versions in code | **Keep them as the release baseline; host qualifications extend, never replace them** | The offline container gate needs a fixed pair; the host needs to move without a release. |

---

## 8. Risks

- **A candidate touching the active version's state.** A new Codex or Claude may
  migrate its session store or rotate the login's refresh token. *Mitigation:* the
  scratch state home with a copied credential and an atomic copy-back of a
  refreshed login (§3.2); a state backup before promotion; the copy-back is the
  runtime user's own operation and is tested in W3 with a fake credential. *Left:*
  if a provider invalidates the old refresh token the moment the copy refreshes,
  the active version needs a re-login — detected by the `auth.present` check of the
  *active* version right after the suite, shown in the panel.
- **Cross-version resume.** A session created by the new version may not resume
  after a rollback. *Mitigation:* `session.resume_from_active` proves the forward
  direction; sessions created in probation are marked, and after a rollback start
  fresh with the conversation as context. Stated in §3.4 rather than hidden.
- **The migration of catalog identity (W5).** Repointing project defaults is the
  riskiest data change in the design. *Mitigation:* expand/contract across two
  releases; superseded rows kept; DB tests for "every default resolves" and "no
  eligible model lost"; a dry-run read (`catalog_identity_collapse_preview`) run on
  the host before deploy.
- **Subscription spend and windows.** Automatic checks and suites spend calls on
  the same plans tasks use. *Mitigation:* one call per check, a daily budget, the
  Codex window read, inconclusive-not-rejected for limits, suites only on request.
- **Background runs starving a task.** *Mitigation:* the admission rule keeps room
  for one more task run; one check and one qualification at a time; M1's
  `memory.max` when it lands.
- **A suite that drifts from the real path.** If the qualification surface
  launched runtimes differently from task runs, a pass would mean little. The
  surface must reuse the drivers' launch code with only the executable and the
  state home changed; a test compares the argv and environment of a qualification
  launch with a task launch of the same surface.
- **False confidence from a signature.** The registry signature proves the npm
  registry served the package, not that the vendor's code is sound. The 48 h
  minimum age and the suite are the practical defence; nothing here claims more.
- **The AppArmor change (R13).** Allowing `userns` to one binary widens what that
  binary can do; a later OS upgrade can replace the binary or the profile.
  *Mitigation:* the profile names one path; `doctor` re-checks
  `bwrap.userns` and the binary's package origin every run; the change is the
  owner's, documented in `SECURITY.md` when made.
- **Claude aliases move under us.** An alias can start resolving to a new model
  between checks. *Mitigation:* the resolved model is recorded per check and per
  run; drift is shown and re-checked, never silently accepted as the old model.
- **OpenCode's models.dev cache.** OpenCode fetches model metadata at run time
  (the `.cache` it needs writable), so its list can change without a version
  change. That is the "list changes without a runtime update" path of §4 and
  needs nothing more — but a qualification's `catalog.list` diff will sometimes
  show changes that are not the candidate's doing; the diff is informative, never
  a failure.
- **Scope.** Eight packages is a lot beside 12.1's seven. W1 and W2 are small and
  worth doing early; W3–W4 decide whether Codex's new models are reachable at
  all; W5–W7 can follow M-packages in any order the owner prefers.

---

## Review notes for revision 2 (local session, 2026-09-28)

- **§0 overstates the per-version identity.** On the host, Codex and Claude rows carry an **empty** `runtime_version` and `adapter_version` (7 Codex rows, 3 Claude rows); only OpenCode rows carry `1.18.31`. So a Codex or Claude refresh under a new runtime version does **not** create new rows or mark old ones `stale` — it updates the same rows, and a check made at one Codex version keeps counting at another.
- **The consequence on the host today:** `gpt-6-sol` and `gpt-6-luna`, verified by the 0.158.0 gate, stayed `verified` after the rollback to 0.154.0 and are offered in Team. §4's "the open item closes itself" is true only under the new model (W5–W6). Until then, the local session proposes to return them to `discovered` by hand.
- This strengthens R1 rather than changing it: the W5 backfill must handle rows whose version is empty (attribute their checks to the version active when they were made, from `model_verification_receipts` or the inventory history, else to the baseline).
