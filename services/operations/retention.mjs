// What may go, decided apart from deleting it.
//
// rc.120 could not update the production host: its 30G disk was full. Nothing had ever
// removed an installed release, and backups were removed only by age, while
// every update installs a release (~45M) and takes a backup (~140M). A hundred
// and twenty updates in two weeks filled the disk; the restore drill was what
// noticed, with "No space left on device" from createdb. Both choices are pure
// so the rule can be read and tested without a host.

// Installed releases: the newest `keep` by install time, and always the ones
// named in `protect` — the release now live and the one it rolls back to.
// `releases` is [{ name, installedAt }]; what is returned is names to remove.
export function releasesToPrune(releases, { keep, protect = [] }) {
  if (!Number.isInteger(keep) || keep < 2) throw new Error("at least two releases are kept: the live one and its rollback target");
  const kept = new Set(protect);
  for (const release of [...releases].sort((a, b) => b.installedAt - a.installedAt)) {
    if (kept.size >= keep) break;
    kept.add(release.name);
  }
  return releases.map((release) => release.name).filter((name) => !kept.has(name));
}

// Backups, by the timestamp in their name (infra-cod-<ISO with - for :>.tar.gpg):
// the newest `keep`, and the newest of each day within `retentionDays`. The
// newest is always kept — it is the one `latest.json` names and the restore
// drill reads. Returns the .tar.gpg names to remove; the caller removes each
// one's receipts with it.
export function backupsToPrune(names, { now, retentionDays, keep }) {
  if (!Number.isInteger(keep) || keep < 1) throw new Error("backup count limit is invalid");
  const backups = names
    .filter((name) => /^infra-cod-.+\.tar\.gpg$/.test(name))
    .map((name) => ({ name, at: backupTime(name) }))
    .filter((backup) => Number.isFinite(backup.at))
    .sort((a, b) => b.at - a.at);
  const cutoff = now - retentionDays * 86_400_000;
  const kept = new Set(backups.slice(0, keep).map((backup) => backup.name));
  const days = new Set();
  for (const backup of backups) {
    if (backup.at < cutoff) break;
    const day = new Date(backup.at).toISOString().slice(0, 10);
    if (days.has(day)) continue;
    days.add(day);
    kept.add(backup.name);
  }
  return backups.map((backup) => backup.name).filter((name) => !kept.has(name));
}

function backupTime(name) {
  const match = /^infra-cod-(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})(?:\.(\d+))?Z\.tar\.gpg$/.exec(name);
  if (!match) return Number.NaN;
  return Date.parse(`${match[1]}T${match[2]}:${match[3]}:${match[4]}.${match[5] ?? "0"}Z`);
}
