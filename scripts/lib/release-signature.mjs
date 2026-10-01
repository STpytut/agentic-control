// Detached signatures in the minisign format, implemented without minisign.
//
// The trust root for a release is a pinned public key, and the artifact carries a
// detached signature over `SHA256SUMS`. `minisign` is the right tool for a human
// doing this by hand, but a release script may not *require* it:
//
//   * the pre-install verifier has to run on a host where nothing but Node has
//     been installed yet (Stage 10 installs Node; it does not install minisign),
//     and it must not be able to fall back to a verifier fetched from the same
//     place as the artifact it is checking;
//   * a negative test has to be able to produce a signature over a deliberately
//     corrupted archive in a temporary directory, and generating an ephemeral key
//     through an external binary would make the test depend on that binary;
//   * the crypto here is Ed25519 and BLAKE2b, both of which Node's `crypto`
//     provides, and the container formats are a few dozen bytes of
//     well-documented layout. There is no primitive being invented here.
//
// Compatibility is with minisign 0.11/0.12 as published by jedisct1. The layout
// implemented below is:
//
//   public key      2 sig_alg "Ed" | 8 keynum | 32 ed25519 public key          = 42
//   signature       2 sig_alg "ED" | 8 keynum | 64 ed25519 signature           = 74
//   secret key      2 "Ed" | 2 kdf_alg | 2 "B2" | 32 salt | 8 ops | 8 mem
//                   | 8 keynum | 64 ed25519 secret key | 32 checksum         = 158
//
// The 158-byte size and the offset of every field below are taken from a
// `sizeof(SeckeyStruct)` and `offsetof` probe compiled against minisign 0.12's own
// header and libsodium, not from reading the struct by eye: salt is 32 bytes at
// offset 6, the limits are 8 bytes each at 38 and 46, keynum is at 54, the secret
// key at 62, and the checksum at 126.
//
// A signature file is four lines: an untrusted comment, the base64 `SigStruct`,
// a trusted comment, and a base64 signature over `SigStruct.sig || trusted
// comment`. `verify` checks all three of the things minisign checks — the key id,
// the message signature and the comment signature — because the comment is what a
// human reads when deciding whether to install, so leaving it unsigned would make
// the readable part of the artifact the only unauthenticated part.
//
// Only unencrypted secret keys (`kdf_alg` = 0x00 0x00, produced by `minisign -G -W`)
// are supported. An encrypted key would need scrypt from libsodium; refusing it
// with a clear message is better than half-implementing it, and the release job
// holds the key in a secret store rather than typing a password.

import { createHash, createPrivateKey, createPublicKey, randomBytes, sign as edSign, verify as edVerify } from "node:crypto";
import { blake2b256 } from "./blake2b.mjs";
import { parseVersion } from "./release-version.mjs";

export const MINISIGN_PUBLIC_KEY_BYTES = 42;
export const MINISIGN_SIGNATURE_BYTES = 74;
// sizeof(SeckeyStruct) from minisign.h:
//   2 sig_alg + 2 kdf_alg + 2 chk_alg + 32 kdf_salt + 8 kdf_opslimit_le
//   + 8 kdf_memlimit_le + 8 keynum + 64 sk + 32 chk  =  158
export const MINISIGN_SECRET_KEY_BYTES = 158;
// Everything before the trailing blake2b checksum.
export const MINISIGN_SECRET_KEY_MATERIAL_BYTES = 126;
// Where the 32-byte checksum begins.
export const MINISIGN_SECRET_KEY_CHECKSUM_OFFSET = 126;
export const MINISIGN_KEYNUM_BYTES = 8;
export const MINISIGN_SIGNATURE_LENGTH = 64;

const SIGALG = "Ed";
const SIGALG_HASHED = "ED";
const CHKALG = "B2";
const KDFNONE = "\0\0";
const COMMENT_PREFIX = "untrusted comment: ";
const TRUSTED_COMMENT_PREFIX = "trusted comment: ";
const DEFAULT_COMMENT = "signature from minisign secret key";

// A fixed DER prefix for an Ed25519 PKCS#8 private key. Node's `crypto` does not
// accept a raw 32-byte Ed25519 seed, so the seed is wrapped; the prefix is
// constant because the algorithm identifier and the 32-byte length are.
// libsodium's scrypt salt size, and the width of each little-endian KDF limit.
// Both are part of the minisign container format, not tuning parameters.
const SALT_BYTES = 32;
const KDF_LIMIT_BYTES = 8;

const PKCS8_ED25519_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
// The same for a SubjectPublicKeyInfo public key.
const SPKI_ED25519_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

