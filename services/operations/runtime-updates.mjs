// Runtime updates without a terminal (0127): `infra-cod runtime updates --apply`,
// run as root by infra-cod-runtime-update.timer every five minutes.
//
// One action a pass, in this order:
//   1. A request from the panel — Qualify or Promote pressed — done through the
//      same code the CLI runs (qualifyAndRecord, promoteAndRecord), and its
//      outcome written back for the panel. A host busy with another update
//      puts the request back for the next pass.
//   2. Otherwise, the newest version of an installed runtime that is newer than
//      the active one and has no qualification under this release's adapter yet
//      is qualified: beside the active version, changing nothing. Not while the
//      subscription it would spend is at 80 % or more, and a version tried once
//      is not tried again by itself — Qualify in the panel does that.
// Promoting stays the owner's press.

import { closePool, queryJson } from "../control-plane/db.mjs";
import { LockError } from "./update-lock.mjs";
import { compareVersions, runtimeNames } from "./runtime-adapters.mjs";
import { driverFor } from "../runtime-supervisor/drivers/index.mjs";

export const USAGE_CEILING_PERCENT = 80;
const USAGE_READING_FRESH_MS = 3 * 3600_000;
// A qualification that failed before the candidate was installed — a download,
// a full disk, rc.109's EXDEV — or that ended incomplete — a usage limit, a host
// without memory to spare — said nothing about the version, so it is tried
// again, after a pause and a bounded number of times.
const INSTALL_FAILURE = /could not be installed/i;
export const INSTALL_RETRY_AFTER_MS = 30 * 60_000;
export const INSTALL_RETRIES = 3;

// Which version to qualify on its own, if any — pure, so the rules are tested
// without a host. `skipped` says why a runtime with a newer version waits.
export function nextQualification({ active, versions, qualifications, usage, adapterVersions, now = Date.now() }) {
  const skipped = [];
  for (const runtime of Object.keys(active).sort()) {
    const current = active[runtime];
    const newest = versions
      .filter((entry) => entry.runtime === runtime && entry.published_at && compareVersions(entry.version, current) > 0)
      .sort((left, right) => compareVersions(right.version, left.version))[0];
    if (!newest) continue;
    const mine = qualifications.filter((q) => q.runtime === runtime);
    if (mine.some((q) => q.result === "running")) {
      skipped.push({ runtime, version: newest.version, why: "a qualification of this runtime is running" });
      continue;
    }
    const tries = mine.filter((q) => q.version === newest.version && q.adapter_version === adapterVersions[runtime]);
    // Retried: an install that failed, and a qualification left incomplete —
    // a usage limit or a host out of memory decided it, not the version.
    const installOnly = tries.length > 0 && tries.every((q) => q.result === "incomplete"
      || (q.result === "failed" && INSTALL_FAILURE.test(q.summary ?? "")));
    if (tries.length && !installOnly) continue; // tried under this adapter: the panel's Qualify retries it
    if (installOnly) {
      const last = Math.max(...tries.map((q) => new Date(q.finished_at ?? q.started_at ?? 0).getTime()));
      if (tries.length >= INSTALL_RETRIES) continue;
      if (now - last < INSTALL_RETRY_AFTER_MS) {
        skipped.push({ runtime, version: newest.version, why: "its last qualification could not finish; tried again 30 minutes after" });
        continue;
      }
    }
    const reading = usage.find((entry) => entry.runtime === runtime);
    const fresh = reading && now - new Date(reading.read_at).getTime() < USAGE_READING_FRESH_MS;
    const full = fresh && (reading.windows ?? []).find((window) => Number(window.used_percent) >= USAGE_CEILING_PERCENT);
    if (full) {
      skipped.push({ runtime, version: newest.version,
        why: `the ${full.key ?? "usage"} window is at ${full.used_percent} % (qualifying waits below ${USAGE_CEILING_PERCENT} %)` });
      continue;
    }
    return { runtime, version: newest.version, skipped };
  }
  return { runtime: null, version: null, skipped };
}

