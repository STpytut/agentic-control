# Release format

This is the reference for the Stage 9 release artifact: the three assets, the
archive format, the manifest schema, and the verification contract that Stage 10
installs against. It describes what the builder produces and what a verifier
checks. How to build an artifact is in `README.md`; the operator-facing verify and
extract procedure is section 19 of `docs/OPERATIONS.md`.

## 1. The three assets

A release is three files that are published and consumed together:

| Asset | Purpose |
| --- | --- |
| `infra-cod-<version>-linux-x64.tar.gz` | The payload: the web standalone tree, the Node services, the production dependency closure, the migrations and the deploy assets. |
| `SHA256SUMS` | One `sha256sum -c` line per published artifact, `<hex>  <filename>`. It binds a filename to the bytes behind it. |
| `SHA256SUMS.minisig` | A detached minisign signature over the exact bytes of `SHA256SUMS`, made with the production secret key. |

The tarball name is fixed by the version contract, not by the machine that runs
the build: a release is `linux-x64`, and that segment is not derived from
`process.platform`. It is also not allowed to *lie*. A build whose host is not the
release target is refused outright, and `--allow-off-target` is the only way past
that — it is a diagnostic mode that names the artifact after the host
(`…-darwin-arm64.tar.gz`) and records the host in `manifest.target`, so a consumer
looking for `linux-x64` cannot pick it up and a verifier asked for `linux/x64`
refuses it. Nothing downstream has to trust a flag: the artifact's own name and
manifest both say what actually produced it.

That is not a theoretical concern. The first version of this check ran only for
`--publish`, so a Darwin/arm64 build produced `…-linux-x64.tar.gz` with
`manifest.target` claiming `linux/x64/glibc`, and every structural check passed
because the only thing comparing the two was the manifest itself. Next's SWC
binaries and sharp's libvips are platform-specific, so that artifact could not run
on the platform it named.

## 2. Verification order, and why the filename is not trusted

Every verifier, shallow or deep, runs the same sequence:

```text
pinned public key
  -> detached signature over SHA256SUMS
  -> checksum of the tarball
  -> safe member list
  -> extraction
  -> manifest identity
  -> FILESUMS.sha256
  -> symlink closure
  -> runtime smoke (optional)
```

The order is the security property. The signature is checked first because an
archive whose provenance is unknown must not be parsed at all: a tar reader is
complex, it is fed attacker-controlled bytes, and any work done before the
signature is verified is work done on unauthenticated input. The member list is
read before extraction because an absolute member or one containing `..` escapes
the extraction directory, and a device, FIFO or socket has no place in an
application release; nothing should be written until the list proves neither is
present. The manifest is checked after
extraction because its claims have to be compared against the bytes that were
actually written, but its version and target are checked before an installer can
act on a directory name.

The filename is metadata the artifact carries about itself, so it is used for
exactly one thing: selecting its entry in `SHA256SUMS` by exact string match. A
directory holding several tarballs must not let "the only one" or "the newest one"
decide which bytes were verified; if the name is not listed, verification stops
rather than guessing. The name is then bound to a digest by the signed checksum
file, and the digest is bound to an identity by the manifest inside the archive.
`infra-cod-9.9.9-linux-x64.tar.gz` whose manifest says `0.1.0-rc.1` is refused,
and so is a `linux/arm64` build requested as `linux/x64`. Nothing consults the
filename as evidence after that point.

## 3. Unpacked layout

The tarball contains exactly one top-level directory, `infra-cod-<version>/`.
A second top-level directory is refused because extraction has to have a single
root it can be pointed at and later moved. The current layout is:

```text
infra-cod-<version>/
  manifest.json                 the artifact's description of itself
  FILESUMS.sha256               sha256 of every regular file except itself
  services/
    cli/                        infra-cod.mjs and admin.mjs
    control-plane/              workers, dispatcher, reconciler, migrate.mjs
    operations/                 backup, restore, health, credentials
    runtime-supervisor/         server.mjs and its channels
  node_modules/                 production dependency closure for the services
  db/
    migrations/                 the ordered .sql files
  deploy/
    caddy/                      Caddyfile (the acceptance-only Caddyfile.local is excluded)
    env/                        *.env.example
    systemd/                    units and timers
    tmpfiles.d/
    setup-postgresql-17-restore.sh
  docs/
    OPERATIONS.md               the units point Documentation= at this file
  web/
    apps/web/                   traced Next standalone tree
```

