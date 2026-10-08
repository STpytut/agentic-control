# Spec Changelog

## 2026-10-08 — delegating after the analyst's answer (rc.139)

- **The turn that brings an analyst's answer may delegate** (migration 0149). rc.136's orchestrator waited for the answer its plan needed, planned in the answer's turn, and was refused: `invoke_delegate_task` took only a conversation turn. A `resume_orchestrator` turn brought by `consultation.answered` or `consultation.failed` now delegates as a conversation turn does; a review's resume still does not.

## 2026-10-08 — role chips, pull request titles, pages rendered in the gate (rc.138)

- **Each agent's role is a chip of its own colour** beside its name in the chat: orchestrator, reviewer, executor, analyst.
- **A pull request is titled by the work, not by the chat's first message**: the orchestrator's last handoff objective, its first sentence, at most 72 characters; the task's title when there is none.
- **The gate renders the panel's pages** (`test:web-render`): a real panel against a scratch database, connected as `infra_web`, signed in as its owner, with a team, a running chat, a reviewed chat and an analyst's answer. The project list, a project's start, both chats, Team, Workspace and the operator's settings must render with their content and no server error. rc.136's crash, a function passed to a client component, fails it with a 500.

## 2026-10-08 — the orchestrator waits for its analyst; runtime marks (rc.136)

- **An answer the plan depends on is waited for.** On rc.135's first consultation the orchestrator read consult's receipt ("asked") as the answer missing, asked again, and delegated before the answer came. The instructions, the tool's description and its receipt (`CONSULT_NEXT`) now say the answer arrives after the turn: consult, end the turn, plan when it arrives. A second ask of the same analyst from the same turn returns the open consultation (migration 0148).
- **Each runtime has its mark in its vendor's colour** beside messages and the live activity (Claude Code, Codex, OpenCode). The activity card names the model as the catalogue does, not by the runtime's id.

## 2026-10-08 — analysts: the first member of an agent team (rc.135, Stage 12)

- **An analyst is a read-only member of a project's team** (migration 0147). The operator adds one on the Team page: a name, instructions and a verified model on Claude Code or OpenCode, which now play the `analyst` role (registry, `runtime_roles`, `ROLE_CORE.analyst`). Analysts live in `project_analysts`, apart from the assignments a task's snapshot reads.
- **The orchestrator asks with `platform.consult({member, question})`**, on a conversation turn or a review. `consultation.requested` becomes a `consultation_run` job. The supervisor's new `consult` surface runs the analyst on a **snapshot of the last commit** (`snapshot.mjs`: regular files of HEAD, written by the supervisor, no symlinks), read-only under the Landlock ruleset, with no shell and no platform tool. The answer goes back through `finish_consultation`, and `consultation.answered` or `consultation.failed` becomes a `resume_orchestrator` turn whose message is the answer. That turn is not a review.
- **The chat shows the question and the analyst's answer**, the answer as the analyst's own message with its model. The orchestrator's instructions list the analysts it may ask. Design: `docs/STAGE_12_ANALYST.md`.

## 2026-10-08 — a repository map for the orchestrator (rc.134)

- **Every new chat starts with a project briefing** (migration 0146). The supervisor builds a map of the workspace's last commit — layout, languages, manifests and their scripts, the start of the README, the instruction files it holds, the latest commits — as the workspace's owner, after every implementation, sync with GitHub and provisioning. A new orchestrator session is told it in its first turn, with the project's check command and what the earlier tasks changed and which pull requests they became. Repository text is fenced as data; `.env` files, binaries and files over 256 KiB are never read.
- **The Workspace page shows the map** the orchestrator is given, and when it was built.

## 2026-10-07 — notifications, approve & open PR, an unread list keeps its models (rc.127–rc.128)

- **Telegram notifications** (migration 0140). The operator's own bot sends a message when a task needs their approval, an agent asks a question, a job stops for good, a pull request opens, or a publish fails. The bot token is stored only as the broker envelope the browser made; a new service, `infra-cod-telegram-notifier`, decrypts it on the VPS.
- **The panel reads the reviewed files** (0139): `infra_web` may read `review_evidence.changed_files`, which the step card lists. The web reads test now checks columns, not only tables.
- **Approve & open PR** (0138). One click approves and asks for the publish; the request is made in the operator's name when the host has prepared the commit, through `request_publish` and all its checks. A refusal leaves the approval standing.
- **A Claude model list that could not be read keeps the models it listed** (0137). A refresh names the sources it did not read; their entries keep their status instead of becoming unavailable.

## 2026-09-26 — vendor, gateway and billing apart (Stage 11.4 A3, ADR-0018)

- **A model has a vendor, a gateway and a billing, as three facts** (migration 0083). The gateway is the path and the party that bills: OpenCode Zen, OpenCode Go, OpenRouter, ChatGPT. The billing is how: free, subscription, direct_metered, third_party_metered. The vendor is the model's author, read off its id where the gateway carries it.
- **OpenCode's provider is chosen by the gateway.** The old boundary words `go`, `external_api` and `chatgpt_subscription` are gone. A previous panel's `go`/`external_api` still names the same gateway at enrollment.

## 2026-09-26 — GitHub and model credentials apart (Stage 11.4 A2, ADR-0018)

