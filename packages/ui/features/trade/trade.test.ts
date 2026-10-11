import { describe, expect, it } from "vitest";
import {
  balanceHeading,
  balanceLine,
  balanceOf,
  balanceShares,
  cardCount,
  deckNote,
  defaultFinishOptions,
  fromDecks,
  givenNote,
  outcomeSentence,
  receivedNote,
  unwishNote,
  exchangeLine,
  lineMoney,
  sideMoney,
  snapRate,
  takeable,
  toCents,
  tradeMoney,
} from "./trade";

const line = (
  side: "mine" | "theirs",
  quantity: number,
  unitPrice: number | null,
): { side: "mine" | "theirs"; quantity: number; unitPrice: number | null } => ({
  side,
  quantity,
  unitPrice,
});

/** The canvas's own trade: 64.39 against 87.09. */
const CANVAS = [
  line("mine", 1, 42.19),
  line("mine", 2, 3.25),
  line("mine", 1, 4.02),
  line("mine", 2, 5.84),
  line("theirs", 1, 23.85),
  line("theirs", 1, 39.86),
  line("theirs", 1, 19.9),
  line("theirs", 2, 1.74),
];

describe("cents", () => {
  it("turns a quoted price into whole cents, and leaves no price as no price", () => {
    expect(toCents(19.9)).toBe(1990);
    expect(toCents(0.1 + 0.2)).toBe(30);
    expect(toCents(null)).toBeNull();
  });
});

describe("a line", () => {
  it("applies the percentage to one copy and then multiplies", () => {
    // Three copies at 0.05, at 50%: 0.03 a copy is 0.09. Rounding the line once instead would
    // say round(0.15 × 0.5) = 0.08, a cent away from what three of those cards cost.
    expect(lineMoney({ quantity: 3, unitPrice: 0.05 }, 50)).toEqual({
      unit: 3,
      total: 9,
      fullTotal: 15,
    });
    expect(lineMoney({ quantity: 2, unitPrice: 1.74 }, 80)).toEqual({
      unit: 139,
      total: 278,
      fullTotal: 348,
    });
  });

  it("has no figure at all when it has no price", () => {
    expect(lineMoney({ quantity: 4, unitPrice: null }, 80)).toEqual({
      unit: null,
      total: null,
      fullTotal: null,
    });
  });
});

describe("a side", () => {
  it("counts an unpriced line's copies and leaves it out of both totals", () => {
    const side = sideMoney(
      [
        { quantity: 2, unitPrice: 5 },
        { quantity: 3, unitPrice: null },
      ],
      100,
    );
    expect(side).toMatchObject({ total: 1000, fullTotal: 1000, copies: 5, unpriced: 1 });
    expect(side.rated).toBe(false);
  });

  it("is rated only when it is not at 100%", () => {
    expect(sideMoney([], 100).rated).toBe(false);
    expect(sideMoney([], 95).rated).toBe(true);
    expect(sideMoney([], 105).rated).toBe(true);
  });
});

describe("a trade", () => {
  it("adds up to the canvas's figures at 100%", () => {
    const money = tradeMoney({ rateMine: 100, rateTheirs: 100, lines: CANVAS });
    expect(money.mine.total).toBe(6439);
    expect(money.theirs.total).toBe(8709);
    expect(money.mine.copies).toBe(6);
    expect(money.theirs.copies).toBe(5);
    expect(money.balance).toEqual({ kind: "youOwe", cents: 2270 });
  });

  it("adds up to the canvas's figures with their side at 80%", () => {
    const money = tradeMoney({ rateMine: 100, rateTheirs: 80, lines: CANVAS });
    expect(money.theirs.total).toBe(6967);
    expect(money.theirs.fullTotal).toBe(8709);
    expect(money.balance).toEqual({ kind: "youOwe", cents: 528 });
  });
});

