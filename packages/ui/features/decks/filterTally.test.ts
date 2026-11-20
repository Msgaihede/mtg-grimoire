import { beforeEach, describe, expect, it } from "vitest";
import { deckStats } from "./DeckStats";
import { filterTally, filterTallyHint } from "./filterTally";
import { card, resetRowIds } from "./validation/fixtures";

beforeEach(() => resetRowIds());

describe("filterTally", () => {
  it("counts copies, not rows, in the piles the size rule counts", () => {
    const tally = filterTally([
      card({ name: "Lightning Bolt", quantity: 4 }),
      card({ name: "Bear", quantity: 2 }),
    ]);

    expect(tally).toEqual({ sized: 6, rest: [], restCopies: 0 });
  });

  /** The headline is the ledger's `Cards` rule, read through the same function — a sideboard
   *  copy is on screen and in the `+n`, never in the headline. */
  it("reads the size rule through deckStats, so the headline is the ledger's", () => {
    const rows = [
      card({ name: "Lightning Bolt", quantity: 4 }),
      card({ name: "Lightning Bolt", quantity: 1, categoryKind: "side" }),
      card({ name: "Bear", quantity: 2, categoryKind: "commander" }),
    ];

    const tally = filterTally(rows);

    expect(tally.sized).toBe(deckStats(rows).sized);
    expect(tally.rest).toEqual([{ id: expect.any(Number), name: "Sideboard", quantity: 1 }]);
    expect(tally.restCopies).toBe(1);
  });

  /** Where it parts from the ledger, on purpose: a switched-off pile counts toward nothing, but a
   *  card in it the filter matched is drawn on the desk, so the `+n` counts it. */
  it("counts a switched-off pile's copies in the rest, after the switched-on ones", () => {
    const tally = filterTally([
      card({ name: "Lightning Bolt", quantity: 3, categoryKind: "maybe" }),
      card({ name: "Lightning Bolt", quantity: 4 }),
      card({ name: "Shock", quantity: 1, categoryKind: "maybe" }),
      card({ name: "Shock", quantity: 2, categoryKind: "side" }),
    ]);

    expect(tally.sized).toBe(4);
    expect(tally.rest.map(({ name, quantity }) => ({ name, quantity }))).toEqual([
      { name: "Sideboard", quantity: 2 },
      { name: "Maybeboard", quantity: 4 },
    ]);
    expect(tally.restCopies).toBe(6);
  });

  it("answers zero for a filter that left nothing", () => {
    expect(filterTally([])).toEqual({ sized: 0, rest: [], restCopies: 0 });
  });
});

describe("filterTallyHint", () => {
  it("says what the headline counts", () => {
    expect(filterTallyHint({ sized: 6, rest: [], restCopies: 0 })).toBe(
      "Cards shown that count toward deck size.",
    );
  });

  it("names every pile in the rest, in the ledger's words", () => {
    expect(
      filterTallyHint({
        sized: 19,
        rest: [
          { id: 2, name: "Sideboard", quantity: 6 },
          { id: 5, name: "Maybeboard", quantity: 1 },
        ],
        restCopies: 7,
      }),
    ).toBe(
      "Cards shown that count toward deck size, plus 6 sideboard + 1 maybeboard (not counted).",
    );
  });
});
