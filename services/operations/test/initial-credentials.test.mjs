import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  CREDENTIALS_FILE,
  credentialsPath,
  credentialsRetirement,
  readCredentialsState,
  removeCredentials,
  retireCredentials,
  retirementConfirmed,
  writeCredentials,
} from "../initial-credentials.mjs";

// The plaintext password bootstrap leaves on disk, and the rules for getting rid
// of it. Every assertion here is about not being clever: the file is the only
// copy of a credential, so a wrong "yes, it is retired" locks an operator out,
// and a wrong unlink destroys somebody else's file.

const workdir = path.join(process.cwd(), `.tmp-credentials-test-${process.pid}`);
const ORIGINAL_DIR = process.env.INFRA_COD_CREDENTIALS_DIR;

test.before(() => {
  process.env.INFRA_COD_CREDENTIALS_DIR = workdir;
  mkdirSync(workdir, { recursive: true, mode: 0o700 });
});

test.after(() => {
  if (ORIGINAL_DIR === undefined) delete process.env.INFRA_COD_CREDENTIALS_DIR;
  else process.env.INFRA_COD_CREDENTIALS_DIR = ORIGINAL_DIR;
  rmSync(workdir, { recursive: true, force: true });
});

test("the path follows the environment, an explicit directory, and the default", () => {
  assert.equal(credentialsPath(), path.join(workdir, CREDENTIALS_FILE));
  assert.equal(credentialsPath("/tmp/elsewhere"), path.join("/tmp/elsewhere", CREDENTIALS_FILE));
  delete process.env.INFRA_COD_CREDENTIALS_DIR;
  assert.equal(credentialsPath(), path.join("/etc/infra-cod", CREDENTIALS_FILE));
  process.env.INFRA_COD_CREDENTIALS_DIR = workdir;
});

test("a written credential is 0600 and never readable through the reporter", () => {
  const { file } = writeCredentials(workdir, "admin-test", "a-generated-password-value");
  assert.equal(file, credentialsPath(workdir));
  assert.equal(readFileSync(file, "utf8"), "username=admin-test\npassword=a-generated-password-value\n");

  const state = readCredentialsState(workdir);
  assert.equal(state.exists, true);
  assert.equal(state.mode, 0o600);
  assert.equal(state.regularFile, true);
  assert.equal(state.symlink, false);
  // The reporter is what a health snapshot prints, so it must not carry the
  // secret it is reporting on.
  assert.ok(!JSON.stringify(state).includes("a-generated-password-value"));

  // Writing over an existing file re-applies the mode rather than keeping it.
  chmodSync(file, 0o644);
  assert.equal(readCredentialsState(workdir).mode, 0o644);
  writeCredentials(workdir, "admin-test", "third-value");
  assert.equal(readCredentialsState(workdir).mode, 0o600);
});

test("retirement is the database's answer, not this module's opinion", () => {
  // The SQL predicate is authoritative; anything claiming otherwise here would
  // be a second opinion that can drift from 0046.
  assert.equal(retirementConfirmed({ generated_password_retired: true }), true);
  assert.equal(credentialsRetirement({ generated_password_retired: true }), null);

  // Only the reason is derived locally, and only when the answer is no.
  assert.equal(
    credentialsRetirement({ generated_password_retired: false, operator_exists: false }),
    "no local operator account exists yet",
  );
  assert.equal(
    credentialsRetirement({
      generated_password_retired: false, operator_exists: true, must_change_password: true,
    }),
    "the operator has not replaced the generated password yet",
  );
  assert.equal(
    credentialsRetirement({
      generated_password_retired: false, operator_exists: true, must_change_password: false, last_login_at: null,
    }),
    "no successful sign-in has been recorded",
  );
  assert.equal(
    credentialsRetirement({
      generated_password_retired: false, operator_exists: true, must_change_password: false,
      last_login_at: "2026-09-11T00:00:00Z",
    }),
    "the generated password is not retired",
  );
  assert.equal(retirementConfirmed(null), false);
  assert.match(credentialsRetirement(null), /could not be read/);

  // A state that says retired while the flag is still set is still retired: the
  // database is the one that decides, and the reason text never overrides it.
  assert.equal(
    retirementConfirmed({ generated_password_retired: true, must_change_password: true }),
    true,
  );
});

