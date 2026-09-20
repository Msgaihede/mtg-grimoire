import { describe, expect, it } from "vitest";
import type { DeckNote } from "@/lib/ipc";
import {
  attachableCards,
  typeChipCounts,
  UNTITLED_NOTE,
  notedOracleIds,
  noteTitle,
  notesForCard,
} from "./deckNotes";
// `validation/fixtures`' `card` is this folder's one `DeckCard` builder — `CardFacts` is
// `DeckCard` under the engine's name for it, so the factory really does answer the whole row.
// `DeckNotesPanel.test.tsx` already imports it for exactly these cards, and a second local copy
// of a forty-field fixture is a second place for a default to drift.
import { card } from "./validation/fixtures";

/**
 * The three derivations, which are the only part of this feature that can be wrong without
 * anything going red elsewhere: Rust hands over rows that are true whatever this file does with
 * them, and the surfaces draw whatever they are given.
 *
 * **The absent-oracle-id case is the one that matters most.** Both natural ways to write
 * {@link notesForCard} answer *everything* for a card with no oracle id, and either one puts a
 * whole deck's notes behind a card nobody wrote one about — a bug that looks like a feature
 * until somebody counts.
 */

/**
 * One note as Rust hands it over. The ids are obviously synthetic: this file tests the
 * derivations and nothing about Scryfall, so nobody is ever tempted to check them against
 * real data.
 */
const note = (over: Partial<DeckNote> = {}): DeckNote => ({
  id: 1,
  deckId: 1,
  title: "Mana",
  body: "Fourteen sources.",
  sortOrder: 0,
  cards: [],
  createdAt: 0,
  updatedAt: 0,
  ...over,
});

describe("noteTitle", () => {
  it("prefers the stored title", () =>
    expect(noteTitle(note({ title: "Mana", body: "# Other" }))).toBe("Mana"));

  it("falls back to the body's first line, unmarked", () =>
    expect(noteTitle(note({ title: "", body: "## Mana base\nmore" }))).toBe("Mana base"));

  it("says so when there is nothing at all", () =>
    expect(noteTitle(note({ title: "", body: "   " }))).toBe("Untitled note"));

  it("spells that admission once", () =>
    // The literal is asserted above and the constant pinned to it here: an assertion that reads
    // the same constant the implementation reads passes against the exact defect it is for.
    expect(UNTITLED_NOTE).toBe("Untitled note"));

  it("takes the first line of a body that opens with a list", () =>
    expect(noteTitle(note({ title: "", body: "- Add a fetch\n- Cut a land" }))).toBe(
      "Add a fetch",
    ));

  it("treats a title of nothing but spaces as no title", () =>
    expect(noteTitle(note({ title: "   ", body: "Fourteen sources." }))).toBe(
      "Fourteen sources.",
    ));

  it("does not truncate a long first line", () => {
    // A clamp is a decision about how wide a row is, and the band, a submenu and a modal row
    // have three different answers. It belongs in CSS at each of them, not once here.
    const long = "x".repeat(300);
    expect(noteTitle(note({ title: "", body: long }))).toBe(long);
  });
});

describe("notedOracleIds", () => {
  it("gathers every id across every note, once each", () => {
    const ids = notedOracleIds([
      note({ id: 1, cards: [{ oracleId: "o-bolt", name: "Lightning Bolt", cardId: "c-bolt" }] }),
      note({
        id: 2,
        cards: [
          { oracleId: "o-bolt", name: "Lightning Bolt", cardId: "c-bolt" },
          { oracleId: "o-ritual", name: "Dark Ritual", cardId: "c-ritual" },
        ],
      }),
    ]);
    expect([...ids].sort()).toEqual(["o-bolt", "o-ritual"]);
  });

  it("is empty when nothing names a card", () =>
    expect(notedOracleIds([note({ cards: [] })]).size).toBe(0));
});

