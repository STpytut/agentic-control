#!/usr/bin/env node
// `infra-cod` — the operator entry point.
//
// Deliberately thin: it dispatches to a module per command family so that each
// one can be tested and reasoned about on its own, and so that a future command
// does not turn this file into a second implementation of anything.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runAdmin } from "./admin.mjs";
import { runDoctor } from "../operations/doctor.mjs";
// Eagerly, at load time, and not behind the `case` that uses them. `infra-cod
// update` replaces the release this file is running from: a lazy `import()`
// after the symlink moved would resolve through `current` and load the new
// release's code into the old release's run.
import { runReleases, runRollback, runUpdate } from "../operations/update.mjs";
import { runRuntime } from "../operations/runtime.mjs";
import { runConsole } from "../operations/console.mjs";

const USAGE = `infra-cod <command>

  admin <subcommand>    Local operator administration (see \`infra-cod admin help\`).
  console [section]     Read-only operator view of this host (see \`infra-cod console help\`).
  doctor [--json]       System health diagnostics.
  update --artifact <f> --checksums <f> --signature <f> --public-key <f>
                        Update this host to a signed release, with rollback.
  rollback --to <ver>   Return to an installed release, if the schema allows it.
  releases list         What is installed, what is current, what is running.
  runtime <subcommand>  Provision the agent runtimes (see \`infra-cod runtime\`).
  version               Print the installed version.
`;

// Where `version` reads its answer.
//
// The release manifest, not `package.json`. The root manifest describes the
// workspace, not an artifact — it is `private`, and its version field is whatever
// was last written there — so reading it meant `infra-cod version` printed `0.0.0`
// on an installed release. The release manifest is produced by the release build,
// travels inside the tarball, and is covered by the artifact's own checksums, so it
// is the only source that can answer "which release is installed" truthfully.
//
// The path is relative to this file, so the answer does not depend on the working
// directory: a release has `../../manifest.json`, a source checkout has nothing at
// all and falls back to a value that says so. No build path is baked in.
const COMMAND_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const RELEASE_MANIFEST = path.resolve(COMMAND_DIRECTORY, "../../manifest.json");
const RELEASE_MANIFEST_SCHEMA = "infra-cod/release-manifest/1";

// The development fallback is named `development` and carries no version number
// that could be mistaken for a release. Reporting a plausible-looking version from
// a checkout is the bug this command had.
export function developmentReport() {
  return {
    name: "infra-cod",
    version: null,
    channel: "development",
    source: "checkout",
    note: "not a release build; run `npm run release:build` to produce a versioned artifact",
  };
}

export function releaseReport(manifest) {
  return {
    name: manifest.product ?? "infra-cod",
    version: manifest.version,
    channel: manifest.channel,
    gitSha: manifest.git?.sha,
    target: `${manifest.target?.os}-${manifest.target?.arch}`,
    libc: manifest.target?.libc,
    node: manifest.toolchain?.node,
    migrations: manifest.database?.migrationCount,
    latestMigration: manifest.database?.latestMigration,
    signed: manifest.release?.signed === true,
    source: "release-manifest",
  };
}

export function readVersionReport(manifestPath = RELEASE_MANIFEST) {
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return developmentReport();
    // A manifest that exists and does not parse is not a checkout: it is a broken
    // installation, and answering "development" would hide that.
    throw new Error(`${manifestPath} exists but is not readable JSON: ${error.message}`);
  }
  if (manifest.schema !== RELEASE_MANIFEST_SCHEMA) {
    throw new Error(
      `${manifestPath} has schema ${JSON.stringify(manifest.schema)}, which this command does not understand`,
    );
  }
  return releaseReport(manifest);
}

// The dispatch runs unconditionally, which is what a `bin` script needs: systemd
// starts this file through `/opt/infra-cod/current`, a symlink, so any guard that
// compared raw paths would have to resolve the link before deciding to do anything
// — and a CLI that silently does nothing when it is started the way production
// starts it is worse than one that is awkward to import. Tests spawn it.
const [command, ...rest] = process.argv.slice(2);
switch (command) {
  case "admin":
    process.exitCode = await runAdmin(rest);
    break;
  case "console":
    process.exitCode = await runConsole(rest);
    break;
  case "doctor":
    process.exitCode = await runDoctor(rest);
    break;
  case "update":
    process.exitCode = await runUpdate(rest);
    break;
  case "rollback":
    process.exitCode = await runRollback(rest);
    break;
  case "releases":
    process.exitCode = await runReleases(rest);
    break;
  case "runtime":
    process.exitCode = await runRuntime(rest);
    break;
  case "version":
    process.stdout.write(`${JSON.stringify(readVersionReport())}\n`);
    break;
  default:
    process.stdout.write(`${USAGE}\n`);
    process.exitCode = command ? 1 : 0;
}
