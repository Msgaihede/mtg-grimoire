import { describe, expect, it } from "vitest";
import { HOST_SCANNER_UNAVAILABLE, SCANNER_NEEDS_SIMD } from "@/lib/core/hostScanner";
import { DB_BUSY } from "./verdictText";
import { STATUS } from "./fixtures";
import type { ScannerStatus } from "./types";
import {
  neuralSentence,
  SCANNER_NOT_IN_A_BROWSER_YET,
  SCANNER_OPEN_ELSEWHERE,
  scannerUnavailable,
} from "./verdictText";

/**
 * **A host with no scanner to offer, and a host with no folder** — the two things the light
 * app's step 7.5 taught the page to read from what a host answers: a closed list of sentences
 * that mean "there is no session here", and an asset whose `source` is `store`.
 */

describe("a host saying it has no scanner", () => {
  it("is read from the engine's sentence and from each of a host's own", () => {
    for (const sentence of [SCANNER_NOT_IN_A_BROWSER_YET, SCANNER_NEEDS_SIMD]) {
      expect(scannerUnavailable(sentence), sentence).toBe(true);
    }
    expect(HOST_SCANNER_UNAVAILABLE).toEqual([SCANNER_NEEDS_SIMD]);
  });

  it("is not read from a refusal that is about something else", () => {
    for (const sentence of [
      SCANNER_OPEN_ELSEWHERE,
      DB_BUSY,
      "no labels to filter by",
      "This build of MTG Grimoire was made without the card scanner's files.",
      "The card scanner could not be loaded. Check your connection.",
      "",
    ]) {
      expect(scannerUnavailable(sentence), sentence).toBe(false);
    }
  });
});

const store = (over: Partial<ScannerStatus["neural"]>): ScannerStatus => ({
  ...STATUS.store,
  neural: { ...STATUS.store.neural, ...over },
});

describe("a host that fetches the scanner's files into a store of its own", () => {
  it("draws nothing for files it has not fetched yet, and nothing for files that loaded", () => {
    expect(neuralSentence(store({}))).toBeNull();
    expect(neuralSentence(store({ present: true, loaded: true }))).toBeNull();
  });

  it("says the files did not load, in the host's words, with no path and no restart", () => {
    const failed = store({ error: "The card recognizer's files would not load: bad gallery" });
    expect(neuralSentence(failed)).toBe(
      "The card recognizer did not load: The card recognizer's files would not load: bad gallery.",
    );
    expect(neuralSentence(failed)).not.toMatch(/restart|\/scanner-neural/i);
  });
});
