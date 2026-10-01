// `infra-cod console` — the read-only contract.
//
// The console is the one command an operator will leave open, so what it may
// show and what it may run are pinned here: only allowlisted units, only bounded
// and redacted journal text, never a password or its hash, and never a command
// that changes the host. Every host command goes through an injected runner
// that answers from fixtures and records what was asked, so the last assertion
// — that nothing but `systemctl show` and `journalctl` was ever spawned — is
// checked against the record and not against intent.

import test from "node:test";
import assert from "node:assert/strict";

import {
  ConsoleError,
  DEFAULT_LOG_LINES,
  MAX_LOG_LINES,
  allowlistedUnits,
  boundLines,
  collect,
  credentialsSection,
  logsSection,
  redactLine,
  releasesSection,
  resolveAllowlistedUnit,
  runConsole,
  runtimesSection,
  unitsSection,
} from "../console.mjs";
import { LONG_RUNNING_SERVICES, ONESHOT_SERVICES, POSTGRESQL_UNIT, TIMERS } from "../unit-contract.mjs";

// A runner that answers like a healthy host and remembers every call.
function recordingRunner({ journal = [], failJournal = false } = {}) {
  const calls = [];
  const run = (command, args) => {
    calls.push([command, ...args]);
    if (command === "systemctl" && args[0] === "show") {
      const unit = args.at(-1);
      const oneshot = ONESHOT_SERVICES.some((name) => unit === `${name}.service`);
      const timer = unit.endsWith(".timer");
      const lines = [
        `ActiveState=${oneshot ? "inactive" : "active"}`,
        `SubState=${oneshot ? "dead" : timer ? "waiting" : "running"}`,
        `Result=${oneshot ? "success" : "success"}`,
        "UnitFileState=enabled",
        `MainPID=${oneshot || timer ? 0 : 4242}`,
        "ActiveEnterTimestamp=Sun 2026-09-27 10:00:00 UTC",
        `NextElapseUSecRealtime=${timer ? "Mon 2026-09-28 02:00:00 UTC" : ""}`,
        "LastTriggerUSec=",
      ];
      return { status: 0, stdout: `${lines.join("\n")}\n`, stderr: "" };
    }
    if (command === "journalctl") {
      if (failJournal) return { status: 1, stdout: "", stderr: "No journal files were found." };
      return { status: 0, stdout: journal.map((line) => `${line}\n`).join(""), stderr: "" };
    }
    throw new Error(`the console spawned ${command} ${args.join(" ")}, which no test expected`);
  };
  return { run, calls };
}

const stubDoctor = async () => ({
  exitCode: 0, ok: true, critical: 0, warnings: 0, passed: 1,
  checks: [{ check: "systemd.unit.infra-cod-web", ok: true, severity: "info", message: "active" }],
});

const releaseFixtures = {
  releases: () => [
    { directory: "/opt/infra-cod/releases/0.2.0", name: "0.2.0", version: "0.2.0", channel: "stable", gitSha: "a".repeat(40), latestMigration: "0090", current: false, intact: null, problem: null },
    { directory: "/opt/infra-cod/releases/0.3.0", name: "0.3.0", version: "0.3.0", channel: "stable", gitSha: "b".repeat(40), latestMigration: "0091", current: true, intact: null, problem: null },
  ],
  current: () => "/opt/infra-cod/releases/0.3.0",
  running: () => [
    { unit: "infra-cod-web", pid: 100, directory: "/opt/infra-cod/releases/0.3.0" },
    { unit: "infra-cod-runtime-supervisor", pid: 101, directory: "/opt/infra-cod/releases/0.2.0" },
    { unit: "infra-cod-dispatcher", pid: 102, directory: null },
  ],
  receipts: () => [{ action: "update", from: { version: "0.2.0" }, to: { version: "0.3.0" }, outcome: "succeeded", finishedAt: "2026-09-27T09:00:00Z" }],
  updateState: () => null,
};