- **A connection has a kind**, `scm` (GitHub) or `model_access` (a runtime's credential), derived from its provider (migration 0082).
- **Every row that refers to a connection names the kind it needs.** A GitHub connection cannot be written into the catalog, a refresh or a verification, and a model credential cannot be written as a project's repository connection. The database refuses it, whatever function writes the row.

## 2026-09-26 — roles are permission sets, contract (Stage 11.3 R4)

- **An agent may do what its assignment permits.** Approving and asking for a revision need `review.perform`; being sent an implementation needs `implementation.execute`. Both are asked of the agent's enabled assignments, not of `agents.role` (migration 0081).
- **`agents.role` is history.** It has no CHECK, and project creation no longer writes it. `assignment_role` is the role definition's projection, kept by a trigger for the one-default index; nothing decides on it.

## 2026-09-26 — decisions by permission (Stage 11.3 R3)

- **Workflow functions ask a permission, not a word.** Routing a message, delegating and holding the conversation ask `conversation.hold`. Choosing an implementation's executor and its model asks `implementation.execute` (migration 0080). With the built-ins, every answer is the one it was.
- Questions asked of an agent's own word (`agents.role`) are retired with that column in R4.

## 2026-09-26 — roles are permission sets, expand (Stage 11.3 R2, ADR-0017)

- **An assignment points at a role definition**: a named, versioned set of permissions from a closed vocabulary — `conversation.hold`, `implementation.execute`, `review.perform`, `publish.request`, `completion.required` (migration 0079). The built-ins "Orchestrator" and "Executor" are today's behaviour.
- **The database refuses** a forbidden combination, a change to a built-in, and an assignment whose runtime lacks a capability its permissions need.
- **A task keeps the permissions it was given**, whatever later happens to the definition.
- No routing decision changes: the decisions and events of host-shaped scenarios are identical before and after.

## 2026-09-26 — the executor commits its work (sprint B, B0)

- **The executor is told to commit** exactly the files it changed before its terminal report, and not to push. The platform publishes a commit, never a working tree.
- **A review knows an uncommitted tree is unfinished.** The orchestrator's instructions and the review evidence say that a failed `worktree_committed` means the work is not complete, and a revision asks for the commit.
- **`doctor` names a workspace with an uncommitted seed** (`workspaces.seed_uncommitted`), as a warning, for projects provisioned before rc.48.

## 2026-09-26 — an empty workspace starts committed; defaults follow assignments

- **An empty project's workspace is one commit**, its seeded `AGENTS.md`, by
  `infra-cod`. Left untracked, it was in every first run's tree and in no
  commit, so the first publish of every empty project was refused.
- **A project's default models are of its assignments' runtimes.** The panel
  offers only those, and migration 0078 has `set_project_runtime_defaults`
  refuse another runtime's model where the project has an assignment of that
  role (`runtime_default_not_assigned`).

## 2026-09-26 — OpenRouter as an OpenCode provider (Stage 11.2)

- **An OpenRouter API key runs OpenCode on OpenRouter's models.** It is the
  `external_api` billing boundary 0026 reserved: its own connection beside Go,
  enrolled the same way (encrypted in the browser, decrypted only on the VPS
  broker, never in PostgreSQL). The provider a key signs in to follows from
  the connection's boundary on the VPS, not from anything the browser sends.
- **The catalog offers only models that can call tools**; an orchestrator and
  an executor both work through them. A provider's models keep their names and
  capabilities: they used to be reduced to their ids.

## 2026-09-26 — the vendor's job names retired (Stage 11.2 N6)

- **Three job types, no vendor.** `orchestrator_turn`, `resume_orchestrator`
  and `implementation_run` are the only ones the schema admits; migration 0077
  renames the rows a host still had under `codex_chat_turn`, `resume_codex` and
  `start_implementation`, and no function, trigger or constraint names them.
  Event payloads that recorded a `source_job_type` keep it, as history.

## 2026-09-26 — a project's runtime is the model's (Stage 11.2 N5)

- **Creating a project gives each assignment the runtime of the model picked**
  for it. The panel used to give every catalog project a Codex orchestrator
  and OpenCode executors whatever was picked; with OpenCode picked as the
  orchestrator, its turns would have run Codex with an OpenCode model. The
  registry check refuses a runtime written into the call.
- **An OpenCode turn denies the shell command by command.** Denying the tool
  outright removes it from the request, which OpenCode's free tier refuses
  (403); the turn allows `git status` and refuses every other command. A
  failed turn's error carries the reason OpenCode wrote on stdout.

## 2026-09-26 — OpenCode as an orchestrator (Stage 11.2 N4)

- **A second runtime plays the orchestrator.** OpenCode's project surface is a
  batch run in the conversation's session, granted the workspace read-only and
  held read-only by the kernel: a Landlock ruleset leaves only the runtime's
  own state writable (D5). Its run config denies edits, the shell and fetches.
- **The platform's commands reach a batch runtime as tool files** calling the
  run's socket, answered by the same functions as Codex's dynamic tools, under
  the worker's lease. An orchestrator's socket accepts only them and is not
  spent by an answer; an executor's accepts only its terminal reports.
- **Which runtime runs a turn is the task's assignment**, not the job type:
  both runtimes serve the orchestrator's job types (migration 0076 registers
  the role in the database's mirror).

## 2026-09-26 — neutral workers and units (Stage 11.2 N3)

- **The workers are named for their role.** `infra-cod-orchestrator-worker`
  runs every orchestrator turn and `infra-cod-implementation-worker` every
  implementation; the update retires `infra-cod-codex-chat-worker` and
  `infra-cod-executor-worker`. `doctor` names an `infra-cod*` unit file the
  release does not ship (`systemd.units.stale`).
- **The orchestrator's workflow functions lose the vendor** (migration 0075):
  `claim_orchestrator_jobs`, `orchestrator_job_context`,
  `bind_orchestrator_session`, `complete_orchestrator_job`,
  `invoke_delegate_task`, `invoke_request_revision`.

## 2026-09-25 — selection by role and capability (Stage 11.2 N2)

- **Workflow SQL no longer decides on a runtime's name.** Routing a chat
  message, binding and describing an orchestrator turn, delegation, revision,
  the executor's context and model, project and task creation, follow-ups and
  runtime defaults ask `runtime_plays(runtime, role)` (migration 0074): the
  registry gives the runtime the role, and its driver declares the role's whole
  capability core. The roles, capabilities and cores are a mirror of code the
  gate holds equal to it.
- **An assignment to a role its runtime does not play is refused by the
  database** (`runtime_cannot_play_role`), not only hidden in the panel.
- **What still names a runtime** is identity: session namespaces, credential
  connections (per runtime until 11.4), and the validators that a value is a
  runtime at all. A test lists them and fails on any other.

## 2026-09-25 — neutral job names, expand half (Stage 11.2 N1)

- **Job types no longer name a vendor.** `runtime_jobs.job_type` gains
  `orchestrator_turn`, `resume_orchestrator` and `implementation_run`
  (migration 0073). The router writes only these; every reader, the CHECK,
  the orchestrator-turn trigger and the runtime registry accept the old
  `codex_chat_turn`, `resume_codex` and `start_implementation` beside them, so
  a job queued before the update finishes after it. The old names leave in
  N6, one release after this one reaches the host (decision D3).
- **Deviation from [STAGE_11_PLAN.md](STAGE_11_PLAN.md) §11.2 (decision D2).**
  `runtime_interrupt` and `runtime_input_response` are not jobs: they are
  commands in the active-run mailbox (WP-9a,
  [RUNTIME_CONTRACT.md](RUNTIME_CONTRACT.md) §17). An interrupt addresses a
  running process; as a job it would queue behind the work it is meant to stop.

## 2026-09-24 — a runtime removed during dispatch, and the way back from dead_letter (3.8, C2)

- **A launch asks whether its runtime is still there.**
  [RUNTIME_CONTRACT.md](RUNTIME_CONTRACT.md) §20: `record_runtime_dispatch`
  reads the host's runtime report under a share lock before it records a
  launch, so a launch and a removal are ordered, never interleaved; a runtime
  reported not installed or without a credential is refused by reason, and
  nothing is recorded, spawned or given a socket. A stale or missing report is
  not a refusal at dispatch (task creation already refuses it).
- **A job whose runtime is gone ends, and ends what it holds.** A retry does not
  put it back; its run fails with the reason, the workspace lock is released (or,
  if its lease already ran out, left for reconciliation exactly as the
  reconciler would), grants and unfinished attempts are closed, the task needs
  attention and the conversation says why. Retries that run out end the same
  way.
- **Every dead letter has a reason** from the closed vocabulary
  (`runtime_jobs.failure_reason`).
- **Retry and Dismiss.** The operator can put the same dead-lettered job back,
  once per death and with a fresh attempt budget, reusing its recorded selection
  or superseding it when the runtime moved; or close it with a reason. Both are
  recorded; both are refused by reason when they cannot apply.

## 2026-09-24 — two channels to an agent, a socket per run, provenance (WP-9)

- **A message creates a run; a command goes to one.**
  [RUNTIME_CONTRACT.md](RUNTIME_CONTRACT.md) §17 and
  [ADR-0016](adr/0016-ingress-mailbox-tool-socket-provenance.md): an
  orchestrator message, a handoff and a resume are conversation ingress, ordered
  by `conversation_sequence`, and a job is claimed only when no other run of its
  conversation is live and no earlier entry waits — a message typed during a run
  becomes a run after it. `input_response`, `steer` and `interrupt` are commands
  in the running run's mailbox, idempotent by key, acknowledged only with the
  runtime's native receipt, `outcome_unknown` when the answer never came.
- **A kind a runtime cannot take is refused, never simulated.** A command whose
  capability the run's driver does not declare fails as
  `run_command_unsupported`; it is never turned into a fresh prompt. An answer to
  an executor's question stays interrupt plus native resume.
- **"Stop run" is the driver's declaration.** The button and
  `request_runtime_interrupt` read the capabilities recorded from the driver at
  launch, not `runtime_profiles`, and the interrupt reaches Codex as
  `turn/interrupt` and OpenCode as its process group, each with a receipt.
- **The worker tool socket is per run** (§18), owned by the run's runtime
  account, mode 0600; the shared `worker-tools.sock` of the `opencode-worker`
  group is retired.
- **A job records what was selected, and every launch what ran** (§19): a
  selection written once and reused by retries, superseded — never updated —
  when the runtime moved; an append-only attempt per launch. The panel reads it,
  and `product-data.ts` names no runtime.

## 2026-09-24 — review evidence and the publish boundary (WP-7)

- **A review is of recorded evidence.** [RUNTIME_CONTRACT.md](RUNTIME_CONTRACT.md)
  §16 and [ADR-0015](adr/0015-review-evidence-and-publish-boundary.md): one
  immutable `review_evidence` row per implementation run, with four mandatory
  digests — base commit, head commit, worktree, patch — under canonical,
  versioned algorithms; the executor's reported checks and the platform's
  verified checks as two fields; the run and its fencing token; a bounded diff
  and what was cut.
- **The verdict references the evidence digest**, through one foreign key, for
  Codex's revision request and the operator's approval alike. An approval of an
  implementation without evidence is refused.
- **Publishing in 11.1b is a boundary, not a path** (owner's decision). A
  durable `prepare_publish` recomputes the digests from the workspace and refuses
  a tree or patch that has moved, with a reason from the vocabulary recorded on
  the preparation. The push and the pull request stay manual, from the prepared
  head commit. Exit criterion 5 of the 11.1b plan names exactly this.
- **The orchestrator is no longer told its workspace is read-only.** Codex's
  commands run in a read-only sandbox; the workspace itself is handed to its
  account for the turn, and the grant does not change that.

## 2026-09-24 — the runtime driver (WP-5b)

- **An adapter is a provisioning descriptor and a runtime driver.**
  [RUNTIME_CONTRACT.md](RUNTIME_CONTRACT.md) §15: the driver's seven members,
  its surfaces and how the supervisor carries each (`channel`, `batch`,
  `local_server`), and the protocol-2 requests that name a runtime and a surface
  instead of a vendor method.
- **A capability core per role is mandatory.** A driver without any part of its
  role's core is refused at load; everything beyond the core is an optional
  capability, declared and queryable.
- **Native events are kept beside the normalised ones**, and an event without a
  normalised form is passed on, not dropped.
- **A driver is verified at one exact adapter/runtime pair.** Another runtime
  version is reported as unverified — by `doctor`, the handshake and each launch
  — not refused; §13's block on an unknown major version is unchanged.

## 2026-09-15 — Stage 11.1 accepted in part, and a pre-11.2 substage added

- **11.1's acceptance gate is split rather than waived.** §3 of the stage plan
  said "Nothing below starts before this acceptance is green". Of the three
  items still open, 3.8 gates 11.2 because it is a dispatch property, 3.5 gates
  the publish and review contract, and 3.10 proceeds under a recorded waiver as
  the owner's own step. One gate covering three unrelated claims was blocking
  work that does not depend on them.
- **A pre-11.2 substage exists**, specified in
  [STAGE_11_2_PREWORK.md](STAGE_11_2_PREWORK.md) and planned in
  [STAGE_11_1B_PLAN.md](STAGE_11_1B_PLAN.md). It was added because running 11.1
  on the host found three things that neutral dispatch would multiply by every
  new runtime: a workspace-ownership race that has already fired in production, a
  native session identity that two branches can resume, and review evidence that
  can change between the verdict and the publish.
- **Two contracts are added to the non-negotiable list.** A native session has
  exactly one canonical identity within its namespace — uniqueness is
  `(session_namespace, native_session_id)`, never the opaque id alone.
  Filesystem ownership follows an explicit access grant, and the supervisor
  resolves an opaque grant rather than acting on a mode its client supplied.
- **Host layout is not adapter metadata.** A runtime's Unix user and home belong
  to its adapter descriptor; workspace roots belong to a separate closed
  `INSTALLATION_LAYOUT`, so two descriptors cannot declare different project
  roots.
- **An orchestrator turn is a Run.** The model already said so — "Run: a
  concrete turn / resume / implementation / review" — while only implementation
  runs created `task_runs`, which left an access grant nothing to attach to.
- **Ingress and active-run commands are separate channels.** A new orchestrator
  message or a handoff creates a run and is ordered by conversation sequence; an
  input response, a steer and an interrupt address a running process and are
  ordered by `run_id + sequence`. An adapter that cannot take active input says
  so rather than simulating it with a fresh prompt, which would replace the
  agent's session.
- **Review evidence carries four mandatory digests** — base commit, head commit,
  worktree and patch — because a commit SHA does not describe a dirty workspace;
  and check receipts are split into what the executor reported and what the
  platform verified.
- **An infrastructure gate may not depend on a model's judgement.** Whether a
  reviewer rejects a bad diff is recorded as an experiment. The pass conditions
  are that the evidence was delivered, that the verdict references its digest,
  and that publish refuses a digest that has moved.
- **§3.5 gates nothing and is an experiment.** An earlier wording had it gating
  the publish and review contract while being runnable only after that contract
  exists, which is a cycle. It measures the quality of a real issue-to-PR flow;
  the contract is proven by its own deterministic conditions.
- **An update never drains a live CLI session to proceed.** The maintenance
  fence refuses new launches and reports the active count; it terminates
  nothing, deliberately. A layout migration pauses admission, waits within a
  stated budget and **aborts without touching the layout** if the budget is
  exceeded. Interrupting a running agent is an operator decision, not a step an
  update takes on its own.
- **Provenance is a write-once selection plus append-only attempts.** One
  mutable group of columns loses its history on the first retry, which is
  exactly when "what actually ran" is asked. The selection snapshot is written
  once and reused by every retry; each launch appends its own receipt.
- **An application correlation id is not a `trace_id`.** Field naming follows
  the OpenTelemetry convention where the meaning matches, and
  `correlation_id` keeps its own name until a real tracing context with spans
  and parents exists.
- **The adapter registry is the only *authoritative* registry**, not the only
  place a runtime is named: database CHECK constraints and fixtures legitimately
  name runtimes, and are derived from or checked against the registry. What must
  not exist is a second place that decides.
- **The full defect register for 11.1 is
  [STAGE_11_1_DEFECTS.md](STAGE_11_1_DEFECTS.md)** — 106 defects with how each
  was found. Thirty-nine came from running the product on a real host, in the
  panel or through the task flow, against fifty-five from reading the code.

## 2026-09-13 — Stage 11.0 review: what the first version got wrong

- The deep verifier's own module was left out of the artifact allowlist, so a
  built release could not be installed or updated to at all — its verifier died
  with ERR_MODULE_NOT_FOUND on the acceptance host, where the artifact is the
  only copy of the code there is. `VERIFIER_SCRIPTS` is now compared against the
  import closure of the verifier by a test.
- Rollback safety is decided from the schema boundary actually reached, read at
  the moment of the rollback, not from the decision taken before the migration
  ran. The old form was wrong in both directions: a migration that failed before
  applying anything still demanded a database restore, and a run resumed after an
  incompatible migration had landed found "nothing pending" and offered to start
  the old release on the new schema. An unreadable ledger fails closed.
- Two of the fourteen services — the dispatcher and the reconciler — run from
  `/var/lib/infra-control`, so their working directory names no release. They are
  now proven by re-exec instead: MainPID and start timestamp compared against a
  snapshot taken before the switch, under the same host lock. The harness reads
  each unit's real `WorkingDirectory` rather than giving every process one inside
  the release, which is what hid the divergence.
- `systemctl show` failing for a oneshot is a failure, not a pass. The
  authenticated surface is probed as far as a credential-less command honestly
  can — `/projects` must redirect and the snapshot API must answer 401 — and
  OPERATIONS §22.1 says plainly that this is not a login.
- The pre-update snapshot records the unit contract and the process identities
  the verification is compared against; `rollback` is now its own recovery path,
  finishing an interrupted rollback rather than refusing because `current`
  already looks right; and fault injection covers each mutation inside the
  switch separately.

## 2026-09-13 — Stage 11.0: an update path that proves what is running

- `infra-cod update`, `infra-cod rollback --to` and `infra-cod releases list`
  exist as one coordinator. Re-running the installer is no longer described as
  an update, because it never was one: migrations could run against live
  workers, and `systemctl start` on an active target restarts nothing.
- Success is defined as evidence, not as a status code. Each service is asked
  which release directory its own process is executing in — systemd resolves
  `WorkingDirectory` at exec, so `/proc/<pid>/cwd` is the release — and an
  update that left a process on the old tree fails.
- Every migration now declares whether the previous release can still read the
  schema it leaves behind (`db/schema-compatibility.json`), the release build
  carries that contract in `database.compatibility`, and the verifier recomputes
  it from the shipped declaration. Migrations 0001-0050 predate the contract and
  are recorded as unverified; unknown compatibility is treated as incompatible.
- An application-only rollback is permitted only when that contract says the
  target release can read the current schema. Otherwise the answer is a database
  restore, and the command says so instead of moving a symlink.
- Update and rollback take the installer's own `flock` file, so an installer, an
  update and a rollback cannot believe they are alone at the same time.
- Every state-changing step records its phase before the next one starts, so an
  interrupted run can say where it stopped; `--resume` and `--abandon` decide
  what happens to it.
- `OPERATIONS.md` §22 is the operator-facing contract; §21.4 now points at it.

## 2026-09-13 — Stage 10 accepted; Stage 11 starts with safe live operations

- Stage 10 is accepted on the clean 4 GB Ubuntu VPS: the panel is installed at
  the production domain, HTTPS and login work, and reboot, backup, restore
  drill, and doctor were exercised on the real host.
- Stage 11 now starts with a dedicated production update/rollback/restore
  milestone. Re-running the Stage 10 installer is not treated as an accepted
  live update path: old services can remain active across migrations and a
  `current` symlink rollback cannot undo database changes.
- Runtime provisioning is specified as a supply-chain contract: pinned and
  verified artifacts, root-owned immutable versions, atomic activation,
  explicit state, and health checks under the actual runtime account.
- Agent work is made provider-neutral before adding more vendors: neutral job
  types and an adapter registry replace Codex/OpenCode-specific dispatch
  semantics.
- Runtime adapter, model vendor, access gateway/billing party, and credential
  are separate dimensions. GitHub connections remain a separate integration
  concern.
- Roles become permission-bearing data with database-enforced invariants and
  equivalence-tested backfill before the hard-coded enum is removed.
- The operator console is explicitly a local SSH/TUI surface; privileged host
  operations are not exposed through the public web process.
- Design-system integration may begin immediately in isolated frontend changes
  for tokens, primitives, the responsive shell, accessibility, and visual
  regression coverage. Broad VPS rollout waits for the Stage 11.0
  update/rollback gate; workflow-heavy screens wait for the role/provider
  contracts to settle.
- The release runbook now states the real limitation of the Stage 10 installer
  instead of presenting the same-version install command as a proven update
  mechanism.

## 2026-09-13 — A release runbook, and the one thing blocking the first release

- `OPERATIONS.md` §21: provisioning the signing key once, cutting a release by
  tag, installing on a new host, and updating an existing one.
  `RELEASE_FORMAT.md` §12 already explained why the scheme is shaped the way it
  is; what was missing was the order of operations.
- Written down explicitly because it is the difference between a signature and a
  trustworthy one: `release/release-version.json` has `signing.keyId: null`, and
  while it does, verification accepts any key the artifact was signed with. It
  has to be filled in the same commit that adds the public key, before the first
  tag.
- A tag is not configuration. One release is one tag, and the publish job refuses
  a dirty tree, a tag that is not at HEAD, or a version that disagrees with it.

## 2026-09-13 — Supabase and Vercel out of the living specification

- The runtime stopped depending on Supabase and Vercel at Stage 7; the normative
  documents had not caught up. `PRODUCT_SPEC.md` still listed both as required
  operator access and as shipped integrations, `MVP_SPEC.md` named
  Supabase/Vercel deployment as deferred scope, and `RUNTIME_CONTRACT.md` used
  them as examples of tools the platform layer does not replace. All removed.
- `OPERATIONS.md` told the owner to register a GitHub App against
  `https://infra-cod.vercel.app`, including the OAuth callback. That was not a
  stale phrase but a working instruction to a wrong endpoint: the callback has to
  be the panel's own origin, or GitHub returns the `code` somewhere the CSRF
  check refuses. It now names the installation's domain and says where that value
  comes from.
- Sprint 5.1 in `ROADMAP.md` is marked superseded rather than rewritten: it did
  ship operator identity on Supabase Auth, and Stage 7 replaced it with the local
  Argon2id scheme. Erasing the first half would have made the record false.
- Historical documents and ADRs are untouched by design. `adr/0011` records the
  decision to leave Supabase and Vercel, and a decision record that no longer
  mentions what was decided against is not a record.
- Added `STAGE_11_PLAN.md`. Its order is the point: runtime provisioning first,
  because a fresh host fails the first task with `ENOENT`; then unbinding the
  workflow role from the runtime, because ADR-0009 separated the two in the model
  while 16 sites across 8 migrations still read `runtime_type='codex'`; then
  separating runtime, provider and credential, because the runtime vendor is
  currently also the model provider and `billing_boundary` is a union of two
  vendors' plan names; and only then a third runtime. Claude Code is the
  candidate, through the PoC gate Codex and OpenCode passed.
- Roles are planned as data, not as a widened enum. `agents.role` and
  `project_agent_assignments.assignment_role` are two fixed vocabularies coupled
  by a trigger, and 45 sites read those literals to decide what happens next, so
  adding a role is the same problem as adding a runtime: routing has to key on
  declared permissions rather than on names. Publishing authority becomes a
  permission on a role — ADR-0006's scope, still behind approvals — and the
  change gets its own ADR superseding the role-vocabulary part of ADR-0009.
- Added an operator console to the stage: a terminal front end over the CLI and
  the installer, never a second implementation of either. Its read-only half —
  stack status and unit logs — is useful immediately; update and rollback touch a
  running system and wait for the runtime work to settle.
- Recorded the panel surface this implies: staffing a project becomes explicit
  team setup, its own step or tab, rather than an implicit default.
- Recorded that everything past provisioning waits for the installation to be
  stable. Each of those items is a migration against live data in a system whose
  deployment story started working days ago.

## 2026-09-12 — Stage 2: production PostgreSQL accepted on Ubuntu

- Added idempotent `deploy/setup-postgresql-production.sh`: PostgreSQL
  `17/main:5432`, four passwordless constrained roles, an appliance-owned
  `infra_cod` database, RAM-derived settings, managed HBA/ident drop-ins and the
  three OS peers required to test the boundary before the installer exists.
- The live run caught two assumptions static tests missed. HBA/ident
  `include_dir` operands must not carry `postgresql.conf`-style quotes, and
  `pg_roles.rolpassword` is masked; the converging rerun now repairs the former
  pre-acceptance state and verifies password absence through `pg_authid`.
- Added `deploy/run-production-migrations.sh`. Migration 0038 grants the
  predefined read-only `pg_read_all_data` role to `infra_backup`; the wrapper
  gives `infra_migrator` ADMIN without INHERIT/SET only for the migration window
  and revokes the temporary membership through a trap. A direct production call
  to `migrate.mjs` is no longer documented as the install path.
- Ubuntu 24.04 / PostgreSQL 17.11 passed seven positive peer paths, five negative
  role/runtime/TCP paths, 46 migrations plus a repeat no-op, effective no-DML
  checks for web and backup, and a real encrypted backup restored into isolated
  `17/restore:5433`. After an explicitly approved VPS reboot both clusters
  returned online; the seven positive paths, five refusals, 46-row ledger and
  absence of throwaway restore databases were rechecked. Database acceptance is
  complete; full service acceptance awaits Stage 10.

## 2026-09-12 — Stage 9: review round, and what the first pass got wrong

The first pass was internally consistent and externally wrong in six places. Each
one is recorded here because the pattern matters: a round trip through one
implementation proves self-consistency, not agreement.

- **The minisign key checksum was computed over the wrong bytes and verified on the
  wrong path.** `seckey_compute_chk` hashes `sig_alg` + `keynum` + `sk` (74 bytes,
  read at offsets 0, 54 and 62 of the 158-byte struct), and it is called only from
  `encrypt_key`/`decrypt_key`. For an unencrypted key — what `minisign -G -W`
  writes, and what `release/keys/README.md` tells the owner to create — the checksum
  field is **32 zero bytes** and minisign never looks at it. The implementation
  hashed the 126-byte struct prefix and verified it unconditionally, so a real
  production key was rejected with "checksum does not match". Every test passed
  because generation, parsing, signing and verification all went through the same
  code. Found by building minisign 0.12 from source and running it;
  `release-interop.test.mjs` now runs the real binary in both directions, including
  `minisign -R` and `minisign -S` against a key this module generated, and the
  regression was confirmed by reintroducing the bug and watching two tests fail.
- **The CI workflow could not pass `npm run check`.** It set `PGHOST` and `PGUSER`
  but no `DATABASE_URL`, had no PostgreSQL service, and never created or migrated a
  database. It was not "wired but untested"; it was statically unable to run. Both
  jobs now start `postgres:17`, create `infra_cod_ci`, run `npm run db:migrate`, and
  export `DATABASE_URL`.
- **The candidate job built the artifact twice.** It called `build-release.mjs` and
  then `check-release.mjs`, which builds unconditionally and is guarded against
  overwriting. The driver now has a real verify-existing mode (`--artifact`), and
  reads `INFRA_COD_RELEASE_SKIP_BUILD` for the different question of whether to
  rebuild the web app. Conflating the two was the bug.
- **An off-target build was given a target identity.** The platform check ran only
  for `--publish`, so a Darwin/arm64 build produced `…-linux-x64.tar.gz` whose
  manifest claimed `linux/x64/glibc`. The check is now unconditional, and
  `--allow-off-target` is a diagnostic mode that changes the artifact's *name* and
  `manifest.target` to the host, so the result can never be mistaken for a target
  build. This is why the worked example in `RELEASE_FORMAT.md` is named
  `…-darwin-arm64.tar.gz` and records `darwin/arm64`.
- **The runtime smoke accepted a server that died immediately.** It pattern-matched
  the child's output against a list of known packaging errors, so an empty output or
  an unanticipated `throw` counted as success. It now starts the process
  asynchronously, fails on an early exit whatever it printed, requires a completed
  TCP connection to the port it was told to bind, re-checks that it is still alive
  once listening, and stops it cleanly. A crashing entry point is a negative-control
  test.
- **The offline test did not disable the network.** Removing package managers from
  `PATH` proves only that nothing *invokes* one; `NO_PROXY=*` permits direct
  connections. `scripts/offline-smoke.mjs` now runs the smoke in
  `unshare --net --map-root-user`, asserts that `1.1.1.1:443` is unreachable before
  doing anything else, and exits with a distinct skip code on platforms that cannot
  create a namespace. CI requires it.
- **Publication was not atomic, and `dirty` understated itself.** The tarball was
  renamed into its final name before `SHA256SUMS` and the signature were written, so
  a failure in either left a complete-looking unsigned release; and `git.dirty`
  counted only tracked modifications, so an artifact carrying an untracked runtime
  file could still say `dirty: false`. Every asset is now staged and renamed only
  after the written archive has been re-verified from its own bytes, and `dirty`
  counts untracked files too.
- **`test 0022` and the local database.** The full gate was red on this machine
  because the development database carried a four-hour-old `pending`
  `settings_refresh` row from panel use. `claim_catalog_refresh_work` orders by
  `created_at` across all connections, so an older unrelated job is claimed first and
  the test's assertion fails. A freshly migrated database passes all 31 SQL files.
  The precondition is now stated in `.env.example` rather than left as folklore.

## 2026-09-11 — Stage 9: release artifact, checksums and signature

Status after this entry: `code-complete; VPS acceptance blocked by Stage 2; first
signed RC blocked by the production signing key`.

- **The payload is an allowlist proved by an import closure.** A release is never
  produced by copying the repository and deleting what looks wrong, because that
  order fails in the direction that matters: a stray `.env.local`, a forgotten PEM
  or a fixture with a real token is included by default. The builder names the
  directories and files it will copy, then requires every service file it ships to
  be transitively reachable from an entry point a systemd unit actually starts.
  The check runs both ways, so a file the allowlist names but no import reaches
  and a file that is reachable but outside the allowlist are both build failures.
  This is what keeps `test/`, `run-db-tests.mjs` and future scratch scripts out
  without a per-file exclusion list that has to be maintained forever, and it is
  why the seven omissions are recorded in `manifest.source.omitted` with a reason
  each rather than merely left out.
- **`pnpm deploy` was probed and rejected as acceptance evidence.** During spec
  preparation, `pnpm --offline --filter ai-coding-control-plane deploy --prod
  --legacy` was run on the development machine. It consulted the registry and began
  re-resolving the lockfile despite `--offline`; it was stopped and its temporary
  directory removed. `--offline` is not proof of autonomy, and a dependency graph
  that was re-resolved is not a graph that was verified. The implementation
  therefore materialises the non-web dependencies by following the pnpm store
  links that already exist and refusing to ship any package not reachable from a
  declared production dependency. That produces 15 packages (`pg 8.23.0`,
  `hash-wasm 4.12.0` and their transitive dependencies) that can be checked byte
  for byte, and the pnpm layout it preserves is what makes the tree relocatable.
- **A long symlink target is rewritten or materialised; pax `linkpath` is never
  emitted.** The tar header the writer produces has 100 bytes for a link target,
  and pnpm store keys routinely exceed it because the key encodes the package, its
  version and every peer dependency it resolved. pax has a `linkpath` record for
  exactly this case and it was implemented first: GNU tar extracts such an archive
  correctly, but libarchive 3.7, which is the `tar` on macOS and the reader inside
  some container tooling, places the symlink at a path built from the entry that
  follows it. That was found by extracting a real build and looking at where the
  link landed. The assembler now rewrites the link to a shorter relative path that
  provably resolves to the identical directory, using pnpm's hoisted
  `node_modules/.pnpm/node_modules/<name>` alias, and materialises the directory
  only when no shorter alias exists. Materialising is the fallback because a
  package's own `node_modules` is where its dependencies live and a copy placed
  elsewhere loses the sibling links those dependencies are reached through.
- **Three archive-format defects were invisible to a round-trip test.** Each was
  found by reading the writer against what other tar implementations do, not by a
  failing test in this repository, and the reason is the same in all three cases:
  the project's own reader accepted what the writer produced, so any test that
  wrote and read with the same code stayed green.
  - The tar `linkname` field was written at byte 340 instead of 157. This
    project's reader looked in both places, so every symlink round-tripped; GNU
    tar reads only 157 and turned every symlink into a regular file whose name
    began with its target. Four round-trip tests passed over it.
  - A pax extended header's record length did not count its own decimal digits.
    The failure is order-of-magnitude dependent, so a short record parses and a
    longer one desynchronises; GNU tar rejects the header outright.
  - The pax `linkpath` record described above, which GNU tar and libarchive read
    differently. The fix is structural (the writer refuses to emit the record)
    rather than a test, because there is no single reader behaviour to assert
    against.
- **Node 24.20.0 is pinned because a rebuild with it fixed a real failure.** The
  previous `.next` build, produced under a different Node version, was missing
  `@swc/helpers` entirely and the extracted web server could not start. Rebuilding
  with the pinned Node 24.20.0 produced a payload whose web entry point starts and
  reaches a database error, which is the expected outcome without a database.
  `release/release-version.json` records the exact patch version and the builder
  refuses to run on any other, because Next's native and WASM artifacts, `pg`'s
  optional bindings and Node's own module resolution all vary across majors, and
  "it built on 26" is not evidence about the 24 the plan installs.
- **The production trust root is deliberately absent.** `release/keys/` carries
  the placeholder and the README, not a key. An agent must not mint the production
  signing identity: the private half belongs in a store only the owner controls,
  and generating it in a session would put it in a transcript. Publish builds fail
  closed with an explicit error until the owner provisions the key, PR tests use
  an ephemeral key so the sign, verify and tamper paths are exercised without one,
  and `release/keys/*.key` and `*.minisig` are gitignored.
- **Leftover risks.** Nothing in this stage was built or run on Linux; every
  result is macOS arm64, and `--publish` refuses macOS so only the CI
  `ubuntu-24.04` runner can produce a publishable artifact. The macOS build
  carries `sharp`'s `darwin-arm64` optional binaries, which is exactly why the
  signed artifact must be built on the target platform. `minisign` is not
  installed on the development machine, so the shell gate's signature path was
  exercised through the Node implementation and the tamper tests rather than by
  the binary; it becomes a Stage 10 preflight dependency. Stage 2 is still
  unimplemented, so no unit has been started and the peer matrix has never run,
  and the private-repository distribution question (a client cannot fetch a GitHub
  Release without a token, and the installer must not embed one) is a Stage 10
  blocker rather than a Stage 9 one.

## 2026-09-11 — Stage 7–8 review, fifth round

- **The restore client's executable reached the argv twice.** `clientArgs` passed
  the resolved path to `asUser` as the program and *also* substituted the same path
  for `PROGRAM` inside the argument list, producing
  `psql -U postgres /usr/lib/postgresql/17/bin/psql …`. The client reads that second
  copy as an argument — a database name for `psql` and `createdb`, a stray operand
  for `pg_restore` — so the drill would still not have run. `PROGRAM` is now a
  marker that is removed, and exactly one is required: `asUser` supplies the
  program, and the placeholder never becomes an argument.
  The regression test asserted only that the path appeared and that its first
  occurrence preceded `-U`, which the duplication satisfied; it now asserts the
  exact tail — `executable, -U, role, <first real argument>` — the exact prefix,
  that the executable occurs exactly once, and that `PROGRAM` never reaches the
  argv. Substituting instead of removing fails it.

## 2026-09-11 — Stage 7–8 review, fourth round

- **The final-component symlink check was resolving to a third path.** Keeping the
  symlink's *name* so a separate check could see it was the wrong mechanism: for
  `links/out -> ../targets/actual` it produced `targets/out` — neither the link nor
  the target — and staging created that directory and wrote its marker there. It
  only looked correct while the link and the target happened to share a parent,
  where the wrong formula returns the right name.
  `canonicalPath` now reports the real target and nothing else, and refusing a
  symlinked staging path is a separate `lstat` on the original lexical path, before
  anything is resolved. The cross-directory case is covered, asserting that no
  third directory appears, that the real target is not staged into, and that the
  link still points where it pointed.
- **The restore-client test restated the pairings instead of deriving them.** It
  listed user/command by hand, so swapping `createdb` to the restore account stayed
  green. The identities now live in an exported `CLIENTS` map that the script's
  call sites consume by name, with `PROGRAM` marking where the executable goes; the
  test asserts the argv for each client *and* that every call site names a client
  and places the program through it. Swapping an account, or hand-writing a role at
  a call site, both fail.

## 2026-09-11 — Stage 7–8 review, third round

Two defects, both of the same kind: three individually correct facts that do not
compose.

- **`PGUSER` survived `runuser` and broke the restore drill.** The unit sets
  `PGUSER=infra_control`; the drill's `asUser` used
  `runuser --preserve-environment`; the restore cluster's map grants
  `postgres → postgres` and `infra-control → infra_control`. So the version query,
  `createdb`, the extension install and `dropdb` — all run as the `postgres` OS
  account — requested `infra_control` and would have been refused at the drill's
  first statement. Each invocation now pins its role in both `-U` and `PGUSER` via
  `services/operations/restore-accounts.mjs`, derived from one account map, with an
  unmapped account a hard error. `restore-accounts.test.mjs` asserts the generated
  argv per account and that every `runuser` call in the drill goes through the
  builder; reintroducing the defect fails it.
- **A symlink in an ancestor component bypassed the staging guard.**
  `path.resolve` is lexical and the guard only `lstat`-ed the final component, so
  `alias/.next` — with `alias` a symlink to the protected directory — was accepted
  and the marker was written inside the real `.next`. Comparison now happens on
  canonical paths, with the existing prefix resolved by `realpath` and the missing
  components re-appended, for both the candidate and the protected paths. A
  symlinked ancestor that leads somewhere safe is still allowed, resolved. Three
  cases cover this, including the exact reported reproduction.

## 2026-09-11 — Stage 7–8 review, second round

One new blocking defect and three non-blocking ones.

- **Two clusters' peer maps had been flattened into one.** The previous round
  "unified" the restore role and replaced the production mapping
  `infra-control → infra_worker` with `infra-control → infra_control`. Almost the
  entire control plane runs as `infra-control` and assumes `infra_worker`, so on
  `17/main` every worker would have failed with `Peer authentication failed`; and
  because nothing configured the restore cluster's own peer files, the drill could
  not have authenticated either. `pg_hba.conf` and `pg_ident.conf` belong to a
  *cluster*: production keeps `infra_cod_map` with `infra-control → infra_worker`,
  `infra-web → infra_web`, `infra-cod-github → infra_worker` and three `root` rows
  (`infra_migrator` for DDL and `infra-cod admin`, `infra_worker` for the
  supervisor, `infra_backup` for the backup); `17/restore` gets its own
  `infra_cod_restore_map` with `infra-control → infra_control`.
  `setup-postgresql-17-restore.sh` now writes the restore cluster's `pg_ident.conf`
  and `pg_hba.conf`, reloads it, and verifies through `pg_hba_file_rules` and
  `pg_ident_file_mappings` that the reload took. It never writes into `17/main`.
  The claim that the production admin commands use `infra_control` was wrong and is
  removed — `infra_migrator` owns the schema and runs them.
  Two details of that verification were measured, not assumed: the ident view's
  column is `pg_username`, and `peer map=NAME` appears in `options` as
  `map=NAME`. The mechanism was checked end to end in a throwaway cluster: the
  mapped role is assumed over the socket without a password, an unmapped role is
  refused, TCP is rejected.
- **The staging deletion guard had no regression test.** It now lives in
  `scripts/lib/staging-directory.mjs` with eight cases inside `npm run check`,
  covering every refused path, the marker requirement, a symlink at the staging
  path, and the rerun replacement.
- **`systemd-contract.test.mjs` read scripts from `HEAD`** so that a unit and a
  script could land as separate commits. That made the assertion blind to a
  reverted working tree, which contradicts its purpose; it reads the files
  directly again.
- **The transaction test carried a promise described as a commit signal** that
  resolved before `COMMIT` and was never awaited by the other handler. Removed;
  the lock plus the entry signal are the synchronisation, and the signal is now
  also released from `t.after()` so a failure before the lock reports itself
  instead of timing out.

## 2026-09-11 — Stage 7–8 review fixes

Five blocking defects found in review, all in the boundary between "the files look
right" and "the platform accepts them".

- **systemd never expands a variable in `WorkingDirectory`**, and cannot take one as
  the executable of `ExecStart`. Twelve units used the former and the web unit the
  latter, so the panel would not have started and ten workers would have failed on a
  literal path containing a dollar sign. All paths are now written out; the static
  contract test rejects a variable in the directives systemd does not expand and in
  the first `ExecStart` argument.
- **The target could not stop its timers.** `Wants=` starts them but does not
  propagate a stop, so the backup, health and restore timers survived
  `systemctl stop infra-cod.target` and would fire against a stopped stack. Each
  timer now carries `PartOf=infra-cod.target`, and the test requires it.
- **Backup and restore contradicted the peer model.** The backup dropped to
  `infra-control` for its `pg_dump` while presenting `PGUSER=infra_backup`, which
  would have required mapping an unprivileged worker account to the backup role; it
  now runs in the root process and reaches the database through `root infra_backup`.
  The restore path named three different things — a role `infra_control` nothing
  created, a hyphenated `"infra-control"` role in the setup script, and the
  production `17/main` cluster on the drill's port — and now agrees on the separate
  `17/restore:5433` cluster, `postgresql@17-restore.service` and the restore-only
  role `infra_control`.
- **The origin refusal tests were masked.** Both scenarios set
  `INFRA_COD_INSECURE_COOKIES`, so they aborted on the cookie guard before the origin
  check ran and would have stayed green with the origin check deleted. Worse, the
  underlying check only ran on redirect and CSRF paths, so a production server with
  no origin configured still answered `/login`. The origin is now validated at
  module load — the process refuses to start — and each scenario asserts its own
  diagnostic. Verified by deleting the origin check: the test fails.
- **The staging script could delete almost anything.** `--out` and
  `INFRA_COD_STAGE_DIR` were passed to `rmSync(..., { recursive: true })` unchecked.
  It now refuses the filesystem root, the home directory, the repository, the app
  and build directories and the installed release, refuses any path containing them,
  and refuses a non-empty directory that does not carry the marker this script
  writes. A directory it did create is still replaced on a rerun.

Non-blocking, also fixed: the transaction test armed `statement_timeout` with a
session-level `SET` through the pool, which lands on one pooled connection and left
the other concurrent one without a deadline; each handler now arms `SET LOCAL`
inside its own transaction, with a per-test timeout as the outer diagnostic. The
same test's ordering was racy — `Promise.all` does not decide which handler reaches
its first statement first, and with the second holding the lock the first observed
the second's committed row — so the first handler's commit now signals the second,
in addition to the advisory lock. Eight consecutive runs are green.

## 2026-09-11 — Stages 7–8: self-hosted runtime contour

Status after this entry: `code-complete, VPS acceptance blocked by Stage 2`.

- Finished the Supabase/Vercel removal in executable code: no `@supabase/*`
  dependency in the manifests or the lockfile, no hosted auth routes or client
  creation, no Vercel deployment configuration and no `.vercel/` directory.
  `migrate.mjs` keeps no baseline-import path, so a fresh install and a rerun
  apply migrations through one code path. Historical references remain only in
  comments and in the append-only `0044_drop_supabase_auth.sql`.
- Rewrote the description of the installation in `README.md`,
  `apps/web/README.md`, `docs/OPERATIONS.md`, `docs/SECURITY.md`,
  `docs/ARCHITECTURE.md` and `docs/CURRENT_STATE.md`: local PostgreSQL 17 over
  the Unix socket with peer authentication, the panel as a Next `standalone`
  process on `127.0.0.1:3100`, Caddy as the only published process.
- Replaced `NEXT_PUBLIC_SITE_URL` with runtime-only `INFRA_COD_SITE_URL`. The
  `NEXT_PUBLIC_` prefix marks a value inlined at build time, which would have
  bound one artifact to one domain. Production now refuses to start without an
  explicit `https://` origin instead of falling back to the request's
  `Host`/`X-Forwarded-Host`; the CSRF origin check compares against the configured
  origin only.
- Restructured `.env.example` around the three production env files:
  `database.env` (connection target, no `PGUSER`, no password), root-owned
  `web.env` (pepper and OAuth code key), broker-only `github-app.env`. Removed
  the claim that production holds `DATABASE_URL`/`PGPASSWORD`.
- Removed the contradictory paragraph in ADR-0011 that said `withTransaction` had
  been deleted from the web tier. The single-transaction model is the only one
  described, and it is now covered by `transaction-context.test.mjs`, which tests
  `apps/web/src/lib/database.ts` directly: separate backends for concurrent
  scopes, nested scopes joining the outer transaction, rollback of every
  statement, and post-scope queries returning to the pool. All four fail against a
  copy of the module with the transaction boundary removed.
- Enabled Next.js `standalone` with the monorepo trace root, `pg` as an external
  package, no `X-Powered-By` and no response compression (Caddy owns it). Added
  `scripts/stage-standalone.mjs`, which builds the runtime tree, preserves the
  pnpm symlink layout the standalone server resolves through, copies `public/`
  and `.next/static` beside the entry point, refuses to stage env files or keys,
  rejects escaping symlinks and writes a machine-readable receipt.
- Added `standalone-smoke.test.mjs`: the built tree is started against a
  temporary database and must serve `/login`, redirect anonymous access, complete
  sign-in and the forced password change, serve the static assets the HTML
  references, preserve a session across a restart, exit on SIGTERM with no
  orphan, and refuse to start without a valid `https://` origin or with insecure
  cookies in production — with no package manager on `PATH`.
- Added `deploy/caddy/Caddyfile` (public domain, ACME, HSTS) and
  `deploy/caddy/Caddyfile.local` (plain HTTP, no HSTS) as separate files so the
  mode is readable from the configuration. Caddy forwards to `127.0.0.1:3100`,
  sets the `X-Forwarded-*` headers itself while ignoring client-supplied values,
  bounds the request body, and leaves credentials redacted by default.
- Rewrote the systemd contract: `infra-cod.target` plus `PartOf=` on every
  member, `infra-web` as the panel's OS user, the standalone entry point,
  `PGHOST`/`PGUSER` per unit with no `DATABASE_URL` or `PGPASSWORD`, PostgreSQL
  ordering, stable Node and release paths, and `TimeoutStopSec=20`. The project
  provisioner moved from `codex-poc` to `infra-control` and lost its workspace
  write path. `deploy/systemd/README.md` records the full
  OS-user/role/path/socket/secrets matrix and the `pg_ident.conf` mappings Stage 2
  must provide; `systemd-contract.test.mjs` enforces the parts that can be checked
  without systemd.
- Fixed two test-hermeticity defects that made the SQL suite fail on a database it
  had just migrated: `db/tests/0026` now seeds its own operator instead of
  requiring a committed bootstrap account, and `db/tests/0022` no longer assumes a
  one-row claim returns its own fixture.

## 2026-09-10 — Self-hosted access model (ADR-0011)

- Added `adr/0011-self-hosted-access-model.md` fixing five decisions ahead of
  the self-hosted foundation work: 1:1 Linux-user↔DB-role mapping over peer
  auth, `infra_web` without any DML, privileged filesystem operations confined
  to the Runtime Supervisor's `workspace_operations` channel, PostgreSQL
  cluster naming that follows the Debian package (`17/main:5432` production,
  `17/restore:5433` drill), and the migration numbering order.
- Lifted the `0029`–`0032` reservation. `migrate.mjs` applies files in
  lexicographic order, so a lower-numbered migration released after the
  installed `0037`–`0039` would apply last. `SPRINT_7_2_DESIGN.md:976` still
  records the old reservation and is now the stale document, not the runner: the
  applied history runs to `0050`.
- Added root `check`/`test`/`lint`/`typecheck` aggregates and wired the five
  previously unreferenced node test files; dropped the stale
  `db:migrate:foundation..security` scripts superseded by `migrate.mjs`.

## 2026-08-01 — Full Phase 7 verification

- Added `PHASE_7_VERIFICATION_2026-08-01.md` with the local gate, read-only VPS
  evidence and an explicit 7.1A–7.1F/7.2 status matrix.
- Closed the remaining web lint failures in the Codex/OpenCode connection
  polling effects and exposed the current OpenCode Free connection state.
- Made the launch-admission concurrency fixtures self-cleaning in FK-safe order
  and fixed a flaky wrong-token assertion that matched the real random token
  with probability 1/16.
- Corrected stale `CURRENT_STATE.md` and OpenCode handoff claims: 7.1D/7.1E are
  implemented locally but not deployed; the clean runtime-activity regression
  test is no longer open debt.

## 2026-08-01 — Fifth review round fixed (production gate remains closed)

Addressing the fifth review (launch admission):

- **P0** `PERFORM` removed from the plain-SQL registration transaction in
  `runOpenCode`; lifecycle checks now use `SELECT assert_project_operable(...)`
  (the previous `PERFORM` would have been a syntax error on every launch).
- **P0** Launch admission is now ordered reservation-before-spawn:
  1. `reserve_runtime_launch` locks the project row, validates the exact
     project/job/run/lease binding and returns a one-time token before any
     ownership mutation or child spawn;
  2. `bind_runtime_launch_pid` attaches the spawned PID with token/owner/TTL
     CAS;
  3. `complete_runtime_launch` registers `task_runs.process_ref` and completes
     the reservation under a second project-row lifecycle check;
  4. every setup failure terminates and reaps the child, restores ownership,
     removes the worker capability and only then token-cancels the reservation.
  Deprovision blocks on every live reservation. Expired reservations with a
  bound PID are terminated/reaped before token cancellation; expired unbound
  reservations fail closed for operator reconciliation rather than being
  treated as proof of process absence.
- Added a concurrent integration test (`launch-admission.test.mjs`): a live
  reservation is visible to the deprovision scan, reserve/delete serialize on
  the project row, and DB test 0024 covers reserve/bind/complete/cancel
  lifecycle and fail-closed behavior for deleting projects.
- Fixed clean-environment migration bootstrap: when the application ledger is
  empty after `supabase db reset`, `migrate.mjs` now stamps only the exact
  contiguous baseline recorded by `supabase_migrations.schema_migrations` and
  then executes 0014–0033. Previously it marked all 29 migrations current
  without creating their objects.
- DB concurrency tests now pass `DATABASE_URL` explicitly to `psql`; the
  reserve/delete test uses a transaction advisory marker instead of buffered
  stdout, so its second session is proven to start while the project row lock
  is still held.

## 2026-08-01 — Fourth review round fixed (production gate remains closed)

Addressing the fourth review:

- **P0** Launch admission fence: `getProject` now rejects
  `deleting`/`deletion_failed`/`deleted` (not just `archived`), and the
  `process_ref` registration in `runOpenCode` runs in one transaction with
  `assert_project_operable`, so a project that entered deleting between
  validation and registration cannot spawn a new writer — the transaction
  raises, the child is terminated and ownership is restored. Cleanup's
  filesystem phase therefore has an atomic launch fence, not a TOCTOU window.
- **P0** The final writer scan covers EVERY task_run process ref for the
  project — any run status (a terminal/stale run may still hold a live
  process), no `LIMIT` (the 21st writer is seen too) — and unrecognized
  process-ref formats fail closed. Live Codex app-server channels for the
  project are also closed before removal.
- **P1** The daily gate budget subtracts in-flight (`verifying`) reservations
  in addition to completed receipts, in both `claim_catalog_verifications`
  and `gate_quota_available`; the DB test creates exactly 19 receipt fixtures
  plus one verifying reservation and proves a batch claim gets nothing.

## 2026-08-01 — Third review round fixed (production gate remains closed)

Addressing the third review:

- **P0** The final writer check no longer relies on the pre-grace
  `context.live_runs` snapshot. After SIGTERM/SIGKILL phases and a short reap
  wait, `deprovision_project` performs a fresh DB scan of every active
  task_run's `process_ref` (with a second pass and a final rescan), so a run
  that acquires a PID mid-stop can never slip past the check. The shared
  `assertNoLiveWriters` helper is unit-tested with a writer registered after
  the snapshot.
- **P1** The Codex gate is a full state machine: `thread/start` is pending
  until the app-server response with the matching request id binds the
  thread; a second `thread/start` before the response is rejected;
  `thread/resume` must reference the bound thread exactly; `item/list` also
  validates the bound turn id. `bindCodexGateResponse` only advances state
  for a pending request id (stray/reordered responses are ignored).
- **P1** `claim_catalog_verifications` is batch-safe: per-operator advisory
  locks serialize claims, and eligible entries are ranked and capped to the
  operator's remaining concurrency/daily slots inside the same statement, so
  a single call with a large `p_limit` can never exceed the quota. DB tests
  cover `p_limit=8` with one free slot (claims exactly 1) and the 19/20 daily
  boundary (batch of 2 claims exactly 1).
- **P2** The concurrency test no longer uses `require` in ESM; it resolves
  `psql` via `execFileSync` and runs (not skips) whenever `psql` and
  `DATABASE_URL` are available.

## 2026-08-01 — Second review round fixed (production gate remains closed)

Addressing the second review:

- **P0** Supervisor unit now declares
  `ReadWritePaths=/etc/infra-cod/github-deploy-keys` (deploy keys removable
  under `ProtectSystem=strict`); the directory is guaranteed via
  `deploy/tmpfiles.d/infra-cod-github-deploy-keys.conf` (owner
  root:infra-control 0750).
- **P1** Filesystem checks are fail-closed: only `ENOENT` counts as
  "already removed" for workspace and deploy-key paths; `EACCES`/`EIO` and any
  other error abort cleanup instead of reporting false absence.
- **P1** Worker-first stop is phased: native interrupt requests → bounded
  grace for receipts (no signals) → one SIGTERM pass → separate timeout →
  SIGKILL escalation. Receipts are recorded per phase.
- **P1** Codex gate: `cwd` is rejected in messages (workspace fixed by the
  channel process), and per-channel state binds `threadId`/`turnId` from
  app-server responses so `turn/interrupt`/`item/list` can only reference ids
  created on that channel (stateful validator + tests).
- **P1** Gate quota is serialized per operator with
  `pg_advisory_xact_lock` in `gate_quota_available`; a concurrent DB test
  (two parallel psql sessions) proves claims cannot exceed the concurrency
  limit.
- **P1** Executor fallback is fail-closed: a catalog snapshot with
  provenance that does not cover the handoff assignment resolves to
  `snapshot_mismatch` (supervisor rejects the launch); the first-executor
  fallback applies only to fully legacy provenance-free snapshots.

## 2026-08-01 — 7.1D/7.1E review fixes (production gate remains closed)

Addressing the review of commit `08ba12f`:

- **P0** `assertNoLiveWriter`: probe and result handling separated; the worker
  only proceeds when the process is gone (ESRCH); an alive or EPERM writer
  aborts cleanup. The live-PID case is covered by a new
  `deprovision-safety.test.mjs`.
- **P0** DB-level fail-closed lifecycle guard: `assert_project_operable` plus
  triggers on `tasks`, `domain_events` (chat.user_message /
  implementation.requested), `outbox_messages`, `runtime_jobs` and
  `workspace_operations` reject any new work for deleting/deletion_failed/
  deleted projects; web ownership checks match. The stop path
  (run.interrupt_*) remains open.
- **P0** Capability gate is opt-in: `catalog_gate_allowlist` + owner-scoped
  `request_catalog_verification` set `gate_requested_at`; `claim_catalog_verifications`
  only claims requested, allowlisted entries within `gate_quota_available`
  (2 concurrent, 20 receipts/24h per operator). Discovery never auto-runs a
  smoke; Settings exposes a per-entry “Request gate”.
- **P1** Undo allowed only before the first cleanup claim; `deletion_failed`
  projects offer Retry cleanup only and are never restored to `active`.
- **P1** Supervisor-authenticated stop fallback: `deprovision_project`
  interrupts worker-first, falls back to SIGTERM/SIGKILL with receipts and
  refuses to remove anything while a writer is alive.
- **P1** Filesystem removal moved into the root Supervisor
  (`deprovision_project`) — infra-control never unlinks runtime-owned files;
  deploy-key removal also supervised with containment proof.
- **P1** Gate scratch root is created by the Supervisor with owner
  `root:infra-control` mode `2770`; the gate unit declares
  `ReadWritePaths=/srv/infra-cod-handoff-poc/gate-smoke`.
- **P1** Codex gate transcript parsing matches the proven app-server protocol
  (nested `thread.id`/`turn.id`/`params.turn.items.agentMessage`) with a
  fixture test; `codex-gate-channel.mjs` pins every allowed method and
  parameter shape.
- **P1** Verified-only selectors fail closed: without verified catalog entries
  no legacy `runtime_profiles` are offered for new selection; legacy remains
  only the backfill source for captured snapshots.
- **P1** Executor snapshot entries carry `assignment_ids` provenance; the
  context and supervisor resolvers bind to the exact handoff executor
  assignment, with a two-executor test.
- Integration tests added for deprovision safety (live PID, symlink escape,
  root/glob rejection, ownership) and gate transcript parsing.

## 2026-08-01 — 7.1D/7.1E implementation complete (not yet deployed)

- Implemented `0027_provider_model_catalog.sql` (replaces the intentional
  placeholder): owner-scoped discovered model cache with a strict
  connection/provider/model/adapter-version boundary, statuses
  discovered/verifying/verified/rejected/stale/unavailable, bounded normalized
  metadata (raw provider responses are rejected by a key allowlist), idempotent
  refresh claim/lease, append-only verification receipts and a fail-closed
  availability trigger on provider connections. Rollback-only test 0022.
- Implemented `0028_runtime_selection_snapshots.sql` (replaces the intentional
  placeholder): project runtime defaults and immutable per-task snapshots
  (provider/billing boundary, canonical model, reasoning effort, service tier,
  capabilities, adapter/runtime version, catalog verification identity/time),
  legacy backfill, and snapshot-aware chat/executor context and supervisor
  launch resolution. Rollback-only test 0023.
- Implemented `0033_project_deletion.sql`: deletion lifecycle on `projects`
  (deleting/deletion_failed/deleted, grace timer, bounded failure fields,
  cleanup claim/lease), owner/version-fenced request/undo/approve-delete-now/
  claim/complete/fail/retry functions and a tombstone read model; the row is
  never physically deleted. Rollback-only test 0024.
- Fixed regression `0009_runtime_activity_test.sql` (self-contained fixtures).
- Supervisor protocol: allowlisted Codex `model/list`, OpenCode
  `provider_list` (fixed Free/Go providers, no secrets on reads), and the gate
  smoke operations `open_codex_gate_server` / `run_opencode_gate` under a
  scratch `RUNTIME_GATE_WORKSPACE_ROOT`; OpenCode launch validation now
  resolves the model from the authorized task snapshot.
- New workers with systemd units: `catalog-refresh-worker`,
  `catalog-gate-worker`, `project-deprovision-worker`; health snapshot covers
  catalog state and the new services.
- Web: Settings model catalog (Refresh now, per-connection last check),
  verified-only runtime defaults, project Danger zone (delete/undo/delete
  now/retry), tombstone operations view, and deletion hidden from normal
  navigation.
- Deployment is intentionally NOT executed; the full planned runbook is
  `docs/7_1D_7_1E_SERVER_HANDOFF.md`.

## 2026-08-01 — Safe project deletion added to Sprint 7.1

- Added phase 7.1E before production acceptance (renamed 7.1F): owner-confirmed
  two-phase project deletion with a 24-hour grace/undo window, worker-first
  active-run stop and idempotent workspace/project-key deprovisioning.
- The project row remains an audit tombstone; new work is blocked immediately,
  while terminal `deleted` requires verified filesystem/key cleanup. Partial
  cleanup becomes retryable `deletion_failed` rather than false success.
- Canonical containment and symlink/root guards are mandatory. Remote GitHub
  repositories, provider connections and shared Codex/OpenCode homes are
  explicitly outside the deletion boundary.
- Reserved `0033_project_deletion.sql` to avoid the existing 0029–0032 Sprint
  7.2 migration reservation.

## 2026-08-01 — OpenCode Free/Go connection broker deployed

- Applied migration 0026 in production and deployed the isolated OpenCode
  account worker, Supervisor account channel and Settings UI.
- VPS PoC against OpenCode 1.18.3 showed interactive CLI login cannot consume
  the API key from stdin. The broker uses a short-lived authenticated localhost
  server and `PUT /auth/opencode-go`; status/catalog are structured server reads
  and logout is explicitly scoped to `opencode-go`.
- The broker RSA private key exists only on the VPS; its public key is installed
  in the Vercel production environment. DB test 0021, Supervisor socket smoke,
  web production build and journal/process secret scans passed.
- Remaining acceptance: the owner enters a real Go key in Settings; separately,
  complete the Codex Disconnect/Reconnect drill before final Sprint 7.1 rollout.

## 2026-07-31 — Isolated runtime instances design: third revision after review

- Third review verdict 2026-07-31: PoC-ready after two point fixes and a
  snapshot-contract sync; ADR stays **Proposed**; PoC 1–8 + launch harness are
  allowed, migrations/production code remain closed until receipts.
- P1 harness: `pocs/runtime-instances/harness.mjs` itself `spawn()`s
  `systemd-run --scope --pipe --collect` and owns the JSON-RPC pipes (`--pipe`
  binds stdio to the spawning process; no cross-terminal `attach`); it models
  the Supervisor crash for restart recovery.
- P1 cwd: real working directory is set by `--working-directory` + spawn `cwd`
  (verified via `readlink /proc/<pid>/cwd`); `PWD` env alone does not `chdir`.
- P2 snapshot: `launch_snapshot` now includes `launch_config` and
  `environment_policy` (no separate live columns); `budget_policy` is the single
  source for `MemoryMax`/disk quota/token budgets.
- P2 trigger: per-provider connection 1:1 check serializes on the connection
  row `FOR UPDATE` with a mandatory concurrent DB test.
- No migration, production code or UI is written until the design and PoCs are
  accepted.

## 2026-07-31 — Isolated runtime instances design: second revision after review

- Second review verdict 2026-07-31: architecture ready for PoC-planning;
  three P1 and one P2 closed in v3. `SPRINT_7_2_DESIGN.md` and ADR-0010 stay
  **Proposed** until PoC receipts.
- P1 profile snapshot: frozen `launch_snapshot` per instance
  (model/runtime/adapter/capabilities/env at first `ready`); Supervisor launches
  from it, so edits to the mutable `runtime_profiles` row cannot change a started
  task.
- P1 systemd-run: concrete `systemd-run --scope --pipe --collect` transient
  scope with stdio to Supervisor; new launch-harness PoC (§20.4) for
  initialize/turn/interrupt, signal ownership, unit collection and restart.
- P1 delete: `deleting`/`deprovision_failed`/`deleted` lifecycle with
  `deleted_at` (logical) + `deprovisioned_at` (confirmed cleanup); home/OS
  identity/connection stay reserved until `deprovisioned_at`.
- P2 cardinality: connection→instance 1:1 enforced per-provider by trigger for
  all adapters in 7.2 (Codex permanent); structural 1:N explicitly future.
- PoC 1 now drives app-server through a reproducible JSON-RPC harness
  (`pocs/runtime-instances/harness.mjs`); PoC 6 recalculates guards/reservations
  against the measured overhead (guard moved to <10% / <1.5 GiB).
- No migration, production code or UI is written until the design and PoCs are
  accepted.

## 2026-07-31 — Isolated runtime instances design: revised after review

- Review verdict 2026-07-31: `changes required`; migrations/production code not
  started. Revised `SPRINT_7_2_DESIGN.md` and ADR-0010 (Status: **Proposed**).
- Changes: per-task executor snapshots (`task_executor_snapshots` +
  `tasks.orchestrator_runtime_instance_id`); profile binding immutable after
  `ready`; `create_runtime_instance` creates draft instance + pending connection
  atomically (nullable `provider_connection_id` until ready); separate
  `infra-cod-instance-provisioner` root unit for `useradd`/home (Supervisor keeps
  `ProtectSystem=strict`); worker-first Stop with Supervisor escalation as
  fallback; enforceable limits (transient systemd scopes with cgroup
  `MemoryMax`/`TasksMax`, real project quotas with hard ENOSPC); home/OS identity
  exclusive until soft delete (`deleted_at`); short immutable OS identity
  `icx-<12hex>`; `busy` derived from active jobs instead of stored; capacity
  policy rewritten for ~71% disk / 4.1 GiB free / 7-day journal and backup
  retention; PoC protocol with reproducible commands and evidence template.
- No migration, production code or UI is written until the design and PoCs are
  accepted.

## 2026-07-31 — Isolated runtime instances design proposed

- Recorded the Sprint 7.2 design in
  [SPRINT_7_2_DESIGN.md](SPRINT_7_2_DESIGN.md) and the decision in
  [ADR-0010](adr/0010-runtime-instances.md): named owner-scoped runtime
  instances bind a capability-verified runtime profile to a provider connection
  and a native home; the Runtime Supervisor resolves every launch/session/stop
  by `runtime_instance_id`; one OS user per Codex instance with a home under the
  root-owned `/var/lib/infra-cod/instances/<slug>`.
- Read-only turns stop chowning the project workspace; admission adds
  per-VPS/type/connection/instance/project limits; instance ID becomes a
  snapshot field on tasks, task_runs, agent_sessions and runtime_jobs.
- Defined the migration plan (0029–0032 with a default-instance backfill of the
  current `codex-poc`), supervisor/worker sequence diagrams, threat model,
  capacity policy, UI architecture, increments 7.2A–7.2E, acceptance matrix and
  the mandatory PoCs (two app-servers with separate homes, concurrent read-only
  turns, credential refresh concurrency, independent stop, per-instance
  overhead, home backup/restore, official alternative-provider support).
- No migration, production code or UI is written until the design and PoCs are
  accepted.

## 2026-07-31 — Isolated runtime instances design added to roadmap

- Added Sprint 7.2 as a design-first evolution from runtime profiles to named,
  isolated and lifecycle-managed runtime instances.
- Required separate Codex native homes, instance-bound connections, sessions,
  runs, interrupts, usage and bounded concurrency without weakening the native
  runtime or single-writer contracts.
- Added an architecture assignment covering PoCs, data/state models, Supervisor
  authorization, migration, threat model, capacity policy and production
  acceptance before implementation begins.

## 2026-07-25 — Codex / ChatGPT account connection

- Added an owner-scoped ChatGPT device-code enrollment and Settings
  Connect/Verify/Reconnect/Disconnect lifecycle.
- Added a dedicated Codex account broker and an allowlisted Runtime Supervisor
  channel; ChatGPT credentials remain in the isolated native Codex store.
- Device verification metadata is short-lived and scrubbed after a terminal
  result. Direct API-key/token login and all runtime thread/turn methods are
  rejected by the account channel.
- Production migration, broker service and Vercel Settings surface are deployed.
  The owner completed the real device flow, the broker scrubbed its one-time
  presentation data, and a subsequent live Verify passed without a durable
  failure.
- GitHub App acceptance is complete: private repository project `testik` reached
  `active / ready` through `credential_mode=github_app`.

## 2026-07-21 — Post-MVP provisioning and responsiveness acceptance

- Private GitHub workspace provisioning is now backed by a project-scoped,
  read-only deploy key reference and pinned SSH host identity. The target VPS
  uses GitHub SSH over port 443 because outbound port 22 is unavailable.
- Failed provisioning exposes an audited owner-only retry and a safe diagnostic
  in the project UI; successful setup removes stale error state.
- The web request path removes redundant transaction-control database round
  trips, parallelizes independent read models and uses verified Supabase JWT
  claims for the steady authenticated path.
- Product typography now enforces a readable minimum for essential metadata and
  larger body/control/chat text.

## 2026-07-21 — Project creation receipt fix

- Qualified the created project fields in the multi-CTE web action so the
  orchestrator assignment `id` cannot make the final receipt ambiguous.
- Added a rollback-only regression test for atomic project metadata, default
  agent roster, workspace lock and `project.created` event creation.

## 2026-07-21 — Product completion

- Project chat renders durable input requests, blockers, approvals, review and
  dead-letter recovery as owner-scoped first-class actions.
- Operator forms expose visible labels, busy/status announcements, keyboard
  focus and stacked 44px mobile actions; completion notices are visually distinct.
- Target-VPS quiescent restart returned every runtime service to active with no
  leased jobs or held locks; aggregate health passed after restart.
- The rollback-only security test now proves audited dead-letter incident
  resolution alongside approvals and worker interaction handling.
- Sprint 6.2 and MVP stages 0–6 are complete; optional integrations remain
  explicitly deferred to stage 7+.

## 2026-07-21 — Workspace visibility and guarded recovery

- Project Workspace exposes VPS-observed branch, HEAD/upstream divergence,
  changed paths and bounded diff totals without persisting repository content.
- Latest executor checks are displayed separately from observed Git state and
  retain durable handoff/run provenance.
- Manual ownership restore and stale-lock recovery are queued, audited actions;
  the root Runtime Supervisor verifies operation ownership, job quiescence and
  stale-process absence before filesystem ownership changes.
- Workspace operations can be reclaimed after a supervisor restart, while the
  single active-operation index prevents concurrent recovery for one project.

## 2026-07-21 — Runtime parity closure

- Target-VPS OpenCode server PoC подтвердил authenticated HTTP/SSE, permission
  reply, native abort и active question/reply в одной session.
- Migration 0016 добавляет append-only bounded runtime activity events и
  capability-gated durable interrupt lifecycle.
- Codex `turn/interrupt` и OpenCode isolated process-group termination подключены
  к единому product action; unsupported profiles не получают Stop run.
- Interrupted executor release lock создаёт durable operator response/resume
  record, поэтому intentional stop не попадает в automatic retry loop.

## 2026-07-20 — PostgreSQL 17 backup/restore compatibility

- Backup и restore закреплены на official PGDG PostgreSQL 17 client tools;
  TLS HOME для непривилегированного database user задаётся после `runuser`.
- Encrypted database dump ограничен owned schema `control_plane` и больше не
  включает Supabase-managed schemas или platform roles.
- Manifest format 2 сохраняет source server/client version, counts и checksums.
- Restore drill выполняется в изолированном PostgreSQL 17 cluster на port 5433,
  создаёт только required `pgcrypto`, игнорирует environment-specific owners/ACL
  и по-прежнему сверяет counts, duplicate event versions и concurrent locks.
- Production backup и restore receipts обновлены; health вернулся в `healthy`.

## 2026-07-20 — Production orchestration bridge

- Project-chat Codex threads получили capability-bound dynamic tools для
  initial delegation и constrained revision.
- Tool call привязан к leased job, текущему thread/turn, task orchestrator и
  выбранному task executor assignment; assignment сохраняется в handoff.
- Новый executor worker запускает выбранный OpenCode профиль только через
  Runtime Supervisor и существующий fencing/terminal-report contract.
- Completion/revision events маршрутизируются обратно в тот же native Codex
  task thread как read-only review turn.
- Web `planning` task атомарно получает `task.ready` перед initial delegation.
- Production E2E подтвердил Codex → OpenCode → Codex, отдельные native sessions,
  возврат workspace ownership и отображаемые durable chat/workflow events.

## 2026-07-18 — Live runtime activity telemetry

- Runtime jobs сохраняют phase, detail, start time и отдельный heartbeat timestamp.
- Project chat опрашивает scoped activity endpoint и автоматически обновляет
  durable conversation после появления ответа.
- UI различает task lifecycle, runtime job/run status и agent heartbeat; stalled
  state определяется отсутствием подтверждённого heartbeat, а не длительностью
  ответа самой по себе.
- Зафиксирован [roadmap закрытия остаточного scope этапов 0–6](ROADMAP.md).

## 2026-07-18 — Configurable orchestrator, model и executor roster

- Orchestrator стал project/task role, а не жёстким синонимом Codex.
- Project выбирает default orchestrator runtime profile и executor roster; task
  может переопределить модель orchestrator и подмножество executors.
- Стабильный orchestrator отделён от `active_agent_id`, который обозначает
  только текущего owner этапа.
- Произвольный model ID от клиента запрещён: выбирается только enabled,
  capability-verified RuntimeProfile.
- Publishing authority отделена от orchestration role. На текущем этапе она
  остаётся доступна только одобренному Codex profile с approvals.

## 2026-07-18 — Durable Codex chat delivery

- `chat.user_message` маршрутизируется через transactional outbox в отдельный
  `codex_chat_turn` runtime job.
- Непривилегированный chat worker открывает read-only Codex app-server channel
  через Runtime Supervisor и сохраняет ответ как `chat.agent_message`.
- Native Codex thread закреплён за `project + agent + task_chat:<task_id>`;
  последующие сообщения используют официальный `thread/resume`.
- Очередь сохраняет порядок сообщений внутри task, heartbeat-ит lease и после
  лимита ошибок использует существующий retry/dead-letter механизм.
- На VPS подтверждены два последовательных turn с одним native session ID и
  отображением обоих ответов в Vercel Preview.

## 2026-07-18 — Project-first и chat-first Product UI

- Project закреплён как обязательный родитель для tasks и native sessions.
- Основной рабочей поверхностью project выбран persistent chat с Codex.
- Первое сообщение нового диалога создаёт task; workflow events отображаются в
  разговоре как structured system cards.
- Overview определён как сборная read model остальных project-разделов, а не
  как самостоятельное место выполнения работы.
- Создание project разделено на durable metadata command и VPS filesystem
  provisioning с allowlisted workspace root.

## 2026-07-17 — Privileged Runtime Supervisor boundary

Root-owned filesystem ownership transfer и runtime launch вынесены из E2E/control
plane в отдельный Unix-socket service. Protocol принимает platform IDs и
типизированные операции, но не arbitrary executable/user/path.

На target VPS подтверждены:

- полный Codex → OpenCode → Codex E2E через supervisor;
- DB-backed job/model/project/fencing validation;
- clean runtime environment allowlist;
- `infra-control` socket access и `EACCES` для OpenCode worker;
- запрет `workspace-write` thread через Codex read-only channel;
- systemd capability bounding при сохранённом `NoNewPrivileges`.

## 2026-07-17 — Asynchronous dispatcher and reconciliation

Durable handoff разделён на две очереди: domain outbox и runtime jobs.
`delegate_task` теперь может вернуть accepted receipt до запуска worker; Codex
review инициируется отдельным `resume_codex` job после
`implementation.completed`.

На target VPS подтверждены два независимых Codex turn, heartbeat job/lock,
idempotent routing, dead-letter неоднозначного side effect и reconciliation
истёкшего writer. Dispatcher и reconciler установлены как непривилегированные
systemd services.

## 2026-07-16 — PostgreSQL control-plane foundation

На target VPS подтверждены PostgreSQL-first инварианты и durable handoff:

- mutating commands с immutable idempotency payload/result;
- append-only domain events и transactional outbox;
- dispatcher reservation через lease/`SKIP LOCKED`;
- single-writer workspace lock с монотонным fencing token;
- атомарные `request_implementation`, `start_implementation` и
  `complete_implementation`;
- реальный Codex → PostgreSQL → OpenCode → PostgreSQL → Codex E2E.

Задача после worker completion сохраняется как `awaiting_review`; completion не
является approval. Это подтверждает решения ADR-0002, ADR-0005 и ADR-0007 без
изменения нормативного event contract.

## 2026-07-16 — Codex runtime capability decisions

Target-VPS PoC confirmed `codex exec`, app-server streaming, steering,
interrupts, approvals, structured platform tool callbacks, OpenCode native
session resume, and a real Codex → OpenCode → Codex filesystem handoff.

### Изменено: Platform MCP command path → app-server dynamic tools

Логические control-plane tools сохранены, но для Codex MVP они передаются через
native app-server dynamic tools. Это даёт thread/turn/call correlation и не
требует второго локального процесса только для дублирования command tools.

Handlers остаются transport-independent. MCP сохраняется как опция для read
resources, других runtime surfaces или будущей миграции.

См. [ADR-0008](adr/0008-codex-platform-tool-transport.md).

## 2026-07-14 — Baseline 1.0

Исходное длинное ТЗ преобразовано в комплект нормативных документов и дополнено всеми решениями, принятыми после его фиксации.

### Сохранено без изменения

- Self-hosted VPS как постоянная development environment.
- Единый web UI и будущий Telegram access.
- Codex как architect/planner/reviewer/release manager.
- OpenCode и Antigravity как implementation agents.
- Только Codex имеет publishing authority.
- Native agent runtimes без собственного agent loop.
- Event-driven delegation через structured tools.
- Один общий project workspace и последовательная работа в V1.
- Persistent sessions, resume, streaming, interrupts и input requests.
- Разделение Agent, Runtime, Provider и Model.
- Projects, Tasks, Runs, Events, Locks, Checks, Deployments и Audit как основные сущности.

### Изменено: CLI → capability-complete official interface

Старая упрощённая формулировка «использовать CLI каждого агента» заменена на выбор официального runtime/API/server interface после capability audit.

Причина: Desktop, CLI и server surfaces могут иметь разные возможности. Особенно неопределённа headless parity Antigravity.

Следствие: capability PoC становится этапом 0, а Antigravity — условным scope MVP.

См. [ADR-0001](adr/0001-native-runtime-integration.md).

### Изменено: Context Manager удалён

Предложение управлять cache key, prompt prefix, compaction, project memory и file selection на уровне платформы отменено.

Актуальное решение:

- внутренним контекстом управляет runtime;
- платформа хранит native session IDs;
- платформа выполняет resume;
- платформа передаёт structured handoff;
- платформа показывает только доступную telemetry.

См. [ADR-0003](adr/0003-context-boundary.md).

### Уточнено: provider profiles

- OpenCode Go выбран стартовым provider profile.
- Zen не используется по умолчанию из-за usage-based оплаты.
- Ollama Cloud рассматривается позднее.
- Ни тариф, ни provider не становятся отдельным Agent.
- Цены и лимиты исключены из нормативной архитектуры как изменяемые внешние данные.

См. [ADR-0004](adr/0004-agent-runtime-provider-model.md).

### Усилено: workspace safety

Исходный mutex расширен до durable lease с fencing token, heartbeat и reconciliation. Это закрывает риск старого процесса, продолжающего запись после expiry/restart.

См. [ADR-0002](adr/0002-single-writer-workspace.md).

### Усилено: delivery semantics

Для событий добавлены:

- command/event separation;
- transactional outbox;
- at-least-once delivery;
- idempotency keys;
- workflow versions;
- retry policy;
- dead-letter/`needs_attention`;
- immutable audit trail.

### Усилено: security

Зафиксированы:

- credential references вместо открытых secrets;
- отдельные runtime environments;
- approvals, привязанные к git SHA и target;
- запрет publishing credentials для workers;
- canonical workspace paths;
- защита от stale lock owners;
- недоверенный статус repository/model/tool output.

### Уточнено: single-user V1

V1 явно определён как персональная система. Multi-user tenancy отложен, но actor/owner IDs сохраняются в модели данных.

### Уточнено: PostgreSQL-first

Для V1 выбран PostgreSQL event/outbox/job подход. Kafka, Temporal и другая тяжёлая инфраструктура не используются без измеримой необходимости.

См. [ADR-0007](adr/0007-postgres-first-control-plane.md).

### Изменён порядок реализации

Новый обязательный порядок:

1. capability audit;
2. Codex/OpenCode/Antigravity PoC;
3. runtime foundation;
4. project state и workspace lock;
5. manual handoff vertical slice;
6. structured orchestration;
7. security/recovery;
8. product UI;
9. optional Antigravity/Telegram/providers.

Это снижает риск построить UI и data model вокруг runtime capabilities, которых фактически нет.
