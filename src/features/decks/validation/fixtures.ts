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
import type { CategoryKind, FormatSpec } from "@/lib/ipc";

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
  // The one seeded format that forbids companions outright, and the reason is the cell next
  // to it: no sideboard, so no sideboard slot for one to sit in (research doc).
  gladiator: {
    key: "gladiator",
    displayName: "Gladiator",
    enabledInPicker: true,
    deckMin: 100,
    deckMax: null,
    maxCopies: 1,
    sideboardMax: 0,
    singleton: true,
    requiresCommander: false,
    commanderRule: null,
    life: 20,
    restrictedSemantic: "max_one",
    hasLegalityData: true,
    maxManaValue: null,
    allowsCompanion: false,
    sortOrder: 5,
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
 * The category each kind is filed under, so a fixture that names only a kind still lands in a
 * coherent category: two cards of one kind share a category and two kinds never do.
 *
 * The four fixed names are `schema::PREDEFINED_CATEGORIES` verbatim. `main` has no predefined
 * row — a deck may own any number of `main` categories and the seed names none — so the name
 * here is `"Main deck"`, which is what the v8 migration calls the category it files every
 * legacy `main` row into. The ids are this file's own and mean nothing beyond "two kinds are
 * two categories"; no rule in this folder reads {@link CardFacts.categoryId}, and a test that
 * cares about a *particular* category passes one.
 */
const CATEGORIES: Record<CategoryKind, { id: number; name: string }> = {
  main: { id: 1, name: "Main deck" },
  side: { id: 2, name: "Sideboard" },
  commander: { id: 3, name: "Commander" },
  companion: { id: 4, name: "Companion" },
  maybe: { id: 5, name: "Maybeboard" },
};

/**
 * One `deck_cards` row as Task 5's read answers it.
 *
 * `cardId` and `oracleId` default from the name, which is what makes two rows of the same
 * card in two categories group together the way they do in the database — a printing can sit
 * in the main deck and the sideboard at once (the unique index is on
 * `(deck, card, category, variant)`).
 *
 * **`categoryActive` defaults to `categoryKind !== "maybe"`**, mirroring
 * `schema::PREDEFINED_CATEGORIES`: the Maybeboard is the one predefined category seeded off,
 * and every other pile a deck is born with is on. That default is what keeps this the *only*
 * place schema v8 is visible to a test that was written against the old zones — a fixture
 * saying `categoryKind: "maybe"` still means what `zone: "maybe"` meant, with no second edit.
 *
 * A test about the switch itself says so: `categoryActive: true` on a `maybe` kind is a
 * Maybeboard the user turned on, `categoryActive: false` on a `main` kind is a category of
 * their own they turned off, and the engine treats those two exactly as it treats the seeded
 * defaults — which is the whole point of the category model and is pinned in `engine.test.ts`.
 */
export function card(overrides: Partial<CardFacts> = {}): CardFacts {
  const name = overrides.name ?? "Lightning Bolt";
  const kind = overrides.categoryKind ?? "main";
  const category = CATEGORIES[kind];
  return {
    id: nextRow++,
    cardId: `c-${name}`,
    categoryId: category.id,
    categoryName: category.name,
    categoryKind: kind,
    categoryActive: kind !== "maybe",
    variant: "live",
    tagId: null,
    tagName: null,
    tagColor: null,
    quantity: 1,
    name,
    setCode: "lea",
    setName: "Limited Edition Alpha",
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
    // A printing fact the engine never reads -- it is here so the row is a whole DeckCard.
    finishes: null,
    everUncommon: false,
    // Unpriced by default: the validation engine never reads money, and a fixture that quoted
    // a number would make a money assertion elsewhere pass for the wrong reason. A test about
    // price sets the one field.
    unitPrice: null,
    ownedQuantity: 0,
    ...overrides,
  };
}

/**
 * Filler that no rule objects to: basics are exempt from every copy limit (CR 100.2a),
 * and blue sits inside both commander fixtures' colour identities.
 *
 * The oracle text is the printed one — a basic land's whole text is the reminder for its
 * intrinsic mana ability, `"({T}: Add {U}.)"`, and Task 10's Zirda condition ("each
 * permanent card has an activated ability") is decided by exactly that string. A blank
 * fixture there would have made the most common card in Magic fail the rule.
 */
export function islands(quantity: number, kind: CategoryKind = "main"): CardFacts {
  return card({
    name: "Island",
    typeLine: "Basic Land — Island",
    manaCost: null,
    cmc: 0,
    oracleText: "({T}: Add {U}.)",
    colors: null,
    colorIdentity: "U",
    quantity,
    categoryKind: kind,
  });
}

/**
 * A card on the Game Changers list, which is a **column** and not a list this app keeps
 * (`cards.game_changer`, 53 cards on 2026-08-04 and growing with every panel update).
 *
 * Real printings, and the flag is the point: the bracket estimate hangs entirely on it, and
 * before Task 10 no fixture anywhere in the app — TypeScript or Rust — carried a `true`.
 * Verified against the local card database on 2026-08-05.
 */
export const GAME_CHANGERS: Record<string, Partial<CardFacts>> = {
  "Rhystic Study": {
    manaCost: "{2}{U}",
    cmc: 3,
    typeLine: "Enchantment",
    oracleText:
      "Whenever an opponent casts a spell, you may draw a card unless that player pays {1}.",
    colors: "U",
    colorIdentity: "U",
    rarity: "common",
  },
  "Cyclonic Rift": {
    manaCost: "{1}{U}",
    cmc: 2,
    typeLine: "Instant",
    oracleText:
      "Return target nonland permanent you don't control to its owner's hand.\n" +
      'Overload {6}{U} (You may cast this spell for its overload cost. If you do, change "target" in its text to "each.")',
    colors: "U",
    colorIdentity: "U",
    rarity: "rare",
  },
  "The One Ring": {
    manaCost: "{4}",
    cmc: 4,
    typeLine: "Legendary Artifact",
    oracleText:
      "Indestructible\nWhen The One Ring enters, if you cast it, you gain protection from " +
      "everything until your next turn.\nAt the beginning of your upkeep, you lose 1 life for " +
      "each burden counter on The One Ring.\n{T}: Put a burden counter on The One Ring, then " +
      "draw a card for each burden counter on The One Ring.",
    colors: null,
    colorIdentity: "",
    rarity: "mythic",
  },
  "Ancient Tomb": {
    manaCost: null,
    cmc: 0,
    typeLine: "Land",
    oracleText: "{T}: Add {C}{C}. This land deals 2 damage to you.",
    colors: null,
    colorIdentity: "",
    rarity: "mythic",
  },
  "Demonic Tutor": {
    manaCost: "{1}{B}",
    cmc: 2,
    typeLine: "Sorcery",
    oracleText: "Search your library for a card, put that card into your hand, then shuffle.",
    colors: "B",
    colorIdentity: "B",
    rarity: "uncommon",
  },
  "Smothering Tithe": {
    manaCost: "{3}{W}",
    cmc: 4,
    typeLine: "Enchantment",
    oracleText:
      "Whenever an opponent draws a card, that player may pay {2}. If the player doesn't, you " +
      "create a Treasure token. (It's an artifact with \"{T}, Sacrifice this token: Add one " +
      'mana of any color.")',
    colors: "W",
    colorIdentity: "W",
    rarity: "mythic",
  },
  "Mox Diamond": {
    manaCost: "{0}",
    cmc: 0,
    typeLine: "Artifact",
    oracleText:
      "If this artifact would enter, you may discard a land card instead. If you do, put this " +
      "artifact onto the battlefield. If you don't, put it into its owner's graveyard.\n" +
      "{T}: Add one mana of any color.",
    colors: null,
    colorIdentity: "",
    rarity: "rare",
  },
};

/** One of {@link GAME_CHANGERS} as a deck row, flag set. */
export function gameChanger(
  name: keyof typeof GAME_CHANGERS,
  kind: CategoryKind = "main",
): CardFacts {
  return card({ ...GAME_CHANGERS[name], name, gameChanger: true, categoryKind: kind });
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
    categoryKind: "commander",
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
    categoryKind: "commander",
    typeLine: "Legendary Creature — Human Warrior",
    manaCost: "{2}{R}",
    cmc: 3,
    power: "3",
    toughness: "2",
    colors: "R",
    colorIdentity: "BGRUW",
  });
}

/**
 * Pad the size-counting kinds (`main` + `commander`) out to a legal deck with basics, so a
 * test about copies or legality does not also trip the deck-size rule.
 *
 * It reads `categoryActive` as well as the kind, because the engine's size rule does: a
 * switched-off pile of fifty cards counts toward nothing there, and a helper that counted it
 * here would pad fifty cards short and hand the test the deck-size error it was written to
 * avoid.
 */
export function padTo(size: number, cards: CardFacts[]): CardFacts[] {
  const counted = cards
    .filter(
      (c) => c.categoryActive && (c.categoryKind === "main" || c.categoryKind === "commander"),
    )
    .reduce((n, c) => n + c.quantity, 0);
  return counted < size ? [...cards, islands(size - counted)] : cards;
}
