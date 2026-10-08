// The runtimes this installation knows how to provision, as code.
//
// A closed registry, deliberately: nothing here is read from the database, the
// browser or a configuration file, because everything here decides what gets
// executed as a runtime user in a project's workspace. A path or an argv that
// could arrive from outside would make the rest of the contract decorative.
//
// What each adapter has to answer is fixed by ADR-0012:
//
//   * which Unix user runs it, and which home holds its credential state;
//   * how an exact version resolves to a package that actually contains the
//     executable — which, for both runtimes, is *not* the package people install;
//   * what the executable is called once unpacked;
//   * how to ask it its version, and how to ask whether it is authenticated
//     without printing a secret;
//   * how to stop it updating itself.
//
// Since Stage 11.1b (WP-5a) the registry is also the one place that says what
// else knows about a runtime, so a change here is a change everywhere or a test
// names the place it did not reach:
//
//   * `display` — the name the panel shows (apps/web/src/lib/runtime-labels.ts
//     repeats it, and a test compares the two);
//   * `roles` and `dispatch` — which part of a task it plays, which runtime jobs
//     it serves, and the provider connection its credentials are recorded under
//     (the database's CHECK constraints repeat these, compared by a test against
//     the migrated schema);
//   * `units` — the workers that exist only because this runtime does;
//   * `sandboxPaths` — its home and state directories, with their modes, which
//     tmpfiles, the installer, doctor and the units all rely on;
//   * `backup` — what of its state a backup must carry.
//
// Host paths that are not a runtime's own — where workspaces live — are
// platform layout and live in installation-layout.mjs, not here: two
// descriptors must never be able to declare two different project roots.
//
// The platform is not discovered. A release is `linux-x64` by contract, so the
// adapter names the platform build outright rather than choosing one at install
// time from something the host reports.

export const RUNTIME_PLATFORM = "linux-x64";

// The same platform, spelled the way Codex's own vendor tree spells it. Two
// spellings because two ecosystems: npm names the package `…-linux-x64`, and the
// Rust build inside it lays its files out under a target triple.
export const CODEX_VENDOR_TRIPLE = "x86_64-unknown-linux-musl";

// The npm registry is the source of both runtimes. It is used as an HTTP source
// of metadata and tarballs and nothing else — no npm, no npx, no install
// scripts. See ADR-0012 §2.
export const REGISTRY = "https://registry.npmjs.org";

// The registry's own signing key, pinned in the tree rather than fetched.
// Fetching it from the registry that serves the package would let whoever
// replaced the package replace the key that vouches for it.
export const REGISTRY_PUBLIC_KEY = "release/keys/npm-registry.pub";
export const REGISTRY_KEY_ID = "SHA256:DhQ8wR5APBvFHLF/+Tc+AYvPOdTpcIDqOhxsBHRwC7U";

// The permission profile Codex's commands run under from 0.155.0: a built-in
// profile with the login denied, under `~` and under the real home. One `-c`
// value, a TOML inline table.
export const CODEX_READ_ONLY_PROFILE = "infra_cod_read_only";
// A writing run's profile (Stage 12 X2): the workspace writable, the login
// denied the same way, and the network on — an executor installs what it
// builds with (the owner, 2026-09-29), and with the login hidden nothing in
// its shell is the subscription's to send.
export const CODEX_WORKSPACE_PROFILE = "infra_cod_workspace";
// A writing profile also writes `.git` in the workspace: `:workspace` keeps it
// read-only, and an executor commits (0.158.0 on the host: "index.lock:
// Read-only file system" until it was granted).
function codexProfile(name, base, { network = false, gitWrite = false } = {}) {
  const denied = [".codex"].flatMap((relative) => [`~/${relative}`, `/home/codex-worker/${relative}`]);
  const entries = [...(gitWrite ? ['":workspace_roots"={".git"="write"}'] : []), ...denied.map((entry) => `"${entry}"="deny"`)];
  return `permissions.${name}={extends="${base}",filesystem={${entries.join(",")}}${network ? ",network={enabled=true}" : ""}}`;
}

