import { describe, expect, it } from "vitest";
import { STATUS } from "./fixtures";
import { SYNC_INVALIDATED } from "@/lib/useSyncInvalidation";
import type { ScannerAsset, ScannerStatus } from "./types";
import {
  FILTERS_NEED_NAMES,
  FILTERS_NEED_NAMES_STORE,
  SCANNER_STATUS_KEY,
  scannerStatusFacts,
} from "./useScannerStatus";

describe("scannerStatusFacts", () => {
  it("says nothing is wrong before the status has answered", () => {
    // Unknown is not absent: the first answer takes most of a second, and a line saying the
    // scanner has no hashes for that second is a false alarm on every first open.
    expect(scannerStatusFacts(null)).toEqual({
      status: null,
      hasBundle: true,
      filtersDisabled: null,
      assetNotes: [],
    });
  });

  it("draws nothing for a scanner with everything loaded", () => {
    for (const status of [STATUS.present, STATUS.embedded]) {
      expect(scannerStatusFacts(status)).toEqual({
        status,
        hasBundle: true,
        filtersDisabled: null,
        assetNotes: [],
      });
    }
  });

  it("names both missing assets, refuses the filters and says there is no bundle", () => {
    const facts = scannerStatusFacts(STATUS.missing);
    expect(facts.hasBundle).toBe(false);
    expect(facts.filtersDisabled).toBe(FILTERS_NEED_NAMES);
    expect(facts.assetNotes).toHaveLength(2);
    expect(facts.assetNotes[0]).toMatch(/^No reference bundle\. Put `card-hashes\.bin` at /);
    expect(facts.assetNotes[1]).toMatch(/^No OCR models\. Put /);
  });

  it("keeps the scanner and the filters when only the reading models are absent", () => {
    const facts = scannerStatusFacts(STATUS.noModels);
    expect(facts.hasBundle).toBe(true);
    expect(facts.filtersDisabled).toBeNull();
    expect(facts.assetNotes).toHaveLength(1);
    expect(facts.assetNotes[0]).toMatch(/^No OCR models/);
  });

  it("refuses the filters for a bundle whose card names did not load, and still scans", () => {
    const facts = scannerStatusFacts(STATUS.unlabelled);
    expect(facts.hasBundle).toBe(true);
    expect(facts.filtersDisabled).toBe(FILTERS_NEED_NAMES);
    expect(facts.assetNotes).toHaveLength(1);
    expect(facts.assetNotes[0]).toMatch(/^Bundle loaded, but card names didn't/);
  });

  it("says a bundle that is there and did not parse did not load", () => {
    const facts = scannerStatusFacts(STATUS.corrupt);
    expect(facts.hasBundle).toBe(false);
    expect(facts.assetNotes[0]).toMatch(/did not load: bad magic/);
  });
});

describe("a host that keeps the scanner's files in a store of its own", () => {
  const stored = (over: Partial<ScannerAsset>): ScannerAsset => ({
    path: "/scanner-assets/card-hashes.bin",
    present: false,
    loaded: false,
    error: null,
    source: "store",
    ...over,
  });
  const status = (over: Partial<ScannerStatus>): ScannerStatus => ({
    bundle: stored({}),
    detection_model: stored({}),
    recognition_model: stored({}),
    labels: 0,
    scans_dir: "",
    unapplied_filters: null,
    ...over,
  });

  it("refuses the filters without naming a file or a folder, before anything is downloaded", () => {
    const facts = scannerStatusFacts(status({}));
    expect(facts.filtersDisabled).toBe(FILTERS_NEED_NAMES_STORE);
    expect(facts.filtersDisabled).not.toMatch(/corpus\.db|next to|folder|Put /);
    // And tells nobody to put a file anywhere.
    expect(facts.assetNotes).toEqual([]);
  });

  it("says the same of a session built before the card database had cards", () => {
    const unnamed = status({
      bundle: stored({ present: true, loaded: true, error: "labels: the card database had no cards to name them from" }),
    });
    expect(scannerStatusFacts(unnamed).filtersDisabled).toBe(FILTERS_NEED_NAMES_STORE);
  });

  it("keeps the folder's own sentence for a host that has a folder", () => {
    const filed = status({ bundle: { ...stored({ present: true, loaded: true }), source: "file" } });
    expect(scannerStatusFacts(filed).filtersDisabled).toBe(FILTERS_NEED_NAMES);
  });
});

describe("the status, when a card sync lands", () => {
  // The names the scanner has are read out of `cards`. Asked once and kept, a status read on a
  // first run — before the sync — said "no names" for as long as the reader stayed.
  it("is one of the entries a finished sync marks stale, under the key this hook reads", () => {
    expect(SYNC_INVALIDATED).toContainEqual([...SCANNER_STATUS_KEY]);
  });
});
