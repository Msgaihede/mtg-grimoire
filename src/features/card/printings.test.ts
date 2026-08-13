import { describe, expect, it } from "vitest";
import type { Printing } from "@/lib/ipc";
import {
  buildPrintingGroups,
  cheapestPrice,
  faceCount,
  groupByIllustration,
  isPrintingGroupBy,
  legalityChips,
} from "./printings";

const printing = (over: Partial<Printing>): Printing => ({
  id: "p",
  setCode: "lea",
  setName: "Limited Edition Alpha",
  collectorNumber: "161",
  releasedAt: "1993-08-05",
  rarity: "common",
  illustrationId: "art-a",
  artist: "Christopher Rush",
  lang: "en",
  finishes: '["nonfoil"]',
  finishPrices: { nonfoil: 5.0, foil: null, etched: null },
  promo: false,
  fullArt: false,
  frameEffects: null,
  borderColor: "black",
  layout: "normal",
  ...over,
});

describe("groupByIllustration", () => {
  it("puts printings that share artwork together, in first-seen order", () => {
    const groups = groupByIllustration([
      printing({ id: "a", illustrationId: "art-b" }),
      printing({ id: "b", illustrationId: "art-a" }),
      printing({ id: "c", illustrationId: "art-b" }),
    ]);

    expect(groups.map((g) => g.illustrationId)).toEqual(["art-b", "art-a"]);
    expect(groups[0].printings.map((p) => p.id)).toEqual(["a", "c"]);
  });

  /**
   * "Newly spoiled cards may not have this field yet", so a null illustration is a real
   * case. Every one of them is its own group: lumping them together would claim a set of
   * unrelated cards share artwork.
   */
  it("never merges printings that have no illustration id", () => {
    const groups = groupByIllustration([
      printing({ id: "a", illustrationId: null }),
      printing({ id: "b", illustrationId: null }),
    ]);

    expect(groups).toHaveLength(2);
  });
});

describe("buildPrintingGroups: artist", () => {
  /**
   * The deliberate behaviour change. `groupByIllustration` splits on the artwork, so an artist
   * who drew the card twice got two groups with the *same* heading — which reads as a bug in
   * the pane whatever the reason for it. The illustration grouping is still there and still
   * right for the question it answers ("how many artworks are there?"), which is why both are
   * asserted on one input.
   */
  it("merges two artworks by one artist, where the illustration grouping made two groups", () => {
    const list = [
      printing({ id: "a", artist: "Rebecca Guay", illustrationId: "art-a" }),
      printing({ id: "b", artist: "Rebecca Guay", illustrationId: "art-b" }),
    ];

    expect(groupByIllustration(list)).toHaveLength(2);
    expect(buildPrintingGroups(list, "artist")).toHaveLength(1);
  });

  /**
   * Alphabetical *and case-insensitive*: a plain code-unit sort puts every capital before
   * every lower-case letter, so "Christopher Rush" would come before "alan pollack".
   */
  it("orders artists alphabetically whatever their case, with the unattributed last", () => {
    const groups = buildPrintingGroups(
      [
        printing({ id: "a", artist: "Rebecca Guay" }),
        printing({ id: "b", artist: null }),
        printing({ id: "c", artist: "Christopher Rush" }),
        printing({ id: "d", artist: "alan pollack" }),
        printing({ id: "e", artist: null }),
      ],
      "artist",
    );

    expect(groups.map((g) => g.heading)).toEqual([
      "alan pollack",
      "Christopher Rush",
      "Rebecca Guay",
      "Artist unknown",
    ]);
    // One group for all of them, not one each — unlike a null illustration id, a missing
    // credit claims nothing about the cards sharing anything.
    expect(groups[3].printings.map((p) => p.id)).toEqual(["b", "e"]);
  });

  /** Rust's order is `released_at DESC` — inside a group it is the whole ordering. */
  it("keeps the incoming order inside a group", () => {
    const groups = buildPrintingGroups(
      [
        printing({ id: "new", artist: "Rebecca Guay", releasedAt: "2020-01-01" }),
        printing({ id: "old", artist: "Rebecca Guay", releasedAt: "1997-06-09" }),
      ],
      "artist",
    );

    expect(groups[0].printings.map((p) => p.id)).toEqual(["new", "old"]);
  });
});

