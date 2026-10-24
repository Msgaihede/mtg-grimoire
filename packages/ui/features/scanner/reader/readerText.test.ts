import { describe, expect, it } from "vitest";
import type { ScannerChoice, ScannerTracked, ScannerVerdict } from "@/lib/ipc";
import { VERDICTS } from "../fixtures";
import { filtering, filterSummary, matchStrip, NO_FILTERS, type LastAdded } from "./readerText";

/** Three printings of Lightning Bolt one picture stands for — the shared ambiguous decision. */
const boltChoices = VERDICTS.ambiguous.decision?.choices ?? [];

/**
 * The two agreement states every rung below the no-card one turns on, taken off the shared
 * fixtures: `decided` is a card the agreement has settled on, `voting` one it is still weighing.
 *
 * **`settled` names two cards on purpose**: its agreement leads with Storm of Saruman (LTR 72)
 * and its decision is Black Lotus (LEA 232) — so a rung that names the wrong source names the
 * wrong card here.
 */
const settled: ScannerVerdict = { ...VERDICTS.resolved, tracked: VERDICTS.decided.tracked };
const weighing: ScannerVerdict = { ...VERDICTS.voting, decision: null };

/** A settled frame whose decision offers `choices` to pick from. */
const offering = (choices: ScannerChoice[]): ScannerVerdict => ({
  ...VERDICTS.ambiguous,
  decision: { ...VERDICTS.ambiguous.decision!, choices },
});

const forest: LastAdded = {
  name: "Forest",
  setCode: "hob",
  collectorNumber: "193",
  bumpedTo: null,
  replaced: false,
};

