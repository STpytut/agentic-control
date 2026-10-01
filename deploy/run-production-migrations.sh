#!/usr/bin/env bash
# Apply infra-cod migrations through the production peer boundary.
#
# Legacy migration 0038 grants pg_read_all_data to the backup role. PostgreSQL
# requires the migrating role to hold ADMIN OPTION on that predefined role even
# when the intended membership was already granted by postgres. This wrapper
# gives infra_migrator that administrative capability without INHERIT or SET,
# runs the migrator, and revokes the temporary membership on every exit path.
set -euo pipefail

readonly PG_PORT=5432
readonly PG_SOCKET=/var/run/postgresql
readonly DATABASE_NAME=infra_cod
readonly PG_BIN=/usr/lib/postgresql/17/bin

die() {
  echo "run-production-migrations: $*" >&2
  exit 1
}

if [[ ${EUID} -ne 0 ]]; then
  die "migrations must run as root"
fi

application_root=${1:-/opt/infra-cod/current}
migrator=${application_root}/services/control-plane/migrate.mjs
node_bin=${INFRA_COD_NODE_BIN:-/opt/node/bin/node}

[[ -f ${migrator} ]] || die "migration runner is missing at ${migrator}"
[[ -x ${node_bin} ]] || die "Node executable is missing at ${node_bin}"
systemctl is-active --quiet postgresql@17-main.service || die "PostgreSQL 17/main is not active"

psql_as_postgres() {
  runuser -u postgres -- "${PG_BIN}/psql" \
    -h "${PG_SOCKET}" -p "${PG_PORT}" -U postgres -X -qAt -v ON_ERROR_STOP=1 "$@"
}

cleanup_bootstrap_membership() {
  local original_status=$?
  trap - EXIT INT TERM HUP

  # CASCADE removes any membership grant 0038 attributed to infra_migrator.
  # The independent postgres -> infra_backup grant below remains in force.
  if ! psql_as_postgres -d postgres <<'SQL'
REVOKE pg_read_all_data FROM infra_migrator CASCADE;
SQL
  then
    echo "run-production-migrations: failed to revoke temporary infra_migrator membership" >&2
    exit 1
  fi

  if ! psql_as_postgres -d postgres <<'SQL'
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_auth_members membership
    JOIN pg_roles granted ON granted.oid = membership.roleid
    JOIN pg_roles member ON member.oid = membership.member
    WHERE granted.rolname = 'pg_read_all_data'
      AND member.rolname = 'infra_backup'
      AND NOT membership.admin_option
      AND membership.inherit_option
      AND NOT membership.set_option
  ) THEN
    RAISE EXCEPTION 'infra_backup did not retain the constrained pg_read_all_data membership';
  END IF;
  IF pg_has_role('infra_migrator', 'pg_read_all_data', 'MEMBER') THEN
    RAISE EXCEPTION 'infra_migrator retained its temporary pg_read_all_data membership';
  END IF;
END
$$;
SQL
  then
    echo "run-production-migrations: post-migration role verification failed" >&2
    exit 1
  fi

  if [[ ${original_status} -eq 0 ]]; then
    printf '{"ok":true,"database":"%s","migrator":"infra_migrator","backup_role":"infra_backup","temporary_membership_revoked":true}\n' \
      "${DATABASE_NAME}"
  fi
  exit "${original_status}"
}

# Install the cleanup before granting anything, and clear a stale temporary
# membership from a process that could only have died by SIGKILL. The permanent
# postgres -> infra_backup grant is made first, so CASCADE cannot remove the
# backup's independent path.
trap cleanup_bootstrap_membership EXIT INT TERM HUP

# The permanent grant is the backup role's entire purpose. SET is disabled:
# backup clients inherit SELECT/USAGE but cannot become the predefined role.
# infra_migrator receives only the ability required by legacy migration 0038;
# it cannot inherit or SET ROLE to pg_read_all_data.
psql_as_postgres -d postgres <<'SQL'
BEGIN;
GRANT pg_read_all_data TO infra_backup
  WITH ADMIN FALSE, INHERIT TRUE, SET FALSE;
REVOKE pg_read_all_data FROM infra_migrator CASCADE;
GRANT pg_read_all_data TO infra_migrator
  WITH ADMIN TRUE, INHERIT FALSE, SET FALSE;
COMMIT;
SQL

# The host layout moves with the schema (WP-5c): the release's own mover runs
# first, and is reverted if the SQL migrations then fail, so the two move
# together or not at all. On a host already on the product layout, or a fresh
# one, it is a no-op. It refuses to move anything while a service or a Codex
# process runs; the coordinator has stopped them, because 0065 is declared
# backward-incompatible.
layout_mover=${application_root}/services/operations/layout-migration.mjs
layout_moved=0
if [[ -f ${layout_mover} ]]; then
  layout_output=$("${node_bin}" "${layout_mover}" apply) || die "the host layout could not be moved: ${layout_output:-see above}"
  printf '%s\n' "${layout_output}" | sed 's/^/run-production-migrations: /' >&2
  if grep -qx "layout: moved" <<<"${layout_output}"; then layout_moved=1; fi
fi

if ! env -u DATABASE_URL -u PGPASSWORD \
  PGHOST="${PG_SOCKET}" PGPORT="${PG_PORT}" PGUSER=infra_migrator PGDATABASE="${DATABASE_NAME}" \
  "${node_bin}" "${migrator}"; then
  if [[ ${layout_moved} -eq 1 ]]; then
    echo "run-production-migrations: the migrations failed; moving the host layout back" >&2
    "${node_bin}" "${layout_mover}" revert >&2 || echo "run-production-migrations: the layout revert failed; see /etc/infra-cod/layout-migration.json" >&2
  fi
  die "the migrations failed"
fi

# Revoke before verification rather than waiting for the EXIT trap, so success
# is never printed while the temporary capability is still present.
cleanup_bootstrap_membership
