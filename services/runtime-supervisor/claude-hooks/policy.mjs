// The platform's policy for an executor's Claude Code run (rc.144): a
// PreToolUse hook, given through `--settings` by the driver, that refuses
// what would break how the platform publishes work — before the tool runs, with
// a reason the model reads.
//
// It is a belt, not the boundary. The sandbox is the boundary: Bash runs in
// bubblewrap with the login covered (Stage 12 M0), the files the runtime keeps
// are behind permission rules, and nothing here is needed for either. What the
// sandbox cannot know is the platform's workflow: the approved commit is
// published by the platform from this branch and its base (0150), so pushing,
// rewriting history, switching branches, changing the commit identity or
// writing git's own hooks would each make the review or the publish fail —
// or, for a git hook, run the model's code later in another step. A command
// built to slip past these patterns can; the patterns catch the ordinary ways
// a model does these things, and tell it why not.
//
// Shown on the host at 2.1.294: hooks from `--settings` run under
// `--setting-sources user`; a repository's own `.claude/settings.json` hook
// does not; a subagent's Bash is checked too; a deny reaches the model as the
// tool's error. A hook that fails is not a deny to Claude Code, so this one
// refuses when it cannot read its input.

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

// The tools the hook is registered for, as Claude Code's matcher reads them.
export const POLICY_TOOLS = Object.freeze(["Bash", "Edit", "Write", "MultiEdit", "NotebookEdit"]);

