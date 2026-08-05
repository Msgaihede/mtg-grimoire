import { beforeEach, describe, expect, it } from "vitest";
import type { DeckZone, FormatSpec } from "@/lib/ipc";
import type { CardFacts } from "./types";
import { copyLimitFor, manaValueOf, validateDeck } from "./engine";

/**
 * The seeded `format_specs` rows these tests judge against, hand-copied from
 * `schema.rs`'s `FORMAT_SPECS_SEED`.
 *
 * The seed's **authority** is Task 2's Rust test
 * (`format_specs_is_seeded_with_all_25_formats_and_the_load_bearing_cells`), which checks
 * every load-bearing cell of all 25 rows against the research doc. These are mirrors, so
 * the engine can be exercised without a database — and so that a test that fails here is
 * about the engine, never about a number.
 */
const SPECS: Record<string, FormatSpec> = {
  modern: {
    key: "modern",
    displayName: "Modern",
    enabledInPicker: true,
    deckMin: 60,
    deckMax: null,
    maxCopies: 4,
    sideboardMax: 15,
    singleton: false,
    requiresCommander: false,
    commanderRule: null,
    life: 20,
    restrictedSemantic: "max_one",
    hasLegalityData: true,
    maxManaValue: null,
    allowsCompanion: true,
    sortOrder: 7,
  },
  vintage: {
    key: "vintage",
    displayName: "Vintage",
    enabledInPicker: true,
    deckMin: 60,
    deckMax: null,
    maxCopies: 4,
    sideboardMax: 15,
    singleton: false,
    requiresCommander: false,
    commanderRule: null,
    life: 20,
    restrictedSemantic: "max_one",
    hasLegalityData: true,
    maxManaValue: null,
    allowsCompanion: true,
    sortOrder: 10,
  },
  commander: {
    key: "commander",
    displayName: "Commander",
    enabledInPicker: true,
    deckMin: 100,
    deckMax: 100,
    maxCopies: 1,
    sideboardMax: 0,
    singleton: true,
    requiresCommander: true,
    commanderRule: "edh",
    life: 40,
    restrictedSemantic: "max_one",
    hasLegalityData: true,
    maxManaValue: null,
    allowsCompanion: true,
    sortOrder: 12,
  },
  duel: {
    key: "duel",
    displayName: "Duel Commander",
    enabledInPicker: true,
    deckMin: 100,
    deckMax: 100,
    maxCopies: 1,
    sideboardMax: 0,
    singleton: true,
    requiresCommander: true,
    commanderRule: "duel",
    life: 20,
    // TRAP A: the same word means something else here than it does in Vintage.
    restrictedSemantic: "banned_as_commander",
    hasLegalityData: true,
    maxManaValue: null,
    allowsCompanion: true,
    sortOrder: 19,
  },
  oldschool: {
    key: "oldschool",
    displayName: "Old School",
    enabledInPicker: true,
    deckMin: 60,
    deckMax: null,
    maxCopies: 4,
    sideboardMax: 15,
    singleton: false,
    requiresCommander: false,
    commanderRule: null,
    life: 20,
    restrictedSemantic: "max_one",
    hasLegalityData: true,
    maxManaValue: null,
    allowsCompanion: true,
    sortOrder: 20,
  },
  tlr: {
    key: "tlr",
    displayName: "Tiny Leaders: Reborn",
    enabledInPicker: true,
    deckMin: 50,
    deckMax: 50,
    maxCopies: 1,
    sideboardMax: 10,
    singleton: true,
    requiresCommander: true,
    commanderRule: "tlr",
    life: 20,
    restrictedSemantic: "banned_as_commander",
    hasLegalityData: true,
    maxManaValue: 3,
    allowsCompanion: true,
    sortOrder: 23,
  },
  casual: {
    key: "casual",
    displayName: "Casual",
    enabledInPicker: true,
    deckMin: 0,
    deckMax: null,
    maxCopies: null,
    sideboardMax: null,
    singleton: false,
    requiresCommander: false,
    commanderRule: null,
    life: 20,
    restrictedSemantic: "max_one",
    hasLegalityData: false,
    maxManaValue: null,
    allowsCompanion: true,
    sortOrder: 24,
  },
  limited: {
    key: "limited",
    displayName: "Limited",
    enabledInPicker: true,
    deckMin: 40,
    deckMax: null,
    maxCopies: null,
    sideboardMax: null,
    singleton: false,
    requiresCommander: false,
    commanderRule: null,
    life: 20,
    restrictedSemantic: "max_one",
    hasLegalityData: false,
    maxManaValue: null,
    allowsCompanion: true,
    sortOrder: 25,
  },
};

