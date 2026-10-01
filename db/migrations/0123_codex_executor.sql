-- Codex as an executor (Stage 12 X2, decision T6 as the owner changed it on
-- 2026-09-29). A task is `codex exec` under a workspace permission profile that
-- denies ~/.codex and allows the network (M0's profile, extended); only from
-- Codex 0.155.0, the first that holds such a profile. The mirror of the
-- registry's roles and the driver's capabilities (0074), extended by what an
-- executor needs.

SET search_path TO control_plane, public, extensions;

INSERT INTO runtime_roles(runtime_type, role) VALUES ('codex','executor')
ON CONFLICT DO NOTHING;
INSERT INTO runtime_capabilities(runtime_type, capability)
SELECT 'codex', c FROM unnest(ARRAY['run.workspace_write','tools.worker_report']) c
ON CONFLICT DO NOTHING;
