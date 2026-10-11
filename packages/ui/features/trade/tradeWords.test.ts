import { describe, expect, it } from "vitest";
import type { TradeStatus, TradeSummary, TradeSummaryLine } from "@/lib/ipc";
import { MARKETPLACES } from "@/lib/marketplace";
import { tradeMoney } from "./trade";
import {
  DECK_COPIES_HEADING,
  DECK_COPIES_WARNING,
  closedBanner,
  deckHolding,
  defaultTradeId,
  fullPriceNote,
  givenMark,
  headerLine,
  listLine,
  newTradeMarketplace,
  nextTradeName,
  printingLabel,
  printingLine,
  rateLabel,
  rateName,
  sideHeading,
  tradeCurrency,
  tradeDay,
  tradeMarketplaceOffers,
  tradeUnpricedNote,
  unpricedNote,
} from "./tradeWords";

/** Midday UTC: the same calendar day in every time zone a suite runs in. */
const day = (year: number, month: number, date: number) =>
  Date.UTC(year, month - 1, date, 12) / 1000;

function summary(over: Partial<TradeSummary> = {}): TradeSummary {
  return {
    id: 1,
    name: "Trade 1",
    marketplace: "tcgplayer",
    rateMine: 100,
    rateTheirs: 100,
    status: "open",
    createdAt: day(2026, 10, 2),
    closedAt: null,
    lines: [],
    ...over,
  };
}

const copies = (side: TradeSummaryLine["side"], quantity: number): TradeSummaryLine => ({
  side,
  quantity,
  unitPrice: 1,
});

describe("tradeDay", () => {
  it("writes the day first and the month in three letters", () => {
    expect(tradeDay(day(2026, 10, 2))).toBe("2 Oct");
    expect(tradeDay(day(2026, 10, 2), true)).toBe("2 Oct 2026");
  });

  it("writes September in three letters too, where en-GB would write four", () => {
    expect(tradeDay(day(2026, 9, 19))).toBe("19 Sep");
  });
});

describe("listLine", () => {
  it("says when an open trade was opened and how many cards go each way", () => {
    const trade = summary({
      lines: [copies("mine", 1), copies("mine", 5), copies("theirs", 2), copies("theirs", 3)],
    });

    expect(listLine(trade)).toBe("Opened 2 Oct · 6 for 5 cards");
  });

  it("counts one card as one card", () => {
    expect(listLine(summary({ lines: [copies("mine", 2), copies("theirs", 1)] }))).toBe(
      "Opened 2 Oct · 2 for 1 card",
    );
  });

  it("dates a finished trade by the day it was finished, not the day it was opened", () => {
    const trade = summary({
      status: "finished",
      closedAt: day(2026, 9, 6),
      lines: [copies("mine", 3), copies("theirs", 3)],
    });

    expect(listLine(trade)).toBe("Finished 6 Sep · 3 for 3 cards");
  });

  it("says an archived trade was not finished, which is what tells it from a finished one", () => {
    const trade = summary({
      status: "archived",
      closedAt: day(2026, 8, 23),
      lines: [copies("mine", 1), copies("theirs", 2)],
    });

    expect(listLine(trade)).toBe("Archived 23 Aug · not finished");
  });
});

describe("headerLine", () => {
  it("names the trade's own marketplace and money, and that there is no Save", () => {
    expect(headerLine(summary())).toBe(
      "Opened 2 Oct 2026 · TCGplayer prices, USD · Saved as you go",
    );
    expect(headerLine(summary({ marketplace: "cardmarket" }))).toBe(
      "Opened 2 Oct 2026 · Cardmarket prices, EUR · Saved as you go",
    );
  });

  it("says a closed trade's prices are the ones it closed with", () => {
    expect(headerLine(summary({ status: "finished", closedAt: day(2026, 9, 6) }))).toBe(
      "Finished 6 Sep 2026 · Prices kept from that day, in USD",
    );
    expect(
      headerLine(
        summary({ status: "archived", closedAt: day(2026, 8, 23), marketplace: "cardmarket" }),
      ),
    ).toBe("Archived 23 Aug 2026 · Prices kept from that day, in EUR");
  });
});

