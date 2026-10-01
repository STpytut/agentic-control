#!/usr/bin/env bash
# infra_cod production installer — Stage 10.
#
# Idempotent: safe to re-run any number of times. Every mutating block records a
# completion marker, and `--resume` re-enters the run at the first block whose
# marker AND whose on-disk evidence are both present. A marker alone is never
# enough: a state file that survived a wiped /etc would otherwise skip the block
# that recreates it.
#
# Companion shell gate deploy/verify-release.sh is required alongside this file.
#
# Test harness
# ------------
# INFRA_COD_INSTALL_PREFIX relocates every absolute path this script touches into
# a sandbox directory. It exists so `services/operations/test/installer.test.mjs`
# can run the real script end to end without a VPS. With a prefix set the script
# is by construction not installing a system: the root, OS, architecture, RAM and
# port checks are skipped and no chown is attempted. Never set it on a real host.
set -euo pipefail

readonly PROGRAM='infra-cod-install'

PREFIX=${INFRA_COD_INSTALL_PREFIX:-}
HARNESS=0
if [[ -n ${PREFIX} ]]; then
  [[ ${PREFIX} == /* ]] || { echo "${PROGRAM}: ERROR: INFRA_COD_INSTALL_PREFIX must be absolute" >&2; exit 1; }
  [[ -d ${PREFIX} ]] || { echo "${PROGRAM}: ERROR: INFRA_COD_INSTALL_PREFIX is not a directory: ${PREFIX}" >&2; exit 1; }
  HARNESS=1
fi
readonly PREFIX HARNESS

readonly APP_ROOT="${PREFIX}/opt/infra-cod"
readonly ETC_ROOT="${PREFIX}/etc/infra-cod"
readonly STATE_FILE="${ETC_ROOT}/.install-state"
readonly LOCK_FILE="${PREFIX}/run/lock/infra-cod-install.lock"
readonly RELEASES_DIR="${APP_ROOT}/releases"
readonly CURRENT_LINK="${APP_ROOT}/current"
readonly CURRENT_TMP="${APP_ROOT}/.current-tmp"
readonly NODE_ROOT="${PREFIX}/opt/node"
readonly NODE_BIN="${NODE_ROOT}/bin/node"
readonly BACKUP_ROOT="${PREFIX}/var/lib/infra-cod-backups"
readonly OBSERVABILITY_ROOT="${PREFIX}/var/lib/infra-control/observability"
readonly WORKSPACE_ROOT="${PREFIX}/srv/infra-cod/workspaces"
readonly GATE_SMOKE_ROOT="${PREFIX}/srv/infra-cod/gate-smoke"
readonly GITHUB_APP_DIR="${ETC_ROOT}/github-app"
readonly GITHUB_DEPLOY_KEYS_DIR="${ETC_ROOT}/github-deploy-keys"
readonly OPENCODE_DIR="${ETC_ROOT}/opencode"
readonly BROKER_PUBLIC_KEY="${OPENCODE_DIR}/broker-public.pem"
readonly BROKER_PRIVATE_KEY="${OPENCODE_DIR}/broker-private.pem"
readonly CREDENTIALS_FILE="${ETC_ROOT}/initial-credentials"
readonly CADDY_DIR="${ETC_ROOT}/caddy"
readonly SYSTEMD_DIR="${PREFIX}/etc/systemd/system"
readonly TMPFILES_DIR="${PREFIX}/etc/tmpfiles.d"
readonly PG_SOCKET="${PREFIX}/var/run/postgresql"
readonly PG_PORT=5432
readonly PG_DATABASE=infra_cod
readonly PG_BIN="${PREFIX}/usr/lib/postgresql/17/bin"
readonly CADDY_BIN="${PREFIX}/usr/bin/caddy"
readonly CLI_SHIM="${PREFIX}/usr/local/bin/infra-cod"
readonly NODE_VERSION='24.20.0'
readonly CADDY_VERSION='2.9.1'
readonly SCRIPT_DIR="$(cd -- "$(dirname -- "$0")" && pwd)"
readonly VERIFY_GATE="${SCRIPT_DIR}/verify-release.sh"
readonly INSTALL_MANIFEST="${SCRIPT_DIR}/install-manifest.json"

# Packages a clean Ubuntu 24.04 host does not necessarily have but the installed
# system needs at runtime. `git` is not optional: the provisioner clones every
# project workspace with it, and a host without it installs cleanly and then
# fails on the first project. It is checked by preflight and by `doctor`.
#
# `bubblewrap` is Codex's sandbox after 0.154.0 (Stage 12 R13): the release's
# AppArmor profile lets that binary, and only it, create a user namespace; the
# host keeps kernel.apparmor_restrict_unprivileged_userns=1 for everything else.
readonly RUNTIME_PACKAGES=(git jq minisign ca-certificates curl bubblewrap)

ARTIFACT=''; CHECKSUMS=''; SIGNATURE=''; PUBLIC_KEY=''; DOMAIN=''; ACME_EMAIL=''
MODE_CHECK=0; MODE_DRY_RUN=0; MODE_RESUME=0; MODE_JSON=0; MODE_HELP=0
STAGING_DIR=''; RELEASE_DIR=''; RELEASE_VERSION=''
ARTIFACT_DIGEST=''; CONFIG_DIGEST=''; SUPERSEDED_DIR=''

# In --json mode stdout carries the receipt and nothing else: fd 1 is swapped for
# fd 2 for the whole run and the receipt is written to the saved fd 3. Every log
# line, every piped subprocess and the completion notice therefore land on stderr,
# which is what makes `install.sh --json | jq .` a contract rather than a hope.
RECEIPT_FD=1

die() { echo "${PROGRAM}: ERROR: $*" >&2; exit 1; }
info() { echo "${PROGRAM}: $*"; }
warn() { echo "${PROGRAM}: WARNING: $*" >&2; }

# chown/chgrp are privileged and meaningless in the sandbox; every other
# permission (the mode) is applied in both modes because the tests check it.
set_owner() { [[ ${HARNESS} -eq 1 ]] && return 0; chown "$@"; }
set_group() { [[ ${HARNESS} -eq 1 ]] && return 0; chgrp "$@"; }
# `install` with the root ownership a real host needs, and without it in the
# sandbox. A function rather than an argument array because an empty array
# expanded under `set -u` is a fatal error in the bash the tests may run under.
inst() { if [[ ${HARNESS} -eq 1 ]]; then install "$@"; else install -o root -g root "$@"; fi; }

# The release's own reconciler, as root, against this installation's prefix.
reconcile_install() {
  INFRA_COD_INSTALL_PREFIX="${PREFIX}" "${NODE_BIN}" \
    "${RELEASE_DIR}/services/operations/install-reconcile.mjs" "$1" --release "${RELEASE_DIR}"
}

acquire_lock() {
  mkdir -p "$(dirname -- "${LOCK_FILE}")"
  if ! command -v flock >/dev/null 2>&1; then
    [[ ${HARNESS} -eq 1 ]] || die "flock is required to serialise installer runs"
    return 0
  fi
  exec 200>"${LOCK_FILE}"
  flock -n 200 || die "another installer holds the lock"
}

sha256_of() { sha256sum "$1" | awk '{print $1}'; }

# GNU stat is used on Ubuntu; the BSD form keeps the end-to-end installer
# harness honest on macOS. Modes are returned without a leading zero.
mode_of() {
  stat -c '%a' "$1" 2>/dev/null || stat -f '%Lp' "$1" 2>/dev/null
}

# Block 4 writes a verified release below APP_ROOT before the directory block
# runs. Refuse a pre-existing link or non-directory before that privileged
# write: mkdir -p would otherwise follow the link.
assert_release_paths_safe() {
  local p
  for p in "${APP_ROOT}" "${RELEASES_DIR}"; do
    [[ -e ${p} || -L ${p} ]] || continue
    [[ ! -L ${p} ]] || die "${p} is a symlink; refusing to install a release through it"
    [[ -d ${p} ]] || die "${p} exists and is not a directory"
  done
}

# Is <user> a member of <group>? Reads the group's member list rather than
# `id -nG`, so it answers the same question on a host where the user has not
# logged in and no session has refreshed its supplementary groups.
group_has_member() {
  local user=$1 group=$2
  getent group "${group}" 2>/dev/null \
    | awk -F: -v u="${user}" '{ n = split($4, m, ","); for (i = 1; i <= n; i++) if (m[i] == u) found = 1 } END { exit !found }'
}

# One value out of the generated-secrets file. The file is the only source of
# truth for the pepper and the OAuth key; nothing else may derive them.
generated_secret() {
  local key=$1
  [[ -f ${ETC_ROOT}/.generated-secrets ]] || return 0
  sed -n "s/^${key}=//p" "${ETC_ROOT}/.generated-secrets" | tail -1
}

# Does the stored public key belong to the private key beside it?
#
# "The file exists" is not the question. A public key left over from a previous
# installation, or restored from the wrong backup, is served to every browser
# that enrols an OpenCode key — and the broker then cannot decrypt a single
# envelope, because they were encrypted to a key whose private half is gone.
broker_public_matches() {
  [[ -f ${BROKER_PRIVATE_KEY} && -f ${BROKER_PUBLIC_KEY} ]] || return 1
  local derived rc=0
  derived=$(mktemp)
  openssl rsa -pubout -in "${BROKER_PRIVATE_KEY}" -out "${derived}" 2>/dev/null || rc=1
  [[ ${rc} -eq 0 ]] && { cmp -s "${derived}" "${BROKER_PUBLIC_KEY}" || rc=1; }
  rm -f "${derived}"
  return ${rc}
}

manifest_migration_count() {
  [[ -n ${RELEASE_DIR} && -f ${RELEASE_DIR}/manifest.json ]] || return 0
  sed -n 's/.*"migrationCount"[[:space:]]*:[[:space:]]*\([0-9]*\).*/\1/p' "${RELEASE_DIR}/manifest.json" | head -1
}

# The first `<path>.rN` that is free. Used only when the wanted path is the live
# release: the new tree goes beside it and the symlink does the switching.
free_release_path() {
  local base=$1 n=2
  while [[ -e ${base}.r${n} ]]; do n=$((n + 1)); done
  printf '%s.r%s' "${base}" "${n}"
}

# Re-verifies an installed release against the FILESUMS.sha256 it shipped with.
release_tree_intact() {
  local dir=$1
  [[ -f ${dir}/FILESUMS.sha256 ]] || return 1
  ( cd "${dir}" && sha256sum --quiet -c FILESUMS.sha256 ) >/dev/null 2>&1
}

# Writes <file> from stdin through a temporary file in the same directory, so a
# reader either sees the previous complete file or the new complete one. The
# interrupted `cat tmp > live` this replaces could leave an existing web.env
# truncated to nothing, and nothing would have put the pepper back.
atomic_install_file() {
  local file=$1 mode=$2 owner=$3 t
  t=$(mktemp "${file}.XXXXXX") || die "cannot stage ${file}"
  cat > "${t}"
  chmod "${mode}" "${t}"
  [[ -z ${owner} ]] || set_owner "${owner}" "${t}"
  mv -f "${t}" "${file}"
}

# ---------------------------------------------------------------------------
# Install state
#
# The state file is one line:
#   block step version artifact-digest config-digest release-directory
#
# The directory is recorded separately from the version because they are no
# longer the same thing: a release that had to be installed beside the live one
# lives at `<version>.rN`, and a resume that rebuilt the path from the version
# alone would point at the tree that was replaced.
# The last two are what make `--resume` safe. Resuming a run whose artifact or
# whose --domain/--acme-email differ from the recorded ones would skip exactly
# the blocks that encode those values, so the state is discarded instead and the
# run starts from the beginning.
# ---------------------------------------------------------------------------
STATE_BLOCK=0; STATE_STEP=0; STORED_VERSION=''; STORED_ARTIFACT=''; STORED_CONFIG=''; STORED_DIR=''
STATE_USABLE=0

read_state() {
  STATE_BLOCK=0; STATE_STEP=0; STORED_VERSION=''; STORED_ARTIFACT=''; STORED_CONFIG=''; STORED_DIR=''
  [[ -f ${STATE_FILE} ]] || return 0
  read -r STATE_BLOCK STATE_STEP STORED_VERSION STORED_ARTIFACT STORED_CONFIG STORED_DIR < "${STATE_FILE}" 2>/dev/null || true
  STATE_BLOCK=${STATE_BLOCK:-0}; STATE_STEP=${STATE_STEP:-0}
  STORED_VERSION=${STORED_VERSION:-}; STORED_ARTIFACT=${STORED_ARTIFACT:-}; STORED_CONFIG=${STORED_CONFIG:-}
  STORED_DIR=${STORED_DIR:-${STORED_VERSION}}

  if [[ ${MODE_RESUME} -eq 0 ]]; then return 0; fi
  if [[ ${STORED_ARTIFACT} != "${ARTIFACT_DIGEST}" ]]; then
    warn "resume: recorded artifact digest ${STORED_ARTIFACT:-none} != ${ARTIFACT_DIGEST}; ignoring saved state"
    return 0
  fi
  if [[ ${STORED_CONFIG} != "${CONFIG_DIGEST}" ]]; then
    warn "resume: install parameters changed since the recorded run; ignoring saved state"
    return 0
  fi
  STATE_USABLE=1
  if [[ -n ${STORED_DIR} && -d ${RELEASES_DIR}/${STORED_DIR} ]]; then
    RELEASE_DIR="${RELEASES_DIR}/${STORED_DIR}"; RELEASE_VERSION="${STORED_VERSION}"
  fi
  info "resume: saved state is block ${STATE_BLOCK}.${STATE_STEP} of ${STORED_VERSION:-unknown}"
}

write_state() {
  local b=$1 s=$2 v=${3:-${RELEASE_VERSION}} t
  mkdir -p "${ETC_ROOT}"; chmod 0755 "${ETC_ROOT}"
  t=$(mktemp "${ETC_ROOT}/.install-state.XXXXXX")
  printf '%s %s %s %s %s %s\n' "${b}" "${s}" "${v}" "${ARTIFACT_DIGEST}" "${CONFIG_DIGEST}" \
    "$([[ -n ${RELEASE_DIR} ]] && basename "${RELEASE_DIR}" || echo "${v}")" > "${t}"
  chmod 0600 "${t}"; mv "${t}" "${STATE_FILE}"
  STATE_BLOCK=${b}; STATE_STEP=${s}
}

# Evidence checks. Each answers one question: is the thing this block creates
# actually on disk right now? A block is skipped only when its marker and its
# evidence agree.
evidence_4() {
  # Not "a directory exists" but "the release this run installs is on disk and
  # still matches the checksums it shipped with".
  [[ -n ${RELEASE_DIR} && -f ${RELEASE_DIR}/manifest.json ]] || return 1
  release_tree_intact "${RELEASE_DIR}"
}
evidence_5() {
  local n
  for n in infra-web infra-control infra-cod-github agent-workspace opencode-worker caddy codex-worker; do
    getent group "${n}" >/dev/null 2>&1 || return 1
  done
  for n in infra-web infra-control infra-cod-github caddy codex-worker opencode-worker; do
    getent passwd "${n}" >/dev/null 2>&1 || return 1
  done
  group_has_member infra-control opencode-worker || return 1
  group_has_member infra-cod-github agent-workspace || return 1
  return 0
}

evidence_6() {
  local f
  [[ -d ${APP_ROOT} && ! -L ${APP_ROOT} && $(mode_of "${APP_ROOT}") == 755 ]] || return 1
  [[ -d ${RELEASES_DIR} && ! -L ${RELEASES_DIR} && $(mode_of "${RELEASES_DIR}") == 755 ]] || return 1
  for f in "${ETC_ROOT}/.generated-secrets" "${ETC_ROOT}/backup.passphrase" \
           "${BROKER_PRIVATE_KEY}" "${BROKER_PUBLIC_KEY}"; do
    [[ -f ${f} ]] || return 1
  done
  [[ -n $(generated_secret PEPPER) && -n $(generated_secret OAUTH_KEY) ]] || return 1
  # A public key that is not the public half of the private key beside it is a
  # broken enrolment path that looks entirely healthy from the filesystem.
  broker_public_matches
}
evidence_7() {
  local f
  for f in database.env web.env github-app.env caddy.env; do
    [[ -f ${ETC_ROOT}/${f} ]] || return 1
  done
  # The values this run was invoked with, and the secrets this installation
  # actually holds — not merely "the key is present and non-empty". A web.env
  # carrying somebody else's pepper validates every password against the wrong
  # key, and "non-empty" is exactly what such a file is.
  local pepper okey
  pepper=$(generated_secret PEPPER); okey=$(generated_secret OAUTH_KEY)
  [[ -n ${pepper} && -n ${okey} ]] || return 1
  [[ $(env_value "${ETC_ROOT}/caddy.env" INFRA_COD_DOMAIN) == "${DOMAIN}" ]] || return 1
  [[ $(env_value "${ETC_ROOT}/caddy.env" INFRA_COD_ACME_EMAIL) == "${ACME_EMAIL}" ]] || return 1
  [[ $(env_value "${ETC_ROOT}/web.env" INFRA_COD_SITE_URL) == "https://${DOMAIN}" ]] || return 1
  [[ $(env_value "${ETC_ROOT}/web.env" INFRA_COD_AUTH_PEPPER) == "${pepper}" ]] || return 1
  [[ $(env_value "${ETC_ROOT}/web.env" GITHUB_OAUTH_CODE_ENCRYPTION_KEY) == "${okey}" ]] || return 1
  [[ $(env_value "${ETC_ROOT}/web.env" OPENCODE_BROKER_PUBLIC_KEY_PATH) == "${BROKER_PUBLIC_KEY}" ]] || return 1
  [[ $(env_value "${ETC_ROOT}/github-app.env" GITHUB_OAUTH_CODE_ENCRYPTION_KEY) == "${okey}" ]] || return 1
  return 0
}
evidence_8() {
  # The ledger has to hold the number this release's manifest declares. Any
  # non-zero count would accept a database migrated for a different release.
  local expected; expected=$(manifest_migration_count)
  [[ -n ${expected} ]] || return 1
  [[ $(migration_count) -eq ${expected} ]]
}
evidence_9() {
  cli_shim_current || return 1
  [[ -n ${RELEASE_DIR} ]] || return 1
  # Byte-for-byte against the release, not "a file with that name exists". An
  # edited or stale unit under /etc/systemd/system is precisely what this block
  # is supposed to correct, and a presence check declares it already correct.
  # The same declaration `infra-cod update` reconciles to (WP-A): units,
  # tmpfiles, the Caddyfile and the runtime tool definitions, compared byte for
  # byte by the release's own install-reconcile.mjs.
  reconcile_install check >/dev/null
}
evidence_10() {
  # The database is what holds the operator. The credentials file is a copy of a
  # password that the operator is meant to delete once acknowledged, so its
  # presence proves nothing about whether anyone can sign in — and a restored or
  # rebuilt database with the old file still on disk would skip the bootstrap
  # and leave a panel nobody has an account for.
  [[ $(owner_count) -gt 0 ]]
}
evidence_11() {
  # `current` being *a* symlink says nothing. It has to point at the release
  # this run installs, and the target it belongs to has to be running — the
  # failure this replaces reported "Installation complete" with `current` still
  # aimed at a different release.
  [[ -L ${CURRENT_LINK} ]] || return 1
  [[ -n ${RELEASE_DIR} ]] || return 1
  [[ $(readlink "${CURRENT_LINK}") == "${RELEASE_DIR}" ]] || return 1
  systemctl is-active --quiet infra-cod.target 2>/dev/null || return 1
  return 0
}

# Returns 0 when the block must run, 1 when it is already done. Callers use
# `block_begin N || return 0`, which keeps the skip out of `set -e`'s way: a bare
# `skip_if_done N; [[ $? -eq 1 ]] && ...` aborts the whole script the moment the
# helper returns non-zero, because `set -e` acts before `$?` is ever read.
block_begin() {
  local b=$1
  info "--- block ${b} ---"
  if [[ ${STATE_USABLE} -eq 1 && ${STATE_BLOCK} -gt ${b} ]]; then
    if "evidence_${b}"; then
      info "resume: block ${b} already done, skipping"
      return 1
    fi
    warn "resume: block ${b} is marked done but its result is missing; re-running it"
  fi
  write_state "${b}" 0
  return 0
}
block_end() { write_state "$(( $1 + 1 ))" 0; }

usage() { cat <<'USAGE'; exit 0
Usage: install.sh --artifact <tarball> --checksums <file> --signature <file>
       --public-key <file> --acme-email <email> [--domain <name>]
Without --domain: the domain this host already has, or else <public-ip>.sslip.io.
Modes: --check --dry-run --resume --json --help
USAGE
}

# The domain when none is given. A host that already has one keeps it: running
# the installer again without --domain must not move a live panel to another
# name. A new host gets <public-ip>.sslip.io, a public name that resolves to
# that address, so a first install needs no DNS record and still gets a real
# certificate. Behind NAT the address is private and there is no such name.
default_domain() {
  local recorded ip
  recorded=$(env_value "${ETC_ROOT}/caddy.env" INFRA_COD_DOMAIN)
  if [[ -n ${recorded} ]]; then printf '%s\n' "${recorded}"; return 0; fi
  ip=$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for (i = 1; i < NF; i++) if ($i == "src") { print $(i + 1); exit }}')
  [[ ${ip} =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "--domain required: this host's address could not be read"
  if [[ ${ip} =~ ^(10\.|127\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.|100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\.) ]]; then
    die "--domain required: this host's address ${ip} is private, so <ip>.sslip.io would not reach it"
  fi
  printf '%s.sslip.io\n' "${ip//./-}"
}

parse_args() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --artifact) shift; ARTIFACT=$1 ;;
      --checksums) shift; CHECKSUMS=$1 ;;
      --signature) shift; SIGNATURE=$1 ;;
      --public-key) shift; PUBLIC_KEY=$1 ;;
      --domain) shift; DOMAIN=$1 ;;
      --acme-email) shift; ACME_EMAIL=$1 ;;
      --check) MODE_CHECK=1 ;;
      --dry-run) MODE_DRY_RUN=1 ;;
      --resume) MODE_RESUME=1 ;;
      --json) MODE_JSON=1 ;;
      --help|-h) MODE_HELP=1 ;;
      *) die "unknown: $1" ;;
    esac; shift
  done
  [[ ${MODE_HELP} -eq 1 ]] && usage
  if [[ ${MODE_CHECK} -eq 0 && ${MODE_DRY_RUN} -eq 0 ]]; then
    [[ -n ${ARTIFACT} && -f ${ARTIFACT} ]] || die "--artifact required"
    [[ -n ${CHECKSUMS} && -f ${CHECKSUMS} ]] || die "--checksums required"
    [[ -n ${SIGNATURE} && -f ${SIGNATURE} ]] || die "--signature required"
    [[ -n ${PUBLIC_KEY} && -f ${PUBLIC_KEY} ]] || die "--public-key required"
    # default_domain runs in a subshell: its die ends only that, so its status is checked here.
    if [[ -z ${DOMAIN} ]]; then DOMAIN=$(default_domain) || exit 1; fi
    [[ -n ${ACME_EMAIL} ]] || ACME_EMAIL=$(env_value "${ETC_ROOT}/caddy.env" INFRA_COD_ACME_EMAIL)
    [[ -n ${ACME_EMAIL} ]] || die "--acme-email required"
    # Both values are written into environment files that systemd and Caddy
    # parse line by line. A newline in either would inject a second variable, and
    # a space or a quote would produce a file that parses as something else than
    # what the operator typed.
    [[ ${DOMAIN} =~ ^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$ ]] \
      || die "--domain is not a plain DNS name: ${DOMAIN}"
    [[ ${ACME_EMAIL} =~ ^[A-Za-z0-9._%+-]+@[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$ ]] \
      || die "--acme-email is not an email address: ${ACME_EMAIL}"
  fi
  return 0
}

