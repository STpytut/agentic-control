// `infra-cod admin` — local operator administration.
//
// This is the only supported way to create the first owner, and the only place
// in the codebase that ever holds a generated password in memory.
//
// Rules it has to keep, and how:
//
//   * A password is never accepted through argv. `--password` is rejected by
//     name rather than ignored: a positional argument is visible in `ps` to
//     every account on the host and is written to the shell history.
//   * A password never reaches stdout. When the terminal can be used it is
//     written to /dev/tty directly, which is not stdout and is not redirected
//     by `> log`; otherwise it goes into a 0600 root-owned credentials file and
//     only the path is reported.
//   * A password never reaches the structured receipt. The receipt is meant to
//     be parsed and forwarded, so it carries the username and the file path and
//     nothing else.
//   * Every command writes an audit row naming the OS user that ran it, in the
//     same transaction as the change: `actor=cli:<os user>`. The database cannot
//     see who invoked the process, so a hardcoded actor would make the trail
//     worthless.

import { execFileSync } from "node:child_process";
import { isMain } from "../control-plane/entrypoint.mjs";
import { randomInt, randomUUID } from "node:crypto";
import { closeSync, openSync, writeSync } from "node:fs";
import { userInfo } from "node:os";
import path from "node:path";
import { closePool, queryJson, queryJsonOn, withTransaction } from "../control-plane/db.mjs";
import { generatePassword, hashPassword, needsRehash } from "../control-plane/password.mjs";
import {
  credentialsPath,
  credentialsRetirement,
  readCredentialsState,
  retireCredentials,
  writeCredentials,
} from "../operations/initial-credentials.mjs";

export { credentialsPath };
export const CREDENTIALS_ENV = "INFRA_COD_CREDENTIALS_DIR";
export const DEFAULT_CREDENTIALS_DIR = "/etc/infra-cod";
export const CREDENTIALS_FILE = "initial-credentials";

const USERNAME_PATTERN = /^[a-z0-9][a-z0-9._-]{2,31}$/;
const GENERATED_ALPHABET = "abcdefghijkmnopqrstuvwxyz23456789";

export class AdminError extends Error {
  constructor(message) {
    super(message);
    this.name = "AdminError";
  }
}

// ------------------------------------------------------------- arguments ----

export function parseFlags(argv) {
  const flags = new Map();
  const positional = [];
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      positional.push(token);
      continue;
    }
    const body = token.slice(2);
    const equals = body.indexOf("=");
    if (equals !== -1) {
      flags.set(body.slice(0, equals), body.slice(equals + 1));
      continue;
    }
    const next = argv[index + 1];
    if (next !== undefined && !next.startsWith("--")) {
      flags.set(body, next);
      index += 1;
    } else {
      flags.set(body, true);
    }
  }
  return { flags, positional };
}

function rejectPasswordFlags(flags) {
  for (const name of ["password", "new-password", "pass"]) {
    if (flags.has(name)) {
      throw new AdminError(
        `--${name} is not accepted: a password on the command line is visible to every process `
        + "on this host. Use --stdin, or let the tool generate one.",
      );
    }
  }
}

export function generatedUsername() {
  let suffix = "";
  for (let index = 0; index < 6; index += 1) {
    suffix += GENERATED_ALPHABET[randomInt(0, GENERATED_ALPHABET.length)];
  }
  return `admin-${suffix}`;
}

function requireUsername(flags, label = "username") {
  const value = flags.get(label);
  if (typeof value !== "string" || !value) {
    throw new AdminError(`--${label} is required`);
  }
  const username = value.trim().toLowerCase();
  if (!USERNAME_PATTERN.test(username)) {
    throw new AdminError(
      "a username must be 3-32 characters of lowercase letters, digits, dot, dash or underscore",
    );
  }
  return username;
}

// ---------------------------------------------------------------- audit ----

// The real OS user, not the one the process runs as. Under `sudo` the process is
// root, so `userInfo()` would name root for every command an operator ever runs;
// SUDO_USER is the human who asked. Without sudo, the process identity is the
// answer.
export function osActor(env = process.env, whoami = () => userInfo().username) {
  const sudoUser = typeof env.SUDO_USER === "string" ? env.SUDO_USER.trim() : "";
  const name = sudoUser || env.INFRA_COD_ACTOR?.trim() || whoami();
  return `cli:${name || "unknown"}`;
}

