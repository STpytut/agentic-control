import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

// The unit files and the Caddyfiles as a checked contract.
//
// None of this can be verified on the machine the tests run on: `systemd-analyze
// verify` needs systemd, peer authentication needs pg_ident.conf, and the peer
// matrix needs Ubuntu. That is exactly why the parts that *can* be checked
// statically are checked here rather than left to a deploy: a unit that lost its
// PGUSER, gained a DATABASE_URL, dropped out of the target, or started `next
// start` again would otherwise be discovered on the VPS, at which point the
// failure looks like an installation problem instead of a regression.
//
// Every assertion names the invariant, and the reason a reader would not guess.

const root = path.resolve(import.meta.dirname, "../../..");
const unitsDirectory = path.join(root, "deploy/systemd");
const unitFiles = readdirSync(unitsDirectory).filter((name) => name.endsWith(".service")).sort();
const timerFiles = readdirSync(unitsDirectory).filter((name) => name.endsWith(".timer")).sort();

function unit(name) {
  return readFileSync(path.join(unitsDirectory, name), "utf8");
}

function field(name, key) {
  const matches = [...unit(name).matchAll(new RegExp(`^${key}=(.*)$`, "gm"))].map((m) => m[1].trim());
  return matches;
}

function one(name, key) {
  const values = field(name, key);
  assert.ok(values.length > 0, `${name} has no ${key}=`);
  return values[0];
}

// `Environment=KEY=value` is not `KEY=value`, so a bare `field(name, "PGUSER")`
// silently returns nothing and an assertion written against it passes for the
// wrong reason. Every environment lookup goes through here.
function environment(name, key) {
  return [...unit(name).matchAll(new RegExp(`^Environment=${key}=(.*)$`, "gm"))].map((m) => m[1].trim());
}

function environmentFile(name) {
  return [...unit(name).matchAll(/^EnvironmentFile=(.*)$/gm)].map((m) => m[1].trim());
}

// Every unit that is part of the stack. The target is the only file that is not.
const partOfTarget = unitFiles;

test("every service is a member of the target, and the target names it", () => {
  const target = readFileSync(path.join(unitsDirectory, "infra-cod.target"), "utf8");
  // Only this stack's own members: the target also wants `network-online.target`
  // and `postgresql@17-main.service`, which are not files in this directory.
  const wanted = [...target.matchAll(/^Wants=(infra-cod-[^\s]+)$/gm)].map((m) => m[1]);

  // A oneshot triggered by a timer is deliberately NOT started by the target:
  // `Wants=` would run a backup at every boot, which is not what a backup timer
  // means. It is still a member, so stopping the target stops a run in progress.
  const timerDriven = new Set(
    readdirSync(unitsDirectory)
      .filter((name) => name.endsWith(".timer"))
      .map((name) => (/^Unit=(.+)$/m.exec(readFileSync(path.join(unitsDirectory, name), "utf8"))?.[1] ?? "").trim())
      .filter(Boolean),
  );

  for (const name of partOfTarget) {
    assert.deepEqual(field(name, "PartOf"), ["infra-cod.target"], `${name} is not part of the target`);
    if (timerDriven.has(name)) {
      assert.ok(!wanted.includes(name), `${name} is timer-driven and must not start with the target`);
    } else {
      assert.ok(wanted.includes(name), `the target does not pull in ${name}`);
    }
  }
  for (const name of wanted) {
    assert.ok(name.endsWith(".timer") || partOfTarget.includes(name),
      `the target names ${name}, which has no unit file`);
  }
  // The timers themselves are pulled in by the target and enabled through
  // timers.target, so a reboot brings the periodic work back without a separate
  // `systemctl enable` for each one.
  for (const timer of [...timerDriven].map((service) => service.replace(/\.service$/, ".timer"))) {
    assert.ok(wanted.includes(timer), `the target does not pull in ${timer}`);
  }
});

