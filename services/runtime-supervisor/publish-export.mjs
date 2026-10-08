// The approved commit of a publish, read from the workspace (sprint B P1).
//
// `runGit(args, { input })` runs git in the workspace as its owner and
// resolves to `{ code, stdout: Buffer, stderr }` (server.mjs binds it; a test
// binds it to a local repository). Nothing here decides whether the publish
// may happen — the database did that when it named the commit — only whether
// the workspace still says what was approved.
//
// Refused when the workspace no longer holds the prepared commit, with the ref
// named. Its HEAD may have moved on past it — the next task committed on top
// (0150) — and the commit is still the one approved: an id names its tree and
// history. Otherwise the pack of the commit and everything it reaches, which
// the broker imports into a scratch repository of its own and pushes from there.
export async function exportApprovedCommit({ runGit, headSha }) {
  if (!/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(String(headSha))) {
    return { refused: "publish_export_failed", message: "the prepared commit id is malformed" };
  }
  const head = await runGit(["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]);
  const currentSha = head.code === 0 ? head.stdout.toString("utf8").trim() : "";
  const symbolic = await runGit(["symbolic-ref", "--quiet", "HEAD"]);
  const headRef = symbolic.code === 0 ? symbolic.stdout.toString("utf8").trim() : "HEAD (detached)";
  const held = currentSha === headSha
    || (await runGit(["-c", "core.fsmonitor=false", "merge-base", "--is-ancestor", headSha, "HEAD"])).code === 0;
  if (!held) {
    return {
      refused: "publish_head_moved", head_ref: headRef, head_sha: currentSha,
      message: `${headRef} is at ${currentSha || "no commit"}, which does not contain ${headSha}, the commit the publish was prepared at`,
    };
  }
  const packed = await runGit(["-c", "core.fsmonitor=false", "pack-objects", "--revs", "--stdout", "-q"],
    { input: `${headSha}\n` });
  if (packed.code !== 0 || !packed.stdout.length) {
    return { refused: "publish_export_failed", message: `git pack-objects: ${String(packed.stderr ?? "").trim().slice(0, 300)}` };
  }
  return { pack: packed.stdout, head_ref: headRef, head_sha: headSha };
}
