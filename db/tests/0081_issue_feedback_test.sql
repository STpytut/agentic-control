-- The loop back to GitHub: comments on the issue, Closes #N (0133).
\set ON_ERROR_STOP on

BEGIN;
SET search_path TO control_plane, public, extensions;

DO $$
DECLARE v_owner uuid; v_connection uuid; v_project uuid; v_task uuid; v_followup uuid;
  v_link uuid; v_claim jsonb; v_reason text; i integer;
BEGIN
  INSERT INTO users(display_name) VALUES('Issue feedback') RETURNING id INTO v_owner;
  INSERT INTO provider_connections(operator_id,provider,auth_method,status,external_installation_id,
    repository_selection,native_credential_reference)
  VALUES(v_owner,'github','github_app','connected','24681359','selected','github-app:24681359')
  RETURNING id INTO v_connection;
  INSERT INTO projects(id,owner_id,name,slug,workspace_path,repository_url,default_branch,status,settings,
    credential_mode,provider_connection_id,github_repository_id,repository_full_name)
  VALUES(gen_random_uuid(),v_owner,'Feedback','issue-feedback-app','/srv/issue-feedback-app',
    'https://github.com/owner/feedback.git','main','active','{}','github_app',v_connection,6161,'owner/feedback')
  RETURNING id INTO v_project;
  -- The first task opens its conversation; a follow-up joins it.
  INSERT INTO tasks(project_id, title, objective, created_by)
  VALUES (v_project, '#9 Fix', 'Work on GitHub issue #9', 'test') RETURNING id INTO v_task;
  INSERT INTO tasks(project_id, title, objective, created_by, followup_of_task_id)
  VALUES (v_project, 'More', 'And this', 'test', v_task) RETURNING id INTO v_followup;
  INSERT INTO issue_links(project_id, issue_number, github_issue_id, title, html_url, author_login, author_association,
    status, task_id, decided_at, decided_by)
  VALUES (v_project, 9, 90009, 'Fix', 'https://github.com/owner/feedback/issues/9', 'me', 'OWNER',
    'started', v_task, clock_timestamp(), 'test')
  RETURNING id INTO v_link;

  -- The task, and a follow-up in its chat, work on the issue; an unrelated task does not.
  IF (issue_for_task(v_task)->>'number')::int <> 9 OR (issue_for_task(v_followup)->>'number')::int <> 9 THEN
    RAISE EXCEPTION 'the issue was not found for the chat';
  END IF;

  -- First the start, once.
  v_claim := claim_issue_comments('w1');
  IF jsonb_array_length(v_claim) <> 1 OR v_claim->0->>'kind' <> 'started' OR v_claim->0->>'installation_id' <> '24681359' THEN
    RAISE EXCEPTION 'wrong claim: %', v_claim;
  END IF;
  IF claim_issue_comments('w2') <> '[]'::jsonb THEN RAISE EXCEPTION 'a leased comment was claimed twice'; END IF;
  PERFORM record_issue_comment(v_link, 'started');
  IF claim_issue_comments('w1') <> '[]'::jsonb THEN RAISE EXCEPTION 'something is pending with no pull request yet'; END IF;

  -- A failed comment is retried, then left after five tries, recorded.
  UPDATE issue_links SET started_comment_at = NULL WHERE id = v_link;
  FOR i IN 1..5 LOOP
    v_claim := claim_issue_comments('w1');
    IF jsonb_array_length(v_claim) <> 1 THEN RAISE EXCEPTION 'try % was not offered', i; END IF;
    PERFORM record_issue_comment(v_link, 'started', 'GitHub said no');
  END LOOP;
  IF claim_issue_comments('w1') <> '[]'::jsonb THEN RAISE EXCEPTION 'a comment was retried past five tries'; END IF;
  IF (SELECT comment_error FROM issue_links WHERE id = v_link) <> 'GitHub said no' THEN RAISE EXCEPTION 'the error was not kept'; END IF;

  BEGIN
    PERFORM record_issue_comment(v_link, 'something', NULL);
    RAISE EXCEPTION 'an unknown comment kind was recorded';
  EXCEPTION WHEN invalid_parameter_value THEN
    GET STACKED DIAGNOSTICS v_reason = PG_EXCEPTION_DETAIL;
    IF v_reason NOT LIKE '%issue_comment_kind_unknown%' THEN RAISE EXCEPTION 'wrong refusal: %', v_reason; END IF;
  END;
END $$;

ROLLBACK;