// The checksum minisign computes for a secret key.
//
// `seckey_compute_chk` hashes exactly three fields, with no length prefix and no
// tag:
//
//   crypto_generichash_update(&hs, seckey_struct->sig_alg, 2);
//   crypto_generichash_update(&hs, seckey_struct->keynum_sk.keynum, 8);
//   crypto_generichash_update(&hs, seckey_struct->keynum_sk.sk, 64);
//
// That is 74 bytes, read from offsets 0, 54 and 62 in the 158-byte struct. It is
// *not* the 126-byte prefix.
//
// Two facts about this checksum are easy to get wrong, and the first version of
// this module got both wrong. Both were found by running the real binary, not by
// reading the source:
//
//   1. The byte ranges. Hashing the 126-byte prefix includes `kdf_alg`, `chk_alg`,
//      the salt and both KDF limits, which minisign excludes.
//   2. When it applies. `seckey_compute_chk` is called from `encrypt_key` and from
//      `decrypt_key` — the encrypted path — and nowhere else. For an unencrypted
//      key (`kdf_alg` = KDFNONE, what `minisign -G -W` writes), `seckey_load`
//      skips the check entirely and the checksum field is **32 zero bytes** in
//      every real key file. Verifying it on that path rejects every genuine
//      unencrypted key.
//
// The measured consequence: a key from `minisign -G -W`, which is the key this
// project tells the owner to create, was refused with "checksum does not match".
// The release job would have failed at signing time on the host, with the
// production key, after the artifact was built.
//
// `interop.test.mjs` runs a real `minisign` binary in both directions and is what
// keeps this honest.
const CHECKSUM_FIELD_OFFSETS = [
  [0, 2], // sig_alg
  [54, 62], // keynum: 2 sig_alg + 2 kdf_alg + 2 chk_alg + 32 salt + 8 + 8
  [62, 126], // sk, 64 bytes
];

function secretKeyChecksum(struct) {
  return blake2b256(Buffer.concat(CHECKSUM_FIELD_OFFSETS.map(([from, to]) => struct.subarray(from, to))));
}

// The trusted comment a release signature carries.
//
// The comment is signed, and it is the part a human reads when deciding whether to
// install, so it has to name the release exactly. The builder's first attempt
// recovered the version from the tarball's *filename* with a greedy regex, which
// turned `infra-cod-0.1.0-linux-x64.tar.gz` into `0.1.0-linux-x64`; the second
// attempt guarded against that with a heuristic that rejected any version containing
// `-linux-` or `-darwin-`.
//
// The heuristic was wrong, and it was wrong in the direction that breaks a release:
// `0.1.0-linux-x64` is a perfectly valid SemVer prerelease, so the guard would have
// refused to sign a legitimate version. It is also unnecessary now that the builder
// passes the validated version directly. What is checked here is that the value is a
// SemVer at all — the same contract the rest of the release path uses — and then it is
// signed verbatim.
export function releasedTrustedComment(version) {
  if (typeof version !== "string" || version.length === 0) {
    throw new SignatureError("a release trusted comment needs a version");
  }
  parseVersion(version);
  return `infra-cod release ${version}`;
}

export class SignatureError extends Error {
  constructor(message) {
    super(message);
    this.name = "SignatureError";
  }
}

function b64encode(buffer) {
  return buffer.toString("base64");
}

function b64decode(text, expectedBytes, label) {
  const trimmed = text.trim();
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(trimmed)) {
    throw new SignatureError(`${label} is not valid base64: ${JSON.stringify(trimmed.slice(0, 24))}`);
  }
  const buffer = Buffer.from(trimmed, "base64");
  if (expectedBytes !== undefined && buffer.length !== expectedBytes) {
    throw new SignatureError(`${label} decodes to ${buffer.length} bytes, expected ${expectedBytes}`);
  }
  return buffer;
}

// The key id. minisign stores it as eight little-endian bytes and prints it as a
// big-endian hex integer, which is why the display order is reversed.
export function keyIdOf(keynum) {
  return Buffer.from(keynum).reverse().toString("hex").toUpperCase();
}

// ---------------------------------------------------------------------------
// Key material
// ---------------------------------------------------------------------------