// A writing run's launch configuration (`codex exec`, Stage 12 X2), from the
// version that can hold a deny profile (0.155.0, see configOverrides): a
// 0.154.0 has no way to hide its login from a shell that writes, so it has
// none, and a task is refused on it (drivers/codex.mjs). Its MCP server is the
// platform bridge, whose tools are approved in advance — `approval_policy
// never` refuses an MCP call that asks (0.158.0 on the host) — and which is
// handed only the run's socket variables.
export function codexTaskConfigOverrides(version, { node, bridge }) {
  if (version !== null && !versionInRange(version, ">=0.155.0")) return null;
  const variables = ["INFRA_WORKER_TOOL_SOCKET", "INFRA_WORKER_CAPABILITY", "INFRA_WORKER_RUN_ID", "INFRA_NATIVE_SESSION_ID", "INFRA_BRIDGE_TOOLS"];
  return [
    `default_permissions="${CODEX_WORKSPACE_PROFILE}"`,
    codexProfile(CODEX_WORKSPACE_PROFILE, ":workspace", { network: true, gitWrite: true }),
    'approval_policy="never"',
    `mcp_servers.platform.command=${JSON.stringify(node)}`,
    `mcp_servers.platform.args=[${JSON.stringify(bridge)}]`,
    `mcp_servers.platform.env_vars=[${variables.map((name) => JSON.stringify(name)).join(",")}]`,
    'mcp_servers.platform.default_tools_approval_mode="approve"',
  ];
}

