// What goes into a release, decided by an allowlist and then proved by an import
// closure.
//
// The payload is never produced by copying the repository and deleting what looks
// wrong. A blacklist fails in the direction that matters: a file nobody thought
// about — a stray `.env.local`, a PEM the developer forgot, a fixture with a real
// token in it — is included by default and only noticed if someone looks. An
// allowlist fails loudly instead: the builder refuses to produce a tree whose
// contents it cannot explain.
//
// The allowlist below names directories and files. That is necessary but not
// sufficient, because a directory contains whatever a previous session left in it.
// So the service half of the payload is additionally derived from the real entry
// points the systemd units start: everything transitively imported by those entry
// points, and nothing else. A file that is not reachable from an entry point is
// not in the release regardless of which directory it sits in, which is what
// keeps `test/`, `run-db-tests.mjs` and future scratch scripts out without a
// per-file exclusion list that has to be maintained forever.

import { existsSync, lstatSync, readdirSync, readFileSync, readlinkSync, realpathSync } from "node:fs";
import path from "node:path";

export class PayloadError extends Error {
  constructor(message) {
    super(message);
    this.name = "PayloadError";
  }
}

// Top-level layout of the unpacked release. Every entry here is created by the
// builder; anything not listed is a bug in the builder, and the structural test
// asserts the produced tree matches exactly.
export const TOP_LEVEL_DIRECTORIES = ["services", "node_modules", "db", "deploy", "web"];
export const TOP_LEVEL_FILES = ["manifest.json", "FILESUMS.sha256"];

// Service source roots, copied wholesale minus test directories and anything not
// in the entry-point closure.
export const SERVICE_DIRECTORIES = ["cli", "control-plane", "operations", "runtime-supervisor"];

// Files that live in a shipped service directory but are not part of what a unit
// starts. Each one is named with the reason it is safe to leave behind, and the
// exclusion is *verified* rather than asserted: `selectServicePayload` refuses to
// omit a file that any production entry point can reach, and the import graph has
// to explain every remaining candidate, so a rename or a new import turns this
// list into a build failure instead of a missing module on the target host.
//
// `run-db-tests.mjs` drives `db/tests`, which is not shipped.
// `policy-smoke.mjs` and `socket-access-smoke.mjs` need a live supervisor socket.
// `opencode-tools/*.ts` used to be listed here, as "PoC tool definition; not
// importable at runtime". The reasoning was half right and the conclusion was
// wrong: nothing under `services/` imports them and the target has no TypeScript
// toolchain — but the code that loads them is OpenCode, which runs on Bun and
// reads `.ts` tool definitions out of its own config directory.
//
// The product asks the executor to call them by name (`implementation-worker.mjs`
// builds the prompt) and the supervisor implements them (the worker tool
// gateway). Only the definitions were missing, so on every installed release the
// executor was told to call tools it had no way to see: it worked for sixteen
// minutes, changed the file it was asked to change, and then failed with
// "OpenCode did not submit a terminal report after two same-session
// finalization turns" — which is true, and says nothing about why.
// `runtime-supervisor/README.md` documents the protocol for a reader in a
// checkout; the protocol itself is enforced by the module that implements it.
// Files that ship because a *runtime* reads them, not because our import graph
// reaches them.
//
// The allowlist has two rules that together forbid this without a third
// category: a shipped file must be explained by an import, and a file nothing
// imports must not ship. Tool definitions satisfy neither — OpenCode loads them
// out of its config directory, and no `.mjs` in this repository mentions them.
//
// That gap is why they were classed as PoC leftovers and dropped from every
// release, while the prompt kept asking the executor to call them. Naming them
// here says what they are: not modules, not documentation, but something the
// product installs for a runtime to find.
//
// Each entry must be unreachable from the import graph. A file that *is*
// imported belongs in the closure, not here, and the check below says so.
export const SERVICE_RUNTIME_ASSETS = new Map([
  ["runtime-supervisor/opencode-tools/complete_task.ts",
    "OpenCode tool definition; the executor is asked to call complete_task and the worker tool gateway implements it"],
  ["runtime-supervisor/opencode-tools/report_blocker.ts",
    "OpenCode tool definition; the executor is asked to call report_blocker and the worker tool gateway implements it"],
  ["runtime-supervisor/opencode-tools/delegate_task.ts",
    "OpenCode tool definition; an OpenCode orchestrator's turn calls delegate_task and its run socket implements it (11.2 N4)"],
  ["runtime-supervisor/opencode-tools/request_revision.ts",
    "OpenCode tool definition; an OpenCode orchestrator's review calls request_revision and its run socket implements it (11.2 N4)"],
  ["runtime-supervisor/opencode-tools/request_user_input.ts",
    "OpenCode tool definition; the executor is asked to call request_user_input and the worker tool gateway implements it"],
  // Started by Claude Code from a turn's --mcp-config, by path (drivers/claude.mjs);
  // its one import, drivers/tool-contracts.mjs, every driver already reaches.
  // $SHELL of a writing run (drivers/opencode.mjs): bash in bubblewrap with
  // the runtime's login covered (Stage 12 M0).
  ["runtime-supervisor/sandbox-shell/bash",
    "the shell a writing run's commands run in; bubblewrap covers the runtime's login (Stage 12 M0)"],
  ["runtime-supervisor/claude-mcp/platform-bridge.mjs",
    "Claude Code's MCP server for the platform's commands; a Claude orchestrator's turn starts it and its run socket implements the commands (sprint C K2)"],
]);

