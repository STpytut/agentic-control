#!/usr/bin/env bash
# One release candidate, from the merged main to the host — the runbook's
# sections 1–7 in order, stopping only for the signature.
#
#   scripts/release.sh <version> --host <ssh host> [--key <minisign secret key>]
#   scripts/release.sh 0.4.0-rc.130 --host infra-vps --key ~/.secure/infra-cod-release.key
#
# What it does, and refuses:
#   1. the checkout is clean and HEAD is origin/main (fetched now);
#   2. the container gate on HEAD — skipped when this exact tree already passed
#      it (a merge commit whose tree is the gated branch's is the same code);
#   3. the annotated tag, local only (the tag policy: pushed only for milestones);
#   4. the build in the pinned container from a clean clone of the tag, and the
#      tool definitions and trusted keys checked inside the tarball;
#   5. the signature: it prints the minisign command and waits for the .minisig.
#      It never runs minisign itself and never reads the key — the owner does;
#   6. the signature verified against release/keys, the upload, sha256sum -c on
#      the host, free disk space checked;
#   7. `infra-cod update` on the host, which backs up, rehearses the restore,
#      migrates, switches, runs the panel's self-test and rolls back on failure.
#
# It stops at the first failure and says which step. Nothing here is pushed.
set -euo pipefail

version="${1:-}"
shift || true
host="${RELEASE_HOST:-}"
key="${RELEASE_SIGNING_KEY:-}"
while [ $# -gt 0 ]; do
  case "$1" in
    --host) host="$2"; shift 2 ;;
    --key) key="$2"; shift 2 ;;
    *) echo "unknown option $1" >&2; exit 2 ;;
  esac
done
[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+-rc\.[0-9]+$ ]] || { echo "usage: $0 <x.y.z-rc.N> --host <ssh host> [--key <path>]" >&2; exit 2; }
[ -n "$host" ] || { echo "name the host: --host <ssh host> (or RELEASE_HOST)" >&2; exit 2; }

root="$(git rev-parse --show-toplevel)"
cd "$root"
tag="v$version"
release="dist/releases/$version-linux-x64"
tarball="infra-cod-$version-linux-x64.tar.gz"
step() { printf '\n== %s\n' "$*"; }
fail() { printf 'release: %s\n' "$*" >&2; exit 1; }

step "1/7 the checkout"
[ -z "$(git status --porcelain)" ] || fail "the working tree is not clean"
git fetch -q origin
[ "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)" ] || fail "HEAD is not origin/main; check out the merged main first"
git rev-parse -q --verify "refs/tags/$tag" >/dev/null && fail "$tag already exists"
tree="$(git rev-parse 'HEAD^{tree}')"

step "2/7 the gate"
gates="$(git rev-parse --path-format=absolute --git-common-dir)/infra-cod-gates"
mkdir -p "$gates"
if [ -f "$gates/$tree" ]; then
  echo "this tree passed the gate on $(cat "$gates/$tree"); not run again"
else
  log="$(mktemp -t infra-cod-gate.XXXXXX)"
  if scripts/run-suites-in-container.sh >"$log" 2>&1; then
    date -u +%Y-%m-%dT%H:%M:%SZ > "$gates/$tree"
    grep -E '^ℹ (tests|fail)' "$log" | paste - - || true
  else
    tail -40 "$log" >&2
    fail "the gate failed; the whole log is $log"
  fi
fi

step "3/7 the tag"
git tag -a "$tag" -m "release candidate $version"
git describe --tags --exact-match

step "4/7 the build"
work="$(mktemp -d -t infra-cod-build.XXXXXX)"
mkdir -p "$work/out"
git clone --local --quiet . "$work/src"
git -C "$work/src" checkout --quiet "$tag"
docker run --rm --platform linux/amd64 -v "$work/src:/src" -v "$work/out:/out" -w /src node:24.20.0-bookworm bash -lc '
  corepack enable && corepack prepare pnpm@11.9.0 --activate
  pnpm install --frozen-lockfile
  npm run build
  npm run release:build -- --out /out; echo RELEASE_BUILD_EXIT=$?' > "$work/build.log" 2>&1 || true
grep -q '^RELEASE_BUILD_EXIT=0' "$work/build.log" || { tail -40 "$work/build.log" >&2; fail "the build failed; the log is $work/build.log"; }
grep -E '^built ' "$work/build.log"
grep -q '"dirty":false' "$work/build.log" || fail "the build reports a dirty tree"
mkdir -p dist/releases
rm -rf "$release"
cp -R "$work/out/$version-linux-x64" "$release"
inside="$(tar tzf "$release/$tarball" | grep -cE 'opencode-tools|release/keys' || true)"
[ "$inside" -ge 2 ] || fail "the tarball lacks the tool definitions or the trusted keys"