// Builds a key pair from a 32-byte Ed25519 seed. The seed is the only secret
// input, so a caller that wants a reproducible *test* key passes a fixed one and
// a caller that wants a real key passes random bytes.
export function keyPairFromSeed(seed, keynum) {
  if (!Buffer.isBuffer(seed) || seed.length !== 32) {
    throw new SignatureError("an Ed25519 seed must be exactly 32 bytes");
  }
  // The key id is a stable label, not a security boundary: minisign generates it
  // randomly and prints it so a human can tell two keys apart. Deriving it from
  // the seed instead of drawing fresh randomness is what lets a test key be
  // reproducible, and it is still unpredictable to anyone who does not hold the
  // seed - which is everyone, because the seed never leaves the secret store.
  const idBytes = keynum ?? blake2b256(Buffer.concat([Buffer.from("infra-cod-minisign-keyid"), seed])).subarray(0, MINISIGN_KEYNUM_BYTES);
  if (!Buffer.isBuffer(idBytes) || idBytes.length !== MINISIGN_KEYNUM_BYTES) {
    throw new SignatureError("a minisign key id must be exactly 8 bytes");
  }

  const privateKey = createPrivateKey({
    key: Buffer.concat([PKCS8_ED25519_PREFIX, seed]),
    format: "der",
    type: "pkcs8",
  });
  const publicKeyDer = createPublicKey(privateKey).export({ format: "der", type: "spki" });
  const publicKey = publicKeyDer.subarray(publicKeyDer.length - 32);
  const secretKey = Buffer.concat([seed, publicKey]);

  const publicKeyStruct = Buffer.concat([
    Buffer.from(SIGALG, "latin1"),
    idBytes,
    publicKey,
  ]);
  // Constants from libsodium: crypto_pwhash_scryptsalsa208sha256_SALTBYTES = 32,
  // crypto_sign_SECRETKEYBYTES = 64, crypto_generichash_BYTES = 32, KEYNUMBYTES = 8.
  const secretKeyStruct = Buffer.concat([
    Buffer.from(SIGALG, "latin1"), // sig_alg                 2
    Buffer.from(KDFNONE, "latin1"), // kdf_alg                 2  (0x00 0x00: no KDF)
    Buffer.from(CHKALG, "latin1"), // chk_alg                  2
    Buffer.alloc(SALT_BYTES), // kdf_salt                    32
    Buffer.alloc(KDF_LIMIT_BYTES), // kdf_opslimit_le           8
    Buffer.alloc(KDF_LIMIT_BYTES), // kdf_memlimit_le           8
    idBytes, // keynum                                       8
    secretKey, // sk                                         64
  ]); //                                                        94 bytes of key material
  if (secretKeyStruct.length !== MINISIGN_SECRET_KEY_MATERIAL_BYTES) {
    throw new SignatureError(`internal: secret key material is ${secretKeyStruct.length} bytes`);
  }
  // The checksum field of an unencrypted key is 32 zero bytes. `minisign -G -W`
  // writes zeros and `seckey_load` never verifies them on the KDFNONE path, so a
  // key file this module writes must carry zeros too or the two implementations
  // produce different bytes for the same key. An *encrypted* key carries a real
  // checksum, which is why the field exists; this project does not write one.
  const secretKeyStructWithChecksum = Buffer.concat([secretKeyStruct, Buffer.alloc(32)]);
  if (secretKeyStructWithChecksum.length !== MINISIGN_SECRET_KEY_BYTES) {
    throw new SignatureError(
      `internal: secret key struct is ${secretKeyStructWithChecksum.length} bytes, expected ${MINISIGN_SECRET_KEY_BYTES}`,
    );
  }

  return {
    keyId: keyIdOf(idBytes),
    publicKeyStruct,
    secretKeyStruct: secretKeyStructWithChecksum,
    privateKey,
    publicKey,
  };
}

// A fresh key pair. Random by construction: a release signing key must never be
// derived from anything a reader of this file can predict.
export function generateKeyPair() {
  return keyPairFromSeed(randomBytes(32));
}

// The text of a `.pub` file. `minisign -G` writes a comment naming the key id;
// reproducing that makes the committed public key indistinguishable from one the
// tool produced.
export function renderPublicKeyFile(pair) {
  return `${COMMENT_PREFIX}minisign public key ${pair.keyId}\n${b64encode(pair.publicKeyStruct)}\n`;
}

export function renderSecretKeyFile(pair) {
  return `${COMMENT_PREFIX}minisign encrypted secret key\n${b64encode(pair.secretKeyStruct)}\n`;
}

// A raw 42-byte public key. The builder holds one of these after generation; the
// verifier holds the text of the committed file. Both have to reach the same
// `{ keyId, keynum, publicKey }` shape, so both go through a check.
export function parsePublicKeyStruct(struct) {
  if (!Buffer.isBuffer(struct) || struct.length !== MINISIGN_PUBLIC_KEY_BYTES) {
    throw new SignatureError(`a minisign public key must be ${MINISIGN_PUBLIC_KEY_BYTES} bytes`);
  }
  if (struct.subarray(0, 2).toString("latin1") !== SIGALG) {
    throw new SignatureError("public key does not use the Ed algorithm");
  }
  return {
    keyId: keyIdOf(struct.subarray(2, 10)),
    keynum: struct.subarray(2, 10),
    publicKey: struct.subarray(10, 42),
    struct,
  };
}

