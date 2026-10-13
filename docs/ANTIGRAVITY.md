# Antigravity (`agy`) as a runtime

rc.150. Google's Antigravity CLI is the fourth runtime the platform drives, and
the first that is an **analyst only**. Everything here was measured by the spike
on the production host at agy 1.3.4 (2026-10-13); the registry entry
(`services/operations/runtime-adapters.mjs`) and the driver
(`services/runtime-supervisor/drivers/antigravity.mjs`) are the code of record.

## What it plays, and why not more

agy's headless interface mirrors Claude Code's: `agy -p "<prompt>"
--output-format stream-json`, one JSON object per stdout line (`init`,
`step_update`, `result`), a conversation resumed by `--conversation <id>`.
What it lacks is a way to add an MCP server: the platform's tools — the
orchestrator's `delegate_task`, an executor's `complete_task` — cannot reach it,
and the two roles that need them stay closed by the capability mirror (0074).
The analyst (0147) needs none: it reads a snapshot and answers once, held
read-only by the kernel. The pull-request reviewer stays Codex's: its review
surface is `codex exec review`'s own, and nothing of it generalises in this
release.

There is **no system-prompt flag**. A role's instructions head the prompt, as
OpenCode's do. Nothing is invented for it.

## Install: pinned, not from the vendor's installer

agy's own installer has no version flag, and its auto-updater manifest
(`…/manifests/linux_amd64.json`, `{version, url, sha512}`) names the newest
build only and nobody signs it. So:

* the release **pins** the versions it was shown with — the tarball's URL and
  sha512 (`pinnedReleases` in the registry). A pinned version is resolved from
  the pin and the manifest is not asked;
* a version the release does not pin is taken from the manifest only when the
  manifest names exactly that version, and the install record says the digest
  came from an unsigned manifest (`signedBy: vendor-manifest-sha512-unsigned:…`);
* the tarball holds one file, `antigravity`; it is unpacked into the usual
  root-owned, 0755 version directory and reached as `agy` through the link on
  PATH, like the others.

`sudo infra-cod runtime install antigravity` installs the recommended version.
The daily watch reads the manifest and dates its one version by the day it was
first seen (the manifest carries no date).

## Self-update: the directory is the switch

agy updates itself in the background and has no setting that stops it. When the
directory holding its binary is not writable it logs
`Directory … is not fully accessible (readable: true, writable: false), skipping
update` and runs on. The root-owned version directory is therefore the kill
switch (`autoUpdate.mechanism: "directory"`):

* an install verifies the tree is root's and neither group- nor world-writable
  before activating it;
* `doctor` reports `runtime.executable_directory.antigravity` every minute;
* a qualification's `config.keys` asks, as `antigravity-worker`, whether the
  candidate's directory is writable (it must not be) and checks every flag the
  driver passes against `agy --help`.

## Helper binaries

At run time agy downloads helper binaries (`agentapi`, `webm_encoder`) into
`~/.gemini/antigravity-cli/bin` — inside its own writable state, outside the
workspace. This release does not block them; `doctor` warns
(`runtime.helper_binaries.antigravity`) when they are there. Blocking or
pinning them is a follow-up.

## State, read-only runs

Under the read-only launch (Landlock) agy needs three writable paths, verified
on the host: `~/.gemini`, `~/.config/antigravity`, `~/.cache`. With exactly
these it runs and a workspace write is `EACCES`. They are the runtime's
`writableState`, mounted by the supervisor's unit, made by tmpfiles, guarded by
the installer, carried by backups (`.gemini`).

## Sign-in

Signed out, a headless run prints on stderr `Authentication required. Please
visit the URL to log in:` with an `accounts.google.com` link, then `Or, paste
the authorization code here and press Enter:` and reads the code from stdin for
**60 seconds**. Without a D-Bus session the token lands in
`~/.gemini/antigravity-cli/antigravity-oauth-token` (0600), which is the
runtime's auth evidence.

The panel signs it in by the paste-code flow Claude Code's sign-in made (0136),
now a runtime's (0157): `claude_login_sessions` rows name their runtime,
`start_runtime_login(owner, runtime)` starts one for any runtime whose driver
declares `account.login`, and the account worker opens that runtime's account
surface — for agy, one headless prompt in its home. A run that answers without
asking was signed in already and the sign-in succeeds at once. The owner has a
minute from the link to paste the code; after it the panel says so and offers to
start again.

An API key (`{"modelProvider":"gemini"}` in `~/.gemini/antigravity-cli/
settings.json` with `GEMINI_API_KEY`) is not offered in this release: the
account surface has one shape per runtime, and a second would be a second card.
Follow-up.

## Models and effort

`agy models` lists `id<TAB>Display name` lines (`gemini-3.8-flash-high`,
`claude-sonnet-4-6`, `claude-opus-4-6-thinking`, `gpt-oss-120b-medium`, …). The
catalog refresh reads it through the supervisor (`runtime_model_list`) as
`antigravity-worker` and records each model under `antigravity_models`; the
model check lane runs each before it is offered, as for every runtime. A
model's vendor is read from its id (`catalog_model_vendor`).

`--effort low|medium|high|xhigh|max` is accepted by the driver, but which models
take it is not known per model (some carry a level in their name), so the
catalog offers **no reasoning levels** for Antigravity yet.

## Events and usage

| agy event | platform event |
| --- | --- |
| `init` | `runtime.turn.started` (with the model) |
| `step_update` tool, ACTIVE / DONE | `runtime.tool.updated` requested / completed / error |
| `step_update` agent_response DONE | `runtime.output.completed` |
| `result` | `runtime.turn.usage` (status, tokens); an error's text |
| anything else | kept raw |

The result's usage (`input_tokens`, `output_tokens`, `thinking_tokens`,
`cache_read_tokens`, `total_tokens`) becomes the run's tokens; whether the
cache and thinking counts are nested in the input and output is read from the
total agy reports (`antigravityTokens`). The token meter reads it at the end of
the run, like Codex's. A model or agent error exits 3 with an `AGY_ERROR:
{json}` line on stderr, which the driver's `failure` reads beside the stream.

## Not in this release

* orchestrator, executor and pull-request reviewer roles (no MCP, see above);
* live input (`--input-format stream-json` exists, but the surface it would
  serve — an executor's — this runtime does not have);
* reasoning levels in the catalog;
* the API-key account;
* holding back the helper binaries.
