#!/usr/bin/env node
// Stages a self-contained runtime tree for the Next.js panel.
//
// `next build` with `output: "standalone"` produces a server that can run with
// nothing but a Node binary — but it deliberately does not produce a *directory*
// that can run as installed. Two things are left out, and one of them only fails
// at request time:
//
//   * `public/` and `.next/static` are not copied. Without them the server starts,
//     serves HTML, and returns 404 for every asset the HTML references.
//   * the standalone output is nested by `outputFileTracingRoot`, so the entry
//     point is `standalone/apps/web/server.js`, not `standalone/server.js`. A unit
//     written against the flattened layout starts nothing.
//
// So this script builds, lays the three pieces out relative to the server that
// needs them, records what it produced, and refuses to hand back a tree it could
// not vouch for. It is not a release artifact: no tarball, no signature, no
// version switch. It exists so a test can start exactly what production starts.
//
// Usage:
//   node scripts/stage-standalone.mjs [--out <dir>] [--skip-build] [--quiet]
//
// The tree is written to `<out>/web`, so `<out>/web/server.js` is the entrypoint
// only when the trace root is the app directory itself. The receipt records the
// path that was actually found, and it is the receipt that callers should read.

import { cpSync, existsSync, lstatSync, mkdirSync, readlinkSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { prepareStagingDirectory } from "./lib/staging-directory.mjs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const appDirectory = path.join(root, "apps/web");

function parseArguments(argv) {
  const options = { out: process.env.INFRA_COD_STAGE_DIR ?? path.join(os.tmpdir(), `infra-cod-stage-${process.pid}`), skipBuild: false, quiet: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--out") options.out = path.resolve(argv[++index]);
    else if (argument === "--skip-build") options.skipBuild = true;
    else if (argument === "--quiet") options.quiet = true;
    else if (argument === "--help" || argument === "-h") {
      process.stdout.write("usage: node scripts/stage-standalone.mjs [--out <dir>] [--skip-build] [--quiet]\n");
      process.exit(0);
    } else throw new Error(`unknown argument: ${argument}`);
  }
  return options;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", cwd: root, ...options });
  if (result.error) throw new Error(`${command} could not be started: ${result.error.message}`);
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} exited ${result.status}\n${result.stdout ?? ""}${result.stderr ?? ""}`);
  }
  return (result.stdout ?? "").trim();
}

function version(command, args) {
  return run(command, args).split("\n")[0];
}

// Every symlink must resolve inside the tree. A pnpm store link or an absolute
// path escaping to a developer's machine would produce a staged tree that works
// where it was built and nowhere else — the failure that is hardest to attribute
// once it is on a server.
function verifySymlinks(directory, label) {
  const escapes = [];
  let links = 0;

  function walk(current) {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      const info = lstatSync(full);
      if (info.isSymbolicLink()) {
        links += 1;
        const target = path.resolve(path.dirname(full), readlinkSync(full));
        if (target !== directory && !target.startsWith(directory + path.sep)) {
          escapes.push(`${path.relative(directory, full)} -> ${target}`);
        }
        continue;
      }
      if (info.isDirectory()) walk(full);
    }
  }

  walk(directory);
  if (escapes.length) {
    throw new Error(
      `${label} contains ${escapes.length} symlink(s) pointing outside the staged tree:\n  `
      + escapes.slice(0, 10).join("\n  "),
    );
  }
  return links;
}

// Copies the traced tree, preserving its symlinks verbatim.
//
// The obvious alternative — `cpSync(..., { dereference: true })`, replacing every
// link with the real directory it names — produces a tree that looks tidier and
// does not start. The standalone output is a pnpm layout, and pnpm's resolution
// depends on the links staying links: `apps/web/node_modules/next` points into
// `node_modules/.pnpm/<next>/...`, and from inside that directory Node reaches
// Next's transitive dependencies through `node_modules/.pnpm/node_modules/@swc`,
// which is itself a link. Flattening the first link changes the path the second
// one is resolved against, so the server dies on its second `require` with a
// missing module that is plainly present in the tree.
//
// `verbatimSymlinks` keeps each link's text exactly as it was, so a link that
// resolved inside the build directory resolves the same way here. The result is
// checked: every link must point inside the staged tree, which is what makes the
// tree relocatable, and the checkout's own links are never consulted.
function copyTracedTree(source, destination, report) {
  const info = lstatSync(source);
  if (info.isSymbolicLink()) {
    report.links += 1;
    const target = readlinkSync(source);
    let inside;
    try {
      inside = existsSync(path.resolve(path.dirname(source), target));
    } catch {
      inside = false;
    }
    if (!inside) report.dangling.push(path.relative(source, target));
    // Recreated rather than copied: `cpSync` on a link to a directory wants
    // `recursive`, and dereferences once it has it — which is the flattening
    // this function exists to avoid. Writing the link is exact and cheap.
    rmSync(destination, { recursive: true, force: true });
    symlinkSync(target, destination);
    return;
  }
  if (info.isDirectory()) {
    mkdirSync(destination, { recursive: true });
    for (const entry of readdirSync(source)) {
      if (isEnvironmentFile(entry)) continue;
      copyTracedTree(path.join(source, entry), path.join(destination, entry), report);
    }
    return;
  }
  cpSync(source, destination);
}

function countFiles(directory) {
  let files = 0;
  let bytes = 0;
  const stack = [directory];
  while (stack.length) {
    const current = stack.pop();
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      const info = lstatSync(full);
      if (info.isSymbolicLink()) { files += 1; continue; }
      if (info.isDirectory()) stack.push(full);
      else { files += 1; bytes += info.size; }
    }
  }
  return { files, bytes };
}

function findEntrypoint(staging) {
  // The trace root decides the nesting, so the entry point is discovered rather
  // than assumed: `server.js` at the top only when the trace was rooted at
  // `apps/web`. The shallowest match is the app's server; deeper ones are Next's
  // own internal files inside `node_modules`.
  const candidates = [];
  const stack = [staging];
  while (stack.length) {
    const current = stack.pop();
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules") continue;
        stack.push(full);
      } else if (entry.name === "server.js" && !full.includes(`${path.sep}node_modules${path.sep}`)) {
        candidates.push(full);
      }
    }
  }
  candidates.sort((left, right) => left.split(path.sep).length - right.split(path.sep).length);
  if (!candidates.length) throw new Error("the standalone output contains no server.js outside node_modules");
  return candidates[0];
}

function main() {
  const options = parseArguments(process.argv.slice(2));
  const log = options.quiet ? () => {} : (message) => process.stdout.write(`${message}\n`);

  const gitSha = run("git", ["rev-parse", "HEAD"]);
  const gitDirty = run("git", ["status", "--porcelain"]).length > 0;
  const nodeVersion = process.version;
  const nextVersion = JSON.parse(readFileSync(path.join(appDirectory, "node_modules/next/package.json"), "utf8")).version;

  if (!options.skipBuild) {
    log(`building apps/web with ${nodeVersion} / next ${nextVersion}...`);
    run("pnpm", ["--dir", "apps/web", "build"]);
  }

  const buildDirectory = path.join(appDirectory, ".next");
  const standalone = path.join(buildDirectory, "standalone");
  const staticDirectory = path.join(buildDirectory, "static");
  const publicDirectory = path.join(appDirectory, "public");
  for (const required of [standalone, staticDirectory]) {
    if (!existsSync(required)) {
      throw new Error(`${path.relative(root, required)} is missing; run without --skip-build`);
    }
  }

  // A new directory every time. Staging into the previous one would leave files
  // from an older build behind, so a removed dependency or renamed asset would
  // keep working in the staged tree and fail only on a clean install.
  const staging = prepareStagingDirectory(options.out, { repositoryRoot: root, appDirectory });
  const webRoot = path.join(staging, "web");
  mkdirSync(webRoot, { recursive: true });

  // The standalone output, materialised. `cpSync(..., { dereference: true })`
  // would be the one-liner, but the traced tree contains links that are already
  // dangling inside it — pnpm's phantom-dependency placeholders — and Node's
  // implementation stats the link target and throws on those. The walk below
  // resolves each link to whatever real file it names, copies dangling ones as
  // nothing, and records the count so the receipt does not hide them.
  const materialised = { links: 0, dangling: [] };
  copyTracedTree(standalone, webRoot, materialised);

  // The two directories Next leaves out. They belong beside the `.next` the server
  // reads, which is where the entry point was traced to — so both are placed
  // relative to the entry point's own app directory, not to the tree root.
  const entrypoint = findEntrypoint(webRoot);
  const appRoot = path.dirname(entrypoint);
  cpSync(staticDirectory, path.join(appRoot, ".next/static"), { recursive: true });
  if (existsSync(publicDirectory)) {
    cpSync(publicDirectory, path.join(appRoot, "public"), { recursive: true });
  }

  const links = verifySymlinks(webRoot, "the staged tree");
  const counts = countFiles(webRoot);

  const receipt = {
    schema: "infra-cod/web-standalone-receipt/1",
    createdAt: new Date().toISOString(),
    git: { sha: gitSha, dirty: gitDirty },
    runtime: { node: nodeVersion, next: nextVersion, platform: `${process.platform}/${process.arch}` },
    build: {
      traceRoot: root,
      output: "standalone",
      copied: ["standalone", ".next/static", "public"],
    },
    layout: {
      staging,
      web: webRoot,
      relativeEntrypoint: path.relative(webRoot, entrypoint),
      entrypoint,
      staticDirectory: path.join(appRoot, ".next/static"),
      publicDirectory: existsSync(path.join(appRoot, "public")) ? path.join(appRoot, "public") : null,
    },
    contents: {
      files: counts.files,
      bytes: counts.bytes,
      // Links preserved from the traced output, and the ones that were already
      // dangling inside it. The first is expected (it is the pnpm layout); the
      // second is recorded so a change in what pnpm emits is visible rather than
      // silent, and the smoke test fails if it is not zero.
      preservedLinks: materialised.links,
      internalLinks: links,
      danglingLinks: materialised.dangling.length,
    },
  };

  const receiptPath = path.join(staging, "receipt.json");
  writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);

  log(`staged ${counts.files} files (${(counts.bytes / 1024 / 1024).toFixed(1)} MiB) at ${staging}`);
  log(`entrypoint: ${path.relative(staging, entrypoint)}`);
  if (gitDirty) log("warning: the working tree is dirty; the receipt records the commit, not the diff");
  process.stdout.write(`${JSON.stringify(receipt)}\n`);
}

function isEnvironmentFile(source) {
  const name = path.basename(source);
  return name === ".env" || name.startsWith(".env.") || name.endsWith(".pem");
}

main();