const runtimeFixtures = {
  names: () => ["codex", "opencode"],
  inventory: () => ({
    schema: "infra-cod/runtimes/1",
    runtimes: {
      codex: {
        active: { version: "0.50.0", directory: "/opt/infra-cod/runtimes/codex/0.50.0" },
        installed: [
          { version: "0.49.0", directory: "/opt/infra-cod/runtimes/codex/0.49.0", source: "npm", installedAt: "2026-09-01T00:00:00Z" },
          { version: "0.50.0", directory: "/opt/infra-cod/runtimes/codex/0.50.0", source: "npm", installedAt: "2026-09-20T00:00:00Z" },
        ],
      },
    },
  }),
  readiness: (name) => (name === "codex"
    ? { runtime: "codex", version: "0.50.0", installed: true, authenticated: true, authDetail: "the runtime reports a usable credential", selfUpdateManaged: true, selfUpdateNote: null, capabilityVerified: false, ready: false }
    : { runtime: "opencode", installed: false, authenticated: false, capabilityVerified: false, ready: false }),
};

const GENERATED_PASSWORD = "gen-pass-7Qx9v2LmT4wZ";
const PASSWORD_HASH = "$argon2id$v=19$m=65536,t=3,p=4$c2FsdHNhbHQ$Zm9vYmFyYmF6cXV4";

function credentialFixtures({ exists = true, retired = false, mustChange = true } = {}) {
  return {
    fileState: () => ({
      exists, path: "/etc/infra-cod/initial-credentials", error: null,
      symlink: false, regularFile: exists, mode: exists ? 0o600 : null, uid: exists ? 0 : null, gid: exists ? 0 : null, size: exists ? 64 : null,
    }),
    databaseAvailable: () => true,
    // More than the function returns today, on purpose: if a future column ever
    // carried a hash, the assertion below is what would catch it.
    query: async () => ({
      operator_exists: true, username: "owner", must_change_password: mustChange,
      last_login_at: retired ? "2026-09-27T08:00:00Z" : null, password_changed_at: retired ? "2026-09-27T08:05:00Z" : null,
      generated_password_retired: retired, password_hash: PASSWORD_HASH,
    }),
  };
}

// ---------------------------------------------------------------------------
// The allowlist
// ---------------------------------------------------------------------------

test("the allowlist is the unit contract and nothing else", () => {
  const allowed = allowlistedUnits().map(({ unit }) => unit);
  for (const name of LONG_RUNNING_SERVICES) assert.ok(allowed.includes(`${name}.service`), name);
  for (const name of ONESHOT_SERVICES) assert.ok(allowed.includes(`${name}.service`), name);
  for (const name of TIMERS) assert.ok(allowed.includes(`${name}.timer`), name);
  assert.ok(allowed.includes("infra-cod.target"));
  assert.ok(allowed.includes(POSTGRESQL_UNIT));
  assert.equal(allowed.length, LONG_RUNNING_SERVICES.length + ONESHOT_SERVICES.length + TIMERS.length + 2);
});

test("a unit outside the contract is refused by name, with the list", () => {
  for (const name of ["ssh", "ssh.service", "postgresql.service", "infra-cod-web.timer", "../infra-cod-web", "", undefined]) {
    assert.throws(() => resolveAllowlistedUnit(name), ConsoleError, JSON.stringify(name));
  }
  assert.throws(() => resolveAllowlistedUnit("sshd"), /the console reads only: .*infra-cod-web\.service/);
  assert.deepEqual(resolveAllowlistedUnit("infra-cod-web"), { unit: "infra-cod-web.service", kind: "service" });
  assert.deepEqual(resolveAllowlistedUnit("infra-cod-backup"), { unit: "infra-cod-backup.service", kind: "oneshot" });
  assert.deepEqual(resolveAllowlistedUnit("infra-cod-backup.timer"), { unit: "infra-cod-backup.timer", kind: "timer" });
});

test("logs for a unit outside the contract never reach journalctl", () => {
  const { run, calls } = recordingRunner();
  assert.throws(() => logsSection({ unit: "ssh", run }), ConsoleError);
  assert.deepEqual(calls, []);
});

// ---------------------------------------------------------------------------
// Bounds
// ---------------------------------------------------------------------------

test("the line cap keeps the newest lines and journalctl is asked for no more", () => {
  const journal = Array.from({ length: 50 }, (_, index) => `2026-09-27T10:00:${String(index).padStart(2, "0")} host web[1]: line ${index}`);
  const { run, calls } = recordingRunner({ journal });
  const section = logsSection({ unit: "infra-cod-web", lines: 10, run });
  assert.equal(section.lines.length, 10);
  assert.match(section.lines[0], /line 40$/);
  assert.match(section.lines.at(-1), /line 49$/);
  assert.equal(section.truncated, true);
  assert.deepEqual(calls[0], ["journalctl", "-u", "infra-cod-web.service", "-n", "10", "--no-pager", "-o", "short-iso"]);
});

