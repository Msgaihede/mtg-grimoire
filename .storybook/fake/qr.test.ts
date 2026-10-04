/**
 * The fake's QR encoder, read back by the decoder the app scans with.
 *
 * An encoder has one honest test: hand what it drew to a decoder somebody else wrote. `jsQR` is
 * that decoder — and it is the one `QrScanner` runs over a camera frame, so a symbol it reads
 * here is one the app's own scanner reads.
 */
import jsQR from "jsqr";
import { describe, expect, it } from "vitest";
import { allHandlers, makeDb } from "./db";
import { QR_CAPACITY_BYTES, qrMatrix } from "./qr";
import type { PairingOffer, QrMatrix } from "@/lib/ipc";

/** The matrix as pixels: `scale` a module, a four-module quiet zone, black on white. */
function decode(matrix: QrMatrix, scale = 4): string | null {
  const quiet = 4;
  const side = (matrix.width + quiet * 2) * scale;
  const pixels = new Uint8ClampedArray(side * side * 4).fill(255);
  matrix.modules.forEach((dark, i) => {
    if (!dark) return;
    const left = ((i % matrix.width) + quiet) * scale;
    const top = (Math.floor(i / matrix.width) + quiet) * scale;
    for (let y = top; y < top + scale; y += 1) {
      for (let x = left; x < left + scale; x += 1) {
        const at = (y * side + x) * 4;
        pixels[at] = pixels[at + 1] = pixels[at + 2] = 0;
      }
    }
  });
  return jsQR(pixels, side, side)?.data ?? null;
}

/** A pairing invite as the QR carries it: the relay's `/pair` page, the code in the fragment. */
const INVITE =
  "https://mtg-grimoire-relay.denmark-east.workers.dev/pair#" +
  "0123456789ABCDEFGHJKMNPQRSTVWXYZ".repeat(3) +
  "012345678";

describe("the fake's QR encoder", () => {
  it("draws the invite as the 53-module symbol the crate measured for it", () => {
    // 162 bytes, the figure `sync_pair::invite::qr_payload` records.
    expect(new TextEncoder().encode(INVITE)).toHaveLength(162);
    const matrix = qrMatrix(INVITE);
    expect(matrix.width).toBe(53);
    expect(matrix.modules).toHaveLength(53 * 53);
  });

  it("draws a symbol the app's own decoder reads back, character for character", () => {
    expect(decode(qrMatrix(INVITE))).toBe(INVITE);
  });

  it("reads back at the size a 360px phone draws it: four pixels a module", () => {
    // 268px less the picture's padding, over 53 modules and their quiet zone, is 4.26px each.
    expect(decode(qrMatrix(INVITE), 4)).toBe(INVITE);
    expect(decode(qrMatrix(INVITE), 3)).toBe(INVITE);
  });

  it("pads a shorter text into the same symbol, and reads that back too", () => {
    const matrix = qrMatrix("https://example.test/pair#SHORT");
    expect(matrix.width).toBe(53);
    expect(decode(matrix)).toBe("https://example.test/pair#SHORT");
  });

  it("fills the symbol to its last byte, and refuses the byte after it", () => {
    const full = "A".repeat(QR_CAPACITY_BYTES);
    expect(decode(qrMatrix(full))).toBe(full);
    expect(() => qrMatrix(`${full}A`)).toThrow(/do not fit/);
  });

  it("is what an offered pairing answers: the invite it shows, as a URL a camera can open", () => {
    const offer = (allHandlers(makeDb()).sync_pairing_begin as () => PairingOffer)();
    const read = decode(offer.qr);
    // The typed form's hyphens are not in the picture — twenty bytes that would buy a larger
    // symbol — and everything after the `#` is the code.
    expect(read).toBe(
      `https://mtg-grimoire-relay.denmark-east.workers.dev/pair#${offer.code.replace(/-/g, "")}`,
    );
  });
});