step "5/7 the signature (yours)"
echo "Sign it:"
echo
echo "  minisign -S -H -s ${key:-<your minisign secret key>} -m $root/$release/SHA256SUMS -t \"infra-cod release $version\""
echo
until [ -f "$release/SHA256SUMS.minisig" ]; do
  read -r -p "Press Enter once it is signed (Ctrl-C to stop here)… " _
done

step "6/7 the signature checked, and the upload"
minisign -Vm "$release/SHA256SUMS" -p release/keys/*.pub | tail -1 | grep -q "infra-cod release $version" \
  || fail "the signature does not verify, or its trusted comment is not \"infra-cod release $version\""
ssh "$host" 'df -h / | tail -1'
ssh "$host" "mkdir -p /root/releases/$version-linux-x64"
scp -q "$release/SHA256SUMS" "$release/SHA256SUMS.minisig" "$release/$tarball" "$host:/root/releases/$version-linux-x64/"
ssh "$host" "cd /root/releases/$version-linux-x64 && sha256sum -c SHA256SUMS"

step "7/7 the update"
# The update runs on the host as a unit of its own, not in this connection:
# rc.145's connection dropped right after the restart (the owner's VPN, as far
# as the host could tell), and the update, a child of the SSH session, died
# with it before its self-test. Here a dropped connection is asked again, and
# the update's output is followed by journal cursor from where it stopped.
unit="infra-cod-release-update-${version//[^0-9a-z]/-}"
ssh "$host" "systemctl reset-failed $unit 2>/dev/null; systemctl stop $unit 2>/dev/null; \
  systemd-run --unit=$unit --quiet --property=Type=exec --property=RemainAfterExit=yes \
    --setenv=HOME=/root --setenv=PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
    /usr/local/bin/infra-cod update \
      --artifact /root/releases/$version-linux-x64/$tarball \
      --checksums /root/releases/$version-linux-x64/SHA256SUMS \
      --signature /root/releases/$version-linux-x64/SHA256SUMS.minisig \
      --public-key /root/rehearsal/keys/infra-cod-release.pub" \
  || fail "the update could not be started on $host"
cursor=""
deadline=$((SECONDS + 45 * 60))
gone=0
while :; do
  [ "$SECONDS" -lt "$deadline" ] || fail "the update on $host has not finished in 45 minutes; follow it: journalctl -u $unit -f"
  if ! out=$(ssh -o ServerAliveInterval=20 -o ConnectTimeout=20 "$host" \
      "journalctl -u $unit -o cat --no-pager --show-cursor ${cursor:+--after-cursor='$cursor'}; \
       echo \"__state__ \$(systemctl show -p ActiveState --value $unit) \$(systemctl show -p SubState --value $unit) \$(systemctl show -p ExecMainStatus --value $unit)\""); then
    echo "(the connection to $host dropped; the update goes on there — asking again)"
    sleep 10
    continue
  fi
  state=${out##*__state__ }
  body=${out%__state__*}
  next=$(printf '%s' "$body" | sed -n 's/^-- cursor: //p' | tail -1)
  [ -n "$next" ] && cursor=$next
  printf '%s' "$body" | grep -v '^-- cursor: ' | grep -v '^-- No entries --$' || true
  read -r active sub status <<<"$state"
  if [ "$active" = "active" ] && [ "$sub" = "exited" ]; then
    [ "$status" = "0" ] || fail "the update ended with status $status on $host"
    ssh "$host" "systemctl stop $unit" || true
    break
  fi
  if [ "$active" = "failed" ]; then
    ssh "$host" "systemctl reset-failed $unit" || true
    fail "the update failed on $host (status $status); its log: journalctl -u $unit"
  fi
  # A unit that is gone — stopped by hand, or the host rebooted — is not one
  # still starting: three answers in a row say so.
  if [ "$active" != "active" ] && [ "$active" != "activating" ]; then gone=$((gone + 1)); else gone=0; fi
  [ "$gone" -lt 3 ] || fail "the update unit on $host is ${active:-unknown}, not running and not finished; its log: journalctl -u $unit"
  sleep 5
done
echo
echo "$version is on $host. The tag $tag is local; push it only if this is a milestone."