describe("the balance", () => {
  it("is owed by whoever gives less", () => {
    expect(balanceOf(100, 100)).toEqual({ kind: "even" });
    expect(balanceOf(100, 250)).toEqual({ kind: "youOwe", cents: 150 });
    expect(balanceOf(250, 100)).toEqual({ kind: "theyOwe", cents: 150 });
  });

  it("is spoken in the past only for a trade that is settled", () => {
    expect(balanceHeading({ kind: "youOwe", cents: 1 }, false)).toBe("You owe them");
    expect(balanceHeading({ kind: "youOwe", cents: 1 }, true)).toBe("You owed them");
    expect(balanceHeading({ kind: "theyOwe", cents: 1 }, false)).toBe("They owe you");
    expect(balanceHeading({ kind: "theyOwe", cents: 1 }, true)).toBe("They owed you");
    expect(balanceHeading({ kind: "even" }, true)).toBe("Nobody owes anything");
    expect(balanceLine({ kind: "youOwe", cents: 2270 }, false, "$22.70")).toBe("You owe $22.70");
    expect(balanceLine({ kind: "theyOwe", cents: 235 }, true, "$2.35")).toBe(
      "They owed you $2.35",
    );
    expect(balanceLine({ kind: "even" }, false, "$0.00")).toBe("Even trade");
  });

  it("draws the gap on the half of whoever owes, and the three widths fill the bar", () => {
    const short = balanceShares(6439, 8709);
    expect(short.mine).toBeLessThan(50);
    expect(short.theirs).toBe(50);
    expect(short.mine + short.gap + short.theirs).toBeCloseTo(100);

    const long = balanceShares(8709, 6439);
    expect(long.mine).toBe(50);
    expect(long.theirs).toBeLessThan(50);
    expect(long.mine + long.gap + long.theirs).toBeCloseTo(100);

    expect(balanceShares(0, 0)).toEqual({ mine: 50, gap: 0, theirs: 50 });
  });
});

describe("the percentage", () => {
  it("snaps to a step of five between 50 and 150", () => {
    expect(snapRate(82)).toBe(80);
    expect(snapRate(83)).toBe(85);
    expect(snapRate(10)).toBe(50);
    expect(snapRate(400)).toBe(150);
    expect(snapRate(Number.NaN)).toBe(100);
  });
});

describe("words", () => {
  it("counts copies", () => {
    expect(cardCount(1)).toBe("1 card");
    expect(cardCount(6)).toBe("6 cards");
    expect(exchangeLine(6, 5)).toBe("6 for 5 cards");
    expect(exchangeLine(2, 1)).toBe("2 for 1 card");
  });

  it("takes out of the collection only what the collection holds", () => {
    expect(takeable({ quantity: 2, owned: 4, ownedInDecks: 0 })).toBe(2);
    expect(takeable({ quantity: 3, owned: 1, ownedInDecks: 0 })).toBe(1);
    expect(takeable({ quantity: 3, owned: 0, ownedInDecks: 0 })).toBe(0);
  });

  it("reaches into a deck only for what the rest of the collection cannot give", () => {
    // Two outside a deck and three in one: a line of two leaves the deck alone, a line of four
    // takes two from it, and a line of nine takes everything there is and no more.
    const held = { owned: 2, ownedInDecks: 3 };
    expect(fromDecks({ quantity: 2, ...held })).toBe(0);
    expect(takeable({ quantity: 4, ...held })).toBe(4);
    expect(fromDecks({ quantity: 4, ...held })).toBe(2);
    expect(takeable({ quantity: 9, ...held })).toBe(5);
    expect(fromDecks({ quantity: 9, ...held })).toBe(3);
  });
});