function spec(key: keyof typeof SPECS): FormatSpec {
  return SPECS[key];
}

/** Legal in every format these tests use, so a fixture only says what it is *about*. */
const LEGAL = JSON.stringify({
  modern: "legal",
  vintage: "legal",
  commander: "legal",
  duel: "legal",
  oldschool: "legal",
  tlr: "legal",
});

let nextRow = 1;
beforeEach(() => {
  nextRow = 1;
});

/**
 * One `deck_cards` row as Task 5's read answers it.
 *
 * `cardId` and `oracleId` default from the name, which is what makes two rows of the same
 * card in two zones group together the way they do in the database — a printing can sit in
 * `main` and `side` at once (the unique index is on `(deck, card, zone)`).
 */
function card(overrides: Partial<CardFacts> = {}): CardFacts {
  const name = overrides.name ?? "Lightning Bolt";
  return {
    id: nextRow++,
    cardId: `c-${name}`,
    zone: "main",
    quantity: 1,
    name,
    setCode: "lea",
    collectorNumber: "161",
    lang: "en",
    needsReview: null,
    oracleId: `o-${name}`,
    manaCost: "{R}",
    cmc: 1,
    typeLine: "Instant",
    oracleText: null,
    colors: "R",
    colorIdentity: "R",
    legalities: LEGAL,
    power: null,
    toughness: null,
    layout: "normal",
    rarity: "common",
    faces: null,
    gameChanger: false,
    everUncommon: false,
    unitPriceUsd: null,
    ownedQuantity: 0,
    ...overrides,
  };
}

/** Filler that no rule objects to: basics are exempt from every copy limit (CR 100.2a). */
function islands(quantity: number, zone: DeckZone = "main"): CardFacts {
  return card({
    name: "Island",
    typeLine: "Basic Land — Island",
    manaCost: null,
    cmc: 0,
    colors: null,
    colorIdentity: "U",
    quantity,
    zone,
  });
}

/** A commander, so a Commander-format fixture is about the card it is about. */
function commander(): CardFacts {
  return card({
    name: "Krenko, Mob Boss",
    zone: "commander",
    typeLine: "Legendary Creature — Goblin Warrior",
    manaCost: "{2}{R}{R}",
    cmc: 4,
    power: "3",
    toughness: "3",
  });
}

/** Pad the size-counting zones (`main` + `commander`) out to a legal deck with basics, so
 *  a test about copies or legality does not also trip the deck-size rule. */
function padTo(size: number, cards: CardFacts[]): CardFacts[] {
  const counted = cards
    .filter((c) => c.zone === "main" || c.zone === "commander")
    .reduce((n, c) => n + c.quantity, 0);
  return counted < size ? [...cards, islands(size - counted)] : cards;
}