export const SERVICE_DEV_ONLY = new Map([
  ["control-plane/run-db-tests.mjs", "database test harness; db/tests is not shipped"],
  ["runtime-supervisor/policy-smoke.mjs", "manual supervisor smoke; needs a live socket"],
  ["runtime-supervisor/socket-access-smoke.mjs", "manual supervisor smoke; needs a live socket"],
  ["runtime-supervisor/README.md", "service documentation; no runtime effect"],
]);

// The runtime entry points, as systemd starts them. `payloadPath` is where each
// one lands in the release, and it is the path the units use relative to
// `/opt/infra-cod/current` — the entry-point contract test asserts the two stay
// equal, so declaring them together is what keeps that honest.
//
// The list is derived from `deploy/systemd` and `deploy/caddy` rather than
// hand-written where it can be: an entry point that a unit starts but this list
// forgets would produce a release whose units cannot start anything. The four
// canonical ones below are also the ones the manifest advertises by name.
export const CANONICAL_ENTRYPOINTS = {
  web: "web/apps/web/server.js",
  cli: "services/cli/infra-cod.mjs",
  migrate: "services/control-plane/migrate.mjs",
  runtimeSupervisor: "services/runtime-supervisor/server.mjs",
};

// Release-relative locations the builder writes to. They live here rather than in
// the builder so that the verifier and the builder cannot disagree about where the
// entry point is supposed to be.
export const RELEASE_MIGRATIONS_PATH = "db/migrations";
export const RELEASE_DEPLOY_PATH = "deploy";
// The units use `Documentation=file:/opt/infra-cod/current/docs/OPERATIONS.md`, so
// the operations runbook is part of the payload. Shipping one Markdown file is a
// smaller commitment than removing a reference the units point a reader at.
export const RELEASE_DOCS = ["docs/OPERATIONS.md"];

// Every release-relative path a systemd unit or the Caddy configuration names,
// extracted from the files themselves. `/usr/bin/caddy` and other system paths
// are not release-relative and therefore do not appear.
export function referencedReleasePaths(deployRoot) {
  const found = new Set();
  const pattern = /\/opt\/infra-cod\/current\/([A-Za-z0-9._/-]+)/g;
  const stack = [deployRoot];
  while (stack.length > 0) {
    const current = stack.pop();
    for (const name of readdirSync(current)) {
      const full = path.join(current, name);
      const info = lstatSync(full);
      if (info.isDirectory()) {
        stack.push(full);
        continue;
      }
      const source = readFileSync(full, "utf8");
      let match;
      while ((match = pattern.exec(source)) !== null) found.add(match[1]);
    }
  }
  return [...found].sort();
}

// Names that must never appear anywhere in the payload, as a path component or as
// a complete basename. This is a second line of defence behind the allowlist: if a
// refactor ever widens the allowlist, these still refuse.
export const FORBIDDEN_PATH_COMPONENTS = new Set([
  ".git", ".github", ".pnpm-store", ".vercel", ".cache", ".turbo", ".venv",
  "pocs", "test", "tests", "__tests__", "fixtures", "coverage", "dumps", "backups",
]);

