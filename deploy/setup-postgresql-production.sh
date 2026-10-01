#!/usr/bin/env bash
# Provision the PostgreSQL 17/main production cluster for infra-cod.
#
# This script deliberately owns only the database boundary and the three OS
# peers needed to prove it. The Stage 10 installer owns the remaining runtime
# users, application files, secrets and systemd units. Rerunning this script is
# safe: it converges roles, the database and managed configuration drop-ins,
# then exercises the effective authentication policy before reporting success.
set -euo pipefail

readonly PG_MAJOR=17
readonly CLUSTER_NAME=main
readonly PG_PORT=5432
readonly PG_SOCKET=/var/run/postgresql
readonly DATABASE_NAME=infra_cod
readonly PEER_MAP=infra_cod_map
readonly PG_BIN=/usr/lib/postgresql/17/bin
readonly CONF_DIR=/etc/postgresql/17/main

die() {
  echo "setup-postgresql-production: $*" >&2
  exit 1
}

if [[ ${EUID} -ne 0 ]]; then
  die "setup must run as root"
fi

ensure_system_account() {
  local account=$1
  local state_directory=$2
  local account_record
  local account_uid
  local account_gid
  local account_home
  local account_shell
  local expected_gid

  if ! getent group "${account}" >/dev/null; then
    groupadd --system "${account}"
  fi
  if ! getent passwd "${account}" >/dev/null; then
    useradd --system --gid "${account}" --home-dir "${state_directory}" \
      --shell /usr/sbin/nologin "${account}"
  fi

  account_record=$(getent passwd "${account}")
  IFS=: read -r _ _ account_uid account_gid _ account_home account_shell <<<"${account_record}"
  expected_gid=$(getent group "${account}" | cut -d: -f3)
  [[ ${account_gid} == "${expected_gid}" ]] || die "${account} does not use its private primary group"
  [[ ${account_home} == "${state_directory}" ]] || die "${account} has unexpected home ${account_home}"
  [[ ${account_shell} == /usr/sbin/nologin ]] || die "${account} has interactive shell ${account_shell}"
  [[ ${account_uid} =~ ^[0-9]+$ ]] || die "${account} has an invalid uid"
}

ensure_system_account infra-web /var/lib/infra-web
ensure_system_account infra-control /var/lib/infra-control
ensure_system_account infra-cod-github /var/lib/infra-cod-github

setup_helper=/usr/share/postgresql-common/pgdg/apt.postgresql.org.sh
if [[ ! -x ${setup_helper} ]]; then
  apt-get update
  DEBIAN_FRONTEND=noninteractive apt-get install -y postgresql-common ca-certificates curl
fi

if [[ ! -f /etc/apt/sources.list.d/pgdg.sources ]]; then
  "${setup_helper}" -y
fi
apt-get update
DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
  postgresql-client-17 postgresql-17

cluster_exists() {
  pg_lsclusters --no-header | awk -v v="$1" -v n="$2" \
    '$1 == v && $2 == n { found = 1 } END { exit !found }'
}

# A different cluster on the production port is data we do not own. Refuse to
# move or replace it: an operator must resolve that conflict explicitly.
foreign_cluster=$(pg_lsclusters --no-header | awk \
  -v v="${PG_MAJOR}" -v n="${CLUSTER_NAME}" -v p="${PG_PORT}" \
  '$3 == p && !($1 == v && $2 == n) { print $1 "/" $2; exit }')
if [[ -n ${foreign_cluster} ]]; then
  die "port ${PG_PORT} belongs to PostgreSQL cluster ${foreign_cluster}"
fi

if ! cluster_exists "${PG_MAJOR}" "${CLUSTER_NAME}"; then
  pg_createcluster "${PG_MAJOR}" "${CLUSTER_NAME}" --port "${PG_PORT}"
fi

cluster_port=$(pg_lsclusters --no-header | awk \
  -v v="${PG_MAJOR}" -v n="${CLUSTER_NAME}" \
  '$1 == v && $2 == n { print $3 }')
if [[ ${cluster_port} != "${PG_PORT}" ]]; then
  die "cluster ${PG_MAJOR}/${CLUSTER_NAME} must listen on ${PG_PORT}; got ${cluster_port:-missing}"
fi

# Recover the only invalid pre-acceptance state this script ever wrote. A quoted
# HBA/ident include operand is interpreted literally, so it prevents the cluster
# from starting and a normal converging rerun could not reach its rewrite step.
remove_exact_line() {
  local parent=$1
  local unwanted=$2
  local temporary
  [[ -f ${parent} ]] || return 0
  temporary=$(mktemp)
  awk -v unwanted="${unwanted}" '$0 != unwanted { print }' "${parent}" > "${temporary}"
  install -o root -g postgres -m 0640 "${temporary}" "${parent}"
  rm -f "${temporary}"
}
remove_exact_line "${CONF_DIR}/pg_hba.conf" "include_dir 'pg_hba.conf.d'"
remove_exact_line "${CONF_DIR}/pg_ident.conf" "include_dir 'pg_ident.conf.d'"

