# Releasing without GitHub Actions

The steps that produced all fifteen Stage 11.1 release candidates, written down
as they were actually run. [DELIVERY_PIPELINE.md](DELIVERY_PIPELINE.md) says
which proof belongs at which level and why; this is level 2 performed by hand,
plus the delivery that follows it.

[RELEASE_FORMAT.md](RELEASE_FORMAT.md) is the authority on what an artifact
contains and how it verifies. Nothing here repeats it.

**Every change that reaches the host goes through all of it** — a work package,
and a one-line fix alike. There is no shorter path for a small change: most of
11.1's fifteen candidates were small changes, and the update coordinator's
backup, restore rehearsal, build-id checks and rollback are exactly as necessary
for them. [GIT_WORKFLOW.md](GIT_WORKFLOW.md) §7 is where a package's candidate is
recorded.

**Signing is the owner's step and stays manual.** The secret key never reaches a
pipeline, a container or this document.

Not repeated here, because it is written once elsewhere:
[OPERATIONS.md](OPERATIONS.md) §21.1 provisions the signing key (once, by the
owner), §21.3 installs on a fresh host, and §22 is what `infra-cod update`
guarantees — order, checks, rollback and restore. §21.2 describes the same
release through GitHub Actions, for when the minutes are there.

---

## 0. One command

`scripts/release.sh <version> --host <ssh host> [--key <minisign secret key>]`
runs sections 1–7 below in order on the merged `main`: the gate (skipped when
this exact tree already passed it), the tag, the container build and its
content check, the signature — it prints the minisign command and waits for the
`.minisig`, never running minisign or reading the key — the upload, and
`infra-cod update`. It stops at the first failure and pushes nothing. The
sections below are what it does, for when one step has to be done by hand.

## 1. The gates, before the tag

One command, which is the whole offline gate — the suites below plus the lease
contract, in a container, on `git archive HEAD`:

```bash
scripts/run-suites-in-container.sh
```

The same proofs run individually on the host when something needs to be looked
at directly:

```bash
npm run lint:services && npm run test:unit && npm run db:test \
  && npm run test:integration:db && npm run test:release \
  && npm run test:update && npm run test:installer
```

Orientation, so a suite that quietly stops running is visible as a number that
moved:

| Suite | Count | Note |
| --- | --- | --- |
| `test:unit` | 330 | |
| `test:installer` | 64 | about ten minutes — the only long one |
| `test:update` | 41 | about five minutes with no output under the default reporter — one case waits out a re-exec timeout; not a hang |
| `test:release` | 49 | |
| `db:test` | 33 files | needs PostgreSQL 17 |
| `test:integration:db` | 51 | needs PostgreSQL 17 and `psql` |

A count that fell is a skip until proven otherwise. `test:installer` once passed
1 test and skipped 63 for want of `jq`, and reported "pass 1, fail 0".

## 2. The tag

The version comes from the tag on `HEAD` and from nowhere else. The builder
refuses a publish build without one.

```bash
git tag -a v0.4.0-rc.16 -m "short description"
git describe --tags --exact-match
```

## 3. The build, in a container from a clean clone

```bash
work=/tmp/linux-build && rm -rf "$work" && mkdir -p "$work/out"
git clone --local --quiet . "$work/src"
git -C "$work/src" checkout --quiet v0.4.0-rc.16
```

A clone, not the working directory: `.env.local`, `.git` credentials and any key
sitting in the checkout do not belong in an image with a network.

```bash
docker run --rm --platform linux/amd64 -v "$work/src:/src" -v "$work/out:/out" -w /src \
  node:24.20.0-bookworm bash -lc '
  corepack enable && corepack prepare pnpm@11.9.0 --activate
  pnpm install --frozen-lockfile
  npm run build
  npm run release:build -- --out /out'
```

**Do not filter the output.** No `grep`, no `until … done`. Two rounds were lost
to exactly that: the build failed in `pnpm install`, the filter swallowed the
error, and the result looked like a hang. What must appear is the line
`built infra-cod-….tar.gz` and `RELEASE_BUILD_EXIT=0`.

Node is exactly `24.20.0`. Another version does not build.

## 4. What is inside it

```bash
cp -R "$work/out/0.4.0-rc.16-linux-x64" dist/releases/
tar tzf dist/releases/0.4.0-rc.16-linux-x64/*.tar.gz | grep -E "opencode-tools|release/keys"
```

The tool definitions are checked by name because a release that ships without
them tells the executor to call tools that are not there — which is how one
candidate reached the host.

## 4a. The agents' recommended versions

A new host installs each agent at `recommendedVersion` in
`services/operations/runtime-adapters.mjs`. Before a release, set each to the
version the production host runs and has qualified in full (`infra-cod runtime
list`, and a `passed` row in `runtime_qualifications`). rc.123 shipped Claude
Code 2.1.270, and a clean install could not run Opus 5.5.

