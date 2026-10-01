// What the supervisor accepts from claude-models.mjs: model ids and names, or
// the reason there are none — checked here, because the probe holds the login
// and the supervisor passes on only what it has looked at.

export function checkClaudeModels(stdout) {
  let value;
  try { value = JSON.parse(String(stdout).trim().split("\n").at(-1) ?? ""); } catch { return { error: "unparsed" }; }
  if (typeof value?.error === "string") return { error: value.error.slice(0, 40) };
  if (!Array.isArray(value?.models)) return { error: "unparsed" };
  const models = value.models
    .filter((model) => /^claude-[a-z0-9][a-z0-9.-]{0,79}$/.test(String(model?.id ?? "")))
    .slice(0, 100)
    .map((model) => ({
      id: model.id,
      display_name: String(model.display_name ?? "").replace(/[^\p{L}\p{N} .()-]/gu, "").slice(0, 100),
      created_at: /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(String(model.created_at ?? "")) ? model.created_at : "",
    }));
  return { models };
}
