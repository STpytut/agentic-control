#!/bin/sh
# Install Agentic Control on a clean Ubuntu 24.04 server in one command:
#
#   curl -fsSL https://github.com/STpytut/agentic-control/releases/latest/download/get.sh \
#     | sudo sh -s -- --email you@example.com [--domain panel.example.com] [--version 0.4.0-rc.122]
#
# This script is the only thing that runs before a signature is checked, so it
# is kept short enough to read. It downloads a release, checks the minisign
# signature over SHA256SUMS with the public key written below, checks the
# tarball against SHA256SUMS, and only then runs the installer from inside the
# verified tarball. The installer checks the same signature again itself.
#
# Without --domain the installer uses <public-ip>.sslip.io, which needs no DNS
# record and still gets a real certificate. Other flags (--check, --dry-run,
# --json) go to the installer unchanged.
set -eu

REPOSITORY="STpytut/agentic-control"
# The release signing key; the same as release/keys/infra-cod-release.pub at
# this script's tag (a test keeps the two equal).
PUBLIC_KEY="RWTPpwcNQqh1RAGq9hEJkUM40VaGNrtBr1HvhF+8+TMtyapBi6xxy/pZ"

die() { printf 'get.sh: %s\n' "$*" >&2; exit 1; }
say() { printf 'get.sh: %s\n' "$*" >&2; }

version=""
email=""
domain=""
passthrough=""
while [ $# -gt 0 ]; do
  case "$1" in
    --version) [ $# -ge 2 ] || die "--version needs a value"; version=${2#v}; shift ;;
    --email|--acme-email) [ $# -ge 2 ] || die "$1 needs a value"; email=$2; shift ;;
    --domain) [ $# -ge 2 ] || die "--domain needs a value"; domain=$2; shift ;;
    --check|--dry-run|--json|--resume) passthrough="${passthrough} $1" ;;
    --help|-h) printf '%s\n' "usage: get.sh --email <address> [--domain <name>] [--version <x.y.z>] [--check|--dry-run|--json|--resume]"; exit 0 ;;
    *) die "unknown option: $1" ;;
  esac
  shift
done

[ "$(id -u)" -eq 0 ] || die "run it as root (sudo sh -s -- ...)"
[ "$(uname -s)" = Linux ] && [ "$(uname -m)" = x86_64 ] || die "Linux on x86-64 only"
[ -n "${email}" ] || die "--email is required: the contact address for the TLS certificate"

missing=""
for tool in curl minisign sha256sum tar; do
  command -v "${tool}" >/dev/null 2>&1 || missing="${missing} ${tool}"
done
if [ -n "${missing}" ]; then
  # A cloud server's first minutes belong to cloud-init and its apt runs; on the
  # first real install (a DigitalOcean droplet) apt-get failed on their lock.
  if command -v cloud-init >/dev/null 2>&1; then
    say "waiting for cloud-init to finish"
    cloud-init status --wait >/dev/null 2>&1 || true
  fi
  say "installing${missing}"
  apt-get -o DPkg::Lock::Timeout=300 update -qq
  # needrestart would otherwise print its report into the install's output.
  NEEDRESTART_SUSPEND=1 DEBIAN_FRONTEND=noninteractive \
    apt-get -o DPkg::Lock::Timeout=300 install -y -qq ca-certificates curl minisign coreutils tar >/dev/null
fi

if [ -n "${version}" ]; then
  base="https://github.com/${REPOSITORY}/releases/download/v${version}"
else
  base="https://github.com/${REPOSITORY}/releases/latest/download"
fi

work=$(mktemp -d /tmp/agentic-control-get.XXXXXX)
trap 'rm -rf "${work}"' EXIT
cd "${work}"

say "downloading the release from ${base}"
curl -fsSL -o SHA256SUMS "${base}/SHA256SUMS"
curl -fsSL -o SHA256SUMS.minisig "${base}/SHA256SUMS.minisig"
printf 'untrusted comment: minisign public key\n%s\n' "${PUBLIC_KEY}" > release.pub
minisign -Vm SHA256SUMS -p release.pub >/dev/null || die "the signature over SHA256SUMS does not verify"

tarball=$(awk '$2 ~ /^\*?infra-cod-.*-linux-x64\.tar\.gz$/ { sub(/^\*/, "", $2); print $2; exit }' SHA256SUMS)
[ -n "${tarball}" ] || die "SHA256SUMS names no linux-x64 tarball"
case "${tarball}" in */*|..*) die "unexpected file name in SHA256SUMS: ${tarball}" ;; esac
curl -fsSL -o "${tarball}" "${base}/${tarball}"
grep " \*\{0,1\}${tarball}\$" SHA256SUMS | sha256sum -c - >/dev/null || die "${tarball} does not match SHA256SUMS"
say "verified ${tarball}"

tar -xzf "${tarball}"
installer=$(find . -maxdepth 3 -path '*/deploy/install.sh' | head -1)
[ -n "${installer}" ] || die "the release has no deploy/install.sh"

set -- --artifact "${work}/${tarball}" --checksums "${work}/SHA256SUMS" \
  --signature "${work}/SHA256SUMS.minisig" --public-key "${work}/release.pub" --acme-email "${email}"
[ -n "${domain}" ] && set -- "$@" --domain "${domain}"
# shellcheck disable=SC2086
bash "${installer}" "$@" ${passthrough}