There is no repository root `package.json`, no lockfile, no package manager and
no pnpm store. Node resolves the non-web services' `pg` and `hash-wasm` through
`node_modules/`, whose symlinks are relative and stay inside the tree.

The manifest's `entrypoints` name the four paths a unit or the CLI starts:
`web/apps/web/server.js`, `services/cli/infra-cod.mjs`,
`services/control-plane/migrate.mjs` and
`services/runtime-supervisor/server.mjs`. The verifier requires every
`/opt/infra-cod/current/...` path named by a unit or the Caddy configuration to
exist in the payload. `docs/OPERATIONS.md` is shipped only because the units
reference it with `Documentation=`; it is the sole file taken from the
repository's `docs/` directory.

`infra-cod version` reads `manifest.json` two levels above
`services/cli/infra-cod.mjs`, so a release answers with the artifact's version,
channel, git SHA, target and migration count. In a source checkout, where no
manifest exists, it answers with `version: null`, `channel: "development"` and
`source: "checkout"` rather than inventing a version from the root
`package.json`.

## 4. The manifest

`manifest.json` is UTF-8 JSON on one schema, `infra-cod/release-manifest/1`.

| Field | Meaning |
| --- | --- |
| `schema` | `infra-cod/release-manifest/1`. A verifier that does not know the schema refuses the artifact. |
| `product` | `infra-cod`. |
| `version` | The SemVer release version. Compared against `--version` and against the tag. |
| `channel` | `dev`, `rc` or `stable`, derived from the version: build metadata or `0.0.0` is `dev`, a prerelease is `rc`, otherwise `stable`. |
| `release.signed` | Whether a signature was produced. A local unsigned build records `false`. |
| `git.sha` | The full 40-hex commit the build came from. Abbreviated SHAs are refused. |
| `git.dirty` | Whether the working tree had modifications. Publish builds refuse a dirty tree. |
| `git.sourceDateEpoch` | The commit's own timestamp (`git show -s --format=%ct`), used as every tar member's mtime. |
| `target.os`, `target.arch`, `target.libc` | `linux`, `x64`, `glibc`. Compared against the requested target. |
| `toolchain.node`, `toolchain.pnpm`, `toolchain.next` | The pinned versions from `release/release-version.json`. |
| `toolchain.postgresqlMajor` | `17`. Recorded because migrations and backup tools are version-bound. |
| `database.migrationCount` | Number of `.sql` files in `db/migrations`, counted from the payload. |
| `database.latestMigration` | The filename that sorts last. Not written anywhere except the file set it is computed from. |
| `database.migrationSetSha256` | Digest of the migration set, constructed in section 8. |
| `entrypoints.web`, `.cli`, `.migrate`, `.runtimeSupervisor` | Release-relative paths. Absolute paths are refused. |
| `payload.fileCount` | Count of regular files plus symlinks, excluding `manifest.json` and `FILESUMS.sha256`. Directories are not counted. |
| `payload.bytes` | Sum of regular file sizes. A symlink contributes zero because it has no content of its own. |
| `payload.checksums` | Always `FILESUMS.sha256`. |
| `payload.symlinks` | Array of `{path, target}` for every symlink in the tree. See section 5. |
| `source.omitted` | Present only when files were deliberately left out. See section 6. |
| `install` | What the release installs outside its tree. See section 4a. Required of every release built since WP-A. |

The manifest never contains an absolute build path, the account that ran the
build, a branch name, a client domain, or an environment value. The builder
asserts this on the serialised JSON rather than trusting the construction: a path
that leaks the build host is both an information leak and a reproducibility
problem, because two machines would then produce different manifests for the same
source.

Nothing in the manifest is a checksum of the manifest, and `FILESUMS.sha256` does
not list itself. `FILESUMS.sha256` covers every regular payload file and the
finished `manifest.json`, but `manifest.json` has to be final, including its
payload counts, before that list can be rendered; listing itself would make the
file depend on its own hash. The tarball's digest lives outside the tarball, in
`SHA256SUMS`, for the same reason.

