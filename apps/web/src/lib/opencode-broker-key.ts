// Where the OpenCode broker's RSA public key comes from.
//
// Two spellings, because the two producers cannot both use the same one:
//
//   OPENCODE_BROKER_PUBLIC_KEY       the PEM itself, for a hand-written .env
//   OPENCODE_BROKER_PUBLIC_KEY_PATH  a file holding the PEM
//
// The installer writes the `_PATH` form and cannot write the other: a PEM is
// multi-line, and a systemd `EnvironmentFile` has no way to express a value that
// spans lines. Supporting only the inline spelling is what left an installed
// system serving 503 from every OpenCode enrolment route while the key sat on
// disk beside it.
//
// The inline value wins when both are set, so an operator debugging a broken
// installation can override the file without moving it.

import { readFileSync } from "node:fs";

export type BrokerKeyResult =
  | { publicKey: string; source: "inline" | "file" }
  | { publicKey: null; reason: string };

let cached: { publicKey: string; source: "inline" | "file" } | null = null;

export function readBrokerPublicKey(): BrokerKeyResult {
  if (cached) return cached;

  const inline = process.env.OPENCODE_BROKER_PUBLIC_KEY?.trim();
  if (inline) {
    cached = { publicKey: inline, source: "inline" };
    return cached;
  }

  const file = process.env.OPENCODE_BROKER_PUBLIC_KEY_PATH?.trim();
  if (!file) {
    return { publicKey: null, reason: "neither OPENCODE_BROKER_PUBLIC_KEY nor OPENCODE_BROKER_PUBLIC_KEY_PATH is set" };
  }

  let text: string;
  try {
    text = readFileSync(file, "utf8").trim();
  } catch (error) {
    // The path is named but the read failed: a missing file, or a mode the panel
    // user cannot read. Both are configuration faults and both must be visible.
    return { publicKey: null, reason: `cannot read OPENCODE_BROKER_PUBLIC_KEY_PATH (${(error as NodeJS.ErrnoException).code ?? "unknown"})` };
  }
  if (!text) {
    return { publicKey: null, reason: "OPENCODE_BROKER_PUBLIC_KEY_PATH names an empty file" };
  }
  if (!text.includes("-----BEGIN PUBLIC KEY-----")) {
    return { publicKey: null, reason: "OPENCODE_BROKER_PUBLIC_KEY_PATH does not contain a PEM public key" };
  }

  cached = { publicKey: text, source: "file" };
  return cached;
}

// Test seam. The value is cached because it is read on every enrolment request
// and never changes while the process lives; a rotation is a restart.
export function resetBrokerPublicKeyCache() {
  cached = null;
}
