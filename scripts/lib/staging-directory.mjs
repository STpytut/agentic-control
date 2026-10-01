// The staging directory, and the guards that decide whether it may be destroyed.
//
// This lives in its own module because it is the one destructive thing the
// staging script does. `rmSync(path, { recursive: true })` on a path that arrived
// from `--out` or an environment variable has no undo: a typo, an unset variable
// or a copy-pasted command pointing at `/`, the checkout or the live release
// takes the target with it. Being importable means the refusals can be tested
// against real temporary directories rather than argued about in a comment.

import { existsSync, lstatSync, mkdirSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// Written by every run, and required before an existing directory may be
// replaced. A directory that does not carry it was not created by us, whatever
// its name.
export const STAGING_MARKER = ".infra-cod-staging";

// The paths a staging tree is never allowed to be, described for the error
// message. `root` and `appDirectory` are the caller's; the fixed entries are the
// installation layout.
export function protectedDirectories({ repositoryRoot, appDirectory }) {
  return new Map([
    [path.parse(path.resolve(repositoryRoot)).root, "the filesystem root"],
    [path.resolve(os.homedir()), "the home directory"],
    [path.resolve(repositoryRoot), "the repository"],
    [path.resolve(appDirectory), "the web application directory"],
    [path.join(path.resolve(appDirectory), ".next"), "the build directory"],
    ["/opt/infra-cod", "the installed application root"],
    ["/opt/infra-cod/current", "the live release"],
  ]);
}

// The path with every symlink in it resolved — the final component included, and
// always the real target. The components that do not exist yet are kept as they
// were written.
//
// `path.resolve` is lexical: it does not look at the filesystem, so
// `alias/.next` stays `alias/.next` even when `alias` is a symlink into a
// protected directory. Comparing that against the protected list accepts it, and
// the write then lands wherever the link points — the guard is bypassed by a name
// that looks innocent. Resolving the existing prefix with `realpath` and only
// then re-appending the components that do not exist closes that: the comparison
// is against where the path actually goes.
//
// This function reports where a path goes and nothing else. An earlier version
// tried to preserve the *name* of a symlinked final component so a separate check
// could see it, which was wrong: for `links/out -> ../targets/actual` it produced
// `targets/out` — a path that is neither the link nor the target, and a directory
// that did not exist until staging created it. The symlink check belongs at the
// original path, and it lives in `assertStagingDirectory`.
export function canonicalPath(directory) {
  const resolved = path.resolve(directory);
  const trailing = [];
  let current = resolved;

  // Walk up to the nearest component that exists, recording what was skipped.
  while (!existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) break;
    trailing.unshift(path.basename(current));
    current = parent;
  }

  const real = existsSync(current) ? realpathSync(current) : current;
  return path.resolve(real, ...trailing);
}

// The path exactly as written, before any resolution.
export function lexicalPath(directory) {
  return path.resolve(directory);
}

// Whether the path's own final component is a symlink. Anything else — a missing
// component, a symlinked ancestor — is not what this asks about, and is handled by
// comparing canonical paths.
export function finalComponentIsSymlink(directory) {
  const resolved = lexicalPath(directory);
  try {
    return lstatSync(resolved).isSymbolicLink();
  } catch {
    // Missing, or a component that cannot be reached. Neither is a symlink at the
    // final component, and both are caught by whatever comes next.
    return false;
  }
}

// Throws unless `directory` is somewhere it is safe to stage into.
export function assertStagingDirectory(directory, { repositoryRoot, appDirectory }) {
  // Checked on the original path, before anything resolves it: refusing to stage
  // onto a symlink is what stops a link from deciding where the tree is written
  // and what a later run is allowed to delete.
  if (finalComponentIsSymlink(directory)) {
    throw new Error(`staging directory is a symlink (${lexicalPath(directory)}); refusing to use it`);
  }

  const resolved = canonicalPath(directory);

  if (resolved === path.parse(resolved).root) {
    throw new Error(`staging directory is the filesystem root (${resolved}); refusing to stage there`);
  }

  for (const [guarded, label] of protectedDirectories({ repositoryRoot, appDirectory })) {
    // The protected paths are canonical too. A repository reached through a
    // symlink would otherwise not match by string, and the lexical check would
    // pass while the canonical path is inside it.
    const guardedCanonical = canonicalPath(guarded);
    if (resolved === guardedCanonical) {
      throw new Error(`staging directory is ${label} (${resolved}); refusing to stage there`);
    }
    // An ancestor of a protected path is protected too: deleting it deletes the
    // protected path with it. `/opt` is not on the list, but `/opt/infra-cod` is,
    // and `/opt` contains it.
    if (guardedCanonical.startsWith(`${resolved}${path.sep}`)) {
      throw new Error(
        `staging directory (${resolved}) contains ${label} (${guardedCanonical}); refusing to stage there`,
      );
    }
  }

  return resolved;
}

// Makes `directory` an empty directory that may be written into, creating it if
// necessary and replacing it only when it is recognisably ours.
export function prepareStagingDirectory(directory, { repositoryRoot, appDirectory }) {
  const resolved = assertStagingDirectory(directory, { repositoryRoot, appDirectory });

  if (existsSync(resolved)) {
    // The final component of the *original* path was already checked for being a
    // symlink, so this only has to establish what the canonical path is.
    if (!lstatSync(resolved).isDirectory()) {
      throw new Error(`staging directory exists and is not a directory (${resolved})`);
    }

    const contents = readdirSync(resolved);
    if (contents.length > 0 && !contents.includes(STAGING_MARKER)) {
      throw new Error(
        `staging directory is not empty and does not carry the ${STAGING_MARKER} marker (${resolved}). `
        + "Refusing to delete it: pick an empty directory, or one this script created before.",
      );
    }
    rmSync(resolved, { recursive: true, force: true });
  }

  mkdirSync(resolved, { recursive: true });
  // Written first, so an interrupted run still leaves a directory the next run is
  // allowed to replace.
  writeFileSync(path.join(resolved, STAGING_MARKER), `${STAGING_MARKER}\n`);
  return resolved;
}