## 5. Signing — the owner's step

```bash
minisign -S -H -s /path/to/infra-cod-release.key \
  -m dist/releases/0.4.0-rc.16-linux-x64/SHA256SUMS \
  -t "infra-cod release 0.4.0-rc.16"
```

**The version in `-t` must be the artifact's version.** rc.13 was signed with
`0.4.0-rc.1` still in the trusted comment, typed by hand; the host would have
rejected it, because the verifier compares that comment against
`infra-cod release <version>`.

**`-H` is required.** The signature is prehashed.

Then, before anything leaves the machine:

```bash
cd dist/releases/0.4.0-rc.16-linux-x64 \
  && minisign -V -p release/keys/infra-cod-release.pub -m SHA256SUMS
```

## 5a. Publishing on GitHub

The release workflow signs only when the repository variable `CI_SIGNS_RELEASES`
is `true`. Until then a release is signed here and uploaded by hand. The tag is
pushed only for releases that are published; ordinary candidates stay local.

```bash
git push origin v0.4.0-rc.16
gh release create v0.4.0-rc.16 --prerelease --title "0.4.0-rc.16" --notes "…" \
  dist/releases/0.4.0-rc.16-linux-x64/infra-cod-0.4.0-rc.16-linux-x64.tar.gz \
  dist/releases/0.4.0-rc.16-linux-x64/SHA256SUMS \
  dist/releases/0.4.0-rc.16-linux-x64/SHA256SUMS.minisig \
  deploy/get.sh
```

`get.sh` goes with every published release, because
`releases/latest/download/get.sh` is the one-command install in the README.

## 6. Delivery, and the update

```bash
ssh infra-vps 'mkdir -p /root/releases/0.4.0-rc.16-linux-x64'
scp SHA256SUMS SHA256SUMS.minisig *.tar.gz infra-vps:/root/releases/0.4.0-rc.16-linux-x64/
ssh infra-vps 'cd /root/releases/0.4.0-rc.16-linux-x64 && sha256sum -c SHA256SUMS'
```

```bash
ssh infra-vps 'infra-cod update \
  --artifact /root/releases/0.4.0-rc.16-linux-x64/infra-cod-0.4.0-rc.16-linux-x64.tar.gz \
  --checksums /root/releases/0.4.0-rc.16-linux-x64/SHA256SUMS \
  --signature /root/releases/0.4.0-rc.16-linux-x64/SHA256SUMS.minisig \
  --public-key /root/rehearsal/keys/infra-cod-release.pub'
```

The public key lives on the host, not in the artifact. An artifact cannot
attest to itself.

From there the coordinator does the rest on its own: takes a backup, rehearses
the restore, drains the dispatcher, applies the migrations, switches the
symlink, checks every service's build id, and rolls back if any of that fails.
The receipt is in `/etc/infra-cod/release-receipts/`.

## 7. After the update

```bash
ssh infra-vps 'infra-cod version && infra-cod doctor --json | head -20'
ssh infra-vps 'systemctl list-units "infra-cod*" --no-pager --all | head -25'
ssh infra-vps 'journalctl --since "-10 min" --no-pager | grep -c "stop-sigterm. timed out"'
```

The last one is not decoration: a unit that cannot stop on SIGTERM is SIGKILLed
after `TimeoutStopSec`, and defect 106 was found by counting those lines rather
than by any suite.

## 8. What to remember

**A change to `update.mjs` takes effect one release later.** `infra-cod` loads
the coordinator from the *currently installed* release, so updating to rc.N is
driven by rc.N−1's code. If a release changes what gets installed on the system,
that change is proven by the update *after* it — and this time it is delivered
by hand.

**`kex_exchange_identification` is the route, not the host.** SSH to the VPS
needs the network path to be up; without the VPN the handshake is torn down
before the host is involved.

**Installer acceptance on a clean host is not automated yet.** That is level 3 of
[DELIVERY_PIPELINE.md](DELIVERY_PIPELINE.md) and it waits on the disposable host
decided in [STAGE_11_1B_PLAN.md](STAGE_11_1B_PLAN.md) §5. What stands in for it
today is that `infra-cod update` verifies and rolls itself back — which proves an
update on *this* host, not that a clean host becomes a working one.


## WP-5c: the layout move (0.4.0-rc.31 and later)

The first release carrying 0065 moves the host's layout inside `infra-cod
update`. Before signing it, read on the host what it will do — nothing changes:

```bash
node <extracted-release>/services/operations/layout-migration.mjs plan
```

It must say `legacy` with four actions. After the update, `doctor` reports
`layout.host` as passing, and `plan` says `current`.

**Rolling back past it** is not an application rollback — the coordinator
refuses one, because 0065 is incompatible. With every service stopped:

1. `node /opt/infra-cod/current/services/operations/layout-migration.mjs revert`
2. restore the pre-update backup the update receipt names;
3. `infra-cod rollback --to <previous>`.
