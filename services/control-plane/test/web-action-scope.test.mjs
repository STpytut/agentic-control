// Every action a panel component submits can be scoped to a project.
//
// performControlPlaneAction first resolves which project the action touches
// (ownedProjectForAction): some kinds derive it from the resource they name,
// a few need none, and every other kind must carry `projectId`. rc.57's
// "Publish to GitHub" submitted `{ kind: "publish_request", id }` and was
// refused with "projectId is invalid" on the host — a kind the resolver did not
// know, sent without the field its fallback requires. This reads both sides.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "../../..");
const actions = readFileSync(path.join(root, "apps/web/src/lib/control-plane-actions.ts"), "utf8");
const resolver = actions.slice(actions.indexOf("async function ownedProjectForAction"),
  actions.indexOf("export async function performControlPlaneAction"));

function components(dir) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...components(full));
    else if (entry.name.endsWith(".tsx")) files.push(full);
  }
  return files;
}

test("every submitted action kind is resolved by the owner check or carries projectId", () => {
  const unscoped = [];
  for (const file of components(path.join(root, "apps/web/src"))) {
    const source = readFileSync(file, "utf8");
    // A component whose own request wrapper adds the project to every body
    // (project-danger-zone.tsx) scopes whatever it submits.
    const wrapperScopes = /JSON\.stringify\(\{[^)]*\bprojectId\b[^)]*\.\.\.body/.test(source);
    for (const match of source.matchAll(/\{\s*kind:\s*"([a-z_]+)"([^}]*)\}/g)) {
      const [, kind, rest] = match;
      if (wrapperScopes || /\bprojectId\b/.test(rest)) continue;
      if (resolver.includes(`"${kind}"`)) continue;
      const prefixed = [...resolver.matchAll(/kind\.startsWith\("([a-z_]+)"\)/g)].some(([, prefix]) => kind.startsWith(prefix));
      if (prefixed) continue;
      unscoped.push(`${kind} (${path.relative(root, file)})`);
    }
  }
  assert.deepEqual(unscoped, [], `actions submitted without projectId that the owner check does not resolve: ${unscoped.join(", ")}`);
});
