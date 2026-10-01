// What a release installs outside its own tree, declared as data (WP-A).
//
// Before this, what a release installed was decided by the code of the release
// being replaced: `infra-cod` runs the *current* release's `update.mjs`, on
// purpose, so a lazy import after the symlink moves cannot load new code into an
// old run. The consequence was that a release could not change how it was
// installed — rc.14's own installer for the OpenCode tool definitions never ran,
// and the directory was filled by hand (defect 79). And nothing removed what a
// release stopped shipping: a withdrawn unit or tool definition stayed on the
// host for good, and a stale tool definition is a capability the product no
// longer intends to offer.
//
// Now the release's manifest carries an `install` section: the exact files it
// installs, each into one of a closed set of roots. The coordinator — whichever
// release's code it is — reconciles the host to the *staged* release's
// declaration: it installs what is declared and retires what it installed before
// and no longer is.
//
// **Data, not a script.** An entry names a source inside the release, a root from
// the vocabulary below, and a file name that root accepts. No commands, no
// arguments, no host paths: the coordinator resolves a root to a directory from
// its own code (the installation layout and the adapter registry), so a manifest
// cannot point it anywhere else. A manifest naming anything outside the
// vocabulary fails verification before an update starts.
//
// This module is pure, so the release builder and the verifier can use it
// without a host. The host side is install-reconcile.mjs.

import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

import { adapterFor, allAdapters } from "./runtime-adapters.mjs";

// The contract versions this code understands. A manifest declaring another one
// is refused rather than half-applied.
export const INSTALL_CONTRACT_VERSION = 1;
export const SUPPORTED_INSTALL_CONTRACTS = Object.freeze([1]);

// The first release whose coordinator implements this vocabulary. A release
// that needs a newer coordinator raises it, and an older coordinator refuses the
// update instead of guessing what an unknown entry meant.
export const MIN_COORDINATOR_VERSION = "0.4.0-rc.63";

// The closed vocabulary. `source` is where a release keeps the files, `match` is
// the file names the root accepts. The directory itself is not here — it is the
// coordinator's to resolve (install-reconcile.mjs) — so nothing that travels in a
// manifest can choose it.
export const INSTALL_ROOTS = Object.freeze({
  // systemd units. Stopped and disabled before removal when retired.
  systemd: Object.freeze({ source: "deploy/systemd", match: /^infra-cod(?:-[a-z0-9]+)*\.(?:service|timer|target)$/ }),
  tmpfiles: Object.freeze({ source: "deploy/tmpfiles.d", match: /^infra-cod-[a-z0-9-]+\.conf$/ }),
  // The runtime accounts a release needs (sprint C K2). An update does not run
  // the installer, so a runtime added after install would have tmpfiles rules
  // naming a user nobody made; systemd-sysusers makes it first.
  sysusers: Object.freeze({ source: "deploy/sysusers.d", match: /^infra-cod-[a-z0-9-]+\.conf$/ }),
  caddy: Object.freeze({ source: "deploy/caddy", match: /^Caddyfile$/ }),
  // AppArmor profiles a runtime's host requirement needs (Stage 12 R13: user
  // namespaces for the distribution's bubblewrap only). Loaded by
  // apparmor_parser after install, unloaded before removal. The coordinator
  // knows the root one release before any release ships a file under it.
  apparmor: Object.freeze({ source: "deploy/apparmor", match: /^infra-cod-[a-z0-9-]+$/ }),
  // Tool definitions a runtime loads from its own home, root-owned and read-only
  // to it. Needs `runtime`, and only a runtime whose adapter declares a tool
  // directory has one.
  "runtime-tools": Object.freeze({ source: null, match: /^[a-z][a-z0-9_]*\.ts$/, perRuntime: true }),
});

export const INSTALL_MODE = "0644";

const ENTRY_KEYS = new Set(["root", "runtime", "source", "name", "mode"]);

// Where a runtime's tool definitions live inside a release.
function toolSource(adapter) {
  return adapter.toolDefinitions?.source ?? null;
}

// The declaration a release makes, derived from its tree. The builder writes this
// into the manifest; a coordinator meeting a release built before WP-A — a
// rollback to rc.24, say — derives the same thing, because what those releases
// installed was exactly "every such file in these directories".
export function declareInstall(releaseRoot, { minCoordinatorVersion = MIN_COORDINATOR_VERSION } = {}) {
  const files = [];
  const add = (root, source, runtime) => {
    const directory = path.join(releaseRoot, source);
    if (!existsSync(directory)) return;
    for (const name of readdirSync(directory).sort()) {
      if (!INSTALL_ROOTS[root].match.test(name)) continue;
      if (!statSync(path.join(directory, name)).isFile()) continue;
      files.push({ root, ...(runtime ? { runtime } : {}), source: `${source}/${name}`, name, mode: INSTALL_MODE });
    }
  };
  for (const [root, spec] of Object.entries(INSTALL_ROOTS)) {
    if (spec.perRuntime) continue;
    add(root, spec.source);
  }
  for (const adapter of allAdapters()) {
    if (toolSource(adapter)) add("runtime-tools", toolSource(adapter), adapter.name);
  }
  return { contractVersion: INSTALL_CONTRACT_VERSION, minCoordinatorVersion, files };
}