describe("deck size", () => {
  it("counts main and commander, and says how short a 60-card deck is", () => {
    expect(validateDeck([islands(59)], spec("modern"))).toEqual([
      {
        severity: "error",
        code: "deck-size",
        message: "Modern decks need at least 60 cards; you have 59.",
      },
    ]);
    expect(validateDeck([islands(60)], spec("modern"))).toEqual([]);
    // CR 100.5: a 60-card format has a minimum and no maximum.
    expect(validateDeck([islands(247)], spec("modern"))).toEqual([]);
  });

  /** An exactly-sized format is wrong in both directions, and the sentence says *including
   *  the commander* because the commander zone is one of the two it counts. */
  it("holds Commander to exactly 100 including the commander", () => {
    const short = validateDeck([commander(), islands(98)], spec("commander"));
    expect(short).toEqual([
      {
        severity: "error",
        code: "deck-size",
        message: "Commander decks are exactly 100 cards including the commander; you have 99.",
      },
    ]);

    const long = validateDeck([commander(), islands(100)], spec("commander"));
    expect(long[0].message).toBe(
      "Commander decks are exactly 100 cards including the commander; you have 101.",
    );

    expect(validateDeck([commander(), islands(99)], spec("commander"))).toEqual([]);
  });

  /**
   * The companion counts toward **no** deck size — EDH's is "effectively a 101st card" —
   * and the maybe pile counts toward nothing at all: not size, not copies, not legality.
   * The maybe row here is four copies of a card that is *banned* in the format, and the
   * deck is clean.
   */
  it("ignores the companion for size and the maybe pile for everything", () => {
    const deck = [
      commander(),
      islands(99),
      card({ name: "Lurrus of the Dream-Den", zone: "companion", typeLine: "Legendary Creature" }),
      card({ name: "Sol Ring", zone: "maybe", quantity: 4, legalities: '{"commander":"banned"}' }),
    ];

    expect(validateDeck(deck, spec("commander"))).toEqual([]);
  });

  /**
   * No seeded row carries a minimum *and* a different maximum today — every `deck_max` is
   * either NULL or equal to its `deck_min`. The branch exists because the rules are data:
   * a format that grows a ceiling is an UPDATE, and it must not need a release here.
   */
  it("reads a maximum that is not also the minimum", () => {
    const capped: FormatSpec = { ...spec("modern"), deckMax: 80 };

    expect(validateDeck([islands(81)], capped)).toEqual([
      {
        severity: "error",
        code: "deck-size",
        message: "Modern decks are at most 80 cards; you have 81.",
      },
    ]);
    expect(validateDeck([islands(80)], capped)).toEqual([]);
  });

  it("reads the two pseudo-formats' sizes from the same cells", () => {
    expect(validateDeck([islands(40)], spec("limited"))).toEqual([]);
    expect(validateDeck([islands(39)], spec("limited"))).toEqual([
      {
        severity: "error",
        code: "deck-size",
        message: "Limited decks need at least 40 cards; you have 39.",
      },
    ]);
    // Casual's `deck_min` is 0, so an empty deck is not a complaint.
    expect(validateDeck([], spec("casual"))).toEqual([]);
  });
});

describe("copy limits", () => {
  /** CR 100.4a: the sideboard's copies count toward the same four. */
  it("counts main and side together", () => {
    const deck = padTo(60, [card({ quantity: 3 }), card({ quantity: 2, zone: "side" })]);

    expect(validateDeck(deck, spec("modern"))).toEqual([
      {
        severity: "error",
        code: "copy-limit",
        message: "Modern decks allow up to 4 copies of Lightning Bolt; you have 5.",
        cardIds: ["c-Lightning Bolt"],
      },
    ]);
  });

  /** CR 100.2a: any number of basic lands. */
  it("lets basics alone", () => {
    const deck = [
      islands(30),
      card({ name: "Mountain", typeLine: "Basic Land — Mountain", cmc: 0, quantity: 30 }),
    ];

    expect(validateDeck(deck, spec("modern"))).toEqual([]);
  });

  /** `max_copies` NULL is *unlimited*, and Limited is the format that means it. */
  it("has no limit at all where the spec has none", () => {
    expect(validateDeck(padTo(40, [card({ quantity: 12 })]), spec("limited"))).toEqual([]);
  });

  it("says singleton when the format is singleton", () => {
    const deck = padTo(100, [commander(), card({ name: "Sol Ring", quantity: 2 })]);

    expect(validateDeck(deck, spec("commander"))).toEqual([
      {
        severity: "error",
        code: "singleton",
        message: "Commander decks are singleton: max 1 copy of Sol Ring; you have 2.",
        cardIds: ["c-Sol Ring"],
      },
    ]);
  });

  /**
   * The commander is one of the 100 (CR 903.5b), so a card in the commander zone and the
   * same card in the main deck is two copies of it — a state the zone model allows, because
   * `deck_cards` is unique on `(deck, card, zone)`.
   */
  it("counts the commander zone as part of the deck", () => {
    const deck = padTo(100, [commander(), card({ ...commander(), zone: "main" })]);

    expect(validateDeck(deck, spec("commander"))).toEqual([
      {
        severity: "error",
        code: "singleton",
        message: "Commander decks are singleton: max 1 copy of Krenko, Mob Boss; you have 2.",
        cardIds: ["c-Krenko, Mob Boss"],
      },
    ]);
  });

  /** The exported limit, straight: what one card is allowed under one spec. */
  it("answers the limit for one card", () => {
    expect(copyLimitFor(card(), spec("modern"))).toBe(4);
    expect(copyLimitFor(card(), spec("commander"))).toBe(1);
    expect(copyLimitFor(card(), spec("casual"))).toBe(Infinity);
    expect(copyLimitFor(islands(1), spec("commander"))).toBe(Infinity);
  });
});

