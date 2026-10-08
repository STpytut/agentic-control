# Stage 12 — the analyst (M2–M5, first slice)

The owner's order (2026-10-08): roles with instructions, then a read-only
**analyst** the orchestrator calls by name, then the analyst beside the coder,
then usage per member. A tester agent is deferred: the platform's own project
check (0143) already runs the tests and blocks the publish.

## What the owner sees

- Team settings gain an **Analysts** section: add an analyst on a verified model
  (Claude Code or OpenCode), give it a name and instructions ("security
  reviewer: look for injection and secrets"), remove it.
- In a chat, the orchestrator may ask an analyst a question. The chat shows
  "Orchestrator asked <analyst>: …", then the analyst's answer as its own
  message, with its model. The orchestrator gets the answer as a new turn and
  carries on: plans, delegates, reviews.
- The analyst can work while the coder writes: it reads a snapshot, never the
  live workspace.

## Shape

| Piece | What |
| --- | --- |
| role | built-in `analyst` (`role_definitions`), permission `consultation.answer`; its runtime core is `run.read_only`, `stream.structured`, `interrupt`; Claude Code and OpenCode play it (registry `roles`, mirrored in `runtime_roles`) |
| member | `project_analysts`: the assignment, the catalog model, the reasoning level, a display name and instructions |
| command | `platform.consult({member?, question})` on the orchestrator's turn; refused for a member who is not an enabled analyst of the project |
| record | `consultations`: question, analyst, status requested → answered / failed, answer (≤ 32 KiB) |
| flow | `consultation.requested` → job `consultation_run` → the supervisor's `consult` surface → `finish_consultation` → `consultation.answered` → `resume_orchestrator` |
| snapshot | `git archive HEAD` of the workspace, as its owner, in its turn; extracted into a scratch directory owned by the analyst's runtime user; removed after the run |
| launch | batch, read-only under the Landlock ruleset (as an orchestrator turn), no platform tools, no shell; the answer is the run's final message; 15 minutes, 4 MiB of output |
| prompt | since rc.143 the analyst's role and the operator's instructions are the run's system prompt (Claude Code `--append-system-prompt`; OpenCode at the head of the prompt); the message is the question and the repository map's layout. Since rc.142 a Claude Code analyst answers by a JSON schema (summary, findings with file and line, open questions) |

The analyst's answer is data the orchestrator reads: it reaches the orchestrator
fenced and labelled as the analyst's report, never as the operator's words.

## Not in this slice

- Codex as an analyst (its batch surface is the writer's `exec`; a read-only
  exec with the login denied is its own qualification).
- Custom roles from the panel (an analyst's instructions cover the need).
- Usage per member (M7) and the "who is working now" strip (M6's panel half).
