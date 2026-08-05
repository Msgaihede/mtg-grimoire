/**
 * The one set of deck fixtures the validation tests share.
 *
 * Task 8 kept a `card()` builder and a hand-copied `format_specs` mirror inside
 * `engine.test.ts`; Tasks 9 and 10 need both, and a second hand-copied mirror is a second
 * place for a cell to drift away from `schema.rs`'s `FORMAT_SPECS_SEED`. So there is one,
 * here, and every test file imports it.
 *
 * **The `SPECS` table is a mirror, not a source.** Its authority is Task 2's Rust test
 * (`format_specs_is_seeded_with_all_25_formats_and_the_load_bearing_cells`), which checks
 * every load-bearing cell of all 25 rows against the research doc. These rows are copied
 * cell-for-cell from the seed so the engine can be exercised without a database — and so
 * that a test failing here is about the engine, never about a number.
 *
 * Not a `.test.ts` file on purpose: Vitest would collect it and report "no test suite".
 */
import type { CardFacts } from "./types";
import type { DeckZone, FormatSpec } from "@/lib/ipc";

/** The seeded rows these tests judge against, hand-copied from `schema.rs`. */
export const SPECS: Record<string, FormatSpec> = {
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
  oathbreaker: {
    key: "oathbreaker",
    displayName: "Oathbreaker",
    enabledInPicker: true,
    deckMin: 60,
    deckMax: 60,
    maxCopies: 1,
    sideboardMax: 0,
    singleton: true,
    requiresCommander: true,
    commanderRule: "oathbreaker",
    life: 20,
    restrictedSemantic: "max_one",
    hasLegalityData: true,
    maxManaValue: null,
    allowsCompanion: true,
    sortOrder: 13,
  },
  brawl: {
    key: "brawl",
    displayName: "Brawl",
    enabledInPicker: true,
    deckMin: 100,
    deckMax: 100,
    maxCopies: 1,
    sideboardMax: 0,
    singleton: true,
    requiresCommander: true,
    commanderRule: "brawl",
    life: 25,
    restrictedSemantic: "max_one",
    hasLegalityData: true,
    maxManaValue: null,
    allowsCompanion: true,
    sortOrder: 15,
  },
  paupercommander: {
    key: "paupercommander",
    displayName: "Pauper Commander",
    enabledInPicker: true,
    deckMin: 100,
    deckMax: 100,
    maxCopies: 1,
    sideboardMax: 0,
    singleton: true,
    requiresCommander: true,
    commanderRule: "pdh",
    life: 30,
    restrictedSemantic: "max_one",
    hasLegalityData: true,
    maxManaValue: null,
    allowsCompanion: true,
    sortOrder: 18,
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

export function spec(key: keyof typeof SPECS): FormatSpec {
  return SPECS[key];
}

/** Legal in every format these tests use, so a fixture only says what it is *about*. */
export const LEGAL = JSON.stringify({
  modern: "legal",
  vintage: "legal",
  commander: "legal",
  oathbreaker: "legal",
  brawl: "legal",
  paupercommander: "legal",
  duel: "legal",
  oldschool: "legal",
  tlr: "legal",
});

let nextRow = 1;

/** Row ids are unique per file run and nothing asserts on them; this only keeps a failure
 *  message from depending on how many tests ran before it. */
export function resetRowIds(): void {
  nextRow = 1;
}

/**
 * One `deck_cards` row as Task 5's read answers it.
 *
 * `cardId` and `oracleId` default from the name, which is what makes two rows of the same
 * card in two zones group together the way they do in the database — a printing can sit in
 * `main` and `side` at once (the unique index is on `(deck, card, zone)`).
 */
export function card(overrides: Partial<CardFacts> = {}): CardFacts {
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

/** Filler that no rule objects to: basics are exempt from every copy limit (CR 100.2a),
 *  and blue sits inside both commander fixtures' colour identities. */
export function islands(quantity: number, zone: DeckZone = "main"): CardFacts {
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

/**
 * A commander, so a Commander-format fixture is about the card it is about.
 *
 * **Kenrith, the Returned King** rather than a mono-coloured legend, and the reason is
 * CR 903.5c: from Task 9 on, every card in a commander deck is judged against the
 * commander's colour identity, and Kenrith's five activated abilities put all five colours
 * in his. A fixture about copy limits is then never also a fixture about colour identity.
 * Real card, verified against the local card database: `{4}{W}`, 5/5, identity WUBRG.
 */
export function commander(): CardFacts {
  return card({
    name: "Kenrith, the Returned King",
    zone: "commander",
    typeLine: "Legendary Creature — Human Noble",
    manaCost: "{4}{W}",
    cmc: 5,
    power: "5",
    toughness: "5",
    colors: "W",
    colorIdentity: "BGRUW",
  });
}

/**
 * The same job under Tiny Leaders: Reborn, whose mana-value ceiling is 3 and whose decks
 * need a commander like every other commander format.
 *
 * **Najeela, the Blade-Blossom** is the rare card that is both: `{2}{R}` (mana value 3,
 * under the cap) with a `{W}{U}{B}{R}{G}` activated ability, so her colour identity is all
 * five. Verified against the local card database.
 */
export function tinyCommander(): CardFacts {
  return card({
    name: "Najeela, the Blade-Blossom",
    zone: "commander",
    typeLine: "Legendary Creature — Human Warrior",
    manaCost: "{2}{R}",
    cmc: 3,
    power: "3",
    toughness: "2",
    colors: "R",
    colorIdentity: "BGRUW",
  });
}

/** Pad the size-counting zones (`main` + `commander`) out to a legal deck with basics, so
 *  a test about copies or legality does not also trip the deck-size rule. */
export function padTo(size: number, cards: CardFacts[]): CardFacts[] {
  const counted = cards
    .filter((c) => c.zone === "main" || c.zone === "commander")
    .reduce((n, c) => n + c.quantity, 0);
  return counted < size ? [...cards, islands(size - counted)] : cards;
}
