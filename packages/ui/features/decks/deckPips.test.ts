import { describe, expect, it } from "vitest";
import { countPips, emptyPips, type ManaKey } from "@/lib/mana";
import type { DeckPipCosts, DeckRow } from "@/lib/ipc";
import { deckColorsLabel, deckPips, pipColors, pipTotal, tilePips } from "./deckPips";

/**
 * These tests are about the **fold** and nothing else. What a pip is — that a hybrid counts
 * twice, that `{2}` counts not at all — is `mana.ts`'s and is pinned in `mana.test.ts`; a copy of
 * those cases here would be a second place for the vocabulary to be wrong in, which is the exact
 * failure the two modules are split to avoid. What can break *here* is the weighting by copies,
 * the accumulation across rows, and the decision that a deck nobody sent rows for is absent.
 */

/** The read's rows, with the plan's half empty unless a test names it — the shape a deck that
 *  keeps no plan arrives in. */
function rows(
  ...decks: (Omit<DeckPipCosts, "theoryCosts"> & Partial<Pick<DeckPipCosts, "theoryCosts">>)[]
): DeckPipCosts[] {
  return decks.map((deck) => ({ theoryCosts: [], ...deck }));
}

/** A `PipCounts` written the short way, for an expectation. Every unnamed colour is zero. */
function pips(counts: Partial<Record<ManaKey, number>>) {
  return { ...emptyPips(), ...counts };
}

describe("deckPips", () => {
  it("weights each cost by the copies in the deck", () => {
    const byDeck = deckPips(
      rows({
        deckId: 4,
        costs: [
          { cost: "{1}{R}", copies: 4 },
          { cost: "{R}{R}", copies: 2 },
        ],
      }),
    );

    // Four Bolts and two double-red spells: 4 + 4 = 8 red pips, and the `{1}` is not one.
    expect(byDeck.get(4)).toEqual(pips({ R: 8 }));
  });

  it("adds every cost in a row together rather than keeping the last", () => {
    const byDeck = deckPips(
      rows({
        deckId: 7,
        costs: [
          { cost: "{W}", copies: 1 },
          { cost: "{W}", copies: 2 },
          { cost: "{U}", copies: 3 },
        ],
      }),
    );

    expect(byDeck.get(7)).toEqual(pips({ W: 3, U: 3 }));
  });

  /**
   * **Two rows naming one deck add up**, which is the half a cost-level test cannot see. The
   * query groups by `(deck, cost)` so this is not a shape the backend produces today — which is
   * exactly why the fold looks the deck up before it starts rather than starting fresh per row:
   * a future query that grouped differently, or a merge of two answers, would otherwise keep the
   * last row and silently lose every one before it.
   */
  it("accumulates across two rows naming the same deck", () => {
    const byDeck = deckPips(
      rows(
        { deckId: 7, costs: [{ cost: "{W}", copies: 2 }] },
        { deckId: 7, costs: [{ cost: "{U}", copies: 3 }] },
      ),
    );

    expect(byDeck.get(7)).toEqual(pips({ W: 2, U: 3 }));
  });

  it("keeps each deck's count to itself", () => {
    const byDeck = deckPips(
      rows(
        { deckId: 1, costs: [{ cost: "{G}{G}", copies: 1 }] },
        { deckId: 2, costs: [{ cost: "{B}", copies: 5 }] },
      ),
    );

    expect(byDeck.get(1)).toEqual(pips({ G: 2 }));
    expect(byDeck.get(2)).toEqual(pips({ B: 5 }));
    expect(byDeck.size).toBe(2);
  });

  /**
   * **No entry, not a record of zeroes.** The map is only allowed to say what it was told, and a
   * deck the read never mentioned is one nobody counted — which is also what a read in flight and
   * a read that failed look like from here. A deck that was counted and holds no pips (an
   * all-lands pile) is the other case and *does* get an entry, because a row arrived for it.
   */
  it("leaves a deck it was told nothing about out of the map", () => {
    const byDeck = deckPips(rows({ deckId: 1, costs: [{ cost: "{G}", copies: 1 }] }));

    expect(byDeck.has(2)).toBe(false);
    expect(byDeck.get(2)).toBeUndefined();
  });

  it("gives a deck whose every cost is generic an entry that counts to nothing", () => {
    const byDeck = deckPips(
      rows({
        deckId: 9,
        costs: [
          { cost: "{2}", copies: 4 },
          { cost: "", copies: 20 },
        ],
      }),
    );

    expect(byDeck.has(9)).toBe(true);
    expect(pipTotal(byDeck.get(9) ?? emptyPips())).toBe(0);
  });

  it("answers an empty map for an empty read", () => {
    expect(deckPips([]).size).toBe(0);
  });

  /**
   * Issue #1673: the read answers both lists, each folded into its own map. A deck with an empty
   * Actual list arrives with an empty Actual half, and it must be **absent** from the Actual map — the same
   * "told nothing" as a deck the read never mentioned — rather than a record of zeroes.
   */
  it("folds the plan's half when asked for the theory list, and each half alone", () => {
    const answer = rows(
      { deckId: 1, costs: [{ cost: "{R}", copies: 4 }], theoryCosts: [{ cost: "{U}", copies: 2 }] },
      { deckId: 2, costs: [], theoryCosts: [{ cost: "{G}{G}", copies: 3 }] },
    );

    const live = deckPips(answer);
    const theory = deckPips(answer, "theory");

    expect(live.get(1)).toEqual(pips({ R: 4 }));
    expect(live.has(2)).toBe(false);
    expect(theory.get(1)).toEqual(pips({ U: 2 }));
    expect(theory.get(2)).toEqual(pips({ G: 6 }));
  });
});

