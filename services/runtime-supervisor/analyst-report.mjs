// An analyst's answer in a fixed shape (rc.142): a summary, findings that each
// name a file and line, and the questions it could not settle.
//
// Claude Code is held to it by `--json-schema` (its `StructuredOutput` tool;
// the result event's `structured_output`, seen on the host at 2.1.294). The
// shape reaches the orchestrator and the chat as text rendered here, so a
// runtime without a schema (OpenCode) answers in prose and both read the same
// way downstream. Whatever the model put in is bounded and checked by name.

export const ANALYST_REPORT_SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["summary", "findings", "open_questions"],
  properties: {
    summary: { type: "string", description: "The answer to the question, in a few sentences." },
    findings: {
      type: "array",
      description: "What the code shows, one claim each, with where it is.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["claim"],
        properties: {
          file: { type: "string", description: "Path relative to the repository root." },
          line: { type: "integer", minimum: 1 },
          claim: { type: "string" },
        },
      },
    },
    open_questions: { type: "array", items: { type: "string" }, description: "What the code does not settle." },
  },
});

const MAX_FINDINGS = 60;
const MAX_QUESTIONS = 20;
const clean = (value, max) => (typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, max) : "");
// A path as a code span: no backticks or line breaks inside it.
const path = (value) => clean(value, 300).replace(/`/g, "");

// The report as Markdown, or "" when there is nothing to render.
export function renderAnalystReport(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "";
  const summary = typeof value.summary === "string" ? value.summary.trim().slice(0, 8000) : "";
  const findings = (Array.isArray(value.findings) ? value.findings : []).slice(0, MAX_FINDINGS)
    .map((finding) => {
      const claim = clean(finding?.claim, 2000);
      if (!claim) return "";
      const file = path(finding?.file);
      const line = Number.isInteger(finding?.line) && finding.line > 0 ? finding.line : null;
      return file ? `- \`${file}${line ? `:${line}` : ""}\` — ${claim}` : `- ${claim}`;
    }).filter(Boolean);
  const questions = (Array.isArray(value.open_questions) ? value.open_questions : []).slice(0, MAX_QUESTIONS)
    .map((question) => clean(question, 1000)).filter(Boolean).map((question) => `- ${question}`);
  const parts = [summary,
    findings.length ? `**Findings**\n${findings.join("\n")}` : "",
    questions.length ? `**Open questions**\n${questions.join("\n")}` : ""].filter(Boolean);
  return parts.join("\n\n");
}