export function parsePublicKeyFile(text) {
  const lines = text.split("\n");
  if (lines.length < 2) throw new SignatureError("public key file has fewer than two lines");
  if (!lines[0].startsWith(COMMENT_PREFIX)) {
    throw new SignatureError(`public key comment must start with ${JSON.stringify(COMMENT_PREFIX)}`);
  }
  return parsePublicKeyStruct(b64decode(lines[1], MINISIGN_PUBLIC_KEY_BYTES, "public key"));
}

// Accepts either the text of a `.pub` file, a raw 42-byte struct, or an already
// parsed key, so a caller cannot accidentally pass bytes where text is expected
// and get a silently wrong key id.
export function asPublicKey(value) {
  if (Buffer.isBuffer(value)) return parsePublicKeyStruct(value);
  if (typeof value === "string") return parsePublicKeyFile(value);
  if (value && Buffer.isBuffer(value.publicKeyStruct)) return parsePublicKeyStruct(value.publicKeyStruct);
  if (value && Buffer.isBuffer(value.publicKey) && Buffer.isBuffer(value.keynum)) return value;
  throw new SignatureError("expected a public key file, a 42-byte public key struct, or a parsed public key");
}

export function parseSecretKeyFile(text) {
  const lines = text.split("\n");
  if (lines.length < 2) throw new SignatureError("secret key file has fewer than two lines");
  const struct = b64decode(lines[1], MINISIGN_SECRET_KEY_BYTES, "secret key");
  if (struct.subarray(0, 2).toString("latin1") !== SIGALG) {
    throw new SignatureError("secret key does not use the Ed algorithm");
  }
  if (struct.subarray(2, 4).toString("latin1") !== KDFNONE) {
    throw new SignatureError(
      "this secret key is encrypted; release signing uses an unencrypted key held in a secret store "
        + "(generate it with `minisign -G -W`)",
    );
  }
  if (struct.subarray(4, 6).toString("latin1") !== CHKALG) {
    throw new SignatureError("secret key does not use the B2 checksum algorithm");
  }
  // An unencrypted key carries 32 zero bytes here and minisign never looks at
  // them, so neither does this. Checking them would refuse every real
  // `minisign -G -W` key, which is the only kind this project uses.
  const encrypted = !struct.subarray(2, 4).equals(Buffer.from(KDFNONE, "latin1"));
  if (encrypted) {
    const declared = struct.subarray(MINISIGN_SECRET_KEY_CHECKSUM_OFFSET);
    if (!declared.equals(secretKeyChecksum(struct))) {
      throw new SignatureError(
        "the encrypted secret key's checksum does not match; the file is corrupt or was truncated",
      );
    }
  }
  // sig_alg(2) + kdf_alg(2) + chk_alg(2) + salt(32) + two 8-byte limits = 54.
  const keynum = struct.subarray(54, 62);
  const secretKey = struct.subarray(62, 126);
  return {
    keyId: keyIdOf(keynum),
    keynum,
    privateKey: createPrivateKey({
      key: Buffer.concat([PKCS8_ED25519_PREFIX, secretKey.subarray(0, 32)]),
      format: "der",
      type: "pkcs8",
    }),
  };
}

// ---------------------------------------------------------------------------
// Signing and verification
// ---------------------------------------------------------------------------

// The prehashed form: minisign hashes the message with BLAKE2b-512 and signs the
// digest. Prehashing is not optional here — minisign refuses a legacy,
// non-prehashed signature by default (`-H`), and a large archive is exactly the
// case the prehashed format exists for.
function messageDigest(data) {
  return createHash("blake2b512").update(data).digest();
}

export function signDetached(data, secret) {
  const digest = messageDigest(data);
  const signature = edSign(null, digest, secret.privateKey);
  const struct = Buffer.concat([
    Buffer.from(SIGALG_HASHED, "latin1"),
    secret.keynum,
    signature,
  ]);
  if (struct.length !== MINISIGN_SIGNATURE_BYTES) {
    throw new SignatureError(`internal: signature struct is ${struct.length} bytes`);
  }
  return { struct, signature, digest };
}

