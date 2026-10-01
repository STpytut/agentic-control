// Where a release build is allowed to write, and what it is allowed to delete.
//
// The release builder removes its work directory between runs and creates the
// final artifacts directory if it is missing. Both are destructive operations on a
// path that arrives from a command-line flag, so both go through the same guard
// the staging script already uses rather than a second, slightly different idea of
// what "safe" means. The guard is imported, not reimplemented: two copies of a
// safety rule is how the two copies drift.
//
// Beyond the shared guard, a release has two extra concerns:
//
//   * the artifacts directory is not a staging directory — it must not be deleted
//     between builds, because it holds the previously published releases;
//   * a partial archive must never appear where a consumer could pick it up, which
//     is why the builder writes to a temporary name inside the same directory and
//     renames only after the artifact verifies.

import { existsSync, lstatSync, mkdirSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { STAGING_MARKER, assertStagingDirectory, canonicalPath, finalComponentIsSymlink } from "./staging-directory.mjs";

export class OutputGuardError extends Error {
  constructor(message) {
    super(message);
    this.name = "OutputGuardError";
  }
}

// Paths the release builder may never write into, described for the error message.
// `dist` is deliberately absent: it is inside the repository and gitignored, and
// it is exactly where the artifacts belong.
export function protectedReleasePaths({ repositoryRoot, appDirectory }) {
  return new Map([
    [path.resolve(repositoryRoot), "the repository root"],
    [path.resolve(appDirectory), "the web application directory"],
    [path.join(path.resolve(appDirectory), ".next"), "the build directory"],
    [path.resolve(os.homedir()), "the home directory"],
    ["/opt/infra-cod", "the installed application root"],
    ["/opt/infra-cod/current", "the live release"],
    ["/etc/infra-cod", "the installed configuration"],
  ]);
}

// Refuses a path that is the filesystem root, an ancestor of a protected path, a
// protected path itself, or a symlink. The symlink refusal is checked on the
// literal path before anything resolves it, so a link cannot decide where the
// build writes.
export function assertSafeReleasePath(target, { repositoryRoot, appDirectory, label }) {
  if (finalComponentIsSymlink(target)) {
    throw new OutputGuardError(`${label} is a symlink (${path.resolve(target)}); refusing to use it`);
  }
  const resolved = canonicalPath(target);
  if (resolved === path.parse(resolved).root) {
    throw new OutputGuardError(`${label} is the filesystem root (${resolved}); refusing to use it`);
  }
  for (const [guarded, description] of protectedReleasePaths({ repositoryRoot, appDirectory })) {
    const canonicalGuarded = canonicalPath(guarded);
    if (resolved === canonicalGuarded) {
      throw new OutputGuardError(`${label} is ${description} (${resolved}); refusing to use it`);
    }
    if (canonicalGuarded.startsWith(`${resolved}${path.sep}`)) {
      throw new OutputGuardError(`${label} (${resolved}) contains ${description} (${canonicalGuarded}); refusing to use it`);
    }
  }
  return resolved;
}

// Creates or empties the work directory, using the shared staging semantics: a
// non-empty directory without this project's marker is refused rather than
// deleted, because a directory that does not carry the marker was not created by
// us whatever it is called.
export function prepareWorkDirectory(directory, { repositoryRoot, appDirectory }) {
  return prepareGuardedDirectory(directory, { repositoryRoot, appDirectory, label: "work directory" });
}

export function prepareGuardedDirectory(directory, { repositoryRoot, appDirectory, label }) {
  const resolved = assertSafeReleasePath(directory, { repositoryRoot, appDirectory, label });

  if (existsSync(resolved)) {
    if (!lstatSync(resolved).isDirectory()) {
      throw new OutputGuardError(`${label} exists and is not a directory (${resolved})`);
    }
    const contents = readdirSync(resolved);
    if (contents.length > 0 && !contents.includes(STAGING_MARKER)) {
      throw new OutputGuardError(
        `${label} is not empty and does not carry the ${STAGING_MARKER} marker (${resolved}). `
          + "Refusing to delete it: pick an empty directory, or one this project created before.",
      );
    }
    rmSync(resolved, { recursive: true, force: true });
  }
  mkdirSync(resolved, { recursive: true });
  writeFileSync(path.join(resolved, STAGING_MARKER), `${STAGING_MARKER}\n`);
  return resolved;
}

// The artifacts directory is created but never emptied: it holds published
// releases. A previous artifact with the same name is refused by the builder
// rather than overwritten, so a rebuild that would replace a published file is an
// explicit decision.
export function prepareArtifactsDirectory(directory, { repositoryRoot, appDirectory }) {
  const resolved = assertSafeReleasePath(directory, { repositoryRoot, appDirectory, label: "artifacts directory" });
  if (existsSync(resolved) && !lstatSync(resolved).isDirectory()) {
    throw new OutputGuardError(`artifacts directory exists and is not a directory (${resolved})`);
  }
  mkdirSync(resolved, { recursive: true });
  return resolved;
}

// Writes a file by creating a uniquely named sibling, fsyncing it and renaming it
// into place. A consumer watching the directory therefore sees either no file or a
// complete one — never a half-written archive that happens to be named correctly.
export function writeFileAtomic(finalPath, contents, { mode = 0o644 } = {}) {
  const directory = path.dirname(finalPath);
  const temporary = path.join(directory, `.${path.basename(finalPath)}.partial-${process.pid}`);
  rmSync(temporary, { force: true });
  writeFileSync(temporary, contents, { mode });
  renameSync(temporary, finalPath);
  return finalPath;
}

// The real path of a directory, used where a build needs to prove that two paths
// that look different are or are not the same place (macOS `/tmp`).
export function realDirectory(directory) {
  return realpathSync(directory);
}
