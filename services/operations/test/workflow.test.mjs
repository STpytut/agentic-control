// The workflow files, checked for the one mistake that costs a push to find.
//
// GitHub reports a malformed workflow as "This run likely failed because of a
// workflow file issue" and nothing else: no line, no reason, and the job never
// starts. The mistake that produced it was a shell heredoc inside a `run: |`
// block — a heredoc terminator has to sit at column zero, and a line at column
// zero ends the YAML block scalar it is inside.
//
// This needs no YAML parser: the defect is structural and visible in the text.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORKFLOWS = path.resolve(HERE, "../../../.github/workflows");

function workflows() {
  return readdirSync(WORKFLOWS).filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"));
}

test("there are workflows to check", () => {
  assert.ok(workflows().length > 0, "no workflow files found");
});

for (const name of workflows()) {
  test(`${name} has no content at column zero except top-level keys`, () => {
    const offenders = [];
    readFileSync(path.join(WORKFLOWS, name), "utf8").split("\n").forEach((line, index) => {
      if (line.length === 0) return;
      if (/^\s/.test(line)) return;
      if (line.startsWith("#")) return;
      // A top-level mapping key, which is the only thing allowed here.
      if (/^[A-Za-z_][A-Za-z0-9_-]*:/.test(line)) return;
      offenders.push(`${index + 1}: ${line}`);
    });
    assert.deepEqual(offenders, [],
      `${name} has lines at column zero that end the block scalar they are inside:\n${offenders.join("\n")}`);
  });

  test(`${name} has no heredoc inside a run block`, () => {
    const source = readFileSync(path.join(WORKFLOWS, name), "utf8");
    const offenders = [];
    source.split("\n").forEach((line, index) => {
      if (/<<-?\s*['"]?EOF/.test(line)) offenders.push(`${index + 1}: ${line.trim()}`);
    });
    // A heredoc can be written safely with `<<-` and a tab-indented terminator,
    // but nothing here needs one, and every attempt so far has been the bug.
    assert.deepEqual(offenders, [],
      `${name} uses a heredoc inside a block scalar; use a pipeline or printf instead:\n${offenders.join("\n")}`);
  });
}