# ---------------------------------------------------------------------------
# Preflight, in two halves.
#
# The first half asks what cannot be changed by installing anything: the OS, the
# architecture, the memory, the disk, the privilege and who already holds the
# ports. It runs BEFORE apt, because the previous order installed packages onto a
# machine it was about to refuse — a rejected host should leave with nothing added
# to it.
#
# The second half asks what the prerequisites step is allowed to fix, and runs
# after it.
# ---------------------------------------------------------------------------
# Who is listening on <port>, or nothing.
#
# `ss` prints a column header even when the filter matches nothing, so the
# obvious `ss -tlnp "sport = :80" | grep -q .` is true on a completely free port.
# The first real Ubuntu run died on `port 80 in use: unknown` on an idle host
# because of exactly that. `-H` suppresses the header, which is the only thing
# that makes the emptiness of this output meaningful.
port_holder() {
  local port=$1
  # `sed`, not `grep -oP`: PCRE is a GNU extension and the sandbox that keeps
  # this code honest runs on a host whose grep does not have it.
  ss -H -tlnp "sport = :${port}" 2>/dev/null | sed -n 's/.*users:((//p' | head -1
}

port_is_free() {
  local lines
  lines=$(ss -H -tln "sport = :$1" 2>/dev/null | grep -c . || true)
  [[ ${lines} -eq 0 ]]
}

