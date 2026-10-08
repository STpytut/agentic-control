// A map of a project's repository, for the orchestrator's first turn (0146).
//
// A new chat is a new orchestrator session, and a new session knew nothing of
// the project: it listed directories, opened package.json and the README, and
// read the log — the same dozen commands in every chat, before the first word
// about the task, paid for in tokens and minutes. The platform knows these
// facts already, cheaply and without a model: they are in the last commit.
//
// So the supervisor builds them from HEAD — never the working tree, so the map
// names a commit and is the same for everyone who reads that commit — as the
// workspace's owner (`runGit`, like workspace-sync.mjs), after every
// implementation, every sync with GitHub and every provisioning. The
// orchestrator is told the map once, at the start of its session
// (turn-prompts.mjs), and reads the files themselves when the task needs them.
//
// Everything here is data written by the project, bounded in size and never
// interpreted: no file's content decides what else is read.
// `runGit(args)` resolves to { code, stdout: Buffer|string, stderr }.

const text = (output) => String(Buffer.isBuffer(output) ? output.toString("utf8") : output ?? "");
const SHA = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

export const MAP_VERSION = 1;
const LIMITS = {
  treeLines: 140, treeChars: 6000, namesPerLine: 10,
  commits: 10, subjectChars: 120,
  blobBytes: 256 * 1024, readmeChars: 1500, manifestChars: 1500, manifestsChars: 4000,
  nestedPackages: 6, dependencies: 40, scriptChars: 160,
};

// Directories that are generated or vendored: counted, never listed.
const COLLAPSED = new Set(["node_modules", "vendor", "dist", "build", "out", ".next", "coverage", "target", "__pycache__", ".venv", "venv"]);

const LANGUAGES = {
  ts: "TypeScript", tsx: "TypeScript", mts: "TypeScript", cts: "TypeScript",
  js: "JavaScript", jsx: "JavaScript", mjs: "JavaScript", cjs: "JavaScript",
  py: "Python", rb: "Ruby", go: "Go", rs: "Rust", java: "Java", kt: "Kotlin", kts: "Kotlin",
  swift: "Swift", m: "Objective-C", c: "C", h: "C/C++ header", cc: "C++", cpp: "C++", hpp: "C++",
  cs: "C#", fs: "F#", php: "PHP", scala: "Scala", ex: "Elixir", exs: "Elixir", erl: "Erlang",
  dart: "Dart", lua: "Lua", r: "R", jl: "Julia", hs: "Haskell", clj: "Clojure", zig: "Zig",
  vue: "Vue", svelte: "Svelte", astro: "Astro", html: "HTML", css: "CSS", scss: "SCSS", less: "Less",
  sql: "SQL", sh: "Shell", bash: "Shell", zsh: "Shell", ps1: "PowerShell",
  md: "Markdown", mdx: "Markdown", json: "JSON", yaml: "YAML", yml: "YAML", toml: "TOML", xml: "XML",
  tf: "Terraform", proto: "Protocol Buffers", graphql: "GraphQL", gql: "GraphQL",
};

// Read whole, at the root (package.json only, one or two levels down too).
const ROOT_MANIFESTS = ["package.json", "pyproject.toml", "requirements.txt", "Cargo.toml", "go.mod", "Gemfile",
  "composer.json", "pom.xml", "build.gradle", "build.gradle.kts", "Package.swift", "mix.exs", "pubspec.yaml",
  "deno.json", "Makefile", "justfile", "docker-compose.yml", "compose.yaml", "Dockerfile"];
// Named, not read: the runtimes load their own, and the orchestrator is told
// they exist so it reads them before planning.
const INSTRUCTION_FILES = ["AGENTS.md", "CLAUDE.md", "GEMINI.md", ".cursorrules", ".github/copilot-instructions.md", "CONTRIBUTING.md"];

// No NUL (jsonb refuses it) and no other control characters but newline and tab.
const clean = (value) => String(value).replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "");
// A name on one line: a path or a branch may hold a newline.
const cleanName = (value) => String(value).replace(/[\u0000-\u001f\u007f]/g, "?");
const cut = (value, limit) => (value.length > limit ? `${value.slice(0, limit).trimEnd()}…` : value);

export function languageOf(file) {
  const name = file.slice(file.lastIndexOf("/") + 1);
  if (name === "Dockerfile") return "Dockerfile";
  if (name === "Makefile") return "Makefile";
  const dot = name.lastIndexOf(".");
  return dot > 0 ? LANGUAGES[name.slice(dot + 1).toLowerCase()] ?? null : null;
}

