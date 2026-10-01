# OpenCode account PoC receipt

Status: **passed with contract changes**. Tested on the production VPS against
OpenCode `1.18.3` as the isolated `opencode-worker` user.

- Native store: `/home/opencode-worker/.local/share/opencode/auth.json`, mode
  `0600`, owner `opencode-worker` (contents were never read or printed).
- The installed CLI exposes `auth list`, `auth login [url]`, and
  `auth logout [provider]`. It has no `auth status` command.
- `auth login --provider ...` opens an interactive prompt and does not consume
  an API key from stdin. The proposed `--api-key -` contract is invalid.
- Headless login passed in an isolated temporary HOME through an authenticated,
  localhost-only `opencode serve --pure`: `PUT /auth/opencode-go` with
  `{type: "api", key: ...}` returned success. No real credential was used.
- The Go provider id is `opencode-go`. Explicit
  `opencode auth logout opencode-go` is noninteractive and does not touch the
  existing OpenAI OAuth credential.
- Catalog commands are `opencode models` and `opencode models <provider>`;
  the server's `GET /provider` supplies the structured provider/model view.
- Free models were available through provider `opencode` without Go enrollment.

Architecture impact: login/status/catalog use a short-lived localhost server;
logout uses an explicit provider argument. Provider selection is fixed in the
Supervisor allowlist, and the obsolete manual stdin enrollment is disabled.
