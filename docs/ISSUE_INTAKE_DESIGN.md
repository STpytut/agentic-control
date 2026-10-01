# GitHub issues as chats — design

The owner asked (2026-10-01) for the platform to take work from GitHub
issues: a labelled issue becomes a chat, the chat's pull request closes the
issue. This is the plan and the decisions behind it.

## What an issue is to the platform

Untrusted text. Anyone who can open an issue on the repository can write
into it, and whatever it says reaches an agent with write access to the
workspace. So:

1. **Only trusted authors.** An issue is a candidate only when GitHub reports
   its author as `OWNER`, `MEMBER` or `COLLABORATOR` (`author_association`).
   Others are recorded as ignored, with the reason, and never offered.
2. **Only by label.** The project names one label (default `agent`); an open
   issue without it is not read at all.
3. **The owner starts it.** A candidate waits in the project as "Issue
   waiting" with Start and Dismiss. Nothing runs on its own in the first
   version. An automatic mode, if it comes, is a per-project switch that is
   off by default and still applies 1 and 2.
4. **Fenced in the prompt.** The chat's objective quotes the issue as data —
   its number, title, author and body inside a marked block — under a line
   that says it is a request from GitHub, not instructions about the
   platform, its tools or its rules.

## Steps

**I1 — intake (rc.117).**
- 0132: `issue_intake_settings` (project, enabled, label), `issue_links`
  (project, issue number and id, title, author, association, state, status,
  task), and the functions: the worker records what it read; the panel lists
  candidates, starts one (which creates the chat through
  `create_task_with_executors` and links it) or dismisses one.
- The GitHub App worker polls, once a minute at most, each project with
  intake on: `GET /repos/{owner}/{repo}/issues?labels=…&state=open`, with an
  installation token scoped to that repository and `issues: read`.
- The panel: Project settings → GitHub issues (on/off, label); the project's
  start page lists waiting issues with Start and Dismiss.
- Permissions: the App needs **Issues: Read and write**. A new App gets it
  from the manifest; an existing one is changed once by the owner on GitHub
  and the installation accepts it. Until then the poll reads 403 and the
  settings section says what to do — no silent failure.

**I2 — the loop back to GitHub (rc.118).**
- The pull request's body ends with `Closes #N`, so merging closes the issue.
- The bot comments on the issue when the chat starts and when the pull
  request opens, with links. Two comments, no running commentary.

**Later, if wanted.** A webhook instead of polling (needs the App's webhook
secret and a public route); automatic start; several issues in parallel,
which needs a workspace per task rather than one per project.

## Not in scope

Issues from repositories the project is not connected to; pull request
comments as instructions; editing or closing issues other than through the
merged pull request.
