// Argon2id password hashing for the self-hosted installation.
//
// The single place where a plaintext password is turned into a stored secret,
// and the single place where the pepper is applied. Both are deliberate: the
// login path, the change-password path and the `infra-cod admin` CLI all reach
// Argon2id through here, so hash and verify can never disagree about how the
// pepper or the encoding is applied.
//
// Parameters are the OWASP-recommended Argon2id profile (19 MiB, t=2, p=1),
// and `needsRehash` exists so raising them later is a one-line change that
// upgrades hashes as operators log in.
//
// Nothing in this module writes to stdout/stderr, and no error message echoes
// the password, the encoded hash or the pepper: an exception on the login path
// ends up in a log or an HTTP response, and a secret must not travel with it.

import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { argon2id, argon2Verify } from "hash-wasm";

export const ARGON2_MEMORY_KIB = 19456;
export const ARGON2_ITERATIONS = 2;
export const ARGON2_PARALLELISM = 1;
export const ARGON2_HASH_BYTES = 32;
export const ARGON2_SALT_BYTES = 16;
export const ARGON2_VERSION = 19;

export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 256;
export const GENERATED_PASSWORD_LENGTH = 32;

const PEPPER_VARIABLE = "INFRA_COD_AUTH_PEPPER";

// Ambiguous glyphs (l, I, O, 0, 1) are left out: a generated password is read
// off a terminal and retyped by a human at least once.
const GENERATED_ALPHABET =
  "abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789-_";

// $argon2id$v=19$m=19456,t=2,p=1$<salt-b64>$<hash-b64>
const ENCODED_ARGON2ID =
  /^\$argon2id\$v=(\d+)\$m=(\d+),t=(\d+),p=(\d+)\$([A-Za-z0-9+/]+={0,2})\$([A-Za-z0-9+/]+={0,2})$/;

export class PasswordPolicyError extends Error {
  constructor(message) {
    super(message);
    this.name = "PasswordPolicyError";
  }
}

// Read per call rather than cached on purpose: the CLI, the tests and the web
// bundle each import this module in a process where the environment is set up
// differently, and a stale cache would silently produce unverifiable hashes.
function authPepper() {
  const value = process.env[PEPPER_VARIABLE];
  if (typeof value !== "string" || value.length === 0) {
    // Fail closed. A hash made without the pepper is not a weaker hash, it is a
    // different one, so continuing would lock every operator out.
    throw new Error(`${PEPPER_VARIABLE} is not configured`);
  }
  return value.normalize("NFKC");
}

function encodedLength(password) {
  return Array.from(password).length;
}

// The policy for a password that is being *set*. Login never calls this: an
// operator retyping a wrong password must reach Argon2id and be rejected, not
// be told by a validator how long a password has to be.
export function assertPasswordPolicy(password) {
  if (typeof password !== "string") {
    throw new PasswordPolicyError("a password must be a string");
  }
  const length = encodedLength(password);
  if (length < PASSWORD_MIN_LENGTH) {
    throw new PasswordPolicyError(
      `a password must be at least ${PASSWORD_MIN_LENGTH} characters`,
    );
  }
  if (length > PASSWORD_MAX_LENGTH) {
    throw new PasswordPolicyError(
      `a password must be at most ${PASSWORD_MAX_LENGTH} characters`,
    );
  }
  return password;
}

export async function hashPassword(password) {
  assertPasswordPolicy(password);
  const encoded = await argon2id({
    password: password.normalize("NFKC"),
    salt: randomBytes(ARGON2_SALT_BYTES),
    secret: authPepper(),
    parallelism: ARGON2_PARALLELISM,
    iterations: ARGON2_ITERATIONS,
    memorySize: ARGON2_MEMORY_KIB,
    hashLength: ARGON2_HASH_BYTES,
    outputType: "encoded",
  });
  if (typeof encoded !== "string" || !encoded.startsWith("$argon2id$")) {
    throw new Error("Argon2id produced an unexpected encoding");
  }
  return encoded;
}

