import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "../../..");
const scriptPath = path.join(root, "deploy/setup-postgresql-production.sh");
const script = readFileSync(scriptPath, "utf8");
const migrationScriptPath = path.join(root, "deploy/run-production-migrations.sh");
const migrationScript = readFileSync(migrationScriptPath, "utf8");

function heredoc(label) {
  const match = new RegExp(`<<'${label}'\\n([\\s\\S]*?)\\n${label}(?:\\n|$)`).exec(script);
  assert.ok(match, `missing ${label} heredoc`);
  return match[1];
}

test("the production PostgreSQL provisioner is valid Bash and fails closed", () => {
  const parsed = spawnSync("bash", ["-n", scriptPath], { encoding: "utf8" });
  assert.equal(parsed.status, 0, parsed.stderr);
  assert.match(script, /^set -euo pipefail$/m);
  assert.match(script, /if \[\[ \$\{EUID\} -ne 0 \]\]/);
  assert.match(script, /port \$\{PG_PORT\} belongs to PostgreSQL cluster/);
  assert.match(script, /contains unrelated database/);
  assert.match(script, /does not use its private primary group/);
  assert.match(script, /has interactive shell/);
  assert.match(script, /remove_exact_line "\$\{CONF_DIR\}\/pg_hba\.conf" "include_dir 'pg_hba\.conf\.d'"/);
  assert.match(script, /systemctl is-active --quiet/);
});

test("the production cluster identity and network policy are explicit", () => {
  assert.match(script, /readonly PG_MAJOR=17/);
  assert.match(script, /readonly CLUSTER_NAME=main/);
  assert.match(script, /readonly PG_PORT=5432/);
  assert.match(script, /readonly PG_SOCKET=\/var\/run\/postgresql/);

  const hba = heredoc("HBA");
  assert.match(hba, /^local\s+all\s+all\s+peer map=infra_cod_map$/m);
  assert.match(hba, /^local\s+replication\s+all\s+peer map=infra_cod_map$/m);
  assert.match(hba, /^host\s+all\s+all\s+127\.0\.0\.1\/32\s+reject$/m);
  assert.match(hba, /^host\s+all\s+all\s+::1\/128\s+reject$/m);
  assert.match(script, /ensure_include_first "\$\{CONF_DIR\}\/pg_hba\.conf" "include_dir pg_hba\.conf\.d"/);
  assert.ok(!/ensure_include_first[^\n]+include_dir ['"]/.test(script),
    "managed HBA/ident include_dir operands must not contain literal quotes");
});

test("the effective peer map has only the intended production capabilities", () => {
  const ident = heredoc("IDENT");
  const rows = ident
    .split("\n")
    .filter((line) => /^infra_cod_map\s/.test(line))
    .map((line) => line.trim().split(/\s+/).slice(1));

  assert.deepEqual(rows, [
    ["postgres", "postgres"],
    ["infra-web", "infra_web"],
    ["infra-control", "infra_worker"],
    ["infra-cod-github", "infra_worker"],
    ["root", "infra_migrator"],
    ["root", "infra_worker"],
    ["root", "infra_backup"],
  ]);

  for (const runtimeUser of ["codex-worker", "opencode-worker", "claude-worker"]) {
    assert.ok(!rows.some(([account]) => account === runtimeUser), `${runtimeUser} unexpectedly has a DB mapping`);
  }

  const unprivileged = rows.filter(([account]) => !["root", "postgres"].includes(account));
  const rolesByAccount = Map.groupBy(unprivileged, ([account]) => account);
  for (const [account, mappings] of rolesByAccount) {
    assert.equal(new Set(mappings.map(([, role]) => role)).size, 1, `${account} can assume multiple roles`);
  }
});

test("roles are passwordless, constrained, and the database is appliance-owned", () => {
  assert.match(script, /ARRAY\['infra_migrator','infra_worker','infra_web','infra_backup'\]/);
  assert.match(script, /NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD NULL/);
  assert.match(script, /FROM pg_authid WHERE rolname = role_name/);
  assert.ok(!/SELECT \* INTO role_row FROM pg_roles/.test(script), "pg_roles masks password state");
  assert.match(script, /-O infra_migrator "\$\{DATABASE_NAME\}"/);
  assert.match(script, /REVOKE CONNECT ON DATABASE infra_cod FROM PUBLIC/);
  assert.match(script, /GRANT CONNECT ON DATABASE infra_cod TO infra_migrator, infra_worker, infra_web, infra_backup/);
});

test("the provisioner exercises both allowed and denied paths before success", () => {
  for (const allowed of [
    "assert_peer infra-web infra_web",
    "assert_peer infra-control infra_worker",
    "assert_peer infra-cod-github infra_worker",
    "assert_peer root infra_migrator",
    "assert_peer root infra_worker",
    "assert_peer root infra_backup",
    "assert_peer postgres postgres",
  ]) {
    assert.match(script, new RegExp(`^${allowed}$`, "m"));
  }
  for (const refused of [
    "assert_refused infra-web infra_worker",
    "assert_refused infra-control infra_web",
    "assert_refused nobody infra_worker",
    "assert_refused root postgres",
    "assert_refused infra-web infra_web tcp",
  ]) {
    assert.match(script, new RegExp(`^${refused}$`, "m"));
  }
  assert.match(script, /printf '\{"ok":true,/);
});

test("the production migration wrapper bounds the legacy backup bootstrap grant", () => {
  const parsed = spawnSync("bash", ["-n", migrationScriptPath], { encoding: "utf8" });
  assert.equal(parsed.status, 0, parsed.stderr);
  assert.match(migrationScript, /^set -euo pipefail$/m);
  assert.match(migrationScript, /GRANT pg_read_all_data TO infra_backup\s+WITH ADMIN FALSE, INHERIT TRUE, SET FALSE;/);
  assert.match(migrationScript, /GRANT pg_read_all_data TO infra_migrator\s+WITH ADMIN TRUE, INHERIT FALSE, SET FALSE;/);
  assert.match(migrationScript, /trap cleanup_bootstrap_membership EXIT INT TERM HUP/);
  assert.match(migrationScript, /REVOKE pg_read_all_data FROM infra_migrator CASCADE;/);
  assert.match(migrationScript, /BEGIN;[\s\S]*GRANT pg_read_all_data TO infra_backup[\s\S]*COMMIT;/);
  assert.match(migrationScript, /NOT membership\.admin_option/);
  assert.match(migrationScript, /membership\.inherit_option/);
  assert.match(migrationScript, /NOT membership\.set_option/);
  assert.match(migrationScript, /pg_has_role\('infra_migrator', 'pg_read_all_data', 'MEMBER'\)/);
  assert.match(migrationScript, /env -u DATABASE_URL -u PGPASSWORD/);
  assert.match(migrationScript, /PGUSER=infra_migrator/);
  assert.ok(!/PGPASSWORD=|DATABASE_URL=/.test(migrationScript));
});
