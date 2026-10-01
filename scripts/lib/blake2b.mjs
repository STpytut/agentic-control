// BLAKE2b-256, for the one place a release needs it: the checksum inside an
// unencrypted minisign secret key file.
//
// Node's `crypto` exposes BLAKE2b only at its native 512-bit output —
// `createHash("blake2b256")` is not a supported digest, and `blake2b512` with
// `outputLength` is rejected because OpenSSL's BLAKE2b is not marked as an XOF.
// minisign's key checksum is `crypto_generichash_BYTES` = 32, so a key file
// written by `minisign -G -W` cannot be validated with the built-in hash.
//
// The alternatives were worse. Requiring the `minisign` binary to read a key file
// would make the release job depend on a package that Stage 10 does not install,
// and skipping the checksum would mean a truncated key file produces a wrong
// signature on an artifact that then fails verification on a production host.
//
// So the compression function is implemented here. It is the RFC 7693
// construction, unkeyed, with `outlen = 32`; the constants and rotations are the
// published ones. Correctness is not argued, it is tested: `test:release` checks
// the empty-input digest and the single-block `abc` digest from the BLAKE2
// specification, plus hashes at the block-size boundary where the multi-block
// path is exercised.

import { createHash } from "node:crypto";

const BLOCK_BYTES = 128;
const OUT_BYTES = 32;

// The BLAKE2b initialisation vector: the first 64 bits of the fractional parts of
// the square roots of the first eight primes.
const IV = new BigUint64Array([
  0x6a09e667f3bcc908n, 0xbb67ae8584caa73bn, 0x3c6ef372fe94f82bn, 0xa54ff53a5f1d36f1n,
  0x510e527fade682d1n, 0x9b05688c2b3e6c1fn, 0x1f83d9abfb41bd6bn, 0x5be0cd19137e2179n,
]);

// The message schedule permutations, from the sigma table in RFC 7693.
const SIGMA = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
  [14, 10, 4, 8, 9, 15, 13, 6, 1, 12, 0, 2, 11, 7, 5, 3],
  [11, 8, 12, 0, 5, 2, 15, 13, 10, 14, 3, 6, 7, 1, 9, 4],
  [7, 9, 3, 1, 13, 12, 11, 14, 2, 6, 5, 10, 4, 0, 15, 8],
  [9, 0, 5, 7, 2, 4, 10, 15, 14, 1, 11, 12, 6, 8, 3, 13],
  [2, 12, 6, 10, 0, 11, 8, 3, 4, 13, 7, 5, 15, 14, 1, 9],
  [12, 5, 1, 15, 14, 13, 4, 10, 0, 7, 6, 3, 9, 2, 8, 11],
  [13, 11, 7, 14, 12, 1, 3, 9, 5, 0, 15, 4, 8, 6, 2, 10],
  [6, 15, 14, 9, 11, 3, 0, 8, 12, 2, 13, 7, 1, 4, 10, 5],
  [10, 2, 8, 4, 7, 6, 1, 5, 15, 11, 9, 14, 3, 12, 13, 0],
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
  [14, 10, 4, 8, 9, 15, 13, 6, 1, 12, 0, 2, 11, 7, 5, 3],
];

const MASK = 0xffffffffffffffffn;

function rotr(value, bits) {
  return ((value >> BigInt(bits)) | (value << BigInt(64 - bits))) & MASK;
}

function mix(state, a, b, c, d, x, y) {
  state[a] = (state[a] + state[b] + x) & MASK;
  state[d] = rotr(state[d] ^ state[a], 32);
  state[c] = (state[c] + state[d]) & MASK;
  state[b] = rotr(state[b] ^ state[c], 24);
  state[a] = (state[a] + state[b] + y) & MASK;
  state[d] = rotr(state[d] ^ state[a], 16);
  state[c] = (state[c] + state[d]) & MASK;
  state[b] = rotr(state[b] ^ state[c], 63);
}

