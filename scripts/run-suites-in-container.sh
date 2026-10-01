#!/usr/bin/env bash
# Runs the operations suites in a disposable Ubuntu container.
#
# Why this exists: these suites simulate systemd, /proc, file locks and a Unix
# user boundary. macOS answers several of those questions differently — `flock`
# semantics, `/proc`, `realpath` on /var, `exec -c` in dash vs bash, and `tar`
# determinism — and a suite that is green only on a developer laptop proves less
# than it looks like.
#
# Why not the VPS: that host carries production mounts, secrets and the live
# panel. A test run there is a test run with something to lose.
#
# What goes in, and what does not
# -------------------------------
# The container gets `git archive HEAD` — the tracked tree at the current commit
# and nothing else. It does not get the working directory.
#
# That distinction is the whole point. A bind mount of the working directory
# carries `.env.local`, `apps/web/.env.local`, any private key sitting in the
# checkout, `.git` with its credentials, and a host `node_modules` built for a
# different platform. `test:unit` runs with `--env-file-if-exists=.env.local`, so
# those secrets were not merely present — they were loaded. An image from Docker
# Hub with unrestricted outbound networking is not a place to put them.
#
# Networking is granted for exactly one phase and then taken away:
#
#   1. prepare — has network, installs Node and the locked dependencies, sees no
#      source but `package.json` and the lockfile.
#   2. run — `--network none`, sees the snapshot, and cannot reach anything. The
#      runtime harness serves its registry on loopback, which `--network none`
#      still provides.
#
# So the phase that can talk to the internet has nothing worth sending, and the
# phase that has the source cannot talk.
#
# The database, and how it is reached without giving anything egress
# ------------------------------------------------------------------
# 33 database test files, the DB integration suite, the query shapes and the
# lease contract ran nowhere automatic, and they cover the class of defect that
# reached the production host most often in 11.1 — a launch query naming columns
# that do not exist (92), a migration opening its own transaction (72), a
# function created in `public` (75).
#
# So a `postgres:17` container starts first with `--network none`, and the phase
# that has the source joins *its* namespace with `--network container:<pg>`.
# Then `localhost:5432` reaches the database and neither container can reach the
# internet — which is the property that mattered, not the flag. A sidecar on a
# bridge network would have been the other way round: reachable, and reachable
# both ways.
#
# The lease contract runs here too, through LEASE_CONTRACT_DATABASE_URL against
# its own empty database on that server. It used to be excluded because it
# creates a PostgreSQL container and there is no docker in here; with the server
# already in the namespace it no longer needs one.
#
#   scripts/run-suites-in-container.sh [test:runtime test:update ...]
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${here}"