// Multi-component paths that must not appear. `.next` in a *release* is only ever
// the built output the standalone server reads; a cache inside it carries
// timestamps, makes two builds of one commit differ, and is never read at runtime.
// It is a two-component match because the component set above can only test one
// component at a time. `walkTree` is recursive, so this refuses it at any depth.
export const FORBIDDEN_PATH_FRAGMENTS = [".next/cache", "node_modules/.cache"];

export const FORBIDDEN_BASENAMES = new Set([
  ".env", ".env.local", ".npmrc", ".yarnrc", ".yarnrc.yml", "initial-credentials",
  ".DS_Store", "tsconfig.tsbuildinfo", ".eslintcache", "lock.yaml",
]);

export const FORBIDDEN_SUFFIXES = [".pem", ".key", ".p12", ".pfx", ".minisig", ".log", ".tsbuildinfo"];

// `.env.example` is documentation, not configuration: it is in `.env.example` form
// everywhere in this repository and carries no values. It is still not shipped,
// because a release tree has no use for it and shipping it invites someone to
// copy it into place with the sample values.
export function isForbiddenName(relativePath) {
  const components = relativePath.split("/");
  const basename = components[components.length - 1];
  if (basename === ".env.example") return "environment example file";
  if (FORBIDDEN_BASENAMES.has(basename)) return `forbidden basename ${basename}`;
  for (const suffix of FORBIDDEN_SUFFIXES) {
    if (basename.endsWith(suffix)) return `forbidden suffix ${suffix}`;
  }
  for (const component of components) {
    if (FORBIDDEN_PATH_COMPONENTS.has(component)) return `forbidden path component ${component}`;
  }
  for (const fragment of FORBIDDEN_PATH_FRAGMENTS) {
    if (relativePath === fragment || relativePath.startsWith(`${fragment}/`) || relativePath.includes(`/${fragment}/`)) {
      return `forbidden path ${fragment}`;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Import closure over the service sources
// ---------------------------------------------------------------------------

const IMPORT_PATTERNS = [
  // import ... from "x"  /  export ... from "x"
  /(?:^|[^\w$.])import\s+(?:[^"'()]*?\s+from\s+)?["']([^"']+)["']/g,
  /(?:^|[^\w$.])export\s+(?:[^"'()]*?\s+from\s+)?["']([^"']+)["']/g,
  // await import("x")
  /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
];

// Specifiers that name a package rather than a file. Recorded, not followed: the
// package half of the closure is materialised separately and any package the
// services actually import must be a declared production dependency.
export function bareSpecifiers(source) {
  const found = new Set();
  for (const pattern of IMPORT_PATTERNS) {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(source)) !== null) {
      const specifier = match[1];
      if (specifier.startsWith("node:") || specifier.startsWith(".") || specifier.startsWith("/")) continue;
      const segments = specifier.split("/");
      found.add(specifier.startsWith("@") ? `${segments[0]}/${segments[1]}` : segments[0]);
    }
  }
  return found;
}

function isSourceFile(name) {
  return name.endsWith(".mjs") || name.endsWith(".js") || name.endsWith(".cjs") || name.endsWith(".json");
}

// Resolves a relative specifier the way Node does for this project's ESM sources:
// the literal path, then the `.mjs`/`.js`/`.cjs`/`.json` extensions, then the
// directory index. A specifier that resolves to nothing is reported rather than
// ignored: a service that imports a missing file is broken, and finding that here
// is cheaper than finding it after an install.
export function resolveRelative(fromFile, specifier) {
  const base = path.resolve(path.dirname(fromFile), specifier);
  const candidates = [base, `${base}.mjs`, `${base}.js`, `${base}.cjs`, `${base}.json`];
  for (const candidate of candidates) {
    try {
      const info = lstatSync(candidate);
      if (info.isDirectory()) {
        for (const index of ["index.mjs", "index.js", "index.cjs", "index.json"]) {
          const nested = path.join(candidate, index);
          try {
            if (lstatSync(nested).isFile()) return nested;
          } catch { /* not this one */ }
        }
        continue;
      }
      if (info.isFile()) return candidate;
    } catch { /* not this one */ }
  }
  return null;
}

// Walks the import graph from `entrypoints` inside `servicesRoot`.
//
// Returns the reachable files (absolute) and the set of bare package specifiers
// they import. Both are needed: the files become the service payload, and the
// package set is what the dependency materialiser has to satisfy.
export function serviceImportClosure({ servicesRoot, entrypoints }) {
  const reachable = new Set();
  const packages = new Set();
  const missing = [];
  const queue = entrypoints.map((entrypoint) => path.resolve(servicesRoot, entrypoint));

  for (const entry of queue) {
    if (!lstatSync(entry, { throwIfNoEntry: false })?.isFile()) {
      throw new PayloadError(`runtime entry point does not exist: ${entry}`);
    }
  }

  while (queue.length > 0) {
    const file = queue.pop();
    if (reachable.has(file)) continue;
    reachable.add(file);
    if (!isSourceFile(file)) continue;

    const source = readFileSync(file, "utf8");
    for (const specifier of allSpecifiers(source)) {
      if (specifier.startsWith("node:")) continue;
      if (specifier.startsWith(".") || specifier.startsWith("/")) {
        const resolved = resolveRelative(file, specifier);
        if (!resolved) {
          missing.push(`${path.relative(servicesRoot, file)} imports ${specifier}, which does not resolve`);
          continue;
        }
        // A service must not reach outside `services/`. If it does, the release
        // layout would have to mirror the repository, and the allowlist stops
        // meaning anything. Refusing here keeps that explicit.
        const inside = path.relative(servicesRoot, resolved);
        if (inside.startsWith("..") || path.isAbsolute(inside)) {
          throw new PayloadError(
            `${path.relative(servicesRoot, file)} imports ${specifier}, which resolves outside services/ (${resolved})`,
          );
        }
        queue.push(resolved);
        continue;
      }
      const segments = specifier.split("/");
      packages.add(specifier.startsWith("@") ? `${segments[0]}/${segments[1]}` : segments[0]);
    }
  }

  return { files: [...reachable].sort(), packages: [...packages].sort(), missing };
}

function allSpecifiers(source) {
  const found = new Set();
  for (const pattern of IMPORT_PATTERNS) {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(source)) !== null) found.add(match[1]);
  }
  return found;
}

// The service half of the payload, and the proof that it is exactly what the
// services need.
//
// Candidates come from the directory allowlist: everything under `services/<dir>`
// for the directories above, minus test directories, forbidden names and the
// developer-only scripts named in `SERVICE_DEV_ONLY`. That is the allowlist the
// stage requires. It is then cross-checked against the import graph in every
// direction that matters:
//
//   * a shipped file no entry point reaches is dead weight at best and an
//     unreviewed file at worst, so it is named and the build stops;
//   * a closure member that is not a candidate means the allowlist is narrower
//     than the code, which would ship a service that cannot start;
//   * a developer-only file that a *production* entry point reaches would be
//     omitted from a tree that needs it, so that also stops the build.
//
// The dev-only scripts are still walked as roots. That is what lets
// `client.mjs` be recognised as theirs rather than called unreachable: the graph
// has to be fully explained before anything may be left out.
export function selectServicePayload({ repositoryRoot }) {
  const servicesRoot = path.join(repositoryRoot, 'services');
  const candidates = new Map();
  const productionRoots = [];
  const devRoots = [];

  for (const directory of SERVICE_DIRECTORIES) {
    const absolute = path.join(servicesRoot, directory);
    if (!lstatSync(absolute, { throwIfNoEntry: false })?.isDirectory()) {
      throw new PayloadError(
        `services/${directory} does not exist. The release layout names it, so a release cannot be built without it; `
          + "either restore the directory or remove it from SERVICE_DIRECTORIES.",
      );
    }
    for (const entry of walkTree(absolute)) {
      if (entry.type !== 'file') continue;
      const relative = `${directory}/${entry.relativePath}`;
      if (isForbiddenName(relative)) continue;
      const full = path.join(absolute, entry.relativePath);
      const isRootScript = !entry.relativePath.includes('/') && entry.relativePath.endsWith('.mjs');
      if (SERVICE_DEV_ONLY.has(relative)) {
        if (isRootScript) devRoots.push(relative);
        continue;
      }
      if (isRootScript) productionRoots.push(relative);
      candidates.set(full, relative);
    }
  }

  if (productionRoots.length === 0) {
    throw new PayloadError('no service entry points were found under services/');
  }

  const closure = serviceImportClosure({ servicesRoot, entrypoints: [...productionRoots, ...devRoots] });
  if (closure.missing.length > 0) {
    throw new PayloadError(`service imports do not resolve:\n  ${closure.missing.join('\n  ')}`);
  }

  const productionClosure = new Set(
    serviceImportClosure({ servicesRoot, entrypoints: productionRoots }).files,
  );
  const everythingReachable = new Set(closure.files);

  // Rule 1: never omit a file the running services need.
  const neededButDevOnly = [];
  for (const [relative] of SERVICE_DEV_ONLY) {
    if (productionClosure.has(path.join(servicesRoot, relative))) neededButDevOnly.push(relative);
  }
  if (neededButDevOnly.length > 0) {
    throw new PayloadError(
      'these files are listed as developer-only but a runtime entry point reaches them:\n'
        + `${neededButDevOnly.map((file) => `  services/${file}`).join('\n')}\n`
        + '  (remove the entry from SERVICE_DEV_ONLY, or stop importing it)',
    );
  }

  // Rule 2: the service closure may not reach outside the allowlisted directories.
  const outsideAllowlist = [...productionClosure].filter((file) => !candidates.has(file));
  // Rule 3: every candidate file must be explained by some import graph, or be a
  // named runtime asset — something a runtime loads and no module imports.
  const runtimeAssets = new Set(
    [...SERVICE_RUNTIME_ASSETS.keys()].map((relative) => path.join(servicesRoot, relative)),
  );
  const unexplained = [...candidates.keys()]
    .filter((file) => !everythingReachable.has(file) && !runtimeAssets.has(file));

  // And the category has to stay honest: an asset the import graph reaches is a
  // module, and belongs in the closure where a missing import fails the build.
  const assetsThatAreModules = [...runtimeAssets].filter((file) => everythingReachable.has(file));
  if (assetsThatAreModules.length > 0) {
    throw new PayloadError(
      'these are listed as runtime assets but the import graph reaches them:\n'
        + `${assetsThatAreModules.map((file) => `  ${path.relative(repositoryRoot, file)}`).join('\n')}\n`
        + '  (remove the entry; the closure already ships them)',
    );
  }

  if (outsideAllowlist.length > 0 || unexplained.length > 0) {
    const lines = [
      ...outsideAllowlist.map((file) => `  reachable but outside the allowlist: ${path.relative(repositoryRoot, file)}`),
      ...unexplained.map((file) => `  unreachable: ${path.relative(repositoryRoot, file)}`),
    ];
    throw new PayloadError(
      'the service allowlist and the import graph disagree; resolve this before building a release:\n'
        + `${lines.join('\n')}\n`
        + '  (import an unreachable file from an entry point, delete it, or list it in SERVICE_DEV_ONLY)',
    );
  }

  return {
    root: servicesRoot,
    // The closure, plus the assets a runtime loads. They are not in the closure
    // by construction — nothing imports them — so without this line the category
    // above would only stop the build complaining and still ship nothing, which
    // is the state that produced the defect.
    files: [...new Set([...productionClosure, ...runtimeAssets])].sort(),
    packages: closure.packages,
    entrypoints: productionRoots.sort(),
    omitted: [...SERVICE_DEV_ONLY].map(([file, reason]) => ({ path: `services/${file}`, reason })),
  };
}

// ---------------------------------------------------------------------------
// Walking a built tree
// ---------------------------------------------------------------------------

// Every entry under `directory`, as `{ relativePath, type, size, linkTarget }`,
// sorted by relative path. `relativePath` always uses `/`, because a tar member
// name is not an OS path and a `\` in one is a literal backslash on Linux.
export function walkTree(directory) {
  const entries = [];
  const stack = [directory];
  while (stack.length > 0) {
    const current = stack.pop();
    for (const name of readdirSync(current)) {
      const full = path.join(current, name);
      const relative = path.relative(directory, full).split(path.sep).join("/");
      const info = lstatSync(full);
      if (info.isSymbolicLink()) {
        entries.push({ relativePath: relative, type: "symlink", size: 0 });
        continue;
      }
      if (info.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (!info.isFile()) {
        throw new PayloadError(`${relative} is neither a regular file, a directory nor a symlink`);
      }
      entries.push({ relativePath: relative, type: "file", size: info.size });
    }
  }
  entries.sort((left, right) => (left.relativePath < right.relativePath ? -1 : left.relativePath > right.relativePath ? 1 : 0));
  return entries;
}

// Checks the payload against the forbidden-name rules, and refuses path shapes
// that cannot be represented in a portable archive.
export function assertNoForbiddenEntries(entries) {
  for (const entry of entries) {
    if (entry.relativePath.startsWith("/") || /^[A-Za-z]:/.test(entry.relativePath)) {
      throw new PayloadError(`payload contains an absolute path: ${entry.relativePath}`);
    }
    const components = entry.relativePath.split("/");
    if (components.includes("..") || components.includes(".") || components.includes("")) {
      throw new PayloadError(`payload contains a non-normalised path: ${entry.relativePath}`);
    }
    const forbidden = isForbiddenName(entry.relativePath);
    if (forbidden) {
      throw new PayloadError(`payload contains ${entry.relativePath} (${forbidden})`);
    }
  }
}

// Verifies that every symlink in a tree points inside that tree, and that nothing
// is dangling. A link that escapes is a relocation bug at best and a
// directory-traversal primitive at worst; a dangling link is a file somebody
// believed was shipped.
//
// `root` is resolved with `realpath` so that a tree reached through a symlinked
// parent (macOS `/tmp` -> `/private/tmp`, for one) does not report every internal
// link as an escape.
// The canonical form of a path that may not exist, resolved against the nearest
// ancestor that does. `realpathSync` throws on a missing path, and a symlink whose
// target is missing must be *reported* as dangling rather than crash the check.
//
// Both sides of every comparison in `checkSymlinkClosure` go through this, which is
// what keeps the comparison meaningful when the tree lives somewhere with a symlink
// in its own path (macOS `/tmp` and `/var/folders` both resolve to `/private/...`).
function canonicalise(target) {
  const absolute = path.resolve(target);
  const trailing = [];
  let current = absolute;
  while (!existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) return absolute;
    trailing.unshift(path.basename(current));
    current = parent;
  }
  return path.resolve(realpathSync(current), ...trailing);
}

export function checkSymlinkClosure(directory, entries) {
  // `directory` is canonicalised once, and every comparison is made against that
  // canonical value rather than against the path the caller wrote. On macOS
  // `/tmp` and `/var/folders/...` are symlinks to `/private/...`, so a check that
  // resolved the root but not the members — or the reverse — reports every internal
  // link in a perfectly closed tree as an escape. The bug is invisible on Linux,
  // which is exactly the kind that reaches production.
  const root = canonicalise(directory);
  const escaping = [];
  const dangling = [];
  const links = [];

  for (const entry of entries) {
    if (entry.type !== "symlink") continue;
    const full = path.join(directory, entry.relativePath);
    const target = readlinkSync(full);
    links.push({ path: entry.relativePath, target });

    if (path.isAbsolute(target)) {
      escaping.push({ path: entry.relativePath, target, reason: "absolute target" });
      continue;
    }

    // Resolved against the *containing directory*, which is what the kernel does,
    // then canonicalised so that an internal link which traverses another internal
    // link is still accepted and a link that leaves the tree is not.
    const resolved = canonicalise(path.resolve(path.dirname(full), target));
    if (resolved !== root && !resolved.startsWith(root + path.sep)) {
      escaping.push({ path: entry.relativePath, target, reason: "target resolves outside the release tree" });
      continue;
    }
    if (!lstatSync(resolved, { throwIfNoEntry: false })) {
      dangling.push({ path: entry.relativePath, target });
      continue;
    }
    // A target inside the tree that is itself a symlink escaping the tree is the
    // same escape one hop later.
    let cursor = resolved;
    for (let hops = 0; hops < 40; hops += 1) {
      const info = lstatSync(cursor, { throwIfNoEntry: false });
      if (!info) break;
      if (!info.isSymbolicLink()) break;
      const next = canonicalise(path.resolve(path.dirname(cursor), readlinkSync(cursor)));
      if (next !== root && !next.startsWith(root + path.sep)) {
        escaping.push({ path: entry.relativePath, target, reason: `resolves through ${path.relative(root, cursor)} to ${next}` });
        break;
      }
      cursor = next;
    }
  }

  return { links, escaping, dangling };
}
