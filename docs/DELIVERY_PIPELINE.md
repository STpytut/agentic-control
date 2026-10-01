# The delivery pipeline, without GitHub Actions

What has to be proven before a release reaches the host, where each proof runs,
and why the logic moves out of workflow YAML.

Stage 11.1 ran its entire delivery — 15 release candidates onto a production
host — with GitHub Actions unavailable. That is the evidence this document is
built on: the substitute already exists in pieces, and what is missing is
specific.

---

## 1. Why replace it

**The stated reason is the minutes.** The account is at the 2000 minutes/month
ceiling. `installer-acceptance.yml` alone provisions an `ubuntu-24.04` runner,
removes its preinstalled PostgreSQL, installs the product three times and runs a
login smoke test; `release.yml` builds a candidate, creates and migrates a
database, and runs an offline smoke inside a network namespace. Those are not
cheap jobs, and they are the ones that matter.

**The structural reason is larger.** 1062 lines of workflow YAML hold logic that
exists nowhere else:

| Workflow | Lines | What only it knows |
| --- | --- | --- |
| `installer-acceptance.yml` | 508 | account creation, tmpfiles materialisation, `systemd-analyze verify`, ephemeral signing key, three install runs, doctor, unit/timer assertions, login smoke, journal secret scan |
| `release.yml` | 478 | preflight tools, database creation and migration, structural release tests, minisign interoperability, offline smoke in a network namespace |
| `scope.yml` | 76 | what changed |

None of it can be run by a developer, on a host, or anywhere but GitHub. When
Actions became unavailable, that knowledge became unavailable with it — and
11.1's answer was to re-derive parts of it by hand, which is how a container
gate that reports green on a suite it skipped 63 tests of comes about
(defect 60).

**So the goal is not "a different CI provider".** It is: *the pipeline is
scripts in the repository, and a runner is one way to invoke them.* Then it runs
locally, in a container, on a disposable host — and in GitHub Actions too, if
minutes return.

---

## 2. What has to be proven, and what each proof needs

Everything below exists today. The column that matters is the last one.

| Proof | Command | Needs |
| --- | --- | --- |
| Lint (web and services) | `lint`, `lint:services` | nothing |
| Type check | `typecheck` | nothing |
| Unit suites (300) | `test:unit` | nothing |
| Installer suite (64) | `test:installer` | `jq`, Linux for one setgid test |
| Update coordinator (37) | `test:update` | nothing |
| Runtime provisioning (55) | `test:runtime` | a loopback registry the harness starts |
| Release structure (49) | `test:release` | `minisign` for interop |
| Database suites (33 files) | `db:test` | **PostgreSQL 17** |
| Integration (47) | `test:integration:db` | **PostgreSQL 17**, `psql` |
| Query shapes | (inside integration) | **PostgreSQL 17** |
| Lease contract | `test:lease-contract` | **PostgreSQL 17** — its own container on a host, or an empty database given as `LEASE_CONTRACT_DATABASE_URL` |
| Adapter coordinates | `check:runtime-adapters` | **network** — asks the real registry |
| Release build | `release:build` | **Node 24.20.0 exactly**, linux-x64, clean clone |
| Artifact verification | `test:release:artifact`, `release:verify` | a built artifact |
| Offline smoke | `release:offline-smoke` | a network namespace |
| Installer acceptance | — | **a disposable host with systemd and root** |
| Live host checks | `test:integration:live` | the production host |

Three of these cannot run in an ordinary container: the installer acceptance
needs systemd and root, the offline smoke needs a network namespace, and the
adapter check needs the network *on purpose*. Everything else can.

---

## 3. Four levels

Each level is a script with a name, a defined scope, and a stated cost. Nothing
is "the CI"; each is invoked by a person, a hook, or a runner.

### Level 0 — the edit loop (seconds)

`npm run check:fast` — lint, typecheck, unit suites. Runs on the developer's
machine, on every save if they want it, and as a `pre-push` hook.

