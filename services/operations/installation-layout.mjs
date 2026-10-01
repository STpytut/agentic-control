// Where this installation keeps what is not a runtime's own.
//
// Separate from the adapter registry on purpose. A workspace root is platform
// layout, not adapter metadata: if descriptors carried it, two of them could
// declare two different project roots, and something would have to decide which
// one a project lives under. Here there is one.
//
// Closed, like the registry. Every entry is created by tmpfiles with exactly this
// owner, group and mode, and `unit-contract.test.mjs` and
// `runtime-registry.test.mjs` compare the units, the installer, the backup set
// and the web tier's default against it. The paths still carry the proof of
// concept's name; WP-5c moves them, starting here.

export const INSTALLATION_LAYOUT = Object.freeze({
  // Every project's checkout, one directory per project id.
  workspaceRoot: Object.freeze({ path: "/srv/infra-cod/workspaces", owner: "root", group: "root", mode: 0o755 }),
  // Scratch space for model verification gates. setgid, so what a gate creates
  // stays in the group the catalog worker can clean up.
  gateSmokeRoot: Object.freeze({ path: "/srv/infra-cod/gate-smoke", owner: "root", group: "infra-control", mode: 0o2771 }),
  githubDeployKeys: Object.freeze({ path: "/etc/infra-cod/github-deploy-keys", owner: "root", group: "infra-control", mode: 0o750 }),
  githubApp: Object.freeze({ path: "/etc/infra-cod/github-app", owner: "root", group: "infra-cod-github", mode: 0o750 }),
  // The runtime fence, deliberately outside every unit's RuntimeDirectory: a
  // lock is on an inode, and a directory systemd deletes on stop takes the
  // exclusion with it while leaving both holders believing they have it.
  runtimeFence: Object.freeze({ path: "/var/lib/infra-cod/runtime-fence", owner: "root", group: "root", mode: 0o755 }),
});

export function layoutPaths() {
  return Object.values(INSTALLATION_LAYOUT);
}
