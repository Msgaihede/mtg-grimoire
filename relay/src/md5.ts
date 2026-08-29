/**
 * MD5 and HMAC-MD5, written out by hand, because the one caller that needs them cannot get
 * them any other way.
 *
 * **Why a hash algorithm is transcribed into this repository at all.** Patreon signs every
 * webhook with `X-Patreon-Signature`, and that header is the hex digest of the request body
 * HMAC-signed with **MD5**. There is no negotiating it: the signature is computed on Patreon's
 * side and the relay's only job is to arrive at the same sixteen bytes, or reject the request.
 *
 * Two routes that look obvious are both closed. Workers exposes MD5 as a documented
 * non-standard extension of `crypto.subtle.digest("MD5", ...)` — but `crypto.subtle`'s HMAC
 * does *not* list MD5 among its hashes, so `importKey`/`sign` cannot be handed the one
 * algorithm this needs, and a bare hash does not verify a signature. Reaching for Node's
 * `createHash("md5")` in the test is closed for a different reason: `tsconfig.relay.json` pins
 * `"types": ["@cloudflare/workers-types"]` and `@types/node` is banned repo-wide, so
 * `node:crypto` does not type-check in this program and never will.
 *
 * What is left is RFC 1321 transcribed, which type-checks in the relay's own program and runs
 * unchanged in vitest and in workerd. The part that makes that safe is the test file: a
 * hand-written hash whose only witness is its own output is worthless, so this one is pinned
 * to RFC 1321 appendix A.5 and RFC 2202 section 2 to the digit. It is either right, or broken
 * in a way those published vectors would have caught.
 *
 * **No secret is inferred from the presence of this file.** MD5 is Patreon's choice, not ours,
 * and it is used here only to check that a body arrived unmodified from a party holding the
 * shared webhook secret. Nothing in this repository hashes a password, an id or a group key
 * with it.
 */

/** Per-round shift amounts, RFC 1321 section 3.4. */
const S = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14,
  20, 5, 9, 14, 20, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10, 15, 21, 6,
  10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
];

/**
 * The 64 round constants, **transcribed from RFC 1321's published table** rather than computed.
 *
 * They are *defined* as `K[i] = floor(2^32 * abs(sin(i + 1)))`, and one line of `Array.from` with
 * `Math.sin` reproduces them — under V8. That is the problem. ECMAScript deliberately does not
 * pin `Math.sin`: it is permitted to return an implementation-approximated result, so the values
 * a computed table holds are a fact about the engine, not about MD5. vitest runs this file in
 * Node and the relay ships it to workerd; both are V8 today, so both would agree today, and
 * **nothing in the suite would notice if they ever stopped.**
 *
 * The cost of being wrong here is what settles it. A single low-bit difference in one constant
 * changes every digest, so every Patreon webhook signature would fail to verify — at once, with
 * no bad input to point at, on the one path in this design where failing open would delete a
 * reader's data. Sixty-four literals are cheap; a hash whose constants depend on a transcendental
 * function's rounding is not.
 *
 * The RFC 1321 and RFC 2202 vectors in `md5.test.ts` are what proves the transcription: a typo in
 * this table changes the digest of every message, so a table with a wrong digit cannot produce a
 * green suite.
 */
const K = [
  0xd76aa478, 0xe8c7b756, 0x242070db, 0xc1bdceee, 0xf57c0faf, 0x4787c62a, 0xa8304613, 0xfd469501,
  0x698098d8, 0x8b44f7af, 0xffff5bb1, 0x895cd7be, 0x6b901122, 0xfd987193, 0xa679438e, 0x49b40821,
  0xf61e2562, 0xc040b340, 0x265e5a51, 0xe9b6c7aa, 0xd62f105d, 0x02441453, 0xd8a1e681, 0xe7d3fbc8,
  0x21e1cde6, 0xc33707d6, 0xf4d50d87, 0x455a14ed, 0xa9e3e905, 0xfcefa3f8, 0x676f02d9, 0x8d2a4c8a,
  0xfffa3942, 0x8771f681, 0x6d9d6122, 0xfde5380c, 0xa4beea44, 0x4bdecfa9, 0xf6bb4b60, 0xbebfbc70,
  0x289b7ec6, 0xeaa127fa, 0xd4ef3085, 0x04881d05, 0xd9d4d039, 0xe6db99e5, 0x1fa27cf8, 0xc4ac5665,
  0xf4292244, 0x432aff97, 0xab9423a7, 0xfc93a039, 0x655b59c3, 0x8f0ccc92, 0xffeff47d, 0x85845dd1,
  0x6fa87e4f, 0xfe2ce6e0, 0xa3014314, 0x4e0811a1, 0xf7537e82, 0xbd3af235, 0x2ad7d2bb, 0xeb86d391,
];

/** MD5's block, in bytes. HMAC pads to a block too, which is why the constant is shared. */
const BLOCK = 64;

/** MD5's digest, in bytes. */
const DIGEST = 16;

/**
 * Where the length field starts inside the final block: the last eight bytes, so the padded
 * message has to land on a block boundary with exactly that much room left over.
 */
const LENGTH_FIELD_AT = BLOCK - 8;

/**
 * Rotate left, forced back into unsigned 32-bit range.
 *
 * JavaScript's bitwise operators produce *signed* 32-bit values, so a rotation whose high bit
 * ends up set comes back negative. Every arithmetic step below ends in `>>> 0` for that reason.
 */
function rotl(x: number, s: number): number {
  return ((x << s) | (x >>> (32 - s))) >>> 0;
}