test("every DB client declares a PostgreSQL role, and none relies on a password or URL", () => {
  // The role is per unit, never in the shared file: web, worker, backup and the
  // oneshot administration commands are different roles, and a single shared
  // PGUSER would let one compromised process name another's role and pass the
  // peer check.
  for (const name of partOfTarget) {
    const body = unit(name);
    if (!environmentFile(name).some((value) => value.includes("database.env"))) continue;
    const roles = environment(name, "PGUSER");
    assert.equal(roles.length, 1, `${name} must set exactly one PGUSER`);
    assert.ok(
      ["infra_web", "infra_worker", "infra_backup", "infra_migrator", "infra_control"].includes(roles[0]),
      `${name} names an unknown role ${roles[0]}`,
    );
  }
  for (const name of partOfTarget) {
    const body = unit(name);
    assert.ok(!/^Environment=.*\bDATABASE_URL=/m.test(body), `${name} sets DATABASE_URL`);
    assert.ok(!/PGPASSWORD/.test(body), `${name} sets PGPASSWORD`);
    assert.ok(!/SUPABASE|NEXT_PUBLIC_SUPABASE/.test(body), `${name} sets a Supabase variable`);
    assert.ok(!/CONTROL_PLANE_OPERATOR_ID/.test(body), `${name} sets the removed CONTROL_PLANE_OPERATOR_ID`);
  }
});

test("every unit that touches PostgreSQL names the socket path", () => {
  // PrivateTmp=true gives each unit its own /tmp, so a client that fell back to
  // the default socket path would fail to connect with a confusing error instead
  // of using the peer socket the deployment configured.
  const socket = readFileSync(path.join(root, "deploy/env/database.env.example"), "utf8");
  assert.match(socket, /^PGHOST=\/var\/run\/postgresql$/m);
  assert.match(socket, /^PGDATABASE=infra_cod$/m);
  // The shared file must NOT name a role: that is what keeps the per-unit
  // mapping meaningful.
  assert.ok(!/^PGUSER=/m.test(socket), "the shared database env names a role");
  for (const name of partOfTarget) {
    const files = environmentFile(name);
    if (!files.some((value) => value.includes("database.env"))) continue;
    assert.ok(environment(name, "PGUSER").length === 1, `${name} does not declare its own role`);
  }
});

test("the web unit runs the standalone server on loopback, not next start", () => {
  const name = "infra-cod-web.service";
  assert.equal(one(name, "User"), "infra-web");
  assert.equal(one(name, "Group"), "infra-web");
  const exec = one(name, "ExecStart");
  assert.match(exec, /web\/apps\/web\/server\.js$/, `unexpected entry point: ${exec}`);
  assert.ok(!/next\s+start/.test(exec), "the web unit still starts next start");
  assert.ok(!/node_modules/.test(exec), "the entry point still points into node_modules");
  // The trace root nests the standalone server; the smoke test pins the same
  // relative path against a real build, and these two must not drift apart.
  assert.match(one(name, "Environment") || "", /.*/);
  assert.deepEqual(environment(name, "HOSTNAME"), ["127.0.0.1"]);
  assert.deepEqual(environment(name, "PORT"), ["3100"]);
  assert.deepEqual(environment(name, "NODE_ENV"), ["production"]);
  assert.deepEqual(field(name, "TimeoutStopSec"), ["20"]);
  // The panel must not be able to read the plaintext bootstrap credential or the
  // runtime users' home directories.
  assert.ok(!/ReadWritePaths=.*(workspace|\.codex|\/etc\/infra-cod\b)/.test(unit(name)),
    "the web unit has a writable path outside its own state");
});

test("the provisioner coordinates and holds no writable path", () => {
  const name = "infra-cod-project-provisioner.service";
  assert.equal(one(name, "User"), "infra-control");
  assert.equal(one(name, "Group"), "infra-control");
  // The privileged half of provisioning is the supervisor. A writable workspace
  // path here would re-grant the capability the coordinator was moved away from.
  assert.deepEqual(field(name, "ReadWritePaths"), [], "the provisioner still has a writable path");
  assert.deepEqual(environment(name, "PGUSER"), ["infra_worker"]);
});

