import { describe, expect, it } from "vitest";
import type { ScannerResolution, ScannerVerdict } from "@/lib/ipc";
import { VERDICTS } from "../fixtures";
import { filterSummary, statusLine, type LastAdded } from "./readerText";

/**
 * A resolve's outcome on its own, with nothing else in it — the status line reads the outcome and
 * nothing more, so a fixture carrying tiers and choices would be scenery the assertion ignores.
 */
const resolution = (outcome: ScannerResolution["outcome"]): ScannerResolution => ({
  outcome,
  choices: [],
  tiers: [],
  elapsed_ms: 41,
});

/**
 * The two tracker states every rung below the no-card one turns on, taken off the shared
 * fixtures: `decided` is a card the tracker has settled on, `voting` one it is still weighing,
 * and both are locked with a quad in frame. Spread over the Exact fixture so the frame is the mode
 * this pass added rather than the vote rule's alone.
 */
const settled: ScannerVerdict = { ...VERDICTS.exactResolved, quad: VERDICTS.decided.quad, lock: VERDICTS.decided.lock, tracked: VERDICTS.decided.tracked };
const weighing: ScannerVerdict = { ...VERDICTS.exactResolved, quad: VERDICTS.voting.quad, lock: VERDICTS.voting.lock, tracked: VERDICTS.voting.tracked };

const forest: LastAdded = { name: "Forest", setCode: "hob", collectorNumber: "193", bumpedTo: null };

describe("statusLine", () => {
  it("says the scanner cannot name anything while no hashes are loaded, whatever is in frame", () => {
    expect(statusLine(settled, "exact", forest, false, resolution("resolved"))).toBe(
      "The scanner has no card hashes loaded, so it can find a card but not name it.",
    );
  });

  it("asks for a card when there is no frame, or no card in it", () => {
    expect(statusLine(null, "fast", null, true, null)).toBe("Point the camera at a card");
    expect(statusLine(VERDICTS.noCard, "exact", forest, true, resolution("not_found"))).toBe(
      "Point the camera at a card",
    );
  });

  it("says a resolve found nothing, even before the tracker settles", () => {
    expect(statusLine(weighing, "exact", null, true, resolution("not_found"))).toBe(
      "No match — try better light, or clear the filters",
    );
  });

  it("points at the tray when a settled card resolved to several printings", () => {
    expect(statusLine(settled, "exact", forest, true, resolution("ambiguous"))).toBe(
      "Pick a printing below",
    );
  });

  it("does not ask for a pick on a card the tracker has not settled on", () => {
    expect(statusLine(weighing, "exact", null, true, resolution("ambiguous"))).toBe(
      "Hold steady — reading the card…",
    );
  });

  it("names the printing a settled card was added as", () => {
    expect(statusLine(settled, "fast", forest, true, resolution("resolved"))).toBe(
      "Added Forest — HOB 193",
    );
  });

  it("says a second copy as a count", () => {
    expect(statusLine(settled, "fast", { ...forest, bumpedTo: 2 }, true, null)).toBe(
      "Added Forest again — ×2",
    );
  });

  it("drops the dash for a card with no printing to name", () => {
    const unknown: LastAdded = { name: "Unknown card", setCode: "", collectorNumber: "", bumpedTo: null };
    expect(statusLine(settled, "fast", unknown, true, null)).toBe("Added Unknown card");
  });

  it("says the card is being read while Exact holds a lock it has not settled", () => {
    expect(statusLine(weighing, "exact", null, true, null)).toBe("Hold steady — reading the card…");
  });

  it("says hold steady otherwise", () => {
    expect(statusLine(weighing, "fast", null, true, null)).toBe("Hold steady");
    const acquiring: ScannerVerdict = { ...weighing, lock: { phase: "acquiring", agree: 1, misses: 0 } };
    expect(statusLine(acquiring, "exact", null, true, null)).toBe("Hold steady");
  });
});

describe("filterSummary", () => {
  it("says any set for no filters", () => {
    expect(filterSummary({ sets: [], released_from: null, released_to: null })).toBe("Any set");
  });

  it("names up to two sets by code, upper-cased", () => {
    expect(filterSummary({ sets: ["hob", "ltr"], released_from: null, released_to: null })).toBe("HOB, LTR");
  });

  it("counts past two sets", () => {
    expect(
      filterSummary({ sets: ["hob", "ltr", "mh3"], released_from: "2020-01-01", released_to: "2024-12-31" }),
    ).toBe("3 sets · 2020-01-01 – 2024-12-31");
  });

  it("says an open-ended window by its one end", () => {
    expect(filterSummary({ sets: ["hob"], released_from: "2023-06-23", released_to: null })).toBe(
      "HOB · from 2023-06-23",
    );
    expect(filterSummary({ sets: [], released_from: null, released_to: "2024-12-31" })).toBe(
      "Any set · until 2024-12-31",
    );
  });

  it("reads a cleared date field as no date", () => {
    expect(filterSummary({ sets: [], released_from: "", released_to: "" })).toBe("Any set");
  });
});
