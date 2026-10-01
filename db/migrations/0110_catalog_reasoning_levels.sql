-- The reasoning levels each model supports, and its default (Stage 12: a
-- reasoning level per team member; docs/REASONING_AND_LIMITS_RESEARCH.md §4).
--
-- provider_model_catalog.reasoning_efforts has held a list of level names since
-- 0027, and resolve_catalog_snapshot_entry validates a chosen level against it.
-- It was empty for every runtime: Codex's `model/list` items are
-- `{reasoningEffort, description}` objects the worker read as `item.id`, OpenCode
-- never sends the key the worker looked for (its levels are a model's
-- `variants`), and Claude Code has no discovery at all. This keeps that column
-- the list of names — so the validation and every reader of it stay as they
-- are — and adds beside it what the panel needs to offer a level well:
--
--   reasoning_levels          [{level, description?}], in the runtime's order;
--   default_reasoning_effort  the level the runtime uses when none is sent, ''
--                             when the runtime does not say.
--
-- One trigger fills all three, whatever writes the row:
--
--   * a worker's entry may carry `reasoning_efforts` as objects
--     `{level, description?, default?}` (this release's refresh worker) or as
--     names (the previous release's); both are accepted by upsert_catalog_entries
--     unchanged, and the trigger reduces them to the three columns. A level is a
--     bounded token — it reaches a runtime's argv as the value of --variant or
--     --effort — and anything else is dropped here;
--   * a Claude row's levels are not the worker's to say. Claude Code has no
--     discovery API, and the alias a catalog row names resolves to whichever
--     model the subscription currently maps it to; so the levels come from the
--     documented table below, keyed on the model the row's check resolved
--     (resolved_model, 0098/0099), and change when that does. The same table is
--     declared in the Claude driver (drivers/claude.mjs, `reasoning.byModel`)
--     with its source; drivers.test.mjs holds the two equal.

SET search_path TO control_plane, public, extensions;

ALTER TABLE provider_model_catalog
  ADD COLUMN reasoning_levels jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(reasoning_levels) = 'array' AND jsonb_array_length(reasoning_levels) <= 16
           AND length(reasoning_levels::text) <= 8192),
  ADD COLUMN default_reasoning_effort text NOT NULL DEFAULT ''
    CHECK (length(default_reasoning_effort) <= 64);

-- Claude Code's effort levels by the model an alias resolved to.
--
-- Source: code.claude.com/docs/en/model-config § "Adjust effort level", read
-- 2026-09-29 for Claude Code 2.1.270. Fable 5/5.1, Opus 5.5/5, Sonnet 5.5/5 and
-- Opus 4.8/4.7 take low, medium, high, xhigh and max; Opus 4.6 and Sonnet 4.6
-- take low, medium, high and max; a model the table does not list (Haiku, older
-- families) takes none. The default is high, except Opus 5.5 and Sonnet 5.5
-- (medium) and Opus 4.7 (xhigh). `ultracode` is xhigh with a mode switched on,
-- not a level of its own, and is not offered.
--
-- A resolved id is `claude-<family>-<major>[-<minor>][-<date>]`: a one- or
-- two-digit part after the major is the minor version, an eight-digit one is a
-- date (claude-opus-4-20250514 is Opus 4).
CREATE FUNCTION claude_reasoning_levels(p_resolved_model text)
RETURNS jsonb
LANGUAGE plpgsql
IMMUTABLE
SET search_path TO control_plane, public, extensions, pg_temp
AS $$
DECLARE v_match text[]; v_family text; v_version text; v_row jsonb;
BEGIN
  v_match := regexp_match(lower(COALESCE(p_resolved_model,'')),
    '^claude-(opus|sonnet|haiku|fable)-([0-9]+)(?:-([0-9]{1,2}))?(?:$|[^0-9])');
  IF v_match IS NULL THEN
    RETURN jsonb_build_object('levels','[]'::jsonb,'default','');
  END IF;
  v_family := v_match[1];
  v_version := v_match[2] || COALESCE('.' || v_match[3], '');
  SELECT jsonb_build_object('levels', t.levels, 'default', t.default_level) INTO v_row
  FROM (VALUES
    ('fable',  '5',   '["low","medium","high","xhigh","max"]'::jsonb, 'high'),
    ('fable',  '5.1', '["low","medium","high","xhigh","max"]'::jsonb, 'high'),
    ('opus',   '5.5', '["low","medium","high","xhigh","max"]'::jsonb, 'medium'),
    ('opus',   '5',   '["low","medium","high","xhigh","max"]'::jsonb, 'high'),
    ('sonnet', '5.5', '["low","medium","high","xhigh","max"]'::jsonb, 'medium'),
    ('sonnet', '5',   '["low","medium","high","xhigh","max"]'::jsonb, 'high'),
    ('opus',   '4.8', '["low","medium","high","xhigh","max"]'::jsonb, 'high'),
    ('opus',   '4.7', '["low","medium","high","xhigh","max"]'::jsonb, 'xhigh'),
    ('opus',   '4.6', '["low","medium","high","max"]'::jsonb, 'high'),
    ('sonnet', '4.6', '["low","medium","high","max"]'::jsonb, 'high')
  ) AS t(family, version, levels, default_level)
  WHERE t.family = v_family AND t.version = v_version;
  RETURN COALESCE(v_row, jsonb_build_object('levels','[]'::jsonb,'default',''));
END $$;

-- The three columns from what was written. Objects are the whole answer —
-- descriptions and the default included; plain names (the previous release's
-- worker) keep the descriptions and the default already known for the levels
-- that are still listed.
CREATE FUNCTION normalize_catalog_reasoning()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO control_plane, public, extensions, pg_temp
AS $$
DECLARE
  v_input jsonb := CASE WHEN jsonb_typeof(NEW.reasoning_efforts) = 'array' THEN NEW.reasoning_efforts ELSE '[]'::jsonb END;
  v_objects boolean;
  v_item jsonb;
  v_level text;
  v_description text;
  v_names text[] := '{}';
  v_levels jsonb := '[]'::jsonb;
  v_default text := '';
  v_claude jsonb;
BEGIN
  IF NEW.runtime_type = 'claude' THEN
    v_claude := claude_reasoning_levels(NEW.resolved_model);
    NEW.reasoning_efforts := v_claude->'levels';
    NEW.reasoning_levels := COALESCE((SELECT jsonb_agg(jsonb_build_object('level', l.level) ORDER BY l.n)
      FROM jsonb_array_elements_text(v_claude->'levels') WITH ORDINALITY AS l(level, n)), '[]'::jsonb);
    NEW.default_reasoning_effort := COALESCE(v_claude->>'default', '');
    RETURN NEW;
  END IF;

  v_objects := EXISTS (SELECT 1 FROM jsonb_array_elements(v_input) e WHERE jsonb_typeof(e) = 'object');
  FOR v_item IN SELECT e FROM jsonb_array_elements(v_input) e LOOP
    v_description := NULL;
    IF jsonb_typeof(v_item) = 'string' THEN
      v_level := v_item #>> '{}';
    ELSIF jsonb_typeof(v_item) = 'object' THEN
      v_level := v_item->>'level';
      v_description := NULLIF(left(btrim(COALESCE(v_item->>'description', '')), 300), '');
    ELSE
      CONTINUE;
    END IF;
    IF v_level IS NULL OR v_level !~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'
       OR v_level = ANY (v_names) OR cardinality(v_names) >= 16 THEN
      CONTINUE;
    END IF;
    IF NOT v_objects AND TG_OP = 'UPDATE' THEN
      SELECT NULLIF(l->>'description', '') INTO v_description
      FROM jsonb_array_elements(OLD.reasoning_levels) l WHERE l->>'level' = v_level LIMIT 1;
    END IF;
    IF jsonb_typeof(v_item) = 'object' AND v_item->'default' = 'true'::jsonb THEN
      v_default := v_level;
    END IF;
    v_names := v_names || v_level;
    v_levels := v_levels || jsonb_build_array(jsonb_strip_nulls(
      jsonb_build_object('level', v_level, 'description', v_description)));
  END LOOP;
  IF NOT v_objects AND TG_OP = 'UPDATE' AND OLD.default_reasoning_effort = ANY (v_names) THEN
    v_default := OLD.default_reasoning_effort;
  END IF;

  NEW.reasoning_efforts := to_jsonb(v_names);
  NEW.reasoning_levels := v_levels;
  NEW.default_reasoning_effort := v_default;
  RETURN NEW;
END $$;

CREATE TRIGGER provider_model_catalog_reasoning
BEFORE INSERT OR UPDATE OF reasoning_efforts, resolved_model, runtime_type ON provider_model_catalog
FOR EACH ROW EXECUTE FUNCTION normalize_catalog_reasoning();

-- A default is one of the levels.
ALTER TABLE provider_model_catalog
  ADD CONSTRAINT provider_model_catalog_default_reasoning_listed
  CHECK (default_reasoning_effort = '' OR reasoning_efforts ? default_reasoning_effort);

-- The rows already there: their names become levels, and every Claude row takes
-- the table's answer for the model its last check resolved.
UPDATE provider_model_catalog SET reasoning_efforts = reasoning_efforts;

REVOKE EXECUTE ON FUNCTION claude_reasoning_levels(text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION normalize_catalog_reasoning() FROM PUBLIC;