systemctl enable "postgresql@${PG_MAJOR}-${CLUSTER_NAME}.service"
systemctl start "postgresql@${PG_MAJOR}-${CLUSTER_NAME}.service"
systemctl is-active --quiet "postgresql@${PG_MAJOR}-${CLUSTER_NAME}.service" || \
  die "cluster ${PG_MAJOR}/${CLUSTER_NAME} did not become active"

psql_as_postgres() {
  runuser -u postgres -- "${PG_BIN}/psql" \
    -h "${PG_SOCKET}" -p "${PG_PORT}" -X -v ON_ERROR_STOP=1 "$@"
}

# Refuse to adopt a cluster containing a database unrelated to infra-cod. The
# setup is allowed to converge an existing infra_cod database, but never to
# reinterpret a shared PostgreSQL cluster as an appliance-owned cluster.
unexpected_database=$(psql_as_postgres -qAt -d postgres -c \
  "SELECT datname FROM pg_database WHERE NOT datistemplate AND datname NOT IN ('postgres', '${DATABASE_NAME}') ORDER BY datname LIMIT 1")
if [[ -n ${unexpected_database} ]]; then
  die "cluster ${PG_MAJOR}/${CLUSTER_NAME} contains unrelated database ${unexpected_database}"
fi

psql_as_postgres -q -d postgres <<'SQL'
DO $$
DECLARE role_name text;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['infra_migrator','infra_worker','infra_web','infra_backup']
  LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name) THEN
      EXECUTE format('CREATE ROLE %I LOGIN', role_name);
    END IF;
    EXECUTE format(
      'ALTER ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD NULL',
      role_name
    );
  END LOOP;
END
$$;
SQL

if ! psql_as_postgres -qAt -d postgres -c \
  "SELECT 1 FROM pg_database WHERE datname = '${DATABASE_NAME}'" | grep -qx 1; then
  runuser -u postgres -- "${PG_BIN}/createdb" \
    -h "${PG_SOCKET}" -p "${PG_PORT}" -O infra_migrator "${DATABASE_NAME}"
fi

database_owner=$(psql_as_postgres -qAt -d postgres -c \
  "SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname = '${DATABASE_NAME}'")
if [[ ${database_owner} != infra_migrator ]]; then
  die "database ${DATABASE_NAME} is owned by ${database_owner}, expected infra_migrator"
fi

psql_as_postgres -q -d postgres <<'SQL'
REVOKE CONNECT ON DATABASE infra_cod FROM PUBLIC;
GRANT CONNECT ON DATABASE infra_cod TO infra_migrator, infra_worker, infra_web, infra_backup;
SQL

[[ -d ${CONF_DIR} ]] || die "PostgreSQL configuration directory ${CONF_DIR} is missing"

ram_mb=$(awk '/^MemTotal:/ { print int($2 / 1024) }' /proc/meminfo)
[[ ${ram_mb} =~ ^[0-9]+$ ]] || die "could not determine system memory"

shared_buffers_mb=$((ram_mb / 4))
(( shared_buffers_mb < 128 )) && shared_buffers_mb=128
(( shared_buffers_mb > 4096 )) && shared_buffers_mb=4096

effective_cache_mb=$((ram_mb / 2))
(( effective_cache_mb < 256 )) && effective_cache_mb=256
(( effective_cache_mb > 8192 )) && effective_cache_mb=8192

maintenance_work_mem_mb=$((ram_mb / 16))
(( maintenance_work_mem_mb < 64 )) && maintenance_work_mem_mb=64
(( maintenance_work_mem_mb > 1024 )) && maintenance_work_mem_mb=1024

work_mem_mb=$(((ram_mb - shared_buffers_mb) / 400))
(( work_mem_mb < 4 )) && work_mem_mb=4
(( work_mem_mb > 64 )) && work_mem_mb=64

