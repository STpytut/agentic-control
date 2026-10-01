import test from "node:test";
import assert from "node:assert/strict";
import { archiveOutcome } from "../backup-tar.mjs";

test("a clean archive has nothing to say", () => {
  assert.deepEqual(archiveOutcome({ status: 0, stderr: "" }), { warned: [] });
});

test("a runtime writing its home while it is read is a warning, named, not a failed backup", () => {
  // rc.107: Codex wrote ~/.codex during the pre-update backup, and the update stopped.
  const outcome = archiveOutcome({ status: 1, stderr: "tar: home/codex-worker/.codex: file changed as we read it\ntar: srv/w/x.lock: File removed before we read it\n" });
  assert.deepEqual(outcome.warned, [
    { path: "home/codex-worker/.codex", warning: "file changed as we read it" },
    { path: "srv/w/x.lock", warning: "File removed before we read it" },
  ]);
});

test("anything else from tar still fails the backup", () => {
  assert.throws(() => archiveOutcome({ status: 2, stderr: "tar: home/x: Cannot open: Permission denied\n" }), /exit 2/);
  assert.throws(() => archiveOutcome({ status: 1, stderr: "tar: home/x: file changed as we read it\ntar: Error is not recoverable: exiting now\n" }), /not recoverable/);
  assert.throws(() => archiveOutcome({ status: 2, stderr: "tar: home/x: file changed as we read it\n" }), /exit 2/);
  assert.throws(() => archiveOutcome({ status: 1, stderr: "" }), /no message/);
});
