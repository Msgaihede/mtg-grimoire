/**
 * A QR encoder for one symbol: **version 9 at error-correction level M**, byte mode — the
 * 53×53 the pairing invite is drawn as (`sync_pair::invite::qr_payload`: 162 bytes against the
 * relay's address, measured 2026-08-31; version 8 holds 152 and does not fit).
 *
 * **Why the fake has an encoder at all.** Until 2026-10-04 `sync_pairing_begin` here answered a
 * 21×21 grid of noise with three finder patterns drawn on it — a *picture* of a QR code, said so
 * in as many words, and enough while a story only checked the box around it. Then the panel was
 * driven at a phone's width, where the question is whether a camera can read what is drawn: a
 * 21-module picture stands at 9px a module in a box where the real invite stands at 4.3, so it
 * answered "is this big enough" for a symbol nobody ships, and it could be pointed at no camera
 * at all. With a real symbol the same story is the thing a phone is held up to, and a headless
 * browser's fake camera can be fed the panel's own drawing (`scripts/pairing-scan-smoke.mjs`).
 *
 * **One version, on purpose.** The crate asks its `qrcode` dependency for the smallest symbol
 * that fits and gets version 9 for every invite, because every invite is the same length. A
 * general encoder is the version tables for forty sizes and four levels; this is the one row of
 * them the app draws, and a text that does not fit that row is refused rather than drawn as
 * something else. A shorter text is padded and still drawn at 53.
 *
 * The algorithm is ISO/IEC 18004's, in the order the standard gives it: the bit stream, the
 * Reed–Solomon blocks, the function patterns, the zigzag, the mask with the lowest penalty, and
 * the two format words. `qr.test.ts` decodes what this draws with `jsQR` — the decoder the
 * app's own scanner uses — which is the only check of an encoder worth having.
 */
import type { QrMatrix } from "@grimoire/ui/lib/ipc";

/** Version 9: `17 + 4 × 9` modules a side. */
const VERSION = 9;
const SIZE = 17 + 4 * VERSION;

/** Level M at version 9: three blocks of 36 data codewords and two of 37, 22 of correction each. */
const BLOCKS = [36, 36, 36, 37, 37];
const EC_PER_BLOCK = 22;
const DATA_CODEWORDS = BLOCKS.reduce((sum, n) => sum + n, 0);

/** Byte mode spends four bits on the mode and, below version 10, eight on the length. */
export const QR_CAPACITY_BYTES = DATA_CODEWORDS - 2;

/** Where version 9's alignment patterns are centred, on both axes. */
const ALIGNMENT = [6, 26, 46];

/** Level M's two bits in the format word. */
const LEVEL_M = 0;

/* ------------------------------------------------------------------ Reed–Solomon ------- */

/** A product in GF(2^8) over the QR polynomial `x^8 + x^4 + x^3 + x^2 + 1`. */
function multiply(a: number, b: number): number {
  let product = 0;
  for (let bit = 7; bit >= 0; bit -= 1) {
    product = (product << 1) ^ ((product >>> 7) * 0x11d);
    product ^= ((b >>> bit) & 1) * a;
  }
  return product;
}

/** The generator polynomial of `degree`, highest coefficient dropped (it is always one). */
function generator(degree: number): number[] {
  const out = new Array<number>(degree).fill(0);
  out[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i += 1) {
    for (let j = 0; j < degree; j += 1) {
      out[j] = multiply(out[j], root);
      if (j + 1 < degree) out[j] ^= out[j + 1];
    }
    root = multiply(root, 0x02);
  }
  return out;
}

/** The correction codewords for one block: the remainder of its data over the generator. */
function remainder(data: readonly number[], divisor: readonly number[]): number[] {
  const out = new Array<number>(divisor.length).fill(0);
  for (const byte of data) {
    const factor = byte ^ (out.shift() as number);
    out.push(0);
    divisor.forEach((coefficient, i) => {
      out[i] ^= multiply(coefficient, factor);
    });
  }
  return out;
}

/* ------------------------------------------------------------------ the codewords ------ */

/** The text as the symbol's data codewords: mode, length, bytes, terminator and padding. */
function dataCodewords(bytes: Uint8Array): number[] {
  const bits: number[] = [];
  const push = (value: number, length: number) => {
    for (let i = length - 1; i >= 0; i -= 1) bits.push((value >>> i) & 1);
  };
  push(0b0100, 4);
  push(bytes.length, 8);
  for (const byte of bytes) push(byte, 8);
  const room = DATA_CODEWORDS * 8;
  push(0, Math.min(4, room - bits.length));
  push(0, (8 - (bits.length % 8)) % 8);
  for (let pad = 0xec; bits.length < room; pad ^= 0xec ^ 0x11) push(pad, 8);

  const out: number[] = [];
  for (let i = 0; i < bits.length; i += 8) {
    out.push(bits.slice(i, i + 8).reduce((byte, bit) => (byte << 1) | bit, 0));
  }
  return out;
}