function compress(state, block, counter, final) {
  const message = new BigUint64Array(16);
  for (let index = 0; index < 16; index += 1) {
    message[index] = block.readBigUInt64LE(index * 8);
  }

  const work = new BigUint64Array(16);
  for (let index = 0; index < 8; index += 1) work[index] = state[index];
  for (let index = 0; index < 8; index += 1) work[index + 8] = IV[index];
  work[12] ^= counter & MASK;
  work[13] ^= (counter >> 64n) & MASK;
  if (final) work[14] ^= MASK;

  for (let round = 0; round < 12; round += 1) {
    const sigma = SIGMA[round];
    mix(work, 0, 4, 8, 12, message[sigma[0]], message[sigma[1]]);
    mix(work, 1, 5, 9, 13, message[sigma[2]], message[sigma[3]]);
    mix(work, 2, 6, 10, 14, message[sigma[4]], message[sigma[5]]);
    mix(work, 3, 7, 11, 15, message[sigma[6]], message[sigma[7]]);
    mix(work, 0, 5, 10, 15, message[sigma[8]], message[sigma[9]]);
    mix(work, 1, 6, 11, 12, message[sigma[10]], message[sigma[11]]);
    mix(work, 2, 7, 8, 13, message[sigma[12]], message[sigma[13]]);
    mix(work, 3, 4, 9, 14, message[sigma[14]], message[sigma[15]]);
  }

  for (let index = 0; index < 8; index += 1) {
    state[index] ^= work[index] ^ work[index + 8];
  }
}

// Incremental hasher with the same call shape as `crypto.createHash`, so a caller
// can hash a file in chunks instead of loading it.
export class Blake2b {
  constructor(outBytes = OUT_BYTES) {
    if (!Number.isInteger(outBytes) || outBytes < 1 || outBytes > 64) {
      throw new Error(`BLAKE2b output length must be 1..64, got ${outBytes}`);
    }
    this.outBytes = outBytes;
    this.state = new BigUint64Array(IV);
    // The output length is folded into the parameter block, which BLAKE2 does by
    // XORing the low byte of h[0]. Without it the result would be BLAKE2b-512
    // truncated, which is a different function.
    this.state[0] ^= BigInt(0x01010000 ^ outBytes);
    this.buffer = Buffer.alloc(BLOCK_BYTES);
    this.bufferLength = 0;
    this.counter = 0n;
  }

  update(chunk) {
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    let offset = 0;
    while (offset < data.length) {
      // A full buffer is only compressed when more input follows, so the final
      // block is always the one compressed with the `final` flag set.
      if (this.bufferLength === BLOCK_BYTES) {
        this.counter += BigInt(BLOCK_BYTES);
        compress(this.state, this.buffer, this.counter, false);
        this.bufferLength = 0;
      }
      const take = Math.min(BLOCK_BYTES - this.bufferLength, data.length - offset);
      data.copy(this.buffer, this.bufferLength, offset, offset + take);
      this.bufferLength += take;
      offset += take;
    }
    return this;
  }

  digest() {
    this.counter += BigInt(this.bufferLength);
    this.buffer.fill(0, this.bufferLength);
    compress(this.state, this.buffer, this.counter, true);
    const out = Buffer.alloc(this.outBytes);
    for (let index = 0; index < Math.ceil(this.outBytes / 8); index += 1) {
      const chunk = Buffer.alloc(8);
      chunk.writeBigUInt64LE(this.state[index]);
      chunk.copy(out, index * 8, 0, Math.min(8, this.outBytes - index * 8));
    }
    return out;
  }
}

export function blake2b256(data) {
  return new Blake2b(OUT_BYTES).update(data).digest();
}

// The cross-check the test suite uses. Where OpenSSL can produce the same value,
// agreeing with it is stronger evidence than any vector typed into a test file;
// where it cannot (256-bit output), the test falls back to the published vectors.
export function blake2b512(data) {
  return createHash("blake2b512").update(data).digest();
}