/** A gallery row with only the fields {@link tilePips} reads through `tileList` set. */
function deckRow(
  id: number,
  shape: Partial<Pick<DeckRow, "theoryEnabled" | "virtualOnly" | "cardCount" | "lastVariant">>,
): DeckRow {
  return {
    id,
    theoryEnabled: false,
    virtualOnly: false,
    cardCount: 0,
    lastVariant: "live",
    ...shape,
  } as DeckRow;
}

describe("tilePips", () => {
  const live = new Map([[1, pips({ R: 4 })]]);
  const theory = new Map([
    [1, pips({ U: 2 })],
    [2, pips({ G: 6 })],
    [3, pips({ B: 1 })],
  ]);

  /** The chip decides: a theory deck turned to Theory reads the plan, and every other deck its
   *  Actual list — whatever either holds. A regular deck's stale `lastVariant` is never read. */
  it("colours a tile turned to its plan from the plan and every other tile from its cards", () => {
    const decks = [
      deckRow(1, { theoryEnabled: true, cardCount: 4 }),
      deckRow(2, { theoryEnabled: true, cardCount: 0, lastVariant: "theory" }),
      deckRow(3, { cardCount: 0, lastVariant: "theory" }),
    ];

    const byDeck = tilePips(decks, live, theory);

    expect(byDeck.get(1)).toEqual(pips({ R: 4 }));
    expect(byDeck.get(2)).toEqual(pips({ G: 6 }));
    expect(byDeck.has(3)).toBe(false);
  });

  /** The colour sort's memo and every tile hold still on this map's identity. */
  it("hands the Actual map back as it is when no deck on the wall reads its plan", () => {
    const decks = [deckRow(1, { theoryEnabled: true, cardCount: 4 }), deckRow(3, {})];

    expect(tilePips(decks, live, theory)).toBe(live);
  });

  it("draws no bar for a tile turned to a plan with no costs, though its cards have some", () => {
    const decks = [deckRow(1, { theoryEnabled: true, cardCount: 4, lastVariant: "theory" })];
    const planless = new Map<number, ReturnType<typeof pips>>();

    expect(tilePips(decks, live, planless).has(1)).toBe(false);
  });

  /** An empty Actual list is shown as it is — no automatic switch to the plan. */
  it("leaves a theory deck with an empty Actual list on that list until it is turned", () => {
    const decks = [deckRow(2, { theoryEnabled: true, cardCount: 0 })];

    expect(tilePips(decks, live, theory).has(2)).toBe(false);
  });
});

describe("pipTotal", () => {
  it("counts the colourless pips along with the five", () => {
    expect(pipTotal(countPips("{2}{C}{W}"))).toBe(2);
  });

  it("is zero for a deck with nothing to say about colour", () => {
    expect(pipTotal(emptyPips())).toBe(0);
  });
});

describe("pipColors", () => {
  /** WUBRG then colourless — the order the symbols are printed in, which is what makes the bar's
   *  accessible name read the way a player says their deck's colours out loud. */
  it("answers in printed order however the pips arrived", () => {
    const counts = pips({ G: 3, W: 1, U: 2 });

    expect(pipColors(counts)).toEqual(["W", "U", "G"]);
  });

  it("names colourless last and only when there is a colourless pip", () => {
    expect(pipColors(pips({ C: 4, R: 1 }))).toEqual(["R", "C"]);
    expect(pipColors(pips({ R: 1 }))).toEqual(["R"]);
  });

  it("omits a colour with no pips rather than naming it with a zero", () => {
    expect(pipColors(pips({ B: 2 }))).toEqual(["B"]);
    expect(pipColors(emptyPips())).toEqual([]);
  });
});

describe("deckColorsLabel", () => {
  /**
   * The words the tile says after the deck's name, and the reason this function exists at all:
   * the bar draws the colours and cannot name them — anything named inside the tile's `<button>`
   * ahead of the name would read ahead of the deck — so the picture and the sentence are two
   * elements, and this is the one answer they share.
   */
  it("spells the colours present, in printed order", () => {
    expect(deckColorsLabel(pips({ G: 3, W: 1 }))).toBe("White, Green");
    expect(deckColorsLabel(pips({ C: 2, R: 5 }))).toBe("Red, Colorless");
  });

  /** `null` exactly where the bar draws nothing, so a call site cannot render an empty element by
   *  forgetting to check — the read still being out, and a deck with no pips at all. */
  it("answers null for both silences the bar keeps", () => {
    expect(deckColorsLabel(null)).toBeNull();
    expect(deckColorsLabel(emptyPips())).toBeNull();
  });
});
