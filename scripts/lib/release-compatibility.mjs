// The schema compatibility contract a release carries about its own migrations.
//
// `infra-cod update` has to answer two questions before it touches a live host:
// may the old release keep serving while these migrations run, and is an
// application-only rollback to it still a rollback afterwards? Both are the same
// fact — "does release A still read the schema B leaves behind" — and nothing in
// the SQL can be asked for it. So `db/schema-compatibility.json` declares it per
// migration, the release build copies the declaration into the manifest, and the
// update coordinator reads it from there.
//
// The manifest is the transport rather than the source because the update reads
// the *incoming* release's contract, and the incoming release is a verified
// artifact: its manifest is covered by FILESUMS.sha256, which is covered by the
// signed SHA256SUMS. A separate payload file would have to earn that same trust
// again, and a file the operator could hand over separately would not have it at
// all.
//
// Everything unknown is incompatible. A migration with no entry, a release with
// no contract and a contract this code does not understand all produce the same
// answer, which is the answer that keeps an old worker away from a new schema.

import { readFileSync } from "node:fs";
import path from "node:path";

export const COMPATIBILITY_SCHEMA = "infra-cod/schema-compatibility/1";
export const COMPATIBILITY_FILENAME = "schema-compatibility.json";

export class CompatibilityError extends Error {
  constructor(message) {
    super(message);
    this.name = "CompatibilityError";
  }
}

const VERSION = /^\d{4}$/;
const MIGRATION = /^(\d{4})_[A-Za-z0-9_]+\.sql$/;

export function migrationVersion(name) {
  const match = MIGRATION.exec(name);
  if (!match) throw new CompatibilityError(`${name} is not a migration filename`);
  return match[1];
}

export function loadCompatibility(databaseDirectory) {
  const file = path.join(databaseDirectory, COMPATIBILITY_FILENAME);
  let document;
  try {
    document = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new CompatibilityError(`${file} is not readable JSON: ${error.message}`);
  }
  if (document.schema !== COMPATIBILITY_SCHEMA) {
    throw new CompatibilityError(
      `${file} has schema ${JSON.stringify(document.schema)}, expected ${COMPATIBILITY_SCHEMA}`,
    );
  }
  if (!VERSION.test(document.unverifiedThrough ?? "")) {
    throw new CompatibilityError(`${file} has no four-digit unverifiedThrough boundary`);
  }
  if (!document.migrations || typeof document.migrations !== "object") {
    throw new CompatibilityError(`${file} has no migrations object`);
  }
  for (const [name, entry] of Object.entries(document.migrations)) {
    migrationVersion(name);
    if (typeof entry?.previousReleaseCompatible !== "boolean") {
      throw new CompatibilityError(
        `${file}: ${name}.previousReleaseCompatible is ${JSON.stringify(entry?.previousReleaseCompatible)}, expected a boolean`,
      );
    }
    if (typeof entry.note !== "string" || entry.note.trim().length === 0) {
      throw new CompatibilityError(`${file}: ${name} has no note saying why`);
    }
  }
  return document;
}

// Which migrations a reviewer has to be told about, and which ones this file
// cannot vouch for. Everything not named here is backward compatible, so the
// summary stays a handful of names rather than one line per migration — and it
// still describes every migration in the set, because the set is what it is
// compared against.
export function compatibilitySummary({ migrationNames, compatibility }) {
  const boundary = compatibility.unverifiedThrough;
  const unverified = [];
  const incompatible = [];
  const undeclared = [];

  for (const name of migrationNames) {
    const version = migrationVersion(name);
    const entry = compatibility.migrations[name];
    if (entry) {
      if (!entry.previousReleaseCompatible) incompatible.push(version);
      continue;
    }
    if (version <= boundary) unverified.push(version);
    else undeclared.push(name);
  }

  if (undeclared.length > 0) {
    throw new CompatibilityError(
      `these migrations are past the ${boundary} boundary and declare no compatibility in `
      + `db/${COMPATIBILITY_FILENAME}: ${undeclared.join(", ")}. `
      + "Add an entry saying whether the previous release can still read the schema the migration leaves behind.",
    );
  }

  return {
    contract: COMPATIBILITY_SCHEMA,
    unverifiedThrough: boundary,
    unverified,
    backwardIncompatible: incompatible,
  };
}
