# The git and GitHub workflow

How work reaches the repository: what a branch is for, what a commit says, when
a push happens, what a pull request costs, and what has to be green before each
of those.

Written because the rules were tacit. Stage 11.1 ran 15 release candidates and
110 defects through a single long-lived branch, and every convention below
already existed in someone's head — which is the same as not existing when a
second agent starts committing.

---

## 1. Where the work lives

`main` is not the current state of this project. It is 69 commits behind
`feat/stage-11a-runtime-provisioning`, which carries all of Stage 11.1 — the
production fixes, the defect register, the reports and every plan document.
That is a fact to work with, not one to fix in passing: rebasing or merging 69
commits of accepted work is its own change with its own risk, and it is not the
first thing a substage does.

So:

| Line | Purpose |
| --- | --- |
| `main` | the last merged state. Release tags and the two `push`-triggered workflows watch it |
| `feat/stage-11a-runtime-provisioning` | Stage 11.1 as accepted, plus the 11.1b plans. The base of everything below |
| `feat/stage-11-1b` | the integration line for the substage. Every work package merges here |
| `feat/stage-11-1b-wp<N>-<slug>` | one work package, one branch, one pull request |
| `docs/<slug>` | a documentation change that belongs to no package |
| `rehearsal/<slug>` | a deliberately broken tree, built to prove a gate catches it. **Never merged** |

The substage's integration line branches from `feat/stage-11a-runtime-provisioning`
and lands on `main` when [STAGE_11_1B_PLAN.md](STAGE_11_1B_PLAN.md) §2's exit
criteria are green — one merge of a substage that has been proven, rather than
fourteen merges of packages that have not.

**One package, one branch.** [STAGE_11_1B_PLAN.md](STAGE_11_1B_PLAN.md) §3 says
each package is one reviewable pull request; the branch is what makes that
possible. A branch that carries two packages cannot be reverted as one, and
11.1's defect 98 is what parallel work on adjacent surfaces costs.

**Migration numbers are not a branch's to choose.** They are allocated in
[STAGE_11_1B_PLAN.md](STAGE_11_1B_PLAN.md) §3, in the order of its §4. A branch
that needs a number takes the one the table gives it. Two branches picking the
next free number merge cleanly and fail on a host, which is where `migrate.mjs`
checks — the collision this rule exists to prevent was already written into an
earlier draft of that plan, with `0063` claimed twice.

## 2. What a commit says

A commit is one change with one reason. The subject names the change; the body
says why it was needed and what it is evidence of.

```
fix(supervisor): the inspection ran as a user who could not read the workspace
docs: the delivery pipeline, without GitHub Actions
rehearsal: a release whose worker refuses to start
```

- **Type prefixes in use:** `feat`, `fix`, `docs`, `chore`, `refactor`, `test`,
  `revert`, `rehearsal`. A scope in parentheses when one component owns the
  change.
- **The subject is a statement, not a label.** "the inspection ran as a user who
  could not read the workspace" survives being read a year later;
  "fix supervisor bug" does not.
- **The body carries the evidence.** A defect number from
  [STAGE_11_1_DEFECTS.md](STAGE_11_1_DEFECTS.md), a file and line, or the host
  observation that produced the change. Nothing is claimed on general principle.
- **Every commit an agent writes ends with its attribution trailer**
  (`Co-Authored-By:`). Authorship of machine-written code is not something to
  leave ambiguous.
- **A commit compiles and its suites pass.** Not the branch — the commit. A
  bisect through commits that do not individually run is a bisect that reports
  the wrong one.

Each work-package commit names the row of [STAGE_11_1B_PLAN.md](STAGE_11_1B_PLAN.md)
§4 it advances, as [STAGE_11_PLAN.md](STAGE_11_PLAN.md) §4 already requires of
its pull requests.

## 3. What runs before a push

From [DELIVERY_PIPELINE.md](DELIVERY_PIPELINE.md) §3. The level is chosen by
what the change touches, and `scope.yml`'s rule decides: everything is code
unless it is documentation.

| Change | Before the push |
| --- | --- |
| Documentation only | nothing. Prose cannot break a suite |
| Code, no database surface | `lint:services`, `typecheck`, `test:unit` |
| Migrations, SQL functions, shipped queries | the full offline gate — `scripts/run-suites-in-container.sh` — which is where the database suites run |
| Release layout, `deploy/`, units or tmpfiles | the offline gate, then a release candidate (level 2) |
| Anything that installs | level 3 on a disposable host, before the deployment, not before the push |

**And then a release, every time.** A finished work package is not a merged
branch; it is a release candidate running on the host. A one-line fix is a
release too. Every candidate of Stage 11.1 went this way — fifteen of them, most
of them point fixes — and the steps are
[RELEASE_RUNBOOK.md](RELEASE_RUNBOOK.md). The gate says the commit is sound; only
the update says the host takes it.