// Wrapped in an object rather than cast to text: `queryJson` parses its result
// as JSON, and the uuid that `write_audit_event` returns is not JSON — the cast
// would fail the whole command after the change had already landed.
function auditSql() {
  return `SELECT jsonb_build_object('audit_event_id', write_audit_event(
    NULL,NULL,NULL,'system',:'actor_id',:'action',:'target_type',:'target_id',
    :'decision',NULL,:'details'::jsonb,:'correlation'))::text;`;
}

function auditVariables(entry) {
  return {
    actor_id: entry.actor,
    action: entry.action,
    target_type: entry.target_type,
    target_id: entry.target_id,
    decision: entry.decision ?? "allowed",
    details: JSON.stringify(entry.details ?? {}),
    correlation: randomUUID(),
  };
}

// Runs the change and its audit row together. Either both land or neither does,
// so a crashed command cannot leave an unaudited operator change behind.
async function audited(entry, change) {
  return withTransaction(async (client) => {
    const run = (sql, variables) => queryJsonOn(client, sql, variables);
    const result = await change(run);
    await run(auditSql(), auditVariables({ actor: osActor(), ...entry }));
    return result;
  });
}

// A refusal has nothing to keep atomic with — the change did not happen — and the
// row exists precisely to record that it was attempted.
//
// The failure is reported rather than swallowed. The original error is still the
// one the operator needs, so it is not replaced, but a lost audit row is a real
// failure with a security meaning and silence is how it goes unnoticed.
async function auditDenied(entry) {
  try {
    await queryJson(auditSql(), auditVariables({ actor: osActor(), decision: "denied", ...entry }));
  } catch (error) {
    process.stderr.write(`${JSON.stringify({
      type: "admin.audit_failed",
      action: entry.action,
      target_type: entry.target_type,
      target_id: entry.target_id,
      decision: "denied",
      error: error?.code ?? (error instanceof Error ? error.name : "unknown"),
    })}\n`);
  }
}

// -------------------------------------------------------------- password ----

function hideStdinEcho() {
  if (!process.stdin.isTTY) return () => {};
  try {
    execFileSync("stty", ["-echo"], { stdio: [process.stdin.fd, "ignore", "ignore"] });
  } catch {
    return () => {};
  }
  return () => {
    try {
      execFileSync("stty", ["echo"], { stdio: [process.stdin.fd, "ignore", "ignore"] });
    } catch {
      // The terminal will be reset when the process exits anyway.
    }
  };
}

export async function readPasswordFromStdin() {
  const restore = hideStdinEcho();
  try {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    const text = Buffer.concat(chunks).toString("utf8");
    // The first line only: a trailing newline is the shell's, not the operator's.
    return text.split(/\r?\n/)[0];
  } finally {
    restore();
  }
}

// Argon2id refuses to hash without INFRA_COD_AUTH_PEPPER, and the name of an
// environment variable is not a secret. Saying which one is missing is the
// difference between a one-line fix and an undiagnosable install.
async function hashOrExplain(password) {
  try {
    return await hashPassword(password);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("INFRA_COD_AUTH_PEPPER")) {
      throw new AdminError(
        "INFRA_COD_AUTH_PEPPER is not set. It must be the same pepper the panel runs with "
        + "(see /etc/infra-cod/web.env); a hash made with a different one can never be verified.",
      );
    }
    throw error;
  }
}

async function resolvePassword(flags) {
  if (flags.has("stdin")) {
    const password = await readPasswordFromStdin();
    if (!password) throw new AdminError("no password arrived on stdin");
    return password;
  }
  // Generation is the default. An operator who wants a specific password can
  // still supply one, but only through a pipe.
  return generatePassword();
}

// -------------------------------------------------------------- delivery ----

// Only when both ends are a real terminal. A secret written to stdout would be
// captured by `> file` and by anything reading the pipe.
function reportToTerminal(username, password) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return false;
  let tty = null;
  try {
    tty = openSync("/dev/tty", "w");
    writeSync(tty, `\n  username: ${username}\n  password: ${password}\n\n  Change it after the first sign-in.\n\n`);
    return true;
  } catch {
    return false;
  } finally {
    if (tty !== null) closeSync(tty);
  }
}

function deliverCredentials(username, password, out, receipt) {
  if (reportToTerminal(username, password)) {
    out({ ...receipt, credentials_delivered_to: "tty" });
    return;
  }
  const { file, ownedByRoot } = writeCredentials(undefined, username, password);
  out({ ...receipt, credentials_file: file, credentials_file_owned_by_root: ownedByRoot });
}

// ------------------------------------------------------------- commands ----

async function loadOperator(username) {
  const record = await queryJson(`SELECT find_local_operator(:'username')::text;`, { username });
  if (!record) throw new AdminError(`no local operator named ${username}`);
  return record;
}

