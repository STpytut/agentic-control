# OpenCode account PoC — read-only discovery

Purpose: confirm the exact official OpenCode auth/catalog interface on the
installed VPS version (`opencode 1.18.3`, isolated user `opencode-worker`)
used by `opencode-account-worker.mjs` and the Supervisor account channel
(Sprint 7.1C.3). The VPS receipt was completed against OpenCode 1.18.3.

## Security rules (must hold)

- No API key, access token or device authorization is ever entered in chat or
  pasted into this repository.
- Go enrollment uses the Settings form: the browser encrypts the key and the
  VPS broker submits it to a localhost-only OpenCode server. The key is never
  placed in argv, environment, repository files or logs.
- `run-poc.sh` is read-only: it never cats `auth.json`, never prints token
  values, and redacts emails/JWTs/`sk-*`/`sess-*` from every captured line.
- The redacted transcript is the only artifact that may be copied back.

## How to run (VPS, as root)

```bash
cd /opt/infra-cod/app
node --version                                   # control-plane runtime note
# (script lives in the repo; copy run-poc.sh + enroll-go.sh to the VPS)
bash pocs/opencode-account/run-poc.sh
ls -la pocs/opencode-account/out/opencode-poc-*.txt
```

Then paste the **redacted** transcript (or commit it as
`pocs/opencode-account/RESULTS.md`) back into the repo.

## What the receipt must answer

1. Exact commands/API surface: `opencode auth --help`, `opencode models --help`,
   provider flags and accepted login methods.
2. Key-passing mechanism without argv/env: the CLI prompt does not consume a
   piped key; `PUT /auth/opencode-go` on an ephemeral authenticated localhost
   `opencode serve --pure` instance is the confirmed headless interface.
3. Native credential store location and permissions: `~/.local/share/opencode/`
   layout, `auth.json` existence and mode (never its contents).
4. List/catalog response shape: `opencode models` / `opencode models opencode`
   and the structured `GET /provider` response.
5. Verify and logout: the exact status/logout commands and their exit behavior.
6. No-secret evidence: `journalctl` slice and `ps eww -p <pid>` for the auth
   process contain no key; the transcript is clean.

`enroll-go.sh` is intentionally disabled because the installed CLI cannot
safely accept the key from a pipe. Use Settings after the broker is deployed.