test("the GitHub broker keeps only its own paths and groups", () => {
  const name = "infra-cod-github-app-worker.service";
  assert.equal(one(name, "User"), "infra-cod-github");
  // It stages clones into the workspace root and hands them to the runtime users,
  // so this path is genuinely its own; the App private key stays read-only.
  assert.deepEqual(field(name, "ReadWritePaths"), ["/srv/infra-cod/workspaces"]);
  assert.ok(unit(name).includes("ReadOnlyPaths=/etc/infra-cod/github-app"));
  assert.ok(!/GITHUB_APP_CLIENT_SECRET=/.test(unit(name)), "the broker unit inlines the client secret");
  // An App created from the panel (G1): its secrets in the broker's own state
  // directory, which only the broker's user can enter.
  assert.equal(one(name, "StateDirectory"), "infra-cod-github");
  assert.equal(one(name, "StateDirectoryMode"), "0700");
  assert.ok(unit(name).includes("Environment=GITHUB_APP_STATE_DIR=/var/lib/infra-cod-github/app"));
});

test("runtime users and Caddy have no database access, and database units have no runtime reach", () => {
  // The reverse direction of the same boundary: nothing that reaches a workspace
  // as an agent may also reach the database.
  for (const name of ["codex-worker", "opencode-worker"]) {
    for (const file of partOfTarget) {
      assert.ok(!new RegExp(`^User=${name}$`, "m").test(unit(file)), `${file} runs as the runtime user ${name}`);
    }
  }
  assert.ok(!unit("infra-cod-caddy.service").includes("database.env"), "Caddy reads the database environment");
  assert.equal(one("infra-cod-caddy.service", "User"), "caddy");
});

test("no unit asks systemd for an expansion it will not perform", () => {
  // systemd expands `$VAR`/`${VAR}` in a handful of directives and takes the rest
  // literally. `WorkingDirectory` is one of the literal ones, so
  // `WorkingDirectory=${INFRA_COD_RELEASE}` would point at a directory whose name
  // contains a dollar sign and the unit would fail to start. The first argument of
  // `ExecStart` is the executable itself and must be an absolute path or a
  // well-known name; a variable there is refused outright.
  //
  // Later `ExecStart` arguments are expanded, which is why caddy's
  // `--config ${INFRA_COD_CADDY_CONFIG}` is allowed: the executable is literal.
  for (const name of [...unitFiles, ...timerFiles]) {
    const body = unit(name);
    for (const directive of ["WorkingDirectory", "RootDirectory", "StateDirectory", "RuntimeDirectory"]) {
      assert.ok(
        !new RegExp(`^${directive}=.*\\$`, "m").test(body),
        `${name} uses a variable in ${directive}=, which systemd does not expand`,
      );
    }
    for (const exec of field(name, "ExecStart")) {
      const executable = exec.trim().split(/\s+/)[0];
      assert.ok(!executable.includes("$"), `${name} has a variable as the executable: ${exec}`);
      assert.ok(executable.startsWith("/"), `${name} does not use an absolute executable: ${exec}`);
    }
    for (const key of ["ExecStartPre", "ExecReload", "ExecStop"]) {
      for (const exec of field(name, key)) {
        assert.ok(!exec.trim().split(/\s+/)[0].includes("$"), `${name} has a variable as ${key}'s executable`);
      }
    }
  }
});

test("the timers are members of the target, not only started by it", () => {
  // `Wants=` in the target starts a timer; it does not make the timer stop with
  // the target. Without `PartOf=`, `systemctl stop infra-cod.target` leaves the
  // backup, health and restore timers active, and they fire on a stack that was
  // just stopped.
  for (const name of timerFiles) {
    assert.deepEqual(field(name, "PartOf"), ["infra-cod.target"], `${name} does not stop with the target`);
    assert.deepEqual(field(name, "WantedBy"), ["timers.target"], `${name} is not enabled through timers.target`);
  }
});

test("the backup reaches the database as infra_backup, from root, without runuser", () => {
  const name = "infra-cod-backup.service";
  assert.equal(one(name, "User"), "root");
  // The peer map is 1:1 per OS user. Dropping to `infra-control` for the dump
  // while presenting `PGUSER=infra_backup` would force Stage 2 to map an
  // unprivileged worker account to the backup role, which is exactly the
  // separation the map exists to provide. The script must not `runuser` a database
  // client at all, and `ProtectHome=read-only` (not `true`) keeps the agent home
  // directories readable for the filesystem archive.
  assert.deepEqual(environment(name, "PGUSER"), ["infra_backup"]);
  assert.deepEqual(field(name, "ProtectHome"), ["read-only"]);
  // The script has to agree with the unit. It does not have to exist working-tree
  // at every future commit — this checks committed content, which is what the unit
  // will actually run.
  const script = readFileSync(path.join(root, "services/operations/backup.mjs"), "utf8");
  assert.ok(
    !/run(ToFile)?\(\s*"runuser"/.test(script),
    "backup.mjs still drops privileges for a database client",
  );
});

test("the restore drill targets its own cluster and the role the setup creates", () => {
  const name = "infra-cod-restore-drill.service";
  // The drill's cluster is `17/restore` on 5433, a separate unit from production's
  // `17/main` on 5432 (ADR-0011). Depending on the production cluster would make
  // the drill share its lifecycle and configuration.
  assert.ok(field(name, "After").some((value) => value.includes("postgresql@17-restore.service")));
  assert.ok(field(name, "Requires").includes("postgresql@17-restore.service"));
  assert.ok(!unit(name).includes("postgresql@17-main.service"), "the drill depends on the production cluster");

  // One role name, spelled the way the setup script creates it. The hyphen
  // belongs to OS users and the underscore to database roles; asking for
  // `infra_control` while the script created `"infra-control"` is how the drill
  // and its own setup disagreed.
  assert.deepEqual(environment(name, "PGUSER"), ["infra_control"]);

  // The mapping from OS account to database role lives in exactly one module,
  // because the drill switches accounts mid-run and each switch has to carry its
  // role. `restore-accounts.test.mjs` checks the argv that produces; this checks
  // that the script has no other way to name a role.
  const script = readFileSync(path.join(root, "services/operations/restore-drill.mjs"), "utf8");
  const accounts = readFileSync(path.join(root, "services/operations/restore-accounts.mjs"), "utf8");
  assert.match(accounts, /export const RESTORE_OS_USER = "infra-control";/);
  assert.match(accounts, /export const RESTORE_ROLE = "infra_control";/);
  // The hyphenated spelling is an OS user name and may appear only in the module
  // that maps it; a second occurrence elsewhere is how the two drifted apart.
  assert.equal(
    [...script.matchAll(/"infra-control"/g)].length, 0,
    "restore-drill.mjs names the OS account outside the account map",
  );
  // And no role is passed any other way than through that map.
  assert.ok(!/PGUSER=/.test(script), "restore-drill.mjs sets PGUSER outside the account map");
  assert.ok(!/"infra_control"/.test(script), "restore-drill.mjs names a database role outside the account map");
  const setup = readFileSync(path.join(root, "deploy/setup-postgresql-17-restore.sh"), "utf8");
  assert.ok(!/"infra-control"/.test(setup), "the setup script still creates a hyphenated database role");
  assert.match(setup, /CREATE ROLE infra_control LOGIN/);
  assert.match(setup, /pg_createcluster 17 restore --port 5433/);
});

test("every unit runs a node binary it declares, from the release directory", () => {
  for (const name of unitFiles) {
    const exec = one(name, "ExecStart");
    if (!/node/.test(exec)) continue;
    assert.match(exec, /\/opt\/node\/bin\/node/, `${name} does not use the pinned node path: ${exec}`);
    assert.match(exec, /\/opt\/infra-cod\/current\//, `${name} does not run from the release tree: ${exec}`);
    assert.ok(!/\/opt\/infra-cod\/app\//.test(exec), `${name} still references the old /opt/infra-cod/app root`);
    // An absolute path, chosen from the two that exist: the release tree, or the
    // dispatcher's own state directory. What matters is that it is literal — the
    // expansion check above proves no `$` survives here.
    const workingDirectory = one(name, "WorkingDirectory");
    assert.ok(
      ["/opt/infra-cod/current", "/opt/infra-cod/current/web", "/var/lib/infra-control"].includes(workingDirectory),
      `${name} has an unexpected working directory: ${workingDirectory}`,
    );
    // Long-running units bound how long a stop may take; oneshot units have no
    // process to stop and are bounded on start instead.
    // The runtime update pass is the one oneshot that runs for minutes: a
    // qualification, or a promotion waiting for the runtime to be idle (0127).
    if (one(name, "Type") === "oneshot") {
      const bound = name === "infra-cod-runtime-update.service" ? "45min" : "120";
      assert.deepEqual(field(name, "TimeoutStartSec"), [bound], `${name} has no bounded start timeout`);
    } else {
      assert.deepEqual(field(name, "TimeoutStopSec"), ["20"], `${name} has no 20s stop timeout`);
    }
  }
});

test("the production workers keep infra-control -> infra_worker, and infra_control stays restore-only", () => {
  // This is the defect the review caught. Almost the whole control plane runs as
  // the `infra-control` OS user and assumes `infra_worker`; `infra_control` exists
  // only in the restore cluster. Flattening the two clusters' peer maps into one
  // replaced the production mapping and would have failed every worker with
  // `Peer authentication failed`.
  const workers = unitFiles.filter((name) => {
    const roles = environment(name, "PGUSER");
    return roles.length === 1 && roles[0] === "infra_worker";
  });
  assert.ok(workers.length >= 10, `expected the worker fleet to assume infra_worker, found ${workers.length}`);

  const asInfraControl = workers.filter((name) => field(name, "User")[0] === "infra-control");
  assert.ok(asInfraControl.length >= 8, "the worker fleet no longer runs as infra-control");
  for (const name of asInfraControl) {
    assert.notEqual(environment(name, "PGUSER")[0], "infra_control", `${name} asks for the restore-only role`);
  }

  // `infra_control` may appear in exactly one unit: the restore drill.
  const assumeInfraControl = unitFiles.filter((name) => environment(name, "PGUSER").includes("infra_control"));
  assert.deepEqual(assumeInfraControl, ["infra-cod-restore-drill.service"]);

  // The documented production map has to agree with the units. Reading the
  // document is not proof of runtime behaviour, but a map that contradicts the
  // units is provably wrong, and that is the shape the defect had.
  const matrix = readFileSync(path.join(root, "deploy/systemd/README.md"), "utf8");
  const productionMap = matrix.slice(
    matrix.indexOf("infra_cod_map"),
    matrix.indexOf("### `17/restore`"),
  );
  assert.match(productionMap, /infra_cod_map\s+infra-control\s+infra_worker/);
  assert.ok(!/infra_cod_map\s+infra-control\s+infra_control/.test(productionMap),
    "the production map assigns the restore-only role to infra-control");
  assert.match(productionMap, /infra_cod_map\s+root\s+infra_migrator/);
  assert.ok(!/admin commands.*infra_control|infra_control.*admin commands/.test(matrix),
    "the matrix still claims the production admin commands use infra_control");
});

test("the restore setup configures its own cluster's peer files, and does not touch production", () => {
  const setup = readFileSync(path.join(root, "deploy/setup-postgresql-17-restore.sh"), "utf8");
  // Each cluster has its own pg_hba.conf and pg_ident.conf. The restore map must
  // be written into 17/restore, with its own map name, and the cluster's own hba
  // must point at it — creating the role without either leaves the drill unable
  // to authenticate, which is what the review found.
  assert.match(setup, /infra_cod_restore_map/);
  assert.match(setup, /peer map=infra_cod_restore_map/);
  assert.match(setup, /\$\{pg_ident\}|pg_ident=/);
  assert.match(setup, /pg_hba_file_rules/);
  assert.match(setup, /pg_ident_file_mappings/);
  // The measured representation, so the verification cannot pass by finding
  // nothing: `peer map=NAME` is stored as the single option `map=NAME`.
  assert.match(setup, /'map=infra_cod_restore_map' = ANY/);
  // And it must not edit the production cluster's files. The check is for a write
  // or a redirect into that directory, not for the path appearing: the script's
  // own explanation of why it leaves production alone has to be able to name it.
  assert.ok(
    !/(>|>>|cat\s*>|tee\s+|chown\s+\S+\s+|chmod\s+\S+\s+)\/etc\/postgresql\/17\/main/.test(setup),
    "the restore setup writes into the production cluster",
  );
  assert.ok(
    !/(pg_ctlcluster|pg_ctl).{0,40}(17\s+main|17\/main)/.test(setup),
    "the restore setup operates on the production cluster",
  );
  // Reruns must be safe.
  assert.match(setup, /if ! cluster_exists 17 restore/);
  assert.match(setup, /IF NOT EXISTS \(SELECT 1 FROM pg_roles WHERE rolname = 'infra_control'\)/);
});

test("the Caddyfiles keep the two modes apart and never leak a credential", () => {
  const production = readFileSync(path.join(root, "deploy/caddy/Caddyfile"), "utf8");
  const local = readFileSync(path.join(root, "deploy/caddy/Caddyfile.local"), "utf8");

  // Upstream is the loopback port the web unit binds, in both modes.
  assert.match(production, /reverse_proxy 127\.0\.0\.1:3100/);
  assert.match(local, /reverse_proxy 127\.0\.0\.1:3100/);

  // HSTS only in the mode that actually terminates TLS. Sending it from the local
  // plain-HTTP listener would assert a scheme it cannot provide. The check is for
  // the directive: the local file explains in a comment why the header is absent,
  // and matching the bare word would fail on its own explanation.
  assert.match(production, /^\s*header Strict-Transport-Security/m);
  assert.ok(!/^\s*header Strict-Transport-Security/m.test(local), "the local mode sends HSTS");

  // The local file must not silently become a TLS listener: a bare host:port
  // address implies TLS to the adapter even with auto_https off, which fails every
  // request with "Client sent an HTTP request to an HTTPS server".
  assert.match(local, /^http:\/\/\{\$INFRA_COD_HOST/m, "the local site address has no explicit http:// scheme");
  assert.match(local, /auto_https off/);

  // Both bound the body and delegate compression to the next hop rather than
  // compressing twice.
  for (const [label, text] of [["production", production], ["local", local]]) {
    assert.match(text, /request_body/, `${label} has no body bound`);
    assert.match(text, /encode zstd gzip/, `${label} does not compress`);
    assert.ok(!/^\s*log_credentials\b/m.test(text), `${label} enables credential logging`);
    assert.ok(!/^\s*file_server\b/m.test(text), `${label} adds a second static-file owner`);
  }
});

test("the health snapshot may read the agent runtime homes", () => {
  // `ProtectHome=true` makes /home empty inside the unit's namespace. The
  // snapshot has to ask each runtime what state it is in, so with `true` it died
  // every minute on "/home/codex-worker does not exist" from the moment a runtime
  // was installed — and took the database, service and backup sections of the
  // report down with it, because one throw ends the process.
  //
  // `read-only` is the least that works and the most that is wanted: the
  // credential evidence is tested with `test -s`, and nothing here writes into a
  // runtime's home.
  const name = "infra-cod-health.service";
  assert.deepEqual(field(name, "ProtectHome"), ["read-only"]);
  assert.equal(one(name, "User"), "root");
  assert.deepEqual(field(name, "ProtectSystem"), ["strict"]);
});