describe("notesForCard", () => {
  const bolt = { oracleId: "o-bolt", name: "Lightning Bolt", cardId: "c-bolt" };

  it("answers the notes that name the card, in the deck's own order", () => {
    const notes = [
      note({ id: 1, sortOrder: 0, cards: [bolt] }),
      note({ id: 2, sortOrder: 1, cards: [] }),
      note({ id: 3, sortOrder: 2, cards: [bolt] }),
    ];
    expect(notesForCard(notes, "o-bolt").map((n) => n.id)).toEqual([1, 3]);
  });

  it("answers nothing for a card with no oracle id rather than everything", () =>
    // An orphan printing has `oracleId: null`, and a loose equality here would match every
    // note whose attachment list happened to be empty.
    expect(notesForCard([note({ cards: [] })], null)).toEqual([]));

  it("answers nothing for an empty oracle id either", () =>
    expect(notesForCard([note({ cards: [bolt] })], "")).toEqual([]));

  it("never answers a note that names no card", () =>
    // `[].every(...)` is vacuously true, so a filter written with `every` returns every
    // unattached note for every card — the same shape as `NOT IN` over an empty set.
    expect(notesForCard([note({ cards: [] })], "o-bolt")).toEqual([]));

  it("leaves the array it was handed alone", () => {
    const notes = [note({ id: 1, cards: [bolt] })];
    expect(notesForCard(notes, "o-bolt")).not.toBe(notes);
    expect(notes).toHaveLength(1);
  });
});

describe("what the card picker offers", () => {
  it("folds every copy of one oracle card into one row", () => {
    const [row, ...rest] = attachableCards([
      card({ cardId: "m10", oracleId: "o-bolt", name: "Lightning Bolt", quantity: 3 }),
      card({ cardId: "lea", oracleId: "o-bolt", name: "Lightning Bolt", quantity: 1 }),
    ]);

    expect(rest).toEqual([]);
    expect(row?.copies).toBe(4);
  });

  it("takes the printing off the first row the deck lists, which is the deck's own order", () => {
    const [row] = attachableCards([
      card({
        cardId: "m10",
        oracleId: "o-bolt",
        name: "Lightning Bolt",
        setCode: "m10",
        collectorNumber: "146",
      }),
      card({
        cardId: "lea",
        oracleId: "o-bolt",
        name: "Lightning Bolt",
        setCode: "lea",
        collectorNumber: "161",
      }),
    ]);

    expect(row?.cardId).toBe("m10");
    expect(row?.setCode).toBe("m10");
    expect(row?.collectorNumber).toBe("146");
  });

  it("buckets a card by the front face of its type line", () => {
    const [mdfc] = attachableCards([
      card({
        cardId: "agadeem",
        oracleId: "o-agadeem",
        name: "Agadeem's Awakening",
        typeLine: "Sorcery // Land",
      }),
    ]);

    // The back of a modal DFC is routinely a land while the front is a spell; a deck is cast
    // from the front, and `typeBucket` is the rule that already says so.
    expect(mdfc?.typeBucket).toBe("Sorcery");
  });

  it("drops a row with no oracle id rather than offering a press that can only be refused", () => {
    expect(attachableCards([card({ cardId: "orphan", oracleId: null, name: "Gone" })])).toEqual([]);
  });

  it("sorts by name, so the list reads the way a reader scans it", () => {
    const names = attachableCards([
      card({ cardId: "b", oracleId: "o-b", name: "Mountain" }),
      card({ cardId: "a", oracleId: "o-a", name: "Goblin Guide" }),
    ]).map((c) => c.name);

    expect(names).toEqual(["Goblin Guide", "Mountain"]);
  });
});

describe("the picker's chips", () => {
  const CHOICES = attachableCards([
    card({
      cardId: "1",
      oracleId: "o-1",
      name: "Goblin Guide",
      typeLine: "Creature — Goblin Scout",
      quantity: 4,
    }),
    card({
      cardId: "2",
      oracleId: "o-2",
      name: "Mountain",
      typeLine: "Basic Land — Mountain",
      quantity: 20,
    }),
    card({ cardId: "3", oracleId: "o-3", name: "Lightning Bolt", typeLine: "Instant", quantity: 4 }),
  ]);

  it("counts cards and never copies, because a note names a card once", () => {
    const chips = typeChipCounts(CHOICES, 1);

    // 20 Mountains are one row in this list and one thing a note can name.
    expect(chips.find((c) => c.key === "all")?.count).toBe(3);
    expect(chips.find((c) => c.key === "land")?.count).toBe(1);
  });

  it("puts All and Named first, then the types in TYPE_BUCKETS' order", () => {
    expect(typeChipCounts(CHOICES, 1).map((c) => c.label)).toEqual([
      "All",
      "Named",
      "Creature",
      "Instant",
      "Land",
    ]);
  });

  it("draws no chip for a type the deck does not hold", () => {
    expect(typeChipCounts(CHOICES, 0).map((c) => c.label)).not.toContain("Planeswalker");
  });

  it("keeps Named even at zero, because it is how a reader checks their own work", () => {
    expect(typeChipCounts(CHOICES, 0).find((c) => c.key === "named")).toEqual({
      key: "named",
      label: "Named",
      count: 0,
    });
  });
});
