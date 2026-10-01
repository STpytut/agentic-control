-- The sidebar counts issues waiting to be started (0132) beside chats waiting
-- for the owner: a waiting issue said "Nothing waits for you".
--
-- The web role reads the count's columns only — not an issue's title or body,
-- which it reads through get_issue_intake with the owner checked.

SET search_path TO control_plane, public, extensions;

GRANT SELECT (status) ON issue_links TO infra_web;
GRANT SELECT (project_id, enabled) ON issue_intake_settings TO infra_web;
