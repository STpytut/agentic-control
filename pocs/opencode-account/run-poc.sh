#!/usr/bin/env bash
# OpenCode account PoC — read-only discovery. Run as root on the VPS.
# Produces a redacted transcript under ./out/opencode-poc-<stamp>.txt
# This script never enters or prints secrets.
set -u

HERE="$(cd "$(dirname "$0")" && pwd)"
OUT_DIR="$HERE/out"
mkdir -p "$OUT_DIR"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT="$OUT_DIR/opencode-poc-$STAMP.txt"

redact() {
  sed -E \
    -e 's/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/[REDACTED_EMAIL]/g' \
    -e 's/\b(sk|sess|key|rk)-[A-Za-z0-9_-]{8,}\b/[REDACTED_CRED]/g' \
    -e 's/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/[REDACTED_JWT]/g' \
    -e 's/(api[_-]?key|access[_-]?token|client[_-]?secret|token|password)([=: ]+)[A-Za-z0-9._\/+=-]{8,}/\1\2[REDACTED]/Ig'
}

log() { printf '\n### %s\n' "$1" | tee -a "$OUT"; }

probe() {
  local label="$*"
  log "$label"
  local out rc=0
  out="$("$@" 2>&1)" || rc=$?
  printf '%s\n' "$out" | redact | tee -a "$OUT"
  printf 'exit=%d\n' "$rc" | tee -a "$OUT"
}

# opencode-worker identity for credential-store checks.
OC=(runuser -u opencode-worker -- env --chdir=/home/opencode-worker HOME=/home/opencode-worker XDG_DATA_HOME=/home/opencode-worker/.local/share)

log "OpenCode account PoC (read-only discovery) — $STAMP"
log "Host"
probe hostname
probe id opencode-worker
probe stat /home/opencode-worker/.local/share/opencode
probe ls -la /home/opencode-worker/.local/share/opencode
if [ -e /home/opencode-worker/.local/share/opencode/auth.json ]; then
  log "auth.json present (mode/owner only; contents are never printed)"
  probe stat -c '%a %U:%G %n' /home/opencode-worker/.local/share/opencode/auth.json
else
  log "auth.json NOT present (expected before first login)"
fi

log "Version"
probe "${OC[@]}" opencode --version
probe "${OC[@]}" opencode --help
log "Auth surface"
probe "${OC[@]}" opencode auth --help
probe "${OC[@]}" opencode auth login --help
log "Catalog surface"
probe "${OC[@]}" opencode models --help
probe "${OC[@]}" opencode models
probe "${OC[@]}" opencode models opencode
log "Auth status (redacted)"
probe "${OC[@]}" opencode auth list
log "Logout surface (help only, no logout executed)"
probe "${OC[@]}" opencode auth logout --help

log "Process-argument check (no secret in argv/env of the discovery process)"
ps eww -p "$$" 2>/dev/null | redact | tee -a "$OUT"

printf '\n=== transcript: %s ===\n' "$OUT" | tee -a "$OUT"
printf 'REMINDER: only this redacted transcript may leave the VPS; the key is entered on the VPS only via enroll-go.sh\n' | tee -a "$OUT"
