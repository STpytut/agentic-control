#!/bin/sh
# The pre-install verification gate.
#
# This script is the trust boundary an installer crosses before it writes anything
# into `/opt`. It runs the checks in the only order that is safe —
#
#   pinned public key -> signature over SHA256SUMS -> checksum of the tarball
#     -> safe member list -> extraction -> manifest identity
#
# and it deliberately does *not* do the deep verification. That is
# `scripts/verify-release.mjs`, which lives inside the artifact and is therefore
# only trustworthy after this gate has passed; the installer runs it on the
# extracted tree, with the pinned Node it just installed.
#
# Why shell and not Node: at this point the host may have no Node at all — Stage 10
# installs it. This script uses only `sha256sum`, a pinned `minisign` public key and
# a tar implementation, all of which are either in the base image or are an
# explicit Stage 10 preflight dependency. It never fetches anything, and it never
# trusts the artifact's own filename.
#
# Usage:
#   release/verify-release.sh --artifact <tarball> [--checksums <file>]
#        [--signature <file>] [--public-key <file>] [--require-signature]
#        [--extract <dir>] [--version <semver>]
#
# Environment:
#   MINISIGN_BIN   path to minisign (default: minisign)
#   TAR_BIN        path to tar (default: tar)
#   SHA256_BIN     path to sha256sum (default: sha256sum)

set -eu

PROGRAM=$(basename "$0")
MINISIGN_BIN=${MINISIGN_BIN:-minisign}
TAR_BIN=${TAR_BIN:-tar}
SHA256_BIN=${SHA256_BIN:-sha256sum}

ARTIFACT=
CHECKSUMS=
SIGNATURE=
PUBLIC_KEY=
REQUIRE_SIGNATURE=0
EXTRACT=
EXPECTED_VERSION=

die() {
    printf '%s: %s\n' "$PROGRAM" "$1" >&2
    exit 1
}

usage() {
    cat >&2 <<'EOF'
usage: verify-release.sh --artifact <tarball> [options]

  --artifact <file>       the tarball to verify (required)
  --checksums <file>      SHA256SUMS (default: beside the artifact)
  --signature <file>      SHA256SUMS.minisig (default: beside the checksums)
  --public-key <file>     pinned minisign public key (required to verify a signature)
  --require-signature     fail unless a signature is present and valid
  --extract <dir>         extract into <dir> only after every check has passed
  --version <semver>      require this version in the extracted manifest
EOF
    exit 2
}

while [ $# -gt 0 ]; do
    case "$1" in
        --artifact) [ $# -ge 2 ] || die "--artifact needs a value"; ARTIFACT=$2; shift 2 ;;
        --checksums) [ $# -ge 2 ] || die "--checksums needs a value"; CHECKSUMS=$2; shift 2 ;;
        --signature) [ $# -ge 2 ] || die "--signature needs a value"; SIGNATURE=$2; shift 2 ;;
        --public-key) [ $# -ge 2 ] || die "--public-key needs a value"; PUBLIC_KEY=$2; shift 2 ;;
        --require-signature) REQUIRE_SIGNATURE=1; shift ;;
        --extract) [ $# -ge 2 ] || die "--extract needs a value"; EXTRACT=$2; shift 2 ;;
        --version) [ $# -ge 2 ] || die "--version needs a value"; EXPECTED_VERSION=$2; shift 2 ;;
        --help|-h) usage ;;
        *) die "unknown argument: $1" ;;
    esac
done

[ -n "$ARTIFACT" ] || usage
[ -f "$ARTIFACT" ] || die "artifact does not exist: $ARTIFACT"

ARTIFACT_DIR=$(CDPATH= cd -- "$(dirname -- "$ARTIFACT")" && pwd)
ARTIFACT_NAME=$(basename -- "$ARTIFACT")
[ -n "$CHECKSUMS" ] || CHECKSUMS="$ARTIFACT_DIR/SHA256SUMS"
[ -n "$SIGNATURE" ] || SIGNATURE="$CHECKSUMS.minisig"

# ---------------------------------------------------------------------------
# 1. The signature, over the checksum file, against the pinned key.
# ---------------------------------------------------------------------------

if [ -f "$SIGNATURE" ]; then
    [ -n "$PUBLIC_KEY" ] || die "a signature exists at $SIGNATURE but --public-key was not given; a signature nobody has a key for verifies nothing"
    [ -f "$PUBLIC_KEY" ] || die "public key does not exist: $PUBLIC_KEY"
    command -v "$MINISIGN_BIN" >/dev/null 2>&1 || die "minisign is required to verify $SIGNATURE and was not found ($MINISIGN_BIN)"
    "$MINISIGN_BIN" -V -q -p "$PUBLIC_KEY" -m "$CHECKSUMS" \
        || die "the signature at $SIGNATURE does not verify against $PUBLIC_KEY"
    echo "signature verified over $(basename -- "$CHECKSUMS")"
elif [ "$REQUIRE_SIGNATURE" -eq 1 ]; then
    die "no signature at $SIGNATURE and --require-signature was given; an unsigned artifact is not a release"
else
    echo "no signature at $SIGNATURE; continuing unsigned (pass --require-signature to make this fatal)"
fi

# ---------------------------------------------------------------------------
# 2. The checksum of the artifact, against the checksum file.
#
# The entry is selected by *exact name match*. A directory holding several
# tarballs must not let "the only one" or "the newest one" decide which bytes were
# verified.
# ---------------------------------------------------------------------------

