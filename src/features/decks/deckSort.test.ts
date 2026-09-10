import { describe, expect, it } from "vitest";
import { countPips, type PipCounts } from "@/lib/mana";
import type { DeckRow } from "@/lib/ipc";
import {
  DECK_SORT_OPTIONS,
  DEFAULT_DECK_SORT,
  NATURAL_DESC,
  formatDeckSort,
  parseDeckSort,
  sortDecks,
  type DeckSortKey,
} from "./deckSort";

/**
 * The four properties the gallery's order has to have — total, stable, copying, and reversible as
 * a whole — get a test each below, and each of them is a property rather than a case: a
 * comparator can be right about the deck in front of it and wrong about all four.
 */

let nextId = 1;

/**
 * One `deck_list` row. Every field is the schema's default except the ones a sort reads, so a
 * test that says nothing about a field is a test that does not depend on it.
 */
function deck(over: Partial<DeckRow> & { name: string }): DeckRow {
  return {
    id: nextId++,
    formatKey: "commander",
    formatName: "Commander",
    gameKey: "any",
    description: null,
    coverCardId: null,
    coverKind: "card_art",
    coverArtist: null,
    archived: false,
    cardCount: 100,
    updatedAt: 1_800_000_000,
    folderId: null,
    notes: null,
    theoryEnabled: false,
    virtualOnly: false,
    theoryMarkExact: true,
    theoryMarkName: true,
    theoryMarkUnplanned: true,
    lastVariant: "live",
    lastGroupBy: "category",
    lastSortBy: "alphabetical",
    separateXGroup: false,
    defaultCategoryId: 0,
    bracket: 0,
    tokensOpen: false,
    statsOpen: true,
    ...over,
  };
}

/** The empty context — no pips answered, no brackets answered. What the gallery's first paint
 *  holds, and what every comparator has to survive. */
const NOTHING = { pips: new Map<number, PipCounts>(), brackets: new Map<number, number>() };

function ctx(
  pips: Record<number, PipCounts> = {},
  brackets: Record<number, number> = {},
): { pips: Map<number, PipCounts>; brackets: Map<number, number> } {
  return {
    pips: new Map(Object.entries(pips).map(([id, counts]) => [Number(id), counts])),
    brackets: new Map(Object.entries(brackets).map(([id, floor]) => [Number(id), floor])),
  };
}

const names = (decks: readonly DeckRow[]) => decks.map((d) => d.name);

describe("sortDecks — updated", () => {
  /** Today's order and the default: `deck_list` answers most recently touched first, and the
   *  gallery a reader knows is the gallery they get until they press something. */
  it("puts the most recently touched first, and breaks a tie on id", () => {
    const decks = [
      deck({ id: 1, name: "Old", updatedAt: 100 }),
      deck({ id: 2, name: "Same second, made first", updatedAt: 200 }),
      deck({ id: 5, name: "Same second, made later", updatedAt: 200 }),
    ];

    expect(names(sortDecks(decks, DEFAULT_DECK_SORT, NOTHING))).toEqual([
      "Same second, made later",
      "Same second, made first",
      "Old",
    ]);
  });

  it("reads oldest first with the direction turned round", () => {
    const decks = [
      deck({ id: 1, name: "Old", updatedAt: 100 }),
      deck({ id: 2, name: "New", updatedAt: 200 }),
    ];

    expect(names(sortDecks(decks, { key: "updated", desc: false }, NOTHING))).toEqual([
      "Old",
      "New",
    ]);
  });
});

describe("sortDecks — name", () => {
  /**
   * The app collator, which folds case and accents: a wall that put every capitalised deck above
   * every lower-case one would be sorting by a keyboard rather than by a name.
   */
  it("orders by the words on the tile, case and accents folded", () => {
    const decks = [
      deck({ name: "Élan" }),
      deck({ name: "Burn" }),
      deck({ name: "arclight" }),
      deck({ name: "Set 10" }),
      deck({ name: "Set 2" }),
    ];

    expect(names(sortDecks(decks, { key: "name", desc: false }, NOTHING))).toEqual([
      "arclight",
      "Burn",
      "Élan",
      "Set 2",
      "Set 10",
    ]);
  });

  /** Two names the collator cannot separate are still two decks, and the id is what tells them
   *  apart — a reader with `Burn` and `burn` should get a stable order, not a coin toss. */
  it("breaks a collation tie on id", () => {
    const decks = [deck({ id: 9, name: "burn" }), deck({ id: 3, name: "Burn" })];

    expect(sortDecks(decks, { key: "name", desc: false }, NOTHING).map((d) => d.id)).toEqual([
      3, 9,
    ]);
  });
});

