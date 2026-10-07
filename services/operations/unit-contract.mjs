// The one list of units this installation is made of.
//
// There were five: `infra-cod.target`, the health snapshot, `doctor`, the
// installer and the acceptance workflow each kept their own, and they drifted.
// The health snapshot was missing `infra-cod-caddy` and
// `infra-cod-project-provisioner` and watched the Debian meta-unit
// `postgresql.service` — which is inactive on a host where PostgreSQL 17 is
// running perfectly well under `postgresql@17-main.service`, so health reported a
// dead database on a healthy machine and failed the install.
//
// `unit-contract.test.mjs` compares this file against the target's `Wants=` and
// against the unit files the release ships, so a new worker that is added to one
// and not the other fails a test instead of going unwatched.

import { allAdapters, sandboxPathsFor } from "./runtime-adapters.mjs";
import { layoutPaths } from "./installation-layout.mjs";

// The PostgreSQL unit that actually runs the cluster. `postgresql.service` is a
// meta-unit that stays inactive; asking it whether the database is up is asking
// the wrong question and getting a confident wrong answer.
export const POSTGRESQL_UNIT = "postgresql@17-main.service";

// Type=simple services that must be active whenever the target is up.
export const LONG_RUNNING_SERVICES = [
  "infra-cod-web",
  "infra-cod-caddy",
  "infra-cod-runtime-supervisor",
  "infra-cod-dispatcher",
  "infra-cod-reconciler",
  "infra-cod-project-provisioner",
  "infra-cod-project-deprovision-worker",
  "infra-cod-orchestrator-worker",
  "infra-cod-codex-account-worker",
  "infra-cod-opencode-account-worker",
  "infra-cod-implementation-worker",
  "infra-cod-github-app-worker",
  "infra-cod-catalog-refresh-worker",
  "infra-cod-catalog-gate-worker",
  "infra-cod-telegram-notifier",
];

// Type=oneshot services. A completed oneshot is `inactive`, so `is-active` is
// the wrong question for these; `Result=success` is the right one.
export const ONESHOT_SERVICES = [
  "infra-cod-backup",
  "infra-cod-restore-drill",
  "infra-cod-health",
  "infra-cod-runtime-watch",
  "infra-cod-runtime-probation",
  "infra-cod-runtime-update",
];

// Timers, which arm the oneshots above.
export const TIMERS = [
  "infra-cod-backup",
  "infra-cod-restore-drill",
  "infra-cod-health",
  "infra-cod-runtime-watch",
  "infra-cod-runtime-probation",
  "infra-cod-runtime-update",
];

// The directories systemd mounts into a unit's namespace.
//
// These are resolved while the mount namespace is built, before ExecStart, so a
// missing one is `status=226/NAMESPACE` and the unit never runs. Their owner,
// group and mode are part of the contract and not decoration: `.codex` and
// `.local` hold the agents' credentials, and a directory that exists with mode
// 0777 is not the same fact as a directory that exists.
//
// Derived since WP-5a: the runtime rows come from the adapter registry and the
// rest from the installation layout, so a runtime added or moved there is added
// or moved here, and tmpfiles, the installer and doctor are checked against it.
//
// One list, checked three ways: `deploy/tmpfiles.d` declares it, `install.sh`
// creates it, and `doctor` verifies it. `unit-contract.test.mjs` compares the
// tmpfiles entries against this.
export const RUNTIME_SANDBOX_PATHS = [
  // Each runtime's home and state directories, from the adapter registry.
  ...allAdapters().flatMap(sandboxPathsFor),
  // The platform's own directories, from the installation layout.
  ...layoutPaths(),
];

export function unitFileNames() {
  return [
    ...LONG_RUNNING_SERVICES.map((name) => `${name}.service`),
    ...ONESHOT_SERVICES.map((name) => `${name}.service`),
    ...TIMERS.map((name) => `${name}.timer`),
    "infra-cod.target",
  ];
}