describe("tradeCurrency", () => {
  it("is the trade's marketplace's, whatever the app is set to", () => {
    expect(tradeCurrency({ marketplace: "cardmarket" })).toBe("eur");
    expect(tradeCurrency({ marketplace: "manapool" })).toBe("usd");
  });
});

describe("closedBanner", () => {
  it("says what a finish did", () => {
    const outcome = {
      removedFromCollection: 3,
      removedFromDecks: 0,
      addedToCollection: 3,
      removedFromWishlist: 1,
      addedToWishlist: 0,
    };

    expect(closedBanner({ status: "finished", outcome })).toBe(
      "Finished and archived, so nothing here can be edited. Finishing it took 3 cards out of " +
        "your collection, added 3 cards to your collection and took 1 card off your wishlist.",
    );
  });

  it("says so when a finish moved nothing, rather than saying nothing", () => {
    const nothing = {
      removedFromCollection: 0,
      removedFromDecks: 0,
      addedToCollection: 0,
      removedFromWishlist: 0,
      addedToWishlist: 0,
    };
    const said =
      "Finished and archived, so nothing here can be edited. " +
      "Finishing it changed nothing in your collection or your wishlist.";

    expect(closedBanner({ status: "finished", outcome: nothing })).toBe(said);
    expect(closedBanner({ status: "finished", outcome: null })).toBe(said);
  });

  it("says an archived trade was put away and that doing so moved nothing", () => {
    expect(closedBanner({ status: "archived", outcome: null })).toBe(
      "Archived without finishing, so nothing here can be edited. " +
        "Archiving it changed nothing in your collection or your wishlist.",
    );
  });
});

describe("sideHeading", () => {
  it("is in the past tense only once the cards have changed hands", () => {
    const headings = (status: TradeStatus) => [
      sideHeading("mine", status),
      sideHeading("theirs", status),
    ];

    expect(headings("open")).toEqual(["You give", "They give"]);
    expect(headings("finished")).toEqual(["You gave", "They gave"]);
    // Archived unfinished: nothing was given.
    expect(headings("archived")).toEqual(["You give", "They give"]);
  });
});

describe("the small labels", () => {
  it("writes a percentage, a printing, and a printing with its finish", () => {
    expect(rateLabel(80)).toBe("80% of market");
    expect(printingLabel("mh2", "138")).toBe("MH2 · 138");
    expect(printingLine("ema", "32", "foil")).toBe("EMA 32 · Foil");
  });
});

describe("nextTradeName", () => {
  it("guesses one past the newest id, and Trade 1 when there are none", () => {
    expect(nextTradeName([{ id: 5 }, { id: 4 }, { id: 2 }])).toBe("Trade 6");
    expect(nextTradeName([])).toBe("Trade 1");
  });
});

describe("defaultTradeId", () => {
  it("is the newest open trade, even under a newer closed one", () => {
    expect(
      defaultTradeId([
        { id: 9, status: "finished" },
        { id: 5, status: "open" },
        { id: 4, status: "open" },
      ]),
    ).toBe(5);
  });

  it("is the newest trade of any kind when none is open, and nothing when there are none", () => {
    expect(
      defaultTradeId([
        { id: 9, status: "archived" },
        { id: 3, status: "finished" },
      ]),
    ).toBe(9);
    expect(defaultTradeId([])).toBeNull();
  });
});

describe("rateName", () => {
  it("names whose price it is and what it is, so the value is never only drawn", () => {
    expect(rateName("mine", 100)).toBe("Price for your cards: 100%");
    expect(rateName("theirs", 80)).toBe("Price for their cards: 80%");
  });
});

