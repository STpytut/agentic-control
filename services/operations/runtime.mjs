// `infra-cod runtime` — provisioning the agent runtimes.
//
// The panel has been installable since Stage 10 and the first real agent task
// has failed with `ENOENT` ever since: `codex` and `opencode` are not on the
// runtime PATH. This closes that, and the way it closes it is the point.
//
// The sequence mirrors the one the release artifact already goes through, for
// the same reason — an artifact whose provenance is unknown must not be parsed
// before it is verified:
//
//   pinned registry key -> signature over name@version:integrity
//     -> sha512 of the tarball -> safe member list -> extraction
//     -> root-owned placement -> smoke test as the real Unix user
//     -> atomic switch -> written record
//
// No npm, no npx, no install scripts, no `curl | sh`, and no floating version.
// ADR-0012 says why each of those is refused; the short version is that every
// one of them means executing something nobody chose as a user who can reach a
// project's workspace.

import { spawn, spawnSync } from "node:child_process";
import { connect as netConnect } from "node:net";
import { createHash, createVerify, randomUUID } from "node:crypto";
import httpTransport from "node:http";
import httpsTransport from "node:https";
import { chmodSync, closeSync, createWriteStream, existsSync, fsyncSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, readlinkSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  REGISTRY,
  REGISTRY_KEY_ID,
  REGISTRY_PUBLIC_KEY,
  adapterFor,
  assertExactVersion,
  compareVersions,
  runtimeNames,
} from "./runtime-adapters.mjs";
import {
  RUNTIMES_FILE,
  RUNTIME_ROOT,
  activeLink,
  executableDigest,
  forgetRuntimeDirectories,
  readRuntimes,
  recordCandidate,
  recordQualification,
  recordRuntime,
  runtimeEntry,
  versionDirectory,
} from "./runtime-inventory.mjs";
import { holdRuntimeFence } from "../runtime-supervisor/runtime-fence.mjs";
import { driverFor } from "../runtime-supervisor/drivers/index.mjs";
import { activeQualification, capabilityVerification } from "../runtime-supervisor/drivers/capabilities.mjs";
import { withHostLock } from "./update-lock.mjs";
import { currentReleaseDirectory, readManifest } from "./release-inventory.mjs";

const PREFIX = (process.env.INFRA_COD_INSTALL_PREFIX ?? "").trim();
const HARNESS = PREFIX.length > 0;
const COMMAND_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));

// The launch boundary, copied from the supervisor rather than approximated.
//
// Stage 10 ended with an installation whose `doctor` reported a binary as
// working that the runtime user could not execute, because the check ran as
// root. Everything this command asks of a runtime, it asks the way production
// will ask it.
const RUNUSER = sys("/usr/sbin/runuser");
const RUNTIME_PATH = "/usr/local/bin:/opt/node/bin:/usr/bin:/bin";

function sys(absolute) {
  return `${PREFIX}${absolute}`;
}

export class RuntimeError extends Error {
  constructor(message) {
    super(message);
    this.name = "RuntimeError";
  }
}

function run(binary, args, options = {}) {
  const result = spawnSync(binary, args, { encoding: "utf8", timeout: 300_000, ...options });
  if (result.error) return { ok: false, code: null, stdout: "", stderr: result.error.message };
  return {
    ok: result.status === 0,
    code: result.status,
    stdout: (result.stdout ?? "").trim(),
    stderr: (result.stderr ?? "").trim(),
  };
}

// Runs a command as the runtime's own Unix user, through the same scrubbed
// environment the supervisor uses. `env -i` is not decoration: a probe that
// inherits root's environment is a probe of a situation that never happens.
export function runAsRuntimeUser(adapter, args, { cwd = adapter.home, extraEnvironment = [] } = {}) {
  return runtimeProbe(adapter, adapter.executable, args, { cwd, extraEnvironment });
}

// Whether the host gives a runtime what its version needs (Stage 12 W1,
// HOST_REQUIREMENTS). Read-only: a probe that changed the host to find out
// would be the change the owner has not decided on.
export function probeHostRequirement(requirement, adapter, { readFile = readFileSync, exists = existsSync, probe = runtimeProbe } = {}) {
  if (requirement === "landlock") {
    let lsm;
    try {
      lsm = readFile("/sys/kernel/security/lsm", "utf8").trim();
    } catch (error) {
      return { met: false, detail: `the kernel's LSM list could not be read: ${error.message}` };
    }
    return lsm.split(",").includes("landlock")
      ? { met: true, detail: `landlock is in the LSM list (${lsm})` }
      : { met: false, detail: `landlock is not in the LSM list (${lsm})` };
  }
  if (requirement === "bwrap.userns") {
    // The distribution's binary: Codex uses a `bwrap` on PATH before its own
    // bundled copy, and an AppArmor profile can only name a fixed path.
    const bwrap = RUNTIME_PATH.split(":").map((directory) => path.join(directory, "bwrap")).find((file) => exists(file));
    if (!bwrap) return { met: false, detail: "no bubblewrap on the runtime's PATH (the distribution's `bubblewrap` package is not installed)" };
    let result;
    try {
      result = probe(adapter, bwrap, ["--unshare-user", "--unshare-net", "--ro-bind", "/", "/", "--", "/usr/bin/true"], { cwd: adapter.home });
    } catch (error) {
      return { met: false, detail: error.message };
    }
    return result.ok
      ? { met: true, detail: `${bwrap} created a user and a network namespace as ${adapter.user}` }
      : { met: false, detail: `${bwrap} could not create a user namespace as ${adapter.user}: ${(result.stderr || `exit ${result.code}`).split("\n")[0]}` };
  }
  return { met: false, detail: `no probe for the host requirement ${JSON.stringify(requirement)}` };
}

// `PWD` is a string in an environment; it does not move a process. The
// supervisor passes a real working directory, so this passes one too — a probe
// that announced a cwd it was not in would be measuring somewhere else.
//
// A missing directory is a refusal rather than a fallback. Falling back to
// `undefined` hands the child the *caller's* cwd — root's cwd, somewhere under
// the release tree — while still announcing the runtime home in `PWD`. Every
// relative path the runtime touches would then land outside its home, and the
// probe's result would describe a situation the supervisor never creates. If the
// home is gone, that is the finding.
// A candidate's probe (Stage 12 W3): its own executable, in its scratch home.
export function runCandidateProbe(adapter, executable, args, { home, extraEnvironment = [] }) {
  return runtimeProbe(adapter, executable, args, { cwd: home, home, extraEnvironment });
}

function runtimeProbe(adapter, executable, args, { cwd, extraEnvironment = [], home = adapter.home } = {}) {
  const workingDirectory = sys(cwd);
  if (!existsSync(workingDirectory)) {
    throw new RuntimeError(
      `${cwd} does not exist, so ${adapter.user} cannot be run there. `
      + `The runtime home is created by the installer; a host missing it needs that repaired, `
      + `not a probe run from somewhere else.`,
    );
  }
  return run(RUNUSER, [
    "-u", adapter.user, "--", "/usr/bin/env", "-i",
    `HOME=${home}`, `PATH=${RUNTIME_PATH}`, `PWD=${cwd}`, "LANG=C.UTF-8",
    ...runtimeEnvironment(adapter), ...extraEnvironment,
    executable, ...args,
  ], { timeout: 60_000, cwd: workingDirectory });
}

// What every start of a runtime carries whatever started it: the switches of
// an adapter whose self-update is stopped by its environment. A probe that
// left them out would be the one start that may update.
export function runtimeEnvironment(adapter) {
  return adapter.autoUpdate?.mechanism === "environment" ? [...adapter.autoUpdate.environment] : [];
}

// ---------------------------------------------------------------------------
// The registry, used as an HTTP source and nothing more
// ---------------------------------------------------------------------------

function registryBase() {
  // The sandbox may point this at a local server. On a real host it is the
  // constant, because a registry that can be redirected by the environment is a
  // supply chain that can be redirected by the environment.
  const override = (process.env.INFRA_COD_NPM_REGISTRY ?? "").trim();
  return HARNESS && override ? override : REGISTRY;
}

function pinnedKey() {
  // Resolved relative to the installed release, which is where the reviewed copy
  // of the key lives. A key read from anywhere the runtime could write would
  // vouch for whatever that runtime put there.
  const releaseRoot = path.resolve(COMMAND_DIRECTORY, "../..");
  const file = path.join(releaseRoot, REGISTRY_PUBLIC_KEY);
  if (!existsSync(file)) {
    throw new RuntimeError(`the pinned registry key is missing at ${file}; this release cannot verify a runtime package`);
  }
  return readFileSync(file, "utf8");
}

export async function resolvePackage(adapter, version, { fetchJson = defaultFetchJson } = {}) {
  const coordinates = adapter.packageFor(version);
  const url = `${registryBase()}/${encodeURIComponent(coordinates.name)}/${coordinates.version}`;
  const metadata = await fetchJson(url);
  if (!metadata?.dist?.tarball || !metadata.dist.integrity) {
    throw new RuntimeError(`${coordinates.name}@${coordinates.version} has no tarball and integrity in its registry metadata`);
  }

  // The answer has to be an answer to the question that was asked.
  //
  // Taking the name and version from the response and then verifying the
  // signature over *those* proves only that the registry signed something. It
  // does not prove it signed what this command asked for — and a registry that
  // answered a request for Codex with a signed OpenCode would have passed every
  // later check, because every later check would have been performed against the
  // identity the answer chose for itself.
  if (metadata.name !== coordinates.name || metadata.version !== coordinates.version) {
    throw new RuntimeError(
      `asked the registry for ${coordinates.name}@${coordinates.version} and it answered with `
      + `${metadata.name}@${metadata.version}; refusing to install something other than what was requested`,
    );
  }

  return {
    name: coordinates.name,
    version: coordinates.version,
    tarball: metadata.dist.tarball,
    integrity: metadata.dist.integrity,
    signatures: metadata.dist.signatures ?? [],
  };
}

// ---------------------------------------------------------------------------
// The watch (Stage 12 W2): which newer versions exist, without installing any
// ---------------------------------------------------------------------------

// Hours a version must have been published before it is offered. R8 had 48 —
// upstream hotfixes land in the first two days — and the owner chose on
// 2026-10-01 to have new releases at once (0127): every qualification still
// checks the registry's signature, and probation still rolls back. An operator
// who wants the wait back sets INFRA_COD_RUNTIME_MIN_AGE_HOURS.
export const WATCH_MINIMUM_AGE_HOURS = Math.max(0, Number(process.env.INFRA_COD_RUNTIME_MIN_AGE_HOURS ?? 0) || 0);
// The whole package's history is one document — 16 MB for Codex in 2026-09.
const WATCH_METADATA_MAX_BYTES = 64 * 1024 * 1024;
const WATCH_VERSIONS_MAX = 50;

// The exact versions a package document offers for this adapter's platform
// build. Asked of the adapter, not guessed from the key: Codex's `0.158.0` is
// the key `0.158.0-linux-x64` of `@openai/codex`, the others' keys are plain,
// and a pre-release is neither.
export function platformVersions(adapter, packument) {
  const keys = Object.keys(packument?.versions ?? {});
  const found = [];
  for (const key of keys) {
    const base = /^(\d+\.\d+\.\d+)/.exec(key)?.[1];
    if (!base || adapter.packageFor(base).version !== key) continue;
    found.push({
      version: base,
      published_at: packument.time?.[key] ?? null,
      deprecated: Boolean(packument.versions[key]?.deprecated),
    });
  }
  return found;
}

// Newer than the active version, newest first, bounded.
export function newerVersions(found, activeVersion) {
  return found
    .filter((entry) => !activeVersion || compareVersions(entry.version, activeVersion) > 0)
    .sort((left, right) => compareVersions(right.version, left.version))
    .slice(0, WATCH_VERSIONS_MAX);
}

export function isOffered(entry, now = Date.now()) {
  if (entry.deprecated || !entry.published_at) return false;
  const published = new Date(entry.published_at).getTime();
  return Number.isFinite(published) && now - published >= WATCH_MINIMUM_AGE_HOURS * 3600 * 1000;
}

// One runtime's answer. A registry that cannot be read is an answer too — the
// error is recorded, and yesterday's versions are not presented as today's.
export async function watchRuntime(name, { fetchJson = defaultFetchJson, activeVersion = null } = {}) {
  const adapter = adapterFor(name);
  const packageName = adapter.packageFor("0.0.0").name;
  try {
    const packument = await fetchJson(`${registryBase()}/${encodeURIComponent(packageName)}`, { maxBytes: WATCH_METADATA_MAX_BYTES });
    if (packument?.name !== packageName) {
      throw new RuntimeError(`asked the registry for ${packageName} and it answered with ${JSON.stringify(packument?.name)}`);
    }
    return { runtime: name, activeVersion, versions: newerVersions(platformVersions(adapter, packument), activeVersion), error: "" };
  } catch (error) {
    return { runtime: name, activeVersion, versions: [], error: String(error.message ?? error).slice(0, 500) };
  }
}

// The registry signs `name@version:integrity` with a key whose id is pinned
// here. Both halves matter: a signature that verifies under an unexpected key is
// a signature from somebody else.
export function verifyRegistrySignature(resolved, { key = pinnedKey(), keyId = REGISTRY_KEY_ID } = {}) {
  const signature = resolved.signatures.find((candidate) => candidate.keyid === keyId);
  if (!signature) {
    const seen = resolved.signatures.map((candidate) => candidate.keyid).join(", ") || "none";
    throw new RuntimeError(
      `${resolved.name}@${resolved.version} carries no signature from the pinned registry key ${keyId} (saw: ${seen})`,
    );
  }
  const message = `${resolved.name}@${resolved.version}:${resolved.integrity}`;
  const verified = createVerify("SHA256").update(message).verify(key, Buffer.from(signature.sig, "base64"));
  if (!verified) {
    throw new RuntimeError(`the registry signature for ${resolved.name}@${resolved.version} does not verify against the pinned key`);
  }
  return { keyId, message };
}

export function verifyIntegrity(digests, integrity) {
  const [algorithm, expected] = integrity.split("-", 2);
  if (algorithm !== "sha512") {
    throw new RuntimeError(`unsupported integrity algorithm ${JSON.stringify(algorithm)}; this installation requires sha512`);
  }
  const actual = typeof digests === "string" || Buffer.isBuffer(digests)
    ? createHash("sha512").update(digests).digest("base64")
    : digests.sha512;
  if (actual !== expected) {
    throw new RuntimeError("the downloaded tarball does not match the integrity the registry signed for it");
  }
  return {
    sha512: actual,
    sha256: typeof digests === "string" || Buffer.isBuffer(digests)
      ? createHash("sha256").update(digests).digest("hex")
      : digests.sha256,
  };
}

