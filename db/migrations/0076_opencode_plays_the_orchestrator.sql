-- OpenCode plays the orchestrator (Stage 11.2 N4; decision D1).
--
-- The mirror of the registry and the drivers (0074) learns what the code now
-- says: OpenCode's registry entry gives it the orchestrator as well as the
-- executor, and its driver declares the two capabilities the orchestrator's
-- core needs and it lacked —
--
--   run.read_only   a turn runs under a Landlock ruleset that leaves the
--                   workspace readable and nothing but the runtime's own state
--                   writable (services/runtime-supervisor/read-only-launch.mjs);
--   tools.platform  delegate_task and request_revision, as tool files calling
--                   the run's socket.
--
-- So runtime_plays('opencode','orchestrator') becomes true, and an OpenCode
-- orchestrator assignment, a runtime default and a routed chat message are
-- admitted by the same functions that admit Codex's. Nothing else changes.

SET search_path TO control_plane, public, extensions;

INSERT INTO runtime_roles(runtime_type, role) VALUES ('opencode','orchestrator');
INSERT INTO runtime_capabilities(runtime_type, capability) VALUES
  ('opencode','run.read_only'), ('opencode','tools.platform');
