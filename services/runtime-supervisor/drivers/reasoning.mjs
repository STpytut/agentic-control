// Reasoning levels: what a runtime calls them, how a run is told one, and the
// shape the catalog keeps them in (Stage 12, a reasoning level per team member;
// docs/REASONING_AND_LIMITS_RESEARCH.md).
//
// A level reaches a runtime two ways: as the value of an argv option (Claude
// Code's --effort, OpenCode's --variant) or as a JSON-RPC field (Codex's
// turn/start `effort`). Either way it is never a free string: the database
// accepts only a level the model's catalog entry lists, the catalog keeps only
// bounded tokens, and each driver checks the value again against its own
// allowed set before a launch is built. A token cannot begin with "-", so as an
// argv element it cannot be read as an option.
//
// Pure: the drivers, the supervisor and the catalog worker import it.

// The same pattern as the database's (0110, 0111).
export const REASONING_LEVEL = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const MAX_LEVELS = 16;
const MAX_DESCRIPTION = 300;

// A catalog entry's levels, as the refresh worker sends them to
// upsert_catalog_entries: `[{level, description?, default?}]`, bounded, in the
// runtime's order, each level once. `items` are names or objects whose level
// is under one of `levelKeys`; `defaultLevel` marks one of them.
export function catalogReasoningLevels(items, { levelKeys = ["level"], defaultLevel = null } = {}) {
  if (!Array.isArray(items)) return [];
  const seen = new Set();
  const out = [];
  for (const item of items) {
    const level = typeof item === "string" ? item
      : item && typeof item === "object" ? levelKeys.map((key) => item[key]).find((value) => typeof value === "string") : null;
    if (typeof level !== "string" || !REASONING_LEVEL.test(level) || seen.has(level)) continue;
    seen.add(level);
    const entry = { level };
    const description = typeof item?.description === "string" ? item.description.trim().slice(0, MAX_DESCRIPTION) : "";
    if (description) entry.description = description;
    if (level === defaultLevel) entry.default = true;
    out.push(entry);
    if (out.length >= MAX_LEVELS) break;
  }
  return out;
}

// A level for a launch, checked against the driver's allowed set: null for
// "send nothing" (the runtime's default), the level itself, or a refusal that
// names both. What the database stored is checked again here because a launch
// is built from it, and the check is the driver's: its runtime's wire values.
export function launchReasoningLevel(driver, level) {
  if (level === null || level === undefined || level === "") return null;
  const reasoning = driver.reasoning;
  if (typeof level !== "string" || !REASONING_LEVEL.test(level) || !reasoning?.accepts(level)) {
    throw Object.assign(new Error(`${driver.name} has no reasoning level ${JSON.stringify(String(level).slice(0, 80))}`), {
      code: "reasoning_effort_unsupported", retryable: false,
    });
  }
  return level;
}