const ADAPTERS = {
  codex: {
    name: "codex",
    // What `runtime install codex` and a new host get (rc.124): the version the
    // author's host qualified in full (rc.110, 2026-10-01) and runs every day. The
    // driver's verified baseline is older, and too old for the newest models.
    recommendedVersion: "0.159.3",
    // The Unix user the supervisor launches it as, and the home that holds its
    // credentials. Both already exist: tmpfiles creates them and the unit
    // contract checks their ownership and mode.
    user: "codex-worker",
    home: "/home/codex-worker",
    credentialState: "/home/codex-worker/.codex",
    // What the model's tools may never read, relative to the home: the login
    // and everything beside it (Stage 12 M0).
    loginState: [".codex"],
    // Everything this runtime must be able to write, as the sandbox has to
    // grant it. Declared here rather than only in the unit, so the unit contract
    // can check the two against each other and a runtime added later brings its
    // own list.
    writableState: ["/home/codex-worker/.codex"],
    executable: "codex",

    display: { label: "Codex" },
    // What one run is expected to take, for the supervisor's memory admission
    // (sprint C K3): an app-server channel and the commands it runs; not yet
    // measured on the host, so on the high side. Every run records its peak.
    memoryEstimateMb: 350,
    // The orchestrator: it plans, delegates and reviews, and never writes the
    // workspace itself (ADR-0013).
    // An executor too since Stage 12 X2 (T6): a task is `codex exec` under a
    // workspace profile that denies ~/.codex (0.155.0 and later only).
    roles: ["orchestrator", "executor"],
    dispatch: {
      // Both vocabularies until 11.2 N6: a job queued under the old name
      // before the update is still this runtime's after it (migration 0073).
      jobTypes: ["orchestrator_turn", "resume_orchestrator", "implementation_run"],
      connectionProvider: "codex",
    },
    // Only what exists because this runtime does. The orchestrator and
    // implementation workers serve whichever runtime plays the role (11.2 N3).
    units: ["infra-cod-codex-account-worker"],
    // Owned by `user`, group `user`. The home is 0750 so the supervisor's group
    // can traverse it; the credential store is the runtime's alone.
    sandboxPaths: [
      { path: "/home/codex-worker", mode: 0o750 },
      { path: "/home/codex-worker/.codex", mode: 0o700 },
    ],
    // Its credentials and its native sessions: losing this directory loses both.
    backup: ["/home/codex-worker/.codex"],

    // `@openai/codex` is a few kilobytes of platform selection; the binary lives
    // in a version of the same package suffixed with the platform. Installing
    // the wrapper would mean installing something whose only job is to pick what
    // we already know.
    packageFor(version) {
      return { name: "@openai/codex", version: `${version}-${RUNTIME_PLATFORM}` };
    },

    // Where the executable sits inside the unpacked tarball.
    //
    // Not `package/bin/codex`, which is what this said until the production host
    // refused the install by name: the platform package carries a whole vendor
    // tree — the binary, `codex-code-mode-host`, `bwrap`, `rg` and a bundled zsh
    // — under a Rust target triple, and the triple is not the npm platform
    // string. `linux-x64` names the package; `x86_64-unknown-linux-musl` names
    // the directory inside it, and it is **musl**, statically linked, which is
    // why it runs on a glibc host at all.
    //
    // Fixed rather than discovered. Searching the archive for something called
    // `codex` would let the package decide what this installation executes, and
    // the point of a closed registry is that it does not.
    executablePath: `package/vendor/${CODEX_VENDOR_TRIPLE}/bin/codex`,

    versionProbe: ["--version"],
    // Asks whether a usable credential exists without printing one. `codex
    // login status` reports the account state and nothing secret — and, checked
    // on the host, exits 1 when there is no account, which is what makes the
    // exit code an answer rather than a formality.
    authProbe: ["login", "status"],
    // Nothing further needed: the exit code is authoritative for this runtime.
    authEvidence: null,

    // Codex checks for updates on startup unless told not to, and the way to
    // tell it is a config setting — not an environment variable.
    //
    // An earlier version of this file passed `CODEX_DISABLE_UPDATE_CHECK=1`,
    // which does not appear anywhere in the pinned release's source. It did
    // nothing, and the test that asserted we passed it proved only that we
    // passed something. `check_for_update_on_startup` is real: it is declared in
    // `codex-rs/config/src/config_toml.rs` at `rust-v0.154.0`, documented as
    // "set to false only if your Codex updates are centrally managed", which is
    // exactly what this installation does.
    // Passed as `-c` on every launch, before the subcommand; app-server applies
    // root overrides (codex-rs/cli/src/main.rs at rust-v0.154.0).
    //
    // Why: Codex's default Linux sandbox is bubblewrap, which unshares a user
    // and a network namespace and brings up loopback inside them. Ubuntu 24.04
    // sets kernel.apparmor_restrict_unprivileged_userns=1, so the namespace is
    // created without capabilities and every sandboxed command Codex ran failed
    // with "RTM_NEWADDR: Operation not permitted" — the orchestrator could not
    // read the workspace it reviews (acceptance, P-2, seen on the host).
    //
    // `features.use_legacy_landlock` selects Codex's own documented fallback:
    // Landlock for the filesystem and a seccomp network filter, applied in
    // process, no namespaces (linux-sandbox/README.md and
    // linux-sandbox/src/linux_run_main.rs at rust-v0.154.0). Read-only stays
    // read-only and the network stays closed; what changes is only the
    // mechanism, to one this kernel allows (landlock is in its LSM list).
    //
    // Only up to 0.154.0. Later versions refuse the legacy path for
    // filesystem-restricted policies ("filesystem-restricted execution requires
    // bubblewrap to isolate app-server sockets", 0.158.0 on the host) and use
    // bubblewrap, which R13's AppArmor profile lets create its namespace; with
    // the flag they cannot run a sandboxed command at all.
    //
    // The model's commands must not read the login beside them (Stage 12 M0,
    // STAGE_12_CREDENTIAL_ISOLATION.md): Codex's read-only sandbox limits
    // writes, not reads, and `cat ~/.codex/auth.json` worked. From 0.155.0 a
    // permission profile denies `loginState` — under `~` (a qualification's
    // scratch home) and under the real home both — and threads carry no
    // `sandbox` of their own, which would replace the profile (0.158.0 on the
    // host: `active: null`). 0.154.0 cannot hold such a profile beside the
    // legacy Landlock flag ("incompatible with --use-legacy-landlock"), so it
    // keeps the read-only mode it always had, set at launch instead.
    configOverrides: [
      { value: "features.use_legacy_landlock=true", versions: "<=0.154.0" },
      { value: 'sandbox_mode="read-only"', versions: "<=0.154.0" },
      { value: `default_permissions="${CODEX_READ_ONLY_PROFILE}"`, versions: ">=0.155.0" },
      { value: codexProfile(CODEX_READ_ONLY_PROFILE, ":read-only"), versions: ">=0.155.0" },
    ],
    configOverridesVerifiedAgainst: "openai/codex rust-v0.154.0 codex-rs/linux-sandbox/README.md, src/linux_run_main.rs; "
      + "0.158.0 on the host: `codex sandbox -- cat` reads and a write is refused without the flag, and panics with it",

    autoUpdate: {
      mechanism: "config-toml",
      file: ".codex/config.toml",
      setting: "check_for_update_on_startup",
      value: false,
      verifiedAgainst: "openai/codex rust-v0.154.0 codex-rs/config/src/config_toml.rs",
    },
    // The Landlock fallback above, up to the version that still accepts it;
    // bubblewrap after it. Found on the host on 2026-09-28: 0.158.0 panicked on
    // every read-only shell command ("filesystem-restricted execution requires
    // bubblewrap"), and was rolled back (STAGE_11_2_ACCEPTANCE.md).
    // What a candidate's scratch home gets (Stage 12 W3): the login and the
    // configuration that holds the update control. Not the sessions: a
    // candidate starts its own, and must not migrate the active version's.
    qualificationState: [".codex/auth.json", ".codex/config.toml"],
    hostRequirements: [
      { requirement: "landlock", versions: "<=0.154.0" },
      { requirement: "bwrap.userns", versions: ">=0.155.0" },
    ],
  },

  opencode: {
    name: "opencode",
    // What `runtime install opencode` and a new host get (rc.124): the version the
    // author's host qualified in full (rc.111, 2026-10-01) and runs every day. The
    // driver's verified baseline is older, and too old for the newest models.
    recommendedVersion: "1.18.34",
    user: "opencode-worker",
    home: "/home/opencode-worker",
    // Configuration lives here; the credential store does not — it is
    // `.local/share/opencode/auth.json`, which is what `authEvidence` below
    // tests. Both are the runtime user's, and neither is ever read by this code.
    credentialState: "/home/opencode-worker/.config/opencode",
    // The login (`auth.json`) and the sessions beside it: hidden from the
    // model's shell by the sandboxed shell launcher (Stage 12 M0).
    loginState: [".local/share/opencode"],
    // Three directories, because OpenCode uses three and found each of them the
    // hard way on the production host:
    //
    //   .local  — the credential store, and the data directory the account
    //             channel points XDG_DATA_HOME at;
    //   .config/opencode — written during boot (a `.gitignore`), which is why a
    //             read-only home made the account server die before it listened;
    //   .cache  — `models.dev` is cached here by a run launched in a workspace,
    //             which takes the general launch path and sets no XDG variables,
    //             so OpenCode uses the default. Without it the executor exits 1
    //             with "Failed to fetch models.dev ... EROFS".
    writableState: [
      "/home/opencode-worker/.local",
      "/home/opencode-worker/.config/opencode",
      "/home/opencode-worker/.cache",
    ],
    executable: "opencode",

    display: { label: "OpenCode" },
    // What one run is expected to take, for the supervisor's memory admission
    // (sprint C K3): a Bun process and its tools — 528 and 563 MB sampled peak
    // for two implementations on the host (rc.66). Every run records its peak.
    memoryEstimateMb: 600,
    // The executor, and since 11.2 N4 an orchestrator too: a turn is a batch
    // run held read-only by the kernel (read-only-launch.mjs). An analyst too
    // (Stage 12, 0147): a read-only batch run on a snapshot.
    roles: ["orchestrator", "executor", "analyst"],
    dispatch: {
      jobTypes: ["orchestrator_turn", "resume_orchestrator", "implementation_run", "consultation_run"],
      connectionProvider: "opencode",
    },
    units: ["infra-cod-opencode-account-worker"],
    sandboxPaths: [
      { path: "/home/opencode-worker", mode: 0o750 },
      { path: "/home/opencode-worker/.local", mode: 0o700 },
      { path: "/home/opencode-worker/.cache", mode: 0o700 },
      { path: "/home/opencode-worker/.cache/opencode", mode: 0o700 },
      { path: "/home/opencode-worker/.config", mode: 0o700 },
      { path: "/home/opencode-worker/.config/opencode", mode: 0o700 },
      // Tool definitions this product installs and the runtime must not rewrite.
      { path: "/home/opencode-worker/.config/opencode/tools", mode: 0o755 },
    ],
    backup: ["/home/opencode-worker/.local/share/opencode"],
    configOverrides: [],
    // The control-plane tools OpenCode loads from its own config directory:
    // shipped in the release at `source`, installed root-owned into `directory`
    // under the home (install-declaration.mjs), mounted read-only for the runtime.
    toolDefinitions: {
      source: "services/runtime-supervisor/opencode-tools",
      directory: ".config/opencode/tools",
    },

    // `opencode-ai` carries a postinstall script. This is the package that
    // carries the binary, and it has no scripts at all — which is why the
    // postinstall never has to be reviewed: it is never run.
    packageFor(version) {
      return { name: `opencode-${RUNTIME_PLATFORM}`, version };
    },

    executablePath: "package/bin/opencode",

    versionProbe: ["--version"],

    // `auth list` exits 0 whether or not a credential exists.
    //
    // Measured on the host: with an empty store it prints "0 credentials" and
    // returns 0, so believing the exit code would have reported an OpenCode with
    // no credential at all as `authenticated` — a green state in the panel, a
    // dispatch the database would admit, and a run that fails the moment it needs
    // to talk to a provider. The whole point of separating `installed` from
    // `authenticated` is to catch exactly that, and the probe silently did not.
    //
    // The probe still runs, because it proves the binary works as its own user
    // with its own home. What decides the answer is evidence:
    authProbe: ["auth", "list"],

    // A credential store with something in it, tested as the runtime user and by
    // exit code alone. The file is never read: a count would be harmless, the
    // contents are not, and `test -s` needs neither.
    //
    // Fails closed by construction. If OpenCode moves this file, the answer
    // becomes "not authenticated" and work is refused — the direction that costs
    // an operator a puzzled minute instead of costing a task its run. Parsing
    // "0 credentials" out of the output would fail the other way the first time
    // the wording changed.
    authEvidence: { path: ".local/share/opencode/auth.json", of: "opencode's credential store" },

    // Established from the source of the pinned tag (Stage 12 W1), not assumed:
    // `upgrade()` returns at once when `config.autoupdate === false` or
    // `Flag.OPENCODE_DISABLE_AUTOUPDATE`, and the flag is `truthy()` — "true" or
    // "1". Until W1 this record said the control was unverified: the variable
    // had been passed since 11.1 without anyone having read where it is used.
    //
    // Only the TUI worker calls `upgrade()`; `run` and `serve`, the two this
    // product launches, never do. `serve` has an explicit upgrade route, which a
    // caller of the loopback server would have to ask for — and the tree it
    // would have to write is root-owned, which the executable's recorded digest
    // (doctor) turns into a finding if it ever changes.
    autoUpdate: {
      mechanism: "environment",
      environment: ["OPENCODE_DISABLE_AUTOUPDATE=true"],
      setting: "OPENCODE_DISABLE_AUTOUPDATE",
      verifiedAgainst: "anomalyco/opencode v1.18.31: packages/opencode/src/cli/upgrade.ts (upgrade() returns on "
        + "Flag.OPENCODE_DISABLE_AUTOUPDATE), packages/core/src/flag/flag.ts (truthy: \"true\" or \"1\"), "
        + "packages/opencode/src/cli/tui/worker.ts (its only caller)",
    },
    // The read-only launch (read-only-launch.mjs) is a Landlock ruleset.
    hostRequirements: [{ requirement: "landlock", versions: "*" }],
    // The whole config directory, not only tools/: the platform's tools import
    // @opencode-ai/plugin from its node_modules (63 MB on the host), and a copy
    // without them left the candidate with no tools in the first host run.
    qualificationState: [".local/share/opencode/auth.json", ".config/opencode"],
  },

  // Claude Code (Stage 11.6, sprint C K2). Everything below was measured by the
  // PoC on the production host (pocs/claude-runtime/RESULTS.md §7), at 2.1.270.
  claude: {
    name: "claude",
    // What `runtime install claude` and a new host get (rc.124): the version the
    // author's host qualified in full (rc.111, 2026-10-01) and runs every day. The
    // driver's verified baseline is older, and too old for the newest models.
    recommendedVersion: "2.1.286",
    user: "claude-worker",
    home: "/home/claude-worker",
    // The login, the sessions (keyed by the workspace path) and the settings.
    credentialState: "/home/claude-worker/.claude",
    loginState: [".claude", ".claude.json"],
    // Two, because Claude Code keeps its account state in a file beside the
    // directory: a run under the read-only launch with exactly these writable
    // passed on the host (probe 08). The file is made by tmpfiles, since
    // systemd cannot mount a path that does not exist.
    writableState: ["/home/claude-worker/.claude", "/home/claude-worker/.claude.json"],
    executable: "claude",

    display: { label: "Claude Code" },
    // What one run is expected to take, for the supervisor's memory admission
    // (sprint C K3): 281–298 MB sampled peak per turn with its MCP bridge on
    // the host (rc.66), ~205 MB without it (PoC probe 09). Every run records its peak.
    memoryEstimateMb: 350,
    // An executor too since Stage 12 X1 (T6). Decision C2 kept it an
    // orchestrator because an executor's shell, running as this user, could read
    // the subscription's credentials (probe 10). Now its Bash runs in the sandbox
    // shell with ~/.claude and ~/.claude.json covered (M0's launcher, via
    // CLAUDE_CODE_SHELL), and its Read is denied them as before (rc.68);
    // qualification proves it with login.isolated on the task surface. An
    // analyst too (Stage 12, 0147): Read, Glob and Grep on a snapshot.
    roles: ["orchestrator", "executor", "analyst"],
    dispatch: {
      jobTypes: ["orchestrator_turn", "resume_orchestrator", "implementation_run", "consultation_run"],
      connectionProvider: "claude",
    },
    // Inside ~/.claude, what the sandbox shell must still reach: Claude Code has
    // every command source the snapshot of its shell's environment it keeps
    // there (Stage 12 X1, on the host).
    shellKeptState: [".claude/shell-snapshots"],
    units: [],
    sandboxPaths: [
      { path: "/home/claude-worker", mode: 0o750 },
      { path: "/home/claude-worker/.claude", mode: 0o700 },
    ],
    // The login and the conversations' sessions.
    backup: ["/home/claude-worker/.claude", "/home/claude-worker/.claude.json"],
    configOverrides: [],

    // `@anthropic-ai/claude-code` carries a postinstall that picks a platform
    // package; this is the platform package, without scripts, signed by the
    // registry key this installation pins (checked for 2.1.270 on the host).
    packageFor(version) {
      return { name: `@anthropic-ai/claude-code-${RUNTIME_PLATFORM}`, version };
    },
    // Where the host's install found it (RESULTS §7): one static binary.
    executablePath: "package/claude",

    versionProbe: ["--version"],
    authProbe: ["auth", "status"],
    // The subscription login's credential file, tested as the runtime user by
    // exit code and never read. `auth status` was not shown to exit non-zero
    // when signed out, so its exit code is not trusted; a missing file fails
    // closed.
    authEvidence: { path: ".claude/.credentials.json", of: "Claude Code's subscription login" },
    // `infra-cod runtime login claude` (decision C3): the runtime's own login,
    // run as its user on the operator's terminal. It prints a URL and reads a
    // code; nothing of it passes through this process.
    login: ["auth", "login"],

    // Not a setting written into a file: the binary checks two environment
    // variables first, and with them `claude update` refused on the host
    // ("Updates are disabled by your administrator", probe 60). Passed on every
    // launch and every probe. The pinned binary is root-owned besides, so the
    // runtime user could not replace it if it tried.
    autoUpdate: {
      mechanism: "environment",
      environment: ["DISABLE_AUTOUPDATER=1", "DISABLE_UPDATES=1"],
      setting: "DISABLE_AUTOUPDATER and DISABLE_UPDATES",
      verifiedAgainst: "Claude Code 2.1.270 on the host: `claude update` refused with both set (pocs/claude-runtime RESULTS §7, probe 60)",
    },
    hostRequirements: [{ requirement: "landlock", versions: "*" }],
    qualificationState: [".claude/.credentials.json", ".claude.json"],
  },
};

