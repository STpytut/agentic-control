-- Roles are permission sets, expand half (Stage 11.3, sprint B R2; ADR-0017).
--
-- A project assignment used to say what it may do with one of two words,
-- `assignment_role ∈ {orchestrator, executor}`. It now points at a role
-- definition: a named, versioned set of permissions from a closed vocabulary,
-- and each permission names the runtime capabilities it needs.
--
-- This release, the expand:
--
--   * the vocabulary, its capability requirements and the two built-in
--     definitions that are today's behaviour (ADR-0017 §3);
--   * `project_agent_assignments.role_definition_id`, backfilled from
--     `assignment_role`. The writers still write `assignment_role` and a trigger
--     fills the definition; a row written with a definition gets its
--     `assignment_role` from the definition's permissions, so the readers of
--     this release, which still decide on `assignment_role`, see what they
--     always saw, and the one-default-orchestrator index holds for any
--     definition that holds the conversation;
--   * the database refuses a definition with a combination ADR-0017 §4
--     forbids, a change to a built-in, and an assignment whose runtime lacks a
--     capability one of its permissions needs;
--   * a task snapshots the permissions of its assignments when it gets them,
--     and keeps them whatever later happens to the definition.
--
-- No decision function changes here: R3 (0080) makes them read permissions.
-- Custom definitions are possible in the schema but nothing writes them yet —
-- their functions arrive with 11.5's team editor (ADR-0017 §3).

SET search_path TO control_plane, public, extensions;

INSERT INTO failure_reasons(reason, code, note) VALUES
  ('role_definition_invalid','invalid_argument','a role definition has no permission, or a combination ADR-0017 forbids'),
  ('role_definition_builtin','conflict','a built-in role definition is changed only by a migration'),
  ('role_permission_unsupported','conflict','the runtime lacks a capability one of the role''s permissions needs');

CREATE TABLE role_permission_vocabulary (
  permission text PRIMARY KEY CHECK (permission ~ '^[a-z]+\.[a-z_]+$'),
  note text NOT NULL
);
INSERT INTO role_permission_vocabulary(permission, note) VALUES
  ('conversation.hold','holds the task''s conversation: receives messages, delegates, asks for revisions'),
  ('implementation.execute','takes a handoff and changes the workspace under a fencing token'),
  ('review.perform','receives review evidence and gives a verdict bound to its digest'),
  ('publish.request','may ask for a publish to be prepared; never publishes'),
  ('completion.required','an implementation is complete only with evidence whose platform checks all passed');

-- ADR-0017 §5: what a runtime must be able to do for each permission. The
-- capability names are the drivers' (capabilities.mjs), mirrored as 0074 did.
CREATE TABLE permission_capabilities (
  permission text NOT NULL REFERENCES role_permission_vocabulary(permission),
  capability text NOT NULL,
  PRIMARY KEY (permission, capability)
);
INSERT INTO permission_capabilities(permission, capability)
SELECT 'conversation.hold', capability FROM runtime_role_core WHERE role='orchestrator'
UNION ALL SELECT 'review.perform', capability FROM runtime_role_core WHERE role='orchestrator'
UNION ALL SELECT 'implementation.execute', capability FROM runtime_role_core WHERE role='executor';

CREATE TABLE role_definitions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid REFERENCES users(id),
  builtin_key text UNIQUE CHECK (builtin_key IN ('orchestrator','executor')),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  description text NOT NULL DEFAULT '' CHECK (length(description) <= 500),
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  -- A built-in belongs to nobody; anything else belongs to its owner.
  CHECK ((builtin_key IS NULL) <> (owner_id IS NULL))
);
CREATE TABLE role_permissions (
  role_definition_id uuid NOT NULL REFERENCES role_definitions(id) ON DELETE CASCADE,
  permission text NOT NULL REFERENCES role_permission_vocabulary(permission),
  PRIMARY KEY (role_definition_id, permission)
);

INSERT INTO role_definitions(builtin_key, name, description) VALUES
  ('orchestrator','Orchestrator','Holds the conversation, delegates, reviews, and may ask for a publish.'),
  ('executor','Executor','Implements a handoff in the workspace and is complete only on passing evidence.');
INSERT INTO role_permissions(role_definition_id, permission)
SELECT d.id, p.permission FROM role_definitions d
JOIN (VALUES ('orchestrator','conversation.hold'),('orchestrator','review.perform'),('orchestrator','publish.request'),
             ('executor','implementation.execute'),('executor','completion.required')) AS p(builtin_key, permission)
  ON p.builtin_key=d.builtin_key;

-- ADR-0017 §4. Empty for a valid definition.
CREATE FUNCTION role_definition_problems(p_role_definition_id uuid) RETURNS text[]
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=control_plane,public,extensions,pg_temp AS $$
  WITH p AS (SELECT array_agg(permission) AS set FROM role_permissions WHERE role_definition_id=p_role_definition_id)
  SELECT array_remove(ARRAY[
    CASE WHEN p.set IS NULL THEN 'it grants no permission' END,
    CASE WHEN p.set @> ARRAY['implementation.execute','conversation.hold']
      THEN 'implementation.execute and conversation.hold are separate runs with separate guarantees' END,
    CASE WHEN 'review.perform'=ANY(p.set) AND NOT 'conversation.hold'=ANY(p.set)
      THEN 'review.perform is held by the conversation holder until a separate reviewer exists' END,
    CASE WHEN 'completion.required'=ANY(p.set) AND NOT 'implementation.execute'=ANY(p.set)
      THEN 'completion.required belongs to implementation.execute' END
  ], NULL) FROM p;
