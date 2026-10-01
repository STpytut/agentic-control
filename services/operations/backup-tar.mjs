// What a backup's tar may say and still be a backup (rc.107's update).
//
// The archive covers live directories: every workspace and each runtime's home,
// where a runtime writes whenever it runs — Codex's ~/.codex during a model
// check, say. GNU tar reads a file that changes under it, says "file changed as
// we read it" and exits 1; that is a warning, the archive is whole, and the file
// is as it was when read. Exit 1 failed the pre-update backup, and with it the
// update, on a host doing nothing wrong. Exit 2 is tar failing, and so is exit 1
// with anything else in stderr: those still fail the backup.
const TOLERATED = [
  /^tar: (.+): file changed as we read it$/,
  /^tar: (.+): File removed before we read it$/,
  /^tar: (.+): socket ignored$/,
];

// `{ status, stderr }` from spawnSync → the paths tar warned about, or throws.
export function archiveOutcome({ status, stderr }) {
  if (status === 0) return { warned: [] };
  const lines = String(stderr ?? "").split("\n").map((line) => line.trim()).filter(Boolean);
  const warned = [];
  for (const line of lines) {
    const match = TOLERATED.map((pattern) => pattern.exec(line)).find(Boolean);
    if (!match) {
      throw new Error(`tar failed (exit ${status}): ${lines.join("; ").slice(0, 1000)}`);
    }
    warned.push({ path: match[1], warning: line.slice(`tar: ${match[1]}: `.length) });
  }
  if (status !== 1 || !warned.length) {
    throw new Error(`tar failed (exit ${status}): ${lines.join("; ").slice(0, 1000) || "no message"}`);
  }
  return { warned };
}
