import { describe, expect, it } from "vitest";
import type { DeckRow } from "@/lib/ipc";
import { NO_DECK_FILTER, deckFormats, filterDecks, type DeckFilter } from "./deckFilter";

let nextId = 1;

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

const names = (decks: readonly DeckRow[]) => decks.map((d) => d.name);
const filter = (over: Partial<DeckFilter> = {}): DeckFilter => ({ ...NO_DECK_FILTER, ...over });

describe("filterDecks — the name box", () => {
  it("matches anywhere in the name, not only at the start", () => {
    const decks = [deck({ name: "Atraxa Superfriends" }), deck({ name: "Burn" })];

    expect(names(filterDecks(decks, filter({ query: "friends" })))).toEqual([
      "Atraxa Superfriends",
    ]);
  });

  it("ignores case", () => {
    const decks = [deck({ name: "Atraxa Superfriends" }), deck({ name: "Burn" })];

    expect(names(filterDecks(decks, filter({ query: "ATRAXA" })))).toEqual([
      "Atraxa Superfriends",
    ]);
    expect(names(filterDecks(decks, filter({ query: "burn" })))).toEqual(["Burn"]);
  });

  /**
   * **Accents fold both ways.** A reader who typed the deck's name with the accent and one who
   * typed it without are asking the same question, and a name box that answered only one of them
   * would look broken to exactly the reader who took the trouble to spell it properly.
   */
  it("ignores accents in either the name or the query", () => {
    const decks = [deck({ name: "Jötun Grunt" }), deck({ name: "Elan" })];

    expect(names(filterDecks(decks, filter({ query: "jotun" })))).toEqual(["Jötun Grunt"]);
    expect(names(filterDecks(decks, filter({ query: "Jötun" })))).toEqual(["Jötun Grunt"]);
    expect(names(filterDecks(decks, filter({ query: "élan" })))).toEqual(["Elan"]);
  });

  it("trims the field before asking, so a stray space is not a query", () => {
    const decks = [deck({ name: "Burn" }), deck({ name: "Storm" })];

    expect(names(filterDecks(decks, filter({ query: "   " })))).toEqual(["Burn", "Storm"]);
    expect(names(filterDecks(decks, filter({ query: "  burn  " })))).toEqual(["Burn"]);
  });

  it("shows the whole gallery for an empty query", () => {
    const decks = [deck({ name: "Burn" }), deck({ name: "Storm" })];

    expect(names(filterDecks(decks, NO_DECK_FILTER))).toEqual(["Burn", "Storm"]);
  });

  it("answers nothing when nothing matches, rather than everything", () => {
    const decks = [deck({ name: "Burn" })];

    expect(filterDecks(decks, filter({ query: "zzz" }))).toEqual([]);
  });
});

describe("filterDecks — the format chips", () => {
  const MODERN = deck({ name: "Burn", formatKey: "modern", formatName: "Modern" });
  const EDH = deck({ name: "Atraxa", formatKey: "commander", formatName: "Commander" });
  const PAUPER = deck({ name: "Familiars", formatKey: "pauper", formatName: "Pauper" });
  const ALL = [MODERN, EDH, PAUPER];

  /**
   * **The one thing about a chip row that has to be right.** Nothing ticked is a reader asking to
   * see everything, and the bug shape — an `includes` with no empty check in front of it — empties
   * the wall the moment the row appears and reads as the gallery having lost every deck at once.
   */
  it("treats an empty format list as no filter at all", () => {
    expect(names(filterDecks(ALL, filter({ formats: [] })))).toEqual([
      "Burn",
      "Atraxa",
      "Familiars",
    ]);
  });

  it("keeps only the ticked formats", () => {
    expect(names(filterDecks(ALL, filter({ formats: ["modern"] })))).toEqual(["Burn"]);
    expect(names(filterDecks(ALL, filter({ formats: ["modern", "pauper"] })))).toEqual([
      "Burn",
      "Familiars",
    ]);
  });

  it("matches on the key rather than on the words drawn on the chip", () => {
    expect(filterDecks(ALL, filter({ formats: ["Modern"] }))).toEqual([]);
  });

  /** The two terms are an **and**: a reader who typed a name and ticked a format wants the decks
   *  that are both. */
  it("asks both terms at once", () => {
    expect(names(filterDecks(ALL, filter({ query: "a", formats: ["commander"] })))).toEqual([
      "Atraxa",
    ]);
    expect(filterDecks(ALL, filter({ query: "burn", formats: ["commander"] }))).toEqual([]);
  });
});

describe("filterDecks — what it does to the array", () => {
  /** The array reaching this is React Query's own cached `deck_list` answer. */
  it("copies, keeps the read's order, and leaves the input alone", () => {
    const decks = [
      deck({ name: "Zur" }),
      deck({ name: "Atraxa" }),
      deck({ name: "Burn", formatKey: "modern", formatName: "Modern" }),
    ];
    const before = names(decks);

    const kept = filterDecks(decks, filter({ formats: ["commander"] }));

    expect(names(kept)).toEqual(["Zur", "Atraxa"]);
    expect(names(decks)).toEqual(before);
    expect(kept).not.toBe(decks);
  });
});

describe("deckFormats", () => {
  it("offers only the formats these decks are actually in, with a count each", () => {
    const decks = [
      deck({ name: "Burn", formatKey: "modern", formatName: "Modern" }),
      deck({ name: "Atraxa", formatKey: "commander", formatName: "Commander" }),
      deck({ name: "Zur", formatKey: "commander", formatName: "Commander" }),
    ];

    expect(deckFormats(decks)).toEqual([
      { key: "commander", label: "Commander", count: 2 },
      { key: "modern", label: "Modern", count: 1 },
    ]);
  });

  /** Alphabetical by the words on the chip — `options.ts` is the app's one rule for an option
   *  list, and a reader looks for *Modern* under M. */
  it("orders the chips by their label rather than by their key", () => {
    const decks = [
      deck({ name: "A", formatKey: "aaa", formatName: "Zenith" }),
      deck({ name: "B", formatKey: "zzz", formatName: "Alpha" }),
    ];

    expect(deckFormats(decks).map((f) => f.label)).toEqual(["Alpha", "Zenith"]);
  });

  /** A format the seeded table no longer carries is a deck that still lists, so it still gets a
   *  chip — labelled with the raw key, which is the honest name for it. */
  it("labels an unseeded format with its key", () => {
    const decks = [deck({ name: "Homebrew", formatKey: "my-format", formatName: null })];

    expect(deckFormats(decks)).toEqual([{ key: "my-format", label: "my-format", count: 1 }]);
  });

  /** Faceting, not a picker: one format is one chip, which is information rather than clutter. */
  it("offers one chip for a one-format gallery and none for an empty one", () => {
    expect(deckFormats([deck({ name: "Atraxa" })])).toHaveLength(1);
    expect(deckFormats([])).toEqual([]);
  });

  it("never collapses two keys that happen to share a label", () => {
    const decks = [
      deck({ name: "A", formatKey: "paper-edh", formatName: "Commander" }),
      deck({ name: "B", formatKey: "commander", formatName: "Commander" }),
    ];

    expect(deckFormats(decks).map((f) => f.key).sort()).toEqual(["commander", "paper-edh"]);
  });
});
