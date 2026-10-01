// The approved commit of a publish, read from the workspace (sprint B P1).
//
// `runGit(args, { input })` runs git in the workspace as its owner and
// resolves to `{ code, stdout: Buffer, stderr }` (server.mjs binds it; a test
// binds it to a local repository). Nothing here decides whether the publish
// may happen — the database did that when it named the commit — only whether
// the workspace still says what was approved.
//
// Refused when HEAD is not the prepared commit: the plan's "a repository whose
// head moved since prepare is refused, with the ref named". Otherwise the pack
// of the commit and everything it reaches, which the broker imports into a
// scratch repository of its own and pushes from there.
export async function exportApprovedCommit({ runGit, headSha }) {
  if (!/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(String(headSha))) {
    return { refused: "publish_export_failed", message: "the prepared commit id is malformed" };
  }
  const head = await runGit(["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]);
  const currentSha = head.code === 0 ? head.stdout.toString("utf8").trim() : "";
  const symbolic = await runGit(["symbolic-ref", "--quiet", "HEAD"]);
  const headRef = symbolic.code === 0 ? symbolic.stdout.toString("utf8").trim() : "HEAD (detached)";
  if (currentSha !== headSha) {
    return {
      refused: "publish_head_moved", head_ref: headRef, head_sha: currentSha,
      message: `${headRef} is at ${currentSha || "no commit"}; the publish was prepared at ${headSha}`,
    };
  }
  const packed = await runGit(["-c", "core.fsmonitor=false", "pack-objects", "--revs", "--stdout", "-q"],
    { input: `${headSha}\n` });
  if (packed.code !== 0 || !packed.stdout.length) {
    return { refused: "publish_export_failed", message: `git pack-objects: ${String(packed.stderr ?? "").trim().slice(0, 300)}` };
  }
  return { pack: packed.stdout, head_ref: headRef, head_sha: currentSha };
}