// What a runtime needs from the host that the host does not give every process,
// by version (Stage 12 W1, RUNTIMES_AND_MODELS_DESIGN §3.5). Declared so a
// version that needs something this host lacks is reported by `doctor` before
// it is installed, instead of by a task that fails the way Codex 0.158.0 did.
// Nothing here changes the host: meeting a requirement is the owner's decision.
export const HOST_REQUIREMENTS = Object.freeze({
  landlock: Object.freeze({
    label: "Landlock in the kernel's LSM list",
    why: "read-only launches are held read-only by a Landlock ruleset",
  }),
  "bwrap.userns": Object.freeze({
    label: "bubblewrap able to create a user namespace as the runtime user",
    why: "Codex after 0.154 refuses its Landlock fallback for filesystem-restricted policies "
      + "and requires bubblewrap (openai/codex linux-sandbox/README.md at rust-v0.158.0)",
    decision: "R13 in docs/RUNTIMES_AND_MODELS_DESIGN.md",
  }),
});

// Whether an exact version falls in a declared range: "*", ">=x.y.z" or "<=x.y.z".
// The `-c` overrides a launch of this exact version takes. An entry is a string
// (every version) or { value, versions }. A version nobody knows launches as
// the newest would: its "<=" entries are left out. Before Stage 12 M0 it got
// them all; now two of them contradict two others, and the newest's are the
// ones that keep the login from the model — an older binary refuses them and
// fails instead of running with the login readable.
export function configOverridesFor(adapter, version = null) {
  return (adapter.configOverrides ?? [])
    .filter((entry) => typeof entry === "string"
      || (version === null ? !entry.versions.startsWith("<=") : versionInRange(version, entry.versions)))
    .map((entry) => (typeof entry === "string" ? entry : entry.value));
}

