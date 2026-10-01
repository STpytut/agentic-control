# OpenCode account PoC — receipt template

Status: **superseded by completed `RESULTS.md`**. Keep this template for a
future OpenCode version requalification.

## Test metadata

- Date:
- Host: Ubuntu 24.04 LTS VPS, Linux `x86_64`
- Runtime user: `opencode-worker`
- CLI version:
- Provider/plan: Free (builtin) / Go (api_key enrollment)

## 1. Exact commands / API surface

- `opencode auth --help` → (paste redacted)
- `opencode auth login --help` → (paste redacted)
- `opencode models --help` → (paste redacted)

## 2. Key passing without argv/env

- Accepted login method for API key: `stdin` / `file` / other?
- Exact authenticated localhost API confirmed:
- Confirm the key never appears in `ps eww -p <pid>` or `journalctl` during the
  enrollment run: pass/fail.

## 3. Native credential store

- Path: `~/.local/share/opencode/auth.json`
- Present before login? Layout of the store directory (names/modes, not contents):
- Mode/owner of `auth.json`:

## 4. List / catalog response

- `opencode models` output (redacted): paste.
- Plan vs model id: is Free/Go expressed as a plan badge separate from the model
  id (`opencode/north-mini-code-free`)? Confirm naming rule.
- Does `models list` require an authenticated provider, or list all providers?

## 5. Verify and logout

- Verify command and expected exit:
- Logout command and expected exit (help confirmed; actual logout not executed
  in discovery):
- Behavior when the provider key is revoked (fail closed evidence):

## 6. No-secret evidence

- `journalctl` slice for the auth process: no key/email values (attach redacted
  excerpt).
- `ps eww -p <pid>` during auth: no key in argv/env.
- Transcript contains no `[REDACTED]`-bypassed raw secret: pass/fail.

## Manual Go enrollment (optional, VPS-only)

- `enroll-go.sh` run: success/failure code and safe status (no key in chat):
- Connection reached `connected` in `provider_connections`?

## Architecture impact

- Confirms / changes / blocks the `opencode-account-worker` + Supervisor account
  channel design (Sprint 7.1C.3). Notes:
