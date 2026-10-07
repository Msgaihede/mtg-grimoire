import { describe, expect, it } from "vitest";
import { STATUS } from "./fixtures";
import { FILTERS_NEED_NAMES, scannerStatusFacts } from "./useScannerStatus";

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