test("the line cap has a ceiling the operator cannot raise", () => {
  const { run, calls } = recordingRunner({ journal: [] });
  const section = logsSection({ unit: "infra-cod-web", lines: 1_000_000, run });
  assert.equal(section.requestedLines, MAX_LOG_LINES);
  assert.equal(calls[0][4], String(MAX_LOG_LINES));
  assert.ok(DEFAULT_LOG_LINES <= MAX_LOG_LINES);
});

test("the byte cap is applied from the end and reported", () => {
  const lines = Array.from({ length: 5 }, (_, index) => `line ${index} ${"x".repeat(100)}`);
  const bounded = boundLines(lines, { maxLines: 100, maxBytes: 250 });
  // Each line is 107 bytes plus its newline: two fit, the third does not.
  assert.deepEqual(bounded.lines.map((line) => line.slice(0, 6)), ["line 3", "line 4"]);
  assert.equal(bounded.truncated, true);
  assert.ok(bounded.bytes <= 250);

  const untouched = boundLines(lines, { maxLines: 100, maxBytes: 10_000 });
  assert.equal(untouched.lines.length, 5);
  assert.equal(untouched.truncated, false);
});

test("logs honour the byte cap through the section", () => {
  const journal = Array.from({ length: 20 }, (_, index) => `line ${index} ${"y".repeat(200)}`);
  const { run } = recordingRunner({ journal });
  const section = logsSection({ unit: "infra-cod-web", lines: 20, maxBytes: 1000, run });
  assert.ok(section.bytes <= 1000);
  assert.ok(section.lines.length < 20);
  assert.equal(section.truncated, true);
  assert.match(section.lines.at(-1), /^line 19 /);
});

test("a journal that cannot be read is an error, not an empty log", () => {
  const { run } = recordingRunner({ failJournal: true });
  assert.throws(() => logsSection({ unit: "infra-cod-web", run }), /journalctl could not read infra-cod-web\.service: No journal files/);
});

// ---------------------------------------------------------------------------
// Redaction
// ---------------------------------------------------------------------------

test("tokens, keys, passwords and e-mail addresses do not survive redaction", () => {
  const jwt = `eyJ${"a".repeat(24)}.${"b".repeat(16)}.${"c".repeat(16)}`;
  const samples = [
    [`Authorization: Bearer ${"t".repeat(40)}`, "t".repeat(40)],
    [`api key sk-${"k".repeat(24)} rejected`, `sk-${"k".repeat(24)}`],
    [`broker minted rk-${"r".repeat(24)}`, `rk-${"r".repeat(24)}`],
    [`session ${jwt} expired`, jwt],
    [`push failed for ghp_${"g".repeat(36)}`, `ghp_${"g".repeat(36)}`],
    [`token github_pat_${"p".repeat(30)}`, `github_pat_${"p".repeat(30)}`],
    ["PGPASSWORD=hunter2-not-really executing psql", "hunter2-not-really"],
    ['{"password":"correct-horse-battery"}', "correct-horse-battery"],
    ["OPENAI_API_KEY=abc123def456 in env", "abc123def456"],
    ["client_secret: verysecretvalue", "verysecretvalue"],
    ["operator owner@example.com signed in", "owner@example.com"],
    ["-----BEGIN RSA PRIVATE KEY-----MIIEow-----END RSA PRIVATE KEY-----", "MIIEow"],
  ];
  for (const [line, secret] of samples) {
    const redacted = redactLine(line);
    assert.ok(!redacted.includes(secret), `${JSON.stringify(line)} -> ${JSON.stringify(redacted)}`);
    assert.match(redacted, /REDACTED/);
  }
});

test("redaction keeps what is not a secret and does not invent a message", () => {
  assert.equal(redactLine(""), "");
  assert.equal(redactLine("2026-09-27T10:00:00+0000 host infra-cod-web[1]: listening on 127.0.0.1:3100"),
    "2026-09-27T10:00:00+0000 host infra-cod-web[1]: listening on 127.0.0.1:3100");
  // A key that appears as a word, not as an assignment, is prose.
  assert.equal(redactLine("the token was refused"), "the token was refused");
  // Control characters cannot reach the terminal.
  assert.ok(!redactLine("a\u001b[31mred\u001b[0m").includes("\u001b"));
});

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