// The registry is reached with `node:https` and an agent that does not keep
// connections alive, rather than with `fetch`.
//
// Two reasons, and the first one is not stylistic. Node's global `fetch` holds
// its connection pool open, and a process that has used it does not exit: a
// sandbox run of this command completed its work and then sat until something
// killed it — which on a real host means `infra-cod runtime install` never
// returning, while holding the host lock. The second is size: these packages are
// 180 to 320 MB, and `await response.arrayBuffer()` means all of that resident
// at once. Streaming to disk keeps the cost constant and computes both digests
// on the way past.
function requestOnce(url, onResponse) {
  const target = new URL(url);
  const insecure = target.protocol === "http:";
  if (insecure && !(HARNESS && (target.hostname === "127.0.0.1" || target.hostname === "localhost"))) {
    throw new RuntimeError(`${url} is not https; a runtime package may not be fetched over plaintext`);
  }
  return { target, transport: insecure ? httpTransport : httpsTransport, onResponse };
}

async function followRedirects(url, handle, { maximum = 5 } = {}) {
  let current = url;
  for (let hop = 0; hop <= maximum; hop += 1) {
    const { target, transport } = requestOnce(current);
    const response = await new Promise((resolve, reject) => {
      const request = transport.get(
        { protocol: target.protocol, hostname: target.hostname, port: target.port, path: `${target.pathname}${target.search}`, agent: agentFor(target) },
        resolve,
      );
      request.on("error", reject);
      request.setTimeout(120_000, () => request.destroy(new RuntimeError(`${current} did not answer within 120s`)));
    });

    if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
      const location = response.headers.location;
      response.resume();
      if (!location) throw new RuntimeError(`${current} answered ${response.statusCode} with no location`);
      current = new URL(location, current).toString();
      continue;
    }
    if (response.statusCode !== 200) {
      response.resume();
      throw new RuntimeError(`${current} answered ${response.statusCode}`);
    }
    return handle(response, current);
  }
  throw new RuntimeError(`${url} redirected more than ${maximum} times`);
}

function agentFor(target) {
  // No keep-alive, and one connection. The pool that makes `fetch` fast is the
  // pool that makes a CLI hang.
  const Agent = target.protocol === "http:" ? httpTransport.Agent : httpsTransport.Agent;
  return new Agent({ keepAlive: false, maxSockets: 1 });
}

async function defaultFetchJson(url, { maxBytes = 8 * 1024 * 1024 } = {}) {
  return followRedirects(url, (response) => new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    response.on("data", (chunk) => {
      size += chunk.length;
      // Registry metadata for one version is kilobytes. Anything enormous here
      // is not metadata, and buffering it would be the bug this function exists
      // to avoid. The watch asks for a whole package's history, and says so.
      if (size > maxBytes) {
        response.destroy();
        reject(new RuntimeError(`${url} returned more than ${Math.round(maxBytes / 1024 / 1024)} MB of metadata`));
        return;
      }
      chunks.push(chunk);
    });
    response.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch (error) {
        reject(new RuntimeError(`${url} did not return JSON: ${error.message}`));
      }
    });
    response.on("error", reject);
  }));
}

// Streams the tarball to `destination`, hashing as it goes. Nothing is held in
// memory, and the digests come out of the same pass that wrote the file — so
// what is verified and what is on disk cannot differ.
export async function downloadPackage(url, destination) {
  return followRedirects(url, (response) => new Promise((resolve, reject) => {
    const sha512 = createHash("sha512");
    const sha256 = createHash("sha256");
    let bytes = 0;
    const file = createWriteStream(destination, { mode: 0o600 });
    response.on("data", (chunk) => {
      bytes += chunk.length;
      sha512.update(chunk);
      sha256.update(chunk);
    });
    response.pipe(file);
    file.on("error", reject);
    response.on("error", reject);
    file.on("finish", () => resolve({
      bytes,
      sha512: sha512.digest("base64"),
      sha256: sha256.digest("hex"),
    }));
  }));
}

// ---------------------------------------------------------------------------
// Unpacking, with the member checks the release gate applies
// ---------------------------------------------------------------------------

// The hardened tar reader lives in `scripts/`, and a service may not import from
// there — the release payload is the import closure of `services/`, and reaching
// outside it would mean shipping the repository's shape. So the same checks are
// applied here, against the same list `deploy/verify-release.sh` refuses on: an
// absolute member, a `.`/`..` component, anything outside the single top-level
// directory, and any entry that is not a file, directory or symlink.
export function assertSafeArchiveMembers(listing, { topLevel = "package" } = {}) {
  const members = listing.split("\n").map((line) => line.trim()).filter(Boolean);
  if (members.length === 0) throw new RuntimeError("the archive lists no members");

  for (const member of members) {
    if (member.startsWith("/")) throw new RuntimeError(`the archive contains an absolute member: ${member}`);
    const parts = member.split("/");
    if (parts.some((part) => part === ".." || part === ".")) {
      throw new RuntimeError(`the archive contains a relative-path component: ${member}`);
    }
    if (parts[0] !== topLevel) {
      throw new RuntimeError(`the archive contains a member outside ${topLevel}/: ${member}`);
    }
  }
  return members.length;
}

// Types and link targets, decided from the listing — before anything is written.
//
// The earlier version extracted first and inspected the tree afterwards. That is
// one order too late: extraction is the step that creates the link, and
// everything between extraction and the check runs against a tree that already
// contains it. `tar -tv` states each member's type and each link's target, which
// is all this needs, so the archive is refused before a single byte lands.
//
// Refused here: any entry that is not a regular file, a directory or a symlink;
// any symlink whose target resolves outside the package; and any symlink whose
// target is not itself a member of the archive. The last one is the "internal
// dangling" case — a link to `package/bin/codex` in an archive that ships no
// such member is a link that will be resolved by whatever appears at that path
// later, and "later" is not a property this check can verify.
export function assertSafeArchiveEntries(verboseListing, names, { topLevel = "package" } = {}) {
  const members = new Set(names.map((name) => name.replace(/\/+$/, "")));
  const links = [];

  for (const raw of verboseListing.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const type = line[0];
    if (type === "d" || type === "-") continue;
    if (type !== "l" && type !== "h") {
      throw new RuntimeError(
        "the archive contains a device, pipe, socket or other special entry, "
        + "which no runtime package has any use for",
      );
    }

    // `name -> target` for a symlink, `name link to target` for a hard link.
    const separator = type === "l" ? " -> " : " link to ";
    const at = line.lastIndexOf(separator);
    if (at === -1) throw new RuntimeError(`the archive lists a link whose target could not be read: ${line}`);
    const left = line.slice(0, at);
    const target = line.slice(at + separator.length).trim();
    const name = [...members].find((member) => left.endsWith(` ${member}`) || left === member);
    if (!name) throw new RuntimeError(`the archive lists a link that is not among its members: ${line}`);
    links.push({ name, target, hard: type === "h" });
  }

  for (const { name, target, hard } of links) {
    // A hard link's target is archive-relative; a symlink's is relative to the
    // directory the link sits in.
    const resolved = hard
      ? path.posix.normalize(target)
      : path.posix.normalize(path.posix.join(path.posix.dirname(name), target));
    if (target.startsWith("/") || resolved.split("/")[0] !== topLevel) {
      throw new RuntimeError(`the archive contains a link that leaves the package: ${name} -> ${target}`);
    }
    if (!members.has(resolved)) {
      throw new RuntimeError(
        `the archive contains a link to something it does not ship: ${name} -> ${target}. `
        + "What such a link resolves to is decided by whatever occupies that path later.",
      );
    }
  }
  return links.length;
}

function unpack(tarball, destination, { tar = "tar" } = {}) {
  const listing = run(tar, ["-tzf", tarball]);
  if (!listing.ok) throw new RuntimeError(`${tarball} is not a readable gzip-compressed tar archive`);
  const names = listing.stdout.split("\n").map((line) => line.trim()).filter(Boolean);
  const count = assertSafeArchiveMembers(listing.stdout);

  const verbose = run(tar, ["-tvzf", tarball]);
  if (!verbose.ok) throw new RuntimeError(`${tarball} could not be listed in detail`);
  assertSafeArchiveEntries(verbose.stdout, names);

  mkdirSync(destination, { recursive: true });
  const extracted = run(tar, ["--no-same-owner", "--no-same-permissions", "-xzf", tarball, "-C", destination]);
  if (!extracted.ok) throw new RuntimeError(`extraction failed: ${extracted.stderr}`);

  // The listing decided what may be written; this decides what was. The two
  // agree unless `tar` wrote something other than what it listed, which is
  // exactly the case worth a second look: everything after this point follows
  // links — `existsSync`, `chmodSync`, and the smoke test that executes the
  // thing.
  assertLinksStayInside(destination);
  return count;
}

// A link's target, resolved as far as it can be. A link that points at nothing
// yet resolves to its lexical destination, which is enough to decide whether it
// aims inside the tree or outside it.
function canonicalTarget(link) {
  const lexical = path.resolve(path.dirname(link), readlinkSync(link));
  try {
    return realpathSync(lexical);
  } catch {
    return lexical;
  }
}

// Every symlink in the unpacked tree, resolved against the tree it was unpacked
// into. A link that leaves is refused; so is a link that cannot be resolved at
// all, because "points at nothing yet" and "points somewhere that will exist
// later" are not distinguishable here.
export function assertLinksStayInside(root) {
  // Both sides canonical. Comparing a resolved target against an unresolved
  // boundary is how a containment check gets the right answer only on systems
  // where no parent directory is itself a link — `/var` is one on macOS, and the
  // check called a perfectly contained file an escape.
  const boundary = realpathSync(root);
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        const target = canonicalTarget(full);
        if (!existsSync(target)) {
          throw new RuntimeError(
            `the archive contains a symlink to nothing: `
            + `${path.relative(boundary, full)} -> ${readlinkSync(full)}`,
          );
        }
        if (target !== boundary && !target.startsWith(`${boundary}${path.sep}`)) {
          throw new RuntimeError(
            `the archive contains a symlink that leaves the package: `
            + `${path.relative(boundary, full)} -> ${readlinkSync(full)}`,
          );
        }
        continue;
      }
      if (entry.isDirectory()) walk(full);
      else if (!entry.isFile()) {
        throw new RuntimeError(`the archive contains ${path.relative(boundary, full)}, which is neither a file, a directory nor a symlink`);
      }
    }
  };
  walk(boundary);
}

// The executable has to be a regular file in the tree that was just unpacked —
// not a link to one, however innocent the link looks, and not something whose
// path leaves the tree once resolved.
export function assertRegularExecutable(file, root) {
  const boundary = realpathSync(root);
  const info = lstatSync(file, { throwIfNoEntry: false });
  if (!info) throw new RuntimeError(`the package does not contain ${path.relative(boundary, file)}`);
  if (!info.isFile()) {
    throw new RuntimeError(`${path.relative(boundary, file)} is not a regular file; a runtime executable may not be a link or a device`);
  }
  const resolved = realpathSync(file);
  if (!resolved.startsWith(`${boundary}${path.sep}`)) {
    throw new RuntimeError(`${path.relative(boundary, file)} resolves outside the package (${resolved})`);
  }
  return resolved;
}

// ---------------------------------------------------------------------------
// install
// ---------------------------------------------------------------------------

