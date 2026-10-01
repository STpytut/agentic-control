// Which database role each OS account in the restore drill may assume, and the
// argv that guarantees it.
//
// This is its own module because it is the part of the drill that is easy to get
// wrong in a way nothing notices: the role a client asks for comes from `PGUSER`,
// which this process inherits from its unit, while peer authentication decides the
// role from the connecting OS user through the cluster's map. When those two
// disagree the connection is refused — and the failure only appears on a VPS with
// a configured `pg_ident.conf`.
//
// The restore cluster maps exactly two accounts:
//
//   postgres      -> postgres        (create the throwaway database, extensions)
//   infra-control -> infra_control   (restore into it, read it back)
//
// `runuser --preserve-environment` keeps the unit's `PGUSER=infra_control`, so a
// client started as `postgres` would request `infra_control` and be refused by a
// map that grants only `postgres → postgres`. Every invocation therefore states
// its role in both the environment and the command line, and an unknown OS user is
// a hard error rather than a silent fallback.

export const RESTORE_OS_USER = "infra-control";
export const RESTORE_ROLE = "infra_control";

const ACCOUNTS = {
  postgres: { role: "postgres", home: "/var/lib/postgresql" },
  [RESTORE_OS_USER]: { role: RESTORE_ROLE, home: "/var/lib/infra-control" },
};

// The client invocations the drill makes, by name. Identity — which OS account
// runs it, which executable it is, which role it assumes — lives here rather than
// at the call sites, which is what lets a test check the pairings against the
// script instead of restating them.
// The placeholder a call site puts where the executable belongs.
export const PROGRAM = "PROGRAM";

export const CLIENTS = {
  versionQuery: { user: "postgres", command: "psql", operation: "read the restore target's version" },
  createDatabase: { user: "postgres", command: "createdb", operation: "create the throwaway database" },
  createExtensions: { user: "postgres", command: "psql", operation: "install pgcrypto into extensions" },
  restoreDump: { user: RESTORE_OS_USER, command: "pg_restore", operation: "restore the control-plane dump" },
  verificationRead: { user: RESTORE_OS_USER, command: "psql", operation: "read the restored counts" },
  dropDatabase: { user: "postgres", command: "dropdb", operation: "remove the throwaway database" },
};

export function clientFor(name) {
  const client = CLIENTS[name];
  if (!client) throw new Error(`unknown restore client: ${name}`);
  return { ...client, role: accountFor(client.user).role };
}

// The full argv for a named client. The account and the executable both come from
// the map, so a call site cannot pair one account with another client's executable.
//
// The call site writes `PROGRAM` where the program belongs, in its own argument
// list, and that placeholder is **removed** here rather than substituted: `asUser`
// already places the executable as the program, so substituting it as well put the
// path in the argv twice — `psql -U postgres /usr/lib/.../psql …` — and the second
// copy was then read by the client as an argument, as a database name for `psql`
// and `createdb` and as a stray operand for `pg_restore`. The placeholder marks
// the position for a reader and is asserted to be present exactly once; it is not
// an argument.
export function clientArgs(name, args = [], { binDirectory = "" } = {}) {
  const client = clientFor(name);
  const markers = args.filter((value) => value === PROGRAM).length;
  if (markers !== 1) {
    throw new Error(`the ${name} call site must place exactly one ${PROGRAM}, found ${markers}`);
  }
  const executable = binDirectory ? `${binDirectory}/${client.command}` : client.command;
  const commandArgs = args.filter((value) => value !== PROGRAM);
  return asUser(client.user, executable, commandArgs);
}

export function accountFor(user) {
  const account = ACCOUNTS[user];
  if (!account) throw new Error(`no database role is mapped for the OS user ${user}`);
  return account;
}

// The arguments for `runuser`: drop to `user`, keep the rest of the environment,
// and pin the database role twice.
//
// `-U <role>` is the documented way for psql/pg_restore/createdb/dropdb to name
// the role, and libpq gives it precedence over `PGUSER`. Setting `PGUSER` to the
// same value as well means a command built by some later code path cannot inherit
// the unit's value by accident.
export function asUser(user, command, args = []) {
  const account = accountFor(user);
  return [
    "--preserve-environment", "-u", user, "--", "/usr/bin/env",
    `HOME=${account.home}`,
    `PGUSER=${account.role}`,
    command, "-U", account.role, ...args,
  ];
}

// The same binding expressed as the environment a child would see, for tests and
// for reasoning about what survives `--preserve-environment`.
export function environmentFor(user) {
  const account = accountFor(user);
  return { HOME: account.home, PGUSER: account.role };
}
