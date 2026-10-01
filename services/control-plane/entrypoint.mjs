// "Was this module the program that was started?"
//
// The obvious spelling of that question is wrong on every installed host:
//
//   process.argv[1] === fileURLToPath(import.meta.url)
//
// systemd starts a worker as `/opt/infra-cod/current/services/.../worker.mjs`,
// and `current` is a symlink to the release directory. `process.argv[1]` is the
// path as written, while `import.meta.url` is the path Node resolved — the real
// one, inside `/opt/infra-cod/releases/<version>/`. The two strings never match,
// the guard is false, `main()` never runs, and the process exits 0 having done
// nothing. A `Type=simple` unit that exits 0 is `inactive (success)`, which
// `Restart=on-failure` will not restart and which reads, from the outside, like
// a service that finished its work.
//
// So both sides are canonicalised. `realpathSync` is the only thing that makes
// the comparison mean what it is supposed to mean; `path.resolve` is not enough,
// because it normalises `..` and leaves symlinks alone.
//
// A module that is imported rather than started still answers false: argv[1] is
// then the importing program, whose real path is a different file.

import { realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

function canonical(target) {
  try {
    return realpathSync(target);
  } catch {
    // The entry may not exist as a file at all (`node -e`, a REPL, a deleted
    // script). Resolving is then the closest honest answer, and it simply will
    // not match a module that does exist.
    return path.resolve(target);
  }
}

export function isMain(moduleUrl) {
  const entry = process.argv[1];
  if (!entry) return false;
  return canonical(entry) === canonical(fileURLToPath(moduleUrl));
}