// `git ls-tree -r -l -z HEAD`: "<mode> <type> <oid> <size>\t<path>\0".
export function parseTree(output) {
  return text(output).split("\0").filter(Boolean).flatMap((record) => {
    const tab = record.indexOf("\t");
    if (tab < 0) return [];
    const [mode, type, oid, size] = record.slice(0, tab).trim().split(/\s+/);
    if (type !== "blob") return [];
    return [{ mode, oid, size: Number(size) || 0, path: record.slice(tab + 1) }];
  });
}

export function languageSummary(files) {
  const counts = new Map();
  for (const file of files) {
    const language = languageOf(file.path);
    if (language && !file.path.split("/").some((part) => COLLAPSED.has(part))) counts.set(language, (counts.get(language) ?? 0) + 1);
  }
  return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 8).map(([name, files]) => ({ name, files }));
}

function nodeOf() { return { files: [], dirs: new Map(), count: 0 }; }

function buildNodes(paths) {
  const root = nodeOf();
  for (const file of paths) {
    const parts = file.split("/");
    let node = root;
    node.count += 1;
    for (const part of parts.slice(0, -1)) {
      if (!node.dirs.has(part)) node.dirs.set(part, nodeOf());
      node = node.dirs.get(part);
      node.count += 1;
    }
    node.files.push(parts.at(-1));
  }
  return root;
}

const fileNoun = (count) => `${count} file${count === 1 ? "" : "s"}`;

function namesLine(names, indent) {
  const sorted = [...names].sort();
  const shown = sorted.slice(0, LIMITS.namesPerLine);
  const more = sorted.length - shown.length;
  return `${indent}${shown.join(", ")}${more > 0 ? `, … (+${more})` : ""}`;
}

function renderNode(node, depth, maxDepth, indent, lines) {
  for (const [name, child] of [...node.dirs].sort((a, b) => a[0].localeCompare(b[0]))) {
    // A chain of directories that only hold one directory reads as one path.
    let label = name;
    let target = child;
    while (!target.files.length && target.dirs.size === 1 && !COLLAPSED.has(label.split("/").at(-1))) {
      const [next, inner] = [...target.dirs][0];
      label += `/${next}`;
      target = inner;
    }
    const collapsed = COLLAPSED.has(label.split("/").at(-1));
    lines.push(`${indent}${label}/ (${fileNoun(target.count)}${collapsed ? ", not listed" : ""})`);
    if (!collapsed && depth < maxDepth) renderNode(target, depth + 1, maxDepth, `${indent}  `, lines);
  }
  if (node.files.length) lines.push(namesLine(node.files, indent));
}

// The layout as indented text, as deep as fits: the deepest rendering within
// the line and character budgets, and at worst the top level alone.
export function renderTree(paths) {
  const root = buildNodes(paths);
  let fallback = [];
  for (let maxDepth = 5; maxDepth >= 0; maxDepth -= 1) {
    const lines = [];
    renderNode(root, 0, maxDepth, "", lines);
    const rendered = lines.join("\n");
    if (lines.length <= LIMITS.treeLines && rendered.length <= LIMITS.treeChars) return { tree: rendered, depth: maxDepth, truncated: false };
    fallback = lines;
  }
  return { tree: cut(fallback.slice(0, LIMITS.treeLines).join("\n"), LIMITS.treeChars), depth: 0, truncated: true };
}

// package.json as the facts an orchestrator asks of it: what it is called, how
// it runs, and what it is built on. Versions are left out; names say enough.
export function summarizePackageJson(source, { nested = false } = {}) {
  let manifest;
  try { manifest = JSON.parse(source); } catch { return "not valid JSON"; }
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) return "not a JSON object";
  const lines = [];
  if (typeof manifest.name === "string") lines.push(`name: ${cut(cleanName(manifest.name), 100)}`);
  if (!nested && typeof manifest.description === "string") lines.push(`description: ${cut(cleanName(manifest.description), 200)}`);
  if (!nested && manifest.type === "module") lines.push("type: module");
  const scripts = manifest.scripts && typeof manifest.scripts === "object" ? Object.entries(manifest.scripts) : [];
  if (scripts.length) {
    lines.push("scripts:", ...scripts.filter(([, command]) => typeof command === "string").slice(0, 30)
      .map(([name, command]) => `  ${cut(cleanName(name), 60)}: ${cut(cleanName(command), LIMITS.scriptChars)}`));
  }
  if (!nested) {
    for (const field of ["dependencies", "devDependencies"]) {
      const names = manifest[field] && typeof manifest[field] === "object" ? Object.keys(manifest[field]) : [];
      if (names.length) {
        const shown = names.slice(0, LIMITS.dependencies).map((name) => cut(cleanName(name), 80));
        lines.push(`${field}: ${shown.join(", ")}${names.length > shown.length ? `, … (+${names.length - shown.length})` : ""}`);
      }
    }
    const workspaces = Array.isArray(manifest.workspaces) ? manifest.workspaces : manifest.workspaces?.packages;
    if (Array.isArray(workspaces) && workspaces.length) lines.push(`workspaces: ${workspaces.slice(0, 20).map((item) => cut(cleanName(item), 80)).join(", ")}`);
  }
  return lines.join("\n") || "(empty)";
}

