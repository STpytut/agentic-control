import test from "node:test";
import assert from "node:assert/strict";
import { objectsToDelete } from "../offsite-backup.mjs";

test("the newest copies stay, older ones go with their receipts", () => {
  const day = (n) => `2026-10-${String(n).padStart(2, "0")}T03:00:00.000Z`;
  const objects = [];
  for (let n = 1; n <= 16; n += 1) {
    objects.push({ key: `infra-cod/b${n}.tar.gpg`, lastModified: day(n), size: 10 });
    objects.push({ key: `infra-cod/b${n}.tar.gpg.json`, lastModified: day(n), size: 1 });
  }
  assert.deepEqual(objectsToDelete(objects, 14).sort(),
    ["infra-cod/b1.tar.gpg", "infra-cod/b1.tar.gpg.json", "infra-cod/b2.tar.gpg", "infra-cod/b2.tar.gpg.json"]);
  assert.deepEqual(objectsToDelete(objects.slice(0, 6), 14), []);
});