describe("sortDecks — colors", () => {
  /**
   * The plan's order in one list: mono W→U→B→R→G, then multicolour by colour count and then by
   * the printed order of the pair, then colourless, then the decks nothing is known about.
   *
   * `WG` before `UB` is the case that pins the mask's direction. Sorting the mask ascending, or
   * putting `W` in the low bit, splits a guild pair across the whole multicolour block.
   */
  it("reads mono in printed order, then multicolour, then colourless, then the unknown", () => {
    const mono = deck({ id: 1, name: "Mono white" });
    const monoG = deck({ id: 2, name: "Mono green" });
    const azorius = deck({ id: 3, name: "Azorius" });
    const selesnya = deck({ id: 4, name: "Selesnya" });
    const dimir = deck({ id: 5, name: "Dimir" });
    const naya = deck({ id: 6, name: "Naya" });
    const eldrazi = deck({ id: 7, name: "Eldrazi" });
    const lands = deck({ id: 8, name: "Not counted yet" });

    const order = sortDecks(
      [lands, eldrazi, naya, dimir, selesnya, azorius, monoG, mono],
      { key: "colors", desc: false },
      ctx({
        1: countPips("{W}"),
        2: countPips("{G}"),
        3: countPips("{W}{U}"),
        4: countPips("{W}{G}"),
        5: countPips("{U}{B}"),
        6: countPips("{R}{G}{W}"),
        7: countPips("{C}{C}"),
      }),
    );

    expect(names(order)).toEqual([
      "Mono white",
      "Mono green",
      "Azorius",
      "Selesnya",
      "Dimir",
      "Naya",
      "Eldrazi",
      "Not counted yet",
    ]);
  });

  /** A hybrid is one pip of each half, so a deck of nothing but `{W/U}` is Azorius here — the
   *  bar's own reading, and the sort must not have a second one. */
  it("reads a hybrid deck as both of its colours", () => {
    const hybrid = deck({ id: 1, name: "Hybrid" });
    const monoW = deck({ id: 2, name: "Mono white" });

    const order = sortDecks(
      [hybrid, monoW],
      { key: "colors", desc: false },
      ctx({ 1: countPips("{W/U}"), 2: countPips("{W}") }),
    );

    expect(names(order)).toEqual(["Mono white", "Hybrid"]);
  });

  it("breaks a tie between two decks of one colour on name", () => {
    const decks = [deck({ id: 1, name: "Zombies" }), deck({ id: 2, name: "Angels" })];

    const order = sortDecks(
      decks,
      { key: "colors", desc: false },
      ctx({ 1: countPips("{B}"), 2: countPips("{B}") }),
    );

    expect(names(order)).toEqual(["Angels", "Zombies"]);
  });
});

describe("sortDecks — bracket", () => {
  /**
   * One ladder for both kinds of answer. A reader ordering by bracket is asking which decks are
   * heavier, and splitting the wall into "declared" and "estimated" would answer a question they
   * did not ask — the `~` on the tile is where that distinction is drawn.
   */
  it("ranks a set bracket and an estimate together, lowest first", () => {
    const decks = [
      deck({ id: 1, name: "Set to four", bracket: 4 }),
      deck({ id: 2, name: "Reads as two" }),
      deck({ id: 3, name: "Reads as three" }),
    ];

    expect(
      names(sortDecks(decks, { key: "bracket", desc: false }, ctx({}, { 2: 2, 3: 3 }))),
    ).toEqual(["Reads as two", "Reads as three", "Set to four"]);
  });

  /** The reader's own answer wins over the estimate, exactly as the caption does — a sort that
   *  ranked a bracket-2 deck by its floor of 4 would disagree with the words under it. */
  it("prefers the set bracket to the estimate", () => {
    const decks = [
      deck({ id: 1, name: "Set to two", bracket: 2 }),
      deck({ id: 2, name: "Reads as three" }),
    ];

    expect(
      names(sortDecks(decks, { key: "bracket", desc: false }, ctx({}, { 1: 4, 2: 3 }))),
    ).toEqual(["Set to two", "Reads as three"]);
  });

  /**
   * **Unknown is not zero.** A deck on Auto whose estimate has not arrived sorts after every deck
   * that has a number, rather than at the head where a reader counts their lowest brackets —
   * `sorting.ts`'s `nullsLast` rule, held in the direction the reader gets when they pick the key.
   */
  it("puts a deck with neither a bracket nor an estimate last", () => {
    const decks = [
      deck({ id: 1, name: "Nothing known" }),
      deck({ id: 2, name: "Reads as four" }),
      deck({ id: 3, name: "Also nothing known" }),
    ];

    expect(names(sortDecks(decks, { key: "bracket", desc: false }, ctx({}, { 2: 4 })))).toEqual([
      "Reads as four",
      "Also nothing known",
      "Nothing known",
    ]);
  });

  it("breaks a tie between two decks reading the same number on name", () => {
    const decks = [deck({ id: 1, name: "Zur" }), deck({ id: 2, name: "Atraxa" })];

    expect(names(sortDecks(decks, { key: "bracket", desc: false }, ctx({}, { 1: 3, 2: 3 })))).toEqual(
      ["Atraxa", "Zur"],
    );
  });
});

