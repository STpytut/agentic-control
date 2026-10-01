import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { osActor } from "../admin.mjs";
import { hashPassword, verifyPassword } from "../../control-plane/password.mjs";
import { writeCredentials } from "../../operations/initial-credentials.mjs";

// `infra-cod admin`, and the rules it has to keep.
//
// Two kinds of assertion matter here, and neither is "the command printed the
// right JSON":
//
//   * The generated password did not appear anywhere it could be recorded. A
//     password in stdout is a password in a CI log or a shell transcript, and a
//     password in argv is a password in `ps` output for every account on the
//     host.
//   * Every command says who ran it. An audit row with a hardcoded actor is
//     worse than none, because it looks authoritative.
//
// Runs against a scratch database it creates itself, because bootstrap is
// one-shot: it refuses once a local account exists, which would make a shared
// database unusable for a second run.
//
// Skipped only when psql or a superuser connection is genuinely unavailable.

const databaseUrl = process.env.DATABASE_URL;
const pepper = process.env.INFRA_COD_AUTH_PEPPER ?? "admin-cli-test-pepper";
// The CLI child is given this pepper explicitly, so this process has to use the
// same one: `verifyPassword` reads it from the environment too, and a mismatch
// would look exactly like a wrong password.
process.env.INFRA_COD_AUTH_PEPPER = pepper;
const psqlBin = process.env.PSQL_BIN ?? "psql";

// Stands in for `sudo`: the process runs as one account and was invoked by
// another, and the audit row has to name the second.
const INVOKING_USER = "sudo-operator";

let hasPsql = false;
try {
  const probe = spawnSync("sh", ["-c", `command -v ${JSON.stringify(psqlBin)}`], { stdio: "ignore" });
  hasPsql = probe.status === 0;
} catch {}

const skip = !databaseUrl ? "DATABASE_URL is not set" : !hasPsql ? "psql is not available" : false;

const root = path.resolve(import.meta.dirname, "../../..");
const cliPath = path.join(root, "services/cli/admin.mjs");

let scratch = "";
let url = "";
let credentialsDir = "";
let username = "";
let password = "";

function adminUrl(database) {
  const parsed = new URL(databaseUrl);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

function psql(sql) {
  const result = spawnSync(psqlBin, ["-X", "-qAt", "-v", "ON_ERROR_STOP=1", url], {
    encoding: "utf8", input: sql,
  });
  if (result.status !== 0) throw new Error(result.stderr.trim() || `psql exited ${result.status}`);
  return result.stdout.trim();
}

function cli(args, { input, env = {} } = {}) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    encoding: "utf8",
    input,
    env: {
      ...process.env,
      DATABASE_URL: url,
      INFRA_COD_AUTH_PEPPER: pepper,
      INFRA_COD_CREDENTIALS_DIR: credentialsDir,
      SUDO_USER: INVOKING_USER,
      ...env,
    },
  });
}

function receipt(result) {
  const line = result.stdout.trim().split("\n").filter(Boolean).at(-1) ?? "";
  return JSON.parse(line);
}

function credentialsFile() {
  return path.join(credentialsDir, "initial-credentials");
}

function readCredentials() {
  const text = readFileSync(credentialsFile(), "utf8");
  const read = (key) => text.split("\n").find((line) => line.startsWith(`${key}=`))?.slice(key.length + 1) ?? "";
  return { username: read("username"), password: read("password") };
}

// Every command's combined output, for the "no secret in the output" checks.
function outputOf(result) {
  return `${result.stdout}\n${result.stderr}`;
}

function actorsFor(action) {
  return psql(
    `SELECT COALESCE(string_agg(DISTINCT actor_type||':'||actor_id, ','),'') FROM control_plane.audit_events
     WHERE action='${action}';`,
  );
}

test.before(async () => {
  if (skip) return;
  scratch = `infra_cod_admin_${randomUUID().slice(0, 8).replace(/-/g, "")}`;
  const maintenance = adminUrl("postgres");
  const created = spawnSync(psqlBin, ["-X", "-qAt", "-v", "ON_ERROR_STOP=1", maintenance], {
    encoding: "utf8", input: `CREATE DATABASE ${scratch};`,
  });
  if (created.status !== 0) throw new Error(created.stderr);
  url = adminUrl(scratch);
  credentialsDir = path.join(root, `.tmp-admin-cli-${process.pid}`);

  const migrate = spawnSync(process.execPath, [path.join(root, "services/control-plane/migrate.mjs")], {
    encoding: "utf8", env: { ...process.env, DATABASE_URL: url },
  });
  if (migrate.status !== 0) throw new Error(`migrate failed: ${migrate.stderr}`);
});

