import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// Which database role each restore client asks for.
//
// This is a cross-module property, which is why it is easy to get wrong: the role
// a client requests comes from `PGUSER`, the environment the unit sets;
// `runuser --preserve-environment` keeps that variable when the drill drops to
// `postgres`; and the restore cluster's `pg_ident.conf` maps `postgres → postgres`
// and `infra-control → infra_control`. Each of those three looked right on its own
// when the drill was broken — the unit named a role, the map named a pair, the
// script named a user — and together they produced `Peer authentication failed`
// on the drill's first statement.
//
// The pairing is asserted two ways, because either one alone can be satisfied
// while the drill is wrong:
//
//   * the argv the exported builder produces for each named client, including the
//     `-U` flag and the `PGUSER` assignment; and
//   * the script's own call sites, which must name a client from that map and
//     place the program through `PROGRAM` — so a call site cannot pair one
//     account with another client's executable.

const root = new URL("../../../", import.meta.url);
const {
  CLIENTS, PROGRAM, RESTORE_OS_USER, RESTORE_ROLE,
  accountFor, asUser, clientArgs, clientFor, environmentFor,
} = await import(new URL("services/operations/restore-accounts.mjs", root));

const drillSource = readFileSync(new URL("services/operations/restore-drill.mjs", root), "utf8");

// Every client the drill starts, taken from the map the script itself consumes.
// Restating the list by hand is what would let a call site drift without a test
// noticing.
const CLIENT_NAMES = Object.keys(CLIENTS);

test("the account map is the one the restore cluster's pg_ident.conf declares", () => {
  assert.deepEqual(accountFor("postgres"), { role: "postgres", home: "/var/lib/postgresql" });
  assert.deepEqual(accountFor(RESTORE_OS_USER), { role: RESTORE_ROLE, home: "/var/lib/infra-control" });
  assert.equal(RESTORE_OS_USER, "infra-control");
  assert.equal(RESTORE_ROLE, "infra_control");
  // An OS account with no mapping must be an error, not a silent guess: a fallback
  // would pick some role and only fail much later, on a host with a peer map.
  assert.throws(() => accountFor("infra-web"), /no database role is mapped/);
  assert.throws(() => asUser("codex-worker", "psql"), /no database role is mapped/);
  assert.throws(() => clientFor("no-such-client"), /unknown restore client/);
});

test("every named client pins its role in the argv, both as -U and in the environment", () => {
  for (const name of CLIENT_NAMES) {
    const client = clientFor(name);
    const argv = clientArgs(name, [PROGRAM, "-c", "SELECT 1"], { binDirectory: "/usr/lib/postgresql/17/bin" });

    // The shape runuser is invoked with. `--preserve-environment` is the reason
    // this matters: without an explicit override, the unit's PGUSER=infra_control
    // survives the switch to postgres.
    assert.equal(argv[0], "--preserve-environment", `${name}: unexpected runuser flags`);
    assert.equal(argv[1], "-u", `${name}: the account is not selected with -u`);
    assert.equal(argv[2], client.user, `${name}: runs as ${argv[2]}, expected ${client.user}`);
    assert.deepEqual(argv.slice(3, 5), ["--", "/usr/bin/env"], `${name}: env is not the command`);

    // The executable is the client's own command, resolved through the directory
    // the unit provides — and it appears exactly once. `PROGRAM` marks the position
    // so a reader can see where the program belongs, but it is removed before the
    // argv is built: substituting it as an argument put the path in the argv twice,
    // and a client reads its second copy as a database name.
    const executable = `/usr/lib/postgresql/17/bin/${client.command}`;
    assert.equal(
      argv.filter((value) => value === executable).length, 1,
      `${name}: ${executable} appears ${argv.filter((value) => value === executable).length} times in ${JSON.stringify(argv)}`,
    );
    assert.ok(!argv.includes(PROGRAM), `${name}: the ${PROGRAM} placeholder reached the argv`);

    // The exact tail, which is what the client parses: the program, then `-U`, then
    // the role, then the first real argument. `-U <role>` is what libpq obeys even
    // if the environment disagrees, and the environment is set to the same value so
    // nothing can inherit the other one.
    const start = argv.indexOf(executable);
    assert.deepEqual(
      argv.slice(start),
      [executable, "-U", client.role, "-c", "SELECT 1"],
      `${name}: unexpected argv tail ${JSON.stringify(argv.slice(start))}`,
    );
    assert.ok(argv.includes(`PGUSER=${client.role}`), `${name}: PGUSER is not ${client.role}`);
    // Nothing precedes the program except the runuser invocation and the pinned
    // environment, so the client is handed no argument it did not ask for.
    assert.deepEqual(
      argv.slice(0, start),
      ["--preserve-environment", "-u", client.user, "--", "/usr/bin/env",
        `HOME=${environmentFor(client.user).HOME}`, `PGUSER=${client.role}`],
      `${name}: unexpected argv prefix ${JSON.stringify(argv.slice(0, start))}`,
    );

    assert.equal(environmentFor(client.user).PGUSER, client.role, `${name}: environmentFor disagrees`);
  }
});