// The start of a text file, whole lines, without the blank ones it opens with.
export function excerpt(source, limit) {
  const body = clean(source).replace(/^\s*\n/, "").trimEnd();
  if (body.length <= limit) return body;
  const head = body.slice(0, limit);
  const lineEnd = head.lastIndexOf("\n");
  return `${(lineEnd > limit / 2 ? head.slice(0, lineEnd) : head).trimEnd()}\n…`;
}

const looksBinary = (buffer) => buffer.subarray(0, 8000).includes(0);

export async function buildRepositoryMap({ runGit }) {
  const git = async (args) => runGit(["-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", ...args]);
  const headAnswer = await git(["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]);
  const head = headAnswer.code === 0 ? text(headAnswer.stdout).trim() : "";
  // A repository with no commit has nothing a map could name.
  if (!SHA.test(head)) return null;
  const branchAnswer = await git(["symbolic-ref", "--quiet", "--short", "HEAD"]);
  const branch = branchAnswer.code === 0 ? cut(cleanName(text(branchAnswer.stdout).trim()), 200) : null;

  const listed = await git(["ls-tree", "-r", "-l", "-z", "--full-tree", head]);
  if (listed.code !== 0) throw new Error(`listing ${head}: ${text(listed.stderr).slice(0, 200)}`);
  const files = parseTree(listed.stdout);
  const byPath = new Map(files.map((file) => [file.path, file]));
  const { tree, truncated } = renderTree(files.map((file) => cleanName(file.path)));

  const read = async (file) => {
    if (!file || file.size > LIMITS.blobBytes || file.mode === "120000") return null;
    const blob = await git(["cat-file", "blob", file.oid]);
    if (blob.code !== 0) return null;
    const buffer = Buffer.isBuffer(blob.stdout) ? blob.stdout : Buffer.from(String(blob.stdout));
    return looksBinary(buffer) ? null : buffer.toString("utf8");
  };

  const manifests = [];
  let manifestChars = 0;
  const addManifest = (path, summary) => {
    const bounded = cut(summary, LIMITS.manifestChars);
    if (manifestChars + bounded.length > LIMITS.manifestsChars) return false;
    manifestChars += bounded.length;
    manifests.push({ path: cleanName(path), summary: bounded });
    return true;
  };
  for (const name of ROOT_MANIFESTS) {
    const source = await read(byPath.get(name));
    if (source === null) continue;
    addManifest(name, name === "package.json" ? summarizePackageJson(source) : excerpt(source, 800));
  }
  // A monorepo's packages: their names and how each runs, nothing more.
  const nested = files.filter((file) => /^[^/]+\/(?:[^/]+\/)?package\.json$/.test(file.path)
    && !file.path.split("/").some((part) => COLLAPSED.has(part))).slice(0, LIMITS.nestedPackages);
  for (const file of nested) {
    const source = await read(file);
    if (source !== null && !addManifest(file.path, summarizePackageJson(source, { nested: true }))) break;
  }

  const readmeFile = files.find((file) => /^readme(\.(md|markdown|rst|txt))?$/i.test(file.path));
  const readmeSource = await read(readmeFile);
  const readme = readmeSource === null ? null : { path: cleanName(readmeFile.path), excerpt: excerpt(readmeSource, LIMITS.readmeChars) };

  const log = await git(["log", "--no-show-signature", "--no-color", "-n", String(LIMITS.commits), "--format=%h%x09%cs%x09%s", head]);
  const commits = log.code !== 0 ? [] : text(log.stdout).split("\n").filter(Boolean).map((line) => {
    const [sha, date, ...subject] = line.split("\t");
    return { sha, date, subject: cut(cleanName(subject.join(" ")), LIMITS.subjectChars) };
  });

  return {
    version: MAP_VERSION,
    head_sha: head,
    branch,
    files_total: files.length,
    languages: languageSummary(files),
    tree,
    tree_truncated: truncated,
    manifests,
    readme,
    instructions: INSTRUCTION_FILES.filter((name) => byPath.has(name)),
    commits,
  };
}
