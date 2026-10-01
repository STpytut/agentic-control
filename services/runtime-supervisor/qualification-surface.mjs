// The qualification surface (Stage 12 W3, RUNTIMES_AND_MODELS_DESIGN §3.2):
// where a candidate version runs its checks, and with what.
//
// A candidate runs the driver's own argv and environment, launched the way a
// task's run is — the same runuser, cgroup and read-only ruleset — with three
// things changed and nothing else:
//
//   * the executable is the candidate's, chosen by exact version from the
//     inventory root keeps (a closed set: never a path a request supplies), and
//     held to the digest recorded when it was installed;
//   * HOME is a scratch home under the gate root holding a copy of the
//     runtime's login and configuration, made by the runtime's own user — so a
//     candidate that migrates its state store migrates a copy, and this process
//     never reads a credential's bytes;
//   * the workspace is a scratch git repository beside that home.
//
// Pure where it can be, so the rules are tested without a host.

import path from "node:path";

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const VERSION = /^\d+\.\d+\.\d+$/;

// Where one qualification lives. The id is the database's (a uuid), so the
// path cannot be steered.
export function qualificationPaths(gateRoot, id) {
  if (!ID.test(String(id ?? ""))) throw new Error("qualification id is not a uuid");
  const root = path.join(gateRoot, "qualification", id);
  return { root, workspace: path.join(root, "workspace"), home: path.join(root, "home") };
}

// The executable of an exact recorded version. Candidate or active, it must be
// a tree the inventory names; the digest recorded at install must match.
export function qualificationExecutable(adapter, version, { inventory, digestOf }) {
  if (!VERSION.test(String(version ?? ""))) throw new Error("qualification version is not exact");
  const entry = inventory?.[adapter.name];
  const recorded = (entry?.installed ?? []).filter((installed) => installed.version === version);
  // The newest tree of that version: a rebuilt package is a new directory.
  const installation = recorded.sort((left, right) => String(right.installedAt).localeCompare(String(left.installedAt)))[0];
  if (!installation) throw new Error(`${adapter.name} ${version} is not installed on this host`);
  const executable = path.join(installation.directory, adapter.executablePath);
  if (!installation.executableSha256) throw new Error(`${adapter.name} ${version} has no recorded executable digest`);
  const actual = digestOf(executable);
  if (actual !== installation.executableSha256) {
    throw new Error(`${adapter.name} ${version}'s executable is not the one recorded at install`);
  }
  return executable;
}

// A path under the runtime's real home, moved under the scratch home.
export function inScratchHome(adapter, home, file) {
  if (file === adapter.home) return home;
  if (!file.startsWith(`${adapter.home}/`)) return file;
  return path.join(home, file.slice(adapter.home.length + 1));
}

// What a read-only launch may still write, for a candidate: the driver's list,
// with the runtime's own state moved into the scratch home.
export function scratchReadOnlyWritable(driver, adapter, home) {
  return (driver.run.readOnlyWritable ?? []).map((file) => inScratchHome(adapter, home, file));
}

// The runtime's writable state inside its home, as paths relative to the home.
// A read-only launch skips a writable path that does not exist yet, and the
// scratch home itself is not writable under it, so a directory missing there
// is one the runtime cannot create: OpenCode 1.18.32 died with EACCES on
// ~/.cache in the first host qualification (Stage 12 W3).
export function writableStateInHome(adapter) {
  return (adapter.writableState ?? [])
    .filter((file) => file.startsWith(`${adapter.home}/`))
    .map((file) => file.slice(adapter.home.length + 1));
}

// What is copied into the scratch home, as paths relative to the home. Declared
// by the adapter; a path outside the home is refused.
export function stateToCopy(adapter) {
  const files = adapter.qualificationState ?? [];
  for (const file of files) {
    if (path.isAbsolute(file) || file.split("/").includes("..")) throw new Error(`${adapter.name}: qualification state ${file} is not inside the home`);
  }
  return files;
}