describe("what a total leaves out", () => {
  it("says how many lines have no price, and nothing when every line has one", () => {
    expect(unpricedNote(2)).toBe("2 without a price");
    expect(unpricedNote(1)).toBe("1 without a price");
    expect(unpricedNote(0)).toBeNull();
  });

  it("counts both sides for a trade's row in the list", () => {
    const line = (side: TradeSummaryLine["side"], unitPrice: number | null): TradeSummaryLine => ({
      side,
      quantity: 2,
      unitPrice,
    });
    const priced = summary({ lines: [line("mine", 1), line("theirs", 1)] });
    const holes = summary({
      lines: [line("mine", null), line("mine", 1), line("theirs", null), line("theirs", null)],
    });

    expect(tradeUnpricedNote(tradeMoney(priced))).toBeNull();
    // Lines, not copies: three lines of two cards each are three things with no price.
    expect(tradeUnpricedNote(tradeMoney(holes))).toBe("3 without a price");
  });

  it("words a rated side's full figure", () => {
    expect(fullPriceNote("$87.09")).toBe("$87.09 at 100%");
  });
});

/**
 * A copy that comes out of a deck is the one thing a trade costs that nobody put on the table, so
 * the line that would take one says so — in the destructive colour on both faces, and in these
 * words. The colour is the caller's; which mark it is, and what it says, is decided here.
 */
describe("givenMark", () => {
  type Given = Parameters<typeof givenMark>[0];
  const given = (over: Partial<Given> = {}): Given => ({
    side: "mine",
    source: "collection",
    quantity: 1,
    owned: 1,
    ownedInDecks: 0,
    deckNames: [],
    ...over,
  });

  it("is the gold mark while every copy comes from outside the reader's decks", () => {
    const gold = { place: "collection", words: "from your collection" };
    expect(givenMark(given(), true)).toEqual(gold);
    // A deck holds another copy, and the line does not ask for it.
    expect(givenMark(given({ ownedInDecks: 1, deckNames: ["Serah"] }), true)).toEqual(gold);
    // A line that asks for more than exists anywhere takes what there is, and no deck has any.
    expect(givenMark(given({ quantity: 4 }), true)).toEqual(gold);
  });

  it("is nothing for a line that came from a search or a scan and touches no deck", () => {
    expect(givenMark(given({ source: "search" }), true)).toBeNull();
    expect(givenMark(given({ source: "scan", owned: 0 }), true)).toBeNull();
  });

  it("turns to the deck's mark as the quantity crosses what is held outside decks", () => {
    const held = { owned: 1, ownedInDecks: 2, deckNames: ["Serah", "Azula"] };
    expect(givenMark(given({ ...held, quantity: 1 }), true)?.place).toBe("collection");
    expect(givenMark(given({ ...held, quantity: 2 }), true)).toEqual({
      place: "deck",
      // One copy comes out of the first deck a finish empties, and the second is left alone.
      words: "1 from your deck Serah",
    });
    expect(givenMark(given({ ...held, quantity: 3 }), true)).toEqual({
      place: "deck",
      words: "2 from your decks Serah, Azula",
    });
    // Past everything the reader holds: still the two a finish can take, and no more.
    expect(givenMark(given({ ...held, quantity: 9 }), true)?.words).toBe(
      "2 from your decks Serah, Azula",
    );
  });

  it("drops the count where the whole line comes out of decks", () => {
    expect(
      givenMark(given({ owned: 0, ownedInDecks: 1, deckNames: ["Serah"] }), true)?.words,
    ).toBe("from your deck Serah");
    expect(
      givenMark(
        given({ quantity: 2, owned: 0, ownedInDecks: 2, deckNames: ["Serah", "Azula"] }),
        true,
      )?.words,
    ).toBe("from your decks Serah, Azula");
  });

  it("marks a line that was searched for or scanned: a finish asks no line where it came from", () => {
    expect(
      givenMark(given({ source: "scan", owned: 0, ownedInDecks: 1, deckNames: ["Serah"] }), true),
    ).toEqual({ place: "deck", words: "from your deck Serah" });
  });

  it("still warns where the decks arrive without a name", () => {
    expect(givenMark(given({ owned: 0, ownedInDecks: 1 }), true)?.words).toBe("from a deck");
  });

  /**
   * `owned` and `ownedInDecks` are computed for both sides: a card they are giving that the reader
   * happens to hold in a deck arrives with `ownedInDecks: 1`. Nothing is ever taken for it.
   */
  it("never marks a card on their side, whatever the reader holds of it", () => {
    const theirs = given({ side: "theirs", owned: 0, ownedInDecks: 1, deckNames: ["Serah"] });
    expect(givenMark(theirs, true)).toBeNull();
    expect(givenMark({ ...theirs, owned: 3 }, true)).toBeNull();
  });

  /**
   * The facts are live on a closed trade too, so there they say what *another* finish would take
   * — a deck that had two copies still has one. The line is a record: it keeps where it came from.
   */
  it("keeps to where the line came from once the trade is closed", () => {
    const dips = given({ owned: 0, ownedInDecks: 1, deckNames: ["Serah"] });
    expect(givenMark(dips, false)).toEqual({ place: "collection", words: "from your collection" });
    expect(givenMark({ ...dips, source: "search" }, false)).toBeNull();
  });
});