# Is this port held by the unit that is supposed to hold it?
#
# The previous answer was a regular expression over the process name, and the
# panel's process is called `next-server`, which was not in it — so the second
# install refused the panel the first install had just started. A name is a guess;
# the process identity is not. `MainPID` is asked first, and the listener's
# control group settles any case where the unit forked.
port_owned_by_unit() {
  local port=$1 unit=$2 line pid main
  line=$(ss -H -tlnp "sport = :${port}" 2>/dev/null | head -1)
  [[ -n ${line} ]] || return 1
  pid=$(printf '%s' "${line}" | sed -n 's/.*pid=\([0-9]*\).*/\1/p' | head -1)
  [[ -n ${pid} ]] || return 1

  main=$(systemctl show -p MainPID --value "${unit}" 2>/dev/null || echo 0)
  [[ ${main} =~ ^[0-9]+$ ]] || main=0
  [[ ${main} -gt 0 && ${main} -eq ${pid} ]] && return 0

  # Forked, or a worker holding the socket: the control group names the unit.
  [[ -r /proc/${pid}/cgroup ]] && grep -q "${unit}" "/proc/${pid}/cgroup" && return 0
  return 1
}

# The ports the installation publishes, and the one PostgreSQL owns.
#
# Runs in the sandbox too — it is read-only, and stubbing `ss` is how the header
# bug above is kept fixed.
check_ports() {
  local port unit holder
  for port in 80 443 3100; do
    case "${port}" in
      3100) unit=infra-cod-web.service ;;
      *) unit=infra-cod-caddy.service ;;
    esac
    holder=$(port_holder "${port}")
    if [[ -z ${holder} ]]; then
      if port_is_free "${port}"; then continue; fi
      # A listener whose process `ss` would not name: without the privileges to
      # see it, or a socket in another namespace. Not ours to assume.
      die "port ${port} is in use by a process this installer cannot identify"
    fi
    if port_owned_by_unit "${port}" "${unit}"; then
      info "port ${port}: ${unit} (re-run OK)"
    else
      die "port ${port} in use by something that is not ${unit}: ${holder}"
    fi
  done
  holder=$(port_holder 5432)
  [[ -n ${holder} ]] && info "port 5432: ${holder} (re-run OK)"
  return 0
}

preflight_immutable() {
  info "--- preflight: host ---"
  if [[ ${HARNESS} -eq 1 ]]; then
    info "harness mode: host checks skipped (prefix ${PREFIX})"
    check_ports
    return 0
  fi
  [[ ${EUID} -eq 0 ]] || die "must run as root"
  grep -q "Ubuntu 24.04" /etc/os-release 2>/dev/null || die "requires Ubuntu 24.04"
  [[ $(uname -m) == x86_64 ]] || die "requires x86_64"
  local ram_mb; ram_mb=$(awk '/^MemTotal:/ { print int($2/1024) }' /proc/meminfo)
  [[ ${ram_mb} -ge 1900 ]] || die "min ~2 GB RAM, got ${ram_mb} MB"
  local free_gb; free_gb=$(df -BG / | awk 'NR==2 { gsub(/G/,"",$4); print $4 }')
  [[ ${free_gb} -ge 10 ]] || die "min 10 GB free, got ~${free_gb} GB"
  timedatectl show 2>/dev/null | grep -q 'NTPSynchronized=yes' || warn "NTP not synced"

  check_ports
  if [[ -n ${DOMAIN} ]]; then
    local r; r=$(host "${DOMAIN}" 2>/dev/null | awk '/has address/{print $NF;exit}' || true)
    [[ -n ${r} ]] || warn "cannot resolve ${DOMAIN}"
  fi
  info "host preflight passed"
}