**The gate runs on `HEAD`, not on the working tree.** `git archive HEAD` is what
enters the container, so an uncommitted fix is a fix the gate has not seen.
Commit first, then gate — and if the gate fails, amend or add a commit and run
it again.

## 4. Pushing, and what a pull request costs

**A push to a work branch is free.** Both heavy workflows were narrowed to one
run per change: `release.yml` and `installer-acceptance.yml` trigger on `push`
only for `main` and `v*` tags, and otherwise on `pull_request`.

**Opening a pull request is not free.** It starts a 120-minute release job and
an installer acceptance on `ubuntu-24.04`, against an account at its
2000 minutes/month ceiling. That ceiling is why
[DELIVERY_PIPELINE.md](DELIVERY_PIPELINE.md) exists at all.

So, until the pipeline has moved into scripts:

- push work branches freely — they trigger nothing;
- **never push a release-candidate tag.** `release.yml` runs on `tags: ["v*"]`,
  so a pushed `v0.4.0-rc.N` starts the tag build and its publish job. None of
  Stage 11.1's fifteen candidate tags was ever pushed: a candidate is built,
  signed and delivered by hand ([RELEASE_RUNBOOK.md](RELEASE_RUNBOOK.md)), and
  its tag stays in the local repository as the record of what was built. This
  was nearly got wrong for rc.16 — it was described as free to push, and only a
  check of the workflow's triggers before pushing caught it;
- **open a pull request only when the owner asks for one**, or when the package
  is finished and its review is the next thing that has to happen;
- a documentation-only pull request is cheap by construction: `scope.yml`
  reports `code == false` and the heavy jobs skip themselves. It is still worth
  knowing that this is *why* they are cheap, rather than assuming all pull
  requests are;
- never re-open or churn a pull request to re-trigger a run. Each one is minutes
  that the release path may need that week.

**Never force-push a branch that has been pushed.** History that has left the
machine is history someone else may be reading. A mistake is corrected by a new
commit, or by `git revert` — which is how the Stage 11A code was taken back out
of the CI change, in the open, with a commit that says so.

## 5. Merging

- Work package into `feat/stage-11-1b`: `--no-ff`, so the package is one object
  in the history and one object to revert.
- The gate on the merge result, not only on the branch: two packages that each
  pass alone can fail together, and the integration line is where that shows.
- `feat/stage-11-1b` into `main`: when §2's exit criteria are demonstrated. The
  criteria are the definition of done — that is the rule that stops the substage
  growing until 11.2 never starts.
- A rehearsal branch merges nowhere. It exists to be run against, and it says so
  in its own commit message.

## 6. What never enters a commit

- Secrets of any kind: `.env` files, private keys, tokens, passwords, a database
  URL with credentials in it. `.gitignore` covers the shapes — `*.pem`, `.env.*`,
  `release/keys/*.key` — and the offline gate refuses to build a container from a
  snapshot that contains one anyway, because "should never" is what every leaked
  secret was before it leaked.
- Build output, `dist/`, `node_modules/`, staging trees.
- `.claude/settings.local.json`. A permission file that arrives with a checkout
  grants access nobody reviewed.

## 7. How a work package is recorded

One package produces, in order:

1. a branch off the integration line;
2. commits that each stand alone, the first of which names the plan row;
3. a gate run at the level §3 requires, whose output is the evidence — including
   its skip list, because a gate that does not say what it skipped is decoration;
4. where the package claims a gate catches something, a rehearsal branch that
   proves it does, and a line in the package's own document recording the run;
5. a merge into `feat/stage-11-1b`, `--no-ff`;
6. **a release candidate from the merge commit** — tagged, built from a clean
   clone, signed by the owner, delivered and applied with `infra-cod update` as
   [RELEASE_RUNBOOK.md](RELEASE_RUNBOOK.md) describes — and its post-update checks
   (`version`, `doctor`, units, the SIGTERM count) recorded next to the gate run.

One package, one candidate. Two packages in one candidate cannot be told apart
when the host disagrees with the gate, and rolling one back would roll back both.

**When the package ships nothing.** The release payload is an allowlist:
`db/tests`, the gate scripts and every document except `docs/OPERATIONS.md` stay
out of it. A package like WP-1 or WP-2 therefore produces a candidate whose
payload differs from the previous one only in its version. It is released anyway,
and the record says plainly what that proves — that the line still updates and
rolls back cleanly — and does not claim more.

**A change to `update.mjs` is proven one candidate later.** The installed
release's coordinator drives the update, so a package that changes how updates
work is delivered by hand this time and is not closed until the *next* candidate
has updated through it.

A package whose proof is a claim in a pull request description has not been
proven. That sentence is from the Stage 11.0 rehearsal, and it is the reason
that document exists.