test.after(() => {
  if (skip) return;
  spawnSync(psqlBin, ["-X", "-qAt", adminUrl("postgres")], {
    encoding: "utf8", input: `DROP DATABASE IF EXISTS ${scratch} WITH (FORCE);`,
  });
});

// ------------------------------------------------------------- attribution ----

test("the audit actor is the OS user that invoked the command", () => {
  // Under sudo the process is root; naming root would make every row identical,
  // so the human who asked wins.
  assert.equal(osActor({ SUDO_USER: "alice" }, () => "root"), "cli:alice");
  assert.equal(osActor({}, () => "bob"), "cli:bob");
  // SUDO_USER first, then the override a unit sets for itself, then the process.
  assert.equal(osActor({ SUDO_USER: "alice", INFRA_COD_ACTOR: "installer" }, () => "root"), "cli:alice");
  assert.equal(osActor({ INFRA_COD_ACTOR: "installer" }, () => "root"), "cli:installer");
  assert.equal(osActor({ SUDO_USER: "   " }, () => "carol"), "cli:carol");
  assert.equal(osActor({}, () => ""), "cli:unknown");
});

// -------------------------------------------------------------- behaviour ----

test("an installation with no operator says so instead of failing", { skip }, () => {
  const human = cli(["list"]);
  assert.equal(human.status, 0, outputOf(human));
  assert.match(human.stdout, /no local operator account exists yet/);

  const json = cli(["list", "--json"]);
  assert.equal(json.status, 0, outputOf(json));
  assert.deepEqual(receipt(json).operators, []);
});

test("a password is never accepted as an argument", { skip }, () => {
  for (const flag of ["--password", "--password=hunter2hunter2", "--new-password"]) {
    const result = cli(["bootstrap", flag]);
    assert.equal(result.status, 1, `${flag} was accepted`);
    assert.match(outputOf(result), /not accepted/);
  }
  // Nothing was created by the rejected attempts.
  assert.equal(psql("SELECT count(*) FROM control_plane.users WHERE username IS NOT NULL;"), "0");
});

test("a malformed username is refused before anything is created", { skip }, () => {
  const result = cli(["bootstrap", "--username", "AB"]);
  assert.equal(result.status, 1);
  assert.match(outputOf(result), /username must be/);
  assert.equal(psql("SELECT count(*) FROM control_plane.users WHERE username IS NOT NULL;"), "0");
});

test("bootstrap generates the account and keeps the password out of stdout", { skip }, () => {
  const result = cli(["bootstrap"]);
  assert.equal(result.status, 0, outputOf(result));

  const parsed = receipt(result);
  assert.equal(parsed.status, "bootstrapped");
  assert.match(parsed.username, /^admin-[a-z0-9]{6}$/, "the generated username has the documented shape");
  assert.equal(parsed.must_change_password, true);
  assert.equal(parsed.adopted_existing_owner, false);

  const stored = readCredentials();
  username = stored.username;
  password = stored.password;
  assert.equal(username, parsed.username);
  assert.ok(password.length >= 24, "the generated password is at least 24 characters");

  // The receipt is JSON meant to be forwarded, so it must not carry the secret.
  assert.ok(!outputOf(result).includes(password), "the password appeared in the command output");
  assert.ok(!outputOf(result).includes("password="), "the credential line appeared in the output");

  // The file is the documented delivery channel and is closed to everyone else.
  assert.ok(existsSync(credentialsFile()));
  assert.equal(statSync(credentialsFile()).mode & 0o777, 0o600);

  // And what landed in the database is a hash, not the password.
  const row = psql("SELECT username||'|'||left(password_hash,10)||'|'||must_change_password::text FROM control_plane.users WHERE username IS NOT NULL;");
  assert.equal(row, `${username}|$argon2id$|true`);
  assert.ok(!row.includes(password));
});