## 4a. The install declaration

Since Stage 11.1b WP-A a release says what it installs on the host, as data, and
`infra-cod update`, `infra-cod rollback` and `install.sh` all reconcile the host
to it with the same code
([`install-reconcile.mjs`](../services/operations/install-reconcile.mjs)).

```json
"install": {
  "contractVersion": 1,
  "minCoordinatorVersion": "0.4.0-rc.25",
  "files": [
    { "root": "systemd", "source": "deploy/systemd/infra-cod-web.service", "name": "infra-cod-web.service", "mode": "0644" },
    { "root": "runtime-tools", "runtime": "opencode",
      "source": "services/runtime-supervisor/opencode-tools/complete_task.ts", "name": "complete_task.ts", "mode": "0644" }
  ]
}
```

| Root | Directory, resolved by the coordinator | Names it accepts |
| --- | --- | --- |
| `systemd` | `/etc/systemd/system` | `infra-cod[-…].service`, `.timer`, `.target` |
| `tmpfiles` | `/etc/tmpfiles.d` | `infra-cod-….conf` |
| `caddy` | `/etc/infra-cod/caddy` | `Caddyfile` |
| `runtime-tools` | the runtime's home + its adapter's tool directory | `….ts`, for a runtime whose adapter declares tool definitions |

**No host paths.** An entry names a root, never a directory; the coordinator
resolves the root from its own installation layout and adapter registry. A
manifest naming a root, a key, a mode, a name or a source outside this
vocabulary fails validation, and the deep verifier also requires the list to be
exactly what the tree implies, so a hand-edited manifest cannot retire a unit by
leaving it out.

**Reconciling** installs every declared file root-owned `0644`, by writing beside
the target and renaming over it, and retires every file the product installed
before and no longer declares — known from `/etc/infra-cod/install-ledger.json`
and the declaration of the release being left. A retired unit is stopped and
disabled before its file is removed. A file the product never recorded is never
touched.

**Refusal.** A coordinator that does not implement `contractVersion`, or is older
than `minCoordinatorVersion`, refuses the artifact before anything is staged. A
release built before WP-A has no section; a coordinator derives the declaration
its tree implies, which is exactly what those releases installed.

## 5. Symlink accounting

`payload.symlinks` lists every symlink by release-relative `path` and by the
verbatim `target` text stored in the link, in the same sorted order as the rest of
the payload. A link is never presented as a regular file: `walkTree` records it as
type `symlink` with size zero, `FILESUMS.sha256` covers regular files only, and
the verifier re-reads each one with `lstat` and `readlink` and then proves that its
target resolves inside the tree and is not dangling. A regular file that claimed to
be a link, or a link silently flattened into a file with its target's content,
would both fail those checks.

The current artifact carries 72 symlinks, all from the pnpm layout
(`node_modules/<name> -> .pnpm/<key>/node_modules/<name>` and the dependencies
inside each store key). They are relative, so the extracted tree works at any
absolute path.

## 6. Omissions

A manifest that records only what is present cannot be asked why something is
absent. `source.omitted` answers that from the artifact itself, as an array of
`{path, reason}` entries. The current artifact records seven:

| Path | Reason |
| --- | --- |
| `services/control-plane/run-db-tests.mjs` | database test harness; `db/tests` is not shipped |
| `services/runtime-supervisor/policy-smoke.mjs` | manual supervisor smoke; needs a live socket |
| `services/runtime-supervisor/socket-access-smoke.mjs` | manual supervisor smoke; needs a live socket |
| `services/runtime-supervisor/opencode-tools/complete_task.ts` | PoC tool definition; not importable at runtime |
| `services/runtime-supervisor/opencode-tools/report_blocker.ts` | PoC tool definition; not importable at runtime |
| `services/runtime-supervisor/opencode-tools/request_user_input.ts` | PoC tool definition; not importable at runtime |
| `services/runtime-supervisor/README.md` | service documentation; no runtime effect |