test("the units section reports every allowlisted unit with its systemd state", () => {
  const { run, calls } = recordingRunner();
  const section = unitsSection({ run });
  assert.equal(section.units.length, allowlistedUnits().length);
  assert.equal(calls.length, allowlistedUnits().length);
  for (const call of calls) assert.deepEqual(call.slice(0, 2), ["systemctl", "show"]);

  const web = section.units.find((unit) => unit.unit === "infra-cod-web.service");
  assert.deepEqual(
    { kind: web.kind, activeState: web.activeState, subState: web.subState, pid: web.pid, available: web.available },
    { kind: "service", activeState: "active", subState: "running", pid: 4242, available: true },
  );
  const backup = section.units.find((unit) => unit.unit === "infra-cod-backup.service");
  assert.equal(backup.kind, "oneshot");
  assert.equal(backup.result, "success");
  const timer = section.units.find((unit) => unit.unit === "infra-cod-backup.timer");
  assert.equal(timer.nextElapse, "Mon 2026-09-28 02:00:00 UTC");
  // A finished oneshot is inactive and fine; nothing here needs attention.
  assert.deepEqual(section.attention, []);
});

test("a unit systemd does not know needs attention", () => {
  const run = (command, args) => (args.at(-1) === "infra-cod-web.service"
    ? { status: 4, stdout: "", stderr: "Unit not found" }
    : recordingRunner().run(command, args));
  const section = unitsSection({ run });
  assert.deepEqual(section.attention, ["infra-cod-web.service"]);
});

test("the releases section identifies releases by manifest, not by directory", () => {
  const section = releasesSection(releaseFixtures);
  assert.deepEqual(section.current, { directory: "0.3.0", version: "0.3.0", gitSha: "b".repeat(40) });
  assert.deepEqual(section.installed.map((release) => [release.version, release.gitSha.slice(0, 4), release.current]),
    [["0.2.0", "aaaa", false], ["0.3.0", "bbbb", true]]);
  const supervisor = section.running.find((service) => service.unit === "infra-cod-runtime-supervisor");
  assert.deepEqual(supervisor.running, { directory: "0.2.0", version: "0.2.0", gitSha: "a".repeat(40) });
  assert.equal(supervisor.matchesCurrent, false);
  // The dispatcher runs outside the release tree by design; it is not "wrong".
  const dispatcher = section.running.find((service) => service.unit === "infra-cod-dispatcher");
  assert.equal(dispatcher.running, null);
  assert.equal(dispatcher.matchesCurrent, null);
  assert.deepEqual(section.notCurrent, ["infra-cod-runtime-supervisor"]);
  assert.deepEqual(section.receipts, [{ action: "update", from: "0.2.0", to: "0.3.0", outcome: "succeeded", finishedAt: "2026-09-27T09:00:00Z", unreadable: null }]);
  assert.equal(section.interruptedUpdate, null);
});

test("an interrupted update is reported with its phase", () => {
  const section = releasesSection({
    ...releaseFixtures,
    updateState: () => ({ schema: "infra-cod/update-state/1", phase: "stopped", action: "update", from: { version: "0.3.0" }, to: { version: "0.4.0" }, startedAt: "2026-09-27T11:00:00Z" }),
  });
  assert.deepEqual(section.interruptedUpdate, { action: "update", phase: "stopped", from: "0.3.0", to: "0.4.0", startedAt: "2026-09-27T11:00:00Z" });
});

test("the runtimes section carries readiness and every installed version", () => {
  const section = runtimesSection(runtimeFixtures);
  assert.equal(section.problem, null);
  const [codex, opencode] = section.runtimes;
  assert.equal(codex.installed, true);
  assert.equal(codex.authenticated, true);
  assert.equal(codex.capabilityVerified, false);
  assert.deepEqual(codex.installedVersions.map((installation) => installation.version), ["0.49.0", "0.50.0"]);
  assert.equal(opencode.installed, false);
  assert.deepEqual(opencode.installedVersions, []);
});

