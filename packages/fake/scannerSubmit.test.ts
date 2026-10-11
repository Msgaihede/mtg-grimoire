/**
 * The fake's `scanner_submit` — the workbench's stand-in for
 * `crates/grimoire-core/src/scanner_submit.rs`, which sends one scan — a run of camera frames —
 * and the card a reader says they show to the scan inbox.
 *
 * The fake has no inbox and sends nothing anywhere, so what is held here is the little a story
 * leans on: that a Send is answered with a reference shaped like the inbox's, that one picture
 * is not a scan here either, that the one refusal a story cannot produce by what it sends has a
 * fault, and that the sentences it refuses in are the engine's.
 */
import { describe, expect, it } from "vitest";
import type { ScannerSubmission } from "@grimoire/ui/lib/ipc";
import {
  FAKE_SCAN_ID,
  SCAN_INBOX_FULL,
  SCAN_MIN_FRAMES,
  SCAN_TOO_SHORT,
  makeDb,
  scannerHandlers,
} from "./db";
import scannerSubmitRs from "../../crates/grimoire-core/src/scanner_submit.rs?raw";

/** A submission over `frames` pictures, the last one at the press. */
function scan(frames: number): { submission: ScannerSubmission } {
  return {
    submission: {
      cardId: "c-bolt",
      finish: "foil",
      reported: null,
      mode: "fast",
      confidence: null,
      distance: null,
      bundle: null,
      filters: { sets: [], released_from: null, released_to: null },
      run: Array.from({ length: frames }, (_, at) => ({
        jpeg: "QUJD",
        ms: -110 * (frames - 1 - at),
        ok: false,
        lock: null,
        confidence: null,
        distance: null,
        decided: null,
        detail: false,
      })),
    },
  };
}

/** A `pub const` string out of the engine's module. `\s*` after the `=`: rustfmt may break the line. */
function sentence(name: string): string {
  const found = new RegExp(`pub const ${name}: &str =\\s*"([^"]+)";`).exec(scannerSubmitRs)?.[1];
  if (found === undefined) throw new Error(`no \`pub const ${name}\` found in scanner_submit.rs`);
  return found;
}

describe("the fake's scan inbox", () => {
  it("takes a scan and answers a reference", () => {
    expect(scannerHandlers(makeDb()).scanner_submit(scan(SCAN_MIN_FRAMES))).toEqual({
      id: FAKE_SCAN_ID,
    });
    expect(scannerHandlers(makeDb()).scanner_submit(scan(20))).toEqual({ id: FAKE_SCAN_ID });
  });

  it("answers a reference in the shape the inbox mints one in", () => {
    // `infrastructure/scan-worker/src/submit.ts`'s `mintId`: the second it arrived, then eight
    // random bytes — which that Worker's own suite holds to this same pattern.
    expect(FAKE_SCAN_ID).toMatch(/^\d{8}T\d{6}Z-[0-9a-f]{16}$/);
  });

  it("refuses one picture, and every run shorter than a run, in the engine's sentence", () => {
    // The feature's rule — all the frames or nothing, never a single screenshot — held where a
    // story and the phone's smoke run would meet it.
    for (let frames = 0; frames < SCAN_MIN_FRAMES; frames += 1) {
      expect(() => scannerHandlers(makeDb()).scanner_submit(scan(frames)), String(frames)).toThrow(
        SCAN_TOO_SHORT,
      );
    }
    // The fake cannot import the engine's constants, so it spells them again; read as text, the
    // way `qr.test.ts` reads `RELAY_BASE`.
    expect(SCAN_TOO_SHORT).toBe(sentence("TOO_SHORT"));
    const floor = /pub const MIN_RUN_FRAMES: usize = (\d+);/.exec(scannerSubmitRs)?.[1];
    expect(Number(floor)).toBe(SCAN_MIN_FRAMES);
    expect(SCAN_MIN_FRAMES).toBeGreaterThan(1);
  });

  it("refuses under `scanInboxFull`, in the engine's sentence", () => {
    const db = makeDb();
    db.fault = "scanInboxFull";
    expect(() => scannerHandlers(db).scanner_submit(scan(SCAN_MIN_FRAMES))).toThrow(
      SCAN_INBOX_FULL,
    );
    expect(SCAN_INBOX_FULL).toBe(sentence("INBOX_FULL"));
  });
});