[ -f "$CHECKSUMS" ] || die "checksum file does not exist: $CHECKSUMS"
command -v "$SHA256_BIN" >/dev/null 2>&1 || die "sha256sum was not found ($SHA256_BIN)"

EXPECTED=$(awk -v name="$ARTIFACT_NAME" '$2 == name { print $1 }' "$CHECKSUMS")
[ -n "$EXPECTED" ] || die "$ARTIFACT_NAME is not listed in $CHECKSUMS; refusing to guess which entry describes this artifact"
[ "$(printf '%s' "$EXPECTED" | wc -l)" -eq 0 ] || die "$ARTIFACT_NAME is listed more than once in $CHECKSUMS"

ACTUAL=$(cd "$ARTIFACT_DIR" && "$SHA256_BIN" "$ARTIFACT_NAME" | awk '{print $1}')
[ "$ACTUAL" = "$EXPECTED" ] || die "the artifact does not match its checksum: SHA256SUMS says $EXPECTED, the file hashes to $ACTUAL"
echo "checksum verified: $ACTUAL"

# ---------------------------------------------------------------------------
# 3. The member list, before anything is written anywhere.
# ---------------------------------------------------------------------------

command -v "$TAR_BIN" >/dev/null 2>&1 || die "tar was not found ($TAR_BIN)"

MEMBER_LIST=$(mktemp) || die "could not create a temporary file"
cleanup() { rm -f "$MEMBER_LIST"; }
trap cleanup EXIT INT TERM

"$TAR_BIN" -tzf "$ARTIFACT" > "$MEMBER_LIST" 2>/dev/null || die "$ARTIFACT is not a readable gzip-compressed tar archive"

[ -s "$MEMBER_LIST" ] || die "the archive has no members"

# Exactly one top-level directory, and every member inside it.
TOP_LEVEL=$(awk -F/ 'NF > 0 && $1 != "" { print $1 }' "$MEMBER_LIST" | sort -u)
TOP_LEVEL_COUNT=$(printf '%s\n' "$TOP_LEVEL" | grep -c . || true)
[ "$TOP_LEVEL_COUNT" -eq 1 ] || die "the archive must contain exactly one top-level directory, found $TOP_LEVEL_COUNT: $(printf '%s' "$TOP_LEVEL" | tr '\n' ' ')"

case "$TOP_LEVEL" in
    /*|*..*) die "the archive's top-level directory is not a plain relative name: $TOP_LEVEL" ;;
esac

# An absolute member, a `..` component, or a member outside the top-level
# directory is a traversal attempt. Every member has already been read by tar and
# nothing has been written, so inspecting the list is enough.
#
# The comparisons are literal string comparisons in `awk` rather than a `grep`
# pattern: a version such as `0.1.0+build` or this project's own
# `0.0.0-dev+bcb77940` contains characters that are metacharacters in one regular
# expression dialect or another, and a prefix test that silently matches everything
# is a traversal check that silently passes everything.
if awk -v top="$TOP_LEVEL" '
    index($0, "/") == 1 { print "absolute"; exit 1 }
    {
        n = split($0, parts, "/")
        for (i = 1; i <= n; i++) if (parts[i] == ".." || parts[i] == ".") { print "dotdot"; exit 1 }
        if ($0 != top && index($0, top "/") != 1) { print "outside"; exit 1 }
    }
' "$MEMBER_LIST"; then
    :
else
    die "the archive contains a member that is absolute, contains a '.'/'..' component, or lies outside $TOP_LEVEL/"
fi

# Devices, FIFOs and sockets have no legitimate place in an application release.
# `tar -tv` prints the type as the first character of the mode column.
if "$TAR_BIN" -tvzf "$ARTIFACT" 2>/dev/null | grep -qE '^[bcps]'; then
    die "the archive contains a device, FIFO or socket member"
fi

echo "archive members are safe: $(grep -c . "$MEMBER_LIST") entries under $TOP_LEVEL/"

# ---------------------------------------------------------------------------
# 4. Extraction, and the manifest's own identity.
#
# The manifest is read from the extracted tree rather than from the archive so
# that the checksum of every file that was written is what the deep verifier
# checks — but the version it claims is checked here, before an installer could
# act on a directory name.
# ---------------------------------------------------------------------------

if [ -n "$EXTRACT" ]; then
    [ -e "$EXTRACT" ] && [ ! -d "$EXTRACT" ] && die "extraction target exists and is not a directory: $EXTRACT"
    mkdir -p "$EXTRACT" || die "could not create $EXTRACT"
    "$TAR_BIN" -xzf "$ARTIFACT" -C "$EXTRACT" || die "extraction into $EXTRACT failed"
    RELEASE_ROOT="$EXTRACT/$TOP_LEVEL"
    echo "extracted to $RELEASE_ROOT"

    MANIFEST="$RELEASE_ROOT/manifest.json"
    [ -f "$MANIFEST" ] || die "the archive contains no manifest.json at $TOP_LEVEL/manifest.json"

    if [ -n "$EXPECTED_VERSION" ]; then
        # `sed` rather than a JSON parser: this stage must run before Node exists.
        # The pattern is anchored on the exact key so it cannot match a nested one.
        FOUND_VERSION=$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$MANIFEST" | head -n 1)
        [ "$FOUND_VERSION" = "$EXPECTED_VERSION" ] \
            || die "the manifest says version $FOUND_VERSION but $EXPECTED_VERSION was requested"
        echo "manifest version matches: $FOUND_VERSION"
    fi
else
    echo "no --extract given; the artifact verified but was not unpacked"
fi

echo "pre-install verification passed: $ARTIFACT_NAME"