test("a corrupt inventory is a problem the section reports, not an empty host", () => {
  const section = runtimesSection({
    ...runtimeFixtures,
    inventory: () => { throw new Error("runtimes.json is not readable JSON"); },
  });
  assert.match(section.problem, /not readable JSON/);
  assert.equal(section.runtimes.length, 2);
});

test("the credentials section says what to do and never what the password is", async () => {
  const live = await credentialsSection(credentialFixtures({ exists: true, retired: false }));
  assert.equal(live.requiresRetirement, true);
  assert.equal(live.retired, false);
  assert.match(live.verdict, /still holds a plaintext password: the operator has not replaced the generated password yet/);
  assert.match(live.command, /infra-cod admin ack-credentials --if-retired$/);

  const stale = await credentialsSection(credentialFixtures({ exists: true, retired: true, mustChange: false }));
  assert.equal(stale.requiresRetirement, true);
  assert.match(stale.verdict, /still on disk although the generated password is retired/);
  assert.equal(stale.command, "infra-cod admin ack-credentials --if-retired");

  const done = await credentialsSection(credentialFixtures({ exists: false, retired: true, mustChange: false }));
  assert.equal(done.requiresRetirement, false);
  assert.equal(done.command, null);

  for (const section of [live, stale, done]) {
    const text = JSON.stringify(section);
    assert.ok(!text.includes(GENERATED_PASSWORD));
    assert.ok(!text.includes(PASSWORD_HASH));
    assert.ok(!text.includes("password_hash"));
    assert.ok(!text.includes("owner"), "the username is not the console's business either");
  }
});

test("an unreadable credentials file is an alarm, and a missing database is said so", async () => {
  const unreadable = await credentialsSection({
    fileState: () => ({ exists: null, path: "/etc/infra-cod/initial-credentials", error: "EACCES", symlink: null, regularFile: null, mode: null, uid: null, gid: null, size: null }),
    databaseAvailable: () => false,
    query: async () => { throw new Error("must not be asked"); },
  });
  assert.equal(unreadable.database, "unavailable");
  assert.equal(unreadable.retired, null);
  assert.match(unreadable.verdict, /cannot tell whether .* exists \(EACCES\)/);
});

// ---------------------------------------------------------------------------
// The command
// ---------------------------------------------------------------------------

function capture() {
  const chunks = [];
  return { stream: { write: (chunk) => { chunks.push(chunk); } }, text: () => chunks.join("") };
}

function allDeps(runner) {
  return { run: runner.run, doctor: stubDoctor, ...releaseFixtures, ...runtimeFixtures, ...credentialFixtures({ exists: true, retired: false }) };
}

test("--json prints one object with a key per section, and the overview has all but logs", async () => {
  const runner = recordingRunner();
  const out = capture();
  const err = capture();
  const code = await runConsole(["--json"], { stdout: out.stream, stderr: err.stream, deps: allDeps(runner) });
  assert.equal(code, 0, err.text());
  const report = JSON.parse(out.text());
  assert.deepEqual(Object.keys(report), ["units", "doctor", "releases", "runtimes", "credentials"]);
  assert.ok(Array.isArray(report.units.units));
  assert.ok(Array.isArray(report.doctor.checks));
  assert.ok(Array.isArray(report.releases.installed));
  assert.ok(Array.isArray(report.runtimes.runtimes));
  assert.equal(typeof report.credentials.verdict, "string");
});

test("each section runs alone, in text and in JSON", async () => {
  for (const section of ["units", "doctor", "releases", "runtimes", "credentials"]) {
    const runner = recordingRunner();
    const json = capture();
    const code = await runConsole([section, "--json"], { stdout: json.stream, stderr: capture().stream, deps: allDeps(runner) });
    assert.equal(code, 0, section);
    assert.deepEqual(Object.keys(JSON.parse(json.text())), [section]);

    const text = capture();
    assert.equal(await runConsole([section], { stdout: text.stream, stderr: capture().stream, deps: allDeps(runner) }), 0);
    assert.match(text.text(), /^infra-cod console — read-only\n/);
    assert.ok(text.text().includes("─".repeat(60)), section);
  }
});