export async function installRuntime({
  name,
  version,
  actor,
  reporter,
  waitSeconds = 0,
  acceptUnmanaged = false,
  fetchJson = defaultFetchJson,
  fetchBuffer = downloadPackage,
  activate = true,
}) {
  const adapter = adapterFor(name);
  assertExactVersion(version);

  // An installation starts from a state this host can describe, or it does not
  // start.
  //
  // A crash between the symlink and the record leaves one piece of evidence: the
  // switch-intent file. Installing again over it would overwrite the only
  // account of what happened — and the tree the interrupted switch made live,
  // which the inventory never learned about, would become an orphan nothing
  // could ever be asked to remove. Repair is `reconcile`'s job, and it is the
  // only command allowed to act on a host that disagrees with its own record.
  assertConsistentBefore(name, "installing");

  // A runtime version may not change under a process that is using it.
  //
  // The plan allows draining, waiting or refusing. This waits, and then refuses;
  // it does not kill. An earlier version took an `--interrupt-active` flag,
  // logged the word "interrupting" and carried on — no signal, no wait, no
  // re-check. A flag that names an action it does not perform is worse than no
  // flag, because an operator reading the output believes the sessions were
  // stopped.
  //
  // The race after this check is closed by the fence taken later: the supervisor
  // stops admitting launches of this runtime, and the check is repeated with the
  // door shut.
  // A candidate changes nothing that is running, so it waits for nothing.
  if (activate) await waitForIdleRuntime(adapter, { reporter, waitSeconds });

  const previousActive = readRuntimes().runtimes[name]?.active ?? null;

  reporter.step(`resolving ${name} ${version}`);
  const resolved = await resolvePackage(adapter, version, { fetchJson });
  reporter.step(`${resolved.name}@${resolved.version} carries the executable`);

  const signature = verifyRegistrySignature(resolved);
  reporter.step(`signed by the pinned registry key ${signature.keyId.slice(0, 24)}…`);

  // Staged beside the trees it becomes one of, on the same filesystem: the
  // tree is moved into place with one rename, and a rename cannot cross
  // filesystems. Staged in /tmp it failed with EXDEV wherever /tmp is its own
  // mount — the update unit's PrivateTmp, first time it qualified anything
  // (rc.109). The runtimes root, not the runtime's own directory, so `verify`
  // never counts a staging area as an unrecorded installation.
  const runtimesRoot = path.dirname(path.dirname(versionDirectory(name, "unused")));
  mkdirSync(runtimesRoot, { recursive: true, mode: 0o755 });
  const staging = mkdtempSync(path.join(runtimesRoot, `.staging-${name}-`));
  try {
    // Streamed to disk and hashed on the way past: these packages are hundreds
    // of megabytes, and what is verified is the file that was written rather
    // than a copy of it held in memory.
    const tarball = path.join(staging, "package.tgz");
    const downloaded = await fetchBuffer(resolved.tarball, tarball);
    const digests = verifyIntegrity(downloaded, resolved.integrity);
    reporter.step(`integrity matches the signed sha512 (${downloaded.bytes} bytes)`);

    const members = unpack(tarball, path.join(staging, "tree"));
    reporter.step(`unpacked ${members} members, none of them outside package/`);

    // The executable is checked properly once the tree is in its landing place —
    // `existsSync` here would follow a link, which is the thing being guarded
    // against.

    // An installed tree is never rewritten, and never renamed out from under the
    // link that names it.
    //
    // The previous attempt moved the old tree aside and the new one into its
    // place, which leaves `/usr/local/bin/<name>` pointing at a path that does
    // not exist for the length of two renames — and permanently, if the second
    // one fails or the machine stops between them. So each installation gets its
    // own immutable directory, the symlink is swung to it in the one operation
    // that is atomic, and only then is anything old removed.
    //
    // Whether the bytes were already on disk decides only *which* tree is
    // activated. It decides nothing about the gates: an install that found the
    // version already present is still an activation, and an activation that
    // skipped the idle check or the update policy is the same unsafe act
    // whichever branch reached it. The first version of this had a second,
    // shorter path for the already-installed case — which is exactly how a gate
    // gets skipped: not by being removed, but by there being a way around it.
    const existing = (readRuntimes().runtimes[name]?.installed ?? [])
      .find((installed) => installed.version === version && installed.digest?.sha256 === digests.sha256);
    const reused = Boolean(existing && existsSync(path.join(existing.directory, adapter.executablePath)));

    let directory;
    if (reused) {
      reporter.step(`${name} ${version} is already installed with these exact bytes`);
      directory = existing.directory;
    } else {
      directory = uniqueVersionDirectory(name, version);
      mkdirSync(path.dirname(directory), { recursive: true, mode: 0o755 });
      renameSync(path.join(staging, "tree"), directory);

      // Root-owned and not writable by the runtime user: the executable tree and
      // the credential state are different things, and only one of them is the
      // runtime's to change.
      if (!HARNESS) run("chown", ["-R", "root:root", directory]);
      run("chmod", ["-R", "u=rwX,go=rX", directory]);
    }

    // Discards anything this attempt created, and never anything it found.
    // Idempotent: more than one failure path can reach it on the way out.
    let discarded = false;
    const discard = () => {
      if (reused || discarded) return;
      discarded = true;
      rmSync(directory, { recursive: true, force: true });
    };

    // A regular file, inside the tree, resolved — not a link that the archive
    // aimed somewhere else and that every step after this would have followed.
    //
    // Inside the discard, like every other gate after the rename, and for the
    // reason the production host demonstrated: this is the check that fires when
    // an adapter names a path the package does not have, and it fired *before*
    // any `discard()` existed on its path. The result was 324 MB in
    // `/opt/infra-cod/runtimes/codex/0.154.0` that the inventory never learned
    // about — so `runtime remove` could not see it, `verify` did not mention it,
    // and the only way out was `rm -rf` by hand.
    let staged;
    try {
      staged = assertRegularExecutable(path.join(directory, adapter.executablePath), directory);
      if (!reused) chmodSync(staged, 0o755);
    } catch (error) {
      discard();
      throw error;
    }
    if (!reused) reporter.step(`staged at ${path.basename(directory)}, root-owned`);

    // The executable's digest, recorded so `doctor` can say whether it is still
    // the one the signed package carried (Stage 12 W1). A reused tree is held
    // to the package just unpacked: the bytes on disk must be those bytes, or
    // someone changed a tree that is meant never to change.
    let executableSha256;
    try {
      executableSha256 = executableDigest(staged);
      if (reused) {
        const fresh = executableDigest(path.join(staging, "tree", adapter.executablePath));
        if (fresh !== executableSha256) {
          throw new RuntimeError(
            `${name} ${version} is installed at ${directory}, but its executable is not the one the signed package `
            + `carries (on disk ${executableSha256.slice(0, 12)}…, package ${fresh.slice(0, 12)}…). `
            + "Nothing was activated; remove that tree and install again.",
          );
        }
      }
    } catch (error) {
      discard();
      throw error;
    }
    reporter.step(`executable sha256 ${executableSha256.slice(0, 12)}…`);

    // The bytes being the same does not make the host the same. Permissions
    // change, users get their shell taken away, a home goes missing — and an
    // install that reported success without asking would be reporting on the
    // last install, not this one.
    const smoke = smokeTest(adapter, staged, version);
    if (!smoke.ok) {
      discard();
      throw new RuntimeError(
        `${name} ${version} did not pass its smoke test as ${adapter.user}: ${smoke.detail}. `
        + `${previousActive ? `${name} ${previousActive.version} is still active and untouched.` : "Nothing was activated."}`,
      );
    }
    reporter.step(`smoke test passed as ${adapter.user}: ${smoke.reported}`);

    // The mandatory control, applied before anything points at this version, and
    // applied every time. A record saying `verified: true` describes the moment
    // it was written: the config file it refers to can be edited, reset by the
    // runtime itself, or restored from a backup taken before the control
    // existed. Re-activating a tree on the strength of that record would carry
    // the old answer forward over a host that has since changed its mind.
    const autoUpdate = requireAutoUpdatePolicy(adapter, { acceptUnmanaged, reporter, onRefuse: discard });

    // A candidate (Stage 12 W3): the same resolve, signature, integrity, unpack,
    // digest and smoke test as an install, and then nothing more. No idle wait,
    // no fence, no switch: the active version keeps serving, and the tree is
    // recorded beside it so `remove` can find it and `qualify` can run it.
    if (!activate) {
      const installation = {
        version, directory, candidate: true,
        digest: { sha256: digests.sha256, integrity: resolved.integrity },
        source: { registry: registryBase(), package: `${resolved.name}@${resolved.version}`, tarball: resolved.tarball },
        installedAt: new Date().toISOString(), actor, executableSha256,
        verification: { smoke: smoke.reported, verifiedAt: new Date().toISOString(), signedBy: signature.keyId, autoUpdate },
      };
      if (directory !== previousActive?.directory) recordCandidate(name, installation);
      reporter.step(`${name} ${version} is installed beside the active ${previousActive?.version ?? "(none)"}, not activated`);
      return {
        name, version, directory, executable: staged, executableSha256, reused,
        signedBy: signature.keyId, smoke: smoke.reported, package: `${resolved.name}@${resolved.version}`,
      };
    }

    await activateStaged({
      name, adapter, version, directory, staged, previousActive, actor, reporter, waitSeconds, discard, executableSha256,
      source: { registry: registryBase(), package: `${resolved.name}@${resolved.version}`, tarball: resolved.tarball },
      digest: { sha256: digests.sha256, integrity: resolved.integrity },
      verification: { smoke: smoke.reported, verifiedAt: new Date().toISOString(), signedBy: signature.keyId, autoUpdate },
    });
    return { name, version, directory, unchanged: reused };
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

// The fenced switch to a tree already staged and checked, and its record. Shared
// by an install, a promotion and a rollback (Stage 12 W4): what differs between
// them is how the tree got here, never how it becomes active.
async function activateStaged({
  name, adapter, version, directory, staged, previousActive, source, digest, executableSha256,
  verification, actor, reporter, waitSeconds, discard, keepPrevious = false,
}) {
  // Nothing has started using this version, and nothing will until the switch —
  // but the supervisor could have started using the *old* one while this ran.
  // If it did, this install ends here, and it takes its tree with it: a
  // directory on disk that the record never learned about is a directory
  // nobody will ever be asked to remove.
  try {
    await waitForIdleRuntime(adapter, { reporter, waitSeconds: 0 });
  } catch (error) {
    discard();
    throw error;
  }

  // The fence: the supervisor stops admitting new launches of this runtime,
  // and the ones already open are waited for. Nothing is interrupted, and the
  // other runtime is untouched.
  let fence;
  try {
    fence = await closeAdmission(name, { reporter, waitSeconds });
  } catch (error) {
    // A tree staged for a switch that will not happen is a tree nobody will
    // ever be asked to remove.
    discard();
    throw error;
  }
  let released = false;
  try {
    // The fence must still be held by *this* connection, and the supervisor
    // behind it must still be the one that granted it.
    await fence.assertHeld();

    // The supervisor says nothing of its own is in flight. `pgrep` is asked
    // once more for anything outside it — an operator's own shell, a stray
    // process from a previous crash — because the fence covers admissions,
    // not the whole machine.
    await waitForIdleRuntime(adapter, { reporter, waitSeconds: 0 });

    // The record that *would* be written, built before anything irreversible
    // happens so that the intent file can carry it.
    const pending = runtimeEntry({
      name,
      adapter,
      version,
      previous: readRuntimes().runtimes[name] ?? null,
      source,
      digest,
      executableSha256,
      directory,
      verification,
      actor,
      rollbackTo: keepPrevious && previousActive ? { version: previousActive.version, directory: previousActive.directory } : undefined,
    });

    // Durable before irreversible. If the machine stops between the rename and
    // the record, this file is what tells the next command which of the two
    // happened — and, because it carries the entry, what the record should
    // have said.
    recordIntent(name, {
      runtime: name,
      from: previousActive ? path.join(previousActive.directory, adapter.executablePath) : null,
      to: staged,
      version,
      startedAt: new Date().toISOString(),
      actor,
      entry: pending,
    });

    // Asked once more with nothing between this and the rename. A check
    // followed by work is a check about the past; the gap cannot be closed
    // from here, only made as small as a local process can make it.
    await fence.assertHeld();

    // What the record said before this switch, so the rollback below can put
    // both the link and the record back rather than one of them.
    const previousEntry = readRuntimes().runtimes[name] ?? null;
    const back = () => (previousActive ? path.join(previousActive.directory, adapter.executablePath) : "");

    switchAndRecord(adapter, staged, {
      reporter,
      write: () => recordRuntime(name, pending),
    });

    // And asked again afterwards, because the gap above is real: the
    // supervisor can die between the last check and the rename, restart, and
    // admit a session while this process is still congratulating itself.
    //
    // A local program cannot make a remote check and a local rename one
    // operation. What it can do is refuse to *report* a switch it cannot show
    // was fenced throughout — so the link goes back and the install fails,
    // rather than leaving a host that was switched without a fence and nobody
    // the wiser.
    try {
      await fence.assertHeld();
    } catch (error) {
      // The tree stays. A supervisor that restarted in this window may already
      // have launched a session from it, and deleting it would take the files
      // out from under a running process — which is the harm this whole design
      // exists to prevent. Immutable trees make that easy: the link can go
      // back while the tree remains, and anything running keeps what it has.
      //
      // So the record keeps it too, in `installed`, where `remove --version`
      // can find it once nothing is using it. Discarding here would produce
      // exactly the orphan this file spends so much effort avoiding.
      try {
        if (previousActive && previousEntry && existsSync(back())) {
          const restored = assertRegularExecutable(back(), previousActive.directory);
          switchActive(adapter, restored, { expect: staged });
          // The old entry, plus the new installation in `installed` — not the
          // new entry with an old `active`. That mixture put the previous
          // version's number beside the new version's smoke result and
          // signature, so the record described an installation that never
          // existed.
          recordRuntime(name, { ...previousEntry, installed: pending.installed });
          reporter.step(`${activeLink(adapter.executable)} put back to ${previousActive.version}: the fence was lost during the switch`);
        } else {
          // Nothing was active before this install, so there is nothing to go
          // back to. The link goes, and the record says what is true: the
          // version is installed and nothing is active. The first version of
          // this left `pending` in place, so the inventory named a directory
          // it had just deleted as the active one.
          rmSync(activeLink(adapter.executable), { force: true });
          recordRuntime(name, { ...pending, active: null });
          reporter.step(`${activeLink(adapter.executable)} removed: the fence was lost and nothing was active before`);
        }
        clearIntent(name);
      } catch (rollbackFailure) {
        // The repair itself failed, so the host is now in a state only
        // `reconcile` should touch — and the intent file is the evidence it
        // needs. Marked divergent so the outer handler leaves both alone.
        const divergence = new RuntimeError(
          `the fence was lost while ${name} ${version} was being activated (${error.message}), `
          + `and putting it back failed too (${rollbackFailure.message}). `
          + `${activeLink(adapter.executable)} and ${RUNTIMES_FILE} may disagree; `
          + `run \`infra-cod runtime reconcile ${name}\`.`,
        );
        divergence.divergent = true;
        throw divergence;
      }

      const lost = new RuntimeError(
        `the fence was lost while ${name} ${version} was being activated (${error.message}). `
        + `${previousActive ? `${name} ${previousActive.version} is active again.` : "Nothing is active."} `
        + `${name} ${version} is installed but not active, and is left on disk because a session may already `
        + "have been launched from it. Nothing can be shown to have been fenced throughout, so this is a failure.",
      );
      // Not "divergent" — the link and the record agree — but the tree must
      // survive, so the outer handler must not discard it either.
      lost.divergent = true;
      throw lost;
    }

    clearIntent(name);
  } catch (error) {
    // The intent file exists to describe a switch nobody can see the end of.
    // If the link was put back, there is nothing left to reconcile and the
    // file would only raise a false alarm. If it could not be put back, the
    // file is the only record of what happened and it stays.
    if (!error.divergent) clearIntent(name);

    // And the tree this attempt staged goes with it. Only the fence-loss path
    // below was discarding; a failure between staging and the switch — the
    // `assertHeld` before the rename is the one that matters — left the
    // directory on disk with nothing in the record naming it, which is a tree
    // nobody can ever be asked to remove.
    if (!error.divergent) discard();
    throw error;
  } finally {
    // A runtime left unable to launch would be a worse outcome than the race
    // this closed, so the fence comes back whatever happened.
    released = await fence.release();
  }

  // And its failure is a failure. The earlier version ignored this answer, so
  // an install could report success on a host that could no longer start a
  // session — and after `systemctl start` it did not even ask whether the
  // service had come up.
  if (!released) {
    throw new RuntimeError(
      `${name} was installed and activated, but the supervisor is still holding its launches. `
      + `No ${name} session can start until that is cleared: check `
      + `\`systemctl status ${LAUNCH_UNIT}\` and restart it if needed.`,
    );
  }
  reporter.step(`${activeLink(adapter.executable)} now points at ${version}`);
  reporter.step(`recorded in ${RUNTIMES_FILE}`);
}

// ---------------------------------------------------------------------------
// promote, rollback (Stage 12 W4)
// ---------------------------------------------------------------------------

export const RUNTIME_BACKUP_ROOT = sys("/var/lib/infra-cod/runtime-backups");

// The runtime's state, as its adapter declares it (`backup`), archived by root
// before a promotion switches the version that reads it. A newer runtime may
// migrate its session store in place; this is what a rollback restores from
// if the old version cannot read the new format. Credentials are in it, so the
// archive is root's alone: 0600 in a 0700 directory.
export function backupRuntimeState(adapter, { name, from, reporter, now = () => new Date() }) {
  const present = adapter.backup.map((absolute) => sys(absolute)).filter((file) => existsSync(file));
  if (!present.length) {
    reporter.step(`no ${name} state to back up`);
    return null;
  }
  mkdirSync(RUNTIME_BACKUP_ROOT, { recursive: true, mode: 0o700 });
  chmodSync(RUNTIME_BACKUP_ROOT, 0o700);
  const stamp = now().toISOString().replace(/[:.]/g, "-");
  const archive = path.join(RUNTIME_BACKUP_ROOT, `${name}-${from}-${stamp}.tar.gz`);
  const root = PREFIX || "/";
  run("tar", ["--create", "--gzip", "--file", archive, "--directory", root,
    ...present.map((file) => path.relative(root, file))]);
  chmodSync(archive, 0o600);
  reporter.step(`${name} state backed up to ${archive}`);
  return archive;
}

// The newest recorded tree of an exact version, held to the digest recorded
// when it was installed. A promotion or a rollback activates bytes that were
// checked once; they are checked again, because a tree on disk can be changed.
function recordedTree(name, adapter, entry, predicate, what) {
  const installation = (entry.installed ?? []).filter(predicate)
    .sort((left, right) => String(right.installedAt).localeCompare(String(left.installedAt)))[0];
  if (!installation) throw new RuntimeError(what);
  const staged = assertRegularExecutable(path.join(installation.directory, adapter.executablePath), installation.directory);
  if (!installation.executableSha256) {
    throw new RuntimeError(`${name} ${installation.version} has no recorded executable digest; install it again with \`infra-cod runtime install ${name} --version ${installation.version}\``);
  }
  const actual = executableDigest(staged);
  if (actual !== installation.executableSha256) {
    throw new RuntimeError(
      `${name} ${installation.version}'s executable at ${installation.directory} is not the one recorded at install `
      + `(on disk ${actual.slice(0, 12)}…, recorded ${installation.executableSha256.slice(0, 12)}…). Nothing was activated.`,
    );
  }
  return { installation, staged };
}

// Activates a version this host has qualified (R9, R10). Refused unless the
// inventory records a passed qualification of that exact tree under the
// adapter version this release ships; `acceptUnqualified` with a reason is the
// emergency exit, recorded and never silent. The previous active version is
// kept and named, so `rollback` is one command (R12).
export async function promoteRuntime({
  name, version, actor, reporter, waitSeconds = 0, acceptUnqualified = false, reason = null, backup = backupRuntimeState,
}) {
  const adapter = adapterFor(name);
  const driver = driverFor(name);
  assertExactVersion(version);
  assertConsistentBefore(name, "promoting");
  const entry = readRuntimes().runtimes[name];
  if (!entry?.active) throw new RuntimeError(`${name} has no active version; install one first`);
  const { installation, staged } = recordedTree(name, adapter, entry, (installed) => installed.version === version,
    `${name} ${version} is not installed on this host; qualify it first: infra-cod runtime qualify ${name} --version ${version}`);
  if (installation.directory === entry.active.directory) {
    throw new RuntimeError(`${name} ${version} is already the active version`);
  }
  const qualification = installation.qualification ?? null;
  const qualified = qualification?.result === "passed" && qualification.adapterVersion === driver.verified.adapterVersion;
  if (!qualified) {
    const why = !qualification ? "no qualification of it has passed on this host"
      : qualification.adapterVersion !== driver.verified.adapterVersion
        ? `it was qualified under adapter ${qualification.adapterVersion}, and this release ships ${driver.verified.adapterVersion}`
        : `its qualification is ${qualification.result}`;
    if (!acceptUnqualified) {
      throw new RuntimeError(
        `${name} ${version} is not promoted: ${why}. Run \`infra-cod runtime qualify ${name} --version ${version}\`; `
        + "in an emergency, --accept-unqualified --reason \"…\" promotes it anyway and is recorded.",
      );
    }
    if (typeof reason !== "string" || reason.trim().length < 8) {
      throw new RuntimeError("--accept-unqualified needs --reason \"…\" of at least a few words: it is recorded, and doctor shows it");
    }
    reporter.step(`WARNING: promoting ${name} ${version} unqualified (${why}); reason recorded: ${reason.trim()}`);
  } else {
    reporter.step(`${name} ${version} passed qualification ${qualification.id} on this host`);
  }

  await waitForIdleRuntime(adapter, { reporter, waitSeconds });
  const smoke = smokeTest(adapter, staged, version);
  if (!smoke.ok) {
    throw new RuntimeError(`${name} ${version} did not pass its smoke test as ${adapter.user}: ${smoke.detail}. ${name} ${entry.active.version} is still active.`);
  }
  reporter.step(`smoke test passed as ${adapter.user}: ${smoke.reported}`);
  const autoUpdate = requireAutoUpdatePolicy(adapter, { reporter });
  const archive = backup(adapter, { name, from: entry.active.version, reporter });

  await activateStaged({
    name, adapter, version, directory: installation.directory, staged, previousActive: entry.active, actor, reporter, waitSeconds,
    discard: () => {}, keepPrevious: true,
    source: installation.source, digest: installation.digest, executableSha256: installation.executableSha256,
    verification: {
      smoke: smoke.reported, verifiedAt: new Date().toISOString(), signedBy: installation.verification?.signedBy ?? null, autoUpdate,
      promotion: {
        from: entry.active.version, at: new Date().toISOString(), actor, backup: archive,
        ...(qualified ? { qualification: qualification.id } : { acceptedUnqualified: { reason: reason.trim() } }),
      },
    },
  });
  reporter.step(`${name} ${entry.active.version} is kept for \`infra-cod runtime rollback ${name}\``);
  return { name, version, from: entry.active.version, qualification: qualified ? qualification.id : null, backup: archive, acceptedUnqualified: !qualified };
}

// Back to the version active before the last promotion, fenced like any
// switch, with no registry involved: the tree is on disk because R12 keeps it.
export async function rollbackRuntime({ name, actor, reporter, waitSeconds = 0, reason = null }) {
  const adapter = adapterFor(name);
  assertConsistentBefore(name, "rolling back");
  const entry = readRuntimes().runtimes[name];
  if (!entry?.active) throw new RuntimeError(`${name} has no active version`);
  if (!entry.rollbackTo) throw new RuntimeError(`${name} has no previous version to roll back to: nothing was promoted since it was installed`);
  const target = entry.rollbackTo;
  const { installation, staged } = recordedTree(name, adapter, entry, (installed) => installed.directory === target.directory,
    `${name} ${target.version} (${target.directory}) is no longer on record; nothing to roll back to`);
  await waitForIdleRuntime(adapter, { reporter, waitSeconds });
  const smoke = smokeTest(adapter, staged, installation.version);
  if (!smoke.ok) {
    throw new RuntimeError(`${name} ${installation.version} did not pass its smoke test as ${adapter.user}: ${smoke.detail}. ${name} ${entry.active.version} is still active.`);
  }
  const autoUpdate = requireAutoUpdatePolicy(adapter, { reporter });
  await activateStaged({
    name, adapter, version: installation.version, directory: installation.directory, staged, previousActive: entry.active, actor, reporter, waitSeconds,
    discard: () => {},
    source: installation.source, digest: installation.digest, executableSha256: installation.executableSha256,
    verification: {
      smoke: smoke.reported, verifiedAt: new Date().toISOString(), signedBy: installation.verification?.signedBy ?? null, autoUpdate,
      rollback: { from: entry.active.version, at: new Date().toISOString(), actor, ...(reason ? { reason: String(reason).slice(0, 500) } : {}) },
    },
  });
  return { name, version: installation.version, from: entry.active.version };
}

// What the probation timer does with the database's verdicts (Stage 12 W4b):
// a passed probation is closed, a failing one is rolled back — fenced, like an
// operator's rollback — and recorded, which closes it. Anything else is only
// reported. Separate from the command so it is tested without a database.
export async function applyProbationVerdicts(verdicts, { apply, stdout, stderr, end, record, rollback }) {
  let failed = 0;
  let rolledBack = 0;
  for (const verdict of verdicts) {
    if (verdict.state === "none") continue;
    stdout.write(`${verdict.runtime} ${verdict.version}: probation ${verdict.state}, ${verdict.runs_seen}/${verdict.runs_required} runs, until ${verdict.until}\n`);
    if (!apply) continue;
    if (verdict.state === "passed") {
      await end(verdict.activation_id, "three runs and a day without a runtime failure");
      stdout.write(`${verdict.runtime} ${verdict.version}: probation passed; ${verdict.from} stays for \`infra-cod runtime rollback ${verdict.runtime}\` until the next promotion\n`);
    } else if (verdict.state === "failing") {
      const first = verdict.failures?.[0] ?? {};
      const reason = `probation: ${first.signal ?? first.status ?? "runtime failure"}${first.error ? ` — ${first.error}` : ""} (attempt ${first.attempt_id})`.slice(0, 480);
      try {
        const outcome = await rollback(verdict.runtime, reason);
        await record({ kind: "rollback", actor: "probation", reason, ...outcome });
        rolledBack += 1;
        stdout.write(`${verdict.runtime} ${outcome.from} -> ${outcome.version}: rolled back by probation (${reason})\n`);
      } catch (error) {
        failed += 1;
        stderr.write(`infra-cod runtime: ${verdict.runtime} ${verdict.version} failed its probation and could not be rolled back: ${error.message}\n`);
      }
    }
  }
  return { failed, rolledBack };
}

// The mandatory half: a runtime whose self-updates cannot be controlled does not
// get installed, and a control that fails to apply fails the install.
//
// This was a warning, and the install carried on. That is fail-open on a
// contract Stage 11.1 states outright — a host would have ended up running a
// runtime free to change its own version, with a green exit code and a line of
// text nobody reads twice. An operator who wants that anyway has to say so, in
// writing, and it is recorded where the next person will see it.
export function requireAutoUpdatePolicy(adapter, { acceptUnmanaged = false, reporter, onRefuse = () => {} }) {
  const result = applyAutoUpdatePolicy(adapter);
  if (result.verified) {
    reporter.step(`self-update disabled through ${result.setting}`);
    return result;
  }

  if (!acceptUnmanaged) {
    onRefuse();
    throw new RuntimeError(
      `${adapter.name}'s self-update cannot be disabled: ${result.reason}. `
      + "Stage 11.1 requires that a host's runtime version changes only when an operator asks for it. "
      + "Re-run with --accept-unmanaged-updates to install anyway; the host will then be running a runtime "
      + "that may change its own version, and the record will say so.",
    );
  }

  reporter.step(`WARNING: installing with self-update unmanaged — ${result.reason}`);
  return { ...result, acceptedUnmanaged: true, acceptedBy: process.env.INFRA_COD_ACTOR ?? process.env.SUDO_USER ?? "root" };
}

// Writes the runtime's own "do not update yourself" setting into its user's
// configuration, and reports honestly when there is no such setting to write.
//
// The file belongs to the runtime user, so it is written as that user rather
// than written by root and handed over: a root-owned config in a runtime home is
// a file the runtime cannot rewrite and a permission problem waiting for its
// first real session.
export function applyAutoUpdatePolicy(adapter, { runAs = runtimeProbeShell } = {}) {
  const policy = adapter.autoUpdate;
  if (!policy?.mechanism) {
    return { disabled: false, verified: false, reason: policy?.reason ?? "no mechanism is declared for this runtime" };
  }
  // Nothing to write: the switches travel with every launch and every probe
  // (runtimeEnvironment below, and the driver's run environment), and the
  // registry records the version they were shown to work at.
  if (policy.mechanism === "environment") {
    if (!Array.isArray(policy.environment) || !policy.environment.length) {
      return { disabled: false, verified: false, reason: "the environment mechanism names no variables" };
    }
    return { disabled: true, verified: true, mechanism: policy.mechanism, setting: policy.setting, source: policy.verifiedAgainst };
  }
  if (policy.mechanism !== "config-toml") {
    return { disabled: false, verified: false, reason: `unsupported mechanism ${policy.mechanism}` };
  }

  // The path the script touches goes through the prefix, while `HOME` keeps the
  // value production uses. On a host the two are the same string; in a sandbox
  // they must not be, or the policy would be written to the developer's own
  // /home instead of the sandbox's.
  const file = `${sys(adapter.home)}/${policy.file}`;
  const written = writeRootTomlSetting(file, policy.setting, policy.value, adapter);
  if (!written.ok) {
    return { disabled: false, verified: false, reason: written.reason };
  }
  return { disabled: true, verified: true, mechanism: policy.mechanism, setting: policy.setting, source: policy.verifiedAgainst };
}

// Writes a setting into the *root* table of a TOML file, and nowhere else.
//
// Appending `key = value` to the end of the file is wrong in a way that looks
// right: if the file ends inside a table — `[mcp_servers.foo]` is the realistic
// case — the appended line becomes a field of that table, Codex never sees the
// setting, and a `grep` for the line reports success. The file is therefore read,
// split at the first table header, and the assignment placed in the region that
// belongs to no table.
export function rootTomlWithSetting(contents, setting, value) {
  const lines = contents.length === 0 ? [] : contents.replace(/\n$/, "").split("\n");
  const assignment = `${setting} = ${value}`;
  const tableHeader = /^\s*\[/;
  const existing = new RegExp(`^\\s*${setting}\\s*=`);

  let firstTable = lines.findIndex((line) => tableHeader.test(line));
  if (firstTable === -1) firstTable = lines.length;

  // Only an assignment before the first table header is a root-table setting.
  // One inside a table has the same name and a different meaning, and must be
  // left exactly where it is.
  const rootRegion = lines.slice(0, firstTable);
  const existingIndex = rootRegion.findIndex((line) => existing.test(line));
  if (existingIndex !== -1) {
    rootRegion[existingIndex] = assignment;
  } else {
    if (rootRegion.length > 0 && rootRegion[rootRegion.length - 1].trim() !== "") rootRegion.push("");
    rootRegion.push(assignment);
    if (firstTable < lines.length) rootRegion.push("");
  }
  return `${[...rootRegion, ...lines.slice(firstTable)].join("\n").replace(/\n+$/, "")}\n`;
}

function writeRootTomlSetting(file, setting, value, adapter) {
  // Read as the runtime user, through the same boundary the runtime will use.
  // Root could read it directly, but then a home on a network mount root cannot
  // traverse, or an ACL that denies the runtime, would be invisible here and
  // fatal at the runtime's first session.
  //
  // "Absent" and "there but unreadable" are different answers and get different
  // exit codes. `test -e f && cat f || true` collapsed them into success with an
  // empty stdout: a config the runtime user could not read became an empty
  // string, and the empty string was then written back over the operator's file.
  // The whole configuration would have been silently replaced by one line.
  const read = runtimeProbeShell(adapter, [
    `if [ -L "${file}" ]; then exit 12; fi`,
    `if [ -d "${file}" ]; then exit 13; fi`,
    `if [ ! -e "${file}" ]; then exit 10; fi`,
    `cat "${file}" || exit 11`,
  ].join("\n"));

  let current;
  if (read.ok) current = read.stdout;
  else if (read.code === 10) current = "";
  else if (read.code === 11) {
    return { ok: false, reason: `${file} exists but ${adapter.user} cannot read it${read.stderr ? `: ${read.stderr}` : ""}` };
  } else if (read.code === 13) {
    return { ok: false, reason: `${file} is a directory, not a configuration file` };
  } else if (read.code === 12) {
    // A symlink here is either an operator's deliberate arrangement or someone
    // aiming the write somewhere else. Either way this command does not follow
    // it: writing through it would put the file, and its 0600, somewhere nobody
    // asked for.
    return { ok: false, reason: `${file} is a symlink; this command writes the file itself, not through a link to it` };
  } else {
    return { ok: false, reason: `${file} could not be read as ${adapter.user}: ${read.stderr || `exit ${read.code}`}` };
  }

  const updated = rootTomlWithSetting(current, setting, value);

  // The contents go in on **stdin**, never in argv.
  //
  // The first version base64'd the whole file into a `/bin/sh -c` argument. On
  // an ordinary Linux host `/proc/<pid>/cmdline` is world-readable, so every
  // local user — including the other runtime's user — could read the entire
  // configuration of a runtime out of the process table for as long as the
  // command ran. A config.toml holds API base URLs, MCP server commands and
  // whatever else an operator put there; none of it is ours to broadcast.
  //
  // What is left in argv is the path, which is a constant of the installation.
  const script = [
    "set -eu",
    `umask 077`,
    `mkdir -p "$(dirname "${file}")"`,
    `cat > "${file}.tmp-$$"`,
    // 0600 explicitly rather than by umask alone: the temporary file inherits
    // nothing from the file it replaces, and a config that lands world-readable
    // because the old one was is not a mode this should carry forward.
    `chmod 600 "${file}.tmp-$$"`,
    `mv "${file}.tmp-$$" "${file}"`,
  ].join("\n");
  const result = runtimeProbeShell(adapter, script, { input: updated });
  if (!result.ok) return { ok: false, reason: result.stderr || `exit ${result.code}` };

  // Read back through the same boundary: what matters is what the runtime user
  // can see, not what root believes it wrote.
  const verify = runtimeProbeShell(adapter, `cat "${file}"`);
  if (!verify.ok) return { ok: false, reason: `could not read ${file} back as ${adapter.user}` };
  if (!rootTableHas(verify.stdout, setting, value)) {
    return { ok: false, reason: `${setting} is not set in the root table of ${file} after writing it` };
  }
  return { ok: true };
}

// Is the setting in effect at the root of this document? The same key inside a
// table is a different setting with the same name.
export function rootTableHas(contents, setting, value) {
  for (const line of contents.split("\n")) {
    if (/^\s*\[/.test(line)) return false;
    if (new RegExp(`^\\s*${setting}\\s*=\\s*${value}\\s*$`).test(line)) return true;
  }
  return false;
}

function runtimeProbeShell(adapter, script, { input = undefined } = {}) {
  return run(RUNUSER, [
    "-u", adapter.user, "--", "/usr/bin/env", "-i",
    `HOME=${adapter.home}`, `PATH=${RUNTIME_PATH}`, "LANG=C.UTF-8", ...runtimeEnvironment(adapter),
    "/bin/sh", "-c", script,
  ], { timeout: 30_000, ...(input === undefined ? {} : { input }) });
}

// ---------------------------------------------------------------------------
// The admission fence
// ---------------------------------------------------------------------------

// Ask the supervisor to stop admitting launches of one runtime, then wait for
// the ones already open to finish on their own.
//
// The previous version stopped `infra-cod-runtime-supervisor.service`. That was
// worse than the race it closed. The unit is shared by both runtimes and its
// shutdown terminates every child channel, so installing Codex would have killed
// a live OpenCode session — the precise harm the rule against replacing a tree
// under running work exists to prevent. It could not even close its own race:
// a session admitted between the `pgrep` and the stop was ended by the stop
// rather than protected from it.
//
// The fence therefore lives where admission is decided. `pause` refuses new
// launches of this runtime from that moment; nothing running is touched, and the
// other runtime is not affected at all. Then this waits for the count to reach
// zero — waits, never kills.
export const LAUNCH_UNIT = "infra-cod-runtime-supervisor.service";
// An explicit socket path is taken as given; only the default goes through the
// sandbox prefix, or a harness pointing at its own socket would have the prefix
// applied twice.
const SUPERVISOR_SOCKET = (process.env.RUNTIME_SUPERVISOR_SOCKET ?? "").trim()
  || sys("/run/infra-cod/runtime-supervisor.sock");

// One connection, held open for the whole switch, over which every maintenance
// request travels.
//
// The short-lived-connection version got both failure directions wrong. An
// installer killed mid-switch left the runtime fenced off with nothing to
// release it. A supervisor restart silently dropped the fence while this process
// carried on believing it held one — and then moved the symlink with no fence at
// all, which is the worse of the two.
//
// A socket has exactly the lifetime that matters: it dies when either end dies.
export function openSupervisorLink({ socketPath = SUPERVISOR_SOCKET } = {}) {
  const socket = netConnect(socketPath);
  const waiting = new Map();
  let failure = null;

  const fail = (error) => {
    failure = failure ?? error;
    for (const { reject } of waiting.values()) reject(error);
    waiting.clear();
  };

  const ready = new Promise((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });

  let buffer = "";
  socket.on("data", (chunk) => {
    buffer += chunk;
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      const pending = waiting.get(message.request_id);
      if (!pending) continue;
      waiting.delete(message.request_id);
      if (message.ok === false) pending.reject(new RuntimeError(message.error ?? "the supervisor refused"));
      else pending.resolve(message.result);
    }
  });
  socket.on("error", (error) => fail(error));
  socket.on("close", () => fail(new RuntimeError("the connection to the supervisor closed")));

  return {
    async connect() {
      await ready;
    },
    // True only while this very connection is open. If the supervisor restarted,
    // this is false, and whatever it granted is gone with it.
    held() {
      return failure === null && !socket.destroyed && socket.writable;
    },
    request(payload, { timeoutMs = 15_000 } = {}) {
      if (failure) return Promise.reject(failure);
      const requestId = randomUUID();
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          waiting.delete(requestId);
          reject(new RuntimeError(`the supervisor did not answer within ${timeoutMs}ms`));
        }, timeoutMs);
        waiting.set(requestId, {
          resolve: (value) => { clearTimeout(timer); resolve(value); },
          reject: (error) => { clearTimeout(timer); reject(error); },
        });
        socket.write(`${JSON.stringify({ ...payload, request_id: requestId })}\n`);
      });
    },
    close() {
      socket.destroy();
    },
  };
}