suites=("$@")
# The default set is the whole offline gate: the unit suites, the runtime and
# update coordinators, the installer, the release/import-closure checks — a
# branch that adds files to the release payload is a branch that can break the
# packer — and the three phases that need a database.
#
# What is still not here, and cannot be: `test:integration:live` runs against the
# production host, `check:runtime-adapters` asks the real registry on purpose,
# and the installer acceptance needs systemd and root.
if [ ${#suites[@]} -eq 0 ]; then
  # `lint:services` first, and deliberately: `services/` was never linted, and an
  # undeclared identifier there is a crash waiting for its line to run. Two were
  # found the moment it was switched on, one of them a worker that died after its
  # first successful claim while every suite stayed green.
  #
  # The three database phases are last because they are the ones that need a
  # server, not because they matter least.
  suites=(lint:services test:unit test:runtime test:update test:installer test:release \
          db:test test:integration:db test:lease-contract test:e2e:orchestrator)
fi

# Does anything in this run need PostgreSQL? Asked rather than assumed, so a run
# of `scripts/run-suites-in-container.sh test:unit` does not pay for a database
# it will not open.
needs_database=0
for suite in "${suites[@]}"; do
  case "${suite}" in
    db:test|db:test:*|test:integration:db|test:lease-contract|test:e2e:*) needs_database=1 ;;
  esac
done

# Node and pnpm versions are read from the snapshot further down, not from the
# working tree: reading them here would gate a combination that exists in no
# commit if either file has an uncommitted change.

# INFRA_COD_CONTAINER_PLATFORM=linux/amd64 runs on the architecture the release
# ships for, through emulation and much slower.
platform=""
if [ -n "${INFRA_COD_CONTAINER_PLATFORM:-}" ]; then platform="--platform ${INFRA_COD_CONTAINER_PLATFORM}"; fi

volume="infra-cod-gate-$$"
database="infra-cod-gate-pg-$$"
snapshot="$(mktemp -t infra-cod-gate)"
deps="$(mktemp -d -t infra-cod-gate-deps)"
cleanup() {
  rm -rf "${snapshot}" "${deps}"
  docker rm -f "${database}" >/dev/null 2>&1 || true
  docker volume rm -f "${volume}" >/dev/null 2>&1 || true
}
trap cleanup EXIT

# Tracked files at HEAD. Not the index, not the working tree: whatever is
# uncommitted is also unreviewed, and this gate reports on a commit.
git archive --format=tar HEAD > "${snapshot}"

# The snapshot is built from tracked files, so this should never fire. It is here
# because "should never" is what every leaked secret was before it leaked.
#
# `.env.example` and the other `*.example` templates are tracked on purpose and
# hold no values; everything else matching these shapes stops the run.
forbidden="$(tar -tf "${snapshot}" \
  | grep -Ei '(^|/)(\.env($|\.)|\.git/|node_modules/|.*\.(pem|key|p12|pfx|sec)$|id_(rsa|ed25519)$)' \
  | grep -vE '\.example$' || true)"
if [ -n "${forbidden}" ]; then
  echo "refusing to build a container from a snapshot containing:" >&2
  echo "${forbidden}" >&2
  exit 1
fi

# Now that the snapshot exists, the toolchain versions come out of it.
#
# One source of truth for Node: the version the installer puts on a production
# host. A gate on a different Node is a gate on a different system — this said
# 22.14.0 while every other surface required 24.x.
node_version="$(tar -xOf "${snapshot}" deploy/install.sh | sed -n "s/^readonly NODE_VERSION='\([0-9.]*\)'.*/\1/p")"
if [ -z "${node_version}" ]; then echo "cannot read NODE_VERSION from the snapshot" >&2; exit 1; fi
pnpm_version="$(tar -xOf "${snapshot}" package.json | sed -n 's/.*"packageManager": *"pnpm@\([0-9.]*\)".*/\1/p')"
if [ -z "${pnpm_version}" ]; then echo "cannot read packageManager from the snapshot" >&2; exit 1; fi

docker volume create "${volume}" >/dev/null

# One image for both phases. Building it needs the network — it installs nothing
# but Ubuntu packages and sees no source — and the phase that runs the suites
# then has the tools without needing a network of its own.
image="infra-cod-gate:${node_version}"
docker build ${platform} -t "${image}" - >/dev/null <<'DOCKERFILE'
FROM ubuntu:24.04
ENV DEBIAN_FRONTEND=noninteractive
# Each of these is here because a suite skips itself without it, and a skipped
# suite reports green. The first run of this gate with `test:installer` in it
# passed 1 test and skipped 63 for want of `jq`.
#
# git: seven suites spawn it. python3: the update coordinator takes the dpkg
# frontend lock through it. procps: pgrep, which the drain asks about processes.
# jq: the installer's own scripts. minisign: the release signing tests refuse to
# pass against anything but the real implementation.
RUN apt-get update -qq \
 && apt-get install -y -qq --no-install-recommends \
      ca-certificates curl xz-utils python3 procps git jq minisign gnupg \
 && rm -rf /var/lib/apt/lists/*
# psql 17, from PGDG rather than from Ubuntu — noble ships the 16 client, and a
# gate whose client is a major version behind the server it tests against is a
# gate on a combination this product never runs. `migrate.mjs`, `run-db-tests.mjs`
# and the lease contract all spawn `psql`; `createdb` comes with it.
RUN . /etc/os-release \
 && curl -fsSL --retry 3 --retry-delay 2 --retry-all-errors https://www.postgresql.org/media/keys/ACCC4CF8.asc \
      | gpg --dearmor -o /usr/share/keyrings/pgdg.gpg \
 && echo "deb [signed-by=/usr/share/keyrings/pgdg.gpg] https://apt.postgresql.org/pub/repos/apt ${VERSION_CODENAME}-pgdg main" \
      > /etc/apt/sources.list.d/pgdg.list \
 && apt-get update -qq \
 && apt-get install -y -qq --no-install-recommends postgresql-client-17 \
 && rm -rf /var/lib/apt/lists/* \
 && psql --version
DOCKERFILE

# Phase 1: network, no source. Only the two files that describe dependencies —
# taken out of the same snapshot as the source, not out of the working tree. Two
# sources would mean the dependencies installed and the code tested came from
# different commits, which is a gate on a combination that exists nowhere.
# The workspace manifest and the web package too: `lint:services` runs the
# eslint that lives in `apps/web`, and pnpm installs a workspace package only
# when it can see it.
tar -xf "${snapshot}" -C "${deps}" package.json pnpm-lock.yaml pnpm-workspace.yaml apps/web/package.json
tar -cf - -C "${deps}" package.json pnpm-lock.yaml pnpm-workspace.yaml apps/web | docker run --rm -i ${platform} \
  -v "${volume}:/work" \
  -e NODE_VERSION="${node_version}" \
  -e PNPM_VERSION="${pnpm_version}" \
  "${image}" bash -euo pipefail -c '
    case "$(dpkg --print-architecture)" in
      arm64) arch=linux-arm64 ;;
      amd64) arch=linux-x64 ;;
      *) echo "unsupported architecture: $(dpkg --print-architecture)" >&2; exit 1 ;;
    esac
    # Retried, because this is the one place the gate depends on the internet and
    # a transient TLS timeout here reports as `curl: (28)` and nothing else —
    # which reads like the gate being broken rather than the route being slow.
    curl -fsSL --retry 3 --retry-delay 2 --retry-all-errors \
      "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-${arch}.tar.xz" -o /tmp/node.tar.xz
    mkdir -p /work/node && tar -xJf /tmp/node.tar.xz -C /work/node --strip-components=1
    rm -f /tmp/node.tar.xz
    export PATH="/work/node/bin:$PATH"
    mkdir -p /work/deps && tar -xf - -C /work/deps
    cd /work/deps
    corepack enable
    corepack prepare "pnpm@${PNPM_VERSION}" --activate
    # --ignore-scripts: a dependency install is not the place to run a
    # dependency'"'"'s code, and nothing here needs a native build.
    pnpm install --frozen-lockfile --ignore-scripts
  '

# The database, if this run needs one. Started between the two phases, so a
# failure in the prepare phase costs nothing to tear down, and destroyed by the
# same trap as everything else.
#
# `--network none` on the server, and phase 2 joins its namespace. Neither can
# reach the internet, and the server is reachable from nowhere else on the
# machine — not even from another container of this gate running in parallel.
network="--network none"
database_env=""
if [ "${needs_database}" = 1 ]; then
  # Pulled explicitly, and retried once. An implicit pull inside `docker run`
  # reports a registry timeout as a `docker run` failure, which reads like the
  # gate refusing to start rather than like the network it actually was.
  if ! docker image inspect postgres:17-bookworm >/dev/null 2>&1; then
    docker pull -q postgres:17-bookworm >/dev/null \
      || { sleep 5; docker pull -q postgres:17-bookworm >/dev/null; } \
      || { echo "cannot pull postgres:17-bookworm — the database phases need it" >&2; exit 1; }
  fi
  docker run -d --name "${database}" ${platform} --network none \
    -e POSTGRES_PASSWORD=gate -e POSTGRES_DB=postgres postgres:17-bookworm >/dev/null

  # Waited for, not slept past — and waited for over TCP from inside the
  # namespace, which is the only check that answers the right question. The
  # image's entrypoint runs initdb against a temporary server with
  # `listen_addresses=''`, so a `docker exec pg_isready` over the local socket can
  # report ready while the server the tests will connect to has not started yet.
  # 11.1 lost two rounds to this shape of wait.
  if ! docker run --rm ${platform} --network "container:${database}" "${image}" \
      bash -c 'for _ in $(seq 1 90); do pg_isready -h 127.0.0.1 -p 5432 -U postgres -q && exit 0; sleep 1; done; exit 1'; then
    echo "PostgreSQL did not accept a TCP connection within 90s" >&2
    docker logs --tail 40 "${database}" >&2
    exit 1
  fi
  echo "postgres:17 ready on 127.0.0.1:5432, with no route anywhere"

  network="--network container:${database}"
  # Two databases on one server: the suites' own, migrated by the product's
  # runner, and an empty one for the lease contract, which applies 0001 onward
  # itself and would fail on the first file against a schema that exists.
  database_env="-e DATABASE_URL=postgresql://postgres:gate@127.0.0.1:5432/infra_cod_gate
    -e LEASE_CONTRACT_DATABASE_URL=postgresql://postgres:gate@127.0.0.1:5432/infra_cod_lease
    -e PGHOST=127.0.0.1 -e PGPORT=5432 -e PGUSER=postgres -e PGPASSWORD=gate"
fi

# Phase 2: the source, and no route off the machine.
docker run --rm -i ${platform} ${network} \
  -v "${volume}:/work" \
  -e SUITES="${suites[*]}" \
  -e INFRA_COD_GATE_CONTAINER=1 \
  ${database_env} \
  "${image}" bash -euo pipefail -c '
    export PATH="/work/node/bin:$PATH"
    mkdir -p /work/repo && tar -xf - -C /work/repo
    cd /work/repo
    # pnpm'"'"'s links inside node_modules are relative, so each tree moves whole.
    mv /work/deps/node_modules ./node_modules
    if [ -d /work/deps/apps/web/node_modules ]; then
      mkdir -p apps/web
      mv /work/deps/apps/web/node_modules apps/web/node_modules
    fi
    node --version

    # The schema, created by the product'"'"'s own runner rather than by a dump.
    # `migrate.mjs` is what a production host runs, and it refuses a migration
    # that opens its own transaction — `psql` does not, and 0053 shipped with
    # BEGIN/COMMIT past a check that used raw psql.
    if [ -n "${DATABASE_URL:-}" ]; then
      echo "=== database ==="
      createdb infra_cod_gate
      createdb infra_cod_lease
      npm run --silent db:migrate
    fi

    # Which tests each suite is allowed to skip, by name.
    #
    # A count is not enough: if the allowed skip disappears and a different one
    # takes its place, the total is still 1 and the gate still goes green while
    # something new has quietly stopped running. So the budget names the test.
    #
    # The one entry is a test that forces EACCES through directory permissions
    # and refuses to pretend it proved anything as root.
    allowed_skip_pattern() {
      case "$1" in
        test:unit) echo "a file that cannot be read is not reported as absent" ;;
        *) echo "" ;;
      esac
    }
    allowed_skips() {
      case "$1" in
        test:unit) echo 1 ;;
        *) echo 0 ;;
      esac
    }

    status=0
    for suite in ${SUITES}; do
      echo "=== ${suite} ==="
      npm run --silent "${suite}" > /tmp/suite.log 2>&1 || status=1
      cat /tmp/suite.log

      # The marker before "skipped" is multi-byte, so it is matched by content
      # rather than by position: `^.` is one byte to sed, not one character.
      skipped="$(awk '"'"'/skipped/ { n = $NF } END { print n + 0 }'"'"' /tmp/suite.log)"
      skipped="${skipped:-0}"
      budget="$(allowed_skips "${suite}")"
      pattern="$(allowed_skip_pattern "${suite}")"
      if [ "${skipped}" -gt 0 ]; then
        echo "--- ${suite}: SKIPPED TESTS (${skipped}, allowed ${budget}) ---"
        grep -E "# (SKIP|harness needs|running as root|the .minisign)" /tmp/suite.log || true
      fi
      if [ "${skipped}" -gt "${budget}" ]; then
        echo "!!! ${suite} skipped ${skipped} tests, more than the ${budget} this gate allows." >&2
        echo "!!! A skipped test reports green. Install what it needs, or change the budget deliberately." >&2
        status=1
      elif [ "${skipped}" -gt 0 ]; then
        # The right number of skips, but are they the ones that were agreed?
        # Matched against a *skip* line, not merely against the name: the same
        # test passing would otherwise satisfy this check.
        if [ -z "${pattern}" ] \
           || ! grep -F "${pattern}" /tmp/suite.log | grep -qE "# (SKIP|harness needs|running as root)"; then
          echo "!!! ${suite} skipped ${skipped} tests, but not the one this gate allows." >&2
          echo "!!! Expected a skip of: ${pattern:-(none allowed)}" >&2
          status=1
        fi
      fi
    done
    exit "${status}"
  ' < "${snapshot}"
