import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { globSync } from "node:fs";
import path from "node:path";

// Guards the failure mode that the psql -> pg.Pool port introduced: a helper
// becomes async, its declaration is updated, and a call site keeps using the
// return value as if it were still a plain value. `node --check` cannot see
// this — awaiting is not required syntax — and it surfaces at runtime as
// "x.some is not a function", which in the deprovision path meant every project
// deletion threw instead of completing.
//
// A call is acceptable when it is awaited, returned, voided, or has a
// .then/.catch/.finally chained onto it. Anything else is reported.

const root = path.resolve(import.meta.dirname, "../../..");

function serviceFiles() {
  return globSync("services/**/*.mjs", { cwd: root })
    .filter((file) => !file.includes("/test/"))
    .map((file) => path.join(root, file));
}

function unawaitedCalls(source) {
  const asyncNames = new Set([
    ...[...source.matchAll(/const (\w+) = async \(/g)].map((m) => m[1]),
    ...[...source.matchAll(/(?:export\s+)?async function (\w+)\s*\(/g)].map((m) => m[1]),
  ]);
  const findings = [];
  const lines = source.split("\n");

  lines.forEach((line, index) => {
    const trimmed = line.trim();
    if (trimmed.startsWith("//") || trimmed.startsWith("*")) return;
    if (/^(export\s+)?async function \w+\s*\(/.test(trimmed)) return;
    if (/^const \w+ = async \(/.test(trimmed)) return;

    for (const name of asyncNames) {
      for (const match of line.matchAll(new RegExp(`(?<![.\\w])${name}\\s*\\(`, "g"))) {
        const before = line.slice(0, match.index).trimEnd();
        const after = line.slice(match.index);
        if (/(await|void|return|=>|&&|\|\||\(|,|\?|:)$/.test(before)) continue;
        // A chain may continue on the following lines.
        const tail = [after, lines[index + 1] ?? "", lines[index + 2] ?? ""].join("\n");
        if (/\.(then|catch|finally)\s*\(/.test(tail)) continue;
        findings.push(`${trimmed.slice(0, 90)}  [line ${index + 1}, ${name}()]`);
      }
    }
  });
  return findings;
}

test("every call to a locally declared async function is awaited or chained", () => {
  const problems = [];
  for (const file of serviceFiles()) {
    const source = readFileSync(file, "utf8");
    if (!source.includes("db.mjs")) continue;
    for (const finding of unawaitedCalls(source)) {
      problems.push(`${path.relative(root, file)}: ${finding}`);
    }
  }
  assert.deepEqual(problems, [], `unawaited async calls:\n${problems.join("\n")}`);
});

test("the audit detects a dropped await", () => {
  // Pins the detector itself: this is the exact shape that shipped in
  // deprovisionProject — an async helper whose result is used as an array.
  const regressed = `
import { queryJsonRows } from "./db.mjs";
async function run() {
  const scanWriters = async () => queryJsonRows("SELECT 1");
  const liveRuns = scanWriters();
  return liveRuns.some((r) => r);
}
`;
  const findings = unawaitedCalls(regressed);
  assert.equal(findings.length, 1, `expected the dropped await to be reported, got ${findings.length}`);
  assert.match(findings[0], /scanWriters/);
});
