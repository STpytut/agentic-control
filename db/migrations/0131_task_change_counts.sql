-- The chat's step card counts the task's own files (rc.114).
--
-- The card counted the project workspace: after a publish the workspace sits
-- on the base or on the next chat's branch, and a published chat read
-- "0 files". The task's review evidence holds its diff from base to head; the
-- panel reads the counts only. The diff itself and the changed paths stay out
-- of the web role's reach — the grant names columns, not the table.

SET search_path TO control_plane, public, extensions;

GRANT SELECT (task_id, project_id, recorded_at, diffstat) ON review_evidence TO infra_web;