describe("finishing", () => {
  const fl = (
    side: "mine" | "theirs",
    quantity: number,
    over: Partial<{
      owned: number;
      ownedInDecks: number;
      deckNames: string[];
      wished: number;
      name: string;
    }> = {},
  ) => ({
    side,
    quantity,
    owned: 0,
    ownedInDecks: 0,
    deckNames: [] as string[],
    wished: 0,
    name: "Card",
    ...over,
  });

  it("opens with the tidying steps on, and with everything off the second time", () => {
    expect(defaultFinishOptions({ finishedBefore: false })).toEqual({
      removeGiven: true,
      addReceived: true,
      folderId: null,
      unwishReceived: true,
      wishGiven: false,
    });
    expect(defaultFinishOptions({ finishedBefore: true })).toEqual({
      removeGiven: false,
      addReceived: false,
      folderId: null,
      unwishReceived: false,
      wishGiven: false,
    });
  });

  it("says how many given cards the collection can actually give", () => {
    expect(givenNote([fl("mine", 2, { owned: 4 }), fl("mine", 4, { owned: 4 })])).toBe(
      "6 cards. All of them are in your collection.",
    );
    expect(givenNote([fl("mine", 2, { owned: 1 }), fl("mine", 1, { owned: 0 })])).toBe(
      "3 cards. 1 of them is in your collection; the rest are left alone.",
    );
    expect(givenNote([fl("mine", 2)])).toBe(
      "2 cards. None of them are in your collection, so nothing is taken.",
    );
    expect(givenNote([fl("theirs", 2)])).toBe("There is nothing on your side.");
  });

  it("counts what was received and names what was wished for", () => {
    const lines = [
      fl("theirs", 1, { wished: 1, name: "Urza's Saga" }),
      fl("theirs", 2, { wished: 0, name: "Sol Ring" }),
      fl("theirs", 1, { wished: 2, name: "Tarmogoyf" }),
      fl("mine", 1, { wished: 9, name: "Ragavan" }),
    ];
    expect(receivedNote(lines)).toBe("4 cards, in the printing and finish shown in the trade.");
    expect(unwishNote(lines)).toBe("2 of them are on it: Urza's Saga, Tarmogoyf.");
    expect(unwishNote([fl("theirs", 1)])).toBe("None of them are on your wishlist.");
  });

  it("says what a finish did, and nothing when it did nothing", () => {
    expect(
      outcomeSentence({
        removedFromCollection: 3,
        removedFromDecks: 0,
        addedToCollection: 3,
        removedFromWishlist: 1,
        addedToWishlist: 0,
      }),
    ).toBe(
      "Finishing it took 3 cards out of your collection, added 3 cards to your collection and took 1 card off your wishlist.",
    );
    expect(
      outcomeSentence({
        removedFromCollection: 0,
        removedFromDecks: 0,
        addedToCollection: 0,
        removedFromWishlist: 0,
        addedToWishlist: 0,
      }),
    ).toBeNull();
    expect(outcomeSentence(null)).toBeNull();
  });

  /**
   * The owner asked for this to be impossible to miss: a card that comes out of a deck leaves
   * that deck short, and a finish that does it has to have said so, by name, before the press.
   */
  it("names the decks a finish would take cards out of, and says nothing when it takes none", () => {
    expect(deckNote([fl("mine", 2, { owned: 2, ownedInDecks: 1, deckNames: ["Serah"] })])).toBeNull();
    expect(
      deckNote([fl("mine", 2, { owned: 1, ownedInDecks: 1, deckNames: ["Serah"] })]),
    ).toBe("1 of them comes out of a deck: Serah. That deck will be short of it.");
    expect(
      deckNote([
        fl("mine", 1, { ownedInDecks: 1, deckNames: ["Serah"] }),
        fl("mine", 2, { ownedInDecks: 2, deckNames: ["Azula", "Serah"] }),
        fl("theirs", 1, { ownedInDecks: 4, deckNames: ["Ignored"] }),
      ]),
    ).toBe("3 of them come out of your decks: Serah, Azula. Those decks will be short of them.");
    // One copy of a card two decks hold: only the first deck in line is touched, so only it is named.
    expect(
      deckNote([fl("mine", 1, { ownedInDecks: 2, deckNames: ["Serah", "Azula"] })]),
    ).toBe("1 of them comes out of a deck: Serah. That deck will be short of it.");
    // A deck copy counts as held: the reader has the card, it is only somewhere that costs them.
    expect(givenNote([fl("mine", 1, { ownedInDecks: 1, deckNames: ["Serah"] })])).toBe(
      "1 card. It is in your collection.",
    );
  });

  it("says when a finish took cards out of decks", () => {
    expect(
      outcomeSentence({
        removedFromCollection: 3,
        removedFromDecks: 1,
        addedToCollection: 0,
        removedFromWishlist: 0,
        addedToWishlist: 0,
      }),
    ).toBe("Finishing it took 3 cards out of your collection (1 from a deck).");
  });
});