describe("sortDecks — cards and format", () => {
  it("counts down from the biggest deck, breaking a tie on name", () => {
    const decks = [
      deck({ name: "Sixty", cardCount: 60 }),
      deck({ name: "Zur", cardCount: 100 }),
      deck({ name: "Atraxa", cardCount: 100 }),
    ];

    expect(names(sortDecks(decks, { key: "cards", desc: true }, NOTHING))).toEqual([
      "Atraxa",
      "Zur",
      "Sixty",
    ]);
  });

  /** The words on the tile, not the key — and the raw key where the seeded table no longer
   *  carries the format, which is a deck that still lists and still sorts. */
  it("orders by the format's display name, falling back to the key", () => {
    const decks = [
      deck({ name: "A", formatKey: "modern", formatName: "Modern" }),
      deck({ name: "B", formatKey: "zzz-homebrew", formatName: null }),
      deck({ name: "C", formatKey: "commander", formatName: "Commander" }),
    ];

    expect(names(sortDecks(decks, { key: "format", desc: false }, NOTHING))).toEqual([
      "C",
      "A",
      "B",
    ]);
  });

  it("breaks a format tie on name", () => {
    const decks = [
      deck({ name: "Zur", formatKey: "commander", formatName: "Commander" }),
      deck({ name: "Atraxa", formatKey: "commander", formatName: "Commander" }),
    ];

    expect(names(sortDecks(decks, { key: "format", desc: false }, NOTHING))).toEqual([
      "Atraxa",
      "Zur",
    ]);
  });
});

describe("sortDecks — the four properties", () => {
  const KEYS: DeckSortKey[] = ["updated", "name", "colors", "bracket", "cards", "format"];

  /**
   * **Total.** Two of the six keys read a fact from a query that may not have answered, and a
   * gallery draws its tiles long before either does. Nothing may throw on the empty context, and
   * every key must still produce all the decks it was given.
   */
  it("orders every key against a context that answered nothing", () => {
    const decks = [
      deck({ name: "Zur" }),
      deck({ name: "Atraxa", formatName: null, formatKey: "brawl" }),
      deck({ name: "Burn", cardCount: 60, updatedAt: 1 }),
    ];

    for (const key of KEYS) {
      for (const desc of [false, true]) {
        const sorted = sortDecks(decks, { key, desc }, NOTHING);
        expect(sorted).toHaveLength(3);
        expect(new Set(names(sorted))).toEqual(new Set(names(decks)));
      }
    }
  });

  /**
   * **Stable.** `Burn` and `burn` are one string to the collator, so the `cards` comparator has
   * nothing left to separate them by — and they must keep the order `deck_list` returned them
   * in rather than swapping places on the next redraw.
   */
  it("keeps the read's order through a tie the comparator cannot break", () => {
    const decks = [
      deck({ id: 11, name: "Burn", cardCount: 60 }),
      deck({ id: 12, name: "burn", cardCount: 60 }),
      deck({ id: 13, name: "BURN", cardCount: 60 }),
    ];

    expect(sortDecks(decks, { key: "cards", desc: true }, NOTHING).map((d) => d.id)).toEqual([
      11, 12, 13,
    ]);
    // …and the same tie the other way round is the same three decks, reversed rather than
    // reshuffled: the negation leaves a 0 a 0.
    expect(sortDecks(decks, { key: "cards", desc: false }, NOTHING).map((d) => d.id)).toEqual([
      11, 12, 13,
    ]);
  });

  /**
   * **Copies.** The array reaching this is React Query's own cached `deck_list` answer, and
   * sorting it in place would mutate the cache every other reader of `["decks", "list"]` shares.
   */
  it("leaves the input array exactly as it found it", () => {
    const decks = [
      deck({ name: "Zur", cardCount: 100 }),
      deck({ name: "Burn", cardCount: 60 }),
    ];
    const before = names(decks);

    const sorted = sortDecks(decks, { key: "cards", desc: true }, NOTHING);

    expect(names(decks)).toEqual(before);
    expect(sorted).not.toBe(decks);
  });

  /**
   * **Reversible whole.** The toggle negates the comparator, tiebreaks included, so pressing it
   * gives the reader the same wall from the other end — never a differently-shuffled one. Run
   * against a set with no ties on any key, so `.reverse()` is the whole of the expectation.
   */
  it("answers the same list upside down when the direction turns", () => {
    const decks = [
      deck({ id: 1, name: "Atraxa", cardCount: 100, updatedAt: 300, bracket: 4, formatKey: "commander", formatName: "Commander" }),
      deck({ id: 2, name: "Burn", cardCount: 60, updatedAt: 200, bracket: 2, formatKey: "modern", formatName: "Modern" }),
      deck({ id: 3, name: "Cascade", cardCount: 80, updatedAt: 100, bracket: 3, formatKey: "pauper", formatName: "Pauper" }),
    ];
    const context = ctx({ 1: countPips("{W}"), 2: countPips("{U}{B}"), 3: countPips("{C}") });

    for (const key of KEYS) {
      const ascending = sortDecks(decks, { key, desc: false }, context);
      const descending = sortDecks(decks, { key, desc: true }, context);

      expect(names(descending)).toEqual([...names(ascending)].reverse());
    }
  });
});

