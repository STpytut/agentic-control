-- Migration 0153: a pull request's review by Codex.
--
--   * asked from a chat: refused for a project without a connected GitHub
--     repository, without a Codex model on its team, for a bad number or a
--     stranger; the same pull request asked again while open is that review;
--   * the broker's fetch: claimed with what it needs, finished with the
--     commits (`pr_review.started`) or the reason (`pr_review.failed`);
--   * the run: claimed, its context read under the lease only, finished with
--     the review and findings (`pr_review.completed`);
--   * posting on GitHub only on the owner's word, once, and its outcome;
--   * none of its events is routed to a job.
\set ON_ERROR_STOP on

BEGIN;
SET search_path TO control_plane, public, extensions;

CREATE FUNCTION pg_temp.reason_of(p_sql text) RETURNS text LANGUAGE plpgsql AS $$
DECLARE v_detail text;
BEGIN
  EXECUTE p_sql;
  RETURN NULL;
EXCEPTION WHEN OTHERS THEN
  GET STACKED DIAGNOSTICS v_detail = PG_EXCEPTION_DETAIL;
  IF v_detail IS NULL OR left(v_detail, 1) <> '{' THEN RETURN 'NO_DETAIL: ' || SQLERRM; END IF;
  RETURN v_detail::jsonb->>'reason';
END $$;

DO $$
DECLARE
  v_owner uuid; v_github uuid; v_codex_connection uuid; v_codex uuid; v_project uuid; v_bare uuid; v_task uuid; v_bare_task uuid;
  v_review uuid; v_result jsonb; v_reason text; v_claim jsonb; v_events text[];
