// Assembling the release tree from the allowlisted parts.
//
// Every copy in this module is an allowlist copy: the caller names a source and a
// destination, and the function copies exactly that, refusing to follow a symlink
// out of the tree and refusing to invent a file. Nothing here walks the
// repository.
//
// Symlinks are preserved verbatim, not dereferenced, for the reason
// `stage-standalone.mjs` documents at length: the Next standalone output and the
// pnpm store are both link layouts, and flattening a link changes the path the
// next link resolves against, so the server dies on a module that is plainly
// present. Preservation is only acceptable because the result is *checked* —
// `verifySymlinkClosure` proves every link stays inside the release.
//
// Dangling links are the one exception, and they are dropped rather than
// preserved. Next's file tracer copies a pnpm hoist link without copying its
// target, so a real build contains at least one link to a package that is not
// there. Such a link cannot be resolved by any consumer, so its presence changes
// no behaviour; keeping it would mean shipping a release that fails its own
// symlink check and claiming the check is too strict. The count and the paths are
// recorded in the build summary so the difference is visible rather than silent.

import { chmodSync, constants, copyFileSync, existsSync, linkSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { COMPATIBILITY_FILENAME } from "./release-compatibility.mjs";
import { REGISTRY_PUBLIC_KEY } from "../../services/operations/runtime-adapters.mjs";

export class AssemblyError extends Error {
  constructor(message) {
    super(message);
    this.name = "AssemblyError";
  }
}

const MODE_DIRECTORY = 0o755;
const MODE_FILE = 0o644;
const MODE_EXECUTABLE = 0o755;

function placeFile(source, destination, hardlink) {
  mkdirSync(path.dirname(destination), { recursive: true });
  const mode = lstatSync(source).mode & 0o111 ? MODE_EXECUTABLE : MODE_FILE;
  let placed = false;
  if (hardlink) {
    try {
      linkSync(source, destination);
      placed = true;
    } catch {
      placed = false;
    }
  }
  if (!placed) copyFileSync(source, destination, constants.COPYFILECLONE);
  chmodSync(destination, mode);
  return lstatSync(destination).size;
}

// The tar header this project writes has 100 bytes for a link target, and the
// target is what a consumer resolves, so a longer one cannot be carried.
//
// pax *does* have a `linkpath` record for exactly this, and it was implemented
// first: GNU tar extracts such an archive correctly, but libarchive 3.7 — the `tar`
// on macOS, and the reader inside some container tooling — places the symlink at a
// path built from the entry that follows it. That was found by extracting a real
// build and looking at where the link landed.
//
// So a link whose target is too long is *rewritten* to a shorter relative path that
// reaches the same real directory. pnpm already provides one: the hoisted
// `node_modules/.pnpm/node_modules/<name>` directory is a link to the same package
// as `<key>/node_modules/<name>`, and from inside a nested directory it is much
// shorter. The rewrite is accepted only when it provably resolves to the identical
// real path, so behaviour cannot change.
//
// If no shorter alias exists the directory is materialised instead: the real tree
// is copied to the link's own path. That is a fallback rather than the primary
// mechanism because a package's own `node_modules` is where its dependencies live,
// and a copy that lands elsewhere loses the sibling links those dependencies are
// reached through. Behaviour is still unchanged for every consumer — Node resolves
// a symlink to its target before looking in `node_modules` — but the aliasing path
// is the one that keeps the layout intact.
export const MAX_LINK_TARGET_BYTES = 100;

// Copies `source` to `destination`. Returns the counts plus the dangling links it
// refused to carry and the over-long links it materialised.
// A relative path from the link's own location to `resolved` that fits the tar
// field, or null.
//
// The candidates are, for each ancestor of the link's directory from the deepest
// upwards, `<ancestor>/node_modules/<basename>` and pnpm's hoist directory
// `<ancestor>/node_modules/.pnpm/node_modules/<basename>`. The second one is where
// pnpm puts the short name for a package whose store key is long, which is exactly
// the case this function exists for; the first covers an ordinary install. A
// candidate is accepted only when it resolves to the *identical* real path, so the
// rewrite cannot change what the link points at.
//
// `linkDirectory` is the symlink's directory, not the directory of its target: the
// target text is relative to where the link lives, and using anything else produces
// a link that points at itself.
export function shortAliasFor(linkDirectory, resolved, { limit = MAX_LINK_TARGET_BYTES } = {}) {
  if (!existsSync(resolved)) return null;
  const realTarget = realpathSync(resolved);
  const original = path.resolve(linkDirectory, path.basename(resolved));
  let current = path.resolve(linkDirectory);

  for (;;) {
    const candidates = [
      path.join(current, "node_modules", path.basename(resolved)),
      path.join(current, "node_modules", ".pnpm", "node_modules", path.basename(resolved)),
    ];
    for (const candidate of candidates) {
      if (candidate === original || !existsSync(candidate)) continue;
      if (realpathSync(candidate) !== realTarget) continue;
      const relative = path.relative(linkDirectory, candidate).split(path.sep).join("/");
      if (Buffer.byteLength(relative, "utf8") <= limit) return relative;
    }
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

export function copyTree(source, destination, { hardlink = true, dropDangling = true, releaseRoot = null } = {}) {
  const counters = { files: 0, bytes: 0, directories: 0, links: 0, dangling: [], materialised: [], rewritten: [] };
  // Symlink creation is deferred until every directory and file exists, so a link
  // can never be the thing a later write goes through.
  //
  // Containment is judged on where the link's target *lands in the release*, not on
  // where it lives in the checkout. The copied tree keeps its shape, so a target at
  // `source/<relative>` in the checkout becomes `destination/<relative>` in the
  // release, and `<relative>` is what has to stay inside. Comparing the checkout
  // paths instead would report every internal link in a tree that had not yet been
  // given its destination as an escape.
  const releaseBoundary = canonical(releaseRoot ?? destination);
  const pendingLinks = [];
  const resolvedChains = new Set();

  const walk = (from, to) => {
    const info = lstatSync(from);
    if (info.isSymbolicLink()) {
      const target = readlinkSync(from);
      const resolved = path.resolve(path.dirname(from), target);
      if (!existsSync(resolved)) {
        if (!dropDangling) throw new AssemblyError(`${from} is a dangling symlink and dropDangling is false`);
        counters.dangling.push({ path: to, target });
        return;
      }
      // A target longer than a tar header can hold is materialised as a real
      // directory *with its links resolved*, because the package behind it uses
      // sibling links of its own, and those link targets are written relative to
      // their own directory. Copying the link verbatim under a new parent moves the
      // base those targets resolve against, so the chain has to be resolved at the
      // same time.
      if (Buffer.byteLength(target, "utf8") > MAX_LINK_TARGET_BYTES) {
        const alias = shortAliasFor(path.dirname(from), resolved);
        if (alias !== null) {
          counters.rewritten.push({ path: to, from: target, to: alias });
          mkdirSync(path.dirname(to), { recursive: true });
          pendingLinks.push({ from, to, target: alias, resolved });
          return;
        }
        const nested = materialiseResolved(resolved, to, [resolved]);
        counters.files += nested.files;
        counters.bytes += nested.bytes;
        counters.directories += nested.directories;
        counters.links += nested.links;
        counters.dangling.push(...nested.dangling);
        counters.materialised.push({ path: to, target, bytes: Buffer.byteLength(target, "utf8") });
        return;
      }
      mkdirSync(path.dirname(to), { recursive: true });
      pendingLinks.push({ from, to, target, resolved });
      return;
    }
    if (info.isDirectory()) {
      mkdirSync(to, { recursive: true, mode: MODE_DIRECTORY });
      chmodSync(to, MODE_DIRECTORY);
      counters.directories += 1;
      for (const name of readdirSync(from)) walk(path.join(from, name), path.join(to, name));
      return;
    }
    if (!info.isFile()) {
      throw new AssemblyError(`${from} is neither a regular file, a directory nor a symlink`);
    }
    counters.bytes += placeFile(from, to, hardlink);
    counters.files += 1;
  };

  // Copies a link's target as a real tree, resolving every link inside it the same
  // way. `visited` is the chain currently being expanded: a link that leads back
  // into its own chain is a cycle, and copying it would not terminate.
  function materialiseResolved(from, to, visited) {
    const countersInner = { files: 0, bytes: 0, directories: 0, links: 0, dangling: [] };
    mkdirSync(to, { recursive: true, mode: MODE_DIRECTORY });
    chmodSync(to, MODE_DIRECTORY);
    countersInner.directories += 1;

    for (const name of readdirSync(from)) {
      const childFrom = path.join(from, name);
      const childTo = path.join(to, name);
      const info = lstatSync(childFrom);
      if (info.isSymbolicLink()) {
        const target = readlinkSync(childFrom);
        const resolved = path.resolve(path.dirname(childFrom), target);
        if (!existsSync(resolved)) {
          countersInner.dangling.push({ path: childTo, target });
          continue;
        }
        if (visited.includes(resolved)) {
          // A cycle: the link points back at a directory already being expanded.
          // Copying it again would recurse forever, and the link itself would be
          // valid inside the release only if its target is copied too — which it is,
          // one level up. Refusing is honest; a silent skip would produce a tree
          // that cannot be explained.
          throw new AssemblyError(
            `cannot materialise ${childFrom}: its target ${resolved} is part of the link chain being expanded`,
          );
        }
        const nested = materialiseResolved(resolved, childTo, [...visited, resolved]);
        countersInner.files += nested.files;
        countersInner.bytes += nested.bytes;
        countersInner.directories += nested.directories;
        countersInner.dangling.push(...nested.dangling);
        continue;
      }
      if (info.isDirectory()) {
        // One recursive call per directory, not per entry: `materialiseResolved`
        // copies the directory it is given *and* its contents, so calling it once
        // here is what copies the whole subtree.
        const nested = materialiseResolved(childFrom, childTo, visited);
        countersInner.files += nested.files;
        countersInner.bytes += nested.bytes;
        countersInner.directories += nested.directories;
        countersInner.dangling.push(...nested.dangling);
        continue;
      }
      countersInner.bytes += placeFile(childFrom, childTo, hardlink);
      countersInner.files += 1;
    }
    return countersInner;
  }

  walk(source, destination);

  // Every deferred link must land inside the release. A link whose target would
  // land outside is not relocatable — it points at the build machine — so it is
  // refused rather than copied.
  for (const link of pendingLinks) {
    const relativeTarget = path.relative(path.resolve(source), link.resolved);
    if (relativeTarget.startsWith("..") || path.isAbsolute(relativeTarget)) {
      throw new AssemblyError(
        `${link.from} -> ${link.target} resolves to ${link.resolved}, which is outside the tree being copied; `
          + "the release would only work where it was built",
      );
    }
    const landing = canonical(path.join(destination, relativeTarget));
    if (!isInside(releaseBoundary, landing)) {
      throw new AssemblyError(
        `${link.from} -> ${link.target} would land at ${landing}, outside the release root ${releaseBoundary}`,
      );
    }
    if (resolvedChains.has(link.to)) continue;
    resolvedChains.add(link.to);
    mkdirSync(path.dirname(link.to), { recursive: true });
    symlinkSync(link.target, link.to);
    counters.links += 1;
  }

  return counters;
}

function canonical(target) {
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

function isInside(root, target) {
  return target === root || target.startsWith(`${root}${path.sep}`);
}

// Copies the pieces Next leaves out beside the entry point it traced them
// relative to. The entry point is discovered by the same rule
// `stage-standalone.mjs` uses — the shallowest `server.js` outside `node_modules`
// — so a change to the trace root changes both together or neither.
export function findWebEntrypoint(webRoot) {
  const candidates = [];
  const stack = [webRoot];
  while (stack.length > 0) {
    const current = stack.pop();
    for (const name of readdirSync(current)) {
      const full = path.join(current, name);
      const info = lstatSync(full);
      if (info.isSymbolicLink()) continue;
      if (info.isDirectory()) {
        if (name === "node_modules") continue;
        stack.push(full);
      } else if (name === "server.js" && !full.includes(`${path.sep}node_modules${path.sep}`)) {
        candidates.push(full);
      }
    }
  }
  candidates.sort((left, right) => left.split(path.sep).length - right.split(path.sep).length);
  if (candidates.length === 0) {
    throw new AssemblyError("the web tree contains no server.js outside node_modules");
  }
  return candidates[0];
}

// Lays out `web/` in the release from a built Next standalone output.
export function assembleWebRelease({ repositoryRoot, releaseRoot, hardlink }) {
  const appDirectory = path.join(repositoryRoot, "apps/web");
  const standalone = path.join(appDirectory, ".next/standalone");
  const staticDirectory = path.join(appDirectory, ".next/static");
  const publicDirectory = path.join(appDirectory, "public");

  for (const required of [standalone, staticDirectory]) {
    if (!existsSync(required)) {
      throw new AssemblyError(`${path.relative(repositoryRoot, required)} is missing; build the web app first`);
    }
  }

  const webRoot = path.join(releaseRoot, "web");
  const counters = copyTree(standalone, webRoot, { hardlink, dropDangling: true, releaseRoot });

  const entrypoint = findWebEntrypoint(webRoot);
  const appRoot = path.dirname(entrypoint);
  const staticCounters = copyTree(staticDirectory, path.join(appRoot, ".next/static"), { hardlink, releaseRoot });
  const publicCounters = existsSync(publicDirectory)
    ? copyTree(publicDirectory, path.join(appRoot, "public"), { hardlink, releaseRoot })
    : { files: 0, bytes: 0, directories: 0, links: 0, dangling: [], materialised: [], rewritten: [] };

  return {
    webRoot,
    entrypoint: path.relative(releaseRoot, entrypoint).split(path.sep).join("/"),
    relativeEntrypoint: path.relative(webRoot, entrypoint).split(path.sep).join("/"),
    counters: {
      files: counters.files + staticCounters.files + publicCounters.files,
      bytes: counters.bytes + staticCounters.bytes + publicCounters.bytes,
      directories: counters.directories + staticCounters.directories + publicCounters.directories,
      links: counters.links + staticCounters.links + publicCounters.links,
    },
    dangling: [...counters.dangling, ...staticCounters.dangling, ...publicCounters.dangling],
    materialised: [...counters.materialised, ...staticCounters.materialised, ...publicCounters.materialised],
    rewritten: [...counters.rewritten, ...staticCounters.rewritten, ...publicCounters.rewritten],
  };
}

// Copies the service sources the import closure selected, keeping their
// `services/<dir>/...` layout so a release-relative path matches the repository
// path and `WorkingDirectory=/opt/infra-cod/current` keeps resolving.
export function assembleServiceRelease({ selection, releaseRoot, hardlink }) {
  const counters = { files: 0, bytes: 0, directories: 0, links: 0, dangling: [] };
  for (const file of selection.files) {
    const relative = path.relative(selection.root, file).split(path.sep).join("/");
    const destination = path.join(releaseRoot, "services", relative);
    counters.bytes += placeFile(file, destination, hardlink);
    counters.files += 1;
  }
  return counters;
}

// Copies the migrations. Deliberately a copy of the directory contents and not a
// `db/` copy: `db/tests` is a test fixture and belongs nowhere near a release.
export function assembleMigrationsRelease({ repositoryRoot, releaseRoot, hardlink }) {
  const source = path.join(repositoryRoot, "db/migrations");
  if (!existsSync(source)) throw new AssemblyError("db/migrations is missing");
  const counters = copyTree(source, path.join(releaseRoot, "db/migrations"), { hardlink });
  const nonSql = readdirSync(source).filter((name) => !name.endsWith(".sql"));
  if (nonSql.length > 0) {
    throw new AssemblyError(`db/migrations contains non-SQL entries: ${nonSql.join(", ")}`);
  }

  // The schema compatibility contract travels beside the migrations it describes.
  // The manifest carries the same answer in summarised form, but a manifest is a
  // claim: shipping the declaration itself is what lets the verifier recompute the
  // summary from the payload and refuse an artifact whose manifest disagrees with
  // its own migrations.
  const contract = path.join(repositoryRoot, "db", COMPATIBILITY_FILENAME);
  if (!existsSync(contract)) throw new AssemblyError(`db/${COMPATIBILITY_FILENAME} is missing`);
  counters.bytes += placeFile(contract, path.join(releaseRoot, "db", COMPATIBILITY_FILENAME), hardlink);
  counters.files += 1;
  return counters;
}

// Copies the deploy assets the units and Caddy need.
//
// `Caddyfile.local` is excluded on purpose. It is an acceptance-mode template with
// no TLS, and a release that carries it is a release where a misconfigured
// `INFRA_COD_CADDY_CONFIG` serves the operator's panel over plain HTTP. It stays in
// the repository, where the acceptance run can reach it, and out of the artifact,
// where nothing legitimate reads it.
export function assembleDeployRelease({ repositoryRoot, releaseRoot, hardlink }) {
  const source = path.join(repositoryRoot, "deploy");
  const excluded = ["deploy/caddy/Caddyfile.local"];
  const counters = copyTree(source, path.join(releaseRoot, "deploy"), { hardlink });

  // The exclusion is applied by removing the file after the copy, so the copy
  // itself stays one auditable operation and the exclusion stays visible. A
  // missing file is not an error: the point is that the release does not contain
  // it either way.
  let removed = 0;
  let removedBytes = 0;
  for (const relative of excluded) {
    const file = path.join(releaseRoot, relative);
    if (!existsSync(file)) continue;
    removedBytes += statSync(file).size;
    rmSync(file);
    removed += 1;
  }
  counters.files -= removed;
  counters.bytes -= removedBytes;
  counters.excluded = excluded;
  return counters;
}

// Copies the documentation the units reference.
export function assembleDocsRelease({ repositoryRoot, releaseRoot, hardlink, documents }) {
  const counters = { files: 0, bytes: 0, directories: 0, links: 0, dangling: [] };
  for (const relative of documents) {
    const source = path.join(repositoryRoot, relative);
    if (!existsSync(source)) throw new AssemblyError(`${relative} is referenced by a unit but is missing`);
    counters.bytes += placeFile(source, path.join(releaseRoot, relative), hardlink);
    counters.files += 1;
  }
  return counters;
}

// Files the deep verifier needs inside the shipped artifact.
//
// verify-release.mjs is the main entry; its lib/* dependencies travel with it —
// all of them. This list is hand-written and the import graph is not, which is
// how `release-compatibility.mjs` was added to the verifier's imports and not to
// this array: every structural test passed, and the deep verifier inside the
// real artifact died with ERR_MODULE_NOT_FOUND on the Ubuntu acceptance host,
// where the artifact is the only copy of the code there is.
//
// `release-structure.test.mjs` now computes the closure of the entry point and
// compares it against this list in both directions, so the next missing import
// is a failed test rather than an unusable release.
export const VERIFIER_SCRIPTS = [
  "scripts/verify-release.mjs",
  "scripts/lib/blake2b.mjs",
  "scripts/lib/release-archive.mjs",
  "scripts/lib/release-compatibility.mjs",
  "scripts/lib/release-manifest.mjs",
  "scripts/lib/release-payload.mjs",
  "scripts/lib/release-signature.mjs",
  "scripts/lib/release-verify.mjs",
  "scripts/lib/release-version.mjs",
];

// The version contract file that the deep verifier reads for pinned key, target
// and Node version. It is deliberately outside scripts/ so that the builder and
// the verifier read the same file.
const VERIFIER_VERSION_CONTRACT = [
  "release/release-version.json",
];

export function assembleVerifierScriptsRelease({ repositoryRoot, releaseRoot, hardlink }) {
  const counters = { files: 0, bytes: 0, directories: 0, links: 0, dangling: [] };
  for (const relative of [...VERIFIER_SCRIPTS, ...VERIFIER_VERSION_CONTRACT]) {
    const source = path.join(repositoryRoot, relative);
    if (!existsSync(source)) throw new AssemblyError(`${relative} is referenced by the verifier but is missing`);
    counters.bytes += placeFile(source, path.join(releaseRoot, relative), hardlink);
    counters.files += 1;
  }
  return counters;
}

// Public keys the *installed release* has to be able to read, as opposed to the
// ones a build or a verifier reads from a checkout.
//
// `infra-cod runtime install` verifies the npm registry's signature against a key
// pinned in the tree (ADR-0012 §3), and it resolves that key relative to the
// release it is running from. Left out of the payload, the command fails on the
// only host it exists for — with the key plainly present in the repository, so
// nothing in a checkout reproduces it. The runtime suite did not: its harness
// builds a synthetic release and writes the key into it, which tests the reader
// and not the packer.
//
// The list is taken from the adapter registry rather than restated here, so a key
// that moves cannot move out of the release at the same time. The module is a
// table of constants and pure functions; importing it costs nothing and runs
// nothing.
export const TRUSTED_KEYS = [REGISTRY_PUBLIC_KEY];

export function assembleTrustedKeysRelease({ repositoryRoot, releaseRoot, hardlink }) {
  const counters = { files: 0, bytes: 0, directories: 0, links: 0, dangling: [] };
  for (const relative of TRUSTED_KEYS) {
    const source = path.join(repositoryRoot, relative);
    if (!existsSync(source)) {
      throw new AssemblyError(`${relative} is a trust anchor this release needs but is missing`);
    }
    counters.bytes += placeFile(source, path.join(releaseRoot, relative), hardlink);
    counters.files += 1;
  }
  return counters;
}

// A single summary the builder prints and records.
export function mergeCounters(list) {
  const total = { files: 0, bytes: 0, directories: 0, links: 0, dangling: [], materialised: [], rewritten: [] };
  for (const counters of list) {
    total.files += counters.files ?? 0;
    total.bytes += counters.bytes ?? 0;
    total.directories += counters.directories ?? 0;
    total.links += counters.links ?? 0;
    total.dangling.push(...(counters.dangling ?? []));
    total.materialised.push(...(counters.materialised ?? []));
    total.rewritten.push(...(counters.rewritten ?? []));
  }
  return total;
}

// ---------------------------------------------------------------------------
// Build-path normalisation
// ---------------------------------------------------------------------------

// Next bakes absolute build paths into its output: `outputFileTracingRoot` and
// `turbopack.root` appear in `required-server-files.json` and in the manifest
// embedded in `server.js`'s webpack runtime.
//
// That is a host-identity leak in a portable artifact — it names the machine, the
// account and the checkout directory — and it is the exact thing the release
// contract forbids. It also makes two builds of one commit differ whenever they
// happen in different directories, which is what a reproducibility claim has to
// survive.
//
// The paths are removed rather than rewritten to a different absolute path: an
// empty string is not a path, so nothing can accidentally use it, and anything that
// genuinely reads it (a trace root is a build-time input) is not read at run time.
// Every removal is counted and reported so the change is visible rather than
// silent.
const BUILD_PATH_PATTERNS = [
  // A JSON string value holding an absolute path.
  [/"outputFileTracingRoot":"\/[^"]*"/g, '"outputFileTracingRoot":""'],
  [/"turbopack":\{"root":"\/[^"]*"/g, '"turbopack":{"root":""'],
  [/"appDir":"\/[^"]*"/g, '"appDir":""'],
];

export function normaliseBuildPaths(releaseRoot, { buildRoots = [] } = {}) {
  const removed = [];
  let filesTouched = 0;

  for (const entry of walkAll(releaseRoot)) {
    if (entry.type !== "file") continue;
    // Only text files Next writes; a binary that happens to contain the path is not
    // something this pass can rewrite, and rewriting one would corrupt it.
    if (!/\.(json|js|mjs|cjs)$/.test(entry.relativePath)) continue;
    const file = path.join(releaseRoot, entry.relativePath);
    let contents = readFileSync(file, "utf8");
    const original = contents;

    for (const root of buildRoots) {
      // A bare occurrence inside a JavaScript string, for the webpack runtime that
      // embeds `outputFileTracingRoot` verbatim.
      const escaped = root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const pattern = new RegExp(`"${escaped}"`, "g");
      contents = contents.replace(pattern, '""');
    }
    for (const [pattern, replacement] of BUILD_PATH_PATTERNS) {
      contents = contents.replace(pattern, replacement);
    }

    if (contents !== original) {
      writeFileSync(file, contents);
      filesTouched += 1;
      for (const root of buildRoots) {
        if (original.includes(root)) removed.push({ path: entry.relativePath, value: root });
      }
    }
  }

  return { filesTouched, removed };
}

function* walkAll(directory) {
  const stack = [directory];
  while (stack.length > 0) {
    const current = stack.pop();
    for (const name of readdirSync(current)) {
      const full = path.join(current, name);
      const info = lstatSync(full);
      if (info.isSymbolicLink()) continue;
      if (info.isDirectory()) {
        stack.push(full);
        continue;
      }
      yield { relativePath: path.relative(directory, full).split(path.sep).join("/"), type: "file", size: info.size, absolute: full };
    }
  }
}