export function versionInRange(version, range) {
  if (range === "*") return true;
  const match = /^(>=|<=)(\d+\.\d+\.\d+)$/.exec(range);
  if (!match) throw new Error(`unsupported version range ${JSON.stringify(range)}`);
  const order = compareVersions(version, match[2]);
  return match[1] === ">=" ? order >= 0 : order <= 0;
}

export function compareVersions(left, right) {
  const parts = (value) => value.split(/[.-]/).slice(0, 3).map(Number);
  const [a, b] = [parts(left), parts(right)];
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] < b[index] ? -1 : 1;
  }
  return 0;
}

// The requirements an exact version of a runtime declares.
export function hostRequirementsOf(adapter, version) {
  return (adapter.hostRequirements ?? []).filter((entry) => versionInRange(version, entry.versions));
}

export function adapterFor(name) {
  const adapter = ADAPTERS[name];
  if (name === undefined || name === "") {
    throw new Error(`name a runtime: ${runtimeNames().join(", ")}`);
  }
  if (!adapter) {
    throw new Error(`unknown runtime ${JSON.stringify(name)}; this installation provisions ${runtimeNames().join(", ")}`);
  }
  return adapter;
}

export function runtimeNames() {
  return Object.keys(ADAPTERS);
}

export function allAdapters() {
  return Object.values(ADAPTERS);
}