describe("parseDeckSort", () => {
  it("reads back everything formatDeckSort writes", () => {
    for (const { value } of DECK_SORT_OPTIONS) {
      for (const desc of [false, true]) {
        const sort = { key: value, desc };
        expect(parseDeckSort(formatDeckSort(sort))).toEqual(sort);
      }
    }
  });

  it("writes the two directions as words", () => {
    expect(formatDeckSort({ key: "name", desc: false })).toBe("name:asc");
    expect(formatDeckSort({ key: "updated", desc: true })).toBe("updated:desc");
  });

  /**
   * **It accepts anything and answers something.** The string comes out of `app_meta`, a database
   * outlives the app, and a key some future build stops offering has to become an order the
   * reader can leave rather than one the toolbar cannot draw — `asSortBy`'s contract in
   * `sorting.ts:47`, one table over.
   */
  it("answers the default for anything it does not recognise", () => {
    for (const stored of [
      "",
      "name",
      "name:",
      ":asc",
      "colours:asc",
      "name:sideways",
      "NAME:ASC",
      "name:asc:extra",
      "  name:asc  ",
      "[object Object]",
    ]) {
      expect(parseDeckSort(stored)).toEqual(DEFAULT_DECK_SORT);
    }
  });

  it("never throws, whatever it is handed", () => {
    expect(() => parseDeckSort("::::")).not.toThrow();
    expect(() => parseDeckSort("\u0000")).not.toThrow();
  });
});

describe("the picker's vocabulary", () => {
  /**
   * The two tables and the parser are three spellings of one key list, and the only one that can
   * silently drift is a key added to the type without a row here — which would be a sort the
   * reader cannot reach and a direction `NATURAL_DESC` cannot answer for.
   */
  it("offers every key and gives each one a natural direction", () => {
    const keys: DeckSortKey[] = ["updated", "name", "colors", "bracket", "cards", "format"];

    expect(DECK_SORT_OPTIONS.map((o) => o.value).sort()).toEqual([...keys].sort());
    expect(Object.keys(NATURAL_DESC).sort()).toEqual([...keys].sort());
  });

  /** The gallery opens on the natural direction of its default key, which is what makes the
   *  first paint today's order rather than today's order upside down. */
  it("opens on the default key's own direction", () => {
    expect(DEFAULT_DECK_SORT).toEqual({ key: "updated", desc: true });
    expect(NATURAL_DESC[DEFAULT_DECK_SORT.key]).toBe(DEFAULT_DECK_SORT.desc);
  });

  /** Two count something and read from the top; the other four are alphabets and ladders. */
  it("counts down and reads up", () => {
    expect(NATURAL_DESC.updated).toBe(true);
    expect(NATURAL_DESC.cards).toBe(true);
    expect(NATURAL_DESC.name).toBe(false);
    expect(NATURAL_DESC.colors).toBe(false);
    expect(NATURAL_DESC.bracket).toBe(false);
    expect(NATURAL_DESC.format).toBe(false);
  });
});