An omission is verified rather than asserted. The builder refuses to leave out a
file that any production entry point can reach, and every remaining candidate has
to be explained by the import graph, so a rename or a new import turns this list
into a build failure instead of a missing module on the target host.

## 7. Tar and gzip normalisation

Two builds of the same commit produce the same bytes. That is a requirement, not a
nicety: a signed artifact whose bytes changed for reasons no reviewer can see
cannot be compared across a rebuild, and the tag job builds twice and compares.
The rules the writer applies are:

- **Member order.** The release root directory first, then directories shallowest
  first, then every remaining member in byte-wise path order. A file can never be
  the parent of a directory, so this order guarantees a parent exists before its
  children without a per-entry sort.
- **Owner.** `uid` and `gid` are `0`, and `uname`/`gname` are left empty. An empty
  owner records `0:0` without naming the account that ran the build.
- **Modes.** `0644` for regular files, `0755` for directories and for any file that
  is executable in the source tree. No other mode survives.
- **Timestamps.** Every member's mtime is `SOURCE_DATE_EPOCH`, read from the
  commit through `git show -s --format=%ct`, never from the clock.
- **Format.** POSIX ustar with `ustar\0` magic. The 100-byte link target field at
  offset 157 carries a symlink's target.
- **gzip.** The tar stream is compressed in-process at level 9 with `mtime: 0`, so
  the gzip header carries no build time and does not depend on the host's `gzip`
  version.
- **Environment.** Child processes that build the web tree run with `LC_ALL=C`,
  `LANG=C`, `TZ=UTC` and `SOURCE_DATE_EPOCH` set. A build that formats a date or
  sorts a listing differently depending on the operator's locale is not
  reproducible, and the difference is invisible until two machines disagree.
- **Next build id.** The build id is derived from the version and the commit, so
  two builds of one commit carry the same chunk names.

pax extended headers are used only where ustar cannot represent a member, which in
practice means a pnpm store path longer than the 100-byte name field. A pnpm key
encodes the package name, its version and every peer dependency it resolved, so
these names routinely exceed the field before the path inside the package is even
added. A pax `path` record is deterministic: the header name is synthesised from
the member, the records are ASCII in a fixed order, and the header uses the same
`SOURCE_DATE_EPOCH` as every other entry. A pax record's length field counts its
own decimal digits, which the writer computes in a loop because adding a digit can
push the number into the next order of magnitude.

The writer refuses to emit a pax `linkpath` record for a long symlink target. GNU
tar reads such a record correctly, but libarchive (bsdtar, which is the `tar` on
macOS and inside some container tooling) places the link at a path derived from
the entry that follows it. The assembler therefore handles an over-long target
before the archive is written: it either rewrites the link to a shorter relative
path that provably resolves to the identical directory, using pnpm's hoisted
`node_modules/.pnpm/node_modules/<name>` alias, or, if no shorter alias exists, it
materialises the real directory at the link's own path. Materialising is the
fallback because a package's own `node_modules` is where its dependencies live; a
copy placed elsewhere loses the sibling links those dependencies are reached
through.

## 8. Migration set digest

`database.migrationSetSha256` is SHA-256 over the ordered list of
`<filename>\n<file sha256>\n` records, in the lexicographic order the runner
applies them. It is not a digest of the concatenated SQL. Concatenating bodies
would let two different sets collide by moving a boundary between files, and it
would miss a rename entirely, which is exactly the change that breaks a deployed
ledger. `database.migrationCount` and `database.latestMigration` are computed from
the same file list rather than written down, so a new or renamed migration changes
the manifest without anyone editing a constant.

## 9. Verifying an artifact

Two commands verify. They are not alternatives.

`release/verify-release.sh` is the pre-install gate. It is a POSIX shell script
because at that point the host may have no Node at all; Stage 10 is what installs
it. The script uses only `sha256sum`, the system `tar` and `minisign`, never
fetches anything, and never trusts the artifact's own filename.

```bash
sh release/verify-release.sh --artifact infra-cod-<version>-linux-x64.tar.gz \
  --public-key release/keys/infra-cod-release.pub --require-signature \
  --extract /tmp/infra-cod-verify
```

