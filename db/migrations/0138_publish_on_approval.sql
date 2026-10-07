-- "Approve & open PR": the operator's one click asks for both.
--
-- Until now an approval and a publish were two clicks with a wait between: the
-- approval asks the host to prepare the reviewed commit (0069), and only once
-- that preparation is done does the Publish card appear (0085). The operator
-- who already knew they wanted a pull request clicked, waited, and clicked
-- again.
--
-- The publish is still the operator's request, never a model's: the approval
-- records who asked for it on the preparation, and when the host finishes
-- preparing, the request is made in that operator's name through the same
-- request_publish, with every one of its checks. A refusal there (a repository
-- not connected through the GitHub App, a connection gone) leaves the
-- preparation as it was, and the Publish card offers it as before.

SET search_path TO control_plane, public, extensions;

INSERT INTO failure_reasons(reason, code, note) VALUES
  ('publish_on_approval_missing','not_found','the task has no publish preparation in progress to publish when it is ready')
ON CONFLICT (reason) DO NOTHING;

ALTER TABLE publish_preparations
  ADD COLUMN publish_requested_by text,
  ADD COLUMN publish_requested_correlation text,
  ADD CONSTRAINT publish_requested_whole
    CHECK ((publish_requested_by IS NULL) = (publish_requested_correlation IS NULL));

-- The approving operator's request, made right after approve_task_review: on
-- the preparation that approval opened. A preparation already done is
-- published now; one in progress, when the host finishes it.
CREATE FUNCTION request_publish_on_approval(p_project_id uuid, p_task_id uuid, p_owner_id uuid,
  p_actor text, p_correlation_id text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO control_plane, public, extensions, pg_temp
AS $$
DECLARE v_preparation publish_preparations%ROWTYPE;
BEGIN
  -- The caller's approval is in the same transaction: a refusal here is
  -- answered, not raised, so it never takes the approval back with it.
  BEGIN
  SELECT pp.* INTO v_preparation FROM publish_preparations pp
  JOIN projects p ON p.id=pp.project_id
  WHERE pp.project_id=p_project_id AND pp.task_id=p_task_id AND p.owner_id=p_owner_id
    AND pp.status IN ('requested','claimed','prepared')
  ORDER BY pp.requested_at DESC LIMIT 1
  FOR UPDATE OF pp;
  IF NOT FOUND THEN
    PERFORM refuse('publish_on_approval_missing', format('task %s has no publish preparation in progress', p_task_id));
  END IF;
  IF v_preparation.status='prepared' THEN
    RETURN request_publish(v_preparation.id, p_owner_id, p_actor, p_correlation_id) || jsonb_build_object('when','now');
  END IF;
  UPDATE publish_preparations SET publish_requested_by=p_actor, publish_requested_correlation=p_correlation_id
  WHERE id=v_preparation.id;
  RETURN jsonb_build_object('publish_preparation_id', v_preparation.id, 'when', 'prepared');
  EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object('refused', SQLERRM);
  END;
END $$;

-- When the host finishes a preparation the operator asked to publish, the
-- request is made. Its refusal is caught here: the preparation stays prepared
-- and the Publish card asks, as it does without the request.
CREATE FUNCTION publish_when_prepared()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO control_plane, public, extensions, pg_temp
AS $$
DECLARE v_owner uuid;
BEGIN
  SELECT owner_id INTO v_owner FROM projects WHERE id=NEW.project_id;
  BEGIN
    PERFORM request_publish(NEW.id, v_owner, NEW.publish_requested_by, NEW.publish_requested_correlation);
  EXCEPTION WHEN OTHERS THEN
    PERFORM write_audit_event(NEW.project_id, NEW.task_id, NULL, 'system', 'publish-on-approval',
      'task.publish_on_approval_refused', 'publish_preparation', NEW.id::text, 'denied', NULL,
      jsonb_build_object('message', left(SQLERRM, 500)), NEW.publish_requested_correlation);
  END;
  RETURN NULL;
END $$;

CREATE TRIGGER publish_preparations_publish_when_prepared
  AFTER UPDATE OF status ON publish_preparations
  FOR EACH ROW
  WHEN (OLD.status <> 'prepared' AND NEW.status = 'prepared' AND NEW.publish_requested_by IS NOT NULL)
  EXECUTE FUNCTION publish_when_prepared();

REVOKE ALL ON FUNCTION request_publish_on_approval(uuid,uuid,uuid,text,text), publish_when_prepared() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION request_publish_on_approval(uuid,uuid,uuid,text,text) TO infra_web;
