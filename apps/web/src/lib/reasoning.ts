// A reasoning level per team member (Stage 12): the levels a model offers and
// the words the panel shows for them.
//
// Pure, no database import: the forms and the Team tab are client components.
// The levels are the catalog's (provider_model_catalog.reasoning_levels, 0110),
// so the panel never offers a level the database would refuse; "" is the
// runtime's default — nothing is sent — and is always an option.

export type ReasoningLevel = { level: string; description?: string };

export function reasoningLevelsFrom(value: unknown): ReasoningLevel[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (typeof item === "string") return item ? [{ level: item }] : [];
    if (item && typeof item === "object" && typeof (item as { level?: unknown }).level === "string") {
      const { level, description } = item as { level: string; description?: unknown };
      return [typeof description === "string" && description ? { level, description } : { level }];
    }
    return [];
  });
}

// "Default (medium)" when the catalog knows what the runtime defaults to.
export function defaultReasoningLabel(defaultLevel?: string | null) {
  return defaultLevel ? `Default (${defaultLevel})` : "Default";
}

// The level a member runs at, in words: its own, or the default's.
export function reasoningWords(level: string | null | undefined, defaultLevel?: string | null) {
  return level ? level : defaultReasoningLabel(defaultLevel).toLowerCase();
}
