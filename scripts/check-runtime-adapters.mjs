#!/usr/bin/env node
// Asks the registry whether the adapters describe the packages that exist.
//
// Why this is separate from `test:runtime`: that suite serves its own registry on
// loopback and builds its own tarballs, so every layout it tests is a layout it
// chose. It proved the installer handles a package correctly and could not have
// told us the real Codex package puts its binary somewhere else entirely —
// `package/vendor/x86_64-unknown-linux-musl/bin/codex`, not `package/bin/codex`.
// The production host found that, after a signed release had been built, signed
// and installed.
//
// So this reaches the real registry, and is therefore not part of the offline
// gate: `scripts/run-suites-in-container.sh` runs with `--network none` on
// purpose. Run it whenever an adapter's coordinates or paths change, and before
// cutting a release that carries such a change:
//
//   node scripts/check-runtime-adapters.mjs codex@0.154.0 opencode@1.18.31
//
// What it checks, per runtime: that the version resolves, that the registry
// answers with the coordinates that were asked for, that the pinned key verifies
// the signature, and that the member the adapter intends to execute is really in
// the archive and really a regular file.
//
// With no arguments it checks the pair each runtime driver was verified at
// (WP-5b): the capability evidence in services/runtime-supervisor/drivers is for
// one exact runtime version, and this is where that version is shown to still
// resolve to the package the adapter describes.
//
//   node scripts/check-runtime-adapters.mjs
//
// It downloads nothing. The member list comes from the tarball, which does have
// to be fetched — 320 MB for Codex — so it is streamed and discarded rather than
// kept.

import { createHash } from "node:crypto";
import { createGunzip } from "node:zlib";
import https from "node:https";

import { adapterFor, runtimeNames } from "../services/operations/runtime-adapters.mjs";
import { allDrivers } from "../services/runtime-supervisor/drivers/index.mjs";
import { pairOf } from "../services/runtime-supervisor/drivers/capabilities.mjs";
import { resolvePackage, verifyRegistrySignature, verifyIntegrity } from "../services/operations/runtime.mjs";

const TAR_BLOCK = 512;

// A minimal tar member listing, from a stream, because the whole point is not to
// keep 320 MB anywhere. Names and types only — this asks a question about the
// archive's shape, not about its contents.
async function listMembers(url) {
  const members = [];
  const hash = createHash("sha512");
  await new Promise((resolve, reject) => {
    const request = https.get(url, (response) => {
      if (response.statusCode === 301 || response.statusCode === 302 || response.statusCode === 307) {
        response.resume();
        listMembers(response.headers.location).then((inner) => {
          members.push(...inner.members);
          resolve();
        }, reject);
        return;
      }
      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error(`${url} answered ${response.statusCode}`));
        return;
      }
      response.on("data", (chunk) => hash.update(chunk));
      const gunzip = createGunzip();
      let pending = Buffer.alloc(0);
      let skip = 0;
      gunzip.on("data", (chunk) => {
        pending = pending.length === 0 ? chunk : Buffer.concat([pending, chunk]);
        while (pending.length >= TAR_BLOCK) {
          if (skip > 0) {
            const drop = Math.min(skip, pending.length);
            pending = pending.subarray(drop);
            skip -= drop;
            continue;
          }
          const header = pending.subarray(0, TAR_BLOCK);
          pending = pending.subarray(TAR_BLOCK);
          const name = header.subarray(0, 100).toString("utf8").replace(/\0.*$/, "");
          if (name.length === 0) continue;
          const sizeField = header.subarray(124, 136).toString("utf8").replace(/\0.*$/, "").trim();
          const size = Number.parseInt(sizeField, 8) || 0;
          const type = String.fromCharCode(header[156]) || "0";
          const mode = Number.parseInt(header.subarray(100, 108).toString("utf8").replace(/\0.*$/, "").trim(), 8) || 0;
          members.push({ name, type, size, mode });
          skip = Math.ceil(size / TAR_BLOCK) * TAR_BLOCK;
        }
      });
      gunzip.on("end", resolve);
      gunzip.on("error", reject);
      response.pipe(gunzip);
    });
    request.on("error", reject);
  });
  return { members, sha512: hash.digest("base64") };
}

const verifiedPairs = allDrivers().map((driver) => `${driver.name}@${driver.verified.runtimeVersion}`);
const requested = process.argv.slice(2);
if (requested.includes("--help")) {
  process.stderr.write(
    "usage: node scripts/check-runtime-adapters.mjs [<runtime>@<exact version> ...]\n"
    + `  known runtimes: ${runtimeNames().join(", ")}\n`
    + `  with no arguments, the drivers' verified pairs: ${verifiedPairs.join(" ")}\n`,
  );
  process.exit(2);
}
if (requested.length === 0) {
  for (const driver of allDrivers()) process.stdout.write(`checking the verified pair: ${pairOf(driver)}\n`);
  requested.push(...verifiedPairs);
}

let failed = 0;
for (const pair of requested) {
  const at = pair.lastIndexOf("@");
  const name = pair.slice(0, at);
  const version = pair.slice(at + 1);
  try {
    const adapter = adapterFor(name);
    const resolved = await resolvePackage(adapter, version);
    verifyRegistrySignature(resolved);

    const { members, sha512 } = await listMembers(resolved.tarball);
    verifyIntegrity({ sha512 }, resolved.integrity);

    const wanted = members.find((member) => member.name === adapter.executablePath);
    if (!wanted) {
      const candidates = members
        .filter((member) => member.name.includes(`/${adapter.executable}`) && (member.mode & 0o111))
        .map((member) => member.name);
      throw new Error(
        `${resolved.name}@${resolved.version} does not contain ${adapter.executablePath}`
        + (candidates.length ? `; it does contain ${candidates.join(", ")}` : ""),
      );
    }
    if (wanted.type !== "0" && wanted.type !== "\0") {
      throw new Error(`${adapter.executablePath} is not a regular file (tar type ${JSON.stringify(wanted.type)})`);
    }
    if (!(wanted.mode & 0o111)) {
      throw new Error(`${adapter.executablePath} is not executable (mode ${wanted.mode.toString(8)})`);
    }

    process.stdout.write(
      `${name} ${version}: ${resolved.name}@${resolved.version}, signature verified, `
      + `${adapter.executablePath} present (${wanted.size} bytes)\n`,
    );
  } catch (error) {
    failed += 1;
    process.stderr.write(`${name} ${version}: ${error.message}\n`);
  }
}

process.exit(failed === 0 ? 0 : 1);