/** Data and correction, interleaved across the blocks in the order the symbol carries them. */
function interleaved(data: readonly number[]): number[] {
  const divisor = generator(EC_PER_BLOCK);
  let at = 0;
  const blocks = BLOCKS.map((length) => {
    const block = data.slice(at, at + length);
    at += length;
    return { data: block, ec: remainder(block, divisor) };
  });
  const out: number[] = [];
  for (let i = 0; i < Math.max(...BLOCKS); i += 1) {
    for (const block of blocks) if (i < block.data.length) out.push(block.data[i]);
  }
  for (let i = 0; i < EC_PER_BLOCK; i += 1) for (const block of blocks) out.push(block.ec[i]);
  return out;
}

/* ------------------------------------------------------------------ the grid ----------- */

/** A symbol being drawn: what is dark, and which modules are patterns rather than data. */
interface Grid {
  dark: boolean[][];
  fixed: boolean[][];
}

function emptyGrid(): Grid {
  const rows = () => Array.from({ length: SIZE }, () => new Array<boolean>(SIZE).fill(false));
  return { dark: rows(), fixed: rows() };
}

/** Draw one function module. Off-grid coordinates are a finder's separator past the edge. */
function fix(grid: Grid, x: number, y: number, dark: boolean): void {
  if (x < 0 || y < 0 || x >= SIZE || y >= SIZE) return;
  grid.dark[y][x] = dark;
  grid.fixed[y][x] = true;
}

/** A 15-bit format word: level and mask, ten bits of BCH, and the standard's mask over it. */
function formatBits(mask: number): number {
  const data = (LEVEL_M << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i += 1) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  return ((data << 10) | rem) ^ 0x5412;
}

/** Both copies of the format word, and the one module that is always dark. */
function drawFormat(grid: Grid, mask: number): void {
  const bits = formatBits(mask);
  const bit = (i: number) => ((bits >>> i) & 1) === 1;
  for (let i = 0; i <= 5; i += 1) fix(grid, 8, i, bit(i));
  fix(grid, 8, 7, bit(6));
  fix(grid, 8, 8, bit(7));
  fix(grid, 7, 8, bit(8));
  for (let i = 9; i < 15; i += 1) fix(grid, 14 - i, 8, bit(i));
  for (let i = 0; i < 8; i += 1) fix(grid, SIZE - 1 - i, 8, bit(i));
  for (let i = 8; i < 15; i += 1) fix(grid, 8, SIZE - 15 + i, bit(i));
  fix(grid, 8, SIZE - 8, true);
}

/** Everything in the symbol that is not data: finders, timing, alignment, format and version. */
function drawFunctionPatterns(grid: Grid): void {
  for (let i = 0; i < SIZE; i += 1) {
    fix(grid, 6, i, i % 2 === 0);
    fix(grid, i, 6, i % 2 === 0);
  }
  // Three finders, each with the light separator a module past its edge.
  for (const [cx, cy] of [
    [3, 3],
    [SIZE - 4, 3],
    [3, SIZE - 4],
  ]) {
    for (let dy = -4; dy <= 4; dy += 1) {
      for (let dx = -4; dx <= 4; dx += 1) {
        const ring = Math.max(Math.abs(dx), Math.abs(dy));
        fix(grid, cx + dx, cy + dy, ring !== 2 && ring !== 4);
      }
    }
  }
  // An alignment pattern at every pair of centres but the three a finder stands on.
  for (const cy of ALIGNMENT) {
    for (const cx of ALIGNMENT) {
      const first = ALIGNMENT[0];
      const last = ALIGNMENT[ALIGNMENT.length - 1];
      const onFinder =
        (cx === first && cy === first) || (cx === first && cy === last) || (cx === last && cy === first);
      if (onFinder) continue;
      for (let dy = -2; dy <= 2; dy += 1) {
        for (let dx = -2; dx <= 2; dx += 1) {
          fix(grid, cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
        }
      }
    }
  }
  // Reserved now with any mask, so the zigzag steps round it; redrawn once a mask is chosen.
  drawFormat(grid, 0);
  // From version 7 a symbol states its own version, twice: eighteen bits beside two finders.
  let rem = VERSION;
  for (let i = 0; i < 12; i += 1) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
  const bits = (VERSION << 12) | rem;
  for (let i = 0; i < 18; i += 1) {
    const dark = ((bits >>> i) & 1) === 1;
    const a = SIZE - 11 + (i % 3);
    const b = Math.floor(i / 3);
    fix(grid, a, b, dark);
    fix(grid, b, a, dark);
  }
}

/** Lay the codewords into every module that is not a pattern: two columns at a time from the
 *  right edge, up and then down, stepping over the vertical timing column. */
function drawCodewords(grid: Grid, codewords: readonly number[]): void {
  let i = 0;
  for (let right = SIZE - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let step = 0; step < SIZE; step += 1) {
      for (let j = 0; j < 2; j += 1) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? SIZE - 1 - step : step;
        if (grid.fixed[y][x] || i >= codewords.length * 8) continue;
        grid.dark[y][x] = ((codewords[i >>> 3] >>> (7 - (i & 7))) & 1) === 1;
        i += 1;
      }
    }
  }
}