BEGIN
  IF NOT has_function_privilege('infra_web','request_pr_review(uuid,uuid,uuid,integer,text)','EXECUTE')
     OR has_function_privilege('infra_web','finish_pr_review(uuid,text,jsonb)','EXECUTE')
     OR NOT has_function_privilege('infra_worker','claim_pr_review_fetch(text)','EXECUTE')
     OR has_table_privilege('infra_web','pr_reviews','SELECT') THEN
    RAISE EXCEPTION 'pull request review grants are wrong';
  END IF;

  INSERT INTO users(display_name,role) VALUES('Review owner','owner') RETURNING id INTO v_owner;
  INSERT INTO provider_connections(operator_id,provider,auth_method,status,external_installation_id,repository_selection,native_credential_reference)
    VALUES(v_owner,'github','github_app','connected','5550','selected','github-app:5550') RETURNING id INTO v_github;
  INSERT INTO provider_connections(operator_id,provider,auth_method,status)
    VALUES(v_owner,'codex','device_code','connected') RETURNING id INTO v_codex_connection;
  INSERT INTO provider_model_catalog(operator_id,connection_id,runtime_type,provider_id,model_id,discovery_source,status,last_verified_at,verification_id)
    VALUES(v_owner,v_codex_connection,'codex','openai','gpt-review','codex_model_list','verified',clock_timestamp(),gen_random_uuid()) RETURNING id INTO v_codex;
  INSERT INTO projects(owner_id,name,slug,workspace_path,repository_url,default_branch,status,settings,
      credential_mode,provider_connection_id,github_repository_id,repository_full_name)
    VALUES(v_owner,'Reviewed','pr-reviewed','/srv/pr-reviewed','https://github.com/owner/reviewed.git','main','active','{}',
      'github_app',v_github,7070,'owner/reviewed') RETURNING id INTO v_project;
  INSERT INTO projects(owner_id,name,slug,workspace_path,status) VALUES(v_owner,'Local','pr-local','/srv/pr-local','active') RETURNING id INTO v_bare;
  INSERT INTO tasks(project_id,title,objective,created_by) VALUES(v_project,'Chat','Talk','test') RETURNING id INTO v_task;
  INSERT INTO tasks(project_id,title,objective,created_by) VALUES(v_bare,'Chat','Talk','test') RETURNING id INTO v_bare_task;

  -- Refusals.
  v_reason := pg_temp.reason_of(format($q$SELECT request_pr_review(%L,%L,%L,7,'o')$q$, v_bare, v_bare_task, v_owner));
  IF v_reason IS DISTINCT FROM 'pr_review_unavailable' THEN RAISE EXCEPTION 'a project without GitHub was reviewed: %', v_reason; END IF;
  v_reason := pg_temp.reason_of(format($q$SELECT request_pr_review(%L,%L,%L,7,'o')$q$, v_project, v_task, v_owner));
  IF v_reason IS DISTINCT FROM 'pr_review_needs_codex' THEN RAISE EXCEPTION 'a team without Codex was asked: %', v_reason; END IF;
  INSERT INTO project_runtime_defaults(project_id, orchestrator_entry_id) VALUES (v_project, v_codex);
  v_reason := pg_temp.reason_of(format($q$SELECT request_pr_review(%L,%L,%L,0,'o')$q$, v_project, v_task, v_owner));
  IF v_reason IS DISTINCT FROM 'pr_review_invalid' THEN RAISE EXCEPTION 'pull request 0 was asked: %', v_reason; END IF;
  v_reason := pg_temp.reason_of(format($q$SELECT request_pr_review(%L,%L,%L,7,'o')$q$, v_project, v_task, gen_random_uuid()));
  IF v_reason IS DISTINCT FROM 'project_unavailable' THEN RAISE EXCEPTION 'a stranger asked for a review: %', v_reason; END IF;
  v_reason := pg_temp.reason_of(format($q$SELECT request_pr_review(%L,%L,%L,7,'o')$q$, v_project, v_bare_task, v_owner));
  IF v_reason IS DISTINCT FROM 'task_unavailable' THEN RAISE EXCEPTION 'another project''s chat asked: %', v_reason; END IF;

  -- Asked, and asked again while open: one review.
  v_result := request_pr_review(v_project, v_task, v_owner, 7, 'owner');
  v_review := (v_result->>'review_id')::uuid;
  IF (request_pr_review(v_project, v_task, v_owner, 7, 'owner')->>'review_id')::uuid <> v_review THEN RAISE EXCEPTION 'a repeat started a second review'; END IF;
  IF (SELECT model FROM pr_reviews WHERE id = v_review) <> 'gpt-review' THEN RAISE EXCEPTION 'the review is not on the team''s Codex'; END IF;

  -- The broker's fetch.
  v_claim := claim_pr_review_fetch('broker');
  IF v_claim->>'review_id' <> v_review::text OR v_claim->>'repository_full_name' <> 'owner/reviewed'
     OR v_claim->>'installation_id' <> '5550' OR (v_claim->>'pr_number')::int <> 7 THEN
    RAISE EXCEPTION 'fetch claim: %', v_claim;
  END IF;
  IF claim_pr_review_fetch('broker-2') IS NOT NULL THEN RAISE EXCEPTION 'a leased fetch was claimed twice'; END IF;
  IF pr_review_inbox_target(v_review) IS NULL THEN RAISE EXCEPTION 'the inbox of a review being fetched is refused'; END IF;
  v_reason := pg_temp.reason_of(format($q$SELECT finish_pr_review_fetch(%L,'broker-2','{"status":"fetched"}')$q$, v_review));
  IF v_reason IS DISTINCT FROM 'pr_review_not_held' THEN RAISE EXCEPTION 'another broker finished the fetch: %', v_reason; END IF;
  PERFORM finish_pr_review_fetch(v_review, 'broker', jsonb_build_object('status','fetched','title','Change a','pr_url','https://github.com/owner/reviewed/pull/7',
    'base_ref','main','base_sha',repeat('b',40),'head_sha',repeat('a',40)));
  IF pr_review_inbox_target(v_review) IS NOT NULL THEN RAISE EXCEPTION 'a fetched review still opens an inbox'; END IF;

  -- The run.
  v_reason := pg_temp.reason_of(format($q$SELECT pr_review_run_context(%L,'reviewer')$q$, v_review));
  IF v_reason IS DISTINCT FROM 'pr_review_not_held' THEN RAISE EXCEPTION 'an unclaimed review was read: %', v_reason; END IF;
  IF claim_pr_reviews('reviewer')->>'review_id' <> v_review::text THEN RAISE EXCEPTION 'the review was not claimed'; END IF;
  v_result := pr_review_run_context(v_review, 'reviewer');
  IF v_result->>'runtime_type' <> 'codex' OR v_result->>'base_ref' <> 'main' OR v_result->>'head_sha' <> repeat('a',40) THEN
    RAISE EXCEPTION 'run context: %', v_result;
  END IF;
  IF NOT heartbeat_pr_review(v_review, 'reviewer') THEN RAISE EXCEPTION 'the heartbeat did not hold'; END IF;
  v_reason := pg_temp.reason_of(format($q$SELECT request_pr_review_publish(%L,%L,%L,'o')$q$, v_project, v_owner, v_review));
  IF v_reason IS DISTINCT FROM 'pr_review_not_ready' THEN RAISE EXCEPTION 'an unfinished review was posted: %', v_reason; END IF;
  PERFORM finish_pr_review(v_review, 'reviewer', jsonb_build_object('status','reviewed','review','One finding.',
    'findings', jsonb_build_array(jsonb_build_object('priority','P1','title','Off by one','file','avg.js','line',3)),
    'tokens', jsonb_build_object('input',14769,'cache_read',12800,'output',237,'reasoning',0)));
  -- rc.146 (0154): its tokens count in its chat.
  IF (SELECT total_tokens FROM run_usage WHERE pr_review_id = v_review) IS DISTINCT FROM 27806
     OR (get_task_usage(v_project, v_task, v_owner)#>>'{totals,total_tokens}')::bigint IS DISTINCT FROM 27806 THEN
    RAISE EXCEPTION 'the review''s tokens are not the chat''s: %', get_task_usage(v_project, v_task, v_owner)->'totals';
  END IF;
  IF (SELECT status FROM pr_reviews WHERE id = v_review) <> 'reviewed' OR (SELECT jsonb_array_length(findings) FROM pr_reviews WHERE id = v_review) <> 1 THEN
    RAISE EXCEPTION 'the review was not recorded';
  END IF;

  -- Posting: on the owner's word, once.
  v_reason := pg_temp.reason_of(format($q$SELECT request_pr_review_publish(%L,%L,%L,'o')$q$, v_project, gen_random_uuid(), v_review));
  IF v_reason IS DISTINCT FROM 'pr_review_not_ready' THEN RAISE EXCEPTION 'a stranger posted the review: %', v_reason; END IF;
  PERFORM request_pr_review_publish(v_project, v_owner, v_review, 'owner');
  v_claim := claim_pr_review_publish('broker');
  IF v_claim->>'review' <> 'One finding.' OR (v_claim->>'pr_number')::int <> 7 THEN RAISE EXCEPTION 'publish claim: %', v_claim; END IF;
  PERFORM finish_pr_review_publish(v_review, NULL, 'GitHub said no');
  IF (SELECT publish_status FROM pr_reviews WHERE id = v_review) <> 'failed' THEN RAISE EXCEPTION 'a refused post was not recorded'; END IF;
  PERFORM request_pr_review_publish(v_project, v_owner, v_review, 'owner');
  PERFORM claim_pr_review_publish('broker');
  -- An answer without the comment's address is not taken for a post.
  PERFORM finish_pr_review_publish(v_review, '', NULL);
  IF (SELECT publish_error FROM pr_reviews WHERE id = v_review) <> 'GitHub did not return the comment''s address' THEN
    RAISE EXCEPTION 'a post without an address was published';
  END IF;
  -- A broker that went quiet mid-post: the post fails, it is not posted again.
  PERFORM request_pr_review_publish(v_project, v_owner, v_review, 'owner');
  PERFORM claim_pr_review_publish('broker');
  UPDATE pr_reviews SET publish_leased_until = clock_timestamp() - interval '1 second' WHERE id = v_review;
  IF claim_pr_review_publish('broker') IS NOT NULL THEN RAISE EXCEPTION 'a post that may have gone through was taken again'; END IF;
  IF (SELECT publish_error FROM pr_reviews WHERE id = v_review) !~ 'check the pull request' THEN RAISE EXCEPTION 'the quiet post was not failed'; END IF;
  PERFORM request_pr_review_publish(v_project, v_owner, v_review, 'owner');
  PERFORM claim_pr_review_publish('broker');
  PERFORM finish_pr_review_publish(v_review, 'https://github.com/owner/reviewed/pull/7#issuecomment-1', NULL);
  v_reason := pg_temp.reason_of(format($q$SELECT request_pr_review_publish(%L,%L,%L,'o')$q$, v_project, v_owner, v_review));
  IF v_reason IS DISTINCT FROM 'pr_review_not_ready' THEN RAISE EXCEPTION 'a posted review was posted again: %', v_reason; END IF;
  IF task_pr_reviews(v_project, v_task, v_owner)->0->>'publish_status' <> 'published' THEN RAISE EXCEPTION 'the panel does not see it posted'; END IF;

  -- The chat's record, and nothing routed.
  SELECT array_agg(event_type ORDER BY conversation_sequence) INTO v_events FROM domain_events WHERE task_id = v_task AND event_type LIKE 'pr_review.%';
  IF v_events <> ARRAY['pr_review.requested','pr_review.started','pr_review.completed',
      'pr_review.publish_requested','pr_review.publish_failed','pr_review.publish_requested','pr_review.publish_failed',
      'pr_review.publish_requested','pr_review.publish_failed','pr_review.publish_requested','pr_review.published'] THEN
    RAISE EXCEPTION 'chat events: %', v_events;
  END IF;
  IF EXISTS (SELECT 1 FROM runtime_jobs j JOIN domain_events e ON e.id = j.source_event_id WHERE e.event_type LIKE 'pr_review.%') THEN
    RAISE EXCEPTION 'a review event started a job';
  END IF;

  -- A failed fetch fails the review; a run whose lease ran out fails too.
  v_review := (request_pr_review(v_project, v_task, v_owner, 8, 'owner')->>'review_id')::uuid;
  PERFORM claim_pr_review_fetch('broker');
  PERFORM finish_pr_review_fetch(v_review, 'broker', '{"status":"failed","failure":"pull request #8 is closed"}');
  IF (SELECT failure FROM pr_reviews WHERE id = v_review) <> 'pull request #8 is closed' THEN RAISE EXCEPTION 'the fetch failure was lost'; END IF;
  -- Three fetches that never finished fail the review.
  v_review := (request_pr_review(v_project, v_task, v_owner, 10, 'owner')->>'review_id')::uuid;
  UPDATE pr_reviews SET attempts = 3, leased_until = clock_timestamp() - interval '1 second' WHERE id = v_review;
  PERFORM claim_pr_review_fetch('broker');
  IF (SELECT status FROM pr_reviews WHERE id = v_review) <> 'failed' THEN RAISE EXCEPTION 'a thrice-lost fetch was not failed'; END IF;
  IF NOT (pr_reviews_open(ARRAY[v_review]) = '{}') THEN RAISE EXCEPTION 'a failed review still needs its inbox'; END IF;
  v_review := (request_pr_review(v_project, v_task, v_owner, 9, 'owner')->>'review_id')::uuid;
  UPDATE pr_reviews SET status = 'reviewing', leased_by = 'gone', leased_until = clock_timestamp() - interval '1 minute' WHERE id = v_review;
  PERFORM claim_pr_reviews('reviewer');
  IF (SELECT status FROM pr_reviews WHERE id = v_review) <> 'failed' THEN RAISE EXCEPTION 'a lost run was not failed'; END IF;
  RAISE NOTICE 'pull request review assertions passed';
END $$;

ROLLBACK;