test("logs need a unit, and the unit must be allowlisted", async () => {
  const runner = recordingRunner({ journal: ["2026-09-27T10:00:00+0000 host web[1]: token=abcdef123456 owner@example.com"] });
  const err = capture();
  assert.equal(await runConsole(["logs"], { stdout: capture().stream, stderr: err.stream, deps: allDeps(runner) }), 2);
  assert.match(err.text(), /--unit names which unit/);

  const refused = capture();
  assert.equal(await runConsole(["logs", "--unit", "ssh"], { stdout: capture().stream, stderr: refused.stream, deps: allDeps(runner) }), 2);
  assert.match(refused.text(), /"ssh" is not a unit of this installation/);
  assert.deepEqual(runner.calls, [], "the refusal happened before any command ran");

  const out = capture();
  assert.equal(await runConsole(["logs", "--unit", "infra-cod-web", "--lines", "5", "--json"], { stdout: out.stream, stderr: capture().stream, deps: allDeps(runner) }), 0);
  const { logs } = JSON.parse(out.text());
  assert.equal(logs.unit, "infra-cod-web.service");
  assert.equal(logs.requestedLines, 5);
  assert.equal(logs.redacted, true);
  assert.ok(!out.text().includes("abcdef123456"));
  assert.ok(!out.text().includes("owner@example.com"));
});

test("unknown sections and arguments are usage errors", async () => {
  for (const argv of [["restart"], ["--wat"], ["units", "doctor"], ["logs", "--unit"], ["logs", "--unit", "infra-cod-web", "--lines", "0"]]) {
    const err = capture();
    assert.equal(await runConsole(argv, { stdout: capture().stream, stderr: err.stream, deps: allDeps(recordingRunner()) }), 2, argv.join(" "));
    assert.match(err.text(), /^infra-cod console: /);
  }
});

test("nothing the console runs can change the host", async () => {
  const runner = recordingRunner({ journal: ["a line"] });
  await collect(["units", "doctor", "logs", "releases", "runtimes", "credentials"], {
    options: { unit: "infra-cod-web", lines: 5 },
    deps: allDeps(runner),
  });
  assert.ok(runner.calls.length > 0);
  for (const call of runner.calls) {
    const [command, verb] = call;
    assert.ok(
      (command === "systemctl" && verb === "show") || command === "journalctl",
      `${call.join(" ")} is not a read`,
    );
    assert.ok(!call.some((argument) => /^(start|stop|restart|reload|enable|disable|kill|daemon-reload|vacuum|rotate)$/.test(argument)), call.join(" "));
    assert.notEqual(command, "infra-cod");
  }
});

test("a monotonic timer shows when it last ran, not an empty next run", async () => {
  // The host's health timer is OnUnitActiveSec: NextElapseUSecRealtime is
  // empty, and the view said `next=-` for a timer firing every minute.
  const run = (command, args) => {
    if (command !== "systemctl") throw new Error(`unexpected ${command}`);
    const timer = args.at(-1).endsWith(".timer");
    return { status: 0, stderr: "", stdout: [
      "ActiveState=active", `SubState=${timer ? "waiting" : "running"}`, "Result=success", "UnitFileState=enabled",
      `MainPID=${timer ? 0 : 7}`, "ActiveEnterTimestamp=", "NextElapseUSecRealtime=",
      `LastTriggerUSec=${timer ? "Sun 2026-09-27 11:08:08 UTC" : ""}`,
    ].join("\n") };
  };
  let out = "";
  const code = await runConsole(["units"], { stdout: { write: (chunk) => { out += chunk; } }, stderr: { write: () => {} }, deps: { run } });
  assert.equal(code, 0);
  assert.match(out, /infra-cod-health\.timer\s+timer\s+active \(waiting\)\s+last=Sun 2026-09-27 11:08:08 UTC/);
  assert.doesNotMatch(out, /next=-/);
});

test("as root with no database role named, the console reads as infra_worker; a named one is kept", async () => {
  const { consoleDatabaseRole } = await import("../console.mjs");
  assert.equal(consoleDatabaseRole({}, 0), "infra_worker");
  assert.equal(consoleDatabaseRole({ PGUSER: "infra_migrator" }, 0), null);
  assert.equal(consoleDatabaseRole({ DATABASE_URL: "postgres://x" }, 0), null);
  assert.equal(consoleDatabaseRole({}, 1000), null, "only root is peer-mapped to the product's roles");
});