// The identity of an installed file: where it goes, not where it came from.
export function entryKey(entry) {
  return `${entry.root}${entry.runtime ? `:${entry.runtime}` : ""}/${entry.name}`;
}

// Every way a declaration can be outside the vocabulary. Empty means valid.
export function installSectionProblems(section) {
  const problems = [];
  if (!section || typeof section !== "object") return ["install is not an object"];
  if (!SUPPORTED_INSTALL_CONTRACTS.includes(section.contractVersion)) {
    problems.push(`install.contractVersion ${JSON.stringify(section.contractVersion)} is not one this coordinator implements (${SUPPORTED_INSTALL_CONTRACTS.join(", ")})`);
  }
  if (typeof section.minCoordinatorVersion !== "string" || !parseLoose(section.minCoordinatorVersion)) {
    problems.push(`install.minCoordinatorVersion ${JSON.stringify(section.minCoordinatorVersion)} is not a version`);
  }
  if (!Array.isArray(section.files) || section.files.length === 0) {
    problems.push("install.files is not a non-empty list");
    return problems;
  }
  const seen = new Set();
  section.files.forEach((entry, index) => {
    const at = `install.files[${index}]`;
    if (!entry || typeof entry !== "object") { problems.push(`${at} is not an object`); return; }
    for (const key of Object.keys(entry)) if (!ENTRY_KEYS.has(key)) problems.push(`${at} has an unknown key ${JSON.stringify(key)}`);
    const root = INSTALL_ROOTS[entry.root];
    if (!root) { problems.push(`${at} names the root ${JSON.stringify(entry.root)}, which is not in the vocabulary`); return; }
    if (typeof entry.name !== "string" || !root.match.test(entry.name)) {
      problems.push(`${at} installs ${JSON.stringify(entry.name)}, which the ${entry.root} root does not accept`);
    }
    if (typeof entry.source !== "string" || entry.source.startsWith("/") || entry.source.split("/").includes("..")
      || path.posix.basename(entry.source) !== entry.name) {
      problems.push(`${at} has the source ${JSON.stringify(entry.source)}; a source is a relative path inside the release ending in the name`);
    } else if (root.perRuntime) {
      let adapter = null;
      try { adapter = adapterFor(entry.runtime); } catch { /* reported below */ }
      if (!adapter || !toolSource(adapter)) {
        problems.push(`${at} installs tools for ${JSON.stringify(entry.runtime)}, which declares no tool directory`);
      } else if (path.posix.dirname(entry.source) !== toolSource(adapter)) {
        problems.push(`${at} takes ${entry.name} from ${path.posix.dirname(entry.source)}, not from ${toolSource(adapter)}`);
      }
    } else {
      if (entry.runtime !== undefined) problems.push(`${at} names a runtime for the ${entry.root} root, which has none`);
      if (path.posix.dirname(entry.source) !== root.source) {
        problems.push(`${at} takes ${entry.name} from ${path.posix.dirname(entry.source)}, not from ${root.source}`);
      }
    }
    if (entry.mode !== INSTALL_MODE) problems.push(`${at} has the mode ${JSON.stringify(entry.mode)}; only ${INSTALL_MODE} is installed`);
    const key = entryKey(entry);
    if (seen.has(key)) problems.push(`${at} installs ${key} a second time`);
    seen.add(key);
  });
  return problems;
}

// SemVer precedence, prerelease included (0.4.0-rc.9 < 0.4.0-rc.25 < 0.4.0).
function parseLoose(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(version);
  if (!match) return null;
  return { core: match.slice(1, 4).map(Number), pre: match[4] ? match[4].split(".") : [] };
}

export function compareVersions(a, b) {
  const left = parseLoose(a);
  const right = parseLoose(b);
  if (!left || !right) throw new Error(`cannot compare ${JSON.stringify(a)} with ${JSON.stringify(b)}`);
  for (let i = 0; i < 3; i += 1) if (left.core[i] !== right.core[i]) return left.core[i] < right.core[i] ? -1 : 1;
  if (!left.pre.length || !right.pre.length) return left.pre.length === right.pre.length ? 0 : left.pre.length ? -1 : 1;
  for (let i = 0; i < Math.max(left.pre.length, right.pre.length); i += 1) {
    const x = left.pre[i];
    const y = right.pre[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (x === y) continue;
    const numeric = /^\d+$/.test(x) && /^\d+$/.test(y);
    if (numeric) return Number(x) < Number(y) ? -1 : 1;
    if (/^\d+$/.test(x)) return -1;
    if (/^\d+$/.test(y)) return 1;
    return x < y ? -1 : 1;
  }
  return 0;
}

// What a coordinator of `coordinatorVersion` does with a release's manifest:
// its declaration if it has one it understands, the derived one if it predates
// WP-A, and a refusal otherwise.
export function installDeclarationFor(manifest, releaseRoot, { coordinatorVersion }) {
  const section = manifest?.install;
  if (section === undefined) return declareInstall(releaseRoot);
  const problems = installSectionProblems(section);
  if (problems.length) throw new Error(`the release's install declaration is not one this coordinator can apply:\n  ${problems.join("\n  ")}`);
  if (parseLoose(coordinatorVersion) && compareVersions(coordinatorVersion, section.minCoordinatorVersion) < 0) {
    throw new Error(`the release needs a coordinator of ${section.minCoordinatorVersion} or later to install it; this one is ${coordinatorVersion}`);
  }
  return section;
}
