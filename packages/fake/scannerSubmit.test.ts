/**
 * The fake's `scanner_submit` — the workbench's stand-in for
 * `crates/grimoire-core/src/scanner_submit.rs`, which sends one camera picture and the card a
 * reader says it shows to the scan inbox.
 *
 * The fake has no inbox and sends nothing anywhere, so what is held here is the little a story
 * leans on: that a Send is answered with a reference shaped like the inbox's, that the one
 * refusal a story cannot produce by what it sends has a fault, and that the sentence it refuses
 * in is the engine's.
 */
import { describe, expect, it } from "vitest";
import { FAKE_SCAN_ID, SCAN_INBOX_FULL, makeDb, scannerHandlers } from "./db";
import scannerSubmitRs from "../../crates/grimoire-core/src/scanner_submit.rs?raw";

describe("the fake's scan inbox", () => {
  it("takes a scan and answers a reference", () => {
    expect(scannerHandlers(makeDb()).scanner_submit()).toEqual({ id: FAKE_SCAN_ID });
  });

  it("answers a reference in the shape the inbox mints one in", () => {
    // `infrastructure/scan-worker/src/submit.ts`'s `mintId`: the second it arrived, then eight
    // random bytes — which that Worker's own suite holds to this same pattern.
    expect(FAKE_SCAN_ID).toMatch(/^\d{8}T\d{6}Z-[0-9a-f]{16}$/);
  });

  it("refuses under `scanInboxFull`, in the engine's sentence", () => {
    const db = makeDb();
    db.fault = "scanInboxFull";
    expect(() => scannerHandlers(db).scanner_submit()).toThrow(SCAN_INBOX_FULL);

    // The fake cannot import the constant, so it spells the sentence again; read as text, the
    // way `qr.test.ts` reads `RELAY_BASE`. `\s*` after the `=`: rustfmt may break the line.
    const rust = /pub const INBOX_FULL: &str =\s*"([^"]+)";/.exec(scannerSubmitRs)?.[1];
    expect(rust, "no `pub const INBOX_FULL` found in scanner_submit.rs").toBeDefined();
    expect(SCAN_INBOX_FULL).toBe(rust);
  });
});
