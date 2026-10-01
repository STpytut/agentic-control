import path from "node:path";
import { lstat, realpath } from "node:fs/promises";

// Verifies the complete directory chain which protects a privileged leaf.
// Checking only the leaf is insufficient: write access to any parent permits
// replacing the component below it after the check.
export async function assertTrustedDirectoryChain(directory, {
  boundary = path.parse(path.resolve(directory)).root,
  ownerUid = 0,
} = {}) {
  const resolvedDirectory = path.resolve(directory);
  const resolvedBoundary = path.resolve(boundary);
  // The filesystem root already ends in a separator, and appending another
  // produced `//` — which nothing starts with. The default boundary is the root,
  // so every caller that did not pass one of its own was refused: the runtime
  // supervisor could not start on any host, because its very first act is this
  // check on /srv/infra-cod-handoff-poc/workspaces. The unit tests all passed a
  // temporary directory as the boundary, so none of them ever reached this.
  const boundaryPrefix = resolvedBoundary.endsWith(path.sep)
    ? resolvedBoundary
    : `${resolvedBoundary}${path.sep}`;
  if (resolvedDirectory !== resolvedBoundary && !resolvedDirectory.startsWith(boundaryPrefix)) {
    throw new Error(`trusted boundary ${resolvedBoundary} does not contain ${resolvedDirectory}`);
  }

  const canonicalDirectory = await realpath(resolvedDirectory);
  const canonicalBoundary = await realpath(resolvedBoundary);
  if (canonicalDirectory !== resolvedDirectory || canonicalBoundary !== resolvedBoundary) {
    throw new Error("trusted directory chain must not contain symlinks");
  }

  for (let current = canonicalDirectory; ; current = path.dirname(current)) {
    const entry = await lstat(current);
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      throw new Error(`${current} must be a real directory`);
    }
    if (entry.uid !== ownerUid) {
      throw new Error(`${current} must be owned by uid ${ownerUid}, not uid ${entry.uid}`);
    }
    if (entry.mode & 0o022) {
      throw new Error(
        `${current} must not be group- or world-writable (mode ${(entry.mode & 0o7777).toString(8)})`,
      );
    }
    if (current === canonicalBoundary) break;
  }
  return canonicalDirectory;
}
