BEGIN;
SET search_path TO control_plane,public;

CREATE OR REPLACE FUNCTION compute_action_fingerprint(p_action_type text,p_context jsonb)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
 SELECT encode(digest(convert_to(p_action_type||':'||p_context::text,'UTF8'),'sha256'),'hex');
$$;

CREATE OR REPLACE FUNCTION enforce_approval_fingerprint()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.action_fingerprint<>compute_action_fingerprint(NEW.action_type,NEW.action_context) THEN
  RAISE EXCEPTION 'approval fingerprint does not match canonical action context' USING ERRCODE='22023';
 END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER approvals_fingerprint_guard BEFORE INSERT OR UPDATE OF action_type,action_context,action_fingerprint
 ON approvals FOR EACH ROW EXECUTE FUNCTION enforce_approval_fingerprint();

CREATE OR REPLACE FUNCTION bind_worker_interaction_session()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_session agent_sessions%ROWTYPE;
BEGIN
 SELECT s.* INTO v_session FROM task_runs r JOIN agent_sessions s ON s.id=r.session_id
  WHERE r.id=NEW.run_id FOR UPDATE OF s;
 IF NOT FOUND THEN RAISE EXCEPTION 'worker run session not found' USING ERRCODE='23503'; END IF;
 IF v_session.native_session_id IS NOT NULL AND v_session.native_session_id<>NEW.native_session_id THEN
  RAISE EXCEPTION 'worker interaction session continuity failed' USING ERRCODE='55000'; END IF;
 UPDATE agent_sessions SET native_session_id=COALESCE(native_session_id,NEW.native_session_id),
  last_resumed_at=clock_timestamp(),updated_at=clock_timestamp(),version=version+1 WHERE id=v_session.id;
 RETURN NEW;
END; $$;
CREATE TRIGGER worker_interaction_session_guard BEFORE INSERT ON worker_interaction_reports
 FOR EACH ROW EXECUTE FUNCTION bind_worker_interaction_session();

ALTER FUNCTION compute_action_fingerprint(text,jsonb) SET search_path=control_plane,public,pg_temp;
ALTER FUNCTION enforce_approval_fingerprint() SET search_path=control_plane,pg_temp;
ALTER FUNCTION bind_worker_interaction_session() SET search_path=control_plane,pg_temp;
COMMIT;