export function renderSignatureFile({ struct, signature, trustedComment, comment = DEFAULT_COMMENT }) {
  if (/[\r\n]/.test(trustedComment) || /[\r\n]/.test(comment)) {
    throw new SignatureError("signature comments may not contain a newline");
  }
  return [
    `${COMMENT_PREFIX}${comment}`,
    b64encode(struct),
    `${TRUSTED_COMMENT_PREFIX}${trustedComment}`,
    "",
  ].join("\n");
}

// The trusted comment's own signature: over `signature || trusted comment` bytes,
// with no prehashing. This is what stops someone editing the comment to say
// something more reassuring than the truth.
export function signTrustedComment(signature, trustedComment, privateKey) {
  return edSign(null, Buffer.concat([signature, Buffer.from(trustedComment, "utf8")]), privateKey);
}

export function createSignatureFile(data, secret, { trustedComment, comment, publicKey }) {
  const { struct, signature } = signDetached(data, secret);
  const commentSignature = signTrustedComment(signature, trustedComment, secret.privateKey);
  const text = [
    `${COMMENT_PREFIX}${comment ?? DEFAULT_COMMENT}`,
    b64encode(struct),
    `${TRUSTED_COMMENT_PREFIX}${trustedComment}`,
    b64encode(commentSignature),
    "",
  ].join("\n");

  if (publicKey !== undefined) {
    const parsed = asPublicKey(publicKey);
    if (parsed.keyId !== secret.keyId) {
      throw new SignatureError(
        `the secret key (${secret.keyId}) does not match the public key (${parsed.keyId}); `
          + "signing with it would produce an artifact no verifier accepts",
      );
    }
  }
  return text;
}

// Verifies a signature file against data and a pinned public key.
//
// Returns `{ trustedComment }` on success and throws otherwise, naming which of
// the three checks failed. `expectedKeyId` is optional and, when given, is checked
// before the signature so that "signed by the wrong key" and "signature does not
// verify" are distinguishable in a release log.
export function verifySignature(data, signatureText, publicKeyText, { expectedKeyId } = {}) {
  const publicKey = asPublicKey(publicKeyText);
  if (expectedKeyId && publicKey.keyId !== expectedKeyId) {
    throw new SignatureError(`pinned public key id is ${publicKey.keyId}, expected ${expectedKeyId}`);
  }

  const lines = signatureText.split("\n").filter((line) => line.length > 0);
  if (lines.length !== 4) {
    throw new SignatureError(`signature file must have four lines, found ${lines.length}`);
  }
  if (!lines[0].startsWith(COMMENT_PREFIX)) {
    throw new SignatureError(`signature comment must start with ${JSON.stringify(COMMENT_PREFIX)}`);
  }
  if (!lines[2].startsWith(TRUSTED_COMMENT_PREFIX)) {
    throw new SignatureError(`trusted comment must start with ${JSON.stringify(TRUSTED_COMMENT_PREFIX)}`);
  }
  const trustedComment = lines[2].slice(TRUSTED_COMMENT_PREFIX.length);

  const struct = b64decode(lines[1], MINISIGN_SIGNATURE_BYTES, "signature");
  const algorithm = struct.subarray(0, 2).toString("latin1");
  if (algorithm !== SIGALG_HASHED) {
    throw new SignatureError(
      algorithm === SIGALG
        ? "the signature is in the legacy non-prehashed format, which release verification refuses"
        : `unsupported signature algorithm ${JSON.stringify(algorithm)}`,
    );
  }
  const keynum = struct.subarray(2, 10);
  const signature = struct.subarray(10, 74);
  const commentSignature = b64decode(lines[3], MINISIGN_SIGNATURE_LENGTH, "trusted comment signature");

  if (!keynum.equals(publicKey.keynum)) {
    throw new SignatureError(
      `signature key id is ${keyIdOf(keynum)} but the pinned public key id is ${publicKey.keyId}`,
    );
  }

  // The Ed25519 public key is rebuilt from the pinned bytes; the signature file
  // contributes nothing to the key, which is the whole point of pinning it.
  const publicKeyObject = createPublicKey({
    key: Buffer.concat([SPKI_ED25519_PREFIX, publicKey.publicKey]),
    format: "der",
    type: "spki",
  });

  if (!edVerify(null, messageDigest(data), publicKeyObject, signature)) {
    throw new SignatureError("signature does not verify against the pinned public key");
  }
  if (!edVerify(null, Buffer.concat([signature, Buffer.from(trustedComment, "utf8")]), publicKeyObject, commentSignature)) {
    throw new SignatureError("the trusted comment signature does not verify; the comment was modified");
  }

  return { trustedComment, keyId: publicKey.keyId };
}