describe("singleton exceptions (exact phrases)", () => {
  const RELENTLESS_RATS =
    "Relentless Rats gets +1/+1 for each other creature you control named Relentless Rats.\n" +
    "A deck can have any number of cards named Relentless Rats.";
  const DRAGONS_APPROACH =
    "Dragon's Approach deals 3 damage to any target.\n" +
    "A deck can have any number of cards named Dragon's Approach.";
  const SEVEN_DWARVES =
    "Seven Dwarves gets +1/+1 for each other creature you control named Seven Dwarves.\n" +
    "A deck can have up to seven cards named Seven Dwarves.";
  const NAZGUL =
    "Whenever a Ring-bearer you control causes a player to lose life, put a +1/+1 counter " +
    "on Nazgûl.\nA deck can have up to nine cards named Nazgûl.";
  /** THE TRAP: a library search that contains "any number of cards named" and is not a
   *  deckbuilding permission at all. */
  const BATTALION_FOOT_SOLDIER =
    "When Battalion Foot Soldier enters the battlefield, you may search your library for " +
    "any number of cards named Battalion Foot Soldier, reveal them, put them into your " +
    "hand, then shuffle.";

  it("lets the unlimited cards past even a singleton format", () => {
    const rats = card({ name: "Relentless Rats", quantity: 12, oracleText: RELENTLESS_RATS });
    expect(validateDeck(padTo(100, [commander(), rats]), spec("commander"))).toEqual([]);

    const approach = card({
      name: "Dragon's Approach",
      quantity: 30,
      oracleText: DRAGONS_APPROACH,
    });
    expect(validateDeck(padTo(100, [commander(), approach]), spec("commander"))).toEqual([]);
  });

  /** The number is printed as a **word**, so a digit-only parse would read no exception at
   *  all and Seven Dwarves would be a singleton card. */
  it("caps Seven Dwarves at seven and Nazgûl at nine", () => {
    const dwarves = (quantity: number) =>
      card({ name: "Seven Dwarves", quantity, oracleText: SEVEN_DWARVES });
    expect(validateDeck(padTo(100, [commander(), dwarves(7)]), spec("commander"))).toEqual([]);
    expect(validateDeck(padTo(100, [commander(), dwarves(8)]), spec("commander"))).toEqual([
      {
        severity: "error",
        code: "copy-limit",
        message: "Seven Dwarves allows up to 7 copies by its own text; you have 8.",
        cardIds: ["c-Seven Dwarves"],
      },
    ]);

    const nazgul = (quantity: number) => card({ name: "Nazgûl", quantity, oracleText: NAZGUL });
    expect(validateDeck(padTo(100, [commander(), nazgul(9)]), spec("commander"))).toEqual([]);
    expect(validateDeck(padTo(100, [commander(), nazgul(10)]), spec("commander"))[0].message).toBe(
      "Nazgûl allows up to 9 copies by its own text; you have 10.",
    );
  });

  /**
   * A count no word table knows — the table runs to twenty and reads digits, so this is a
   * card that has not been printed yet. The card is *known* to allow more than one copy, so
   * the engine passes the deck rather than reporting a limit the card's own text denies, and
   * warns that it did not check.
   */
  it("passes a printed count it cannot read, and says so", () => {
    const text = "A deck can have up to thirty cards named Goblin Trapfinder.";
    const trapfinders = (quantity: number) =>
      card({ name: "Goblin Trapfinder", quantity, oracleText: text });

    expect(validateDeck(padTo(100, [commander(), trapfinders(8)]), spec("commander"))).toEqual([
      {
        severity: "warning",
        code: "unknown-copy-limit",
        message:
          'Goblin Trapfinder\'s text allows up to "thirty" copies, a number this app cannot ' +
          "read; its 8 copies were not checked.",
        cardIds: ["c-Goblin Trapfinder"],
      },
    ]);

    // One copy clears the format's own limit, so the unread clause did no work and there is
    // nothing to warn about.
    expect(validateDeck(padTo(100, [commander(), trapfinders(1)]), spec("commander"))).toEqual([]);
  });

  /** Why the anchor is the whole sentence: this card's text contains the fragment, and five
   *  copies of it in Commander is five copies of it. */
  it("is not fooled by a card that searches for copies of itself", () => {
    const soldiers = card({
      name: "Battalion Foot Soldier",
      quantity: 5,
      oracleText: BATTALION_FOOT_SOLDIER,
    });

    expect(validateDeck(padTo(100, [commander(), soldiers]), spec("commander"))).toEqual([
      {
        severity: "error",
        code: "singleton",
        message: "Commander decks are singleton: max 1 copy of Battalion Foot Soldier; you have 5.",
        cardIds: ["c-Battalion Foot Soldier"],
      },
    ]);
  });
});

