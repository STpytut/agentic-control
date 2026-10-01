// Production dependencies for the Node services, materialised for a release.
//
// The web panel is a Next `standalone` build and carries its own traced
// dependencies. Everything else — the CLI, the workers, the supervisor, the
// operations scripts and `migrate.mjs` — runs from the repository root and
// resolves `pg` and `hash-wasm` through the workspace's `node_modules`. That is a
// second runtime contour, and a release that ships only the web tree starts the
// panel and then fails every worker with `ERR_MODULE_NOT_FOUND`.
//
// The tree is produced by **dependency closure over the pnpm store**, not by
// `pnpm deploy`. `pnpm deploy` may become the right answer in a clean CI install,
// but it is not evidence by itself: on the machine this was developed on it
// consulted the registry and began re-resolving the lockfile despite `--offline`,
// so accepting its output would mean accepting an unverified dependency graph.
// Following the links pnpm already wrote, and refusing to ship a package that
// cannot be reached from a declared production dependency, produces something
// that can be checked byte for byte.
//
// The released layout is deliberately the same *shape* as the workspace's own:
//
//   node_modules/<name>              -> .pnpm/<key>/node_modules/<name>
//   node_modules/.pnpm/<key>/node_modules/<name>
//   node_modules/.pnpm/<key>/node_modules/<dep> -> ../../<dep-key>/node_modules/<dep>
//
// Every link is therefore relative, points at a real directory inside the release,
// and survives being moved to any absolute path. That is the property that makes
// the tree relocatable, and it is the property `checkSymlinkClosure` proves after
// the copy rather than assuming.

import { constants, chmodSync, copyFileSync, existsSync, linkSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, symlinkSync } from "node:fs";
import path from "node:path";

export class DependencyError extends Error {
  constructor(message) {
    super(message);
    this.name = "DependencyError";
  }
}

// Where a package's real directory sits inside `node_modules/.pnpm`. Everything a
// package needs is reachable from this directory by walking up; anything that is
// not is a link this module refuses to ship.
function pnpmKeyFor(realDirectory, nodeModulesRoot) {
  const storeRoot = path.join(nodeModulesRoot, ".pnpm");
  const relative = path.relative(storeRoot, realDirectory);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new DependencyError(
      `${realDirectory} is not inside ${storeRoot}; the release can only carry packages that live in the workspace store`,
    );
  }
  const key = relative.split(path.sep)[0];
  const expectedPrefix = `${key}${path.sep}node_modules${path.sep}`;
  if (!`${relative}${path.sep}`.startsWith(expectedPrefix)) {
    throw new DependencyError(`${realDirectory} does not have the expected .pnpm layout (<key>/node_modules/<name>)`);
  }
  const name = relative.slice(expectedPrefix.length).split(path.sep).join("/");
  return { key, name, directory: realDirectory };
}

