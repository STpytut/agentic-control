const ACTIONS = Object.freeze({
  prepare_github_app_workspace: "prepare",
  finalize_github_app_workspace: "finalize",
  abort_github_app_workspace: "abort",
  // Sprint B P1: the approved commit's objects, exported from the workspace
  // for the broker to push, and the export removed when it is done.
  export_publish_commit: "publish_export",
  release_publish_export: "publish_release",
});

const PUBLISH_ACTIONS = new Set(["publish_export", "publish_release"]);

export function githubWorkspaceAction(type) {
  return ACTIONS[type] ?? null;
}

export function isPublishAction(action) {
  return PUBLISH_ACTIONS.has(action);
}

export function githubWorkspaceRequest(type, projectId) {
  const action = githubWorkspaceAction(type);
  if (!action || isPublishAction(action)) throw new Error("unsupported github workspace request");
  return { type, project_id: projectId };
}

export function githubPublishRequest(type, intentId) {
  if (!isPublishAction(githubWorkspaceAction(type))) throw new Error("unsupported github publish request");
  return { type, intent_id: intentId };
}