describe("legality (per printing — TRAP B)", () => {
  it("says banned and not legal in the format's own words", () => {
    const banned = padTo(60, [card({ quantity: 4, legalities: '{"modern":"banned"}' })]);
    expect(validateDeck(banned, spec("modern"))).toEqual([
      {
        severity: "error",
        code: "banned",
        message: "Lightning Bolt is banned in Modern.",
        cardIds: ["c-Lightning Bolt"],
      },
    ]);

    const notLegal = padTo(60, [card({ quantity: 4, legalities: '{"modern":"not_legal"}' })]);
    expect(validateDeck(notLegal, spec("modern"))).toEqual([
      {
        severity: "error",
        code: "not-legal",
        message: "Lightning Bolt is not legal in Modern.",
        cardIds: ["c-Lightning Bolt"],
      },
    ]);
  });

  /** TRAP A, first meaning: in Vintage `restricted` is a copy limit of one. The sentence is
   *  the spec's own example, verbatim. */
  it("reads restricted as max one copy where that is what it means", () => {
    const one = padTo(60, [card({ legalities: '{"vintage":"restricted"}' })]);
    expect(validateDeck(one, spec("vintage"))).toEqual([]);

    const three = padTo(60, [card({ quantity: 3, legalities: '{"vintage":"restricted"}' })]);
    expect(validateDeck(three, spec("vintage"))).toEqual([
      {
        severity: "error",
        code: "restricted",
        message: "Lightning Bolt is restricted in Vintage: max 1 copy; you have 3.",
        cardIds: ["c-Lightning Bolt"],
      },
    ]);
  });

  /**
   * TRAP A, second meaning: in Duel Commander `restricted` means *banned as commander*, so
   * the main deck hears nothing about it. The copies complaint that remains is the ordinary
   * singleton one — which is the point: a max-one reading would have been no restriction at
   * all in a format that is already singleton. The commander-zone half is Task 9's.
   */
  it("says nothing about a main-deck restricted card where restricted means banned as commander", () => {
    const deck = padTo(100, [
      commander(),
      card({ name: "Sol Ring", quantity: 4, legalities: '{"duel":"restricted"}' }),
    ]);
    const issues = validateDeck(deck, spec("duel"));

    expect(issues.filter((i) => i.code === "restricted")).toEqual([]);
    expect(issues).toEqual([
      {
        severity: "error",
        code: "singleton",
        message: "Duel Commander decks are singleton: max 1 copy of Sol Ring; you have 4.",
        cardIds: ["c-Sol Ring"],
      },
    ]);
  });

  /**
   * TRAP B: `oldschool` is the only printing-sensitive key, and it needs no special case —
   * a deck card names a printing and carries that printing's own blob, so the `lea` row is
   * silent and the `8ed` row is not.
   */
  it("judges Old School per printing, with no special case", () => {
    const deck = padTo(60, [
      card({
        name: "Serra Angel",
        cardId: "serra-lea",
        setCode: "lea",
        legalities: '{"oldschool":"legal"}',
      }),
      card({
        name: "Serra Angel",
        cardId: "serra-8ed",
        setCode: "8ed",
        legalities: '{"oldschool":"not_legal"}',
      }),
    ]);

    expect(validateDeck(deck, spec("oldschool"))).toEqual([
      {
        severity: "error",
        code: "not-legal",
        message: "Serra Angel is not legal in Old School.",
        cardIds: ["serra-8ed"],
      },
    ]);
  });

  /** `has_legality_data` 0 is the whole of what makes casual and limited pseudo-formats. */
  it("checks no legality at all where the format has none", () => {
    const everywhere = JSON.stringify({ modern: "banned", commander: "banned", vintage: "banned" });
    const deck = padTo(40, [card({ quantity: 4, legalities: everywhere })]);

    expect(validateDeck(deck, spec("casual"))).toEqual([]);
    expect(validateDeck(deck, spec("limited"))).toEqual([]);
  });

  /** A format's list not mentioning a card is that card not being in its pool. */
  it("treats a missing key as not legal", () => {
    expect(validateDeck(padTo(60, [card({ legalities: "{}" })]), spec("modern"))[0]).toMatchObject({
      severity: "error",
      code: "not-legal",
      message: "Lightning Bolt is not legal in Modern.",
    });
    expect(validateDeck(padTo(60, [card({ legalities: null })]), spec("modern"))[0]).toMatchObject({
      code: "not-legal",
    });
  });

  /** A blob this app cannot read is not evidence of anything — a warning, never a verdict. */
  it("warns rather than guesses when a legality is unreadable or unknown", () => {
    const unreadable = validateDeck(padTo(60, [card({ legalities: "not json" })]), spec("modern"));
    expect(unreadable[0]).toMatchObject({ severity: "warning", code: "unknown-legality" });

    const unknown = validateDeck(
      padTo(60, [card({ legalities: '{"modern":"probationary"}' })]),
      spec("modern"),
    );
    expect(unknown).toEqual([
      {
        severity: "warning",
        code: "unknown-legality",
        message:
          'Lightning Bolt\'s Modern legality is "probationary", which this app does not know.',
        cardIds: ["c-Lightning Bolt"],
      },
    ]);
  });

  /**
   * An orphan — a row whose printing left the card database — has no facts to judge, so it
   * gets the reconciler's own sentence as a warning instead of a legality guess. It still
   * counts toward deck size: it is a card in the deck, whatever the database knows.
   */
  it("warns about an orphaned row instead of guessing its legality", () => {
    const orphan = card({
      name: "Ancient Tomb",
      needsReview:
        "This printing is not in the card database. It may have been removed by the last card-data sync, or it may return with the next one.",
      oracleId: null,
      manaCost: null,
      cmc: null,
      typeLine: null,
      oracleText: null,
      colors: null,
      colorIdentity: null,
      legalities: null,
      layout: null,
      rarity: null,
    });

    expect(validateDeck(padTo(60, [orphan]), spec("modern"))).toEqual([
      {
        severity: "warning",
        code: "orphan",
        message:
          "Ancient Tomb: This printing is not in the card database. It may have been removed by the last card-data sync, or it may return with the next one.",
        cardIds: ["c-Ancient Tomb"],
      },
    ]);

    // The flag is written by the reconciler *after* the sweep, so a row can be orphaned
    // before there is a sentence to quote.
    const unflagged = validateDeck(padTo(60, [{ ...orphan, needsReview: null }]), spec("modern"));
    expect(unflagged).toEqual([
      {
        severity: "warning",
        code: "orphan",
        message:
          "Ancient Tomb is not in the card database, so it was not checked against Modern's rules.",
        cardIds: ["c-Ancient Tomb"],
      },
    ]);
  });
});