// A command line as its simple commands, each a list of words, the way the
// shell would run them: quotes and backslashes honoured, so a commit message
// that mentions `git push` is one word, not a command; a heredoc's body is
// data and skipped; `$( … )` and backquotes are commands of their own, inside
// double quotes too, because the shell runs them. It reads commands; it never
// runs them, and a command built to defeat it can.
export function simpleCommands(command) {
  const text = String(command ?? "");
  const out = [];
  const frames = [{ words: [], word: null, quote: null, close: null }];
  const heredocs = [];
  const top = () => frames.at(-1);
  const endWord = (frame = top()) => { if (frame.word !== null) frame.words.push(frame.word); frame.word = null; };
  const endCommand = (frame = top()) => { endWord(frame); if (frame.words.length) out.push(frame.words); frame.words = []; };
  const add = (ch, frame = top()) => { frame.word = (frame.word ?? "") + ch; };
  for (let i = 0; i < text.length; i += 1) {
    const frame = top();
    const ch = text[i];
    if (frame.quote === "'") { if (ch === "'") frame.quote = null; else add(ch); continue; }
    if (ch === "\\") { if (i + 1 < text.length && text[i + 1] !== "\n") add(text[i + 1]); i += 1; continue; }
    if (ch === "$" && text[i + 1] === "(" && text[i + 2] !== "(") {
      add("$"); frames.push({ words: [], word: null, quote: null, close: ")" }); i += 1; continue;
    }
    if (ch === "`") {
      if (frame.close === "`") { endCommand(); frames.pop(); } else { add("`"); frames.push({ words: [], word: null, quote: null, close: "`" }); }
      continue;
    }
    if (frame.quote === '"') { if (ch === '"') frame.quote = null; else add(ch); continue; }
    if (ch === "'" || ch === '"') { frame.quote = ch; add(""); continue; }
    if (ch === ")" && frame.close === ")") { endCommand(); frames.pop(); continue; }
    if (ch === "<" && text[i + 1] === "<" && text[i + 2] !== "<") {
      const match = /^<<(-?)\s*(['"]?)([A-Za-z0-9_.-]+)\2/.exec(text.slice(i));
      if (match) { heredocs.push({ tabs: match[1] === "-", end: match[3] }); i += match[0].length - 1; continue; }
    }
    if (ch === "\n") {
      endCommand();
      while (heredocs.length) {
        const doc = heredocs.shift();
        let next = text.indexOf("\n", i + 1);
        for (;;) {
          const lineEnd = next === -1 ? text.length : next;
          const line = text.slice(i + 1, lineEnd);
          i = lineEnd;
          if ((doc.tabs ? line.replace(/^\t+/, "") : line) === doc.end || next === -1) break;
          next = text.indexOf("\n", i + 1);
        }
      }
      continue;
    }
    if (/\s/.test(ch)) { endWord(); continue; }
    if (";&|(){}".includes(ch)) { endCommand(); continue; }
    add(ch);
  }
  while (frames.length) { endCommand(); frames.pop(); }
  return out.flatMap(unwrap).filter((words) => words.length > 0);
}

const RESERVED = new Set(["if", "then", "else", "elif", "fi", "do", "done", "while", "until", "!", "time", "case", "esac", "in", "for", "select"]);
const SHELLS = new Set(["bash", "sh", "zsh", "dash", "ksh"]);

// The command a simple command runs: past assignments, reserved words and the
// wrappers that run what follows them; a shell's `-c` string is read in turn.
function unwrap(words) {
  let rest = [...words];
  for (let guard = 0; guard < 20 && rest.length; guard += 1) {
    const head = path.basename(rest[0]);
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(rest[0]) || RESERVED.has(head)) { rest = rest.slice(1); continue; }
    if (["command", "exec", "nohup", "builtin"].includes(head)) { rest = rest.slice(1); continue; }
    if (["env", "nice", "sudo", "doas", "stdbuf", "ionice", "xargs", "timeout"].includes(head)) {
      let index = 1;
      while (index < rest.length && (rest[index].startsWith("-") || /^[A-Za-z_][A-Za-z0-9_]*=/.test(rest[index]))) {
        index += /^-(n|u|s|i|o|e|I|L|P|k|d)$/.test(rest[index]) && head !== "env" ? 2 : head === "env" && rest[index] === "-u" ? 2 : 1;
      }
      if (head === "timeout" && index < rest.length) index += 1;
      rest = rest.slice(index);
      continue;
    }
    if (SHELLS.has(head)) {
      const flag = rest.findIndex((word, index) => index > 0 && /^-[a-z]*c[a-z]*$/.test(word));
      return flag > 0 && rest[flag + 1] !== undefined ? simpleCommands(rest[flag + 1]) : [rest];
    }
    break;
  }
  return [rest];
}

// `git [-C dir] [-c k=v] [--git-dir=…] <subcommand> args…` → [subcommand, args].
function gitInvocation(words) {
  if (path.basename(words[0] ?? "") !== "git") return null;
  let index = 1;
  while (index < words.length && words[index].startsWith("-")) {
    const option = words[index];
    index += ["-C", "-c", "--git-dir", "--work-tree", "--namespace"].includes(option) ? 2 : 1;
  }
  return index < words.length ? { sub: words[index], args: words.slice(index + 1), options: words.slice(1, index) } : null;
}

const CONFIG_READS = new Set(["--get", "--get-all", "--get-regexp", "--list", "-l", "--show-origin", "--show-scope", "--get-urlmatch"]);
const RESET_MODES = new Set(["--hard", "--soft", "--mixed", "--keep", "--merge"]);
const REASON = Object.freeze({
  push: "The platform publishes the approved commit itself; do not push. Commit on the current branch and report.",
  remote: "The platform owns this repository's remotes; do not add, change or remove them.",
  config: "The platform sets the commit identity and git's settings for this run; do not change git config or the author.",
  history: "The platform reviews and publishes this branch from its base: do not rewrite history (rebase, amend, reset to another commit, filter). Make a new commit instead.",
  branch: "The platform publishes from the current branch: stay on it — do not create, switch, rename or delete branches or tags.",
  hooks: "Git hooks are not the work: do not write or point to git hooks.",
  gitdir: "Do not write inside .git: change the project's files and commit them.",
  outside: "Write only inside the workspace (or /tmp): the platform reviews and publishes the workspace alone.",
});

// The workspace a call is judged against: the repository the run's working
// directory is in — a `cd` into a subdirectory must not make the rest of the
// tree "outside".
function workspaceOf(cwd, exists) {
  for (let dir = cwd; ; dir = path.dirname(dir)) {
    if (exists(path.join(dir, ".git"))) return dir;
    if (path.dirname(dir) === dir) return cwd;
  }
}

const nonOptions = (args) => {
  const end = args.indexOf("--");
  return (end === -1 ? args : args.slice(0, end)).filter((arg) => !arg.startsWith("-"));
};

function gitRefusal({ sub, args, options }, { cwd, exists }) {
  const isPath = (arg) => arg === "." || exists(path.resolve(cwd, arg));
  if (options.some((option) => /hookspath/i.test(option))) return REASON.hooks;
  if (options.some((option) => /^(user|author|committer)\./i.test(option))) return REASON.config;
  if (sub === "push" || sub === "send-pack") return REASON.push;
  if (sub === "remote" && args.some((arg) => ["add", "set-url", "remove", "rm", "rename", "set-head", "set-branches"].includes(arg))) return REASON.remote;
  if (sub === "config") {
    if (args.some((arg) => /hookspath/i.test(arg)) && nonOptions(args).length >= 2) return REASON.hooks;
    if (!args.some((arg) => CONFIG_READS.has(arg)) && nonOptions(args).length >= 2) return REASON.config;
    if (args.some((arg) => ["--unset", "--unset-all", "--add", "--replace-all", "--rename-section", "--remove-section", "--edit", "-e"].includes(arg))) return REASON.config;
  }
  if (["rebase", "filter-branch", "filter-repo", "update-ref", "replace", "symbolic-ref"].includes(sub)) return REASON.history;
  if (sub === "commit" && args.some((arg) => arg === "--amend" || arg.startsWith("--author") || arg.startsWith("--reset-author"))) {
    return args.includes("--amend") ? REASON.history : REASON.config;
  }
  if (sub === "pull" && args.some((arg) => arg === "--rebase" || arg === "-r" || arg.startsWith("--rebase="))) return REASON.history;
  if (sub === "reset") {
    const target = nonOptions(args)[0];
    if (target && target !== "HEAD" && !(args.indexOf("--") === -1 && !args.some((arg) => RESET_MODES.has(arg)) && isPath(target))) return REASON.history;
  }
  if (sub === "switch") return REASON.branch;
  if (sub === "stash" && args[0] === "branch") return REASON.branch;
  if (sub === "checkout") {
    if (args.some((arg) => ["-b", "-B", "--orphan", "--detach"].includes(arg))) return REASON.branch;
    const target = nonOptions(args)[0];
    if (target && target !== "HEAD" && !args.includes("--") && !isPath(target)) return REASON.branch;
  }
  if (sub === "branch") {
    if (args.some((arg) => /^-[a-zA-Z]*[dDmMcCf]/.test(arg) || ["--delete", "--move", "--copy", "--force", "--set-upstream-to", "-u"].includes(arg))) return REASON.branch;
    if (nonOptions(args).length > 0 && !args.some((arg) => ["--list", "-l", "--contains", "--merged", "--no-merged", "--points-at"].includes(arg))) return REASON.branch;
  }
  if (sub === "tag") {
    if (args.some((arg) => ["-d", "--delete", "-a", "-s", "-f", "--force", "-m", "-F"].includes(arg))) return REASON.branch;
    if (nonOptions(args).length > 0 && !args.some((arg) => ["-l", "--list", "--contains", "--points-at", "--merged", "--no-merged"].includes(arg))) return REASON.branch;
  }
  return null;
}

// A shell command that writes into `.git`: a redirect, or a command that
// writes, naming a path inside it. Reading there is not refused.
const WRITERS = new Set(["cp", "mv", "tee", "ln", "install", "chmod", "touch", "rm", "dd", "truncate", "rsync"]);
function gitDirWrite(words) {
  const inside = (word) => /(^|[\\/=>])\.git([\\/]|$)/.test(word);
  const head = path.basename(words[0] ?? "");
  const redirect = words.some((word, index) => (/^\d*>>?/.test(word) && inside(word))
    || (/^\d*>>?$/.test(word) && inside(words[index + 1] ?? "")));
  const sedInPlace = head === "sed" && words.some((word) => /^-i/.test(word) || word === "--in-place");
  if (!redirect && !((WRITERS.has(head) || sedInPlace) && words.slice(1).some(inside))) return null;
  return words.some((word) => /\.git[\\/]+hooks/.test(word)) ? REASON.hooks : REASON.gitdir;
}

const IDENTITY = /^GIT_(AUTHOR|COMMITTER)_(NAME|EMAIL|DATE)=/;

// Inside `.git`, by any path segment.
const inGitDir = (file) => file.split(/[\\/]+/).includes(".git");

function fileRefusal(file, workspace) {
  if (typeof file !== "string" || !file) return null;
  const absolute = path.resolve(workspace, file);
  if (inGitDir(path.relative(workspace, absolute)) || inGitDir(file)) return /[\\/]hooks([\\/]|$)/.test(absolute) ? REASON.hooks : REASON.gitdir;
  const inside = (root) => absolute === root || absolute.startsWith(`${root}${path.sep}`);
  if (!inside(path.resolve(workspace)) && !inside("/tmp")) return REASON.outside;
  return null;
}

// The decision for one tool call: a reason to refuse it, or null. `exists`
// is the file system's answer, injectable for tests.
export function policyDecision(input, { exists = existsSync } = {}) {
  const tool = input?.tool_name;
  const toolInput = input?.tool_input && typeof input.tool_input === "object" ? input.tool_input : {};
  const cwd = typeof input?.cwd === "string" && path.isAbsolute(input.cwd) ? input.cwd : null;
  if (tool === "Bash") {
    const command = typeof toolInput.command === "string" ? toolInput.command : "";
    if (/(^|[\s;&|])[A-Z_]*GIT_(AUTHOR|COMMITTER)_(NAME|EMAIL|DATE)=/.test(command) && /\bgit\b/.test(command)) return REASON.config;
    for (const words of simpleCommands(command)) {
      const git = gitInvocation(words);
      const reason = (git && gitRefusal(git, { cwd: cwd ?? "/", exists })) || gitDirWrite(words)
        || (words.some((word) => IDENTITY.test(word)) ? REASON.config : null);
      if (reason) return reason;
    }
    return null;
  }
  if (["Edit", "Write", "MultiEdit", "NotebookEdit"].includes(tool)) {
    if (!cwd) return "The run's working directory is unknown, so this write is refused.";
    return fileRefusal(toolInput.file_path ?? toolInput.notebook_path, workspaceOf(cwd, exists));
  }
  return null;
}

// Claude Code's answer for a PreToolUse hook.
export function hookAnswer(reason) {
  return reason ? { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } } : {};
}

export function runHook({ read = () => readFileSync(0, "utf8"), write = (text) => process.stdout.write(text) } = {}) {
  let reason;
  try {
    reason = policyDecision(JSON.parse(read()));
  } catch {
    reason = "The platform's policy check could not read this tool call, so it is refused.";
  }
  write(JSON.stringify(hookAnswer(reason)));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) runHook();