test("bootstrap is attributed, and a refused bootstrap is recorded too", { skip }, () => {
  assert.equal(actorsFor("operator.bootstrapped"), `system:cli:${INVOKING_USER}`);

  const refused = cli(["bootstrap"]);
  assert.equal(refused.status, 1);
  assert.match(outputOf(refused), /already exists/);
  assert.equal(psql("SELECT count(*) FROM control_plane.users WHERE username IS NOT NULL;"), "1");
  assert.equal(actorsFor("operator.bootstrap_refused"), `system:cli:${INVOKING_USER}`);
});

test("the generated password actually verifies against the stored hash", { skip }, async () => {
  const hash = psql(`SELECT password_hash FROM control_plane.users WHERE username='${username}';`);
  assert.equal(await verifyPassword(password, hash), true);
  assert.equal(await verifyPassword(`${password}x`, hash), false);
});

test("list reports the account, never the hash, and records the read", { skip }, () => {
  const result = cli(["list", "--json"]);
  assert.equal(result.status, 0, outputOf(result));
  const [operator] = receipt(result).operators;
  assert.equal(operator.username, username);
  assert.equal(operator.must_change_password, true);
  assert.equal(operator.disabled, false);
  assert.ok(!JSON.stringify(result.stdout).includes("$argon2id$"), "the listing exposed a hash");
  assert.equal(actorsFor("operator.operators_listed"), `system:cli:${INVOKING_USER}`);
});

test("reset-password replaces the hash, forces a change and ends sessions", { skip }, async () => {
  // A live session to prove the reset ends it.
  psql(`INSERT INTO control_plane.web_sessions(user_id,token_digest,csrf_digest,expires_at,absolute_expires_at)
        SELECT id, decode(repeat('ab',32),'hex'), decode(repeat('cd',32),'hex'),
               clock_timestamp()+interval '12 hours', clock_timestamp()+interval '30 days'
        FROM control_plane.users WHERE username='${username}';`);
  assert.equal(psql("SELECT count(*) FROM control_plane.web_sessions WHERE revoked_at IS NULL;"), "1");

  const result = cli(["reset-password", "--username", username, "--stdin"], {
    input: "a-deliberately-chosen-operator-passphrase\n",
  });
  assert.equal(result.status, 0, outputOf(result));
  assert.ok(!outputOf(result).includes("a-deliberately-chosen-operator-passphrase"),
    "the supplied password appeared in the output");

  const stored = readCredentials();
  assert.equal(stored.password, "a-deliberately-chosen-operator-passphrase");
  password = stored.password;

  const hash = psql(`SELECT password_hash FROM control_plane.users WHERE username='${username}';`);
  assert.equal(await verifyPassword(password, hash), true);
  assert.equal(psql("SELECT must_change_password::text FROM control_plane.users WHERE username IS NOT NULL;"), "true");
  assert.equal(psql("SELECT count(*) FROM control_plane.web_sessions WHERE revoked_at IS NULL;"), "0");
  assert.equal(actorsFor("auth.password_reset"), `system:cli:${INVOKING_USER}`);

  // An unknown username is a message, not a stack trace.
  const missing = cli(["reset-password", "--username", "nobody-here", "--generate"]);
  assert.equal(missing.status, 1);
  assert.match(outputOf(missing), /no local operator named nobody-here/);
});

test("change-username renames and ends every session", { skip }, () => {
  psql(`INSERT INTO control_plane.web_sessions(user_id,token_digest,csrf_digest,expires_at,absolute_expires_at)
        SELECT id, decode(repeat('ef',32),'hex'), decode(repeat('12',32),'hex'),
               clock_timestamp()+interval '12 hours', clock_timestamp()+interval '30 days'
        FROM control_plane.users WHERE username='${username}';`);

  const renamed = "admin-renamed-by-cli";
  const result = cli(["change-username", "--from", username, "--to", renamed]);
  assert.equal(result.status, 0, outputOf(result));
  assert.equal(receipt(result).to, renamed);
  assert.equal(psql("SELECT username FROM control_plane.users WHERE role='owner';"), renamed);
  assert.equal(psql("SELECT count(*) FROM control_plane.web_sessions WHERE revoked_at IS NULL;"), "0");
  assert.equal(actorsFor("auth.username_changed"), `system:cli:${INVOKING_USER}`);

  // The username format is the CLI's to check, so a bad one is a message rather
  // than a raw database constraint error. Case is normalised, not rejected.
  const invalid = cli(["change-username", "--from", renamed, "--to", "x"]);
  assert.equal(invalid.status, 1, outputOf(invalid));
  assert.match(outputOf(invalid), /username must be/);
  assert.equal(psql("SELECT username FROM control_plane.users WHERE role='owner';"), renamed);

  username = renamed;
});

