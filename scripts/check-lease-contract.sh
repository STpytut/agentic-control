#!/usr/bin/env bash
# Applies every migration to a clean PostgreSQL 17 and checks the lease contract
# on it.
#
# Why a real database and not a unit test: the first version of the lease migration
# declared row types that do not resolve at creation time, referenced a column
# that does not exist, and — having been fixed twice — created every function in
# `public` instead of `control_plane`, where nothing would ever have called
# them. All three passed every check this repository had. Only running it said
# otherwise.
#
# Two ways to get that database
# -----------------------------
#   * By default the script creates its own `postgres:17` container, uses it and
#     destroys it. Nothing outside docker is required.
#   * With LEASE_CONTRACT_DATABASE_URL set, it runs against that database through
#     `psql` and creates no container. The database must be **empty**: this
#     applies migration 0001 onward and an existing schema fails on the first
#     file. The offline gate uses this mode, because the gate container has
#     PostgreSQL in its network namespace and no docker inside it.
#
# What this does NOT check, and what does
# ---------------------------------------
# The files are fed to `psql` directly, not to `services/control-plane/migrate.mjs`.
# That is the wrong question to ask about acceptability: `psql` is happy to run a
# migration that opens its own transaction, and the runner refuses one, because
# the runner's wrapper is what makes apply + verify + stamp atomic. 0053 shipped
# with BEGIN/COMMIT, passed this script, and could not be installed by any real
# host.
#
# `sql-scan.test.mjs` now scans `db/migrations/` itself and is part of
# `npm run test:unit`, so that half needs no database and no docker.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${here}"

external="${LEASE_CONTRACT_DATABASE_URL:-}"

if [ -n "${external}" ]; then
  # `psql` is given the URL and nothing else: no -U, no -d, no host. Everything
  # the connection needs is in the URL, so there is one place to be wrong.
  sql_file() { psql -X -q -v ON_ERROR_STOP=1 "${external}" -f "$1"; }
  sql_cmd() { psql -X -q -v ON_ERROR_STOP=1 "${external}" -c "$1"; }
  # The URL carries a password, so it is never printed whole: a gate that leaks a
  # credential into a log is a gate that has to be argued about instead of read.
  echo "lease contract against $(printf '%s' "${external}" | sed -E 's#://[^@/]+@#://***@#; s#\?.*##') (no container)"
else
  name="infra-cod-lease-check-$$"
  cleanup() { docker rm -f "${name}" >/dev/null 2>&1 || true; }
  trap cleanup EXIT

  # The container is created, used and destroyed. It holds no data anybody wants.
  docker run -d --name "${name}" -e POSTGRES_PASSWORD=gate -e POSTGRES_DB=gate postgres:17 >/dev/null

  for _ in $(seq 1 60); do
    docker exec "${name}" pg_isready -U postgres >/dev/null 2>&1 && break
    sleep 1
  done
  docker exec "${name}" pg_isready -U postgres >/dev/null

  sql_file() { docker exec -i "${name}" psql -X -q -v ON_ERROR_STOP=1 -U postgres -d gate < "$1"; }
  sql_cmd() { docker exec "${name}" psql -X -q -v ON_ERROR_STOP=1 -U postgres -d gate -c "$1"; }
fi

# Reproduce the production host, not the developer's database.
#
# 0038 stops PostgreSQL granting EXECUTE on every new function to PUBLIC with a
# global `ALTER DEFAULT PRIVILEGES ... REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC`.
# On the production host that row is simply not in `pg_default_acl` — the three
# schema-scoped rows are there and the global one is not — so on that host every
# new function comes out world-executable and the migration is rolled back by
# `assert_no_public_function_execute()`.
#
# Locally the row exists, so a migration that leans on it looks correct. It is
# not: a default is a property of the database it was set in, and a migration has
# to carry its own grants. Undoing the default right after 0038 makes this
# database the stricter of the two, and the check below is what fails.
undo_default_revoke() {
  sql_cmd 'ALTER DEFAULT PRIVILEGES FOR ROLE postgres GRANT EXECUTE ON FUNCTIONS TO PUBLIC' >/dev/null
}

for migration in db/migrations/*.sql; do
  if ! sql_file "${migration}" >/dev/null 2>/tmp/lease-migration.err; then
    echo "migration failed: ${migration}" >&2
    tail -20 /tmp/lease-migration.err >&2
    exit 1
  fi
  case "${migration}" in
    *0038_*) undo_default_revoke; guard=1 ;;
  esac

  # The guard 0038 added, run where `psql` would not run it. `migrate.mjs` calls
  # it after every file in production; this loop is raw psql, so without this the
  # database applies a migration the real runner would refuse.
  #
  # Only from 0038 onward, because that is the migration that creates it — and
  # the files before it are deployed everywhere and are not the subject.
  if [ "${guard:-0}" = 1 ]; then
    if ! sql_cmd 'SELECT control_plane.assert_no_public_function_execute()' >/dev/null 2>/tmp/lease-grants.err; then
      echo "migration grants PUBLIC execute: ${migration}" >&2
      tail -5 /tmp/lease-grants.err >&2
      exit 1
    fi
  fi
  # And from 0062, the guard that every function the web role can execute runs
  # as its owner — the same check migrate.mjs makes, for the same reason the
  # PUBLIC check is repeated here.
  case "${migration}" in
    *0062_*) definer_guard=1 ;;
  esac
  if [ "${definer_guard:-0}" = 1 ]; then
    if ! sql_cmd 'SELECT control_plane.assert_web_functions_run_as_definer()' >/dev/null 2>/tmp/lease-definer.err; then
      echo "migration leaves a web-facing function running as its caller: ${migration}" >&2
      tail -5 /tmp/lease-definer.err >&2
      exit 1
    fi
  fi
done
echo "all migrations applied to a clean PostgreSQL 17, none granting PUBLIC execute"

sql_file db/test/lease-and-defer.sql
echo "lease contract holds"