/**
 * The digest of `data`, as sixteen bytes.
 *
 * **Everything here is little-endian** — the message words read out of each block, the length
 * field, and the digest written back at the end. MD5's word order is the opposite of SHA's,
 * and transcribing it the SHA way produces a hash that looks entirely plausible and matches
 * nothing.
 */
export function md5(data: Uint8Array): Uint8Array {
  // Padding: `0x80`, then zeros until eight bytes remain in the block, then the bit length.
  // The extra `+ BLOCK) % BLOCK` is not decoration — a message that already runs past the
  // length field needs a whole further block, and without it the count goes negative and the
  // buffer comes out short. A 55-byte message pads inside one block and a 56-byte message
  // needs a second one; that pair is what the boundary test holds.
  const withTerminator = data.length + 1;
  const zeros = (((LENGTH_FIELD_AT - (withTerminator % BLOCK)) % BLOCK) + BLOCK) % BLOCK;
  const padded = new Uint8Array(withTerminator + zeros + 8);
  padded.set(data);
  padded[data.length] = 0x80;

  const view = new DataView(padded.buffer, padded.byteOffset, padded.byteLength);
  // Written as two 32-bit halves rather than one 64-bit value. A body large enough to overflow
  // the low half is not a body this relay would accept, but the high half costs one line and
  // getting it wrong would be silent.
  const bits = data.length * 8;
  view.setUint32(padded.length - 8, bits >>> 0, true);
  view.setUint32(padded.length - 4, Math.floor(bits / 2 ** 32), true);

  let a0 = 0x67452301;
  let b0 = 0xefcdab89;
  let c0 = 0x98badcfe;
  let d0 = 0x10325476;

  for (let offset = 0; offset < padded.length; offset += BLOCK) {
    const m = new Array<number>(16);
    for (let i = 0; i < 16; i += 1) m[i] = view.getUint32(offset + i * 4, true);

    let a = a0;
    let b = b0;
    let c = c0;
    let d = d0;

    for (let i = 0; i < 64; i += 1) {
      let f: number;
      let g: number;
      if (i < 16) {
        f = (b & c) | (~b & d);
        g = i;
      } else if (i < 32) {
        f = (d & b) | (~d & c);
        g = (5 * i + 1) % 16;
      } else if (i < 48) {
        f = b ^ c ^ d;
        g = (3 * i + 5) % 16;
      } else {
        f = c ^ (b | ~d);
        g = (7 * i) % 16;
      }

      // Each of the four addends is below 2^32, so the sum is below 2^34 and still an exact
      // double; `>>> 0` is what brings it back to the 32-bit word MD5 is defined over.
      const sum = (a + f + K[i] + m[g]) >>> 0;
      const previousD = d;
      d = c;
      c = b;
      b = (b + rotl(sum, S[i])) >>> 0;
      a = previousD;
    }

    a0 = (a0 + a) >>> 0;
    b0 = (b0 + b) >>> 0;
    c0 = (c0 + c) >>> 0;
    d0 = (d0 + d) >>> 0;
  }

  const out = new Uint8Array(DIGEST);
  const outView = new DataView(out.buffer);
  outView.setUint32(0, a0, true);
  outView.setUint32(4, b0, true);
  outView.setUint32(8, c0, true);
  outView.setUint32(12, d0, true);
  return out;
}

/** Lowercase hex, which is the form Patreon's header arrives in. */
export function hex(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return out;
}

/**
 * `HMAC-MD5(key, message)`, RFC 2104, as sixteen bytes.
 *
 * **A key longer than the block is hashed first**, and that branch is the one worth naming:
 * every short-key vector passes with it missing, so an implementation that skips it stays
 * green until the day the webhook secret is rotated to something over 64 bytes and every
 * signature quietly stops verifying. RFC 2202 case 6 is in the suite precisely to hold it.
 */
export function hmacMd5(key: Uint8Array, message: Uint8Array): Uint8Array {
  const block = new Uint8Array(BLOCK);
  block.set(key.length > BLOCK ? md5(key) : key);

  const inner = new Uint8Array(BLOCK + message.length);
  const outer = new Uint8Array(BLOCK + DIGEST);
  for (let i = 0; i < BLOCK; i += 1) {
    inner[i] = block[i] ^ 0x36;
    outer[i] = block[i] ^ 0x5c;
  }
  inner.set(message, BLOCK);
  outer.set(md5(inner), BLOCK);
  return md5(outer);
}

/**
 * Whether two hex digests are the same, compared across their whole length.
 *
 * **The loop does not stop at the first mismatch**, which is the entire point. A comparison
 * that returns early answers in a time proportional to how many leading characters the caller
 * guessed right, and a caller who can measure that can walk a forged signature into existence
 * one character at a time. Accumulating the XOR across every position costs the same whether
 * the first character matched or the last.
 *
 * Two honest limits. The length check *does* return early, deliberately: a digest's length is
 * fixed and public, so it leaks nothing an attacker did not already know. And JavaScript
 * strings guarantee constant time for nothing — this is the shape of a constant-time compare,
 * held as far as the language allows, rather than a proof.
 *
 * Case-insensitive because hex is: `AB` and `ab` are the same byte, and a peer that sends
 * uppercase is not sending a wrong signature.
 */
export function timingSafeEqualHex(a: string, b: string): boolean {
  const left = a.toLowerCase();
  const right = b.toLowerCase();
  if (left.length !== right.length) return false;

  let diff = 0;
  for (let i = 0; i < left.length; i += 1) diff |= left.charCodeAt(i) ^ right.charCodeAt(i);
  return diff === 0;
}