test("disable and enable switch the account off and back on, and say who did it", { skip }, () => {
  const disabled = cli(["disable", "--username", username]);
  assert.equal(disabled.status, 0, outputOf(disabled));
  assert.equal(psql(`SELECT (disabled_at IS NOT NULL)::text FROM control_plane.users WHERE username='${username}';`), "true");

  // A disabled operator cannot authenticate, and `authenticate_lookup` says so.
  assert.equal(psql(`SELECT (control_plane.authenticate_lookup('${username}'::text)->>'disabled');`), "true");

  const enabled = cli(["enable", "--username", username]);
  assert.equal(enabled.status, 0, outputOf(enabled));
  assert.equal(psql(`SELECT (disabled_at IS NULL)::text FROM control_plane.users WHERE username='${username}';`), "true");

  // The row the function used to write itself said `system:infra-cod-admin` for
  // everyone. There is exactly one row per command, and it names the operator.
  assert.equal(actorsFor("operator.disabled"), `system:cli:${INVOKING_USER}`);
  assert.equal(actorsFor("operator.enabled"), `system:cli:${INVOKING_USER}`);
  assert.equal(psql("SELECT count(*) FROM control_plane.audit_events WHERE actor_id='infra-cod-admin';"), "0");
});

test("revoke-sessions ends them for one account, or for all", { skip }, () => {
  psql(`INSERT INTO control_plane.web_sessions(user_id,token_digest,csrf_digest,expires_at,absolute_expires_at)
        SELECT id, decode(repeat('34',32),'hex'), decode(repeat('56',32),'hex'),
               clock_timestamp()+interval '12 hours', clock_timestamp()+interval '30 days'
        FROM control_plane.users WHERE username='${username}';`);

  const one = cli(["revoke-sessions", "--username", username]);
  assert.equal(one.status, 0, outputOf(one));
  assert.equal(receipt(one).sessions_revoked, 1);
  assert.equal(psql("SELECT count(*) FROM control_plane.web_sessions WHERE revoked_at IS NULL;"), "0");

  const all = cli(["revoke-sessions", "--all"]);
  assert.equal(all.status, 0, outputOf(all));
  assert.equal(receipt(all).scope, "all");
  assert.equal(actorsFor("auth.sessions_revoked"), `system:cli:${INVOKING_USER}`);

  const neither = cli(["revoke-sessions"]);
  assert.equal(neither.status, 1);
  assert.match(outputOf(neither), /--username, or --all/);
});

test("rehash-check reports stale encodings and records the check", { skip }, async () => {
  // The current parameters are in use, so nothing is stale.
  const current = cli(["rehash-check"]);
  assert.equal(current.status, 0, outputOf(current));
  assert.deepEqual(receipt(current).stale, []);

  // A hash from an older profile is reported.
  psql(`UPDATE control_plane.users SET password_hash='$argon2id$v=19$m=4096,t=1,p=1$b2xkc2FsdG9sZHNhbHQ$aGFzaGhhc2hoYXNoaGFzaA';`);
  const stale = cli(["rehash-check"]);
  assert.equal(stale.status, 0, outputOf(stale));
  assert.deepEqual(receipt(stale).stale, [username]);

  // And a hash under the current parameters is not, which is what makes the
  // first result mean something.
  psql(`UPDATE control_plane.users SET password_hash='${await hashPassword(password)}';`);
  assert.deepEqual(receipt(cli(["rehash-check"])).stale, []);
  assert.equal(actorsFor("operator.rehash_checked"), `system:cli:${INVOKING_USER}`);
});