install -d -o root -g postgres -m 0750 "${CONF_DIR}/conf.d"
postgres_dropin=$(mktemp)
cat > "${postgres_dropin}" <<CONF
# Managed by deploy/setup-postgresql-production.sh — do not edit by hand.
listen_addresses = 'localhost'
port = ${PG_PORT}
unix_socket_directories = '${PG_SOCKET}'
password_encryption = 'scram-sha-256'
ssl = off
log_min_duration_statement = 1000
max_connections = 100
shared_buffers = '${shared_buffers_mb}MB'
effective_cache_size = '${effective_cache_mb}MB'
maintenance_work_mem = '${maintenance_work_mem_mb}MB'
work_mem = '${work_mem_mb}MB'
CONF
install -o root -g postgres -m 0640 "${postgres_dropin}" "${CONF_DIR}/conf.d/10-infra-cod.conf"
rm -f "${postgres_dropin}"

# PostgreSQL processes include these directories from the parent files. The
# directive is deliberately first: pg_hba.conf is first-match-wins, so leaving
# Debian's default local rule before ours would bypass the peer map.
ensure_include_first() {
  local parent=$1
  local include_line=$2
  local include_directory=${include_line#include_dir }
  local temporary
  temporary=$(mktemp)
  {
    printf '%s\n' "${include_line}"
    # Remove the quoted form written by the first pre-acceptance revision too.
    # HBA/ident include operands are filenames, not postgresql.conf strings;
    # PostgreSQL otherwise treats the quote marks as part of the directory name.
    awk -v wanted="${include_line}" -v quoted="include_dir '${include_directory}'" \
      '$0 != wanted && $0 != quoted { print }' "${parent}"
  } > "${temporary}"
  install -o root -g postgres -m 0640 "${temporary}" "${parent}"
  rm -f "${temporary}"
}

install -d -o root -g postgres -m 0750 \
  "${CONF_DIR}/pg_hba.conf.d" "${CONF_DIR}/pg_ident.conf.d"

ident_dropin=$(mktemp)
cat > "${ident_dropin}" <<'IDENT'
# Managed by deploy/setup-postgresql-production.sh — do not edit by hand.
# MAPNAME       SYSTEM-USERNAME     PG-USERNAME
infra_cod_map   postgres            postgres
infra_cod_map   infra-web           infra_web
infra_cod_map   infra-control       infra_worker
infra_cod_map   infra-cod-github    infra_worker
infra_cod_map   root                infra_migrator
infra_cod_map   root                infra_worker
infra_cod_map   root                infra_backup
IDENT
install -o root -g postgres -m 0640 "${ident_dropin}" \
  "${CONF_DIR}/pg_ident.conf.d/10-infra-cod.conf"
rm -f "${ident_dropin}"

hba_dropin=$(mktemp)
cat > "${hba_dropin}" <<'HBA'
# Managed by deploy/setup-postgresql-production.sh — do not edit by hand.
local   all             all                                     peer map=infra_cod_map
local   replication     all                                     peer map=infra_cod_map
host    all             all             127.0.0.1/32            reject
host    all             all             ::1/128                 reject
host    replication     all             127.0.0.1/32            reject
host    replication     all             ::1/128                 reject
HBA
install -o root -g postgres -m 0640 "${hba_dropin}" \
  "${CONF_DIR}/pg_hba.conf.d/10-infra-cod.conf"
rm -f "${hba_dropin}"

ensure_include_first "${CONF_DIR}/pg_ident.conf" "include_dir pg_ident.conf.d"
ensure_include_first "${CONF_DIR}/pg_hba.conf" "include_dir pg_hba.conf.d"

systemctl restart "postgresql@${PG_MAJOR}-${CLUSTER_NAME}.service"

assert_peer() {
  local account=$1
  local role=$2
  local actual
  actual=$(runuser -u "${account}" -- env -u DATABASE_URL -u PGPASSWORD \
    PGHOST="${PG_SOCKET}" PGPORT="${PG_PORT}" PGUSER="${role}" PGDATABASE="${DATABASE_NAME}" \
    "${PG_BIN}/psql" -X -qAt -v ON_ERROR_STOP=1 -c 'SELECT current_user')
  [[ ${actual} == "${role}" ]] || die "${account} authenticated as ${actual}, expected ${role}"
}

assert_refused() {
  local account=$1
  local role=$2
  local transport=${3:-socket}
  local host=${PG_SOCKET}
  [[ ${transport} == tcp ]] && host=127.0.0.1

  if runuser -u "${account}" -- env -u DATABASE_URL -u PGPASSWORD \
    PGHOST="${host}" PGPORT="${PG_PORT}" PGUSER="${role}" PGDATABASE="${DATABASE_NAME}" \
    "${PG_BIN}/psql" -X -qAt -v ON_ERROR_STOP=1 -c 'SELECT current_user' \
    >/dev/null 2>&1; then
    die "unexpected database access: ${account} -> ${role} over ${transport}"
  fi
}

assert_peer infra-web infra_web
assert_peer infra-control infra_worker
assert_peer infra-cod-github infra_worker
assert_peer root infra_migrator
assert_peer root infra_worker
assert_peer root infra_backup
assert_peer postgres postgres

assert_refused infra-web infra_worker
assert_refused infra-control infra_web
assert_refused nobody infra_worker
assert_refused root postgres
assert_refused infra-web infra_web tcp

psql_as_postgres -qAt -d postgres <<'SQL'
DO $$
DECLARE
  role_name text;
  role_row record;
  mapped integer;
  peer_rules integer;
  reject_rules integer;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['infra_migrator','infra_worker','infra_web','infra_backup']
  LOOP
    -- pg_roles masks rolpassword as ******** and is therefore incapable of
    -- proving that no password exists. This block runs as postgres and may use
    -- pg_authid; the value itself is never selected out of the block.
    SELECT * INTO role_row FROM pg_authid WHERE rolname = role_name;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'missing production role %', role_name;
    END IF;
    IF role_row.rolsuper OR role_row.rolcreatedb OR role_row.rolcreaterole
       OR role_row.rolreplication OR role_row.rolbypassrls OR role_row.rolpassword IS NOT NULL THEN
      RAISE EXCEPTION 'production role % has forbidden privilege or password', role_name;
    END IF;
  END LOOP;

  SELECT count(*) INTO mapped
  FROM pg_ident_file_mappings
  WHERE map_name = 'infra_cod_map' AND error IS NULL;
  IF mapped <> 7 THEN
    RAISE EXCEPTION 'expected 7 valid infra_cod_map entries, got %', mapped;
  END IF;

  SELECT count(*) INTO peer_rules
  FROM pg_hba_file_rules
  WHERE type = 'local' AND auth_method = 'peer' AND error IS NULL
    AND 'map=infra_cod_map' = ANY(coalesce(options, ARRAY[]::text[]));
  IF peer_rules <> 2 THEN
    RAISE EXCEPTION 'expected 2 active peer rules, got %', peer_rules;
  END IF;

  SELECT count(*) INTO reject_rules
  FROM pg_hba_file_rules
  WHERE type = 'host' AND auth_method = 'reject' AND error IS NULL;
  IF reject_rules < 4 THEN
    RAISE EXCEPTION 'expected at least 4 active TCP reject rules, got %', reject_rules;
  END IF;
END
$$;
SQL

settings=$(psql_as_postgres -qAt -F '|' -d postgres -c \
  "SELECT name, setting FROM pg_settings WHERE name IN ('listen_addresses','port','unix_socket_directories','password_encryption','ssl','log_min_duration_statement','max_connections') ORDER BY name")
grep -qx 'listen_addresses|localhost' <<<"${settings}" || die "listen_addresses is not localhost"
grep -qx "port|${PG_PORT}" <<<"${settings}" || die "PostgreSQL port is not ${PG_PORT}"
grep -qx "unix_socket_directories|${PG_SOCKET}" <<<"${settings}" || die "Unix socket directory is not ${PG_SOCKET}"
grep -qx 'password_encryption|scram-sha-256' <<<"${settings}" || die "password_encryption is not scram-sha-256"
grep -qx 'ssl|off' <<<"${settings}" || die "PostgreSQL SSL is not disabled"
grep -qx 'log_min_duration_statement|1000' <<<"${settings}" || die "slow-query logging is not 1000ms"
grep -qx 'max_connections|100' <<<"${settings}" || die "max_connections is not 100"

config_sha256=$(sha256sum "${CONF_DIR}/conf.d/10-infra-cod.conf" | awk '{ print $1 }')
ident_sha256=$(sha256sum "${CONF_DIR}/pg_ident.conf.d/10-infra-cod.conf" | awk '{ print $1 }')
hba_sha256=$(sha256sum "${CONF_DIR}/pg_hba.conf.d/10-infra-cod.conf" | awk '{ print $1 }')

apt-get clean
printf '{"ok":true,"cluster":"%s/%s","port":%d,"database":"%s","ram_mb":%d,"memory":{"shared_buffers_mb":%d,"effective_cache_mb":%d,"maintenance_work_mem_mb":%d,"work_mem_mb":%d},"checks":{"allowed_peers":7,"refused_paths":5},"sha256":{"postgresql":"%s","ident":"%s","hba":"%s"}}\n' \
  "${PG_MAJOR}" "${CLUSTER_NAME}" "${PG_PORT}" "${DATABASE_NAME}" "${ram_mb}" \
  "${shared_buffers_mb}" "${effective_cache_mb}" "${maintenance_work_mem_mb}" "${work_mem_mb}" \
  "${config_sha256}" "${ident_sha256}" "${hba_sha256}"
