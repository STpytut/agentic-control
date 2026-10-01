import test from "node:test";
import assert from "node:assert/strict";
import { backupsToPrune, releasesToPrune } from "../retention.mjs";

const releases = ["0.4.0-rc.1", "0.4.0-rc.2", "0.4.0-rc.3", "0.4.0-rc.4", "0.4.0-rc.5", "0.4.0-rc.6"]
  .map((name, index) => ({ name, installedAt: 1_000 + index }));

test("the newest releases stay, and the older ones go", () => {
  assert.deepEqual(releasesToPrune(releases, { keep: 3, protect: ["0.4.0-rc.6", "0.4.0-rc.5"] }),
    ["0.4.0-rc.1", "0.4.0-rc.2", "0.4.0-rc.3"]);
});

test("the live release and its rollback target stay whatever their age", () => {
  // A rollback put rc.2 live; its rollback target is rc.6. Both are kept, and
  // only one more fits.
  assert.deepEqual(releasesToPrune(releases, { keep: 3, protect: ["0.4.0-rc.2", "0.4.0-rc.6"] }),
    ["0.4.0-rc.1", "0.4.0-rc.3", "0.4.0-rc.4"]);
});

test("fewer releases than the limit removes nothing, and a limit under two is refused", () => {
  assert.deepEqual(releasesToPrune(releases.slice(0, 2), { keep: 5, protect: [] }), []);
  assert.throws(() => releasesToPrune(releases, { keep: 1, protect: [] }), /at least two/);
});

const day = 86_400_000;
const now = Date.parse("2026-10-01T18:00:00Z");
function backup(at) {
  return `infra-cod-${new Date(at).toISOString().replaceAll(":", "-")}.tar.gpg`;
}

test("the newest backups stay, and one a day within the retention", () => {
  // Five today, and two on each of the three days before.
  const names = [
    ...[1, 2, 3, 4, 5].map((hour) => backup(now - hour * 3_600_000)),
    ...[1, 2, 3].flatMap((back) => [backup(now - back * day), backup(now - back * day - 3_600_000)]),
  ];
  const removed = backupsToPrune([...names, "latest.json", `${names[0]}.json`], { now, retentionDays: 14, keep: 3 });
  // Today's two oldest, and the older of each earlier day's pair.
  assert.deepEqual(removed.sort(), [names[3], names[4], names[6], names[8], names[10]].sort());
});

test("a backup past the retention goes unless it is among the newest", () => {
  const old = [backup(now - 20 * day), backup(now - 30 * day)];
  assert.deepEqual(backupsToPrune(old, { now, retentionDays: 14, keep: 1 }), [old[1]]);
});

test("a name without a timestamp is never chosen", () => {
  assert.deepEqual(backupsToPrune(["infra-cod-manual.tar.gpg", backup(now)], { now, retentionDays: 14, keep: 1 }), []);
});