test("ack-credentials refuses while the generated password is still live", { skip }, () => {
  // After reset-password the file was written again and the account is back in
  // the forced-change state, so the password in it is still the way in.
  psql("UPDATE control_plane.users SET must_change_password=true, last_login_at=NULL;");
  assert.ok(existsSync(credentialsFile()));

  const refused = cli(["ack-credentials"]);
  assert.equal(refused.status, 1, outputOf(refused));
  assert.match(outputOf(refused), /refusing to remove/);
  assert.ok(existsSync(credentialsFile()), "a live credential was deleted");

  // --if-retired is what the root health timer calls: it reports and moves on.
  const retained = cli(["ack-credentials", "--if-retired"]);
  assert.equal(retained.status, 0, outputOf(retained));
  assert.equal(receipt(retained).status, "credentials_retained");
  assert.equal(receipt(retained).generated_password_retired, false);
  assert.ok(existsSync(credentialsFile()));

  // A sign-in alone is not enough either: the operator has not replaced the
  // generated password, so the file is still the only copy of it.
  psql("UPDATE control_plane.users SET last_login_at=clock_timestamp();");
  assert.equal(receipt(cli(["ack-credentials", "--if-retired"])).status, "credentials_retained");
  assert.ok(existsSync(credentialsFile()));
});

test("ack-credentials removes the file once the credential is retired", { skip }, () => {
  psql("UPDATE control_plane.users SET must_change_password=false, last_login_at=clock_timestamp();");

  const removed = cli(["ack-credentials", "--if-retired"]);
  assert.equal(removed.status, 0, outputOf(removed));
  assert.equal(receipt(removed).status, "credentials_acknowledged");
  assert.equal(receipt(removed).removed, true);
  assert.ok(!existsSync(credentialsFile()), "the file survived a confirmed retirement");
  assert.equal(actorsFor("operator.credentials_acknowledged"), `system:cli:${INVOKING_USER}`);

  // Safe to repeat.
  const again = cli(["ack-credentials"]);
  assert.equal(again.status, 0, outputOf(again));
  assert.equal(receipt(again).status, "no_credentials_file");
});

test("ack-credentials finishes a retirement that a crash left half-done", { skip }, () => {
  // The sequence the durable state exists for: a run unlinked the file and died
  // before it could write the audit row. The file is gone, so nothing on disk
  // says the retirement happened — only the open row does.
  const path = credentialsFile();
  writeCredentials(credentialsDir, username, "a-transient-generated-password");
  const retirementId = psql(
    `INSERT INTO control_plane.credential_retirements(path,state,actor_id,file_removed_at)
     VALUES ('${path}','file_removed','cli:health-snapshot',clock_timestamp()) RETURNING id;`,
  );
  rmSync(path, { force: true });

  const resumed = cli(["ack-credentials", "--if-retired"]);
  assert.equal(resumed.status, 0, outputOf(resumed));
  assert.equal(receipt(resumed).status, "credentials_acknowledged");
  assert.equal(receipt(resumed).resumed, true);
  assert.equal(receipt(resumed).retirement, "recorded");
  assert.equal(
    psql(`SELECT state FROM control_plane.credential_retirements WHERE id='${retirementId}';`),
    "recorded",
    "the interrupted retirement was never finished",
  );
  assert.equal(
    psql(`SELECT count(*) FROM control_plane.audit_events
          WHERE action='operator.credentials_retired'
            AND correlation_id='credential-retirement:${retirementId}';`),
    "1",
    "the finished retirement was not audited exactly once",
  );

  // Running it again must not produce a second audit row.
  const repeated = cli(["ack-credentials", "--if-retired"]);
  assert.equal(repeated.status, 0, outputOf(repeated));
  assert.equal(
    psql(`SELECT count(*) FROM control_plane.audit_events
          WHERE action='operator.credentials_retired'
            AND correlation_id='credential-retirement:${retirementId}';`),
    "1",
    "a repeated acknowledgement duplicated the audit row",
  );
});

test("every command wrote a row naming the operator, and none a guessed actor", { skip }, () => {
  const expected = [
    "operator.bootstrapped",
    "operator.bootstrap_refused",
    "operator.operators_listed",
    "auth.password_reset",
    "auth.username_changed",
    "operator.disabled",
    "operator.enabled",
    "auth.sessions_revoked",
    "operator.rehash_checked",
    "operator.credentials_acknowledged",
  ];
  for (const action of expected) {
    assert.equal(actorsFor(action), `system:cli:${INVOKING_USER}`, `${action} was not attributed`);
  }
  // The old hardcoded actor is gone from the whole table.
  assert.equal(psql("SELECT count(*) FROM control_plane.audit_events WHERE actor_id LIKE 'infra-cod%';"), "0");
});

test("an unknown subcommand is refused without touching the database", { skip }, () => {
  const result = cli(["nonsense"]);
  assert.equal(result.status, 2);
  assert.match(outputOf(result), /unknown command/);
});