// Returns false for anything that is not a verifiable Argon2id hash, including
// a corrupted one. A damaged row must fail the login, not crash the process.
export async function verifyPassword(password, encodedHash) {
  if (typeof password !== "string" || typeof encodedHash !== "string") return false;
  if (!encodedHash.startsWith("$argon2id$")) return false;
  // Refuse absurd input before it reaches the KDF. Nothing this long can have
  // been set through hashPassword, and hashing it would be free CPU for an
  // attacker.
  if (encodedLength(password) > PASSWORD_MAX_LENGTH) return false;
  try {
    return await argon2Verify({
      password: password.normalize("NFKC"),
      hash: encodedHash,
      secret: authPepper(),
    });
  } catch {
    return false;
  }
}

// True when the stored hash was produced with parameters this deployment no
// longer uses. A malformed hash also needs a rehash: it cannot be verified, so
// the only safe thing to do with it is replace it.
export function needsRehash(encodedHash) {
  if (typeof encodedHash !== "string") return true;
  const match = ENCODED_ARGON2ID.exec(encodedHash);
  if (!match) return true;
  const [, version, memory, iterations, parallelism, salt, hash] = match;
  if (Number(version) !== ARGON2_VERSION) return true;
  if (Number(memory) !== ARGON2_MEMORY_KIB) return true;
  if (Number(iterations) !== ARGON2_ITERATIONS) return true;
  if (Number(parallelism) !== ARGON2_PARALLELISM) return true;
  if (Buffer.from(hash, "base64").length !== ARGON2_HASH_BYTES) return true;
  if (Buffer.from(salt, "base64").length !== ARGON2_SALT_BYTES) return true;
  return false;
}

export function generatePassword(length = GENERATED_PASSWORD_LENGTH) {
  if (!Number.isInteger(length) || length < 24 || length > 128) {
    throw new PasswordPolicyError(
      "a generated password must be between 24 and 128 characters",
    );
  }
  // randomInt is the CSPRNG-backed, rejection-sampled range primitive, so this
  // stays unbiased without hand-rolled modulo masking.
  let password = "";
  for (let index = 0; index < length; index += 1) {
    password += GENERATED_ALPHABET[randomInt(0, GENERATED_ALPHABET.length)];
  }
  return password;
}

// A real Argon2id hash over a value nobody knows, for the unknown-username
// path. Verifying against it costs the same as verifying a real account, which
// is what keeps "no such user" and "wrong password" indistinguishable by time.
let dummyHashPromise = null;

export async function dummyPasswordHash() {
  if (!dummyHashPromise) {
    dummyHashPromise = hashPassword(randomBytes(32).toString("base64url")).catch(
      (error) => {
        dummyHashPromise = null;
        throw error;
      },
    );
  }
  return dummyHashPromise;
}

export function sha256Digest(value) {
  return createHash("sha256").update(value).digest();
}

// One-way, peppered fingerprint for values that are stored only so two of them
// can be compared — client addresses and user agents. Keyed rather than plain
// so the (small, guessable) input space cannot be brute-forced from a database
// dump, and salted by label so an address and a user agent that happen to share
// a string do not share a digest.
export function pepperedDigest(label, value) {
  return createHmac("sha256", authPepper())
    .update(`${label}\u0000${value}`, "utf8")
    .digest();
}

// Session and CSRF digests are compared with this. timingSafeEqual throws on a
// length mismatch, so the length is checked first; that a digest has a known
// length is not a secret.
export function constantTimeEqual(left, right) {
  const a = Buffer.isBuffer(left) ? left : Buffer.from(String(left ?? ""), "utf8");
  const b = Buffer.isBuffer(right) ? right : Buffer.from(String(right ?? ""), "utf8");
  if (a.length === 0 || a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