async function bootstrap(flags, out) {
  rejectPasswordFlags(flags);
  const requested = flags.get("username");
  const username = typeof requested === "string" && requested
    ? requireUsername(flags)
    : generatedUsername();
  const displayName = typeof flags.get("display-name") === "string"
    ? String(flags.get("display-name")).trim().slice(0, 120) || "Owner"
    : "Owner";

  const password = await resolvePassword(flags);
  const passwordHash = await hashOrExplain(password);

  let result;
  try {
    result = await audited(
      { action: "operator.bootstrapped", target_type: "operator", target_id: username, details: { username } },
      (run) => run(
        `SELECT bootstrap_local_owner(:'username', :'password_hash', :'display_name')::text;`,
        { username, password_hash: passwordHash, display_name: displayName },
      ),
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("already exists")) {
      await auditDenied({ action: "operator.bootstrap_refused", target_type: "operator", target_id: username });
      throw new AdminError(
        "a local operator account already exists; use `admin reset-password` instead",
      );
    }
    throw new AdminError("the owner account could not be created");
  }
  if (!result) throw new AdminError("the owner account could not be created");

  deliverCredentials(result.username, password, out, {
    status: "bootstrapped",
    username: result.username,
    adopted_existing_owner: result.adopted_existing_owner === true,
    must_change_password: true,
  });
  return 0;
}

async function resetPassword(flags, out) {
  rejectPasswordFlags(flags);
  const username = requireUsername(flags);
  const operator = await loadOperator(username);
  const password = await resolvePassword(flags);
  const passwordHash = await hashOrExplain(password);

  await audited(
    { action: "auth.password_reset", target_type: "operator", target_id: operator.user_id, details: { username } },
    (run) => run(
      `SELECT set_user_password(:'user_id'::uuid, :'password_hash', true, NULL)::text;`,
      { user_id: operator.user_id, password_hash: passwordHash },
    ),
  );

  deliverCredentials(username, password, out, {
    status: "password_reset",
    username,
    must_change_password: true,
    sessions_revoked: true,
  });
  return 0;
}

async function changeUsername(flags, out) {
  const from = requireUsername(flags, "from");
  const to = requireUsername(flags, "to");
  const operator = await loadOperator(from);
  const result = await audited(
    { action: "auth.username_changed", target_type: "operator", target_id: operator.user_id, details: { from, to } },
    (run) => run(
      `SELECT set_user_username(:'user_id'::uuid, :'username')::text;`,
      { user_id: operator.user_id, username: to },
    ),
  );
  out({
    status: "username_changed",
    from,
    to: result?.username ?? to,
    sessions_revoked: Number(result?.sessions_revoked ?? 0),
  });
  return 0;
}

async function revokeSessions(flags, out) {
  const all = flags.has("all");
  const username = typeof flags.get("username") === "string" ? requireUsername(flags) : "";
  if (!all && !username) throw new AdminError("pass --username, or --all for every account");

  if (all) {
    const listed = await queryJson(`SELECT list_local_operators()::text;`);
    const operators = Array.isArray(listed?.operators) ? listed.operators : [];
    const revoked = await audited(
      { action: "auth.sessions_revoked", target_type: "installation", target_id: "all", details: { scope: "all" } },
      async (run) => {
        let total = 0;
        for (const operator of operators) {
          // `::text` because queryJson parses JSON: a bare integer arrives from
          // the driver as a number and would be discarded.
          total += Number(await run(
            `SELECT revoke_user_sessions(:'user_id'::uuid, 'admin_revoke', NULL)::text;`,
            { user_id: operator.user_id },
          ) ?? 0);
        }
        return total;
      },
    );
    out({ status: "sessions_revoked", scope: "all", accounts: operators.length, sessions_revoked: revoked });
    return 0;
  }

  const operator = await loadOperator(username);
  const revoked = await audited(
    {
      action: "auth.sessions_revoked", target_type: "operator", target_id: operator.user_id,
      details: { scope: "username", username },
    },
    (run) => run(
      `SELECT revoke_user_sessions(:'user_id'::uuid, 'admin_revoke', NULL)::text;`,
      { user_id: operator.user_id },
    ),
  );
  out({ status: "sessions_revoked", scope: "username", username, sessions_revoked: Number(revoked ?? 0) });
  return 0;
}