`scripts/verify-release.mjs` is the deep verifier. It is shipped inside the
artifact, so it is only trustworthy after the shell gate has passed; the installer
runs it on the extracted tree with the pinned Node it just installed. It reads
only the file it is given and never rebuilds anything.

```bash
node scripts/verify-release.mjs --artifact <tarball> \
  --public-key release/keys/infra-cod-release.pub --require-signature \
  --version <version> --channel rc --smoke --json
```

Flags for the shell gate: `--artifact` (required), `--checksums` (default
`SHA256SUMS` beside the artifact), `--signature` (default `<checksums>.minisig`),
`--public-key` (required whenever a signature is present), `--require-signature`
(fail rather than warn when unsigned), `--extract <dir>` (extract only after every
check passes) and `--version <semver>` (require the extracted manifest to name that
version, which needs `--extract` because the manifest is read from the extracted
tree). `MINISIGN_BIN`, `TAR_BIN` and `SHA256_BIN` override the tools it calls.

Flags for the deep verifier add `--channel <dev|rc|stable>`, `--target os-arch`
(default from `release/release-version.json`), `--extract <dir>`, `--smoke` and
`--json`. Its default public key is the path pinned in
`release/release-version.json`, so a published artifact is verified against the
same key the repository reviews.

`--smoke` imports `pg` and `hash-wasm` inside the extracted tree, runs
`infra-cod version` and compares it with the manifest, and starts the web entry
point with a deliberately absent database. The expected outcome for the last check
is a database error. A missing module, a missing build path or an invoked package
manager is a packaging defect and is reported as one; the distinction is what keeps
the smoke test from failing for an unconfigured host.

## 10. Offline acceptance

Two different guarantees, and the second one is the one that matters on a host with
no egress:

* **No package manager.** The artifact tests run imports, the CLI and the web entry
  point with `npm`, `pnpm`, `yarn` and `corepack` replaced by sentinels in `PATH`
  that exit 97. This proves the artifact never shells out to a package manager.
* **No network.** `scripts/offline-smoke.mjs` re-runs the same smoke inside a
  network namespace with no route out (`unshare --net --map-root-user`, util-linux
  on Ubuntu 24.04). The sandbox first *asserts* that the outside world is
  unreachable — it opens a connection to `1.1.1.1:443` and fails if it succeeds — and
  only then imports `pg` and `hash-wasm`, runs `infra-cod version`, and waits for the
  web entry point to accept a connection on loopback. Registry and proxy variables
  are cleared, and `HOME`/`TMPDIR` point at a scratch directory outside the release.

  A clean `PATH` does not imply a closed network: `NO_PROXY=*` permits direct
  connections, so the first version of this check proved only the weaker property.

On a platform that cannot create a namespace the command exits 78 with a message
naming the reason. CI sets the check to fail rather than skip on `ubuntu-24.04`,
because there it must run.

## 11. Publishing is atomic and version-isolated

One `version + platform` is one directory, published by a single rename:

```text
dist/releases/
  .staging-<version>-<platform>-<pid>/     written first, hidden
    infra-cod-<version>-<platform>.tar.gz  re-verified from its own bytes
    SHA256SUMS                             computed from the written tarball
    SHA256SUMS.minisig                     only in publish mode
      -> rename the whole directory to <version>-<platform>/
  0.1.0-rc.1-linux-x64/                    complete, or absent
```

The staged tarball is re-opened and checked — gzip decodes, the member list is safe,
it extracts to exactly one top-level directory, and the extracted tree passes
`FILESUMS.sha256` — *before* anything is renamed or signed. The rename happens after
the signature exists, so an interruption leaves a hidden staging directory and no
final-named asset.

Two earlier layouts were wrong, and both were found by running them:

* renaming the tarball first, then writing the checksums, then signing, left a
  complete-looking, unsigned release whenever a later step failed;
* writing `SHA256SUMS` and `SHA256SUMS.minisig` at the artifacts root — shared by
  every version — meant a second release overwrote the checksum file while leaving the
  first version's tarball in place, so the older artifact became unverifiable: the
  file beside it described different bytes.

