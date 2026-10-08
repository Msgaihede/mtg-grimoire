import { describe, expect, it } from "vitest";
import { HOST_SCANNER_UNAVAILABLE, SCANNER_NEEDS_SIMD, SCANNER_NOT_SHIPPED } from "@/lib/core/hostScanner";
import { DB_BUSY } from "./verdictText";
import { STATUS } from "./fixtures";
import type { ScannerAsset, ScannerStatus } from "./types";
import {
  bundleSentence,
  modelsSentence,
  SCANNER_NOT_IN_A_BROWSER_YET,
  SCANNER_OPEN_ELSEWHERE,
  scannerUnavailable,
} from "./verdictText";

/**
 * **A host with no scanner to offer, and a host with no folder** — the two things the light
 * app's step 7.5 taught the page to read from what a host answers: a closed list of sentences
 * that mean "there is no session here", and assets whose `source` is `store`.
 */

describe("a host saying it has no scanner", () => {
  it("is read from the engine's sentence and from each of a host's own", () => {
    for (const sentence of [SCANNER_NOT_IN_A_BROWSER_YET, SCANNER_NEEDS_SIMD, SCANNER_NOT_SHIPPED]) {
      expect(scannerUnavailable(sentence), sentence).toBe(true);
    }
    expect(HOST_SCANNER_UNAVAILABLE).toEqual([SCANNER_NEEDS_SIMD, SCANNER_NOT_SHIPPED]);
  });

  it("is not read from a refusal that is about something else", () => {
    for (const sentence of [
      SCANNER_OPEN_ELSEWHERE,
      DB_BUSY,
      "no labels to filter by",
      "The scanner's card data has not been downloaded yet.",
      "The card scanner could not be loaded. Check your connection.",
      "",
    ]) {
      expect(scannerUnavailable(sentence), sentence).toBe(false);
    }
  });
});

const stored = (over: Partial<ScannerAsset> = {}): ScannerAsset => ({
  path: "/scanner-assets/card-hashes.bin",
  present: true,
  loaded: true,
  error: null,
  source: "store",
  ...over,
});
const status = (over: Partial<ScannerStatus>): ScannerStatus => ({
  ...STATUS.present,
  bundle: stored(),
  detection_model: stored({ path: "/scanner-assets/text-detection.rten" }),
  recognition_model: stored({ path: "/scanner-assets/text-recognition.rten" }),
  scans_dir: "",
  ...over,
});

describe("a host that keeps the scanner's files in a store of its own", () => {
  it("draws nothing for files that loaded", () => {
    expect(bundleSentence(status({}))).toBeNull();
    expect(modelsSentence(status({}))).toBeNull();
  });

  it("never tells a reader to put a file anywhere, or to restart, for one it does not hold", () => {
    const none = status({
      bundle: stored({ present: false, loaded: false }),
      detection_model: stored({ present: false, loaded: false }),
      recognition_model: stored({ present: false, loaded: false }),
    });
    // Offered or not: the offer, or the frame's own refusal, is what says it.
    for (const offered of [true, false]) {
      expect(bundleSentence(none, offered)).toBeNull();
      expect(modelsSentence(none, offered)).toBeNull();
    }
  });

  it("says a file it holds did not load, in the crate's words, with no path and no restart", () => {
    const corrupt = status({
      bundle: stored({ loaded: false, error: "unsupported format version 2, expected 3" }),
      detection_model: stored({ loaded: false, error: "not a model" }),
      recognition_model: stored({ loaded: false, error: "not a model" }),
    });
    expect(bundleSentence(corrupt)).toBe(
      "The scanner's card data did not load: unsupported format version 2, expected 3.",
    );
    expect(modelsSentence(corrupt)).toBe("The scanner's text readers did not load: not a model.");
    // And says nothing while the host offers to fetch it again.
    expect(bundleSentence(corrupt, true)).toBeNull();
    expect(modelsSentence(corrupt, true)).toBeNull();
  });

  it("says card names did not load beside a bundle that did, without the restart", () => {
    const unnamed = status({
      bundle: stored({ error: "labels: the card database had no cards to name them from" }),
      labels: 0,
    });
    expect(bundleSentence(unnamed)).toBe(
      "Card names didn't load: labels: the card database had no cards to name them from. Matches will show IDs.",
    );
    expect(bundleSentence(unnamed, true)).toBe(bundleSentence(unnamed));
  });
});
