#!/usr/bin/env bash
# The restore target for the isolated backup drill, and the peer configuration it
# needs to be usable at all.
#
# The drill restores a backup into a throwaway database so that "the backup can
# actually be restored" is a measured fact rather than an assumption. That target
# is its own cluster — `17/restore` on 5433 — and not the package's `17/main`
# cluster on another port: production owns `17/main:5432`, and a drill sharing the
# cluster would share its lifecycle, its configuration and its `pg_hba.conf`.
# ADR-0011, decision 4.
#
# pg_hba.conf and pg_ident.conf belong to a *cluster*. This script therefore
# configures the restore cluster only, and deliberately does not touch `17/main`:
# the production maps are Stage 2's contract (deploy/systemd/README.md) and a
# restore setup that edited them would be fixing another component's
# configuration. The role and the map it creates are unique to this cluster.
#
# The `infra_control` role exists only here. It owns the throwaway database and
# its `extensions` schema, and it is the role the drill's clients assume through
# the peer map. It is deliberately absent from `17/main`: it is not a production
# role and holds no privilege on production data.
#
# This script is the restore half of the PostgreSQL setup. The production half —
# the `17/main` cluster already created by the package, the production database,
# `infra_migrator`/`infra_worker`/`infra_web`/`infra_backup` and their peer map —
# belongs to `setup-postgresql-production.sh` (Stage 2). Until that exists, backup
# and restore cannot be exercised on a VPS, whatever this script does.
#
# Rerunning is safe: every step checks for what it is about to create.
set -euo pipefail

if [[ ${EUID} -ne 0 ]]; then
  echo "setup must run as root" >&2
  exit 1
fi

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
  pg_lsclusters --no-header | awk -v v="$1" -v n="$2" '$1 == v && $2 == n { found = 1 } END { exit !found }'
}

if ! cluster_exists 17 restore; then
  pg_createcluster 17 restore --port 5433
fi

restore_port=$(pg_lsclusters --no-header | awk '$1 == "17" && $2 == "restore" { print $3 }')
if [[ ${restore_port} != 5433 ]]; then
  echo "cluster 17/restore must listen on 5433; got ${restore_port:-missing}" >&2
  exit 1
fi
# Production keeps the package's own cluster, which this script must not configure
# or repair. Fail loudly if it is missing rather than creating it here.
if ! cluster_exists 17 main; then
  echo "cluster 17/main is missing; run setup-postgresql-production.sh first" >&2
  exit 1
fi

conf_directory=/etc/postgresql/17/restore
pg_ident=${conf_directory}/pg_ident.conf
pg_hba=${conf_directory}/pg_hba.conf
for required in "${pg_ident}" "${pg_hba}"; do
  if [[ ! -f ${required} ]]; then
    echo "expected ${required} to exist after pg_createcluster" >&2
    exit 1
  fi
done

systemctl enable --now postgresql@17-restore.service

# ---------------------------------------------------------------- the role ----
#
# Created through the socket as `postgres`, which is mapped to itself in the
# cluster's default pg_ident.conf. The role is a database role name: OS user
# names carry the hyphen (`infra-control`), database roles the underscore, and the
# map below is what joins them.
runuser -u postgres -- /usr/lib/postgresql/17/bin/psql \
  -h /var/run/postgresql -p 5433 -X -v ON_ERROR_STOP=1 -d postgres <<'SQL'
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'infra_control') THEN
    CREATE ROLE infra_control LOGIN;
  END IF;
END
$$;
SQL

# ------------------------------------------------------------ the peer map ----
#
# Rewritten wholesale rather than appended to, so a rerun does not accumulate
# duplicate lines and the file is always the one this script describes. The name
# is distinct from production's `infra_cod_map` because the two files are read by
# different clusters and a reader comparing them should not have to guess which is
# which.
cat > "${pg_ident}" <<'IDENT'
# Managed by deploy/setup-postgresql-17-restore.sh — do not edit by hand.
#
# This map belongs to the 17/restore cluster. Production keeps its own
# pg_ident.conf in /etc/postgresql/17/main; the same OS user name may map
# differently there, and it does: production maps infra-control to infra_worker.
#
# MAPNAME                 SYSTEM-USERNAME     PG-USERNAME
infra_cod_restore_map     postgres            postgres
infra_cod_restore_map     infra-control       infra_control
IDENT
chown root:postgres "${pg_ident}"
chmod 0640 "${pg_ident}"

# ------------------------------------------------------------ the hba rules ----
#
# Only the socket, only peer, and only through this map. TCP is rejected
# explicitly: the drill is a local maintenance job, and a rejected connection
# produces a clear error instead of an accidental password prompt.
#
# The file is rewritten to hold exactly this content, plus the packaging's own
# comment header lines, so a rerun is idempotent.
cat > "${pg_hba}" <<'HBA'
# Managed by deploy/setup-postgresql-17-restore.sh — do not edit by hand.
#
# The restore cluster is reachable only over the local Unix socket, and only by a
# role that the map in pg_ident.conf assigned to the connecting OS user.
local   all             all                                     peer map=infra_cod_restore_map
local   replication     all                                     peer map=infra_cod_restore_map
host    all             all             127.0.0.1/32            reject
host    all             all             ::1/128                 reject
host    replication     all             127.0.0.1/32            reject
host    replication     all             ::1/128                 reject
HBA
chown root:postgres "${pg_hba}"
chmod 0640 "${pg_hba}"

systemctl reload postgresql@17-restore.service

# --------------------------------------------------------------- verification --
#
# The reload is only useful if the running cluster accepted it, so the effective
# rules are read back from the server rather than assumed from the files. A
# configuration error here would otherwise surface much later, as a drill that
# cannot authenticate.
runuser -u postgres -- /usr/lib/postgresql/17/bin/psql \
  -h /var/run/postgresql -p 5433 -X -qAt -v ON_ERROR_STOP=1 -d postgres <<'SQL'
DO $$
DECLARE
  v_peer integer;
  v_mapping integer;
BEGIN
  -- `options` holds one element per authentication option, spelled the way it
  -- appears in the file. For `peer map=NAME` that element is the whole
  -- `map=NAME` string, not the bare name — measured on 17.11:
  -- `{map=infra_cod_restore_map}`. Comparing against the name alone matches
  -- nothing and would have made this check pass by failing to find the rule.
  SELECT count(*) INTO v_peer
  FROM pg_hba_file_rules
  WHERE type = 'local' AND auth_method = 'peer' AND error IS NULL
    AND 'map=infra_cod_restore_map' = ANY(coalesce(options, ARRAY[]::text[]));

  IF v_peer = 0 THEN
    RAISE EXCEPTION 'no active peer rule uses infra_cod_restore_map in 17/restore';
  END IF;

  -- The column is `pg_username`; there is no `pg_name`.
  SELECT count(*) INTO v_mapping
  FROM pg_ident_file_mappings
  WHERE map_name = 'infra_cod_restore_map'
    AND sys_name = 'infra-control'
    AND pg_username = 'infra_control'
    AND error IS NULL;

  IF v_mapping = 0 THEN
    RAISE EXCEPTION 'pg_ident.conf has no infra-control -> infra_control mapping';
  END IF;
END
$$;
SQL

apt-get clean
/usr/lib/postgresql/17/bin/pg_dump --version
pg_lsclusters