async function setDisabled(flags, out, disabled) {
  const username = requireUsername(flags);
  const operator = await loadOperator(username);
  const result = await audited(
    {
      action: disabled ? "operator.disabled" : "operator.enabled",
      target_type: "operator", target_id: operator.user_id, details: { username },
    },
    (run) => run(
      `SELECT set_local_operator_disabled(:'user_id'::uuid, :'disabled'::boolean)::text;`,
      { user_id: operator.user_id, disabled },
    ),
  );
  out({
    status: disabled ? "disabled" : "enabled",
    username: result?.username ?? username,
    sessions_revoked: Number(result?.sessions_revoked ?? 0),
  });
  return 0;
}

async function list(flags, out) {
  const listed = await queryJson(`SELECT list_local_operators()::text;`);
  const operators = Array.isArray(listed?.operators) ? listed.operators : [];
  await audited(
    {
      action: "operator.operators_listed", target_type: "installation", target_id: "all",
      decision: "not_required", details: { accounts: operators.length },
    },
    async () => operators,
  );
  if (flags.has("json")) {
    out({ status: "listed", operators });
    return 0;
  }
  if (operators.length === 0) {
    out({ status: "listed", operators: [] }, true, "no local operator account exists yet");
    return 0;
  }
  const lines = [
    "username         display name     status   must change  sessions  last login",
    "---------------  ---------------  -------  -----------  --------  -------------------",
    ...operators.map((operator) => [
      String(operator.username ?? "-").padEnd(15),
      String(operator.display_name ?? "-").slice(0, 15).padEnd(15),
      (operator.disabled ? "disabled" : "active").padEnd(7),
      (operator.must_change_password ? "yes" : "no").padEnd(11),
      String(operator.active_sessions ?? 0).padEnd(8),
      operator.last_login_at ? String(operator.last_login_at).slice(0, 19).replace("T", " ") : "never",
    ].join("  ")),
  ];
  out({ status: "listed", operators }, true, lines.join("\n"));
  return 0;
}

// Rehashes every stored hash that was produced with parameters this build no
// longer uses. It needs the hash, so it goes through find_local_operator, which
// is why that function returns one and list_local_operators does not.
async function rehashCheck(flags, out) {
  const listed = await queryJson(`SELECT list_local_operators()::text;`);
  const operators = Array.isArray(listed?.operators) ? listed.operators : [];
  const stale = [];
  for (const operator of operators) {
    const record = await queryJson(`SELECT find_local_operator(:'username')::text;`, {
      username: operator.username,
    });
    if (record?.password_hash && needsRehash(record.password_hash)) stale.push(operator.username);
  }
  await audited(
    {
      action: "operator.rehash_checked", target_type: "installation", target_id: "all",
      decision: "not_required", details: { accounts: operators.length, stale },
    },
    async () => stale,
  );
  out({ status: "rehash_checked", accounts: operators.length, stale });
  return 0;
}

// Reports the generated-credentials file, and removes it only once the database
// says the password in it is retired. `--if-retired` is what the root health
// timer calls: run by hand it is still safe, because the decision comes from the
// database and not from the fact that somebody invoked the command.
//
// The removal is durable — `requested -> file_removed -> recorded` — so the
// audit row cannot be lost to a crash between the unlink and the insert, and a
// run that finds an unfinished retirement from an earlier one finishes it.
async function ackCredentials(flags, out) {
  const state = readCredentialsState(undefined);
  const status = await queryJson(`SELECT initial_credentials_status()::text;`);
  const reason = credentialsRetirement(status)
    ?? (status ? null : "the credential state could not be read");

  // An unreadable path is not an absent file, and nothing may be concluded from
  // it — least of all that the plaintext password is gone.
  if (state.exists === null) {
    throw new AdminError(
      `refusing to act on ${state.path}: it could not be read (${state.error}). `
      + "A plaintext password may still be on disk.",
    );
  }

  if (!state.exists) {
    const open = (await queryJson(`SELECT open_credential_retirements()::text;`))?.retirements ?? [];
    const resumable = open.filter((row) => row.path === state.path);
    if (resumable.length === 0) {
      out({ status: "no_credentials_file", credentials_file: state.path });
      return 0;
    }
    // The file is gone but a retirement never reached its audit row. Finish it
    // now rather than forgetting that it happened.
    const finished = await retireCredentials({
      actorId: osActor(),
      run: (sql, variables) => queryJson(sql, variables),
    });
    await audited(
      {
        action: "operator.credentials_acknowledged", target_type: "installation", target_id: state.path,
        details: { resumed: true, state: finished.state },
      },
      async () => finished,
    );
    out({
      status: "credentials_acknowledged",
      credentials_file: state.path,
      removed: true,
      retirement: finished.state,
      resumed: true,
    });
    return 0;
  }

  if (reason) {
    if (flags.has("if-retired")) {
      out({
        status: "credentials_retained",
        credentials_file: state.path,
        reason,
        generated_password_retired: false,
      });
      return 0;
    }
    // Without the flag this is an explicit operator instruction, but a plaintext
    // password is still deleted only against a confirmed state: the flag means
    // "do not keep asking me", not "delete an unretired credential".
    throw new AdminError(
      `refusing to remove ${state.path}: ${reason}. `
      + "Run with --if-retired to have a confirmed state reported instead, "
      + "or use reset-password if the password is lost.",
    );
  }

  const outcome = await retireCredentials({
    actorId: osActor(),
    run: (sql, variables) => queryJson(sql, variables),
  });
  if (outcome.state === "removal_refused" || outcome.state === "unreadable") {
    throw new AdminError(`the credentials file could not be removed: ${outcome.reason ?? outcome.error}`);
  }

  await audited(
    {
      action: "operator.credentials_acknowledged", target_type: "installation", target_id: state.path,
      details: { state: outcome.state, resumed: outcome.resumed === true },
    },
    async () => outcome,
  );
  out({
    status: "credentials_acknowledged",
    credentials_file: state.path,
    removed: true,
    retirement: outcome.state,
    resumed: outcome.resumed === true,
  });
  return 0;
}