describe("the add field's deck section", () => {
  it("counts a deck's copies under the deck's name", () => {
    expect(deckHolding(1, "Serah")).toBe("1 in Serah");
    expect(deckHolding(3, "Modern Goodstuff")).toBe("3 in Modern Goodstuff");
  });

  it("is headed in words that do not need the colour, and says when a deck loses the card", () => {
    expect(DECK_COPIES_HEADING).toBe("In your decks");
    expect(DECK_COPIES_WARNING).toMatch(/out of their decks/);
    expect(DECK_COPIES_WARNING).toMatch(/once your copies outside any deck have run out/);
  });
});

/**
 * Card Kingdom's and Mana Pool's prices are downloads, fetched and refreshed for the marketplace
 * the app is set to and for no other. A trade in one of them made while the app quotes something
 * else has no prices, or months-old ones — so each is offered only while it is the app's own.
 */
describe("tradeMarketplaceOffers", () => {
  const offered = (current: keyof typeof MARKETPLACES) =>
    tradeMarketplaceOffers(MARKETPLACES[current]).map(
      ({ marketplace, reason }) => [marketplace.id, reason] as const,
    );
  const CK = "Switch the app to Card Kingdom in Settings to trade in its prices.";
  const MP = "Switch the app to Mana Pool in Settings to trade in its prices.";

  it("offers only the two that come with the card data while the app is on one of them", () => {
    const both = [
      ["tcgplayer", null],
      ["cardmarket", null],
      ["cardkingdom", CK],
      ["manapool", MP],
    ];
    expect(offered("tcgplayer")).toEqual(both);
    expect(offered("cardmarket")).toEqual(both);
    // A marketplace with no prices at all is never in the list, and changes nothing about it.
    expect(offered("cardtrader")).toEqual(both);
  });

  it("offers a feed while the app is set to it, and never the other one", () => {
    expect(offered("cardkingdom")).toEqual([
      ["tcgplayer", null],
      ["cardmarket", null],
      ["cardkingdom", null],
      ["manapool", MP],
    ]);
    expect(offered("manapool")).toEqual([
      ["tcgplayer", null],
      ["cardmarket", null],
      ["cardkingdom", CK],
      ["manapool", null],
    ]);
  });

  it("opens on the app's own marketplace, which is always one it offers", () => {
    for (const id of ["tcgplayer", "cardmarket", "cardkingdom", "manapool"] as const) {
      const opening = newTradeMarketplace(MARKETPLACES[id]);
      expect(opening).toBe(id);
      expect(offered(id).find(([offer]) => offer === opening)?.[1]).toBeNull();
    }
    expect(newTradeMarketplace(MARKETPLACES.cardtrader)).toBe("tcgplayer");
  });
});