/**
 * The per-card pass runs over rows, and one card is usually several of them — the same
 * printing in `main` and `side`, or two printings of one card. A panel that says "Lightning
 * Bolt is banned in Modern." twice is reporting one problem as two.
 */
describe("one sentence, one finding", () => {
  it("collapses identical sentences and keeps every row they are about", () => {
    // One printing, two zones: one sentence, and the id it already had.
    const twoZones = padTo(60, [
      card({ quantity: 2, legalities: '{"modern":"banned"}' }),
      card({ quantity: 2, zone: "side", legalities: '{"modern":"banned"}' }),
    ]);
    expect(validateDeck(twoZones, spec("modern"))).toEqual([
      {
        severity: "error",
        code: "banned",
        message: "Lightning Bolt is banned in Modern.",
        cardIds: ["c-Lightning Bolt"],
      },
    ]);

    // Two printings of one banned card: still one sentence, now naming both rows.
    const twoPrintings = padTo(60, [
      card({ cardId: "bolt-lea", legalities: '{"modern":"banned"}' }),
      card({ cardId: "bolt-m10", setCode: "m10", legalities: '{"modern":"banned"}' }),
    ]);
    expect(validateDeck(twoPrintings, spec("modern"))).toEqual([
      {
        severity: "error",
        code: "banned",
        message: "Lightning Bolt is banned in Modern.",
        cardIds: ["bolt-lea", "bolt-m10"],
      },
    ]);

    // The same for warnings and for the mana-value ceiling, which are per-row too.
    const orphan = card({
      name: "Ancient Tomb",
      needsReview: "This printing is not in the card database.",
      oracleId: null,
      typeLine: null,
      oracleText: null,
      cmc: null,
      manaCost: null,
      legalities: null,
      layout: null,
      rarity: null,
    });
    const orphanTwice = padTo(60, [orphan, { ...orphan, zone: "side" as const }]);
    expect(validateDeck(orphanTwice, spec("modern"))).toEqual([
      {
        severity: "warning",
        code: "orphan",
        message: "Ancient Tomb: This printing is not in the card database.",
        cardIds: ["c-Ancient Tomb"],
      },
    ]);

    const dreadmaw = card({ name: "Colossal Dreadmaw", manaCost: "{4}{G}{G}", cmc: 6 });
    const bigTwice = padTo(50, [dreadmaw, { ...dreadmaw, zone: "side" as const }]);
    expect(validateDeck(bigTwice, spec("tlr")).filter((i) => i.code === "mana-value")).toHaveLength(
      1,
    );
  });

  /**
   * And the other direction, which is the one that matters for Old School: two printings of
   * one card whose blobs *disagree* are two different sentences — or, here, one sentence and
   * silence. Collapsing is by what was said, never by which card said it.
   */
  it("keeps sentences that genuinely differ apart", () => {
    const deck = padTo(60, [
      card({ name: "Serra Angel", cardId: "serra-lea", legalities: '{"oldschool":"legal"}' }),
      card({ name: "Serra Angel", cardId: "serra-8ed", legalities: '{"oldschool":"not_legal"}' }),
      card({ name: "Chaos Orb", cardId: "orb-lea", legalities: '{"oldschool":"banned"}' }),
    ]);

    expect(validateDeck(deck, spec("oldschool"))).toEqual([
      {
        severity: "error",
        code: "not-legal",
        message: "Serra Angel is not legal in Old School.",
        cardIds: ["serra-8ed"],
      },
      {
        severity: "error",
        code: "banned",
        message: "Chaos Orb is banned in Old School.",
        cardIds: ["orb-lea"],
      },
    ]);
  });
});

