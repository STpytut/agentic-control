-- The approval message only after the review (rc.132).
--
-- A task is awaiting_review twice: when the executor finishes — the
-- orchestrator's review is queued and moves it to reviewing a few seconds
-- later — and again when that review approves it, which is the operator's
-- turn. 0140's trigger fired on any change to awaiting_review, so on
-- 2026-10-08 the owner was told "Needs your approval — the orchestrator
-- reviewed the changes" before the review had begun, and then again after it.
-- It now fires on the second only: reviewing → awaiting_review.

SET search_path TO control_plane, public, extensions;

DROP TRIGGER tasks_notify_awaiting_approval ON tasks;
CREATE TRIGGER tasks_notify_awaiting_approval
  AFTER UPDATE OF status ON tasks
  FOR EACH ROW
  WHEN (OLD.status = 'reviewing' AND NEW.status = 'awaiting_review')
  EXECUTE FUNCTION notify_task_awaiting_approval();
