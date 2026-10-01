import { describe, expect, it } from "vitest";
import type { ScannerChoice, ScannerResolution, ScannerTracked, ScannerVerdict } from "@/lib/ipc";
import { VERDICTS } from "../fixtures";
import { filterSummary, matchStrip, type LastAdded } from "./readerText";

/**
 * A resolve's outcome on its own, with nothing else in it — every rung but the ambiguous one reads
 * the outcome and nothing more, so a fixture carrying tiers would be scenery the assertion ignores.
 * The ambiguous rung also counts the choices and asks whether they name one card, so it is handed
 * them.
 */
const resolution = (
  outcome: ScannerResolution["outcome"],
  choices: ScannerChoice[] = [],
): ScannerResolution => ({ outcome, choices, tiers: [], elapsed_ms: 41 });

/** Three printings of Lightning Bolt the margin could not split — the shared ambiguous resolve. */
const boltChoices = VERDICTS.exactAmbiguous.resolution?.choices ?? [];

/**
 * The two tracker states every rung below the no-card one turns on, taken off the shared
 * fixtures: `decided` is a card the tracker has settled on, `voting` one it is still weighing,
 * and both are locked with a quad in frame. Spread over the Exact fixture so the frame is the mode
 * this pass added rather than the vote rule's alone.
 *
 * **`settled` names two cards on purpose**: its tracker leads with Storm of Saruman (LTR 72) and
 * its decision is the Exact resolve's Black Lotus (LEA 232), which is the shape of an Exact frame
 * whose resolve pinned another printing than the hash's leader — so a rung that names the wrong
 * source names the wrong card here.
 */
const settled: ScannerVerdict = { ...VERDICTS.exactResolved, quad: VERDICTS.decided.quad, lock: VERDICTS.decided.lock, tracked: VERDICTS.decided.tracked };
const weighing: ScannerVerdict = { ...VERDICTS.exactResolved, quad: VERDICTS.voting.quad, lock: VERDICTS.voting.lock, tracked: VERDICTS.voting.tracked };

const forest: LastAdded = { name: "Forest", setCode: "hob", collectorNumber: "193", bumpedTo: null, replaced: false };