`release-artifact.test.mjs` pauses the builder at the commit boundary through
`INFRA_COD_TEST_COMMIT_MARKER` and asserts that at that instant the artifacts root
holds nothing but the hidden staging directory. A sequential file-by-file publish
fails that assertion, which was verified by reintroducing one.

## 12. Signing

The signing scheme is minisign with a detached signature over `SHA256SUMS`, not
over the tarball. Signing the checksum file is what binds a filename to a digest,
so one signature authenticates both; it lets a verifier check the cheap document
before hashing the much larger archive; and it covers every artifact the file
lists, so a release that later carries more than one file needs no second
signature. `release/release-version.json` pins the scheme and the public key path,
and `signing.keyId` records the key id once the owner provisions it.

The private key lives offline and is never committed and never printed. The CI
publish job receives it from a secret store, writes it under the runner's temporary
directory rather than the workspace, and removes it before uploading anything.
`release/keys/*.key` and `*.minisig` are gitignored so that a local generation
cannot be staged by accident.

`release/keys/infra-cod-release.pub` does not exist yet. Publish builds fail closed
until it does, and no step substitutes an unsigned artifact. Pull-request and push
jobs produce an unsigned candidate and exercise the sign, verify and tamper paths
with an ephemeral key, so the code path is tested without a production key
existing. The first signed release candidate is blocked on the owner provisioning
the key, not on any code in this stage.

Once the owner provisions it:

```bash
minisign -G -W -p release/keys/infra-cod-release.pub -s /secure/offline/infra-cod-release.key
# commit release/keys/infra-cod-release.pub and set signing.keyId in
# release/release-version.json to the key id in the public key's comment line.
```

The public key is committed because it is part of the reviewed tree. A verifier
never learns the public key from the artifact it is checking and never from the
network. A keyless service that requires a network round trip to a transparency
log is not an acceptable substitute, because verification must work offline
against a key that shipped with the verifier.

A publishable artifact is built on `linux/x64` only. `--publish` refuses macOS and
any other platform, because Next's SWC binaries and sharp's libvips are
platform-specific; a macOS build carries `darwin-arm64` binaries and would at best
fail to start on Ubuntu. Only the CI `ubuntu-24.04` runner produces a publishable
artifact. The tag job builds twice, compares digests, requires the committed public
key and the production secret key, re-verifies against the committed public key,
and publishes exactly the tarball, `SHA256SUMS` and `SHA256SUMS.minisig`.

## 13. Worked example

Everything in this section is a macOS arm64 development build measured in this
working tree on 2026-09-11, on the `dev` channel, unsigned. It is not a Linux
artifact and nothing here is evidence about Ubuntu.

```text
artifact        infra-cod-0.0.0-dev+0341f3a76ed9-darwin-arm64.tar.gz
bytes           12300466
sha256          ef0465f726dc7617ab993ab4e8cfd4b9a0f9935e1551ec9f1f9ad2ed139d1483
archive members 2329 (files, directories and symlinks)

The platform segment is `darwin-arm64` because this is a diagnostic build on a
Darwin/arm64 host. A release built on the target is `…-linux-x64.tar.gz`; the name
is the same mechanism either way, rendering whatever `resolveBuildTarget` decided.
```

The manifest inside it records schema `infra-cod/release-manifest/1`,
`release.signed: false`, `git.sha bcb77940beee792b493230bae890ae08680b3406`,
`git.dirty: true` (the exact counts are in the build summary — the stage's own work),
target `darwin/arm64/glibc` (the host, because this is a diagnostic build),
toolchain Node `24.20.0`, pnpm
`11.9.0`, Next `16.2.10`, PostgreSQL major `17`, 1869 payload entries,
39422140 payload bytes, 72 symlinks, 46 migrations with latest
`0050_audit_action_namespace.sql` and
`migrationSetSha256 735311ca1441ffd7ea06229da9fe5824691090e12004451ee579623de1461072`.
Two builds of the same commit into two different temporary directories produced
that identical SHA-256. The `git.dirty: true` field records that the working tree
carried modifications at build time; a publish build refuses that state.

The runtime smoke passed on this artifact: `pg` and `hash-wasm` import, the CLI
reports the manifest version, and the extracted web entry point starts and fails
with a database error rather than a missing module, which is the expected outcome
without a database.
