// Bringing a workspace up to date with GitHub (0145, rc.133).
//
// A workspace was cloned once and never learned what happened on GitHub after:
// a pull request merged with squash, a commit pushed by someone else, a
// Dependabot update. The next task started from the old tree, and its pull
// request carried changes already merged, or conflicted with them.
//
// The GitHub broker fetches the base branch into a bundle (it never touches
// the workspace: a repository's own git configuration can name programs, and
// the broker holds a token). This applies the bundle as the workspace's owner,
// in the workspace's turn, and decides — never losing work:
//
//   up to date            nothing to do
//   behind                fast-forward to GitHub
//   ahead                 kept: commits not on GitHub yet (a pull request not
//                         merged); the next task builds on them
//   diverged, same tree   the local commits are on GitHub in another shape
//                         (a squash merge): reset to GitHub
//   diverged              kept, and said; the owner may ask for a reset, which
//                         first keeps the local commits on a backup branch
//
// Only on the base branch and with a clean tree: anything else is kept, and
// said why. `runGit(args)` resolves to { code, stdout: Buffer|string, stderr }.

const text = (output) => String(Buffer.isBuffer(output) ? output.toString("utf8") : output ?? "").trim();
const SHA = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

export async function applyWorkspaceSync({ runGit, bundlePath, baseBranch, mode = "sync", now = new Date() }) {
  if (!/^[A-Za-z0-9._/-]{1,200}$/.test(String(baseBranch)) || String(baseBranch).includes("..")) {
    return { status: "failed", outcome: "the base branch name is not one git takes" };
  }
  const git = async (args) => runGit(["-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", ...args]);
  const status = await git(["status", "--porcelain=v1", "--untracked-files=normal"]);
  if (status.code !== 0) return { status: "failed", outcome: `git status failed: ${text(status.stderr).slice(0, 200)}` };
  if (text(status.stdout)) return { status: "kept", outcome: "the workspace has uncommitted changes; it was left as it is" };

  const branch = await git(["symbolic-ref", "--quiet", "--short", "HEAD"]);
  const current = branch.code === 0 ? text(branch.stdout) : "";
  if (current !== baseBranch) {
    return { status: "kept", outcome: `the workspace is on ${current || "a detached HEAD"}, not ${baseBranch}; it was left as it is` };
  }

  const remoteRef = `refs/remotes/origin/${baseBranch}`;
  const fetched = await git(["fetch", "--no-tags", "--quiet", bundlePath, `+refs/heads/${baseBranch}:${remoteRef}`]);
  if (fetched.code !== 0) return { status: "failed", outcome: `reading GitHub's ${baseBranch}: ${text(fetched.stderr).slice(0, 200)}` };
  const origin = text((await git(["rev-parse", "--verify", "--quiet", `${remoteRef}^{commit}`])).stdout);
  if (!SHA.test(origin)) return { status: "failed", outcome: `GitHub's ${baseBranch} could not be read from the bundle` };
  const headAnswer = await git(["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]);
  const head = headAnswer.code === 0 ? text(headAnswer.stdout) : "";

  const result = (status, outcome, extra = {}) => ({ status, outcome, origin_sha: origin, before_sha: head || null, ...extra });
  const after = async () => text((await git(["rev-parse", "HEAD"])).stdout);

  if (!head) {
    const reset = await git(["reset", "--hard", "--quiet", remoteRef]);
    if (reset.code !== 0) return result("failed", `checking out GitHub's ${baseBranch}: ${text(reset.stderr).slice(0, 200)}`);
    return result("synced", `took GitHub's ${baseBranch}`, { after_sha: await after() });
  }
  if (head === origin) return result("synced", `already at GitHub's ${baseBranch}`, { after_sha: head });

  const isAncestor = async (a, b) => (await git(["merge-base", "--is-ancestor", a, b])).code === 0;
  const count = async (range) => Number(text((await git(["rev-list", "--count", range])).stdout)) || 0;

  if (await isAncestor(head, origin)) {
    const behind = await count(`${head}..${origin}`);
    const ff = await git(["merge", "--ff-only", "--quiet", remoteRef]);
    if (ff.code !== 0) return result("failed", `fast-forwarding to GitHub: ${text(ff.stderr).slice(0, 200)}`);
    return result("synced", `brought up to date with GitHub: ${behind} new commit${behind === 1 ? "" : "s"}`, { after_sha: await after() });
  }
  const ahead = await count(`${origin}..${head}`);
  if (mode !== "reset" && await isAncestor(origin, head)) {
    return result("kept", `${ahead} local commit${ahead === 1 ? " is" : "s are"} not on GitHub yet (a pull request not merged?); the next task builds on ${ahead === 1 ? "it" : "them"}`);
  }

  const sameTree = (await git(["diff", "--quiet", head, remoteRef])).code === 0;
  if (!sameTree && mode !== "reset") {
    return result("kept", `the workspace and GitHub's ${baseBranch} have diverged (${ahead} local commit${ahead === 1 ? "" : "s"} not on GitHub); reset to GitHub from the panel to start from GitHub — the local commits are kept on a backup branch`);
  }
  let backup = null;
  if (!sameTree) {
    backup = `infra-cod/backup/${now.toISOString().slice(0, 19).replace(/[:T]/g, "-")}`;
    const saved = await git(["branch", backup, head]);
    if (saved.code !== 0) return result("failed", `keeping the local commits on ${backup}: ${text(saved.stderr).slice(0, 200)}`);
  }
  const reset = await git(["reset", "--hard", "--quiet", remoteRef]);
  if (reset.code !== 0) return result("failed", `resetting to GitHub: ${text(reset.stderr).slice(0, 200)}`);
  return result("synced", sameTree
    ? `the local commits are on GitHub as merged (same tree): reset to GitHub's ${baseBranch}`
    : `reset to GitHub's ${baseBranch}; the ${ahead} local commit${ahead === 1 ? " is" : "s are"} kept on ${backup}`,
  { after_sha: await after(), backup_ref: backup });
}