# Packages a clean Ubuntu 24.04 host does not necessarily have but the installed
# system needs at runtime. Mutating, so it never runs from --check or --dry-run.
install_prerequisites() {
  local need_apt=() p
  for p in "${RUNTIME_PACKAGES[@]}"; do
    case "${p}" in
      ca-certificates) [[ -e /etc/ssl/certs/ca-certificates.crt ]] || need_apt+=("${p}") ;;
      bubblewrap) command -v bwrap >/dev/null 2>&1 || need_apt+=("${p}") ;;
      *) command -v "${p}" >/dev/null 2>&1 || need_apt+=("${p}") ;;
    esac
  done
  if [[ ${#need_apt[@]} -gt 0 ]]; then
    info "installing missing packages: ${need_apt[*]}"
    apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "${need_apt[@]}"
  fi
}

preflight_tools() {
  info "--- preflight: tools ---"
  # Before any block runs, and on a resume too: a runtime path that has been
  # replaced by a symlink is a host fact, and the installer's own message about
  # it is clearer than the one whichever later step happens to trip over it.
  assert_runtime_paths_safe
  assert_release_paths_safe

  [[ -x ${VERIFY_GATE} ]] || die "verify-release.sh not found at ${VERIFY_GATE}"
  [[ -f ${INSTALL_MANIFEST} ]] || die "install-manifest.json not found at ${INSTALL_MANIFEST}"

  # git is a runtime dependency of the provisioner, not a convenience: a host
  # without it installs and then cannot clone a single project workspace.
  local m=() t
  for t in systemctl tar sha256sum openssl curl minisign jq git; do
    command -v "${t}" >/dev/null 2>&1 || m+=("${t}")
  done
  command -v host >/dev/null 2>&1 || warn "host not found (DNS checks disabled)"
  [[ ${#m[@]} -eq 0 ]] || die "missing required tools: ${m[*]}"
  info "tool preflight passed"
}

# What --check and --dry-run report: both halves, neither mutating.
preflight_checks() { preflight_immutable; preflight_tools; }

# --------------------------------------------------------------------------- Install Node (pinned SHA-256)
install_node() {
  if [[ -x ${NODE_BIN} ]]; then
    local v; v=$("${NODE_BIN}" --version 2>/dev/null || true)
    if [[ ${v} == "v${NODE_VERSION}" ]]; then info "Node ${NODE_VERSION} already installed"; return 0; fi
  fi
  local url="https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz"
  local tb="${STAGING_DIR}/node-v${NODE_VERSION}-linux-x64.tar.xz"
  info "downloading Node ${NODE_VERSION}..."
  curl -fsSL -o "${tb}" "${url}" || die "failed to download Node"
  local expected actual
  expected=$(jq -r '.node.sha256 // ""' "${INSTALL_MANIFEST}")
  [[ -n ${expected} && ${expected} != "null" ]] || die "no pinned Node checksum in ${INSTALL_MANIFEST}"
  actual=$(sha256_of "${tb}")
  [[ ${actual} == "${expected}" ]] || die "Node checksum mismatch: expected ${expected}, got ${actual}"
  info "Node checksum OK"
  rm -rf "${NODE_ROOT}" 2>/dev/null || true; mkdir -p "${PREFIX}/opt"
  tar -xJf "${tb}" -C "${PREFIX}/opt" || die "Node extraction failed"
  mv "${PREFIX}/opt/node-v${NODE_VERSION}-linux-x64" "${NODE_ROOT}"
  local v; v=$("${NODE_BIN}" --version 2>/dev/null || true)
  [[ ${v} == "v${NODE_VERSION}" ]] || die "installed Node ${v} != expected v${NODE_VERSION}"
  info "Node ${v} installed"
}

# ---------------------------------------------------------------------------
# Caddy, pinned by path and by version.
#
# `command -v caddy` was the wrong question twice over: it accepts any build of
# any version anywhere on PATH, while `infra-cod-caddy.service` runs exactly
# /usr/bin/caddy. A stale /usr/local/bin/caddy satisfied the installer and the
# unit then failed to start, or started a version the Caddyfile was never
# validated against.
# ---------------------------------------------------------------------------
caddy_version_of() { "$1" version 2>/dev/null | head -1 | awk '{print $1}'; }

install_caddy() {
  local have
  if [[ -x ${CADDY_BIN} ]]; then
    have=$(caddy_version_of "${CADDY_BIN}")
    if [[ ${have} == "v${CADDY_VERSION}" ]]; then
      info "Caddy ${have} already installed at ${CADDY_BIN}"; return 0
    fi
    warn "replacing ${CADDY_BIN}: found ${have:-unreadable}, expected v${CADDY_VERSION}"
  fi
  local url="https://github.com/caddyserver/caddy/releases/download/v${CADDY_VERSION}/caddy_${CADDY_VERSION}_linux_amd64.tar.gz"
  local tb="${STAGING_DIR}/caddy_${CADDY_VERSION}_linux_amd64.tar.gz"
  info "downloading Caddy ${CADDY_VERSION}..."
  curl -fsSL -o "${tb}" "${url}" || die "failed to download Caddy"
  local expected actual
  expected=$(jq -r '.caddy.sha256 // ""' "${INSTALL_MANIFEST}")
  [[ -n ${expected} && ${expected} != "null" ]] || die "no pinned Caddy checksum in ${INSTALL_MANIFEST}"
  actual=$(sha256_of "${tb}")
  [[ ${actual} == "${expected}" ]] || die "Caddy checksum mismatch: expected ${expected}, got ${actual}"
  info "Caddy checksum OK"
  local cx; cx=$(mktemp -d)
  tar -xzf "${tb}" -C "${cx}" || die "Caddy extraction failed"
  [[ -f ${cx}/caddy ]] || die "caddy binary not found in archive"
  inst -d -m 0755 "${PREFIX}/usr/bin"
  inst -m 0755 "${cx}/caddy" "${CADDY_BIN}"; rm -rf "${cx}"
  have=$(caddy_version_of "${CADDY_BIN}")
  [[ ${have} == "v${CADDY_VERSION}" ]] || die "installed Caddy reports ${have:-nothing}, expected v${CADDY_VERSION}"
  info "Caddy ${have} installed at ${CADDY_BIN}"
}

# --------------------------------------------------------------------------- Block 4: artifact install (trust chain)
install_artifact() {
  block_begin 4 || return 0
  STAGING_DIR=$(mktemp -d); umask 077; info "staging: ${STAGING_DIR}"

  # Step 4.1: the shell gate runs WITHOUT --version — the version is not known
  # until the verified tree exists, and reading it from the tarball's own name
  # would be trusting the thing under verification.
  local ve; ve=$(mktemp -d)
  info "running trusted shell gate: ${VERIFY_GATE}"
  "${VERIFY_GATE}" --artifact "${ARTIFACT}" --checksums "${CHECKSUMS}" \
    --signature "${SIGNATURE}" --public-key "${PUBLIC_KEY}" \
    --require-signature --extract "${ve}" 2>&1 | sed 's/^/  gate: /'

  # Step 4.2: read the version from the EXTRACTED (verified) tree.
  local top_dir; top_dir=$(ls "${ve}"/ | head -1)
  [[ -n ${top_dir} && -d ${ve}/${top_dir} ]] || die "cannot find extracted release directory"
  local manifest="${ve}/${top_dir}/manifest.json"
  [[ -f ${manifest} ]] || die "manifest.json not found in verified tree"
  local rv
  rv=$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "${manifest}" | head -1)
  [[ -n ${rv} ]] || die "cannot determine version from manifest"
  info "version: ${rv}"

  # Step 4.3: Node and Caddy, which the deep verifier needs.
  install_node
  install_caddy

  # Step 4.4: deep verifier from the verified tree (FILESUMS, symlinks, smoke).
  local dp="${ve}/${top_dir}/scripts/verify-release.mjs"
  [[ -f ${dp} ]] || die "deep verifier missing: ${dp}"
  local de; de=$(mktemp -d)
  info "running deep verifier..."
  "${NODE_BIN}" "${dp}" --artifact "${ARTIFACT}" --checksums "${CHECKSUMS}" \
    --signature "${SIGNATURE}" --public-key "${PUBLIC_KEY}" \
    --require-signature --target linux-x64 \
    --extract "${de}" --version "${rv}" --smoke 2>&1 | sed 's/^/  deep: /'
  rm -rf "${de}" 2>/dev/null || true

  local tgt="${RELEASES_DIR}/${rv}"
  if [[ -d ${tgt} ]]; then
    local ct; ct=$(readlink "${CURRENT_LINK}" 2>/dev/null || true)
    # Same version and already current is the common re-run, but "the directory
    # exists" is not the same fact as "the directory is intact". The installed
    # tree is re-checked against its own FILESUMS before it is trusted; a tree
    # that fails is replaced with the verified one rather than reused.
    if [[ ${ct} == "${tgt}" ]] && release_tree_intact "${tgt}"; then
      info "release ${rv} installed, current and intact — no-op"
      rm -rf "${ve}" "${STAGING_DIR}" 2>/dev/null || true
      RELEASE_DIR="${tgt}"; RELEASE_VERSION="${rv}"
      block_end 4; return 0
    fi
    if [[ ${ct} == "${tgt}" ]]; then
      warn "installed release ${rv} does not match its own FILESUMS — replacing it"
    else
      info "release ${rv} exists (not current), replacing..."
    fi
  fi

  # Never touch the directory `current` resolves to.
  #
  # Renaming the live tree aside and renaming the new one in is two operations,
  # and between them the path does not exist: a machine that dies in that window
  # comes back with `current` pointing at nothing. The symlink is the only thing
  # that is allowed to change atomically, so a release that would have to replace
  # the live tree is installed beside it under a fresh name instead, and block 11
  # flips `current` onto it. At every instant, before and after, `current`
  # resolves to a complete release.
  #
  # Created with the mode they have to end up with, not with whatever `umask 077`
  # above would leave. Block 6 sets it too, and that is what repairs a host
  # installed before this line existed — but between block 4 and block 6 the app
  # root would otherwise be 0700, and a run that stopped in between left every
  # non-root service failing at WorkingDirectory with status=200/CHDIR.
  inst -d -m 0755 "${APP_ROOT}" "${RELEASES_DIR}"
  local live; live=$(readlink "${CURRENT_LINK}" 2>/dev/null || true)
  local dest="${tgt}"
  if [[ -e ${tgt} ]]; then
    if [[ ${live} == "${tgt}" ]]; then
      dest=$(free_release_path "${tgt}")
      info "release ${rv} is live at ${tgt}; installing beside it at $(basename "${dest}")"
      SUPERSEDED_DIR="${tgt}"
    else
      # Nothing points at this path, so replacing it in place endangers nothing.
      rm -rf "${tgt}"
    fi
  fi
  mv "${ve}/${top_dir}" "${dest}" || die "could not install release ${rv} at ${dest}; ${live:-no release} is untouched"
  rm -rf "${ve}" "${STAGING_DIR}" 2>/dev/null || true
  RELEASE_DIR="${dest}"; RELEASE_VERSION="${rv}"
  info "release staged at ${dest}"
  block_end 4
}

# --------------------------------------------------------------------------- Block 5: users and groups
# A host still on the proof-of-concept layout (codex-poc, /srv/infra-cod-handoff-poc)
# is moved by `infra-cod update`, which stops every service first and moves the
# account, its home and the workspaces together with the database (WP-5c). This
# installer would instead create codex-worker beside codex-poc, so it refuses.
assert_layout_installable() {
  [[ -n ${RELEASE_DIR} && -f ${RELEASE_DIR}/services/operations/layout-migration.mjs ]] || return 0
  local layout
  layout=$(INFRA_COD_INSTALL_PREFIX="${PREFIX}" "${NODE_BIN}" "${RELEASE_DIR}/services/operations/layout-migration.mjs" plan \
    | "${NODE_BIN}" -e 'let s="";process.stdin.on("data",(d)=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s).layout))') \
    || die "the host layout could not be read"
  case "${layout}" in
    fresh|current) return 0 ;;
    legacy) die "this host is on the proof-of-concept layout (codex-poc); update it with \`infra-cod update\`, which moves it" ;;
    *) die "this host is on neither layout (${layout}); see \`node ${RELEASE_DIR}/services/operations/layout-migration.mjs plan\`" ;;
  esac
}

setup_users_groups() {
  block_begin 5 || return 0
  assert_layout_installable
  # codex-worker is in this list because the useradd below names it with --gid: a
  # group that is not created first makes `useradd --gid codex-worker` fail and the
  # whole clean install with it.
  local g u
  for g in infra-web infra-control infra-cod-github agent-workspace opencode-worker caddy codex-worker claude-worker; do
    getent group "${g}" >/dev/null || groupadd --system "${g}"
  done
  for u in infra-web infra-control infra-cod-github caddy; do
    getent passwd "${u}" >/dev/null || useradd --system --gid "${u}" --home-dir "${PREFIX}/var/lib/${u}" --shell /usr/sbin/nologin "${u}"
  done
  for u in codex-worker opencode-worker claude-worker; do
    getent passwd "${u}" >/dev/null || useradd --system --gid "${u}" --create-home --shell /usr/sbin/nologin "${u}"
  done
  # These two memberships are how the control plane reaches the OpenCode worker
  # socket and how the GitHub worker reaches a project workspace. Losing one is a
  # broken installation that starts and then cannot do its job, so a failure here
  # stops the install instead of being swallowed by `|| true`.
  add_membership infra-control opencode-worker
  add_membership infra-cod-github agent-workspace
  block_end 5
}

# The per-agent state directories inside the runtime users' homes.
#
# `useradd --create-home` makes the home; it does not make these. systemd
# resolves them while building infra-cod-runtime-supervisor.service's mount
# namespace, before ExecStart, so a missing one is status=226/NAMESPACE and the
# supervisor never starts.
#
# Root does not create them, and root does not chmod or chown them.
#
# These paths live inside a directory the runtime user owns and can write. A
# `mkdir -p` accepts a symlink that is already there, and a following `chmod` and
# `chown` act on whatever it points at — so `codex-worker` replacing its own
# `.codex` with a link to /etc would have had the installer hand /etc to
# `codex-worker`. There is no ordering of lstat-then-chmod that closes that: the
# check and the change are two operations on a path the attacker can swap
# between them.
#
# `systemd-tmpfiles` is the one mechanism that creates these safely. It walks the
# path component by component with the symlink protections this shell cannot
# express, and it refuses an unsafe transition rather than completing one. The
# installer's job is therefore to run it and then to verify — and to refuse, not
# to repair, when a runtime path is not a plain directory.
readonly RUNTIME_HOME_PATHS=(
  /home/codex-worker
  /home/codex-worker/.codex
  /home/opencode-worker
  /home/opencode-worker/.local
  /home/opencode-worker/.cache
  /home/opencode-worker/.cache/opencode
  /home/opencode-worker/.config
  /home/opencode-worker/.config/opencode
  /home/opencode-worker/.config/opencode/tools
  /home/claude-worker
  /home/claude-worker/.claude
)

# A runtime path that is not a plain directory is a refusal with a name.
#
# This is a gate, not a guard for a later privileged write: nothing that follows
# mutates these paths as root, so there is no window between the look and the
# change for anything to be swapped into.
assert_runtime_paths_safe() {
  local relative full
  for relative in "${RUNTIME_HOME_PATHS[@]}"; do
    full="${PREFIX}${relative}"
    [[ -e ${full} || -L ${full} ]] || continue
    if [[ -L ${full} ]]; then
      die "${full} is a symlink. It is inside a directory its runtime user can write, so this is how \
that user would aim a privileged operation at somebody else's files. Remove it and re-run; the \
installer will not follow it and will not replace it."
    fi
    [[ -d ${full} ]] || die "${full} exists and is not a directory"
  done
}

runtime_homes_present() {
  local dir
  for dir in "${PREFIX}/home/codex-worker/.codex" "${PREFIX}/home/opencode-worker/.local" \
             "${PREFIX}/home/opencode-worker/.config/opencode/tools"; do
    # A symlink is never "present": following one is exactly what must not happen.
    [[ -d ${dir} && ! -L ${dir} ]] || return 1
  done
  return 0
}

add_membership() {
  local user=$1 group=$2
  if ! group_has_member "${user}" "${group}"; then
    usermod -aG "${group}" "${user}" || die "could not add ${user} to group ${group}"
  fi
  group_has_member "${user}" "${group}" || die "${user} is still not a member of ${group}"
}

# ---------------------------------------------------------------------------
# Block 6: directories and generated secrets.
#
# The marker file says the secrets were generated once. It does not say they are
# still there, and it used to be read as if it did: a missing broker key made the
# block exit immediately, so a re-run could never put the installation back
# together. What follows checks each secret and then says exactly one of three
# things — it is fine, it can be rebuilt, or it is gone and only the operator can
# decide what that means.
# ---------------------------------------------------------------------------
setup_directories_keys() {
  block_begin 6 || return 0
  # APP_ROOT is created implicitly by block 4 under umask 077. Naming it here is
  # essential: changing only RELEASES_DIR leaves the parent at 0700, so every
  # non-root service fails before ExecStart with status=200/CHDIR.
  inst -d -m 0755 "${APP_ROOT}" "${RELEASES_DIR}" "${ETC_ROOT}" "${CADDY_DIR}" "${OPENCODE_DIR}" \
    "${BACKUP_ROOT}" "${OBSERVABILITY_ROOT}" "${WORKSPACE_ROOT}" \
    "${SYSTEMD_DIR}" "${TMPFILES_DIR}"
  # These three carry a group and a mode that a unit's mount namespace and the
  # runtime users depend on; deploy/tmpfiles.d declares the same values, so the
  # two agree and `systemd-tmpfiles --create` puts them back after a cleanup.
  inst -d -m 0750 "${GITHUB_APP_DIR}" "${GITHUB_DEPLOY_KEYS_DIR}"
  inst -d "${GATE_SMOKE_ROOT}"
  set_group infra-cod-github "${GITHUB_APP_DIR}"
  set_group infra-control "${GITHUB_DEPLOY_KEYS_DIR}" "${GATE_SMOKE_ROOT}"
  # Mode last, and after the group: a chgrp can clear the setgid bit, and the
  # setgid bit on the gate root is what makes each scratch directory inherit
  # infra-control. These paths are root-owned with root-owned parents, so unlike
  # the runtime homes there is nothing here an unprivileged account could have
  # substituted between the two calls.
  chmod 2771 "${GATE_SMOKE_ROOT}"

  # The decision is made by looking at the secrets, never at the marker.
  #
  # `.secrets-generated` is a zero-byte file, the least durable artefact in the
  # set and the one an operator is most likely to remove — and while it was the
  # gate, losing it meant the next run silently minted a new pepper, a new backup
  # passphrase and a new broker key on top of an installation that was still
  # using the old ones. Every stored password hash, every existing backup and
  # every stored OpenCode credential would have been invalidated in silence, by a
  # command whose whole promise is that re-running it is safe.
  if secrets_exist; then
    recover_existing_secrets
    apply_secret_permissions
    # Restores the marker when it is the only thing that went missing.
    touch "${ETC_ROOT}/.secrets-generated"
    block_end 6; return 0
  fi

  # Nothing under /etc/infra-cod — but /etc is not the only witness.
  #
  # A wiped or unmounted /etc leaves no secret to find, and generating a fresh
  # set then looks like a clean install right up to the moment the operator
  # cannot sign in: the password hashes in the database are still peppered with
  # the key that was just replaced, and the stored OpenCode envelopes can no
  # longer be decrypted by anybody. The database is asked before anything is
  # minted, and a database that already holds this installation's data means
  # this is not a new installation, whatever /etc looks like.
  refuse_if_database_has_data

  info "generating secrets for a new installation"
  local pepper okey bpass
  pepper=$(openssl rand -base64 32 | tr -d '\n')
  okey=$(openssl rand -hex 32 | tr -d '\n')
  bpass=$(openssl rand -base64 48 | tr -d '\n')

  local bkt bpt
  bkt=$(mktemp); bpt=$(mktemp)
  openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out "${bkt}" 2>/dev/null || die "key gen failed"
  chmod 0600 "${bkt}"; openssl rsa -pubout -in "${bkt}" -out "${bpt}" 2>/dev/null || die "pubkey extract failed"

  printf '%s' "${bpass}" | atomic_install_file "${ETC_ROOT}/backup.passphrase" 0600 root:root
  cat "${bkt}" | atomic_install_file "${BROKER_PRIVATE_KEY}" 0640 ''
  cat "${bpt}" | atomic_install_file "${BROKER_PUBLIC_KEY}" 0644 root:root
  rm -f "${bkt}" "${bpt}"

  printf 'PEPPER=%s\nOAUTH_KEY=%s\nBACKUP_PASSPHRASE=%s\n' "${pepper}" "${okey}" "${bpass}" \
    | atomic_install_file "${ETC_ROOT}/.generated-secrets" 0600 root:root
  openssl pkey -in "${BROKER_PRIVATE_KEY}" -noout 2>/dev/null || die "broker key not valid PEM"
  apply_secret_permissions
  touch "${ETC_ROOT}/.secrets-generated"; info "secrets generated"
  block_end 6
}

# Does a control plane already exist that the secrets about to be generated
# would orphan? Asked only when /etc has nothing left to say.
#
# On a genuinely clean host this is cheap and silent: PostgreSQL is not installed
# yet — block 8 is what installs it — so there is no psql to run and no cluster to
# ask, and the answer is "no data".
refuse_if_database_has_data() {
  if [[ ! -x ${PG_BIN}/psql ]]; then
    # A missing client is not an absent database. Purging the PostgreSQL packages
    # removes the binaries and leaves /var/lib/postgresql where it is, so a host
    # that lost /etc and its packages can still be holding the cluster whose
    # password hashes the pepper about to be generated would orphan.
    #
    # Every other trace of a previous installation is therefore looked for too,
    # and any one of them is enough to refuse.
    # Only things this run did not create. The release directory and the state
    # file are written by this very invocation — counting them would make every
    # clean install refuse itself.
    local traces=() t other
    for t in "${PREFIX}/var/lib/postgresql" "${BACKUP_ROOT}" "${OBSERVABILITY_ROOT}"; do
      [[ -d ${t} ]] && [[ -n $(ls -A "${t}" 2>/dev/null) ]] && traces+=("${t}")
    done
    # A release directory other than the one this run just installed.
    if [[ -d ${RELEASES_DIR} && -n ${RELEASE_DIR} ]]; then
      other=$(ls -A "${RELEASES_DIR}" 2>/dev/null | grep -vFx "$(basename "${RELEASE_DIR}")" | head -1 || true)
      [[ -n ${other} ]] && traces+=("${RELEASES_DIR}/${other}")
    fi
    if [[ ${#traces[@]} -gt 0 ]]; then
      local item
      for item in "${traces[@]}"; do warn "trace of a previous installation: ${item}"; done
      die "${ETC_ROOT} holds no secrets, but this host carries ${#traces[@]} trace(s) of a previous \
installation and PostgreSQL is not installed, so whether a cluster with data in it survives here \
cannot be determined. Install postgresql-client-17 and re-run so the question can be answered, or \
restore ${ETC_ROOT} from a backup. Refusing to generate secrets on a guess."
    fi
    return 0
  fi

  local out rc

  # psql exists, so a previous run reached block 8. From here on, "I could not
  # find out" is never allowed to mean "there is nothing there": that is exactly
  # how a stopped cluster or a refused connection would have licensed minting a
  # new pepper over a live control plane.
  rc=0; out=$(psql_query postgres "SELECT 1") || rc=$?
  if [[ ${rc} -ne 0 ]]; then
    die "PostgreSQL is installed on this host but the cluster did not answer, so whether a \
control plane already exists here cannot be determined — and ${ETC_ROOT} has no secrets to match one. \
Start the cluster and re-run. Refusing to generate secrets on a guess: if a control plane is there, \
a new pepper would leave every stored password hash unverifiable."
  fi

  rc=0; out=$(psql_query postgres "SELECT count(*) FROM pg_database WHERE datname = '${PG_DATABASE}'") || rc=$?
  [[ ${rc} -eq 0 && ${out} =~ ^[0-9]+$ ]] \
    || die "cannot determine whether the ${PG_DATABASE} database exists; refusing to generate secrets on a guess"
  [[ ${out} -eq 0 ]] && return 0

  # The database exists. Has it been migrated? An empty database from a run that
  # got as far as `createdb` holds nothing that a new pepper could orphan.
  rc=0; out=$(psql_query "${PG_DATABASE}" "SELECT to_regclass('control_plane.users') IS NOT NULL") || rc=$?
  [[ ${rc} -eq 0 ]] \
    || die "the ${PG_DATABASE} database exists but could not be inspected; refusing to generate secrets on a guess"
  [[ ${out} == "t" ]] || return 0

  local users hashes
  rc=0; users=$(psql_query "${PG_DATABASE}" "SELECT count(*) FROM control_plane.users") || rc=$?
  [[ ${rc} -eq 0 && ${users} =~ ^[0-9]+$ ]] \
    || die "control_plane.users exists but could not be counted; refusing to generate secrets on a guess"
  [[ ${users} -gt 0 ]] || return 0

  rc=0; hashes=$(psql_query "${PG_DATABASE}" "SELECT count(*) FROM control_plane.users WHERE password_hash IS NOT NULL") || rc=$?
  [[ ${rc} -eq 0 && ${hashes} =~ ^[0-9]+$ ]] || hashes=${users}
  warn "${ETC_ROOT} holds no secrets, but ${PG_DATABASE} already has ${users} user(s)"
  die "this host has a control-plane database with data in it and no secrets to match. \
Generating a new auth pepper would leave every one of those ${hashes} stored password hash(es) \
unverifiable, and a new broker key would orphan every stored OpenCode credential. \
Restore ${ETC_ROOT} from a backup. To start over and accept that loss, drop the ${PG_DATABASE} \
database first — that way the destruction is something you asked for, not something this \
installer did quietly."
}

# Has this host ever generated secrets? Any one of the permanent artefacts is
# enough to answer yes: what follows must then repair, or refuse, but never
# regenerate.
secrets_exist() {
  local f
  for f in "${ETC_ROOT}/.generated-secrets" "${ETC_ROOT}/backup.passphrase" \
           "${BROKER_PRIVATE_KEY}" "${BROKER_PUBLIC_KEY}" "${ETC_ROOT}/.secrets-generated"; do
    [[ -e ${f} ]] && return 0
  done
  return 1
}

# What a re-run may and may not rebuild.
#
# The pepper keys every stored password hash, the backup passphrase decrypts every
# existing backup, and the broker private key is the only thing that can decrypt
# the OpenCode envelopes already in PostgreSQL. None of the three can be
# regenerated without destroying data that still refers to it, so a missing one is
# a refusal with a name, not a silent regeneration and not a silent skip.
#
# The broker *public* key is the exception: it is derivable from the private key,
# so a missing — or mismatched — one is rebuilt on the spot.
recover_existing_secrets() {
  local lost=()
  [[ -f ${ETC_ROOT}/.generated-secrets ]] || lost+=("${ETC_ROOT}/.generated-secrets (auth pepper, OAuth key)")
  [[ -f ${ETC_ROOT}/backup.passphrase ]] || lost+=("${ETC_ROOT}/backup.passphrase (decrypts existing backups)")
  [[ -f ${BROKER_PRIVATE_KEY} ]] || lost+=("${BROKER_PRIVATE_KEY} (decrypts stored OpenCode credentials)")
  if [[ ${#lost[@]} -eq 0 ]]; then
    [[ -n $(generated_secret PEPPER) ]] || lost+=("${ETC_ROOT}/.generated-secrets: PEPPER is empty")
    [[ -n $(generated_secret OAUTH_KEY) ]] || lost+=("${ETC_ROOT}/.generated-secrets: OAUTH_KEY is empty")
  fi
  if [[ ${#lost[@]} -gt 0 ]]; then
    local item
    for item in "${lost[@]}"; do warn "unrecoverable secret missing: ${item}"; done
    die "this installation has generated secrets before, but ${#lost[@]} of them are gone. \
Regenerating them would silently invalidate stored password hashes, backups or OpenCode credentials. \
Restore them from a backup. To start a NEW installation and accept that loss, delete the secret files \
themselves under ${ETC_ROOT} — removing only the .secrets-generated marker is no longer enough, and \
never was a safe way to say it."
  fi

  ensure_broker_public_key
  openssl pkey -in "${BROKER_PRIVATE_KEY}" -noout 2>/dev/null || die "${BROKER_PRIVATE_KEY} is not a valid PEM key"
  info "secrets present"
}

ensure_broker_public_key() {
  if broker_public_matches; then return 0; fi
  if [[ -f ${BROKER_PUBLIC_KEY} ]]; then
    warn "the broker public key is not the public half of ${BROKER_PRIVATE_KEY}; replacing it"
  else
    info "rebuilding the broker public key from the private half"
  fi
  local bpt; bpt=$(mktemp)
  openssl rsa -pubout -in "${BROKER_PRIVATE_KEY}" -out "${bpt}" 2>/dev/null || die "cannot derive the broker public key"
  cat "${bpt}" | atomic_install_file "${BROKER_PUBLIC_KEY}" 0644 root:root
  rm -f "${bpt}"
}

# Re-applied on every run, not only at generation: `doctor` treats a wrong mode
# or group on any of these as critical, so a re-run is the repair path for one.
apply_secret_permissions() {
  chmod 0600 "${ETC_ROOT}/.generated-secrets"; set_owner root:root "${ETC_ROOT}/.generated-secrets"
  chmod 0600 "${ETC_ROOT}/backup.passphrase"; set_owner root:root "${ETC_ROOT}/backup.passphrase"
  chmod 0640 "${BROKER_PRIVATE_KEY}"; set_owner root:root "${BROKER_PRIVATE_KEY}"; set_group infra-control "${BROKER_PRIVATE_KEY}"
  # World-readable on purpose: it is a public key, and the panel reads it as
  # infra-web while the broker holds the private half as infra-control.
  chmod 0644 "${BROKER_PUBLIC_KEY}"; set_owner root:root "${BROKER_PUBLIC_KEY}"
}

# ---------------------------------------------------------------------------
# Environment files
#
# Generated secrets are written from `.generated-secrets`, which is itself never
# regenerated: the pepper that keys every stored password hash is the same value
# on every run. The *configuration* keys are the opposite — a re-run with a
# different --domain must change them, or the panel and Caddy keep serving the
# previous origin while the operator reads a receipt that names the new one.
#
# Every file is assembled whole and installed with a single rename. The previous
# key-at-a-time rewrite ended in `cat tmp > live`, which is a truncate followed by
# a write: an interruption in between left an empty web.env, and the next run
# would not put the pepper back because it only wrote the base lines when the file
# was entirely absent.
# ---------------------------------------------------------------------------
env_value() {
  local file=$1 key=$2
  [[ -f ${file} ]] || return 0
  sed -n "s/^${key}=//p" "${file}" | tail -1
}

# merge_env_file <file> <owner> <mode> <KEY=VALUE>...
#
# Keeps every line the installer does not manage — an operator's GitHub App
# client secret lives in these files — replaces the managed keys, and refuses to
# install a result that is missing one of them.
merge_env_file() {
  local file=$1 owner=$2 mode=$3; shift 3
  local managed=("$@") kv key line drop t
  t=$(mktemp "${file}.XXXXXX") || die "cannot stage ${file}"

  if [[ -f ${file} ]]; then
    while IFS= read -r line || [[ -n ${line} ]]; do
      drop=0
      for kv in "${managed[@]}"; do
        key=${kv%%=*}
        [[ ${line} == "${key}="* ]] && drop=1
      done
      [[ ${drop} -eq 1 ]] || printf '%s\n' "${line}"
    done < "${file}" > "${t}"
  else
    printf '%s\n' '# Managed by install.sh' > "${t}"
  fi

  for kv in "${managed[@]}"; do
    key=${kv%%=*}
    [[ ${kv} == *$'\n'* ]] && die "refusing to write a multi-line value for ${key}"
    printf '%s\n' "${kv}" >> "${t}"
  done

  # The assembled file is checked before it replaces anything: each managed key
  # exactly once, and no managed key silently empty.
  local count
  for kv in "${managed[@]}"; do
    key=${kv%%=*}
    count=$(grep -c "^${key}=" "${t}" || true)
    [[ ${count} -eq 1 ]] || { rm -f "${t}"; die "staged $(basename "${file}") has ${count} definitions of ${key}"; }
    if [[ ${kv} == "${key}=" ]]; then continue; fi
    [[ -n $(sed -n "s/^${key}=//p" "${t}" | tail -1) ]] || { rm -f "${t}"; die "staged $(basename "${file}") lost the value of ${key}"; }
  done

  chmod "${mode}" "${t}"
  [[ -z ${owner} ]] || set_owner "${owner}" "${t}"
  if [[ -f ${file} ]] && cmp -s "${t}" "${file}"; then rm -f "${t}"; return 0; fi
  [[ -f ${file} ]] && info "updating $(basename "${file}")"
  mv -f "${t}" "${file}"
  return 0
}

setup_env_files() {
  block_begin 7 || return 0
  local pepper okey
  pepper=$(generated_secret PEPPER); okey=$(generated_secret OAUTH_KEY)
  [[ -n ${pepper} && -n ${okey} ]] || die "generated secrets are missing from ${ETC_ROOT}/.generated-secrets"

  merge_env_file "${ETC_ROOT}/database.env" root:root 0640 \
    "PGHOST=${PG_SOCKET}" \
    "PGDATABASE=${PG_DATABASE}"

  # Placeholders the operator fills in later are written once, at creation, and
  # never managed again — re-running must not wipe a configured GitHub App.
  if [[ ! -f ${ETC_ROOT}/web.env ]]; then
    printf '%s\n' '# Managed by install.sh' 'GITHUB_APP_SLUG=' 'GITHUB_APP_CLIENT_ID=' \
      | atomic_install_file "${ETC_ROOT}/web.env" 0640 ''
  fi
  merge_env_file "${ETC_ROOT}/web.env" root:infra-web 0640 \
    "INFRA_COD_SITE_URL=https://${DOMAIN}" \
    "INFRA_COD_AUTH_PEPPER=${pepper}" \
    "GITHUB_OAUTH_CODE_ENCRYPTION_KEY=${okey}" \
    "OPENCODE_BROKER_PUBLIC_KEY_PATH=${BROKER_PUBLIC_KEY}"

  if [[ ! -f ${ETC_ROOT}/github-app.env ]]; then
    printf '%s\n' '# Managed by install.sh' 'GITHUB_APP_ID=' 'GITHUB_APP_SLUG=' \
      'GITHUB_APP_CLIENT_ID=' 'GITHUB_APP_CLIENT_SECRET=' \
      | atomic_install_file "${ETC_ROOT}/github-app.env" 0640 ''
  fi
  merge_env_file "${ETC_ROOT}/github-app.env" root:infra-cod-github 0640 \
    "GITHUB_OAUTH_CODE_ENCRYPTION_KEY=${okey}" \
    "GITHUB_APP_PRIVATE_KEY_PATH=${GITHUB_APP_DIR}/private-key.pem"

  merge_env_file "${ETC_ROOT}/caddy.env" root:caddy 0640 \
    "INFRA_COD_DOMAIN=${DOMAIN}" \
    "INFRA_COD_ACME_EMAIL=${ACME_EMAIL}"

  block_end 7
}

# --------------------------------------------------------------------------- Block 8: PostgreSQL
# Runs one statement against one database and preserves psql's exit status, so a
# caller can tell "the answer is zero" from "there was no answer".
psql_query() {
  "${PG_BIN}/psql" -h "${PG_SOCKET}" -p "${PG_PORT}" -U infra_migrator -d "$1" -X -qAt -c "$2" 2>/dev/null
}

psql_scalar() {
  "${PG_BIN}/psql" -h "${PG_SOCKET}" -p "${PG_PORT}" -U infra_migrator -d "${PG_DATABASE}" \
    -X -qAt -c "$1" 2>/dev/null || echo ""
}
migration_count() {
  local c; c=$(psql_scalar "SELECT count(*) FROM control_plane.schema_migrations")
  [[ ${c} =~ ^[0-9]+$ ]] || c=0
  echo "${c}"
}
owner_count() {
  local c; c=$(psql_scalar "SELECT count(*) FROM control_plane.users WHERE role='owner'")
  [[ ${c} =~ ^[0-9]+$ ]] || c=0
  echo "${c}"
}

setup_postgresql() {
  block_begin 8 || return 0
  [[ -n ${RELEASE_DIR} ]] || die "RELEASE_DIR not set"
  if ! command -v pg_lsclusters >/dev/null 2>&1; then
    # PGDG first, then the packages: postgresql-17 and postgresql-client-17 do
    # not exist in Ubuntu 24.04's own archive, so installing them before the
    # repository is configured fails on a clean host.
    local h="/usr/share/postgresql-common/pgdg/apt.postgresql.org.sh"
    if [[ ! -x ${h} ]]; then
      apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y postgresql-common ca-certificates curl
    fi
    if [[ ! -f /etc/apt/sources.list.d/pgdg.sources && ! -f /etc/apt/sources.list.d/pgdg.list ]]; then
      [[ -x ${h} ]] || die "PGDG bootstrap script missing at ${h}"
      "${h}" -y
    fi
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends postgresql-client-17 postgresql-17
  fi
  "${RELEASE_DIR}/deploy/setup-postgresql-production.sh" 2>&1 | sed 's/^/  pg-setup: /'
  if [[ -x ${RELEASE_DIR}/deploy/setup-postgresql-17-restore.sh ]]; then
    "${RELEASE_DIR}/deploy/setup-postgresql-17-restore.sh" 2>&1 | sed 's/^/  restore-setup: /'
  fi
  INFRA_COD_NODE_BIN="${NODE_BIN}" "${RELEASE_DIR}/deploy/run-production-migrations.sh" "${RELEASE_DIR}" 2>&1 | sed 's/^/  migrate: /'
  local c; c=$(migration_count)
  local manifest="${RELEASE_DIR}/manifest.json" expected_count
  expected_count=$(sed -n 's/.*"migrationCount"[[:space:]]*:[[:space:]]*\([0-9]*\).*/\1/p' "${manifest}" | head -1)
  if [[ -n ${expected_count} ]]; then
    [[ ${c} -eq ${expected_count} ]] || die "expected ${expected_count} migrations (per manifest), got ${c}"
    info "${c} migrations (matches manifest)"
  else
    [[ ${c} -ge 46 ]] || die "expected 46+ migrations, got ${c}"
    info "${c} migrations"
  fi
  block_end 8
}

# --------------------------------------------------------------------------- Block 9: systemd, tmpfiles, Caddy
setup_systemd_tmpfiles_caddy() {
  block_begin 9 || return 0
  [[ -n ${RELEASE_DIR} ]] || die "RELEASE_DIR not set"
  local sys="${RELEASE_DIR}/deploy/systemd" tmf="${RELEASE_DIR}/deploy/tmpfiles.d" cdy="${RELEASE_DIR}/deploy/caddy"
  inst -d -m 0755 "${SYSTEMD_DIR}" "${TMPFILES_DIR}" "${CADDY_DIR}"

  [[ -f ${cdy}/Caddyfile ]] || die "Caddyfile missing from the release at ${cdy}/Caddyfile"
  [[ -d ${tmf} ]] || die "tmpfiles rules missing from the release at ${tmf}"

  # Units, tmpfiles rules, the Caddyfile and the OpenCode tool definitions are
  # installed from the release's install declaration by the release's own code —
  # the same reconciliation `infra-cod update` runs (WP-A), so the fresh path and
  # the upgrade path cannot drift. It runs systemd-tmpfiles before it writes
  # into a runtime's home, installs root-owned 0644 by rename, and retires what
  # an earlier run of this product installed and this release no longer ships.
  reconcile_install reconcile || die "installing the release's declared files failed"
  grep -q 'root": "runtime-tools"' "${ETC_ROOT}/install-ledger.json" \
    || die "the release installed no runtime tool definitions; the executor would have nothing to call"

  local u installed=()
  for u in "${sys}"/*.service "${sys}"/*.timer "${sys}"/*.target; do
    [[ -f ${u} ]] && installed+=("$(basename "${u}")")
  done
  [[ ${#installed[@]} -gt 0 ]] || die "no systemd units found in ${sys}"

  systemctl daemon-reload

  # Every unit that was installed, not a hand-kept subset: a unit that is shipped
  # but never verified is exactly the one that fails at boot.
  info "verifying ${#installed[@]} systemd units"
  for u in "${installed[@]}"; do
    systemd-analyze verify "${SYSTEMD_DIR}/${u}" 2>&1 | sed "s/^/  analyze: /"
  done
  install_cli_shim

  # `--envfile` is not optional here. The Caddyfile is written in terms of
  # {$INFRA_COD_DOMAIN} and {$INFRA_COD_ACME_EMAIL}, which `infra-cod-caddy.service`
  # supplies through EnvironmentFile. Validating without them made the adapter read
  # `email` with no argument and fail every clean install:
  #   parsing caddyfile tokens for 'email': wrong argument count
  # Passing the same file systemd loads also means this validates the configuration
  # that will actually run, not an approximation of it.
  [[ -f ${ETC_ROOT}/caddy.env ]] || die "caddy.env is missing; block 7 must run before block 9"
  "${CADDY_BIN}" fmt --diff "${CADDY_DIR}/Caddyfile" 2>&1 | sed 's/^/  caddy-fmt: /'
  "${CADDY_BIN}" validate --envfile "${ETC_ROOT}/caddy.env" --config "${CADDY_DIR}/Caddyfile" 2>&1 \
    | sed 's/^/  caddy-validate: /'
  block_end 9
}

# The command an operator is told to run. Without it `infra-cod doctor` is a
# 90-character path to a .mjs file, which is why CI was able to pass while the
# documented command did not exist at all.
cli_shim_content() {
  cat <<SHIM
#!/bin/sh
# Managed by install.sh — do not edit.
# Runs the CLI from whichever release /opt/infra-cod/current points at, with the
# pinned Node, so a rollback changes what this command runs without touching it.
exec ${NODE_BIN} ${CURRENT_LINK}/services/cli/infra-cod.mjs "\$@"
SHIM
}

install_cli_shim() {
  if cli_shim_current; then return 0; fi
  [[ -e ${CLI_SHIM} ]] && warn "${CLI_SHIM} is not the shim this release installs; replacing it"
  inst -d -m 0755 "$(dirname "${CLI_SHIM}")"
  cli_shim_content | atomic_install_file "${CLI_SHIM}" 0755 root:root
  info "installed ${CLI_SHIM}"
}

# Is the installed command the one this release would write? Executability is not
# the question: a shim left by an older release points at a Node or a release
# path that may no longer exist, and `infra-cod doctor` then fails in a way that
# looks like the installation rather than the command.
cli_shim_current() {
  [[ -f ${CLI_SHIM} && -x ${CLI_SHIM} ]] || return 1
  cli_shim_content | cmp -s - "${CLI_SHIM}"
}

# --------------------------------------------------------------------------- Block 10: operator bootstrap
bootstrap_operator() {
  block_begin 10 || return 0
  [[ -n ${RELEASE_DIR} ]] || die "RELEASE_DIR not set"
  local cli="${RELEASE_DIR}/services/cli/infra-cod.mjs"; [[ -f ${cli} ]] || die "CLI not found"
  if [[ $(owner_count) -gt 0 ]]; then info "owner exists, skipping"; block_end 10; return 0; fi
  # The pepper is not optional here, and leaving it out is not a silent
  # degradation: `hashPassword` refuses without it, so the first real Ubuntu run
  # ended at "the command failed" with nothing to go on. It must also be the same
  # value the panel runs with, or the owner account this creates could never be
  # verified by a sign-in.
  local pepper; pepper=$(generated_secret PEPPER)
  [[ -n ${pepper} ]] || die "cannot bootstrap the operator: no PEPPER in ${ETC_ROOT}/.generated-secrets"
  [[ ${pepper} == "$(env_value "${ETC_ROOT}/web.env" INFRA_COD_AUTH_PEPPER)" ]] \
    || die "the pepper in web.env differs from ${ETC_ROOT}/.generated-secrets; the panel could not verify this account"

  info "bootstrapping operator..."
  INFRA_COD_CREDENTIALS_DIR="${ETC_ROOT}" INFRA_COD_ACTOR=installer \
  INFRA_COD_AUTH_PEPPER="${pepper}" \
  PGHOST="${PG_SOCKET}" PGPORT="${PG_PORT}" PGUSER=infra_migrator PGDATABASE="${PG_DATABASE}" \
  PATH="${NODE_ROOT}/bin:${PATH}" \
  "${NODE_BIN}" "${cli}" admin bootstrap 2>&1 | sed 's/^/  bootstrap: /'
  [[ -f ${CREDENTIALS_FILE} ]] || die "bootstrap did not create ${CREDENTIALS_FILE}"
  info "credentials: ${CREDENTIALS_FILE}"
  block_end 10
}

# --------------------------------------------------------------------------- Block 11: atomic switch and start
switch_current_and_start() {
  block_begin 11 || return 0
  # `mv -T` replaces the symlink itself atomically. Without it (a non-GNU mv) a
  # `mv` onto an existing symlink-to-directory would move the new link *inside*
  # the old target, so the fallback removes the link first and accepts that the
  # swap is no longer atomic.
  ln -sfn "${RELEASE_DIR}" "${CURRENT_TMP}"
  mv -T "${CURRENT_TMP}" "${CURRENT_LINK}" 2>/dev/null \
    || { rm -f "${CURRENT_LINK}"; mv "${CURRENT_TMP}" "${CURRENT_LINK}"; }
  info "current -> ${RELEASE_DIR}"
  systemctl enable infra-cod.target 2>&1 | sed 's/^/  enable: /'
  systemctl start infra-cod.target 2>&1 | sed 's/^/  start: /'
  local attempt=0
  while [[ ${attempt} -lt 30 ]]; do
    # A GET, not `curl -sI`. HEAD is not what a browser sends, so a panel that
    # answers a GET correctly and a HEAD badly would be called dead — which is
    # exactly what happened: the page 500'd on HEAD and the probe timed out
    # against a perfectly healthy server.
    curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3100/login 2>/dev/null | grep -qE '^[23]' && break
    attempt=$((attempt+1)); sleep 2
  done
  if [[ ${attempt} -ge 30 ]]; then
    warn "the panel did not answer on 127.0.0.1:3100; its log follows"
    systemctl status --no-pager --full infra-cod-web.service 2>&1 | sed 's/^/  web: /' || true
    journalctl --no-pager -n 80 -u infra-cod-web.service 2>&1 | sed 's/^/  web: /' || true
    die "web not responding on 3100"
  fi
  info "web OK"
  local resolved; resolved=$(host "${DOMAIN}" 2>/dev/null | awk '/has address/{print $NF;exit}' || true)
  if [[ -n ${resolved} ]]; then
    local ca=0
    while [[ ${ca} -lt 10 ]]; do
      curl -sko /dev/null -w '%{http_code}' "https://${DOMAIN}/login" 2>/dev/null | grep -qE '^[23]' && break
      ca=$((ca+1)); sleep 2
    done
    [[ ${ca} -lt 10 ]] || die "HTTPS not responding on ${DOMAIN}"
    info "HTTPS OK"
  fi
  # Everything the target pulls in has to be up before anything is asked about
  # it. The health snapshot reports on the whole stack, so running it while half
  # of it is still starting produces a failure that describes the timing rather
  # than the installation.
  wait_for_services

  # These three are Type=oneshot: `start` returns when the job has run, and a
  # non-zero exit is the failure. `is-active` is not asked, here or in doctor —
  # a completed oneshot is `inactive` and that is the success case.
  #
  # Backup first, then the restore drill that reads what it wrote, then health,
  # which reports on both. The order is the dependency.
  start_oneshot infra-cod-backup.service
  start_oneshot infra-cod-restore-drill.service
  start_oneshot infra-cod-health.service

  # The tree this run replaced, removed only now: `current` has been flipped onto
  # the new release and the panel has answered on it, so the old copy is no
  # longer anybody's fallback.
  if [[ -n ${SUPERSEDED_DIR} && -d ${SUPERSEDED_DIR} && ${SUPERSEDED_DIR} != "${RELEASE_DIR}" ]]; then
    info "removing the superseded release at ${SUPERSEDED_DIR}"
    rm -rf "${SUPERSEDED_DIR}"
  fi
  block_end 11
}

# The long-running services, read from the target that starts them.
#
# The list lives in one place — `infra-cod.target` — and
# `services/operations/unit-contract.mjs` is checked against it by a test, so the
# installer, `doctor`, the health snapshot and CI cannot drift apart the way five
# hand-kept lists did.
target_services() {
  grep '^Wants=infra-cod-.*\.service$' "${SYSTEMD_DIR}/infra-cod.target" 2>/dev/null | sed 's/^Wants=//'
}

wait_for_services() {
  local units=() line unit waited
  while IFS= read -r line; do [[ -n ${line} ]] && units+=("${line}"); done < <(target_services)
  [[ ${#units[@]} -gt 0 ]] || die "infra-cod.target names no services"

  info "waiting for ${#units[@]} services"
  for unit in "${units[@]}"; do
    waited=0
    while ! systemctl is-active --quiet "${unit}" 2>/dev/null; do
      waited=$((waited + 1))
      if [[ ${waited} -ge 60 ]]; then
        warn "${unit} did not become active; its log follows"
        systemctl status --no-pager --full "${unit}" 2>&1 | sed "s/^/  ${unit}: /" || true
        journalctl --no-pager -n 60 -u "${unit}" 2>&1 | sed "s/^/  ${unit}: /" || true
        die "${unit} is not active"
      fi
      sleep 1
    done
  done
  info "all services active"
}

materialise_runtime_state() {
  # Refuse before creating anything: a symlink already in place is a deliberate
  # act by the only account that could have put it there.
  assert_runtime_paths_safe

  # The one creator. It recreates everything the units mount — the agents' state
  # directories, the workspace roots, the key directories — which a resume that
  # skipped block 9 would otherwise leave missing, and it does so with the
  # symlink protections a shell cannot express.
  if ls "${TMPFILES_DIR}"/*.conf >/dev/null 2>&1; then
    systemd-tmpfiles --create 2>&1 | sed 's/^/  tmpfiles: /'
  else
    die "no tmpfiles configuration is installed, so the runtime state directories cannot be created"
  fi

  # And refuse again: tmpfiles declines an unsafe transition rather than
  # completing one, so a path that is still not a plain directory is a path
  # nothing may proceed on.
  assert_runtime_paths_safe
  runtime_homes_present || die "the runtime state directories are missing and could not be created"
}

# Runs a oneshot unit and, if it fails, says why.
#
# `systemctl start` reports "Job for X failed ... see systemctl status" and
# nothing else, which on a headless VPS is a dead end: the installer has already
# exited by the time anybody reads it. The unit's own log is what the operator
# needs, so it is printed here, at the moment of failure.
start_oneshot() {
  local unit=$1
  # A timer may have fired this unit already, before the stack was up. Clearing
  # that result means what follows is this run's answer and not an older one.
  systemctl reset-failed "${unit}" >/dev/null 2>&1 || true
  if systemctl start "${unit}" 2>&1 | sed "s/^/  ${unit}: /"; then
    return 0
  fi
  warn "${unit} failed; its log follows"
  systemctl status --no-pager --full "${unit}" 2>&1 | sed "s/^/  ${unit}: /" || true
  journalctl --no-pager -n 60 -u "${unit}" 2>&1 | sed "s/^/  ${unit}: /" || true
  die "${unit} failed"
}

run_doctor() {
  local cli="${RELEASE_DIR}/services/cli/infra-cod.mjs"
  [[ -f ${cli} ]] || return 0
  info "=== doctor ==="
  local out rc=0
  out=$(INFRA_COD_INSTALL_PREFIX="${PREFIX}" "${NODE_BIN}" "${cli}" doctor --json 2>&1) || rc=$?
  echo "${out}" | sed 's/^/  doctor: /'
  local critical; critical=$(echo "${out}" | jq -r '.critical // 99' 2>/dev/null || echo "99")
  [[ ${critical} =~ ^[0-9]+$ ]] || critical=99
  if [[ ${critical} -gt 0 ]]; then
    die "doctor reports ${critical} critical issue(s) — the installation is not usable as it stands"
  fi
  [[ ${rc} -eq 0 ]] || warn "doctor reports warnings — review them before handing the panel over"
}

main() {
  parse_args "$@"
  if [[ ${MODE_JSON} -eq 1 ]]; then exec 3>&1 1>&2; RECEIPT_FD=3; fi

  [[ ${MODE_CHECK} -eq 1 ]] && { preflight_checks; info "preflight OK"; exit 0; }
  if [[ ${MODE_DRY_RUN} -eq 1 ]]; then
    info "=== DRY RUN ==="; preflight_checks
    info "Plan: verify -> Node+Caddy -> users/groups -> dirs/keys -> env -> PG -> systemd -> bootstrap -> start"
    info "=== DRY RUN (no changes) ==="; exit 0
  fi

  ARTIFACT_DIGEST=$(sha256_of "${ARTIFACT}")
  CONFIG_DIGEST=$(printf '%s\n%s\n' "${DOMAIN}" "${ACME_EMAIL}" | sha256sum | awk '{print $1}')

  # A host that is going to be refused is refused before apt touches it.
  preflight_immutable
  acquire_lock
  install_prerequisites
  preflight_tools
  read_state
  install_artifact
  setup_users_groups
  setup_directories_keys
  setup_env_files
  setup_postgresql
  setup_systemd_tmpfiles_caddy
  bootstrap_operator
  # Not a block, and deliberately outside the resume logic: every unit that
  # mounts one of these refuses to start without it, and a run that skipped both
  # the block that creates them and the block that installs the tmpfiles rules
  # would report success while the supervisor could not start. Cheap, idempotent,
  # and it runs on every invocation.
  materialise_runtime_state
  switch_current_and_start

  if [[ -f ${CREDENTIALS_FILE} ]]; then
    info "URL: https://${DOMAIN}"
    info "Credentials: ${CREDENTIALS_FILE} (root:root 0600)"
  fi
  run_doctor

  if [[ ${MODE_JSON} -eq 1 ]]; then
    jq -n \
      --arg program "${PROGRAM}" \
      --arg version "${RELEASE_VERSION}" \
      --arg domain "${DOMAIN}" \
      --arg credentials "${CREDENTIALS_FILE}" \
      --arg release_dir "${RELEASE_DIR}" \
      --arg current_link "${CURRENT_LINK}" \
      '{ok: true, program: $program, version: $version, domain: $domain,
        credentials_file: $credentials, release_dir: $release_dir, current_link: $current_link}' >&${RECEIPT_FD}
  fi
  info "=== Installation complete ==="
}

main "$@"
