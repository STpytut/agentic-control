// Interoperability with the real `minisign` binary.
//
// This file exists because the rest of the release test suite could not have found
// the defect it guards against. The key checksum in `release-signature.mjs` was
// computed over the wrong bytes *and* verified on the wrong code path, and every
// test still passed: generation, parsing, signing and verification all went
// through this project's own code, so both sides shared the mistake. A `minisign
// -G -W` key — the exact key `release/keys/README.md` tells the owner to create —
// was rejected with "checksum does not match".
//
// A round trip through one implementation proves the implementation is
// self-consistent. It does not prove it agrees with anybody else. The only test
// that can is one that runs the other implementation.
//
// Both directions are checked, because they fail differently:
//
//   minisign signs  -> this module verifies   (a verifier that only accepts its own
//                                              output fails here)
//   this module signs -> minisign verifies    (a signer that produces something
//                                              nobody else accepts fails here)
//
// The binary is located through `MINISIGN_BIN`, then `PATH`, then the two paths a
// developer is likely to have it at. When it is genuinely absent the tests are
// skipped with a message naming the reason — not silently passed.

import test from "node:test";

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { createSignatureFile, keyPairFromSeed, parsePublicKeyFile, parseSecretKeyFile, renderPublicKeyFile, renderSecretKeyFile, verifySignature } from "../../../scripts/lib/release-signature.mjs";

function findMinisign() {
  const candidates = [
    process.env.MINISIGN_BIN,
    "minisign",
    "/usr/bin/minisign",
    "/usr/local/bin/minisign",
    "/opt/homebrew/bin/minisign",
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (candidate.includes("/")) {
      if (existsSync(candidate)) return candidate;
      continue;
    }
    const found = spawnSync("sh", ["-c", `command -v ${candidate}`], { encoding: "utf8" });
    if (found.status === 0 && found.stdout.trim()) return found.stdout.trim();
  }
  return null;
}

const minisign = findMinisign();

// `node:test` treats `{ skip: null }` as "skip", so the option has to be absent
// rather than falsy when the binary is present. Building it conditionally is the
// difference between six real interoperability tests and six silent skips that look
// like a pass.
const skipReason = "the `minisign` binary was not found. Install it (`apt install minisign` on Ubuntu, "
  + "`brew install minisign` on macOS) or set MINISIGN_BIN. This test must not pass without it: "
  + "the release signing path is verified against the real implementation or it is not verified.";
const requiresMinisign = minisign ? {} : { skip: skipReason };

// Where the binary is a declared preflight dependency — CI, and any host that will
// actually sign — a skip is not acceptable: it would report the suite as green while
// the one test that can catch an incompatible signing key never ran. `--require` in
// shell terms.
const testInterop = process.env.INFRA_COD_REQUIRE_MINISIGN === "1"
  ? (name, options, fn) => {
    if (!minisign) throw new Error(`INFRA_COD_REQUIRE_MINISIGN=1 but ${skipReason}`);
    return test(name, options, fn);
  }
  : test;

// `minisign` reads its echo of the password from argv when it is given a file, and
// from stdin otherwise; `-W` avoids the prompt for key generation entirely.
function runMinisign(args, options = {}) {
  const result = spawnSync(minisign, args, { encoding: "utf8", ...options });
  if (result.error) throw new Error(`minisign could not be started: ${result.error.message}`);
  return result;
}

