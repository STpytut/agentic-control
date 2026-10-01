// A read-only launch, against the real kernel (11.2 N4, D5).
//
// The claim is the kernel's, so it is tested on one: where Linux has Landlock —
// the gate's container and the host both do — a process started through
// readOnlyLaunchArgv reads the workspace, writes its own state path, and is
// refused a write to the workspace with EACCES; so is a shell it starts. The
// control: the same writes without the launch succeed. Elsewhere (macOS) the
// test says why it skipped rather than passing.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { READ_ONLY_LAUNCH_EXIT, readOnlyLaunchArgv } from "../read-only-launch.mjs";

function landlockAbi() {
  if (process.platform !== "linux") return 0;
  const probe = spawnSync("python3", ["-c",
    "import ctypes;l=ctypes.CDLL(None);print(l.syscall(444,None,ctypes.c_size_t(0),ctypes.c_uint32(1)))"], { encoding: "utf8" });
  return probe.status === 0 ? Number(probe.stdout.trim()) : 0;
}
const abi = landlockAbi();
const skip = abi < 1 ? `needs Linux with Landlock (this is ${process.platform}, ABI ${abi})` : false;

function run(argv) {
  const [command, ...args] = argv;
  return spawnSync(command, args, { encoding: "utf8" });
}

test("a read-only launch reads the workspace, writes its own state, and cannot write the workspace", { skip }, () => {
  const base = mkdtempSync(path.join(os.tmpdir(), "read-only-launch-"));
  try {
    const workspace = path.join(base, "workspace");
    const state = path.join(base, "state");
    mkdirSync(workspace);
    mkdirSync(state);
    writeFileSync(path.join(workspace, "README.md"), "hello\n");
    const script = [
      "set -u",
      `cat ${workspace}/README.md`,
      `echo state > ${state}/written && echo STATE_OK`,
      `(echo nope > ${workspace}/README.md) 2>/dev/null && echo EDIT_OK || echo EDIT_REFUSED`,
      `(echo nope > ${workspace}/new.txt) 2>/dev/null && echo CREATE_OK || echo CREATE_REFUSED`,
      `(rm ${workspace}/README.md) 2>/dev/null && echo REMOVE_OK || echo REMOVE_REFUSED`,
      `(mkdir ${workspace}/dir) 2>/dev/null && echo MKDIR_OK || echo MKDIR_REFUSED`,
    ].join("\n");

    const confined = run(readOnlyLaunchArgv([state, "/dev/null"], "/bin/sh", ["-c", script], { python: "python3" }));
    assert.equal(confined.status, 0, confined.stderr);
    for (const line of ["hello", "STATE_OK", "EDIT_REFUSED", "CREATE_REFUSED", "REMOVE_REFUSED", "MKDIR_REFUSED"]) {
      assert.ok(confined.stdout.split("\n").includes(line), `expected ${line}:\n${confined.stdout}`);
    }
    assert.equal(readFileSync(path.join(workspace, "README.md"), "utf8"), "hello\n");
    assert.ok(!existsSync(path.join(workspace, "new.txt")));
    assert.equal(readFileSync(path.join(state, "written"), "utf8"), "state\n");

    // The control: the same writes, unconfined, succeed — so the refusals
    // above are the ruleset's, not the directory's permissions.
    const free = run(["/bin/sh", "-c", script]);
    for (const line of ["EDIT_OK", "CREATE_OK", "REMOVE_OK", "MKDIR_OK"]) {
      assert.ok(free.stdout.split("\n").includes(line), `the control could not ${line}:\n${free.stdout}`);
    }
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("a read-only launch with nothing to run is refused, not run", { skip }, () => {
  const argv = readOnlyLaunchArgv([], "/bin/true", [], { python: "python3" });
  const refused = run(argv.slice(0, argv.indexOf("--")));
  assert.equal(refused.status, READ_ONLY_LAUNCH_EXIT);
  assert.match(refused.stderr, /refused rather than run unconfined/);
});

test("a writable path must be absolute and below the root", () => {
  assert.throws(() => readOnlyLaunchArgv(["/"], "/bin/true"), /absolute and below/);
  assert.throws(() => readOnlyLaunchArgv(["relative"], "/bin/true"), /absolute and below/);
  assert.throws(() => readOnlyLaunchArgv(["/a/../b"], "/bin/true"), /absolute and below/);
  assert.deepEqual(readOnlyLaunchArgv(["/s"], "/bin/true", ["x"]).slice(-4), ["/s", "--", "/bin/true", "x"]);
});
