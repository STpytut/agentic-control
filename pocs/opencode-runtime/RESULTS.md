# OpenCode Runtime PoC Results

## Test metadata

- Date: 2026-07-16
- Host: Ubuntu 24.04 LTS VPS, Linux `x86_64`
- CLI: `opencode 1.18.3`
- Runtime user: isolated `opencode-worker`
- Authentication: official OpenAI/ChatGPT headless device flow
- Model: `opencode/north-mini-code-free`
- Interface: `opencode run --format json`
- Auto sharing: disabled
- Reported model cost: `0`

OpenCode Go was intentionally not configured. The PoC used a free model visible
in the installed CLI, while the saved ChatGPT OAuth credential remains
available for later provider/model switching.

## Result summary

| Capability | Result | Evidence |
| --- | --- | --- |
| CLI discovery/version | Passed | `opencode --version` → `1.18.3` |
| Official headless auth | Passed | OpenAI OAuth credential saved by device flow |
| Free model discovery | Passed | `opencode/north-mini-code-free` listed by CLI |
| Non-interactive start | Passed | exit code `0` |
| Raw JSON streaming | Passed | `step_start`, `tool_use`, `step_finish`, `text` |
| Native session ID | Passed | `ses_09354ee0affeCS9LrCNzo6eJPB` |
| Workspace write | Passed | phase-one file created by write tool |
| Resume after process exit | Passed | explicit `--session` in a new process |
| Same native session | Passed | all resume events used the saved ID |
| Conversation continuity | Passed | remembered `APOLLO-WORKER-4815` without reading phase-one file |
| Write-capable resume | Passed | phase-two file created |
| Usage/cost telemetry | Passed | all six step costs reported as `0` |
| HTTP server/SSE | Not tested | Next OpenCode adapter PoC |
| Abort active session | Not tested | Official server endpoint identified |
| Permission request/response | Not tested | Official server endpoint identified |

Independent verifier result: 10/10 checks passed.

## Event shape

The JSON stream contains one object per line. Observed event types:

- `step_start` with `sessionID` and snapshot;
- `tool_use` with tool name, call ID, input, output, timing and status;
- `step_finish` with reason, token counters, cache counters and cost;
- `text` with the completed assistant text part.

Both start and resume emitted three `step_start`, two `tool_use`, three
`step_finish`, and one `text` events.

## Start/resume evidence

Start command shape:

```bash
opencode run \
  --pure \
  --auto \
  --format json \
  --model opencode/north-mini-code-free \
  '<prompt>'
```

Resume adds:

```bash
--session ses_09354ee0affeCS9LrCNzo6eJPB
```

Created contents:

```text
OPENCODE_POC_PHASE_ONE_OK
MEMORY_TOKEN=APOLLO-WORKER-4815
```

```text
OPENCODE_POC_RESUME_OK
MEMORY_TOKEN=APOLLO-WORKER-4815
```

The free model omitted the final newline requested by the prompt in both files.
This is recorded as model instruction-format fidelity, not a runtime write or
resume failure.

## Discovered integration constraints

### 1. Project `PWD` must match the child working directory

The first Node runner set `spawn.cwd` correctly but inherited `PWD=/root` from
the supervisor process. OpenCode returned `Session not found` before creating a
new session. A direct shell run from the workspace worked.

Setting both the OS working directory and `PWD` to the canonical workspace
resolved the issue:

```js
spawn("opencode", args, {
  cwd: workspace,
  env: { ...process.env, PWD: workspace },
});
```

The production adapter must canonicalize and set both values, then verify the
session directory before resume.

### 2. Auth and model/provider are separate configuration

The runtime has an OpenAI OAuth credential, but the PoC explicitly selected a
free `opencode/*` model. Provider/model selection must remain a runtime profile
setting rather than being inferred from the available credentials.

### 3. `--auto` is test-only

Automatic permission acceptance was scoped to a dedicated Unix user and an
isolated test workspace. Production must use OpenCode server permission events
and the permission response API with platform authorization and audit.

## Decision

`opencode run --format json` is approved for batch jobs and the first real
Codex→OpenCode dispatch PoC. Native session resume, structured output, tool
events, workspace writes, and memory continuity work on the target VPS.

For the interactive production adapter, the next gate is `opencode serve` over
localhost with OpenAPI/SSE, async prompt, abort, and permission-response tests.