describe("matchStrip", () => {
  it("says the scanner cannot name anything while no recogniser is loaded, whatever is in frame", () => {
    expect(matchStrip({ ...settled, matcher: false }, forest)).toEqual({
      word: "Can't identify",
      tone: "error",
      name: null,
      printing: null,
      sentence: "The card recognizer isn't loaded, so cards can't be identified.",
      fill: 0,
      committed: false,
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
    expect(matchStrip(null, null)).toMatchObject(looking);
    expect(matchStrip(VERDICTS.noCard, forest)).toMatchObject(looking);
  });

  it("names the card and counts its printings when a settled card stands for several", () => {
    expect(matchStrip(VERDICTS.ambiguous, forest)).toEqual({
      word: "3 printings",
      tone: "attention",
      name: "Lightning Bolt",
      // A card, not a printing: which printing is the question the tray is asking.
      printing: null,
      sentence: "Pick a printing in the tray",
      fill: 1,
      committed: true,
    });
  });

  it("asks for a pick without a count when there is one printing to pick", () => {
    expect(matchStrip(offering(boltChoices.slice(0, 1)), null)).toMatchObject({
      word: "Pick a printing",
      tone: "attention",
    });
  });

  it("names no card when the printings to pick from are not one card", () => {
    const other = {
      ...boltChoices[1],
      label: { ...boltChoices[1].label!, name: "Chain Lightning" },
    };
    expect(matchStrip(offering([boltChoices[0], other]), null)).toMatchObject({
      word: "2 printings",
      name: null,
    });
  });

  it("does not ask for a pick on a card the agreement has not settled on", () => {
    const unsettled: ScannerVerdict = { ...VERDICTS.ambiguous, tracked: VERDICTS.voting.tracked };
    expect(matchStrip(unsettled, null)).toMatchObject({ word: "Matching", tone: "progress" });
  });

  it("names the printing a settled card was added as", () => {
    expect(
      matchStrip(VERDICTS.decided, {
        ...forest,
        name: "Storm of Saruman",
        setCode: "ltr",
        collectorNumber: "72",
      }),
    ).toEqual({
      word: "Matched",
      tone: "done",
      name: "Storm of Saruman",
      printing: "LTR 72",
      sentence: "Added · swap in the next card",
      fill: 1,
      committed: true,
    });
  });

  it("names what the tray filed, not the agreement's leader or the decision's label", () => {
    expect(matchStrip(settled, forest)).toMatchObject({ name: "Forest", printing: "HOB 193" });
  });

  it("says a second copy as a count, and a second opinion as an update", () => {
    expect(matchStrip(settled, { ...forest, bumpedTo: 3 }).sentence).toBe("Added again — ×3");
    expect(matchStrip(settled, { ...forest, replaced: true }).sentence).toBe("Printing updated");
  });

  it("names no printing for a card with no label", () => {
    expect(matchStrip(settled, { ...forest, setCode: "", collectorNumber: "" })).toMatchObject({
      name: "Forest",
      printing: null,
    });
  });

  it("says matched on the decided card before the tray has taken one, naming the decision", () => {
    expect(matchStrip(settled, null)).toEqual({
      word: "Matched",
      tone: "done",
      name: "Black Lotus",
      printing: "LEA 232",
      sentence: "Hold steady",
      fill: 1,
      committed: true,
    });
  });

  it("does not name the last card filed on a frame that has not decided", () => {
    expect(matchStrip(weighing, forest)).toMatchObject({ word: "Matching", name: "Plains" });
  });

  it("says matched on the agreement's leader on a commit with no decision on it", () => {
    const committed: ScannerVerdict = { ...VERDICTS.decided, decision: null };
    expect(matchStrip(committed, forest)).toMatchObject({
      word: "Matched",
      name: "Storm of Saruman",
      printing: "LTR 72",
      sentence: "Hold steady",
    });
  });

  it("says hold steady otherwise, with the agreement's leader and its bar", () => {
    expect(matchStrip(weighing, null)).toEqual({
      word: "Matching",
      tone: "progress",
      name: "Plains",
      printing: "2XM 373",
      sentence: "Hold steady",
      fill: 0.625,
      committed: false,
    });
  });

  it("names nothing while there is no agreement to lead", () => {
    const blank: ScannerVerdict = { ...VERDICTS.voting, tracked: null };
    expect(matchStrip(blank, null)).toMatchObject({
      word: "Matching",
      name: null,
      printing: null,
      fill: 0,
    });
    const empty: ScannerTracked = { ...VERDICTS.voting.tracked!, standings: [] };
    expect(matchStrip({ ...VERDICTS.voting, tracked: empty }, null)).toMatchObject({ name: null });
  });
});

describe("filterSummary", () => {
  it("says any set for no filters", () => {
    expect(filterSummary({ sets: [], released_from: null, released_to: null })).toBe("Any set");
  });

  it("names up to two sets by code, upper-cased", () => {
    expect(filterSummary({ sets: ["hob", "ltr"], released_from: null, released_to: null })).toBe(
      "HOB, LTR",
    );
  });

  it("counts past two sets", () => {
    expect(
      filterSummary({
        sets: ["hob", "ltr", "mh3"],
        released_from: "2020-01-01",
        released_to: "2024-12-31",
      }),
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

  it("says skipped promos last, and says nothing of promos admitted or unspoken", () => {
    const base = { sets: ["hob"], released_from: "2023-06-23", released_to: null };
    expect(filterSummary({ ...base, exclude_promos: true })).toBe(
      "HOB · from 2023-06-23 · no promos",
    );
    expect(filterSummary({ ...NO_FILTERS, exclude_promos: true })).toBe("Any set · no promos");
    expect(filterSummary({ ...base, exclude_promos: false })).toBe("HOB · from 2023-06-23");
    expect(filterSummary(base)).toBe("HOB · from 2023-06-23");
  });
});

describe("filtering", () => {
  it("is on for any one filter, the promo switch alone among them", () => {
    expect(filtering(NO_FILTERS)).toBe(false);
    expect(filtering({ sets: [], released_from: "", released_to: "" })).toBe(false);
    expect(filtering({ ...NO_FILTERS, exclude_promos: true })).toBe(true);
    expect(filtering({ ...NO_FILTERS, sets: ["hob"] })).toBe(true);
    expect(filtering({ ...NO_FILTERS, released_to: "2024-12-31" })).toBe(true);
  });
});
