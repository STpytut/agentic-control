// The schema compatibility contract is complete, and stays complete.
//
// `infra-cod update` refuses to apply a migration whose compatibility nobody
// declared. That refusal is correct on a live host and useless as a development
// signal: it would be discovered by an operator, at the maintenance window, on
// the release that already shipped. This test is where a missing declaration is
// meant to be found instead — when the migration is written.

import { readdirSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import {
  COMPATIBILITY_SCHEMA,
  compatibilitySummary,
  loadCompatibility,
  migrationVersion,
} from "../../../scripts/lib/release-compatibility.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const migrationNames = readdirSync(path.join(root, "db/migrations"))
  .filter((name) => name.endsWith(".sql"))
  .sort();

test("every migration past the contract boundary declares whether the previous release survives it", () => {
  const compatibility = loadCompatibility(path.join(root, "db"));
  // The throw carries the filenames and what to do about them, so the assertion
  // is on the summary succeeding rather than on a message.
  const summary = compatibilitySummary({ migrationNames, compatibility });
  assert.equal(summary.contract, COMPATIBILITY_SCHEMA);
  assert.equal(summary.unverifiedThrough, compatibility.unverifiedThrough);
});

test("the unverified boundary only ever covers migrations that already exist", () => {
  const compatibility = loadCompatibility(path.join(root, "db"));
  const latest = migrationVersion(migrationNames[migrationNames.length - 1]);
  // Moving the boundary forward past the migrations in the tree would silently
  // exempt the next migrations anybody writes — the one edit that turns this
  // contract back into a comment.
  assert.ok(
    compatibility.unverifiedThrough <= latest,
    `unverifiedThrough is ${compatibility.unverifiedThrough}, which is past the latest migration ${latest}`,
  );
  for (const name of Object.keys(compatibility.migrations)) {
    assert.ok(
      migrationNames.includes(name),
      `${name} is declared in db/schema-compatibility.json but is not a migration in db/migrations`,
    );
  }
});

test("a migration past the boundary with no entry is refused, and the message says what to add", () => {
  const compatibility = loadCompatibility(path.join(root, "db"));
  assert.throws(
    () => compatibilitySummary({
      migrationNames: [...migrationNames, "9999_undeclared.sql"],
      compatibility,
    }),
    /schema-compatibility\.json.*9999_undeclared\.sql/s,
  );
});

test("an incompatible migration is reported by version, not hidden in a count", () => {
  const summary = compatibilitySummary({
    migrationNames: ["0051_a.sql", "0052_b.sql"],
    compatibility: {
      schema: COMPATIBILITY_SCHEMA,
      unverifiedThrough: "0050",
      migrations: {
        "0051_a.sql": { previousReleaseCompatible: true, note: "additive" },
        "0052_b.sql": { previousReleaseCompatible: false, note: "drops a column the previous release selects" },
      },
    },
  });
  assert.deepEqual(summary.backwardIncompatible, ["0052"]);
  assert.deepEqual(summary.unverified, []);
});
