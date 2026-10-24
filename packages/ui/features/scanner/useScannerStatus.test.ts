import { describe, expect, it } from "vitest";
import { STATUS } from "./fixtures";
import { SYNC_INVALIDATED } from "@/lib/useSyncInvalidation";
import {
  FILTERS_NEED_NAMES,
  FILTERS_NEED_NAMES_STORE,
  SCANNER_STATUS_KEY,
  scannerStatusFacts,
} from "./useScannerStatus";

describe("scannerStatusFacts", () => {
  it("says nothing is wrong before the status has answered", () => {
    expect(scannerStatusFacts(null)).toEqual({
      status: null,
      filtersDisabled: null,
      assetNotes: [],
    });
  });

  it("draws nothing for a scanner with everything loaded", () => {
    expect(scannerStatusFacts(STATUS.present)).toEqual({
      status: STATUS.present,
      filtersDisabled: null,
      assetNotes: [],
    });
  });

  it("refuses the filters for a build with nothing, and tells nobody to place a file", () => {
    const facts = scannerStatusFacts(STATUS.missing);
    expect(facts.filtersDisabled).toBe(FILTERS_NEED_NAMES);
    // An absent recogniser is never a reader's to place: every frame says it instead.
    expect(facts.assetNotes).toEqual([]);
  });

  it("refuses the filters for a recogniser with no card names, and still scans", () => {
    const facts = scannerStatusFacts(STATUS.unlabelled);
    expect(facts.filtersDisabled).toBe(FILTERS_NEED_NAMES);
    expect(facts.assetNotes).toEqual([]);
  });

  it("says a recogniser that is there and did not load did not load, in the load's words", () => {
    const facts = scannerStatusFacts(STATUS.corrupt);
    expect(facts.filtersDisabled).toBeNull();
    expect(facts.assetNotes).toEqual(["The card recognizer did not load: gallery: bad magic."]);
  });
});

describe("a host that fetches the scanner's files into a store of its own", () => {
  it("refuses the filters without naming a file or a folder", () => {
    const facts = scannerStatusFacts({ ...STATUS.store, labels: 0 });
    expect(facts.filtersDisabled).toBe(FILTERS_NEED_NAMES_STORE);
    expect(facts.filtersDisabled).not.toMatch(/corpus\.db|next to|folder|Put /);
    // And tells nobody to put a file anywhere.
    expect(facts.assetNotes).toEqual([]);
  });

  it("keeps the other sentence for a host whose recogniser is built in", () => {
    expect(scannerStatusFacts(STATUS.unlabelled).filtersDisabled).toBe(FILTERS_NEED_NAMES);
  });
});

describe("the status, when a card sync lands", () => {
  // The names the scanner has are read out of `cards`. Asked once and kept, a status read on a
  // first run — before the sync — said "no names" for as long as the reader stayed.
  it("is one of the entries a finished sync marks stale, under the key this hook reads", () => {
    expect(SYNC_INVALIDATED).toContainEqual([...SCANNER_STATUS_KEY]);
  });
});
