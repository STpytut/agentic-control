import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { chmod, mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { assertTrustedDirectoryChain } from "../trusted-directory.mjs";

async function fixture() {
  const boundary = await realpath(await mkdtemp(path.join(tmpdir(), "trusted-root-")));
  const parent = path.join(boundary, "service");
  const root = path.join(parent, "workspaces");
  await mkdir(root, { recursive: true, mode: 0o755 });
  return { boundary, parent, root };
}

test("accepts a real, owner-only-writable directory chain", async () => {
  const item = await fixture();
  try {
    assert.equal(await assertTrustedDirectoryChain(item.root, {
      boundary: item.boundary, ownerUid: process.getuid(),
    }), item.root);
  } finally { await rm(item.boundary, { recursive: true, force: true }); }
});

test("rejects a writable parent even when the workspace root itself is safe", async () => {
  const item = await fixture();
  try {
    await chmod(item.parent, 0o775);
    await assert.rejects(assertTrustedDirectoryChain(item.root, {
      boundary: item.boundary, ownerUid: process.getuid(),
    }), /group- or world-writable/);
  } finally { await rm(item.boundary, { recursive: true, force: true }); }
});

test("rejects a symlink in the protected chain", async () => {
  const boundary = await realpath(await mkdtemp(path.join(tmpdir(), "trusted-root-")));
  try {
    const realParent = path.join(boundary, "real");
    const linkedParent = path.join(boundary, "linked");
    await mkdir(path.join(realParent, "workspaces"), { recursive: true });
    await symlink(realParent, linkedParent);
    await assert.rejects(assertTrustedDirectoryChain(path.join(linkedParent, "workspaces"), {
      boundary, ownerUid: process.getuid(),
    }), /must not contain symlinks/);
  } finally { await rm(boundary, { recursive: true, force: true }); }
});

test("rejects a chain owned by an unexpected uid", async () => {
  const item = await fixture();
  try {
    await assert.rejects(assertTrustedDirectoryChain(item.root, {
      boundary: item.boundary, ownerUid: process.getuid() + 1,
    }), /must be owned by uid/);
  } finally { await rm(item.boundary, { recursive: true, force: true }); }
});

test("the filesystem root is contained by the default boundary", async () => {
  // `path.parse("/x").root` is "/", and the containment test appended a
  // separator to it — so the prefix was "//" and no absolute path matched. Every
  // caller that did not pass its own boundary was refused, which is why the
  // runtime supervisor could not start on any host: its first act is this check
  // on /srv/infra-cod/workspaces, with the default boundary.
  assert.equal(await assertTrustedDirectoryChain("/", { ownerUid: 0 }), "/");
});

test("the default boundary rejects on ownership, never on containment", async () => {
  // A temporary directory's parents are root-owned on macOS and runner-owned on
  // Linux, so what this can assert portably is the thing that was broken: the
  // path is inside the boundary, and any complaint is about the chain itself.
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), "trusted-default-")));
  try {
    await assertTrustedDirectoryChain(directory, { ownerUid: process.getuid() });
  } catch (error) {
    assert.doesNotMatch(error.message, /does not contain/,
      "an absolute path was reported as outside the filesystem root");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a boundary that does not contain the directory is still refused", async () => {
  const boundary = await realpath(await mkdtemp(path.join(tmpdir(), "trusted-elsewhere-")));
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), "trusted-target-")));
  try {
    await assert.rejects(
      assertTrustedDirectoryChain(directory, { boundary, ownerUid: process.getuid() }),
      /does not contain/,
    );
  } finally {
    await rm(boundary, { recursive: true, force: true });
    await rm(directory, { recursive: true, force: true });
  }
});