const COMMANDS = {
  bootstrap,
  "reset-password": resetPassword,
  "change-username": changeUsername,
  "revoke-sessions": revokeSessions,
  list,
  disable: (flags, out) => setDisabled(flags, out, true),
  enable: (flags, out) => setDisabled(flags, out, false),
  "ack-credentials": ackCredentials,
  "rehash-check": rehashCheck,
};

const USAGE = `infra-cod admin <command>

  bootstrap [--username U] [--display-name N] [--stdin]
      Create the single local owner. Generates a username and a 24+ character
      password unless told otherwise.

  reset-password --username U [--stdin | --generate]
      Replace the password and end every session.

  change-username --from A --to B
      Rename the account and end every session.

  revoke-sessions [--username U] [--all]
      End sessions without touching the password.

  list [--json]
  disable --username U
  enable --username U
  rehash-check
      Report stored hashes that need rehashing under the current parameters.

  ack-credentials [--if-retired]
      Remove the root-only credentials file once the generated password is
      retired: a successful sign-in *and* the forced change completed. Refuses
      while the file is still somebody's way in; --if-retired reports instead of
      failing, which is what the root health timer calls.

A password is never accepted as an argument. Every command writes an audit row
naming the OS user that ran it.`;

export async function runAdmin(argv, { stdout = process.stdout, stderr = process.stderr } = {}) {
  const [command, ...rest] = argv;
  const headless = { status: "error", error: "" };

  if (!command || command === "help" || command === "--help" || command === "-h") {
    stdout.write(`${USAGE}\n`);
    return command ? 0 : 1;
  }

  const handler = COMMANDS[command];
  if (!handler) {
    stderr.write(`${JSON.stringify({ ...headless, error: `unknown command: ${command}` })}\n`);
    return 2;
  }

  const { flags } = parseFlags(rest);
  const emit = (receipt, human = false, text = "") => {
    if (human && text) stdout.write(`${text}\n`);
    else stdout.write(`${JSON.stringify(receipt)}\n`);
  };

  try {
    return await handler(flags, emit);
  } catch (error) {
    if (error instanceof AdminError) {
      stderr.write(`${JSON.stringify({ ...headless, error: error.message })}\n`);
      return 1;
    }
    // Deliberately not the raw database message: a constraint violation quotes
    // the failing row, and that row holds the password hash.
    // The message is withheld because a constraint violation quotes the failing
    // row, and that row holds the password hash. The error's *class* quotes
    // nothing, and without it a missing environment variable and a broken
    // database are the same sentence — which is exactly how a clean install
    // ended at "the command failed" with nothing to go on.
    stderr.write(`${JSON.stringify({
      ...headless,
      error: "the command failed",
      error_code: error?.code ?? null,
      error_name: error?.name ?? null,
    })}\n`);
    return 1;
  } finally {
    await closePool();
  }
}

// `path.resolve` normalises `..` and leaves symlinks alone, so this was false
// whenever the CLI was reached through /opt/infra-cod/current.
const invokedDirectly = isMain(import.meta.url);
if (invokedDirectly) {
  const argv = process.argv.slice(2);
  // Tolerate both `infra-cod admin ...` and a direct `node admin.mjs ...`.
  if (argv[0] === "admin") argv.shift();
  process.exitCode = await runAdmin(argv);
}