// Closes the fence and hands back the way to open it again, plus the way to
// check it is still held. The caller releases it in a `finally`: a runtime left
// unable to launch is a worse outcome than the race this closes.
export async function closeAdmission(name, { reporter, waitSeconds = 0, link = null, hold = holdRuntimeFence }) {
  const owned = link === null;
  const connection = link ?? openSupervisorLink();
  let status;
  try {
    await connection.connect();
    status = await connection.request({
      type: "runtime_maintenance", action: "pause", runtime: name, reason: "runtime installation",
    });
  } catch (error) {
    if (owned) connection.close();
    // No fence, no switch. An installation that cannot stop new sessions
    // starting is an installation that can replace a tree underneath one.
    if (error.code === "ENOENT") {
      throw new RuntimeError(
        `the supervisor is not listening on ${SUPERVISOR_SOCKET}, so new sessions cannot be fenced off. `
        + "Start it, or stop it deliberately, before installing a runtime.",
      );
    }
    throw new RuntimeError(`the supervisor would not hold launches of ${name} (${error.message}); the switch is not fenced`);
  }

  const grantedBy = status.supervisor_id ?? null;
  reporter.step(`supervisor is holding new ${name} launches (${status.in_flight} in flight)`);

  // Called immediately before anything irreversible. The connection being open
  // is the proof: a restarted supervisor closed it, and a supervisor that never
  // closed it is the one that granted the fence.
  const assertHeld = async () => {
    if (!connection.held()) {
      throw new RuntimeError(
        `the connection holding ${name}'s launches closed, so the fence is gone. `
        + "Nothing was switched. The supervisor most likely restarted; run the install again.",
      );
    }
    const now = await connection.request({ type: "runtime_maintenance", action: "status", runtime: name });
    if (!now.paused || (grantedBy !== null && now.supervisor_id !== grantedBy)) {
      throw new RuntimeError(
        `${name} is no longer fenced off (paused: ${now.paused}). Nothing was switched.`,
      );
    }
    if (now.in_flight > 0) {
      throw new RuntimeError(`${now.in_flight} ${name} launch(es) started while this install was preparing; nothing was switched`);
    }
  };

  const release = async (report = reporter) => {
    let asked = false;
    try {
      if (connection.held()) {
        const resumed = await connection.request({ type: "runtime_maintenance", action: "resume", runtime: name });
        asked = !resumed.paused;
        if (asked) report.step(`supervisor is admitting ${name} launches again`);
      }
    } catch (error) {
      report.step(`the supervisor would not resume ${name} on request (${error.message}); closing the connection instead`);
    } finally {
      // Closing is itself a release: the supervisor drops whatever a connection
      // was holding when it goes. That is what makes a killed installer
      // harmless, and it is the fallback when the polite request fails.
      if (owned) connection.close();
    }
    if (asked) return true;

    // Not taken on trust. A supervisor that does not release on close — an older
    // one, or one that is wedged — would leave the runtime fenced off with
    // nothing left to ask, so the state is read back over a fresh connection.
    if (!owned) return false;
    try {
      const check = openSupervisorLink();
      try {
        await check.connect();
        const now = await check.request({ type: "runtime_maintenance", action: "status", runtime: name });
        if (now.paused) {
          report.step(`WARNING: ${name} launches are still held by the supervisor`);
          return false;
        }
        report.step(`${name} launches are admitted again (the holding connection closed)`);
        return true;
      } finally {
        check.close();
      }
    } catch (error) {
      // The supervisor is unreachable. Nothing it was holding survives a
      // restart, so a fence is not what is wrong here — but say so plainly
      // rather than call it success.
      report.step(`WARNING: could not confirm that ${name} launches are admitted again (${error.message})`);
      return false;
    }
  };

  const deadline = Date.now() + waitSeconds * 1_000;
  let lock = null;
  try {
    while (status.in_flight > 0) {
      if (Date.now() >= deadline) {
        throw new RuntimeError(
          `${status.in_flight} ${name} launch(es) are still open. `
          + "They are not interrupted: replacing the tree underneath them would end whatever they are doing "
          + "to a workspace mid-run. Wait for them to finish, or re-run with --wait <seconds>.",
        );
      }
      reporter.step(`waiting for ${status.in_flight} ${name} launch(es) to finish`);
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      status = await connection.request({ type: "runtime_maintenance", action: "status", runtime: name });
    }
    // The supervisor says it is holding admissions and has none in flight. Now
    // take the lock that says so to every process on the machine, including the
    // supervisor that has not started yet.
    //
    // This is what closes the generation gap. A pause lives in one process's
    // memory; a new supervisor begins with none of it and would admit a launch
    // between the switch and the check that follows it. An exclusive lock on the
    // fence file cannot be ignored by a process that did not exist when it was
    // taken, because the kernel is the one holding it.
    lock = await hold(name, { mode: "exclusive" });
    reporter.step(`${name}'s fence is held exclusively; no process on this host can launch it`);
  } catch (error) {
    await release();
    throw error;
  }

  return {
    async release(report = reporter) {
      // The lock goes first: while it is held, nothing can launch, so releasing
      // the polite pause before it would be releasing nothing.
      lock?.release();
      return release(report);
    },
    assertHeld: async () => {
      // The lock is the answer, and it is a local fact: the child holding it and
      // this check are the same thing, so there is no window between asking and
      // being told.
      if (!lock?.held()) {
        throw new RuntimeError(
          `${name}'s fence is no longer held, so nothing can be shown to have been fenced. `
          + "Nothing was switched.",
        );
      }

      // The supervisor dying is no longer fatal, and that is the point of the
      // lock. A restarted supervisor cannot launch this runtime while the file
      // is held exclusively, so there is nothing to protect the switch from and
      // nothing to undo. Before the lock, this had to abort — and even then the
      // abort was incomplete, because a session admitted in the gap went on
      // running a version the rollback had just made inactive.
      try {
        await assertHeld();
      } catch (error) {
        reporter.step(`the supervisor connection is gone (${error.message}); the fence lock still holds, so the switch continues`);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// The intent record, for the crash the rollback cannot catch
// ---------------------------------------------------------------------------

// Written before the symlink moves, removed after the inventory is written.
//
// The in-process rollback handles every failure the process survives. It cannot
// handle SIGKILL, a power cut, or the OOM killer arriving between the two: the
// host is then running the new tree under a record describing the old one, and
// nothing that reads the record afterwards knows it. `verify` used to be offered
// as the reconcile path for this, which was untrue — it re-asked questions about
// whatever the record named and never compared the record with the link.
//
// This file is the durable half. It survives the crash, `verify` reports it, and
// `reconcile` finishes or undoes the switch it describes.
export const INTENT_SCHEMA = "infra-cod/runtime-switch/1";

// Durability, to the extent a userspace program can have it: the bytes, then the
// directory entry that names them.
function fsyncDirectory(directory) {
  const handle = openSync(directory, "r");
  try {
    fsyncSync(handle);
  } finally {
    closeSync(handle);
  }
}

export function intentFile(name) {
  // Beside the inventory, because they describe the same thing and a host that
  // has one must have the other.
  return path.join(path.dirname(RUNTIMES_FILE), `runtime-switch.${name}.json`);
}

function recordIntent(name, intent) {
  const file = intentFile(name);
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    const temporary = `${file}.tmp-${process.pid}`;
    const handle = openSync(temporary, "w", 0o600);
    try {
      writeFileSync(handle, `${JSON.stringify({ schema: INTENT_SCHEMA, ...intent }, null, 2)}\n`);
      // On disk, not merely in the page cache. `write` then `rename` is atomic
      // with respect to a crash of *this process*; it says nothing about a power
      // cut, where the rename can reach the disk before the bytes it renames, or
      // the symlink can outlive an intent that never got there. The file's data,
      // then the directory entry, in that order.
      fsyncSync(handle);
    } finally {
      closeSync(handle);
    }
    renameSync(temporary, file);
    fsyncDirectory(path.dirname(file));
  } catch (error) {
    // Durable before irreversible. A switch nobody could later reconstruct is
    // not a switch worth making, so this refuses rather than proceeding
    // unrecorded.
    throw new RuntimeError(
      `the switch could not be recorded in ${file} (${error.message}), so it was not made. `
      + "That file is what a later command would use to finish or undo an interrupted switch.",
    );
  }
}

function clearIntent(name) {
  rmSync(intentFile(name), { force: true });
}

export function readIntent(name) {
  const file = intentFile(name);
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new RuntimeError(`${file} is not readable JSON (${error.message}); it records an interrupted switch and cannot be guessed at`);
  }
}

// What the link says, what the record says, and whether they agree.
export function reconciliationOf(name) {
  const adapter = adapterFor(name);
  const link = activeLink(adapter.executable);
  const entry = readRuntimes().runtimes[name] ?? null;
  const intent = readIntent(name);

  let target = null;
  try {
    target = lstatSync(link).isSymbolicLink() ? readlinkSync(link) : null;
  } catch { /* absent */ }

  const recorded = entry?.active ? path.join(entry.active.directory, adapter.executablePath) : null;

  // Compared by directory, not by version: a rebuilt package of the same version
  // is a different tree with the same number, and comparing numbers would call
  // that agreement.
  const agree = canonical(String(target)) === canonical(String(recorded));
  return { name, link, target, recorded, intent, agree, entry };
}

// Refuses to act on a host whose symlink and record describe different
// installations, or one carrying the record of an interrupted switch.
//
// Everything except `reconcile` goes through here. A mutation applied on top of
// an unexplained state produces a second unexplained state, and the evidence for
// the first is gone.
export function assertConsistentBefore(name, action) {
  const state = reconciliationOf(name);
  if (state.agree && !state.intent) return state;

  throw new RuntimeError(
    `${name} is in a state this host cannot describe, so ${action} it would make that worse.\n`
    + `  on PATH:   ${state.target ?? "(nothing)"}\n`
    + `  recorded:  ${state.recorded ?? "(nothing)"}\n`
    + (state.intent ? `  A switch to ${state.intent.version} was interrupted; ${intentFile(name)} is the record of it.\n` : "")
    + `  Run \`infra-cod runtime reconcile ${name}\` first — it is the one command that repairs this, `
    + "and the only one that will not overwrite the evidence.",
  );
}

// A directory no installation has used before. Installed trees are immutable, so
// a second install of the same version gets its own, and the symlink decides
// which one is in use — one atomic operation, no window where the command on
// PATH names something that is not there.
// Directories on disk under a runtime's root that the inventory does not name.
//
// The record is the product's account of the host, and until now it was also the
// product's only way of seeing it: `remove` read directories out of the record,
// so a tree the record had never heard of could not be named, listed or deleted
// by any command. The host produced one — a failed install left 324 MB behind —
// and the answer was `rm -rf` typed by hand, which is the answer this whole file
// exists to avoid.
//
// Read from disk on purpose, and bounded to one runtime's own directory.
export function orphanedDirectories(name) {
  const root = path.dirname(versionDirectory(name, "unused"));
  if (!existsSync(root)) return [];
  const entry = readRuntimes().runtimes[name];
  const known = new Set([
    ...(entry?.installed ?? []).map((installed) => installed.directory),
    ...(entry?.active ? [entry.active.directory] : []),
  ]);
  return readdirSync(root)
    .map((child) => path.join(root, child))
    .filter((directory) => !known.has(directory))
    .filter((directory) => statSync(directory, { throwIfNoEntry: false })?.isDirectory())
    .sort();
}

function uniqueVersionDirectory(name, version) {
  const base = versionDirectory(name, version);
  if (!existsSync(base)) return base;
  for (let attempt = 2; attempt < 1000; attempt += 1) {
    const candidate = `${base}+${attempt}`;
    if (!existsSync(candidate)) return candidate;
  }
  throw new RuntimeError(`${base} already has 1000 installations; remove some with \`infra-cod runtime remove\``);
}

// Waits, bounded, for a runtime to stop being used, and refuses if it does not.
async function waitForIdleRuntime(adapter, { reporter, waitSeconds = 0 }) {
  const deadline = Date.now() + waitSeconds * 1_000;
  let busy = runningProcesses(adapter);
  while (busy.length > 0 && Date.now() < deadline) {
    reporter.step(`waiting for ${busy.length} ${adapter.name} process(es) to finish`);
    await new Promise((resolve) => setTimeout(resolve, 5_000));
    busy = runningProcesses(adapter);
  }
  if (busy.length > 0) {
    throw new RuntimeError(
      `${busy.length} ${adapter.name} process(es) are running as ${adapter.user}. `
      + "Replacing the tree underneath them would end whatever they are doing to a workspace mid-run. "
      + (waitSeconds > 0
        ? `They did not finish within ${waitSeconds}s.`
        : "Wait for them to finish, or re-run with --wait <seconds> to wait for them."),
    );
  }
  return busy;
}

// Which processes of this runtime are running as its user. `pgrep -u <user>`
// answers the question the drain actually asks: not "is something called codex
// running somewhere" but "is this runtime's user running it".
export function runningProcesses(adapter, { pattern = null } = {}) {
  const result = run("pgrep", ["-u", adapter.user, "-f", pattern ?? adapter.executable], { timeout: 15_000 });

  // `pgrep` says "no matches" with exit 1 and nothing else. Every other non-zero
  // code is a different statement: 2 is a usage or `/proc` error, 3 is a fatal
  // one, and a missing binary does not report at all. Treating them all as "no
  // processes" is the fail-open reading — the answer that lets an install
  // replace the tree underneath running sessions precisely when the machine has
  // stopped being able to tell us about them.
  if (result.code === 1 && result.stdout.trim().length === 0) return [];
  if (!result.ok) {
    throw new RuntimeError(
      `whether ${adapter.name} is running as ${adapter.user} could not be determined: `
      + `pgrep exited ${result.code}${result.stderr ? ` (${result.stderr.split("\n")[0]})` : ""}. `
      + "An install will not replace a tree it cannot prove is idle.",
    );
  }
  return result.stdout.split("\n").map((line) => line.trim()).filter(Boolean);
}

// Asks the staged binary its version, as the runtime user, by absolute path —
// before anything on PATH points at it.
function smokeTest(adapter, executable, version) {
  const result = runtimeProbe(adapter, executable, adapter.versionProbe, { cwd: adapter.home });
  if (!result.ok) return { ok: false, detail: result.stderr || `exit ${result.code}` };
  const reported = result.stdout.split("\n")[0] ?? "";
  if (!reported.includes(version)) {
    return { ok: false, detail: `it reports ${JSON.stringify(reported)}, which does not contain ${version}`, reported };
  }
  return { ok: true, reported };
}

// `mv -T` semantics for the symlink, so the command on PATH resolves to a
// complete installation at every instant.
function switchActive(adapter, executable, { expect = null } = {}) {
  const link = activeLink(adapter.executable);
  mkdirSync(path.dirname(link), { recursive: true });
  const previous = assertOursToReplace(link, adapter, expect);
  const temporary = `${link}.tmp-${process.pid}`;
  rmSync(temporary, { force: true });
  symlinkSync(executable, temporary);
  renameSync(temporary, link);
  // The rename that makes the new version live must reach the disk too, or a
  // power cut can leave the intent recorded and the switch it describes undone —
  // which reconcile would then read as "the switch was interrupted" when in fact
  // it never happened. Both orders are recoverable; neither being durable is
  // not.
  try {
    fsyncDirectory(path.dirname(link));
  } catch { /* a filesystem that will not fsync a directory is not a reason to undo the switch */ }
  return previous;
}

// As far as the filesystem can resolve it; a path that does not exist yet keeps
// its lexical form, which is enough to decide where it aims.
function canonical(target) {
  try {
    return realpathSync(target);
  } catch {
    try {
      return path.join(realpathSync(path.dirname(target)), path.basename(target));
    } catch {
      return target;
    }
  }
}

// What is at `/usr/local/bin/<name>` right now, and whether this install has any
// business replacing it.
//
// `renameSync` replaces whatever is there — a regular file included. The earlier
// version could not tell "nothing is there" from "somebody else's binary is
// there", because both answered `null`: an operator's hand-installed `codex`, a
// distribution package's, or a colleague's build would have been silently
// destroyed, and then, if the inventory write failed, deleted outright by the
// rollback.
//
// So: absent is fine, a symlink into this host's runtime tree is fine, and
// anything else stops the install and says what is in the way.
function assertOursToReplace(link, adapter, expect = null) {
  let stat;
  try {
    stat = lstatSync(link);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw new RuntimeError(`${link} could not be examined: ${error.message}`);
  }

  if (!stat.isSymbolicLink()) {
    throw new RuntimeError(
      `${link} is ${stat.isDirectory() ? "a directory" : "a regular file"}, not a symlink this host manages. `
      + `${adapter.name} is installed by pointing that name at a tree under ${RUNTIME_ROOT}; `
      + "replacing something else that happens to have the name would destroy it. "
      + "Move it aside first if it is no longer wanted.",
    );
  }

  const target = readlinkSync(link);
  // Both sides canonical, for the same reason the archive check needs it: on
  // macOS `/var` is itself a link, so comparing a resolved target against an
  // unresolved boundary calls a perfectly contained path an escape.
  const resolved = canonical(path.resolve(path.dirname(link), target));
  // RUNTIME_ROOT already goes through the sandbox prefix where there is one;
  // putting it through a second time names a path that exists nowhere.
  const root = canonical(RUNTIME_ROOT);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    throw new RuntimeError(
      `${link} points at ${target}, which is outside ${RUNTIME_ROOT}. `
      + "That link was not made by this command, and this command will not take it over.",
    );
  }

  // Used by the rollback: the link must still be the one we moved, or somebody
  // else has been here and putting "ours" back would undo their work.
  if (expect !== null && target !== expect) {
    throw new RuntimeError(`${link} now points at ${target}, not at ${expect}; it was changed by something else`);
  }
  return target;
}

// The symlink and the record are one operation or they are a lie.
//
// The switch happens first and the record second, so a failure in between — a
// full disk, a write error, a SIGKILL — used to leave the new executable active
// under the old inventory while the command reported failure. Everything that
// reads the record afterwards (`list`, `doctor`, `remove`) would then be
// describing a host that no longer exists.
//
// So the link is put back. That cannot survive a SIGKILL between the two, which
// is why the record is written immediately after and why `verify` exists: what
// this closes is every failure the process is still alive to notice.
function switchAndRecord(adapter, executable, { write, reporter }) {
  const previous = switchActive(adapter, executable);
  try {
    write();
  } catch (error) {
    try {
      // The second fault-injection seam, for the case the rollback itself cannot
      // handle: a crash between the rename and the record. Sandbox-only, like
      // the first — without INFRA_COD_INSTALL_PREFIX it does nothing.
      if (HARNESS && process.env.INFRA_COD_HARNESS_FAIL_ROLLBACK === "1") {
        throw new Error("harness: the rollback was made to fail");
      }
      if (previous) {
        switchActive(adapter, previous, { expect: executable });
        reporter.step(`${activeLink(adapter.executable)} put back to ${previous}: the record could not be written`);
      } else {
        // Only a link this call created is removed, and only if it is still the
        // one this call created.
        assertOursToReplace(activeLink(adapter.executable), adapter, executable);
        rmSync(activeLink(adapter.executable), { force: true });
        reporter.step(`${activeLink(adapter.executable)} removed: the record could not be written`);
      }
    } catch (rollbackFailure) {
      const divergence = new RuntimeError(
        `${adapter.name} was activated, ${RUNTIMES_FILE} could not be written (${error.message}), `
        + `and the link could not be put back (${rollbackFailure.message}). `
        + `${activeLink(adapter.executable)} and ${RUNTIMES_FILE} disagree; `
        + `run \`infra-cod runtime reconcile ${adapter.name}\`.`,
      );
      divergence.divergent = true;
      throw divergence;
    }
    throw new RuntimeError(
      `${adapter.name} was activated but ${RUNTIMES_FILE} could not be written (${error.message}). `
      + "The link was put back, so the record and the host still agree.",
    );
  }
}

// ---------------------------------------------------------------------------
// list, verify, remove
// ---------------------------------------------------------------------------

// Exists, and is not empty — asked of the file as its owner, by exit code. The
// contents never reach this process, which is the point: a count would be
// harmless and the credential would not, and `test -s` needs neither.
function defaultEvidenceProbe(adapter, evidence) {
  return runtimeProbeShell(adapter, `test -s ${JSON.stringify(path.join(adapter.home, evidence.path))}`);
}

// Whether the runtime user holds a usable credential — asked of the runtime, and
// then, where the runtime cannot answer, of the evidence.
//
// `codex login status` exits 1 with no account, so its exit code is an answer.
// `opencode auth list` exits 0 either way: measured on the host, an empty store
// prints "0 credentials" and returns success. Believing it reported a runtime
// with no credential as authenticated, which is precisely the collapse the four
// states exist to prevent — green in the panel, admitted by dispatch, and broken
// at the first provider call.
//
// So an adapter may name a file that must exist and be non-empty. It is tested
// as the runtime user, by exit code, and never read: a credential store's
// contents are not something this process needs to have held. A missing file is
// "not authenticated", which refuses work — the direction that costs a puzzled
// minute rather than a failed run.
export function authenticationOf(adapter, { probe = runAsRuntimeUser, evidence: evidenceProbe = defaultEvidenceProbe } = {}) {
  const evidence = adapter.authEvidence ?? null;

  // Where an adapter declares evidence, the evidence is the whole answer and the
  // probe is not run at all.
  //
  // Not a shortcut — the probe was never going to answer. `opencode auth list`
  // returns 0 either way, so its only remaining contribution was a process
  // launch, and launching it turned out to have a cost: OpenCode opens a log
  // file in its home on startup, so the probe needs a *writable* home. The
  // health snapshot runs every minute from a hardened root unit, and buying a
  // writable `/home` for an answer the probe does not give is a bad trade.
  //
  // `test -s` needs only to read.
  if (evidence) {
    const present = evidenceProbe(adapter, evidence);
    if (present.ok) return { ok: true, detail: "the runtime reports a usable credential" };
    return {
      ok: false,
      detail: `${adapter.name} answers its auth probe either way, and ${evidence.of} is empty or absent`,
    };
  }

  const result = probe(adapter, adapter.authProbe);
  // The probe's own words, never its output: an auth probe prints account state,
  // and account state is not something this file records.
  return result.ok
    ? { ok: true, detail: "the runtime reports a usable credential" }
    : { ok: false, detail: "the runtime reports no usable credential" };
}

// The four states the plan refuses to let the UI collapse. They are answered
// separately here because they fail separately: a binary that is present and
// unauthenticated is a different problem from one that is authenticated and
// unverified.
export function readinessOf(name, { probe = runAsRuntimeUser } = {}) {
  const adapter = adapterFor(name);
  const entry = readRuntimes().runtimes[name];
  // The release baseline (R15): the pair this release's driver was verified
  // at, and what verifies the version the host runs — the baseline itself or a
  // host qualification recorded on the active tree — as doctor reports it.
  // Reported so the database knows it, rather than the panel inferring it.
  const driver = driverFor(name);
  const baseline = { baselineVersion: driver.verified.runtimeVersion, adapterVersion: driver.verified.adapterVersion };
  if (!entry?.active) {
    return { runtime: name, installed: false, authenticated: false, capabilityVerified: false, ready: false, ...baseline, verifiedBy: null };
  }
  const verification = capabilityVerification(driver, entry.active.version, { qualification: activeQualification(entry) });

  const executable = path.join(entry.active.directory, adapter.executablePath);
  const installed = existsSync(executable) && existsSync(activeLink(adapter.executable));

  let authenticated = false;
  let authDetail = null;
  if (installed) {
    const answer = authenticationOf(adapter, { probe });
    authenticated = answer.ok;
    authDetail = answer.detail;
  }

  const autoUpdate = entry.verification?.autoUpdate ?? null;

  return {
    runtime: name,
    version: entry.active.version,
    installed,
    authenticated,
    authDetail,
    // Surfaced rather than buried in the record: a runtime free to change its
    // own version is a fact about this host, and the three places that report on
    // the host all show it.
    selfUpdateManaged: autoUpdate?.verified === true,
    selfUpdateNote: autoUpdate?.verified === true ? null : (autoUpdate?.reason ?? "no auto-update control has been verified"),
    // Capability verification is the gate's business (11.2/11.4). Until it has
    // run for this exact tuple, this is honestly false rather than assumed.
    capabilityVerified: false,
    ready: false,
    ...baseline,
    verifiedBy: verification.verified_by,
  };
}

// A qualification as `infra-cod runtime qualify` runs it — beside the active
// version, under the host lock, recorded — for the command and for the update
// pass (0127) alike.
export async function qualifyAndRecord({ name, version, actor, reporter, stdout, record = true, turns: withTurns = true }) {
  const { qualifyRuntime, memoryRecorder } = await import("./runtime-qualify.mjs");
  const recorder = record ? (await import("./runtime-qualify-record.mjs")).databaseRecorder() : memoryRecorder();
  let releaseVersion = "development";
  try {
    const directory = currentReleaseDirectory();
    if (directory) releaseVersion = readManifest(directory).version;
  } catch {
    releaseVersion = "unknown";
  }
  let outcome;
  try {
    // The turn checks run through the supervisor; `--no-turns` leaves them out.
    const turns = withTurns ? (await import("./runtime-qualify-turns.mjs")).supervisorTurns({
      connect: async () => {
        const { RuntimeSupervisorClient } = await import("../runtime-supervisor/client.mjs");
        const client = new RuntimeSupervisorClient();
        await client.connect();
        return client;
      },
    }) : null;
    outcome = await withHostLock(async () => qualifyRuntime({ name, version, actor, reporter, recorder, releaseVersion, turns }));
  } finally {
    await recorder.close?.();
  }
  // A complete, passed qualification is recorded on the tree itself, where
  // the supervisor and doctor read it: the version is then verified on
  // this host under this adapter (W3c).
  if (outcome.result === "passed" && record) {
    const { driverFor } = await import("../runtime-supervisor/drivers/index.mjs");
    recordQualification(name, version, {
      id: outcome.id, result: "passed", adapterVersion: driverFor(name).verified.adapterVersion, passedAt: new Date().toISOString(),
    });
    stdout.write(`${name} ${version} is now verified on this host (qualification ${outcome.id})\n`);
  }
  stdout.write(`${name} ${version}: ${outcome.result.toUpperCase()}${outcome.summary ? ` — ${outcome.summary}` : ""}\n`);
  if (outcome.id && record) stdout.write(`qualification ${outcome.id}\n`);
  return outcome;
}

async function recordActivation({ kind, actor, reason, outcome, stderr }) {
  try {
    const { recordRuntimeActivation } = await import("./runtime-activation-record.mjs");
    await recordRuntimeActivation({ kind, actor, reason, ...outcome });
  } catch (error) {
    stderr.write(`infra-cod runtime: WARNING: the ${kind} happened, but the database record failed: ${error.message}\n`);
  }
}

// A promotion as `infra-cod runtime promote` runs it, for the command and for
// the panel's button (0127): under the host lock, recorded for the panel and
// for probation.
export async function promoteAndRecord({ name, version, actor, reporter, stderr, waitSeconds = 0, reason = null,
  acceptUnqualified = false, record = true }) {
  const outcome = await withHostLock(async () => promoteRuntime({ name, version, actor, reporter, waitSeconds, reason, acceptUnqualified }));
  if (record) await recordActivation({ kind: "promote", actor, reason, outcome, stderr });
  return outcome;
}

export async function runRuntime(argv = [], { stdout = process.stdout, stderr = process.stderr } = {}) {
  const [subcommand, ...rest] = argv;
  const reporter = {
    step(message) { stdout.write(`infra-cod runtime: ${message}\n`); },
  };

  try {
    switch (subcommand) {
      case "install": {
        const name = rest[0];
        const version = valueOf(rest, "--version");
        const actor = process.env.INFRA_COD_ACTOR ?? process.env.SUDO_USER ?? process.env.USER ?? "root";
        const acceptUnmanaged = rest.includes("--accept-unmanaged-updates");
        const waitIndex = rest.indexOf("--wait");
        const waitSeconds = waitIndex === -1 ? 0 : Number.parseInt(rest[waitIndex + 1] ?? "", 10);
        if (waitIndex !== -1 && !Number.isInteger(waitSeconds)) throw new RuntimeError("--wait takes a number of seconds");
        await withHostLock(async () => installRuntime({ name, version, actor, reporter, waitSeconds, acceptUnmanaged }));
        return 0;
      }
      // Stage 12 W2. Reads registry metadata and nothing else: no package is
      // fetched, nothing is installed. `--record` writes what it saw to the
      // database (the daily timer); `--check` exits 10 when a newer version is
      // old enough to be offered, for scripts and for the operator's shell.
      case "watch": {
        const names = rest.filter((argument) => !argument.startsWith("--"));
        for (const name of names) adapterFor(name);
        const inventory = readRuntimes().runtimes;
        const results = [];
        for (const name of names.length ? names : runtimeNames()) {
          results.push(await watchRuntime(name, { activeVersion: inventory[name]?.active?.version ?? null }));
        }
        if (rest.includes("--record")) {
          const { recordRuntimeWatch } = await import("./runtime-watch-record.mjs");
          await recordRuntimeWatch(results);
        }
        if (rest.includes("--json")) {
          stdout.write(`${JSON.stringify(results.map((result) => ({
            ...result, versions: result.versions.map((entry) => ({ ...entry, offered: isOffered(entry) })),
          })), null, 2)}\n`);
        } else {
          for (const result of results) {
            if (result.error) {
              stdout.write(`${result.runtime.padEnd(10)} ${String(result.activeVersion ?? "-").padEnd(10)} registry not read: ${result.error}\n`);
              continue;
            }
            const shown = result.versions.filter((entry) => !entry.deprecated);
            const summary = shown.length === 0 ? "up to date" : shown.slice(0, 5).map((entry) => (
              `${entry.version} (${isOffered(entry) ? "offered" : `offered from ${new Date(new Date(entry.published_at).getTime() + WATCH_MINIMUM_AGE_HOURS * 3600 * 1000).toISOString().slice(0, 16)}Z`})`
            )).join(", ") + (shown.length > 5 ? `, and ${shown.length - 5} more` : "");
            stdout.write(`${result.runtime.padEnd(10)} ${String(result.activeVersion ?? "-").padEnd(10)} ${summary}\n`);
          }
        }
        const offered = results.some((result) => result.versions.some((entry) => isOffered(entry)));
        if (results.every((result) => result.error)) return 1;
        return rest.includes("--check") && offered ? 10 : 0;
      }
      // Stage 12 W3: a candidate installed beside the active version and put
      // through the suite; the evidence goes to the database, which derives the
      // result. Nothing running changes.
      case "qualify": {
        const name = rest[0];
        const version = valueOf(rest, "--version");
        if (!name || !version) throw new RuntimeError("qualify takes a runtime and --version <exact>");
        const actor = process.env.INFRA_COD_ACTOR ?? process.env.SUDO_USER ?? process.env.USER ?? "root";
        const record = !rest.includes("--no-record");
        const outcome = await qualifyAndRecord({ name, version, actor, reporter, stdout, record, turns: !rest.includes("--no-turns") });
        return outcome.result === "passed" ? 0 : outcome.result === "incomplete" ? 3 : 1;
      }
      // Runtime updates without a terminal (0127): the panel's requests, then
      // a newer version nobody has qualified yet. The timer runs it with
      // --apply every five minutes; without --apply it says what it would do.
      case "updates": {
        const { runRuntimeUpdates } = await import("./runtime-updates.mjs");
        await runRuntimeUpdates({
          apply: rest.includes("--apply"), reporter, stdout,
          activeVersions: () => Object.fromEntries(Object.entries(readRuntimes().runtimes)
            .filter(([, entry]) => entry?.active).map(([runtime, entry]) => [runtime, entry.active.version])),
          qualify: ({ name, version, actor }) => qualifyAndRecord({ name, version, actor, reporter, stdout, record: true, turns: true }),
          promote: ({ name, version, actor, reason }) => promoteAndRecord({ name, version, actor, reporter, stderr, reason, waitSeconds: 600 }),
        });
        return 0;
      }
      case "list": {
        const document = readRuntimes();
        const json = rest.includes("--json");
        const report = runtimeNames().map((name) => ({
          ...readinessOf(name),
          record: document.runtimes[name]?.active ?? null,
        }));
        if (json) {
          stdout.write(`${JSON.stringify(report, null, 2)}\n`);
          return 0;
        }
        for (const runtime of report) {
          const states = [
            runtime.installed ? "installed" : "not installed",
            runtime.authenticated ? "authenticated" : "not authenticated",
            runtime.capabilityVerified ? "capability verified" : "capability not verified",
            runtime.selfUpdateManaged ? "self-update managed" : "SELF-UPDATE UNMANAGED",
          ];
          stdout.write(`${runtime.runtime.padEnd(10)} ${String(runtime.version ?? "-").padEnd(16)} ${states.join(", ")}\n`);
        }
        return 0;
      }
      case "verify": {
        const name = rest[0];
        const readiness = readinessOf(name);
        // What the link says and what the record says, compared — which is the
        // question `verify` was previously assumed to answer and did not. It
        // re-asked questions about whatever the record named, so a host whose
        // link and record disagreed passed.
        const state = reconciliationOf(name);
        // Trees the record does not name. Reported by `verify` because the
        // alternative is what happened on the host: 324 MB nobody could see
        // through the product, found with `du`.
        const orphans = orphanedDirectories(name);
        stdout.write(`${JSON.stringify({
          ...readiness,
          active_link: state.target,
          recorded: state.recorded,
          agrees: state.agree,
          interrupted_switch: state.intent ?? null,
          unrecorded_directories: orphans,
        }, null, 2)}\n`);
        if (orphans.length > 0) {
          stderr.write(
            `infra-cod runtime: ${orphans.length} director${orphans.length === 1 ? "y" : "ies"} under `
            + `${path.dirname(orphans[0])} ${orphans.length === 1 ? "is" : "are"} not in ${RUNTIMES_FILE}:\n`
            + orphans.map((directory) => `  ${directory}\n`).join("")
            + `  A failed install leaves one of these. Remove with \`infra-cod runtime remove ${name} --version <version>\`.\n`,
          );
        }
        if (!state.agree) {
          stderr.write(
            `infra-cod runtime: ${state.link} and ${RUNTIMES_FILE} do not describe the same installation.\n`
            + `  on PATH:   ${state.target ?? "(nothing)"}\n`
            + `  recorded:  ${state.recorded ?? "(nothing)"}\n`
            + (state.intent
              ? "  A switch was interrupted; the record of it is in "
                + `${intentFile(name)}.\n`
              : "")
            + `  Run \`infra-cod runtime reconcile ${name}\` to decide which one is real.\n`,
          );
          return 1;
        }
        return readiness.installed ? 0 : 1;
      }
      case "reconcile": {
        const name = rest[0];
        return await withHostLock(async () => reconcileRuntime({
          name,
          apply: rest.includes("--apply"),
          waitSeconds: rest.includes("--wait") ? Number.parseInt(valueOf(rest, "--wait"), 10) : 0,
          reporter,
          stdout,
          stderr,
        }));
      }
      case "remove": {
        const name = rest[0];
        const version = valueOf(rest, "--version");
        return await withHostLock(async () => removeRuntimeVersion({ name, version, reporter, stderr }));
      }
      case "login": {
        return loginRuntime(rest[0], { stderr });
      }
      // Stage 12 W4b. The probation after a promotion: the timer runs this
      // every ten minutes with --apply. A runtime-class failure at the promoted
      // version rolls it back; three runs and a day end the probation.
      case "probation": {
        const { probationVerdicts, endProbation, recordRuntimeActivation } = await import("./runtime-activation-record.mjs");
        const installed = Object.entries(readRuntimes().runtimes).filter(([, entry]) => entry?.active).map(([runtime]) => runtime);
        const { failed } = await applyProbationVerdicts(await probationVerdicts(installed), {
          apply: rest.includes("--apply"), stdout, stderr, end: endProbation, record: recordRuntimeActivation,
          rollback: (name, reason) => withHostLock(async () => rollbackRuntime({ name, actor: "probation", reporter, waitSeconds: 60, reason })),
        });
        return failed ? 1 : 0;
      }
      // Stage 12 W4. The switch a qualification earns, and the way back.
      case "promote":
      case "rollback": {
        const name = rest[0];
        const actor = process.env.INFRA_COD_ACTOR ?? process.env.SUDO_USER ?? process.env.USER ?? "root";
        const waitIndex = rest.indexOf("--wait");
        const waitSeconds = waitIndex === -1 ? 0 : Number.parseInt(rest[waitIndex + 1] ?? "", 10);
        if (waitIndex !== -1 && !Number.isInteger(waitSeconds)) throw new RuntimeError("--wait takes a number of seconds");
        const reason = rest.includes("--reason") ? valueOf(rest, "--reason") : null;
        const outcome = subcommand === "promote"
          ? await promoteAndRecord({ name, version: valueOf(rest, "--version"), actor, reporter, stderr, waitSeconds, reason,
            acceptUnqualified: rest.includes("--accept-unqualified"), record: !rest.includes("--no-record") })
          : await withHostLock(async () => rollbackRuntime({ name, actor, reporter, waitSeconds, reason }));
        // The database's record is the panel's; the switch stands without it,
        // and a record that could not be written is said, not hidden.
        if (subcommand === "rollback" && !rest.includes("--no-record")) {
          await recordActivation({ kind: subcommand, actor, reason, outcome, stderr });
        }
        stdout.write(`${name} ${outcome.from} -> ${outcome.version}: ${subcommand === "promote" ? "promoted" : "rolled back"}\n`);
        return 0;
      }
      default:
        stderr.write(
          "infra-cod runtime <install|qualify|promote|rollback|probation|watch|list|verify|reconcile|remove|login>\n\n"
          + "  install <name> --version <exact>   Install and activate a runtime.\n                                     --wait <seconds> waits for a version in use.\n"
          + "                                     --accept-unmanaged-updates installs a runtime\n"
          + "                                     whose self-update cannot be disabled.\n"
          + "  list [--json]                      Installed, authenticated, verified, ready.\n"
          + "  qualify <name> --version <exact>   Install a candidate beside the active version\n"
          + "                                     (not activated) and run the qualification suite;\n"
          + "                                     exit 0 passed, 3 incomplete, 1 failed or refused.\n"
          + "  watch [<name>] [--check] [--json]  Newer versions in the registry (metadata only;\n"
          + "                                     nothing is downloaded). --check exits 10 when\n"
          + "                                     one has been out 48 h; --record stores it.\n"
          + "  verify <name>                      Re-ask the questions, and compare the link\n"
          + "                                     on PATH with what is recorded.\n"
          + "  reconcile <name> [--apply]         Report, and with --apply repair, a switch\n"
          + "                                     interrupted between the two.\n"
          + "  promote <name> --version <exact>   Activate a version that passed qualification on\n"
          + "                                     this host; the active one is kept for rollback.\n"
          + "                                     --accept-unqualified --reason \"…\" in an emergency.\n"
          + "  rollback <name> [--reason \"…\"]     Back to the version active before the last\n"
          + "                                     promotion.\n"
          + "  probation [--apply]                The open probations after a promotion; --apply\n"
          + "                                     rolls back on a runtime failure (the timer's job).\n"
          + "  remove <name> --version <exact>    Remove a version that is not active.\n"
          + "  login <name>                       Sign the runtime in, as its own user, on this\n"
          + "                                     terminal (a runtime that has its own login).\n",
        );
        return subcommand ? 1 : 0;
    }
  } catch (error) {
    stderr.write(`infra-cod runtime: ${error.message}\n`);
    return 1;
  }
}

// The runtime's own login, run as its user on the operator's terminal
// (decision C3, sprint C). What it prints — a URL — and what it reads — the
// code the operator pastes — pass between the terminal and the runtime; this
// process holds neither, and the credential lands in the runtime's home, where
// its auth evidence then finds it. Only for a runtime that declares a login:
// the others sign in through the panel.
export function loginRuntime(name, { stderr = process.stderr, spawn: launch = spawnSync } = {}) {
  const adapter = adapterFor(name);
  if (!Array.isArray(adapter.login) || !adapter.login.length) {
    throw new RuntimeError(`${name} is signed in from the panel, not with runtime login`);
  }
  const readiness = readinessOf(name);
  if (!readiness.installed) {
    throw new RuntimeError(`${name} is not installed; install it first: infra-cod runtime install ${name} --version <exact>`);
  }
  const result = launch(RUNUSER, [
    "-u", adapter.user, "--", "/usr/bin/env", "-i",
    `HOME=${adapter.home}`, `PATH=${RUNTIME_PATH}`, `PWD=${adapter.home}`, "LANG=C.UTF-8",
    `TERM=${process.env.TERM ?? "dumb"}`, ...runtimeEnvironment(adapter),
    adapter.executable, ...adapter.login,
  ], { stdio: "inherit", cwd: sys(adapter.home) });
  if (result.error) throw new RuntimeError(`${name}'s login could not start: ${result.error.message}`);
  const after = readinessOf(name);
  if (!after.authenticated) {
    stderr.write(`infra-cod runtime: ${name} still reports no usable credential (${after.authDetail ?? "no detail"})\n`);
    return 1;
  }
  stderr.write(`infra-cod runtime: ${name} is signed in; the health snapshot reports it within a minute\n`);
  return result.status === 0 ? 0 : 1;
}

// Finishes, or undoes, a switch that was interrupted between the symlink and the
// record.
//
// This is the half the in-process rollback cannot do. A SIGKILL, a power cut or
// the OOM killer between `rename` and the inventory write leaves the host
// running one tree and describing another, and no amount of care inside the
// process that died can help. What can help is a file written before the rename
// and removed after the record — which is what this reads.
//
// It does not guess. Where the link and the record disagree it says so and,
// asked to act, brings the record up to what is actually on PATH when that tree
// is intact, or puts the link back on the recorded tree when it is not.
async function reconcileRuntime({ name, apply, waitSeconds = 0, reporter, stdout, stderr }) {
  const adapter = adapterFor(name);
  const state = reconciliationOf(name);

  if (state.agree && !state.intent) {
    stdout.write(`${name}: ${state.link} and ${RUNTIMES_FILE} agree (${state.target ?? "nothing installed"})\n`);
    return 0;
  }

  if (state.agree && state.intent) {
    // The switch completed; only the note saying it was in progress survived —
    // a crash after the record and before the file was removed.
    stdout.write(`${name}: the interrupted switch had in fact completed; clearing ${intentFile(name)}\n`);
    if (apply) rmSync(intentFile(name), { force: true });
    return apply ? 0 : 1;
  }

  stderr.write(
    `${name}: ${state.link} and ${RUNTIMES_FILE} disagree.\n`
    + `  on PATH:   ${state.target ?? "(nothing)"}\n`
    + `  recorded:  ${state.recorded ?? "(nothing)"}\n`,
  );
  if (!apply) {
    stderr.write("  Nothing was changed. Re-run with --apply to repair it.\n");
    return 1;
  }

  // Repair moves the same symlink an install moves, so it takes the same fence.
  // A recovery path with weaker guarantees than the operation it recovers from
  // is a way of doing the unsafe thing by asking differently.
  const fence = await closeAdmission(name, { reporter, waitSeconds });
  let outcome;
  try {
    // The fence covers admissions. Anything outside the supervisor — an
    // operator's own shell, a process left over from the crash being repaired —
    // is `pgrep`'s question, and repair moves the same symlink an install moves.
    await waitForIdleRuntime(adapter, { reporter, waitSeconds });
    await fence.assertHeld();
    outcome = repairRuntime({ name, adapter, state, reporter, stderr });
  } finally {
    if (!await fence.release()) {
      stderr.write(`${name} launches are still held by the supervisor; no session can start until that is cleared.\n`);
      // A repair that leaves the runtime unable to launch is not a success,
      // whatever it managed to fix. The earlier version printed this line and
      // returned the 0 it had already computed.
      outcome = 1;
    }
  }
  return outcome;
}

function repairRuntime({ name, adapter, state, reporter, stderr }) {
  // The tree on PATH decides, when there is one and it is whole: it is what the
  // host would run right now, and a record is a description of that, not the
  // other way round.
  const onPath = state.target;
  const usable = onPath !== null && existsSync(onPath);
  if (usable) {
    // The interrupted switch carries the record it never managed to write, so
    // the tree on PATH can be described even though the inventory has never
    // heard of it — which is the ordinary case, since the inventory write is
    // exactly what did not happen.
    const trustworthy = state.intent && intentDescribes(state.intent, { name, adapter, onPath });
    if (trustworthy) {
      const smoke = smokeTest(adapter, onPath, state.intent.version);
      if (!smoke.ok) {
        stderr.write(`  ${onPath} cannot be run by ${adapter.user} (${smoke.detail}), so it will not be recorded as active.\n`);
        return 1;
      }
      recordRuntime(name, state.intent.entry);
      rmSync(intentFile(name), { force: true });
      reporter.step(`the interrupted switch to ${state.intent.version} is finished and recorded`);
      return 0;
    }

    const directory = installationDirectoryOf(state.entry, onPath, adapter);
    if (!directory) {
      stderr.write(
        `  ${onPath} is not a tree ${RUNTIMES_FILE} knows about, so this command cannot describe it. `
        + `Re-install the version you want with \`infra-cod runtime install ${name} --version <exact>\`.\n`,
      );
      return 1;
    }
    const smoke = smokeTest(adapter, onPath, directory.version);
    if (!smoke.ok) {
      stderr.write(`  ${onPath} cannot be run by ${adapter.user} (${smoke.detail}), so it will not be recorded as active.\n`);
      return 1;
    }
    recordRuntime(name, {
      ...state.entry,
      active: { version: directory.version, directory: directory.directory, path: state.link },
    });
    rmSync(intentFile(name), { force: true });
    reporter.step(`${RUNTIMES_FILE} now describes ${directory.version}, which is what ${state.link} runs`);
    return 0;
  }

  // Nothing usable on PATH: put the link back on the tree the record names, if
  // that one is still there.
  if (state.recorded && existsSync(state.recorded)) {
    switchActive(adapter, state.recorded);
    rmSync(intentFile(name), { force: true });
    reporter.step(`${state.link} put back on the recorded installation`);
    return 0;
  }

  stderr.write(
    `  Neither ${state.link} nor the recorded installation is usable. `
    + `Install a version explicitly: \`infra-cod runtime install ${name} --version <exact>\`.\n`,
  );
  return 1;
}

// Whether an intent file may be used as the record it claims to be.
//
// It is read from disk, it was written by an earlier version of this program,
// and it is used to write the inventory — so "it has an `entry` field" is not
// enough to act on. Everything it asserts about itself is checked against
// everything else known here, and a single disagreement makes it a note about
// something that happened rather than an instruction.
export function intentDescribes(intent, { name, adapter, onPath }) {
  const entry = intent?.entry;
  if (intent?.schema !== INTENT_SCHEMA) return false;
  if (intent.runtime !== name || entry?.runtime !== name) return false;
  if (typeof intent.version !== "string" || entry?.active?.version !== intent.version) return false;
  if (entry.user !== adapter.user || entry.executable !== adapter.executable) return false;

  // The switch it describes must be the switch that is on PATH.
  if (canonical(String(intent.to)) !== canonical(onPath)) return false;
  if (canonical(path.join(String(entry.active.directory), adapter.executablePath)) !== canonical(onPath)) return false;
  if (entry.active.path !== activeLink(adapter.executable)) return false;

  // And the installation it activates must be one the record it carries lists;
  // an entry whose `active` points outside its own `installed` is a record that
  // would immediately forget the tree it just made live.
  return (entry.installed ?? []).some((installed) =>
    installed.directory === entry.active.directory && installed.version === intent.version);
}

// Which recorded installation an executable path belongs to.
function installationDirectoryOf(entry, executable, adapter) {
  const wanted = canonical(executable);
  return (entry?.installed ?? []).find(
    (installed) => canonical(path.join(installed.directory, adapter.executablePath)) === wanted,
  ) ?? null;
}

function removeRuntimeVersion({ name, version, reporter, stderr }) {
  const adapter = adapterFor(name);
  assertExactVersion(version);
  // Removing trees on a host whose record is already wrong is how the tree that
  // is actually running gets deleted.
  assertConsistentBefore(name, "removing a version from");
  const entry = readRuntimes().runtimes[name];
  if (!entry) {
    stderr.write(`infra-cod runtime: ${name} is not installed\n`);
    return 1;
  }
  // The directory is read from the record rather than derived from the version:
  // an installed tree is immutable and a second install of the same version has
  // its own name, so the version alone no longer says where it lives.
  //
  // What blocks removal is being *active*, which is a property of a directory.
  // Judging it by version number made the active 0.154.0 protect every older
  // tree that happened to carry the same number — trees nothing points at, that
  // no command could then remove.
  //
  // Directories the record does not name are considered too. They exist — a
  // failed install leaves one — and a command that can only remove what the
  // record knows about cannot remove exactly the trees that need removing. They
  // are matched by directory name, which is the version plus `+n` for a repeat,
  // and they pass the same active-directory and running-process gates as the
  // rest.
  const recorded = (entry.installed ?? []).filter((candidate) => candidate.version === version);
  const unrecorded = orphanedDirectories(name)
    .filter((directory) => {
      const base = path.basename(directory);
      return base === version || base.startsWith(`${version}+`);
    })
    .map((directory) => ({ version, directory, unrecorded: true }));
  const all = [...recorded, ...unrecorded];
  if (all.length === 0) {
    stderr.write(`infra-cod runtime: ${name} ${version} is not in ${RUNTIMES_FILE}\n`);
    return 1;
  }
  // The version a rollback would go to is kept (R12) until another promotion
  // replaces it; removing it would turn `rollback` into a download.
  if (entry.rollbackTo && all.some((candidate) => candidate.directory === entry.rollbackTo.directory)) {
    stderr.write(
      `infra-cod runtime: ${name} ${version} is kept for \`infra-cod runtime rollback ${name}\`; `
      + "it can be removed once another promotion has replaced it.\n",
    );
    return 1;
  }
  const installed = all.filter((candidate) => candidate.directory !== entry.active?.directory);
  if (installed.length === 0) {
    stderr.write(
      `infra-cod runtime: ${name} ${version} is the active version. Install another version first; `
      + "removing the one on PATH would leave the supervisor with nothing to launch.\n",
    );
    return 1;
  }

  // A version whose processes are still running is not a version that can be
  // deleted out from under them.
  for (const candidate of installed) {
    const running = runningProcesses(adapter, { pattern: candidate.directory });
    if (running.length > 0) {
      stderr.write(`infra-cod runtime: ${running.length} process(es) of ${name} ${version} are still running\n`);
      return 1;
    }
  }
  for (const candidate of installed) rmSync(candidate.directory, { recursive: true, force: true });
  // Only the recorded ones are forgotten: the record never knew about the
  // others, and telling it to forget something it never held would be a write
  // with nothing behind it.
  forgetRuntimeDirectories(name, installed.filter((candidate) => !candidate.unrecorded).map((candidate) => candidate.directory));
  const strays = installed.filter((candidate) => candidate.unrecorded).length;
  if (strays > 0) {
    reporter.step(`removed ${strays} director${strays === 1 ? "y" : "ies"} that ${RUNTIMES_FILE} did not name`);
  }
  if (installed.length < all.length) {
    reporter.step(`removed ${installed.length} superseded tree(s) of ${name} ${version}; the active one is untouched`);
    return 0;
  }
  reporter.step(`removed ${name} ${version}`);
  return 0;
}

function valueOf(args, flag) {
  const index = args.indexOf(flag);
  if (index === -1 || index === args.length - 1) {
    throw new RuntimeError(`${flag} is required and takes a value`);
  }
  return args[index + 1];
}
