// A role's instructions apart from the message (rc.143): the driver says where
// they go — a system prompt where the runtime has one. Bounded like a prompt,
// and never something an option parser could take for a flag: Claude Code's
// `--append-system-prompt` would read a leading "-" as the next option.
export const SYSTEM_PROMPT_MAX = 32 * 1024;

export function systemPromptOf(request) {
  const value = request?.system_prompt;
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || value.length > SYSTEM_PROMPT_MAX) throw new Error("system prompt length is invalid");
  const text = value.trim();
  if (text.startsWith("-")) throw new Error("a system prompt may not begin with a dash");
  return text || null;
}
