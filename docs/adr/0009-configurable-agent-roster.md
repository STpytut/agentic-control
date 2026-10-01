# ADR-0009: Configure orchestrator and executor roster per project

## Status

Accepted. Supersedes the role-binding part of ADR-0006; its least-privilege and
approval requirements remain in force.

## Context

The baseline assigned orchestration and publishing directly to Codex and kept a
single runtime profile on each Agent. That makes the first vertical slice safe,
but it conflates four independent choices: workflow role, runtime, provider and
model. It also makes `active_agent_id` ambiguous when ownership temporarily
moves from the orchestrator to an implementation worker.

## Decision

- A project owns an explicit roster of agent assignments.
- Each assignment binds a role (`orchestrator` or `executor`), an Agent and one
  capability-verified RuntimeProfile.
- A project has one default orchestrator and zero or more executors.
- A task snapshots its orchestrator assignment and selected executor roster.
- `active_agent_id` remains the current workflow owner; it does not redefine the
  task orchestrator.
- Model selection is selection of an enabled RuntimeProfile. Clients cannot send
  an arbitrary model string to a privileged runtime.
- Only runtimes that passed the persistent-chat capability gate are offered as
  orchestrators. Initially that is Codex app-server.
- Publishing is a separate policy capability. Being selected as orchestrator
  does not automatically grant commit, push, credentials or deployment access.
  In the initial deployment only the approved Codex profile may receive that
  capability, with existing approvals.

## Consequences

- Additional Codex models and future orchestration adapters appear without a
  task-schema redesign.
- Executor/provider choices can vary by project and task.
- Native sessions preserve the selected runtime profile as well as agent ID.
- Existing projects are backfilled to their current Codex orchestrator and one
  compatible implementation worker.
- Runtime-specific transports remain adapters: the generic role model does not
  pretend that OpenCode or Antigravity can orchestrate before their gates pass.