test("no client can request a role its own OS account is not entitled to", () => {
  // The specific defect: a client started as `postgres` requesting `infra_control`.
  // Several clients share an account (`postgres` runs four of them), so the
  // invariant is not "every client has a unique role" — it is that the requested
  // role is always the one this client's own account maps to, and that the
  // generated argv offers no way to ask for a role the account does not own.
  for (const name of CLIENT_NAMES) {
    const client = clientFor(name);
    const argv = clientArgs(name, [PROGRAM], {});
    const requested = argv[argv.indexOf("-U") + 1];
    const fromEnvironment = argv.find((value) => value.startsWith("PGUSER="))?.slice("PGUSER=".length);

    assert.equal(requested, accountFor(client.user).role, `${name} requested ${requested}`);
    assert.equal(fromEnvironment, accountFor(client.user).role, `${name} had PGUSER=${fromEnvironment}`);
  }

  // Every role reachable through the client map is reachable only from the
  // accounts that map to it, and both accounts in the restore cluster are used.
  const byRole = new Map();
  for (const name of CLIENT_NAMES) {
    const client = clientFor(name);
    if (!byRole.has(client.role)) byRole.set(client.role, new Set());
    byRole.get(client.role).add(client.user);
  }
  assert.deepEqual([...byRole.keys()].sort(), ["infra_control", "postgres"]);
  // No user may appear under two roles, which is the property peer authentication
  // is built on: `runuser -u` selects one account, and that account maps one role.
  for (const [role, users] of byRole) {
    for (const user of users) {
      assert.equal(accountFor(user).role, role, `${user} is used as ${role} and as ${accountFor(user).role}`);
    }
  }
});

test("the drill's call sites name a client, place the program, and use no other route", () => {
  // This is the link between the map and the script. A call site that hand-wrote a
  // role, or that paired `postgres` with `pg_restore`, fails here even though the
  // builder itself is correct.
  const calls = [...drillSource.matchAll(/clientArgs\(\s*"([A-Za-z]+)"\s*,\s*\[([\s\S]*?)\]\s*(?:,\s*clientOptions\s*)?\)/g)];
  assert.ok(calls.length >= 6, `expected every client call to name a client, found ${calls.length}`);

  for (const [, name, body] of calls) {
    assert.ok(CLIENT_NAMES.includes(name), `call site names an unknown client ${name}`);
    assert.ok(body.includes("PROGRAM"), `${name} does not place the program through PROGRAM`);
  }

  // The two that were swapped in review: creating the database is `postgres` work,
  // restoring into it is not, and neither can be expressed by the other's client.
  assert.equal(clientFor("createDatabase").user, "postgres");
  assert.equal(clientFor("createDatabase").command, "createdb");
  assert.equal(clientFor("restoreDump").user, RESTORE_OS_USER);
  assert.equal(clientFor("restoreDump").command, "pg_restore");
  assert.equal(clientFor("dropDatabase").user, "postgres");

  // And the script has no other way to start a database client or name a role.
  const runuserCalls = [...drillSource.matchAll(/run(?:ToFile|WithInputFile)?\(\s*"runuser"\s*,\s*([A-Za-z]+)\(/g)];
  assert.equal(runuserCalls.length, calls.length, "a runuser call does not go through clientArgs");
  for (const [match, builder] of runuserCalls) {
    assert.equal(builder, "clientArgs", `a client is started with ${builder} instead of clientArgs: ${match}`);
  }
  assert.ok(!/PGUSER=/.test(drillSource), "the drill sets PGUSER outside the account map");
  assert.ok(!/"infra-control"/.test(drillSource), "the drill names the OS account outside the account map");
  assert.ok(!/"infra_control"/.test(drillSource), "the drill names the database role outside the account map");
  assert.ok(!/postgresCommand\(/.test(drillSource), "the drill resolves a client executable outside the map");
});
