import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

test("get.sh carries the release signing key, the same as release/keys", () => {
  // get.sh verifies a release before anything in it runs, with a key written
  // into the script. A rotated key that is not rotated there too would make
  // every one-command install refuse a correctly signed release.
  const script = readFileSync(path.join(root, "deploy/get.sh"), "utf8");
  const [, key] = readFileSync(path.join(root, "release/keys/infra-cod-release.pub"), "utf8").trim().split("\n");
  assert.match(script, new RegExp(`^PUBLIC_KEY="${key.replace(/[+/]/g, "\\$&")}"$`, "m"));
});