// Node's own resolution, restricted to the directories that exist: `<dir>/node_modules/<name>`
// walking up from the requiring package. `require.resolve` would be simpler but it
// applies the `exports` map and refuses to resolve a package that is installed but
// whose `main` is missing, neither of which is the question here.
function resolvePackageDirectory(fromDirectory, name) {
  let current = fromDirectory;
  for (;;) {
    const candidate = path.join(current, "node_modules", name);
    const info = lstatSync(candidate, { throwIfNoEntry: false });
    if (info) return realpathSync(candidate);
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function readPackageJson(directory) {
  const file = path.join(directory, "package.json");
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new DependencyError(`${file} is not valid JSON: ${error.message}`);
  }
}

// Reads the dependency closure of `roots` from an installed workspace.
//
// `roots` are package names that must resolve from `nodeModulesRoot`. The closure
// includes `dependencies` and `optionalDependencies`. An optional dependency that
// is not installed is skipped *only* when the package itself marks it optional,
// and the skip is recorded; a missing hard dependency is an error.
export function dependencyClosure({ nodeModulesRoot, roots }) {
  const storeRoot = path.join(nodeModulesRoot, ".pnpm");
  if (!existsSync(storeRoot)) {
    throw new DependencyError(
      `${storeRoot} does not exist; run "pnpm install --frozen-lockfile" before building a release`,
    );
  }

  const packages = new Map(); // key -> { key, name, directory, dependencies: [key] }
  const skippedOptional = [];
  const queue = [];

  for (const name of roots) {
    const directory = resolvePackageDirectory(nodeModulesRoot, name);
    if (!directory) {
      throw new DependencyError(
        `${name} does not resolve from ${nodeModulesRoot}. It must be a production dependency of the root package.`,
      );
    }
    queue.push(pnpmKeyFor(directory, nodeModulesRoot));
  }

  while (queue.length > 0) {
    const entry = queue.pop();
    if (packages.has(entry.key)) continue;

    const manifest = readPackageJson(entry.directory);
    if (!manifest) throw new DependencyError(`${entry.directory} has no package.json`);

    const record = { key: entry.key, name: entry.name, directory: entry.directory, dependencies: [] };
    packages.set(entry.key, record);

    const declared = {
      ...(manifest.dependencies ?? {}),
      ...(manifest.optionalDependencies ?? {}),
    };
    const optionalNames = new Set([
      ...Object.keys(manifest.optionalDependencies ?? {}),
      ...Object.entries(manifest.peerDependenciesMeta ?? {})
        .filter(([, meta]) => meta?.optional)
        .map(([name]) => name),
    ]);
    const peerNames = new Set(Object.keys(manifest.peerDependencies ?? {}));

    for (const dependencyName of Object.keys(declared).sort()) {
      const directory = resolvePackageDirectory(entry.directory, dependencyName);
      if (!directory) {
        // A declared hard dependency that is absent is a broken install, not a
        // packaging decision. Refusing here keeps a truncated tree from looking
        // deliberate.
        if (optionalNames.has(dependencyName) || peerNames.has(dependencyName)) {
          skippedOptional.push({ from: entry.name, name: dependencyName, reason: "declared optional and not installed" });
          continue;
        }
        throw new DependencyError(`${entry.name} declares a dependency on ${dependencyName}, which is not installed`);
      }
      const resolved = pnpmKeyFor(directory, nodeModulesRoot);
      record.dependencies.push(dependencyName);
      queue.push(resolved);
    }
  }

  return {
    packages: [...packages.values()].sort((left, right) => (left.key < right.key ? -1 : left.key > right.key ? 1 : 0)),
    skippedOptional,
  };
}

// The workspace-relative specifier for each package that roots the release's
// service runtime. These are the packages the services actually import, read from
// the root `package.json` rather than listed here a second time — if a service
// starts importing something else, the closure check in `selectServicePayload`
// reports it and this function is the one place to widen.
export function serviceDependencyRoots(repositoryRoot, required) {
  const manifest = readPackageJson(repositoryRoot);
  if (!manifest) throw new DependencyError(`${repositoryRoot}/package.json is missing`);
  const available = { ...(manifest.dependencies ?? {}) };
  const missing = required.filter((name) => available[name] === undefined);
  if (missing.length > 0) {
    throw new DependencyError(
      `the services import ${missing.join(", ")}, which is not a production dependency of the root package. `
        + "Add it to \"dependencies\" (not devDependencies) so it is present on the target host.",
    );
  }
  return required;
}

// The release-relative destination of a package directory.
export function releasePathFor(key, name) {
  return `node_modules/.pnpm/${key}/node_modules/${name}`;
}

// Files that pnpm writes into the store but that a release must not carry. They
// are editors and packers scaffolding, not runtime inputs.
const EXCLUDED_BASENAMES = new Set([".npmignore", ".gitignore", ".DS_Store", ".editorconfig", ".eslintrc", ".eslintrc.js", ".eslintrc.json", ".prettierrc"]);
const EXCLUDED_DIRECTORIES = new Set([".git", ".github", "test", "tests", "__tests__", "example", "examples", "coverage", ".turbo"]);

export function planPackageFileCopy(directory) {
  const files = [];
  const directories = [];
  const excluded = [];
  const stack = [{ absolute: directory, relative: "" }];

  while (stack.length > 0) {
    const current = stack.pop();
    for (const name of readdirSync(current.absolute)) {
      const absolute = path.join(current.absolute, name);
      const relative = current.relative ? `${current.relative}/${name}` : name;
      const info = lstatSync(absolute);
      if (info.isSymbolicLink()) {
        // Links *inside* a package are resolved by the closure, never copied: the
        // closure knows the package's own resolution directory, while a copied
        // link would resolve against the release layout and could point anywhere.
        excluded.push({ relative, reason: "symlink inside a package; dependencies are materialised by name" });
        continue;
      }
      if (info.isDirectory()) {
        // A package's own `node_modules` is skipped: pnpm expresses those edges as
        // sibling links under `.pnpm/<key>/node_modules`, and copying the nested
        // directory as well would give two copies of the same dependency that can
        // drift apart. The closure is the single source of truth.
        if (name === "node_modules") {
          excluded.push({ relative, reason: "nested node_modules; dependencies come from the closure" });
          continue;
        }
        if (EXCLUDED_DIRECTORIES.has(name)) {
          excluded.push({ relative, reason: "test/example directory" });
          continue;
        }
        directories.push(relative);
        stack.push({ absolute, relative });
        continue;
      }
      if (EXCLUDED_BASENAMES.has(name)) {
        excluded.push({ relative, reason: "scaffolding file" });
        continue;
      }
      files.push({ absolute, relative, size: info.size, mode: info.mode & 0o777 });
    }
  }

  files.sort((left, right) => (left.relative < right.relative ? -1 : left.relative > right.relative ? 1 : 0));
  directories.sort();
  excluded.sort((left, right) => (left.relative < right.relative ? -1 : 1));
  return { files, directories, excluded };
}

// The links a released package needs: its own name at the top level for each root,
// and a sibling link for every dependency edge.
export function planDependencyLinks({ nodeModulesRoot, closure, roots }) {
  const links = [];
  for (const record of closure.packages) {
    const owner = path.join(nodeModulesRoot, ".pnpm", record.key, "node_modules");
    for (const dependencyName of record.dependencies) {
      const directory = resolvePackageDirectory(path.join(nodeModulesRoot, ".pnpm", record.key, "node_modules", record.name), dependencyName);
      if (!directory) continue;
      const target = pnpmKeyFor(directory, nodeModulesRoot);
      const from = path.join(owner, dependencyName);
      const to = path.join(nodeModulesRoot, ".pnpm", target.key, "node_modules", target.name);
      links.push({
        path: `node_modules/.pnpm/${record.key}/node_modules/${dependencyName}`,
        target: path.relative(path.dirname(from), to).split(path.sep).join("/"),
        owner: record.key,
        name: dependencyName,
      });
    }
  }

  for (const name of roots) {
    const directory = resolvePackageDirectory(nodeModulesRoot, name);
    if (!directory) continue;
    const target = pnpmKeyFor(directory, nodeModulesRoot);
    const from = path.join(nodeModulesRoot, name);
    const to = path.join(nodeModulesRoot, ".pnpm", target.key, "node_modules", target.name);
    links.push({
      path: `node_modules/${name}`,
      target: path.relative(path.dirname(from), to).split(path.sep).join("/"),
      owner: null,
      name,
    });
  }

  links.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  return links;
}

// A stable, human-readable summary for the manifest and the build log.
export function describeClosure(closure) {
  return {
    packages: closure.packages.length,
    keys: closure.packages.map((record) => record.key),
    skippedOptional: closure.skippedOptional,
  };
}

// ---------------------------------------------------------------------------
// Materialisation
// ---------------------------------------------------------------------------

const MODE_DIRECTORY = 0o755;
const MODE_FILE = 0o644;
const MODE_EXECUTABLE = 0o755;

// Hard-links when the filesystem allows it and falls back to a copy when it does
// not. `linkSync` failing with `EXDEV` is the normal case on a machine whose temp
// directory is a different volume from the checkout, which is exactly what CI
// runners and macOS do.
function placeFile(source, destination, mode, counters, linkFirst) {
  mkdirSync(path.dirname(destination), { recursive: true });
  // `COPYFILE_FICLONE` lets a copy-on-write filesystem clone instead of copying;
  // where it is unsupported Node falls back to a real copy by itself.
  const copy = () => copyFileSync(source, destination, constants.COPYFILE_FICLONE);
  if (linkFirst) {
    try {
      linkSync(source, destination);
    } catch {
      copy();
    }
  } else {
    copy();
  }
  // The mode is set explicitly rather than inherited, so the archive's mode
  // normalisation has nothing to do: a package that shipped an executable bit on
  // the wrong file is the same in every build either way.
  chmodSync(destination, mode);
  counters.files += 1;
  counters.bytes += statSync(destination).size;
}

// Writes the service dependency closure into `releaseRoot`.
//
// Returns counts plus the link list, so the caller can cross-check what was
// written against what was planned — a plan that is not verified by the result is
// documentation, not a guarantee.
export function materializeDependencies({ releaseRoot, nodeModulesRoot, closure, roots, hardlink = true }) {
  const counters = { files: 0, bytes: 0 };
  const directoryCount = { directories: 0 };
  const excluded = [];

  for (const record of closure.packages) {
    const destination = path.join(releaseRoot, releasePathFor(record.key, record.name));
    const plan = planPackageFileCopy(record.directory);
    for (const relative of plan.directories) {
      mkdirSync(path.join(destination, relative), { recursive: true, mode: MODE_DIRECTORY });
      directoryCount.directories += 1;
    }
    // Deepest first is not needed for directory creation, but the mode is applied
    // to every directory the package declares so a restrictive source directory
    // cannot make the release unreadable for the service user.
    mkdirSync(destination, { recursive: true, mode: MODE_DIRECTORY });
    chmodSync(destination, MODE_DIRECTORY);

    for (const file of plan.files) {
      const mode = file.mode & 0o111 ? MODE_EXECUTABLE : MODE_FILE;
      placeFile(file.absolute, path.join(destination, file.relative), mode, counters, hardlink);
    }
    for (const entry of plan.excluded) {
      excluded.push({ package: record.key, path: `${releasePathFor(record.key, record.name)}/${entry.relative}`, reason: entry.reason });
    }
  }

  const links = planDependencyLinks({ nodeModulesRoot, closure, roots });
  for (const link of links) {
    const destination = path.join(releaseRoot, link.path);
    mkdirSync(path.dirname(destination), { recursive: true });
    symlinkSync(link.target, destination);
  }

  return { ...counters, directories: directoryCount.directories, links, excluded, packages: closure.packages.length };
}