describe("buildPrintingGroups: released", () => {
  it("makes one group per distinct date, newest first, undated last", () => {
    const groups = buildPrintingGroups(
      [
        printing({ id: "a", releasedAt: "1994-04-11" }),
        printing({ id: "b", releasedAt: null }),
        printing({ id: "c", releasedAt: "1993-08-05" }),
        printing({ id: "d", releasedAt: "1993-08-05" }),
      ],
      "released",
    );

    expect(groups.map((g) => g.heading)).toEqual([
      "11 Apr 1994",
      "5 Aug 1993",
      "Release date unknown",
    ]);
    expect(groups[1].printings.map((p) => p.id)).toEqual(["c", "d"]);
  });

  /**
   * The exact string, because the heading is built with an explicit `en-GB` locale and an
   * explicit UTC time zone and both are load-bearing. Note what this assertion can and cannot
   * see: the locale half fails anywhere the host default is not English, but the **UTC** half
   * only bites west of Greenwich — a machine on a negative offset renders midnight-UTC of the
   * 5th as the evening of the 4th, and every card in the game is dated a day early. It cannot
   * be provoked from here, since `Intl` reads the zone when the formatter is constructed.
   */
  it("formats a date the same way on every machine", () => {
    const groups = buildPrintingGroups([printing({ releasedAt: "1993-08-05" })], "released");

    expect(groups[0].heading).toBe("5 Aug 1993");
  });

  /** A corrupt date is shown as it arrived. `"Invalid Date"` in a heading is worse than useless. */
  it("falls back to the raw string when the date will not parse", () => {
    const groups = buildPrintingGroups([printing({ releasedAt: "1993-13-45" })], "released");

    expect(groups[0].heading).toBe("1993-13-45");
  });
});

describe("buildPrintingGroups: price", () => {
  /** `e` is cheapest on its *foil* and `c` is priced in nothing else — the reason the sort key
   *  is a minimum across finishes rather than the nonfoil column. */
  it("puts every printing in one unheaded list, cheapest finish first", () => {
    const groups = buildPrintingGroups(
      [
        printing({ id: "a", finishPrices: { nonfoil: 12, foil: null, etched: null } }),
        printing({ id: "c", finishPrices: { nonfoil: null, foil: 3.5, etched: null } }),
        printing({ id: "e", finishPrices: { nonfoil: 30, foil: 2, etched: null } }),
      ],
      "price",
    );

    expect(groups).toHaveLength(1);
    expect(groups[0].heading).toBeNull();
    expect(groups[0].printings.map((p) => p.id)).toEqual(["e", "c", "a"]);
  });

  /** Unpriced is not free: a null sinks, and the tail stays in the order Rust sent it. */
  it("sinks the unpriced to the bottom, keeping their incoming order", () => {
    const unpriced = { nonfoil: null, foil: null, etched: null };
    const groups = buildPrintingGroups(
      [
        printing({ id: "b", finishPrices: unpriced }),
        printing({ id: "a", finishPrices: { nonfoil: 12, foil: null, etched: null } }),
        printing({ id: "d", finishPrices: unpriced }),
      ],
      "price",
    );

    expect(groups[0].printings.map((p) => p.id)).toEqual(["a", "b", "d"]);
  });

  /** Not one group holding nothing — that is a heading-less wrapper the pane would still draw,
   *  in place of its own "no printings" line. */
  it("answers no groups at all for an empty list", () => {
    expect(buildPrintingGroups([], "price")).toEqual([]);
  });

  /** The list belongs to the query cache; sorting it in place would reorder it for every other
   *  reader of the same data, including the mode the reader switches back to. */
  it("never sorts the caller's array", () => {
    const list = [
      printing({ id: "a", finishPrices: { nonfoil: 12, foil: null, etched: null } }),
      printing({ id: "b", finishPrices: { nonfoil: 1, foil: null, etched: null } }),
    ];

    buildPrintingGroups(list, "price");

    expect(list.map((p) => p.id)).toEqual(["a", "b"]);
  });
});

