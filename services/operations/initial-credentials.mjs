// The root-only credentials file written by `infra-cod admin bootstrap`.
//
// It exists because a headless install has nowhere to print a generated
// password, and it is the one plaintext secret this system ever writes to disk.
// Everything here is therefore about getting rid of it as soon as it is no
// longer the operator's only way in — and about refusing to guess when that is.
//
// Kept free of `pg` and of CLI argument parsing so both the CLI and the root
// health helper can use it, and so the decision function can be unit-tested
// without a database.

import { chmodSync, chownSync, lstatSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

export const CREDENTIALS_ENV = "INFRA_COD_CREDENTIALS_DIR";
export const DEFAULT_CREDENTIALS_DIR = "/etc/infra-cod";
export const CREDENTIALS_FILE = "initial-credentials";

export function credentialsDir(directory) {
  return directory ?? process.env[CREDENTIALS_ENV]?.trim() ?? DEFAULT_CREDENTIALS_DIR;
}

export function credentialsPath(directory) {
  return path.join(credentialsDir(directory), CREDENTIALS_FILE);
}

// Three answers, not two: present, absent, and "could not tell".
//
// Collapsing a failed read into "absent" is how a plaintext password stays on
// disk while every report says the machine is clean — an EACCES on /etc/infra-cod
// is not the same fact as no file, and only ENOENT is allowed to mean the second.
// `exists` is therefore `true`, `false`, or `null` for unknown, and every caller
// has to decide what unknown means for it (it is always "raise an alarm").
export function readCredentialsState(directory) {
  const file = credentialsPath(directory);
  try {
    // lstat, not stat: a symlink planted here must not be followed, and must not
    // be silently reported as a regular file with someone else's contents.
    const info = lstatSync(file);
    return {
      exists: true,
      path: file,
      error: null,
      symlink: info.isSymbolicLink(),
      regularFile: info.isFile(),
      mode: info.mode & 0o777,
      uid: info.uid,
      gid: info.gid,
      size: info.size,
    };
  } catch (error) {
    if (error?.code === "ENOENT") {
      return {
        exists: false, path: file, error: null, symlink: false, regularFile: false,
        mode: null, uid: null, gid: null, size: null,
      };
    }
    return {
      exists: null, path: file, error: error?.code ?? "unknown", symlink: null,
      regularFile: null, mode: null, uid: null, gid: null, size: null,
    };
  }
}

export function writeCredentials(directory, username, password) {
  const file = credentialsPath(directory);
  // 0o700 on the directory and 0o600 on the file, and the mode is re-applied
  // after writing because an existing file keeps its old permissions.
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, `username=${username}\npassword=${password}\n`, { mode: 0o600 });
  chmodSync(file, 0o600);
  let ownedByRoot = false;
  try {
    chownSync(file, 0, 0);
    ownedByRoot = true;
  } catch {
    // Only root can hand the file to root. During development the caller is not
    // root, and the file is already 0600 and owned by the invoking user.
  }
  return { file, ownedByRoot };
}

// Why the file may not be deleted yet, or null when it may be.
//
// The yes/no answer comes from `initial_credentials_status()` (0046) and nowhere
// else: re-deriving it here would be a second opinion that can drift, and the
// two places that act on it — the CLI and the root health helper — would then
// disagree about whether a plaintext password is still somebody's way in. This
// function only turns that answer into a sentence a person can read.
export function credentialsRetirement(state) {
  if (!state) return "the credential state could not be read";
  if (state.generated_password_retired === true) return null;
  // Reachable only when the database said no; the reason is for the operator.
  if (state.operator_exists !== true) return "no local operator account exists yet";
  if (state.must_change_password === true) return "the operator has not replaced the generated password yet";
  if (!state.last_login_at) return "no successful sign-in has been recorded";
  return "the generated password is not retired";
}

export function retirementConfirmed(state) {
  return state?.generated_password_retired === true;
}

// Removes the file, but only the file this module would have written. A symlink
// or a directory in its place is reported rather than deleted: whatever put it
// there was not bootstrap, and unlinking it could destroy something else. A file
// owned by somebody else is left alone too — silently deleting another account's
// secret because it had the right name would be worse than leaving it.
export function removeCredentials(directory) {
  const state = readCredentialsState(directory);
  if (state.exists === null) {
    return { removed: false, reason: `the file could not be read (${state.error})`, ...state };
  }
  if (!state.exists) return { removed: false, reason: "no credentials file", ...state };
  if (state.symlink || !state.regularFile) {
    return { removed: false, reason: "not a regular file", ...state };
  }
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  if (uid !== null && uid !== 0 && state.uid !== uid) {
    return { removed: false, reason: `owned by uid ${state.uid}`, ...state };
  }
  rmSync(state.path, { force: true });
  return { removed: true, reason: "retired", ...state };
}

// Drives `requested -> file_removed -> recorded` to completion, resuming whatever
// a previous run left behind.
//
// The filesystem and the database cannot share a transaction, so the operation is
// durable instead of atomic: each step is idempotent and recorded before the next
// one starts, which is what lets a crash between the unlink and the audit row be
// finished by the next run rather than leaving a deleted credential with no
// record of why it went.
//
// `run` is any single-statement JSON executor — the CLI's transaction runner, the
// health helper's pooled query, or a stub in a test. It is not given a
// transaction on purpose: a transaction spanning the unlink would hold a row lock
// across a filesystem call and still could not roll the unlink back.
export async function retireCredentials({ actorId, directory, run }) {
  const before = readCredentialsState(directory);
  if (before.exists === null) {
    // Never treated as "no file": an unreadable credentials file is an alarm,
    // and nothing may be recorded as retired on the strength of it.
    return { state: "unreadable", path: before.path, error: before.error };
  }

  const begun = await run(
    `SELECT begin_credential_retirement(:'path', :'actor_id', :'has_file'::boolean)::text;`,
    { path: before.path, actor_id: actorId, has_file: String(before.exists) },
  );
  if (!begun || begun.nothing_to_do === true) {
    return { state: "absent", path: before.path };
  }

  let state = String(begun.state);
  const resumed = begun.resumed === true;

  if (state === "requested") {
    const removal = removeCredentials(directory);
    // "no credentials file" is the expected outcome of a resumed run: a previous
    // one unlinked the file and died before it could record that it had.
    if (!removal.removed && removal.reason !== "no credentials file") {
      return { state: "removal_refused", reason: removal.reason, path: before.path, id: begun.id, resumed };
    }
    const advanced = await run(
      `SELECT advance_credential_retirement(:'id'::uuid, 'file_removed')::text;`,
      { id: begun.id },
    );
    state = String(advanced?.state ?? "file_removed");
  }

  if (state === "file_removed") {
    const recorded = await run(
      `SELECT advance_credential_retirement(:'id'::uuid, 'recorded', :'details'::jsonb)::text;`,
      { id: begun.id, details: JSON.stringify({ resumed, actor: actorId }) },
    );
    state = String(recorded?.state ?? "recorded");
  }

  return { state, id: begun.id, path: before.path, resumed };
}