$$;

-- Whether a runtime can do what every permission of a definition needs.
CREATE FUNCTION assignment_may(p_runtime_type text, p_role_definition_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=control_plane,public,extensions,pg_temp AS $$
  SELECT NOT EXISTS (
    SELECT 1 FROM role_permissions rp JOIN permission_capabilities pc ON pc.permission=rp.permission
    WHERE rp.role_definition_id=p_role_definition_id
      AND NOT EXISTS (SELECT 1 FROM runtime_capabilities c
                      WHERE c.runtime_type=p_runtime_type AND c.capability=pc.capability));
$$;

-- A definition is checked once its permissions are in place: at commit, so a
-- definition can be written a row at a time.
CREATE FUNCTION check_role_definition() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path=control_plane,public,extensions,pg_temp AS $$
DECLARE v_id uuid := CASE WHEN TG_OP='DELETE' THEN OLD.role_definition_id ELSE NEW.role_definition_id END; v_problems text[];
BEGIN
  IF NOT EXISTS (SELECT 1 FROM role_definitions WHERE id=v_id) THEN RETURN NULL; END IF;
  v_problems := role_definition_problems(v_id);
  IF cardinality(v_problems) > 0 THEN
    PERFORM refuse('role_definition_invalid', format('role definition %s: %s', v_id, array_to_string(v_problems, '; ')));
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER role_permissions_valid
  AFTER INSERT OR UPDATE OR DELETE ON role_permissions DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION check_role_definition();

-- The built-ins are today's behaviour; only a migration changes them.
CREATE FUNCTION guard_builtin_role() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path=control_plane,public,extensions,pg_temp AS $$
BEGIN
  -- Separate branches: PL/pgSQL evaluates both sides of an AND, and each
  -- table's row has only its own fields.
  IF TG_TABLE_NAME='role_definitions' THEN
    IF OLD.builtin_key IS NOT NULL THEN
      PERFORM refuse('role_definition_builtin', format('built-in role %s is changed only by a migration', OLD.builtin_key));
    END IF;
  ELSIF EXISTS (SELECT 1 FROM role_definitions d
      WHERE d.id=CASE WHEN TG_OP='DELETE' THEN OLD.role_definition_id ELSE NEW.role_definition_id END
        AND d.builtin_key IS NOT NULL) THEN
    PERFORM refuse('role_definition_builtin', 'the permissions of a built-in role are changed only by a migration');
  END IF;
  RETURN COALESCE(NEW, OLD);
END $$;
CREATE TRIGGER role_definitions_builtin_guard BEFORE UPDATE OR DELETE ON role_definitions
  FOR EACH ROW EXECUTE FUNCTION guard_builtin_role();
CREATE TRIGGER role_permissions_builtin_guard BEFORE INSERT OR UPDATE OR DELETE ON role_permissions
  FOR EACH ROW EXECUTE FUNCTION guard_builtin_role();

-- The assignment's definition, and its word for this release's readers.
ALTER TABLE project_agent_assignments ADD COLUMN role_definition_id uuid REFERENCES role_definitions(id);
UPDATE project_agent_assignments pa SET role_definition_id=d.id
  FROM role_definitions d WHERE d.builtin_key=pa.assignment_role;
ALTER TABLE project_agent_assignments ALTER COLUMN role_definition_id SET NOT NULL;

CREATE FUNCTION fill_assignment_role_definition() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path=control_plane,public,extensions,pg_temp AS $$
BEGIN
  IF NEW.role_definition_id IS NULL
     OR (TG_OP='UPDATE' AND NEW.assignment_role IS DISTINCT FROM OLD.assignment_role
         AND NEW.role_definition_id IS NOT DISTINCT FROM OLD.role_definition_id) THEN
    -- A writer of this release names the word; the built-in of that word is its definition.
    SELECT id INTO NEW.role_definition_id FROM role_definitions WHERE builtin_key=NEW.assignment_role;
  ELSE
    -- A definition names the word: the conversation holder is the orchestrator.
    NEW.assignment_role := CASE WHEN EXISTS (SELECT 1 FROM role_permissions
        WHERE role_definition_id=NEW.role_definition_id AND permission='conversation.hold')
      THEN 'orchestrator' ELSE 'executor' END;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER project_agent_assignments_role_definition
  BEFORE INSERT OR UPDATE OF assignment_role, role_definition_id ON project_agent_assignments
  FOR EACH ROW EXECUTE FUNCTION fill_assignment_role_definition();

-- 0074's guard, and the permissions' capabilities beside it. Trigger names
-- fire in order: `…_role_definition` fills the definition before `…_role_guard`.
CREATE OR REPLACE FUNCTION guard_assignment_role() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_runtime text;
BEGIN
  IF NOT NEW.enabled THEN RETURN NEW; END IF;
  SELECT runtime_type INTO v_runtime FROM runtime_profiles WHERE id=NEW.runtime_profile_id;
  IF NOT runtime_plays(v_runtime, NEW.assignment_role) THEN
    PERFORM refuse('runtime_cannot_play_role',
      format('runtime %s does not play the %s', COALESCE(v_runtime,'(none)'), NEW.assignment_role));
  END IF;
  IF NOT assignment_may(v_runtime, NEW.role_definition_id) THEN
    PERFORM refuse('role_permission_unsupported',
      format('runtime %s lacks a capability the role''s permissions need', COALESCE(v_runtime,'(none)')));
  END IF;
  RETURN NEW;
END $$;
ALTER FUNCTION guard_assignment_role() SET search_path=control_plane,public,extensions,pg_temp;
DROP TRIGGER project_agent_assignments_role_guard ON project_agent_assignments;
CREATE TRIGGER project_agent_assignments_role_guard
  BEFORE INSERT OR UPDATE OF runtime_profile_id, assignment_role, role_definition_id, enabled ON project_agent_assignments
  FOR EACH ROW EXECUTE FUNCTION guard_assignment_role();

-- What is assigned must already be right (as 0074 did for runtimes).
DO $$
DECLARE v_wrong text;
BEGIN
  SELECT string_agg(pa.id::text||' ('||rp.runtime_type||')', ', ') INTO v_wrong
  FROM project_agent_assignments pa JOIN runtime_profiles rp ON rp.id=pa.runtime_profile_id
  WHERE pa.enabled AND NOT assignment_may(rp.runtime_type, pa.role_definition_id);
  IF v_wrong IS NOT NULL THEN
    PERFORM refuse('role_permission_unsupported', 'enabled assignments whose runtime lacks a capability their role needs: '||v_wrong);
  END IF;
END $$;

-- A task's permissions, as they were when it got each assignment. First
-- capture wins: a later change to the definition never reaches a task in
-- flight (ADR-0017 §2).
CREATE TABLE task_role_snapshots (
  task_id uuid NOT NULL REFERENCES tasks(id),
  assignment_id uuid NOT NULL REFERENCES project_agent_assignments(id),
  role_definition_id uuid NOT NULL REFERENCES role_definitions(id),
  role_definition_version bigint NOT NULL,
  permissions text[] NOT NULL,
  captured_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (task_id, assignment_id)
);

CREATE FUNCTION snapshot_task_role(p_task_id uuid, p_assignment_id uuid) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path=control_plane,public,extensions,pg_temp AS $$
  INSERT INTO task_role_snapshots(task_id, assignment_id, role_definition_id, role_definition_version, permissions)
  SELECT p_task_id, pa.id, d.id, d.version,
    (SELECT array_agg(permission ORDER BY permission) FROM role_permissions WHERE role_definition_id=d.id)
  FROM project_agent_assignments pa JOIN role_definitions d ON d.id=pa.role_definition_id
  WHERE pa.id=p_assignment_id
  ON CONFLICT (task_id, assignment_id) DO NOTHING;
$$;

CREATE FUNCTION snapshot_task_roles() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path=control_plane,public,extensions,pg_temp AS $$
BEGIN
  IF TG_TABLE_NAME='tasks' THEN
    IF NEW.orchestrator_assignment_id IS NOT NULL THEN
      PERFORM snapshot_task_role(NEW.id, NEW.orchestrator_assignment_id);
    END IF;
  ELSE
    PERFORM snapshot_task_role(NEW.task_id, NEW.project_agent_assignment_id);
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER tasks_role_snapshot AFTER INSERT OR UPDATE OF orchestrator_assignment_id ON tasks
  FOR EACH ROW EXECUTE FUNCTION snapshot_task_roles();
CREATE TRIGGER task_executor_assignments_role_snapshot AFTER INSERT ON task_executor_assignments
  FOR EACH ROW EXECUTE FUNCTION snapshot_task_roles();

-- Every task there already is, from the built-ins it was run under.
SELECT snapshot_task_role(t.id, t.orchestrator_assignment_id) FROM tasks t WHERE t.orchestrator_assignment_id IS NOT NULL;
SELECT snapshot_task_role(te.task_id, te.project_agent_assignment_id) FROM task_executor_assignments te;

-- Nobody but the functions above reads or writes these; the workers and the
-- panel reach them through the functions R3 adds. The triggers run as their
-- owner, so a writer of assignments or tasks needs no grant on them.
REVOKE ALL ON role_permission_vocabulary, permission_capabilities, role_definitions, role_permissions, task_role_snapshots FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION role_definition_problems(uuid), assignment_may(text,uuid), snapshot_task_role(uuid,uuid),
  check_role_definition(), guard_builtin_role(), fill_assignment_role_definition(), snapshot_task_roles() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION assignment_may(text,uuid) TO infra_worker;