No database, no container, no network. This is the level that must never become
slow, because a slow level 0 is a level 0 people stop running.

### Level 1 — the full offline gate (minutes, in a container)

`scripts/run-suites-in-container.sh`, extended with **PostgreSQL 17** — which
was the single largest hole in this arrangement: 33 database test files, 47
integration tests, the query shapes and the lease contract ran nowhere
automatic. Those cover the defects that reached the production host in 11.1 — a
launch query naming columns that do not exist (92), a migration opening its own
transaction (72), a function created in `public` (75).

**This is done.** WP-1 of [STAGE_11_1B_PLAN.md](STAGE_11_1B_PLAN.md); the run,
its counts and the two deliberately broken branches it had to fail on are in
[STAGE_11_1B_ACCEPTANCE.md](STAGE_11_1B_ACCEPTANCE.md). The whole level is one
command and takes about nine minutes:

```bash
scripts/run-suites-in-container.sh
```

Everything from the existing gate is kept, including the properties that were
themselves defects once:

- source is `git archive HEAD`, never a bind mount — the earlier version copied
  the working directory with `.env.local`, `.git` credentials and any private
  key into an image with unrestricted networking, and `test:unit` loads
  `.env.local` (defect 15);
- Node and pnpm versions are read from `deploy/install.sh`, out of the same
  snapshot — a gate on a different toolchain is a gate on a different system;
- the phase that has source runs with no egress.

  **Topology, corrected.** An earlier version of this document called PostgreSQL
  a "sidecar" while also requiring `--network none` for the source container.
  Those are incompatible: `--network none` leaves no interface a sidecar could be
  reached on. The resolution: **PostgreSQL starts with `--network none`, and the
  test container joins its network namespace with `--network container:<pg>`.**
  Then `localhost:5432` reaches the database and neither container has egress —
  which is the property that mattered, not the flag.

  Other properties kept from the existing gate:
- skips are printed under a heading and budgeted by name (defects 60, 62).

Cost: local Docker, no money. This is the gate a pull request has to pass.

### Level 2 — the release candidate (minutes, in a container)

`scripts/release.sh` — clean `git clone --local` at the tag, a
`node:24.20.0-bookworm` container on `linux/amd64`, `pnpm install
--frozen-lockfile`, `npm run build`, `npm run release:build`. Then the artifact
tests, `release:verify`, and the offline smoke.

This is exactly what produced all 15 candidates of 11.1, and it works. What it
needs is to stop being a command typed from memory and become a script with the
failure modes handled — 11.1 lost two rounds to a filtered `until grep` that
swallowed a real build failure and reported a hang.

**Signing stays with the owner and stays manual.** The key is theirs and never
reaches a pipeline. The script's last act is to print the exact `minisign`
invocation with the version already substituted — 11.1 produced one candidate
whose trusted comment said `0.4.0-rc.1` for an `0.4.0-rc.13` artifact, typed by
hand, which verification would have rejected on the host.

### Level 3 — installer acceptance (a disposable host, on demand)

The part that genuinely needs a machine: systemd, root, real accounts, real
units, a real `systemd-analyze verify`, three installs and a login.

**A disposable host, not a permanent runner.** The acceptance proves that a
*clean* Ubuntu 24.04 becomes a working installation. A runner that has run it
before is no longer clean, and a persistent runner accumulates exactly the state
the test exists to prove is not needed. It also must not be the production VPS:
4 GB, and the installation under test creates system accounts and units.

Three ways to get one, in order of preference:

1. **An hourly VM from the existing provider.** Created, used for twenty
   minutes, destroyed. Hourly billing makes this cost less than the minutes it
   replaces, and it is the closest thing to the real target.
2. **A local Linux VM** (Lima/Colima on the Mac) for iteration — free, slower,
   and good enough for everything except proving behaviour on a fresh cloud
   image.