describe("matchStrip", () => {
  it("says the scanner cannot name anything while no hashes are loaded, whatever is in frame", () => {
    expect(matchStrip(settled, "exact", forest, false, resolution("resolved"))).toEqual({
      word: "Can't identify",
      tone: "error",
      name: null,
      printing: null,
      sentence: "Card hashes aren't loaded, so cards can be detected but not identified.",
      fill: 0,
      committed: false,
      threshold: "end",
    });
  });

  it("asks for a card when there is no frame, or no card in it", () => {
    const looking = {
      word: "Looking",
      tone: "idle",
      name: null,
      printing: null,
      sentence: "Point the camera at a card",
      fill: 0,
      committed: false,
    };
    expect(matchStrip(null, "fast", null, true, null)).toMatchObject(looking);
    expect(matchStrip(VERDICTS.noCard, "exact", forest, true, resolution("not_found"))).toMatchObject(
      looking,
    );
  });

  it("says a resolve found nothing, even before the tracker settles", () => {
    expect(matchStrip(weighing, "exact", null, true, resolution("not_found"))).toMatchObject({
      word: "No match",
      tone: "error",
      name: null,
      sentence: "Try better lighting or clear the filters.",
      fill: 0,
      committed: false,
    });
  });

  it("names the card and counts its printings when a settled card resolved to several", () => {
    expect(matchStrip(settled, "exact", forest, true, resolution("ambiguous", boltChoices))).toEqual({
      word: "3 printings",
      tone: "attention",
      name: "Lightning Bolt",
      // A card, not a printing — which printing is what the tray is asking.
      printing: null,
      sentence: "Pick a printing in the tray",
      fill: 1,
      committed: true,
      threshold: "end",
    });
  });

  it("asks for a pick without a count when the resolve carries no choices to count", () => {
    expect(matchStrip(settled, "exact", forest, true, resolution("ambiguous"))).toMatchObject({
      word: "Pick a printing",
      name: null,
      sentence: "Pick a printing in the tray",
    });
  });

  /** A tie between two names is not a card settled — the strip must not name the first of them. */
  it("names no card when the printings to pick from are not one card", () => {
    const tie: ScannerChoice[] = [
      boltChoices[0],
      { id: "chain", oracle_id: null, label: { name: "Chain Lightning", set: "lgn", number: "94", lang: "en", released: "1998-02-23" }, distance: 0.15, finishes: ["nonfoil"] },
    ];
    expect(matchStrip(settled, "exact", forest, true, resolution("ambiguous", tie))).toMatchObject({
      word: "2 printings",
      name: null,
      sentence: "Pick a printing in the tray",
    });
  });

  it("does not ask for a pick on a card the tracker has not settled on", () => {
    expect(matchStrip(weighing, "exact", null, true, resolution("ambiguous", boltChoices))).toMatchObject({
      word: "Reading",
      tone: "progress",
      sentence: "Hold steady — reading…",
    });
  });

  it("names the printing a settled card was added as", () => {
    expect(matchStrip(VERDICTS.decided, "fast", forest, true, null)).toEqual({
      word: "Matched",
      tone: "done",
      name: "Forest",
      printing: "HOB 193",
      sentence: "Added · swap in the next card",
      fill: 1,
      committed: true,
      threshold: "end",
    });
  });

  /**
   * The hash's leader here is Storm of Saruman and the resolve's decision Black Lotus; the tray
   * filed Forest LTR 270. Only the tray's row is what was filed, so only it may be named.
   */
  it("names what the tray filed in Exact, not the hash's leader or the resolve's first choice", () => {
    const pinned: LastAdded = { ...forest, setCode: "ltr", collectorNumber: "270", replaced: true };
    expect(matchStrip(settled, "exact", pinned, true, resolution("resolved"))).toMatchObject({
      word: "Matched",
      name: "Forest",
      printing: "LTR 270",
      sentence: "Printing updated",
    });
  });

  it("says a second copy as a count", () => {
    expect(matchStrip(settled, "fast", { ...forest, bumpedTo: 2 }, true, null)).toMatchObject({
      word: "Matched",
      name: "Forest",
      sentence: "Added again — ×2",
    });
  });

  it("names no printing for a card with no label", () => {
    const unknown: LastAdded = { name: "Unknown card", setCode: "", collectorNumber: "", bumpedTo: null, replaced: false };
    expect(matchStrip(settled, "fast", unknown, true, null)).toMatchObject({
      name: "Unknown card",
      printing: null,
      sentence: "Added · swap in the next card",
    });
  });

  it("says matched on the decided card before the tray has taken one", () => {
    expect(matchStrip(VERDICTS.decided, "fast", null, true, null)).toMatchObject({
      word: "Matched",
      tone: "done",
      name: "Storm of Saruman",
      printing: "LTR 72",
      sentence: "Hold steady",
      fill: 1,
      committed: true,
    });
  });

  /**
   * Fast holds a commit one frame for the read that confirms it, and that frame carries no
   * decision. `lastAdded` is still the card before — naming it as matched would put the previous
   * card's name over the new one in the camera.
   */
  it("does not name the last card filed on a Fast frame that has not decided yet", () => {
    const confirming: ScannerVerdict = { ...VERDICTS.decided, decision: null };
    expect(matchStrip(confirming, "fast", forest, true, null)).toMatchObject({
      word: "Matched",
      name: "Storm of Saruman",
      printing: "LTR 72",
      sentence: "Hold steady",
    });
  });

  /** Exact is settled by its resolve; a tracker that got there first is still being read. */
  it("keeps reading an Exact card the tracker settled before its resolve answered", () => {
    const early: ScannerVerdict = { ...settled, decision: null, resolution: null };
    expect(matchStrip(early, "exact", forest, true, null)).toEqual({
      word: "Reading",
      tone: "progress",
      name: "Storm of Saruman",
      printing: "LTR 72",
      sentence: "Hold steady — reading…",
      fill: 1,
      committed: false,
      threshold: "end",
    });
  });

  it("says the card is being read while Exact holds a lock it has not settled", () => {
    expect(matchStrip(weighing, "exact", null, true, null)).toEqual({
      word: "Reading",
      tone: "progress",
      name: "Plains",
      printing: "2XM 373",
      sentence: "Hold steady — reading…",
      fill: 0.625,
      committed: false,
      threshold: "end",
    });
  });

  it("says hold steady otherwise, with the tracker's leader and its bar", () => {
    expect(matchStrip(weighing, "fast", null, true, null)).toEqual({
      word: "Matching",
      tone: "progress",
      name: "Plains",
      printing: "2XM 373",
      sentence: "Hold steady",
      fill: 0.625,
      committed: false,
      threshold: "end",
    });
    const acquiring: ScannerVerdict = { ...weighing, lock: { phase: "acquiring", agree: 1, misses: 0 } };
    expect(matchStrip(acquiring, "exact", null, true, null)).toMatchObject({ word: "Matching", sentence: "Hold steady" });
  });

  it("names nothing while there is no tracker to lead", () => {
    const untracked: ScannerVerdict = { ...weighing, tracked: null };
    expect(matchStrip(untracked, "fast", null, true, null)).toMatchObject({
      word: "Matching",
      name: null,
      printing: null,
      fill: 0,
    });
  });

  it("puts the hairline at 70% under the confidence rule, and at the end under votes", () => {
    const gathering: ScannerTracked = { ...(VERDICTS.confidence.tracked as ScannerTracked), committed: false, confidence: 0.55 };
    const strip = matchStrip({ ...VERDICTS.confidence, decision: null, tracked: gathering }, "fast", null, true, null);
    expect(strip).toMatchObject({ word: "Matching", fill: 0.55, threshold: 0.7 });
    expect(matchStrip(weighing, "fast", null, true, null).threshold).toBe("end");
  });

  it("fills the bar under the confidence rule once the card is matched", () => {
    // Committed at 80%: the bar is the question "decided yet?", and the answer is yes.
    expect(matchStrip(VERDICTS.confidence, "fast", null, true, null)).toMatchObject({
      word: "Matched",
      name: "Plains",
      fill: 1,
      committed: true,
      threshold: 0.7,
    });
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