test("removal refuses anything bootstrap did not write", () => {
  // A directory with the credentials name is somebody else's data.
  const directory = path.join(workdir, "as-a-directory");
  mkdirSync(path.join(directory, CREDENTIALS_FILE), { recursive: true });
  const refused = removeCredentials(directory);
  assert.equal(refused.removed, false);
  assert.equal(refused.reason, "not a regular file");
  assert.ok(existsSync(path.join(directory, CREDENTIALS_FILE)));

  // So is a symlink: unlinking it would be fine, but following it would not, and
  // the safe answer to "which is this" is neither.
  const linked = path.join(workdir, "as-a-symlink");
  mkdirSync(linked, { recursive: true });
  const target = path.join(workdir, "elsewhere-secret");
  writeFileSync(target, "not ours\n", { mode: 0o600 });
  symlinkSync(target, path.join(linked, CREDENTIALS_FILE));
  const symlinked = removeCredentials(linked);
  assert.equal(symlinked.removed, false);
  assert.equal(symlinked.reason, "not a regular file");
  assert.ok(existsSync(target), "the symlink target was destroyed");

  // Nothing there at all is not an error.
  const empty = path.join(workdir, "nothing-here");
  mkdirSync(empty, { recursive: true });
  assert.equal(removeCredentials(empty).removed, false);
  assert.equal(removeCredentials(empty).reason, "no credentials file");
});

test("removal takes the real file and leaves nothing behind", () => {
  writeCredentials(workdir, "admin-test", "a-generated-password-value");
  assert.ok(existsSync(credentialsPath(workdir)));

  const removal = removeCredentials(workdir);
  assert.equal(removal.removed, true);
  assert.equal(removal.reason, "retired");
  assert.equal(existsSync(credentialsPath(workdir)), false);
  assert.equal(readCredentialsState(workdir).exists, false);
  assert.equal(removeCredentials(workdir).removed, false);
});

test("a file that cannot be read is not reported as absent", (t) => {
  // Only root can read through a 0000 directory, and root bypasses the check —
  // so the assertion is only meaningful as an unprivileged user.
  if (typeof process.getuid === "function" && process.getuid() === 0) {
    t.skip("running as root: directory permissions cannot be used to force EACCES");
    return;
  }
  const unreadable = path.join(workdir, "unreadable");
  mkdirSync(unreadable, { recursive: true, mode: 0o700 });
  writeCredentials(unreadable, "admin-test", "a-generated-password-value");
  chmodSync(unreadable, 0o000);
  try {
    const state = readCredentialsState(unreadable);
    // The distinction this asserts is the whole point: `false` would let every
    // report claim the machine is clean while a plaintext password sits there.
    assert.equal(state.exists, null, "an unreadable file was reported as absent");
    assert.equal(state.error, "EACCES");

    // And it must not be deleted on the strength of a guess.
    const removal = removeCredentials(unreadable);
    assert.equal(removal.removed, false);
    assert.match(removal.reason, /could not be read/);
  } finally {
    chmodSync(unreadable, 0o700);
  }
});

// A stand-in for `begin_credential_retirement` / `advance_credential_retirement`,
// with the same contract: one open row per path, idempotent steps, and a terminal
// `recorded` that a later run must not reopen.
function fakeDatabase() {
  const rows = [];
  return {
    rows,
    async run(sql, variables = {}) {
      if (sql.includes("begin_credential_retirement")) {
        const open = rows.find((row) => row.path === variables.path && row.state !== "recorded");
        if (open) {
          if (variables.has_file === "true" && open.state === "file_removed") open.state = "requested";
          return { id: open.id, state: open.state, resumed: true };
        }
        if (variables.has_file !== "true") return { nothing_to_do: true, state: null };
        const row = { id: `retirement-${rows.length}`, path: variables.path, state: "requested" };
        rows.push(row);
        return { id: row.id, state: row.state, resumed: false };
      }
      if (sql.includes("advance_credential_retirement")) {
        const row = rows.find((candidate) => candidate.id === variables.id);
        if (sql.includes("'file_removed'")) {
          if (row.state === "requested") row.state = "file_removed";
          return { id: row.id, state: row.state };
        }
        if (row.state === "file_removed") row.state = "recorded";
        return { id: row.id, state: row.state };
      }
      throw new Error(`unexpected SQL: ${sql}`);
    },
  };
}

test("retirement walks the durable states and finishes with the audit row", async () => {
  const directory = path.join(workdir, "retire-happy");
  mkdirSync(directory, { recursive: true });
  writeCredentials(directory, "admin-test", "a-generated-password-value");

  const db = fakeDatabase();
  const outcome = await retireCredentials({ actorId: "cli:tester", directory, run: db.run });

  assert.equal(outcome.state, "recorded");
  assert.equal(outcome.resumed, false);
  assert.equal(existsSync(credentialsPath(directory)), false);
  assert.equal(db.rows.length, 1);
  assert.equal(db.rows[0].state, "recorded");
});