3. **GitHub Actions**, if minutes return — because by then the acceptance is a
   script and the workflow is six lines that call it.

The existing `installer-acceptance.yml` is the specification for this script.
Its 508 lines are not to be thrown away; they are to be moved into
`scripts/acceptance/` where they can be run by hand.

---

## 4. The gate contract

These rules come from 11.1's defects, not from principle. A gate that does not
follow them is decoration.

**1. A gate says what it did not run.** `test:installer` once passed 1 test and
skipped 63 for a missing `jq`, reporting "pass 1, fail 0" (defect 60). Every
level prints its skips under a heading and fails if an unexpected one appears.

**2. The skip budget names its skips.** Counting them is not enough: if the
allowed skip vanishes and a different one appears, the total is unchanged
(defect 62).

**3. The gate itself is tested.** The skip-budget check was once added with a
quoting error that killed the container before it ran anything (defect 61). A
check nobody has seen fail is a check nobody has seen.

**4. No secret enters a gate.** Source comes from `git archive`, environment
files are refused by pattern, and the phase with source has no network
(defect 15).

**5. The toolchain matches production.** Node and pnpm versions are read from
`deploy/install.sh`, in the same snapshot as the source (defect 59).

**6. Evidence outlives the run.** Each level writes a receipt — what ran, what
skipped, versions, durations, and for level 2 the artifact checksum. 11.1's
`/etc/infra-cod/release-receipts/` is the model.

---

## 5. What triggers what

| Event | Levels |
| --- | --- |
| Save / pre-push | 0 |
| Pull request | 0, 1 |
| Tag a candidate | 0, 1, 2 |
| Before a deployment to the production host | 3 |
| Runtime coordinates change | `check:runtime-adapters` (needs network, therefore never inside the offline gate) |
| After a deployment | `test:integration:live` against the host |

Level 3 is deliberately not per-commit. It proves that a clean host becomes a
working installation, and that claim does not change with every commit — it
changes when `deploy/`, the units, the tmpfiles or the release layout change,
which `scope.yml` already knows how to detect.

---

## 6. Migration

**Keep as the specification, then delete:** `installer-acceptance.yml` and
`release.yml`. Every step becomes a function in `scripts/acceptance/` and
`scripts/release.sh`. The YAML is not modified in place; it is read, moved and
then removed once the script reproduces its assertions.

**Keep as logic:** `scope.yml`'s change detection — which paths mean which
levels must run — becomes a small script both a hook and a runner can call.

**The order matters.** Move `release.yml` first: it is the smaller of the two,
its pieces are already commands, and the release path is the one being used
every week. `installer-acceptance.yml` follows, because its script needs the
disposable host decided first.

**Nothing is deleted before its replacement has run and produced the same
verdict on the same commit.** A pipeline replaced without an overlap is a
pipeline nobody can compare.

---

## 7. What this costs and what it buys

**Costs:** one hourly VM per acceptance run, and the work of moving 986 lines of
workflow logic into scripts. Level 1 gains a PostgreSQL container, which is free
and local.

**Buys:**

- Every proof can be run by a person, on demand, without a platform. That is the
  thing 11.1 did not have when it needed it.
- The database suites — 33 files, 47 integration tests, query shapes, the lease
  contract — start running automatically. They currently do not, and they cover
  the class of defect that reached the production host most often.
- The acceptance runs on a clean host every time, which a persistent runner
  cannot promise.
- If GitHub minutes return, the workflows become six-line wrappers and the
  pipeline is unchanged.

---

## 8. Relationship to the rest of Stage 11

This is continuous work, not a substage: it sits alongside
[STAGE_11_2_PREWORK.md](STAGE_11_2_PREWORK.md) and continues through the three
sprints. The one ordering constraint is that **level 1 gains its database before
11.2 begins** — 11.2 rewrites workflow SQL and adapter dispatch, and the suites
that would catch a broken function are exactly the ones that run nowhere
automatic today.
