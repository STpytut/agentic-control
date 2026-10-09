const ACTIONS = Object.freeze({
  prepare_github_app_workspace: "prepare",
  finalize_github_app_workspace: "finalize",
  abort_github_app_workspace: "abort",
  // Sprint B P1: the approved commit's objects, exported from the workspace
  // for the broker to push, and the export removed when it is done.
  export_publish_commit: "publish_export",
  release_publish_export: "publish_release",
  // 0145: GitHub's base branch, fetched by the broker into a bundle in an
  // inbox the supervisor makes, applied to the workspace by the supervisor.
  prepare_workspace_sync: "sync_prepare",
  apply_workspace_sync: "sync_apply",
  release_workspace_sync: "sync_release",
  // rc.145 (0153): a pull request's head and base, bundled by the broker into
  // an inbox the supervisor makes for a review, which the review run reads.
  prepare_pr_review: "review_prepare",
  release_pr_review: "review_release",
});

const PUBLISH_ACTIONS = new Set(["publish_export", "publish_release"]);
const SYNC_ACTIONS = new Set(["sync_prepare", "sync_apply", "sync_release"]);
const REVIEW_ACTIONS = new Set(["review_prepare", "review_release"]);

export function githubWorkspaceAction(type) {
  return ACTIONS[type] ?? null;
}

export function isPublishAction(action) {
  return PUBLISH_ACTIONS.has(action);
}

export function isSyncAction(action) {
  return SYNC_ACTIONS.has(action);
}

export function isReviewAction(action) {
  return REVIEW_ACTIONS.has(action);
}

export function githubReviewRequest(type, reviewId) {
  if (!isReviewAction(githubWorkspaceAction(type))) throw new Error("unsupported github review request");
  return { type, review_id: reviewId };
}

export function githubSyncRequest(type, syncId) {
  if (!isSyncAction(githubWorkspaceAction(type))) throw new Error("unsupported github sync request");
  return { type, sync_id: syncId };
}

export function githubWorkspaceRequest(type, projectId) {
  const action = githubWorkspaceAction(type);
  if (!action || isPublishAction(action) || isSyncAction(action) || isReviewAction(action)) throw new Error("unsupported github workspace request");
  return { type, project_id: projectId };
}

export function githubPublishRequest(type, intentId) {
  if (!isPublishAction(githubWorkspaceAction(type))) throw new Error("unsupported github publish request");
  return { type, intent_id: intentId };
}