/** The eight masks. A data module is flipped where its mask says so. */
const MASKS: readonly ((x: number, y: number) => boolean)[] = [
  (x, y) => (x + y) % 2 === 0,
  (_x, y) => y % 2 === 0,
  (x) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];

/** Flip every data module `mask` names. Applying it twice puts the grid back. */
function applyMask(grid: Grid, mask: number): void {
  for (let y = 0; y < SIZE; y += 1) {
    for (let x = 0; x < SIZE; x += 1) {
      if (!grid.fixed[y][x] && MASKS[mask](x, y)) grid.dark[y][x] = !grid.dark[y][x];
    }
  }
}

/**
 * How hard a masked symbol is to read, by the standard's four rules: long runs of one colour,
 * 2×2 blocks of one colour, anything that looks like a finder, and a dark share far from half.
 */
function penalty(dark: readonly (readonly boolean[])[]): number {
  let score = 0;
  const line = (at: (i: number) => boolean) => {
    let run = 1;
    for (let i = 1; i <= SIZE; i += 1) {
      if (i < SIZE && at(i) === at(i - 1)) run += 1;
      else {
        if (run >= 5) score += run - 2;
        run = 1;
      }
    }
    // 1:1:3:1:1 with four light modules on either side.
    for (let i = 0; i + 11 <= SIZE; i += 1) {
      const cells = Array.from({ length: 11 }, (_unused, k) => (at(i + k) ? "1" : "0")).join("");
      if (cells === "10111010000" || cells === "00001011101") score += 40;
    }
  };
  for (let y = 0; y < SIZE; y += 1) line((x) => dark[y][x]);
  for (let x = 0; x < SIZE; x += 1) line((y) => dark[y][x]);
  let total = 0;
  for (let y = 0; y < SIZE; y += 1) {
    for (let x = 0; x < SIZE; x += 1) {
      if (dark[y][x]) total += 1;
      if (x + 1 < SIZE && y + 1 < SIZE) {
        const here = dark[y][x];
        if (here === dark[y][x + 1] && here === dark[y + 1][x] && here === dark[y + 1][x + 1]) {
          score += 3;
        }
      }
    }
  }
  const share = (total * 100) / (SIZE * SIZE);
  return score + Math.floor(Math.abs(share - 50) / 5) * 10;
}

/**
 * `text` as the 53×53 symbol the app draws an invite as, in `QrMatrix`'s shape: row-major, `true`
 * for a dark module, and no quiet zone — that is `QrCode`'s to draw, as it is for the crate's.
 *
 * Refuses a text that does not fit the symbol, in words, rather than drawing a different one.
 */
export function qrMatrix(text: string): QrMatrix {
  const bytes = new TextEncoder().encode(text);
  if (bytes.length > QR_CAPACITY_BYTES) {
    throw new Error(
      `${bytes.length} bytes do not fit a version-${VERSION} QR code at level M ` +
        `(${QR_CAPACITY_BYTES} at most).`,
    );
  }
  const grid = emptyGrid();
  drawFunctionPatterns(grid);
  drawCodewords(grid, interleaved(dataCodewords(bytes)));

  let best = 0;
  let lowest = Infinity;
  for (let mask = 0; mask < MASKS.length; mask += 1) {
    applyMask(grid, mask);
    drawFormat(grid, mask);
    const score = penalty(grid.dark);
    if (score < lowest) {
      lowest = score;
      best = mask;
    }
    applyMask(grid, mask);
  }
  applyMask(grid, best);
  drawFormat(grid, best);

  return { width: SIZE, modules: grid.dark.flat() };
}
