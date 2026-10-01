-- Claude Code as an executor (Stage 12 X1, decision T6 as the owner changed it
-- on 2026-09-29: a subscription model may write). Decision C2 kept it an
-- orchestrator because an executor's shell could read the subscription's
-- credentials; M0 closed that — its Bash runs in the sandbox shell with
-- ~/.claude covered — and qualification proves it on the task surface
-- (login.isolated). The mirror of the registry's roles and the driver's
-- capabilities (0074, 0091), extended by what an executor needs.

SET search_path TO control_plane, public, extensions;

INSERT INTO runtime_roles(runtime_type, role) VALUES ('claude','executor')
ON CONFLICT DO NOTHING;
INSERT INTO runtime_capabilities(runtime_type, capability)
SELECT 'claude', c FROM unnest(ARRAY['run.workspace_write','tools.worker_report']) c
ON CONFLICT DO NOTHING;