test("a retirement interrupted before the audit row is finished by the next run", async () => {
  const directory = path.join(workdir, "retire-resumed");
  mkdirSync(directory, { recursive: true });
  writeCredentials(directory, "admin-test", "a-generated-password-value");

  const db = fakeDatabase();
  // A previous run unlinked the file and died before it could record that it had.
  // The database says the removal happened; the filesystem agrees; the audit row
  // is still owed.
  db.rows.push({ id: "retirement-0", path: credentialsPath(directory), state: "file_removed" });
  rmSync(credentialsPath(directory), { force: true });

  const outcome = await retireCredentials({ actorId: "cli:health-snapshot", directory, run: db.run });
  assert.equal(outcome.state, "recorded");
  assert.equal(outcome.resumed, true, "the resumed run did not report itself as a resume");
  assert.equal(db.rows[0].state, "recorded");
});

test("a retirement interrupted before the unlink is finished too", async () => {
  const directory = path.join(workdir, "retire-requested");
  mkdirSync(directory, { recursive: true });
  writeCredentials(directory, "admin-test", "a-generated-password-value");

  const db = fakeDatabase();
  db.rows.push({ id: "retirement-0", path: credentialsPath(directory), state: "requested" });

  const outcome = await retireCredentials({ actorId: "cli:health-snapshot", directory, run: db.run });
  assert.equal(outcome.state, "recorded");
  assert.equal(existsSync(credentialsPath(directory)), false, "the resumed run left the plaintext file behind");
});

test("a resumed run whose file is already gone still records the audit row", async () => {
  // The exact crash the durable state exists for: unlink succeeded, the database
  // call that would have recorded it did not.
  const directory = path.join(workdir, "retire-gone");
  mkdirSync(directory, { recursive: true });
  const db = fakeDatabase();
  db.rows.push({ id: "retirement-0", path: credentialsPath(directory), state: "requested" });

  const outcome = await retireCredentials({ actorId: "cli:health-snapshot", directory, run: db.run });
  assert.equal(outcome.state, "recorded");
  assert.equal(db.rows[0].state, "recorded");
});

test("an unfinished retirement is blocked, not completed, once the credential is live again", async () => {
  // The file reappeared under an open retirement. The state is reset so the next
  // eligible run removes it again rather than recording a removal that was undone.
  const directory = path.join(workdir, "retire-reappeared");
  mkdirSync(directory, { recursive: true });
  const db = fakeDatabase();
  db.rows.push({ id: "retirement-0", path: credentialsPath(directory), state: "file_removed" });
  writeCredentials(directory, "admin-test", "a-second-generated-password");

  const outcome = await retireCredentials({ actorId: "cli:health-snapshot", directory, run: db.run });
  assert.equal(outcome.state, "recorded");
  assert.equal(existsSync(credentialsPath(directory)), false, "the reappeared file was not removed");
});

test("retirement refuses a path it did not write, and reports an unreadable one", async () => {
  const directory = path.join(workdir, "retire-refused");
  mkdirSync(path.join(directory, CREDENTIALS_FILE), { recursive: true });
  const db = fakeDatabase();
  const refused = await retireCredentials({ actorId: "cli:tester", directory, run: db.run });
  assert.equal(refused.state, "removal_refused");
  assert.equal(refused.reason, "not a regular file");
  // It stays at `requested`: the file is still there, and a state machine that
  // recorded `file_removed` for a file it did not remove would be lying.
  assert.equal(db.rows[0].state, "requested");

  if (typeof process.getuid === "function" && process.getuid() === 0) return;
  const unreadable = path.join(workdir, "retire-unreadable");
  mkdirSync(unreadable, { recursive: true, mode: 0o700 });
  writeCredentials(unreadable, "admin-test", "a-generated-password-value");
  chmodSync(unreadable, 0o000);
  try {
    const db2 = fakeDatabase();
    const outcome = await retireCredentials({ actorId: "cli:tester", directory: unreadable, run: db2.run });
    assert.equal(outcome.state, "unreadable");
    assert.equal(outcome.error, "EACCES");
    assert.equal(db2.rows.length, 0, "an unreadable path opened a retirement");
  } finally {
    chmodSync(unreadable, 0o700);
  }
});