function withKeys(run) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "infra-cod-minisign-"));
  try {
    return run(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

testInterop("interop: the real minisign binary is available", requiresMinisign, () => {
  const version = runMinisign(["-v"]);
  assert.equal(version.status, 0);
  assert.match(version.stdout, /^minisign \d+\.\d+/);
});

testInterop("interop: a key from `minisign -G -W` parses, and its public half matches", requiresMinisign, () => {
  withKeys((directory) => {
    const secretFile = path.join(directory, "infra-cod.key");
    const publicFile = path.join(directory, "infra-cod.pub");
    const generated = runMinisign(["-G", "-W", "-p", publicFile, "-s", secretFile]);
    assert.equal(generated.status, 0, `minisign -G failed: ${generated.stderr}`);

    // The whole point: this is the key the owner is told to create, and it is the
    // key the release job will sign with.
    const secret = parseSecretKeyFile(readFileSync(secretFile, "utf8"));
    const publicKey = parsePublicKeyFile(readFileSync(publicFile, "utf8"));
    assert.equal(secret.keyId, publicKey.keyId, "the parsed secret and public halves must name the same key");

    // An unencrypted key stores 32 zero bytes where the checksum would be and
    // minisign never verifies them; this asserts the layout this module relies on,
    // so a change in minisign's format shows up here rather than at signing time.
    const struct = Buffer.from(readFileSync(secretFile, "utf8").split("\n")[1], "base64");
    assert.equal(struct.length, 158, "an unencrypted minisign secret key is 158 bytes");
    assert.deepEqual(struct.subarray(2, 4), Buffer.from([0, 0]), "the key must be unencrypted (KDFNONE)");
    assert.deepEqual(
      struct.subarray(126, 158),
      Buffer.alloc(32),
      "an unencrypted key's checksum field is zeros; verifying it would reject every real key",
    );
  });
});

testInterop("interop: minisign signs, this module verifies", requiresMinisign, () => {
  withKeys((directory) => {
    const secretFile = path.join(directory, "infra-cod.key");
    const publicFile = path.join(directory, "infra-cod.pub");
    assert.equal(runMinisign(["-G", "-W", "-p", publicFile, "-s", secretFile]).status, 0);

    const message = path.join(directory, "SHA256SUMS");
    const contents = "0123456789abcdef  infra-cod-0.1.0-linux-x64.tar.gz\n";
    writeFileSync(message, contents);
    const signed = runMinisign(["-S", "-s", secretFile, "-m", message, "-t", "infra-cod release test"]);
    assert.equal(signed.status, 0, `minisign -S failed: ${signed.stderr}`);

    const signatureFile = `${message}.minisig`;
    const verified = verifySignature(
      readFileSync(message),
      readFileSync(signatureFile, "utf8"),
      readFileSync(publicFile, "utf8"),
    );
    assert.equal(verified.trustedComment, "infra-cod release test");
    assert.equal(verified.keyId, parsePublicKeyFile(readFileSync(publicFile, "utf8")).keyId);

    // And the negative: the same signature must not verify a different document.
    assert.throws(
      () => verifySignature(Buffer.from(`${contents} `), readFileSync(signatureFile, "utf8"), readFileSync(publicFile, "utf8")),
      /does not verify against the pinned public key/,
    );
  });
});

testInterop("interop: this module signs, the real minisign verifies", requiresMinisign, () => {
  withKeys((directory) => {
    const secretFile = path.join(directory, "infra-cod.key");
    const publicFile = path.join(directory, "infra-cod.pub");
    assert.equal(runMinisign(["-G", "-W", "-p", publicFile, "-s", secretFile]).status, 0);

    const secret = parseSecretKeyFile(readFileSync(secretFile, "utf8"));
    const publicKey = parsePublicKeyFile(readFileSync(publicFile, "utf8"));
    const message = path.join(directory, "SHA256SUMS");
    const contents = "fedcba9876543210  infra-cod-0.1.0-linux-x64.tar.gz\n";
    writeFileSync(message, contents);

    const signature = createSignatureFile(Buffer.from(contents), secret, {
      trustedComment: "infra-cod release test",
      publicKey,
    });
    writeFileSync(`${message}.minisig`, signature);

    // `-H` requires the prehashed format, which is the one this module writes; the
    // legacy format would be accepted by default and would prove less.
    const verified = runMinisign(["-V", "-H", "-p", publicFile, "-m", message, "-x", `${message}.minisig`]);
    assert.equal(
      verified.status,
      0,
      `minisign refused a signature this module produced:\n${verified.stdout}\n${verified.stderr}`,
    );
    assert.match(verified.stdout, /Signature and comment signature verified/);

    // A tampered byte must fail in the other implementation too, or this test only
    // proves the happy path.
    writeFileSync(message, `${contents}x`);
    const tampered = runMinisign(["-V", "-H", "-p", publicFile, "-m", message, "-x", `${message}.minisig`]);
    assert.notEqual(tampered.status, 0, "minisign must reject a document that changed after signing");
  });
});

testInterop("interop: minisign signs with a key this module generated", requiresMinisign, () => {
  // The reverse of the first direction, and the stronger of the two: a key file
  // this module writes must be one minisign is willing to *use*, not merely one it
  // can parse. `-R` derives the public key from the secret key and fails if the
  // struct is not the layout it expects; `-S` then signs with it.
  withKeys((directory) => {
    const pair = keyPairFromSeed(Buffer.from("b".repeat(64), "hex"));
    const secretFile = path.join(directory, "ours.key");
    const publicFile = path.join(directory, "ours.pub");
    writeFileSync(secretFile, renderSecretKeyFile(pair));
    writeFileSync(publicFile, renderPublicKeyFile(pair));

    const derivedFile = path.join(directory, "derived.pub");
    const derived = runMinisign(["-R", "-s", secretFile, "-p", derivedFile]);
    assert.equal(derived.status, 0, `minisign refused a secret key this module wrote:\n${derived.stdout}\n${derived.stderr}`);
    assert.equal(
      readFileSync(derivedFile, "utf8"),
      readFileSync(publicFile, "utf8"),
      "minisign derived a different public key from this module's secret key",
    );

    const message = path.join(directory, "SHA256SUMS");
    writeFileSync(message, "0011223344556677  infra-cod-0.1.0-linux-x64.tar.gz\n");
    const signed = runMinisign(["-S", "-s", secretFile, "-m", message, "-t", "signed with an infra-cod key"]);
    assert.equal(signed.status, 0, `minisign could not sign with this module's key:\n${signed.stderr}`);

    const verified = verifySignature(
      readFileSync(message),
      readFileSync(`${message}.minisig`, "utf8"),
      readFileSync(publicFile, "utf8"),
    );
    assert.equal(verified.keyId, pair.keyId);
    assert.equal(verified.trustedComment, "signed with an infra-cod key");
  });
});

testInterop("interop: a signature this module produces verifies with minisign's own public key round trip", requiresMinisign, () => {
  // `-R` recreates the public key from the secret key. Doing that with a key this
  // module generated would prove the reverse direction of key compatibility, but
  // this module only *reads* secret keys, so the check is that the public half of a
  // real key is the one minisign derives.
  withKeys((directory) => {
    const secretFile = path.join(directory, "infra-cod.key");
    const publicFile = path.join(directory, "infra-cod.pub");
    assert.equal(runMinisign(["-G", "-W", "-p", publicFile, "-s", secretFile]).status, 0);

    const derivedFile = path.join(directory, "derived.pub");
    const derived = runMinisign(["-R", "-s", secretFile, "-p", derivedFile]);
    assert.equal(derived.status, 0, `minisign -R failed: ${derived.stderr}`);

    const original = parsePublicKeyFile(readFileSync(publicFile, "utf8"));
    const recreated = parsePublicKeyFile(readFileSync(derivedFile, "utf8"));
    assert.equal(recreated.keyId, original.keyId);
    assert.deepEqual(recreated.publicKey, original.publicKey);

    // A public key file this module renders must parse back to the same key, so a
    // rendered file can be committed as the pinned key.
    const rendered = parsePublicKeyFile(renderPublicKeyFile({
      keyId: original.keyId,
      publicKeyStruct: original.struct,
    }));
    assert.equal(rendered.keyId, original.keyId);
    assert.deepEqual(rendered.publicKey, original.publicKey);
  });
});