describe("sideboard and mana value", () => {
  it("caps a sideboard where the format has one", () => {
    const deck = [islands(60), islands(16, "side")];

    expect(validateDeck(deck, spec("modern"))).toEqual([
      {
        severity: "error",
        code: "sideboard-size",
        message: "Sideboards are capped at 15 cards; you have 16.",
      },
    ]);
    expect(validateDeck([islands(60), islands(15, "side")], spec("modern"))).toEqual([]);
  });

  /**
   * `sideboard_max` 0 means *no sideboard* — and a companion is not a sideboard card there.
   * EDH's companion is "effectively a 101st card"; the Brawls, Oathbreaker, PDH, Duel and
   * PreDH all carry the same pair of cells, which is why this is read from `sideboard_max`
   * and not from a format key.
   */
  it("refuses a sideboard where the format has none, and still allows the companion", () => {
    const withSide = [commander(), islands(99), islands(1, "side")];
    expect(validateDeck(withSide, spec("commander"))).toEqual([
      {
        severity: "error",
        code: "sideboard-size",
        message: "Commander decks have no sideboard.",
      },
    ]);

    const withCompanion = [
      commander(),
      islands(99),
      card({ name: "Lurrus of the Dream-Den", zone: "companion" }),
    ];
    expect(validateDeck(withCompanion, spec("commander"))).toEqual([]);
  });

  /** Where the format *does* have a sideboard, the companion occupies one of its slots. */
  it("counts the companion against a real sideboard cap", () => {
    const deck = [
      islands(60),
      islands(15, "side"),
      card({ name: "Lurrus of the Dream-Den", zone: "companion" }),
    ];

    expect(validateDeck(deck, spec("modern"))[0].message).toBe(
      "Sideboards are capped at 15 cards; you have 16.",
    );
  });

  /** NULL is *uncapped*: Limited plays the rest of its pool. */
  it("says nothing about an uncapped sideboard", () => {
    expect(validateDeck([islands(40), islands(40, "side")], spec("limited"))).toEqual([]);
  });

  it("holds every card to the format's mana-value ceiling", () => {
    const dreadmaw = card({
      name: "Colossal Dreadmaw",
      manaCost: "{4}{G}{G}",
      cmc: 6,
      typeLine: "Creature — Dinosaur",
    });

    expect(validateDeck(padTo(50, [dreadmaw]), spec("tlr"))).toEqual([
      {
        severity: "error",
        code: "mana-value",
        message:
          "Colossal Dreadmaw has mana value 6; Tiny Leaders: Reborn caps every card and every face at 3.",
        cardIds: ["c-Colossal Dreadmaw"],
      },
    ]);
    // The cap is a cell, not a rule: Modern has none, and a 6-drop is a 6-drop.
    expect(validateDeck(padTo(60, [dreadmaw]), spec("modern"))).toEqual([]);
  });

  /**
   * "Every card **and every face**" (research doc). Fae of Wishes is a real adventure whose
   * own mana value is 2 — under the cap — while its adventure half, Granted, costs {3}{U}.
   * Per-face costs live only in `faces`, and an adventure's faces carry no `cmc` of their
   * own, so the value has to be computed from the printed cost.
   */
  it("reads every face, even when the card's own mana value is legal", () => {
    const fae = card({
      name: "Fae of Wishes",
      manaCost: "{1}{U}",
      cmc: 2,
      typeLine: "Creature — Faerie // Sorcery — Adventure",
      faces: JSON.stringify([
        { name: "Fae of Wishes", mana_cost: "{1}{U}", type_line: "Creature — Faerie" },
        { name: "Granted", mana_cost: "{3}{U}", type_line: "Sorcery — Adventure" },
      ]),
    });

    expect(validateDeck(padTo(50, [fae]), spec("tlr"))).toEqual([
      {
        severity: "error",
        code: "mana-value",
        message:
          "Fae of Wishes has a face with mana value 4; Tiny Leaders: Reborn caps every card and every face at 3.",
        cardIds: ["c-Fae of Wishes"],
      },
    ]);
  });
});

/** The one arithmetic, exported because Task 15's curve must not grow a second one. */
describe("manaValueOf", () => {
  it("adds the symbols the way Magic does", () => {
    expect(manaValueOf("{2}{U}")).toBe(3);
    expect(manaValueOf("{0}")).toBe(0);
    expect(manaValueOf("{W}{U}{B}{R}{G}")).toBe(5);
    // X is 0 everywhere but on the stack (CR 202.3b).
    expect(manaValueOf("{X}")).toBe(0);
    expect(manaValueOf("{X}{R}{R}")).toBe(2);
    // Hybrids count once; a twobrid counts its generic half.
    expect(manaValueOf("{W/U}")).toBe(1);
    expect(manaValueOf("{2/W}{2/W}")).toBe(4);
    expect(manaValueOf("{W/P}")).toBe(1);
    expect(manaValueOf("{C}{S}")).toBe(2);
    expect(manaValueOf(null)).toBe(0);
    expect(manaValueOf("")).toBe(0);
  });
});