// Names the database accepts as a runtime type and this installation does not
// provision. The schema was written for three runtimes and the product ships two;
// the third is planned, not installed. Declared here so the comparison with the
// CHECK constraints is exact in both directions: a name the database accepts is
// either an adapter or listed here with its reason, and removing it from here
// without a migration fails that comparison.
// Who owns a project's workspace between runs. A run takes the tree for its
// runtime's user and gives it back to this one when it ends. It was "the
// runtime that plays the orchestrator" while only one did; with a second
// orchestrator (11.2 N4) that is no longer one runtime, so it is said here,
// once. Codex's user, as it has been on every host: its turns open a channel
// in the tree as it rests.
export const WORKSPACE_RESTING_RUNTIME = "codex";

export const RESERVED_RUNTIME_NAMES = Object.freeze({
  antigravity: "planned in PRODUCT_SPEC; accepted by the schema since 0001, never provisioned",
});

// How a runtime's credentials are referenced from the database. The reference
// names the runtime and its Unix user, so moving the user (WP-5c) moves every
// stored reference with it — which is why it is derived, not written down twice.
export function credentialReferenceFor(adapter) {
  return `${adapter.name}-home:${adapter.user}`;
}

// The directories systemd mounts into a unit's namespace for this runtime, in
// the unit contract's shape.
export function sandboxPathsFor(adapter) {
  return adapter.sandboxPaths.map(({ path, mode }) => ({ path, owner: adapter.user, group: adapter.user, mode }));
}

// An exact version, and nothing that could resolve to something else later.
//
// `latest` is refused in every spelling, including "resolve it once and write it
// down": a host whose `runtime list` names a version must be running the version
// the operator named. Ranges are refused for the same reason.
export function assertExactVersion(version) {
  if (typeof version !== "string" || version.length === 0) {
    throw new Error("--version is required, and must be an exact version");
  }
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error(
      `${JSON.stringify(version)} is not an exact version. Ranges, tags and "latest" are refused: `
      + "the version a host reports has to be the version somebody chose.",
    );
  }
  return version;
}