async function readState(db) {
  const rows = (sql) => db(sql, {}).then((value) => (Array.isArray(value) ? value : []));
  const [versions, qualifications, usage] = await Promise.all([
    rows(`SELECT COALESCE(jsonb_agg(jsonb_build_object('runtime',runtime_type,'version',version,'published_at',published_at)),'[]')::text
      FROM runtime_versions WHERE state='available';`),
    rows(`SELECT COALESCE(jsonb_agg(jsonb_build_object('runtime',runtime_type,'version',version,'adapter_version',adapter_version,
        'result',result,'summary',summary,'started_at',started_at,'finished_at',finished_at)),'[]')::text
      FROM runtime_qualifications;`),
    rows(`SELECT COALESCE(jsonb_agg(jsonb_build_object('runtime',runtime_type,'windows',windows,'read_at',read_at)),'[]')::text
      FROM (SELECT DISTINCT ON (runtime_type) runtime_type, windows, read_at FROM provider_usage_readings
            ORDER BY runtime_type, read_at DESC) latest;`),
  ]);
  return { versions, qualifications, usage };
}

const say = (error) => String(error?.message ?? error).slice(0, 900);

export async function runRuntimeUpdates({ apply, reporter, stdout, activeVersions, qualify, promote, db = queryJson, close = closePool }) {
  try {
    // 1. The panel's request.
    const request = apply ? await db("SELECT claim_runtime_update_request()::text;", {}) : null;
    if (request?.id) {
      const actor = String(request.requested_by ?? "panel");
      reporter.step(`${request.kind} ${request.runtime} ${request.version}, requested from the panel by ${actor}`);
      try {
        if (request.kind === "qualify") {
          const outcome = await qualify({ name: request.runtime, version: request.version, actor });
          await db("SELECT finish_runtime_update_request(:'id'::uuid,:'ok'::boolean,:'message')::text;", {
            id: request.id, ok: String(outcome.result === "passed"),
            message: `${outcome.result}${outcome.summary ? ` — ${outcome.summary}` : ""}`,
          });
        } else {
          try {
            const outcome = await promote({ name: request.runtime, version: request.version, actor,
              reason: `promoted from the panel by ${actor}` });
            await db("SELECT finish_runtime_update_request(:'id'::uuid,true,:'message')::text;", {
              id: request.id, message: `${outcome.from} → ${outcome.version}; on probation`,
            });
          } catch (error) {
            // Pressed twice: the first press did it, and the second is not a failure.
            if (!/already the active version/.test(String(error?.message ?? ""))) throw error;
            await db("SELECT finish_runtime_update_request(:'id'::uuid,true,:'message')::text;", {
              id: request.id, message: `${request.version} is already active`,
            });
          }
        }
      } catch (error) {
        if (error instanceof LockError) {
          await db("SELECT defer_runtime_update_request(:'id'::uuid)::text;", { id: request.id });
          reporter.step(`the host is busy with another operation; ${request.kind} is tried again on the next pass`);
        } else {
          await db("SELECT finish_runtime_update_request(:'id'::uuid,false,:'message')::text;", { id: request.id, message: say(error) });
          reporter.step(`${request.kind} ${request.runtime} ${request.version} failed: ${say(error)}`);
        }
      }
      return;
    }

    // 2. A newer version nobody has qualified.
    const active = activeVersions();
    const known = new Set(runtimeNames());
    const adapterVersions = Object.fromEntries(Object.keys(active).filter((name) => known.has(name))
      .map((name) => [name, driverFor(name).verified.adapterVersion]));
    const state = await readState(db);
    const next = nextQualification({ active: Object.fromEntries(Object.entries(active).filter(([name]) => known.has(name))),
      adapterVersions, ...state });
    for (const wait of next.skipped) reporter.step(`${wait.runtime} ${wait.version} waits: ${wait.why}`);
    if (!next.runtime) {
      if (!next.skipped.length) stdout.write("infra-cod runtime: nothing to qualify\n");
      return;
    }
    if (!apply) {
      stdout.write(`infra-cod runtime: would qualify ${next.runtime} ${next.version}\n`);
      return;
    }
    reporter.step(`qualifying ${next.runtime} ${next.version} on its own: newer than ${active[next.runtime]}, not qualified yet`);
    try {
      await qualify({ name: next.runtime, version: next.version, actor: "auto-qualify" });
    } catch (error) {
      if (error instanceof LockError) reporter.step("the host is busy with another operation; qualifying waits for the next pass");
      else reporter.step(`qualifying ${next.runtime} ${next.version} stopped: ${say(error)}`);
    }
  } finally {
    await close();
  }
}