describe("buildPrintingGroups: set", () => {
  /**
   * A set has no release date of its own on `Printing`, so it is the earliest of its cards'.
   * The fixture is the case that makes the difference: Dominaria's promo is dated after Core
   * Set 2019 shipped, and it arrives *first* because Rust sorts `released_at DESC` — so a set
   * dated by its first-seen or its latest printing would sort Dominaria above the newer set.
   */
  it("orders sets by their earliest printing, newest set first", () => {
    const groups = buildPrintingGroups(
      [
        printing({ id: "promo", setCode: "dom", setName: "Dominaria", releasedAt: "2018-08-01" }),
        printing({ id: "m19", setCode: "m19", setName: "Core Set 2019", releasedAt: "2018-07-13" }),
        printing({ id: "main", setCode: "dom", setName: "Dominaria", releasedAt: "2018-04-27" }),
      ],
      "set",
    );

    expect(groups.map((g) => g.heading)).toEqual(["Core Set 2019", "Dominaria"]);
    expect(groups[1].printings.map((p) => p.id)).toEqual(["promo", "main"]);
  });

  /** Same-day sets are broken by code so the answer never depends on which Rust listed first,
   *  and a set no card of which carries a date goes last rather than to the top. */
  it("breaks a tie by set code and sorts an undated set last", () => {
    const groups = buildPrintingGroups(
      [
        printing({ id: "u", setCode: "und", setName: "Undated", releasedAt: null }),
        printing({ id: "z", setCode: "zzz", setName: "Zed", releasedAt: "2020-01-01" }),
        printing({ id: "a", setCode: "aaa", setName: "Aay", releasedAt: "2020-01-01" }),
      ],
      "set",
    );

    expect(groups.map((g) => g.heading)).toEqual(["Aay", "Zed", "Undated"]);
  });

  /** `setName` is nullable per row, and a three-letter code is what a player calls a set. */
  it("heads a set by its upper-cased code when the name is missing", () => {
    const groups = buildPrintingGroups([printing({ setCode: "plst", setName: null })], "set");

    expect(groups[0].heading).toBe("PLST");
  });
});

describe("cheapestPrice", () => {
  it("is null when no finish is priced", () => {
    expect(cheapestPrice({ nonfoil: null, foil: null, etched: null })).toBeNull();
  });

  it("takes the minimum across the three finishes", () => {
    expect(cheapestPrice({ nonfoil: 12, foil: 3.5, etched: 40 })).toBe(3.5);
    expect(cheapestPrice({ nonfoil: null, foil: null, etched: 0.25 })).toBe(0.25);
  });

  /**
   * These figures come from bulk pricelists, not from Scryfall's own blob. A `-1` or a `NaN`
   * that reached the comparator would sort a garbage row to the very top of the price list —
   * the most visible place in the pane a bad feed row could land.
   */
  it("treats a negative or non-numeric figure as no price at all", () => {
    expect(cheapestPrice({ nonfoil: -1, foil: Number.NaN, etched: 4 })).toBe(4);
    expect(cheapestPrice({ nonfoil: -1, foil: Number.NaN, etched: null })).toBeNull();
  });
});

describe("isPrintingGroupBy", () => {
  /** The value round-trips through storage and a `<select>`, so a mode that was renamed or
   *  dropped can still arrive here years later. */
  it("rejects a string that is not a mode", () => {
    expect(isPrintingGroupBy("artist")).toBe(true);
    expect(isPrintingGroupBy("set")).toBe(true);
    expect(isPrintingGroupBy("illustration")).toBe(false);
    expect(isPrintingGroupBy("")).toBe(false);
  });
});

describe("legalityChips", () => {
  it("shows only the formats the card is playable or banned in, in a fixed order", () => {
    const chips = legalityChips(
      '{"modern":"legal","standard":"not_legal","vintage":"restricted","commander":"banned"}',
    );

    expect(chips).toEqual([
      { format: "modern", status: "legal" },
      { format: "vintage", status: "restricted" },
      { format: "commander", status: "banned" },
    ]);
  });

  /** The key set GROWS — `tlr` is newer than most published field lists. An unknown key
   *  is rendered at the end, never dropped. */
  it("keeps a format it has never heard of", () => {
    const chips = legalityChips('{"modern":"legal","newformat":"legal"}');

    expect(chips.map((c) => c.format)).toEqual(["modern", "newformat"]);
  });

  it("survives an absent blob", () => {
    expect(legalityChips(null)).toEqual([]);
  });
});

describe("faceCount", () => {
  it("counts two sides only for the layouts that physically have them", () => {
    expect(faceCount("transform", 2)).toBe(2);
    expect(faceCount("modal_dfc", 2)).toBe(2);
    expect(faceCount("reversible_card", 2)).toBe(2);
    // Two faces, one physical side: the back of a split card is a normal Magic back.
    expect(faceCount("split", 2)).toBe(1);
    expect(faceCount("adventure", 2)).toBe(1);
    expect(faceCount("flip", 2)).toBe(1);
    // `meld` has top-level images and no `card_faces` at all.
    expect(faceCount("meld", 0)).toBe(1);
    expect(faceCount("normal", 0)).toBe(1);
  });

  /**
   * A two-sided layout that arrived with one face — a malformed or partially ingested row
   * — must not offer a flip: `card.faces[1]` is `undefined`, and the control would name a
   * face that is not there and swap to an image the protocol answers with a card back.
   */
  it("needs both faces present, not just a layout that usually has them", () => {
    expect(faceCount("transform", 1)).toBe(1);
    expect(faceCount("transform", 0)).toBe(1);
  });
});
