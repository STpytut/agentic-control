// What Codex's review mode answers, read into findings (rc.145).
//
// `codex exec review --json` (0.160 on the host) ends with one agent message:
// a verdict, then "Review comment:" or "Full review comments:" and a list —
//
//   - [P1] Stop the loop before reaching xs.length — /tmp/x/repo/avg.js:3-3
//     For any nonempty numeric array, the final iteration reads …
//
// Each item is a priority, a title, a location, and the lines under it. The
// location is a path in the scratch repository the run read, made relative to
// it here. A review in another shape keeps its text and has no findings; the
// text is what the chat shows either way.

const ITEM = /^- \[P([0-3])\]\s+(.+?)\s+[—–-]\s+(\S.*?):(\d+)(?:-(\d+))?\s*$/;
const MAX_FINDINGS = 50;

const clean = (text, max) => String(text ?? "").replace(/\s+/g, " ").trim().slice(0, max);

// `root` is the scratch repository's path; paths under it become relative, and
// a path outside it is kept only by its last segment.
export function relativeTo(root, file) {
  const prefix = `${String(root ?? "").replace(/\/+$/, "")}/`;
  const value = String(file ?? "");
  if (root && value.startsWith(prefix)) return value.slice(prefix.length);
  return value.startsWith("/") ? value.split("/").at(-1) : value;
}

export function parseReview(text, { root = "" } = {}) {
  const lines = String(text ?? "").split("\n");
  const findings = [];
  let current = null;
  for (const line of lines) {
    const match = ITEM.exec(line.trim());
    if (match && line.startsWith("- ")) {
      if (findings.length >= MAX_FINDINGS) break;
      current = {
        priority: `P${match[1]}`, title: clean(match[2], 300), file: clean(relativeTo(root, match[3]), 300),
        line: Number(match[4]), end_line: Number(match[5] ?? match[4]), body: "",
      };
      findings.push(current);
    } else if (current && /^\s+\S/.test(line)) {
      current.body = clean(`${current.body} ${line}`, 2000);
    } else if (current && line.trim() === "") {
      continue;
    } else {
      current = null;
    }
  }
  const root_ = String(root ?? "").replace(/\/+$/, "");
  const review = root_ ? String(text ?? "").split(`${root_}/`).join("") : String(text ?? "");
  return { review: review.trim().slice(0, 32000), findings };
}

// The review as it is posted on the pull request: one comment, said to be the
// platform's and the model's, with the commit it read.
export function reviewComment({ review, model, headSha }) {
  const sha = /^[0-9a-f]{7,64}$/.test(String(headSha ?? "")) ? String(headSha).slice(0, 12) : "";
  return [
    String(review ?? "").trim(),
    "",
    `<sub>Review by Codex${model ? ` (${String(model).slice(0, 80)})` : ""} through Agentic Control${sha ? `, at ${sha}` : ""}. Posted by the project's owner.</sub>`,
  ].join("\n").slice(0, 60000);
}
