import assert from "node:assert/strict";
import test from "node:test";
import {
  ARGON2_HASH_BYTES,
  ARGON2_ITERATIONS,
  ARGON2_MEMORY_KIB,
  ARGON2_PARALLELISM,
  ARGON2_SALT_BYTES,
  GENERATED_PASSWORD_LENGTH,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  PasswordPolicyError,
  assertPasswordPolicy,
  constantTimeEqual,
  dummyPasswordHash,
  generatePassword,
  hashPassword,
  needsRehash,
  pepperedDigest,
  sha256Digest,
  verifyPassword,
} from "../password.mjs";

const PEPPER = "unit-test-pepper-7f4c2a9e";
const ORIGINAL_PEPPER = process.env.INFRA_COD_AUTH_PEPPER;

test.beforeEach(() => {
  process.env.INFRA_COD_AUTH_PEPPER = PEPPER;
});

test.after(() => {
  if (ORIGINAL_PEPPER === undefined) delete process.env.INFRA_COD_AUTH_PEPPER;
  else process.env.INFRA_COD_AUTH_PEPPER = ORIGINAL_PEPPER;
});

test("a password verifies against its own hash", async () => {
  const password = "correct horse battery staple";
  const hash = await hashPassword(password);
  assert.match(hash, /^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
  assert.equal(await verifyPassword(password, hash), true);
  // No password is logged, but the hash is also not the password.
  assert.ok(!hash.includes(password));
});

test("a wrong password does not verify", async () => {
  const hash = await hashPassword("correct horse battery staple");
  assert.equal(await verifyPassword("correct horse battery stapl", hash), false);
  assert.equal(await verifyPassword("", hash), false);
  assert.equal(await verifyPassword("CORRECT HORSE BATTERY STAPLE", hash), false);
});

test("the encoded hash carries the documented parameters", async () => {
  const hash = await hashPassword("another long enough password");
  const [, version, memory, iterations, parallelism, salt, digest] =
    /^\$argon2id\$v=(\d+)\$m=(\d+),t=(\d+),p=(\d+)\$([^$]+)\$([^$]+)$/.exec(hash);
  assert.equal(Number(version), 19);
  assert.equal(Number(memory), ARGON2_MEMORY_KIB);
  assert.equal(Number(iterations), ARGON2_ITERATIONS);
  assert.equal(Number(parallelism), ARGON2_PARALLELISM);
  assert.equal(Buffer.from(salt, "base64").length, ARGON2_SALT_BYTES);
  assert.equal(Buffer.from(digest, "base64").length, ARGON2_HASH_BYTES);
});

test("the same password hashes differently every time", async () => {
  const password = "the same password twice";
  const first = await hashPassword(password);
  const second = await hashPassword(password);
  assert.notEqual(first, second);
  assert.equal(await verifyPassword(password, first), true);
  assert.equal(await verifyPassword(password, second), true);
});

test("a damaged hash is rejected without throwing", async () => {
  const hash = await hashPassword("a perfectly good password");
  const damaged = [
    "",
    "not-a-hash",
    "$argon2id$",
    "$argon2i$v=19$m=19456,t=2,p=1$c2FsdHNhbHRzYWx0c2E$aGFzaGhhc2hoYXNoaGFzaA",
    hash.slice(0, -4),
    hash.replace("$argon2id$", "$argon2id$v=99$"),
    `${hash}trailing`,
    hash.replace(/\$([^$]+)$/, "$!!!!"),
  ];
  for (const candidate of damaged) {
    // The assertion is the absence of a throw as much as the false.
    assert.equal(await verifyPassword("a perfectly good password", candidate), false, candidate);
  }
  assert.equal(await verifyPassword("a perfectly good password", undefined), false);
});

test("needsRehash accepts the current parameters and rejects outdated ones", async () => {
  const hash = await hashPassword("a password worth rehashing");
  assert.equal(needsRehash(hash), false);

  assert.equal(needsRehash(hash.replace("m=19456", "m=4096")), true, "weaker memory");
  assert.equal(needsRehash(hash.replace("t=2", "t=1")), true, "fewer iterations");
  assert.equal(needsRehash(hash.replace("p=1", "p=4")), true, "different parallelism");
  assert.equal(needsRehash(hash.replace("v=19", "v=16")), true, "older version");
  assert.equal(needsRehash("$argon2i$v=19$m=19456,t=2,p=1$c2FsdA$aGFzaA"), true, "wrong algorithm");
  assert.equal(needsRehash("garbage"), true);
  assert.equal(needsRehash(undefined), true);
});

test("a hash made with a different pepper does not verify", async () => {
  const hash = await hashPassword("pepper scoped password");
  process.env.INFRA_COD_AUTH_PEPPER = `${PEPPER}-rotated`;
  assert.equal(await verifyPassword("pepper scoped password", hash), false);
});

test("hashing fails closed when the pepper is missing", async () => {
  delete process.env.INFRA_COD_AUTH_PEPPER;
  await assert.rejects(() => hashPassword("a password with no pepper"), /INFRA_COD_AUTH_PEPPER/);
  const hash = "$argon2id$v=19$m=19456,t=2,p=1$c2FsdHNhbHRzYWx0c2E$aGFzaGhhc2hoYXNoaGFzaA";
  assert.equal(await verifyPassword("whatever the operator typed", hash), false);
});

test("the password policy is enforced when a password is set", () => {
  for (const short of ["", "a", "short", "x".repeat(PASSWORD_MIN_LENGTH - 1)]) {
    assert.throws(() => assertPasswordPolicy(short), PasswordPolicyError);
  }
  assert.doesNotThrow(() => assertPasswordPolicy("x".repeat(PASSWORD_MIN_LENGTH)));
  assert.throws(
    () => assertPasswordPolicy("x".repeat(PASSWORD_MAX_LENGTH + 1)),
    PasswordPolicyError,
  );
});

test("no error message leaks the password or the pepper", async () => {
  const password = "leak-me-please";
  try {
    await hashPassword(password);
    assert.fail("a short password must be refused");
  } catch (error) {
    const rendered = `${error.message}\n${error.stack}\n${JSON.stringify(error)}`;
    assert.ok(!rendered.includes(password), "the password reached the error");
    assert.ok(!rendered.includes(PEPPER), "the pepper reached the error");
  }

  const hash = await hashPassword("a password that will be damaged later");
  try {
    await verifyPassword("leak-me-please", `${hash}corrupt`);
  } catch (error) {
    assert.fail(`a damaged hash must not throw: ${error.message}`);
  }

  // The policy message names the rule, never the value.
  const tooLong = `leak-me-${"x".repeat(PASSWORD_MAX_LENGTH)}`;
  try {
    assertPasswordPolicy(tooLong);
    assert.fail("an over-long password must be refused");
  } catch (error) {
    assert.ok(!error.message.includes(tooLong));
    assert.ok(!error.message.includes(PEPPER));
  }
});

test("generated passwords are long, random and usable", async () => {
  const first = generatePassword();
  const second = generatePassword();
  assert.equal(first.length, GENERATED_PASSWORD_LENGTH);
  assert.ok(first.length >= 24);
  assert.notEqual(first, second);
  assert.doesNotThrow(() => assertPasswordPolicy(first));
  assert.equal(await verifyPassword(first, await hashPassword(first)), true);
  assert.throws(() => generatePassword(8), PasswordPolicyError);
});

test("the dummy hash is a real hash and is computed once", async () => {
  const dummy = await dummyPasswordHash();
  assert.match(dummy, /^\$argon2id\$v=19\$/);
  assert.equal(needsRehash(dummy), false);
  // Nothing verifies against it: it exists only to burn the same time.
  assert.equal(await verifyPassword("", dummy), false);
  assert.equal(await dummyPasswordHash(), dummy);
});

test("peppered digests are keyed, labelled and stable", () => {
  const first = pepperedDigest("ip", "203.0.113.7");
  assert.equal(first.length, 32);
  assert.equal(pepperedDigest("ip", "203.0.113.7").equals(first), true);
  assert.equal(pepperedDigest("ip", "203.0.113.8").equals(first), false);
  // The same string under a different label is a different digest, so an
  // address can never collide with a user agent.
  assert.equal(pepperedDigest("ua", "203.0.113.7").equals(first), false);
  // The digest does not contain the value it fingerprints.
  assert.ok(!first.toString("hex").includes("203"));

  process.env.INFRA_COD_AUTH_PEPPER = `${PEPPER}-rotated`;
  assert.equal(pepperedDigest("ip", "203.0.113.7").equals(first), false);

  delete process.env.INFRA_COD_AUTH_PEPPER;
  assert.throws(() => pepperedDigest("ip", "203.0.113.7"), /INFRA_COD_AUTH_PEPPER/);
});

test("constant-time comparison refuses different lengths and equal values", () => {
  const digest = sha256Digest("a session token");
  assert.equal(digest.length, 32);
  assert.equal(constantTimeEqual(digest, Buffer.from(digest)), true);
  assert.equal(constantTimeEqual(digest, sha256Digest("another session token")), false);
  assert.equal(constantTimeEqual(digest, digest.subarray(0, 16)), false);
  assert.equal(constantTimeEqual(Buffer.alloc(0), Buffer.alloc(0)), false);
  assert.equal(constantTimeEqual("abc", "abc"), true);
  assert.equal(constantTimeEqual("abc", "abd"), false);
});
