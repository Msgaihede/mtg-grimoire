/**
 * The deck stats goldens — `stats.json`, `odds.json` and `mana.json` under `../__golden__/`, which
 * `crates/grimoire-core/src/deck_stats/` must reproduce (`golden.ts` says how a golden is written
 * and read).
 *
 * - `stats.json`: per case the cards, `deckStats` both ways of `separateXGroup`, the creature split
 *   off each, `typeCounts`, `typeBreakdown`, which rows `activeCards`, `sizedCards` and
 *   `libraryCards` keep, and each row's `cardManaValue`, `isMdfcLand` and `isShort`.
 * - `odds.json`: a grid of `handOdds` inputs with their answers, and a grid of `choose`.
 * - `mana.json`: per string (every cost, type line and produced-mana string in the stats cases,
 *   plus edge strings) the answers of the string readers in `mana.ts`, `deckBuckets.ts` and
 *   `typeBreakdownCounts.ts`.
 *
 * The inputs are lifted from `DeckStats.test.tsx`, `typeBreakdownCounts.test.ts`,
 * `deckBuckets.test.ts`, `mana.test.ts` and `openingHand.test.ts`, plus the edges a port gets
 * wrong: orphans, float sums, odd spacing and dashes, a category whose rows disagree.
 */
import { describe, expect, it } from "vitest";
import type { DeckCard } from "@/lib/ipc";
import { countPips, hasVariableCost, producedKeys } from "@/lib/mana";
import { deckStats, isShort } from "../DeckStats";
import {
  activeCards,
  back,
  cardManaValue,
  front,
  isCreature,
  isLand,
  isMdfcLand,
  libraryCards,
  MODAL_DFC,
  sizedCards,
  typeBucket,
  typeCounts,
} from "../deckBuckets";
import { choose, handOdds, type OddsMode } from "../openingHand";
import { creatureSplit, subtypes, typeBreakdown } from "../stats/typeBreakdownCounts";
import { card, islands, resetRowIds } from "../validation/fixtures";
import { goldenText, type GoldenCase } from "./golden";

// ---------------------------------------------------------------------------------------------
// Builders — the TS suites' own, lifted so a case reads as it does there.
// ---------------------------------------------------------------------------------------------

/** A nonland at a given cost (`DeckStats.test.tsx`' `spell`). */
const spell = (name: string, cmc: number, over: Partial<DeckCard> = {}): DeckCard =>
  card({ name, cmc, typeLine: "Sorcery", manaCost: `{${cmc}}`, ...over });

/** Agadeem's Awakening's shape: `{X}{B}{B}{B}`, mana value 3 (`DeckStats.test.tsx`' `xSpell`). */
const xSpell = (name: string, over: Partial<DeckCard> = {}): DeckCard =>
  card({ name, cmc: 3, typeLine: "Sorcery", manaCost: "{X}{B}{B}{B}", ...over });

/** A land that taps for `produced` and nothing else (`DeckStats.test.tsx`' `dual`). */
const dual = (name: string, produced: string, quantity = 1): DeckCard =>
  card({
    name,
    typeLine: "Land",
    manaCost: null,
    cmc: 0,
    colors: null,
    producedMana: produced,
    quantity,
  });

/** `typeBreakdownCounts.test.ts`' `land`. */
const land = (name: string, typeLine: string, quantity = 1): DeckCard =>
  card({ name, typeLine, quantity, manaCost: null, cmc: 0, colors: null });

/** `typeBreakdownCounts.test.ts`' `creature`. */
const creature = (name: string, typeLine: string, quantity = 1, cmc = 2): DeckCard =>
  card({ name, typeLine, quantity, cmc, manaCost: `{${cmc}}` });

/** A row whose printing has left the corpus: the deck read's `LEFT JOIN` miss, every card fact
 *  null — the four `isOrphan` reads among them. */
const orphan = (name: string, over: Partial<DeckCard> = {}): DeckCard =>
  card({
    name,
    setName: null,
    oracleId: null,
    manaCost: null,
    cmc: null,
    typeLine: null,
    oracleText: null,
    colors: null,
    colorIdentity: null,
    producedMana: null,
    legalities: null,
    layout: null,
    rarity: null,
    gameChanger: null,
    ...over,
  });

/** A whole switched-off row. */
const off = (row: DeckCard): DeckCard => ({ ...row, categoryActive: false });

// ---------------------------------------------------------------------------------------------
// stats.json
// ---------------------------------------------------------------------------------------------

/** Every stats case's cards, by name. Row ids restart at 1 per case. */
const STATS: readonly (readonly [string, () => DeckCard[]])[] = [
  ["an empty deck", () => []],

  // DeckStats.test.tsx — the curve.
  [
    "curve: nine buckets over nonlands, the last open-ended",
    () => [
      spell("Ritual", 1, { quantity: 4 }),
      spell("Gift", 3, { quantity: 2 }),
      spell("Emrakul", 15),
      spell("Kozilek", 8),
      islands(24),
    ],
  ],
  [
    "curve: a mana value read off the printed cost, fractions and clamps",
    () => [
      spell("Counterspell", 0, { cmc: null, manaCost: "{U}{U}" }),
      spell("Little Girl", 0, { cmc: null, manaCost: "{½}", colors: "W" }),
      spell("Beseech the Queen", 0, { cmc: null, manaCost: "{2/B}{2/B}{2/B}", colors: "B" }),
      spell("Gleemax", 1000000, { typeLine: "Legendary Artifact", colors: null }),
      spell("Half step", 2.5, { manaCost: "{2}{½}", quantity: 3 }),
      spell("Below zero", -1, { manaCost: "{0}" }),
      spell("Seven and a half", 7.5, { manaCost: "{7}{½}" }),
    ],
  ],
  [
    "curve: a row with no mana value anywhere",
    () => [spell("Bolt", 1), card({ name: "Ghost", cmc: null, manaCost: null, typeLine: null })],
  ],
  [
    "orphans: every card fact null, in three piles",
    () => [
      orphan("Gone A", { quantity: 2 }),
      orphan("Gone B", { categoryKind: "side" }),
      orphan("Gone C", { categoryKind: "maybe", quantity: 3 }),
      spell("Bolt", 1, { unitPrice: 0.5 }),
    ],
  ],

  // DeckStats.test.tsx — the X bar.
  [
    "x: spells beside one-drops, an orphan and lands",
    () => [
      xSpell("Awakening", { quantity: 4 }),
      spell("Bolt", 1, { quantity: 4 }),
      card({ name: "Ghost", cmc: null, manaCost: null, typeLine: null }),
      islands(20),
    ],
  ],
  ["x: a spell with no cmc", () => [xSpell("Awakening", { cmc: null })]],
  [
    "x: a {Y} cost stays in its numeric bucket",
    () => [card({ name: "Ashnod's Coupon", cmc: 0, manaCost: "{Y}" })],
  ],
  [
    "x: lowercase, doubled, split and on a land",
    () => [
      card({ name: "Fireball", manaCost: "{x}{R}", cmc: 1, quantity: 3 }),
      card({ name: "Double X", manaCost: "{X}{X}{G}", cmc: 1, colors: "G", quantity: 2 }),
      card({ name: "Split X", manaCost: "{X}{R} // {1}{U}", cmc: 3, colors: "RU" }),
      card({ name: "X land", typeLine: "Land", manaCost: "{X}", cmc: 0, colors: null }),
      card({ name: "Brace X", manaCost: "{{X}}", cmc: 1, colors: null }),
    ],
  ],

  // DeckStats.test.tsx — the creature split.
  [
    "creatures: per curve bucket, a subset of the curve",
    () => [
      spell("Goblin Guide", 1, { typeLine: "Creature — Goblin Scout", quantity: 4 }),
      spell("Shock", 1, { quantity: 2 }),
      spell("Walking Ballista", 0, { typeLine: "Artifact Creature — Construct", quantity: 1 }),
      spell("Fireball", 5, { typeLine: "Sorcery", quantity: 3 }),
      spell("Craterhoof Behemoth", 8, { typeLine: "Creature — Beast", quantity: 1 }),
    ],
  ],
  [
    "creatures: an X creature moves into the X bar's count",
    () => [
      xSpell("Hydroid Krasis", { typeLine: "Creature — Jellyfish Hydra Beast", quantity: 2 }),
      xSpell("Agadeem's Awakening", { quantity: 1 }),
      spell("Tarmogoyf", 3, { typeLine: "Creature — Lhurgoyf", quantity: 1 }),
    ],
  ],
  [
    "creatures: the front face decides, and lands are left out",
    () => [
      spell("Emeria's Call", 7, { typeLine: "Sorcery // Land", layout: "modal_dfc" }),
      spell("Bala Ged Recovery", 3, { typeLine: "Sorcery // Land", layout: "modal_dfc" }),
      spell("Delver of Secrets", 1, {
        typeLine: "Creature — Human Wizard // Creature — Human Insect",
        layout: "transform",
        quantity: 4,
      }),
      spell("Tergrid's Shadow", 5, { typeLine: "Instant // Creature — God" }),
      card({ name: "Dryad Arbor", typeLine: "Land Creature — Forest Dryad", cmc: 0 }),
    ],
  ],

  // DeckStats.test.tsx — pips.
  [
    "pips: twice over for a card that asks twice, {C} apart from generic",
    () => [
      card({ name: "Bolas's Citadel", manaCost: "{1}{B}{B}", colors: "B", quantity: 4 }),
      card({ name: "Bolt", manaCost: "{R}", colors: "R", quantity: 4 }),
      card({ name: "Kozilek's Predator", manaCost: "{3}{C}{G}", colors: "G" }),
      card({ name: "Sol Ring", manaCost: "{1}", colors: null, typeLine: "Artifact" }),
    ],
  ],
  [
    "pips: from the cost and not from the colours",
    () => [
      card({ name: "Ancestral Vision", manaCost: "{U}", colors: "U", colorIdentity: "WUBRG" }),
      card({ name: "Suspended Vision", manaCost: "{0}", colors: "U", colorIdentity: "U" }),
    ],
  ],
  [
    "pips: hybrid and twobrid",
    () => [
      card({ name: "Boros Charm", manaCost: "{R}{W}", colors: "RW" }),
      card({ name: "Figure of Destiny", manaCost: "{R/W}", colors: "RW" }),
      card({ name: "Beseech the Queen", manaCost: "{2/B}{2/B}{2/B}", colors: "B" }),
    ],
  ],
  [
    "pips: Phyrexian, hybrid Phyrexian, colourless, split and lowercase costs",
    () => [
      card({ name: "Tamiyo's Safekeeping", manaCost: "{W/U/P}", cmc: 1, colors: "WU" }),
      card({ name: "Mutagenic Growth", manaCost: "{G/P}{G/P}", cmc: 2, colors: "G" }),
      card({ name: "Eldrazi", manaCost: "{1}{C}{C}", cmc: 3, colors: null, quantity: 2 }),
      card({ name: "Fire // Ice", manaCost: "{1}{R} // {1}{U}", cmc: 4, colors: "RU" }),
      card({ name: "Nothing coloured", manaCost: "{2}{X}{Y}{Z}{S}{E}{T}{Q}", cmc: 2 }),
      card({ name: "Gleemax", manaCost: "{100}{1000000}", cmc: 1000100, colors: null }),
      card({ name: "Lowercase", manaCost: "{x}{r}{w/u}", cmc: 2, colors: "RWU" }),
      card({ name: "Spaced", manaCost: "{ W }{w}", cmc: 2, colors: "W" }),
    ],
  ],
  [
    "average: over nonlands only",
    () => [spell("A", 1), spell("B", 3), islands(10)],
  ],
  ["average: none for a deck of nothing but lands", () => [islands(10)]],

  // DeckStats.test.tsx — money.
  [
    "price: summed by copies, the unpriced counted",
    () => [
      spell("Bolt", 1, { quantity: 4, unitPrice: 2.5 }),
      spell("Bear", 2, { quantity: 2, unitPrice: null }),
    ],
  ],
  [
    "price: every row priced",
    () => [
      spell("Bolt", 1, { quantity: 4, unitPrice: 2.5 }),
      spell("Rare Bomb", 2, { quantity: 2, unitPrice: 50 }),
    ],
  ],
  [
    "price: nothing priced",
    () => [spell("Rare Bomb", 2, { quantity: 2, unitPrice: null })],
  ],
  [
    "price: split the way the copies are",
    () => [
      spell("Bolt", 1, { quantity: 4, ownedQuantity: 1, unitPrice: 5 }),
      spell("Bear", 2, { quantity: 2, ownedQuantity: 2, unitPrice: 3 }),
      spell("Ghost", 3, { quantity: 2, ownedQuantity: 0, unitPrice: null }),
    ],
  ],
  [
    "price: nothing priced and partly owned",
    () => [spell("Bolt", 1, { quantity: 4, ownedQuantity: 2, unitPrice: null })],
  ],
  [
    "price: floating-point sums in row order, owned past the want, a parked pile",
    () => [
      spell("Dime", 1, { quantity: 3, unitPrice: 0.1, ownedQuantity: 1 }),
      spell("Two dimes", 1, { quantity: 1, unitPrice: 0.2 }),
      spell("Almost twenty", 2, { quantity: 4, unitPrice: 19.99, ownedQuantity: 3 }),
      spell("Seven cents", 2, { quantity: 7, unitPrice: 0.07, ownedQuantity: 9 }),
      spell("Side", 1, { categoryKind: "side", quantity: 2, unitPrice: 1.15, ownedQuantity: 1 }),
      spell("Parked", 5, { categoryKind: "maybe", quantity: 9, unitPrice: 100 }),
      spell("Free", 0, { quantity: 2, unitPrice: 0 }),
      spell("Third", 3, { quantity: 3, unitPrice: 1 / 3, ownedQuantity: 2 }),
    ],
  ],
  [
    "owned and missing agree with the rows",
    () => [
      spell("Bolt", 1, { quantity: 4, ownedQuantity: 1 }),
      spell("Bear", 2, { quantity: 2, ownedQuantity: 2 }),
      spell("Parked", 2, { categoryKind: "maybe", quantity: 2, ownedQuantity: 0 }),
    ],
  ],

  // DeckStats.test.tsx — sources.
  [
    "sources: once in every colour a card makes",
    () => [
      card({ name: "Azorius Charm", manaCost: "{W}{U}", colors: "WU", producedMana: "" }),
      dual("Hallowed Fountain", "WU", 4),
      card({
        name: "Sol Ring",
        typeLine: "Artifact",
        manaCost: "{1}",
        cmc: 1,
        colors: null,
        producedMana: "C",
      }),
    ],
  ],
  [
    "sources: unanswered when every row predates the column",
    () => [
      card({ name: "Bolt", manaCost: "{R}", producedMana: null, quantity: 4 }),
      card({
        name: "Mountain",
        typeLine: "Basic Land — Mountain",
        manaCost: null,
        cmc: 0,
        colors: null,
        producedMana: null,
        quantity: 20,
      }),
    ],
  ],
  [
    "sources: zeroes answered",
    () => [card({ name: "Bolt", manaCost: "{R}", producedMana: "", quantity: 4 })],
  ],
  [
    "sources: one row answers, an orphan first",
    () => [
      card({ name: "Ghost", manaCost: null, typeLine: null, producedMana: null }),
      dual("Island", "U", 1),
      card({ name: "Counterspell", manaCost: "{U}{U}", producedMana: "" }),
    ],
  ],
  [
    "sources: one row answers, an orphan last",
    () => [
      dual("Island", "U", 1),
      card({ name: "Ghost", manaCost: null, typeLine: null, producedMana: null }),
    ],
  ],
  [
    "sources: only where a cost asks, a dual in a mono-white deck",
    () => [
      card({ name: "Swords", manaCost: "{W}", colors: "W", producedMana: "" }),
      dual("Hallowed Fountain", "WU", 4),
      dual("Plains", "W", 10),
    ],
  ],
  [
    "sources: colourless always",
    () => [
      card({ name: "Swords", manaCost: "{W}", colors: "W", producedMana: "" }),
      dual("Plains", "W", 10),
      card({
        name: "Sol Ring",
        typeLine: "Artifact",
        manaCost: "{1}",
        cmc: 1,
        colors: null,
        producedMana: "C",
      }),
    ],
  ],
  [
    "sources: a switched-off pile asks for nothing",
    () => [
      card({ name: "Swords", manaCost: "{W}", colors: "W", producedMana: "" }),
      card({ name: "Counterspell", manaCost: "{U}{U}", producedMana: "", categoryActive: false }),
      dual("Hallowed Fountain", "WU", 4),
      off(dual("Parked Tomb", "C", 3)),
    ],
  ],
  [
    "sources: odd produced strings",
    () => [
      card({ name: "Domain", manaCost: "{W}{U}{B}{R}{G}", cmc: 5, colors: "WUBRG" }),
      dual("Command Tower", "WUBRG", 1),
      dual("Ancient Tomb", "C2", 2),
      dual("Doubled", "UU", 1),
      dual("Lowercase", "wu", 1),
      dual("Everything", "WUBRGC2", 1),
      dual("Generic only", "2", 1),
    ],
  ],

  // DeckStats.test.tsx — curves per colour.
  [
    "colour curves: a gold spell in each of its colours, colourless apart",
    () => [
      card({ name: "Bolt", manaCost: "{R}", colors: "R", cmc: 1, quantity: 4 }),
      card({ name: "Boros Charm", manaCost: "{R}{W}", colors: "RW", cmc: 2, quantity: 2 }),
      card({
        name: "Wastes Walker",
        typeLine: "Creature — Eldrazi",
        manaCost: "{3}",
        colors: null,
        cmc: 3,
      }),
      islands(10),
    ],
  ],
  [
    "colour curves: empty and five-colour letters, and an X spell",
    () => [
      card({ name: "Empty letters", manaCost: "{2}", colors: "", cmc: 2 }),
      card({ name: "Five colours", manaCost: "{W}{U}{B}{R}{G}", colors: "WUBRG", cmc: 5 }),
      card({ name: "Coloured, no letters", manaCost: "{G}", colors: null, cmc: 1 }),
      card({ name: "Reversed letters", manaCost: "{W}{R}", colors: "WR", cmc: 9 }),
      xSpell("Awakening", { colors: "B", quantity: 4 }),
      card({ name: "Orphan in a colour", manaCost: null, cmc: null, colors: "U" }),
    ],
  ],

  // DeckStats.test.tsx — piles.
  [
    "piles: switched-off copies apart from every other figure",
    () => [
      spell("Bolt", 1, { quantity: 4 }),
      spell("Pyroblast", 1, { categoryKind: "side", quantity: 3 }),
      spell("Ghost", 5, { categoryKind: "maybe", quantity: 9 }),
    ],
  ],
  [
    "lands: a land filed under another type is still a land",
    () => [
      card({ name: "Urza's Saga", typeLine: "Legendary Enchantment Land", cmc: 0, manaCost: null }),
      card({ name: "Tree of Tales", typeLine: "Artifact Land", cmc: 0, manaCost: null }),
      card({ name: "Dryad Arbor", typeLine: "Land Creature — Dryad", cmc: 0, manaCost: null }),
      spell("Bolt", 1),
    ],
  ],
  [
    "lands: MDFC lands beside the figure, a Pathway in it",
    () => [
      card({
        name: "Turntimber Symbiosis",
        typeLine: "Sorcery // Land",
        cmc: 7,
        layout: "modal_dfc",
      }),
      card({
        name: "Skyclave Cleric",
        typeLine: "Creature — Kor Cleric // Land",
        cmc: 2,
        layout: "modal_dfc",
        quantity: 2,
      }),
      card({ name: "Blightstep Pathway", typeLine: "Land // Land", cmc: 0, layout: "modal_dfc" }),
      card({ name: "Island", typeLine: "Basic Land — Island", cmc: 0, quantity: 10 }),
      spell("Bolt", 1),
    ],
  ],
  [
    "lands: a transform land is no MDFC land",
    () => [
      card({ name: "Island", typeLine: "Basic Land — Island", cmc: 0, quantity: 10 }),
      card({
        name: "Search for Azcanta",
        typeLine: "Legendary Enchantment // Legendary Land",
        cmc: 2,
        layout: "transform",
      }),
      card({
        name: "Valki, God of Lies",
        typeLine: "Legendary Creature — God // Legendary Planeswalker",
        cmc: 2,
        layout: "modal_dfc",
      }),
      card({ name: "Gone MDFC", typeLine: null, layout: MODAL_DFC, cmc: 1 }),
    ],
  ],
  [
    "lands: an MDFC land in a switched-off pile",
    () => [
      card({
        name: "Turntimber Symbiosis",
        typeLine: "Sorcery // Land",
        cmc: 7,
        layout: "modal_dfc",
        categoryKind: "maybe",
      }),
    ],
  ],
  [
    "size: by the kinds the format counts",
    () => [
      spell("Bolt", 1, { quantity: 4 }),
      card({ name: "Kenrith", categoryKind: "commander" }),
      spell("Pyroblast", 1, { categoryKind: "side", quantity: 3 }),
      spell("Lurrus", 3, { categoryKind: "companion" }),
      spell("Ghost", 5, { categoryKind: "maybe", quantity: 9 }),
    ],
  ],
  [
    "size: a main pile the reader switched off",
    () => [
      spell("Bolt", 1, { quantity: 4, unitPrice: 1 }),
      spell("Ghost", 5, {
        categoryId: 7,
        categoryName: "Cuts",
        categoryKind: "main",
        categoryActive: false,
        quantity: 9,
        unitPrice: 100,
      }),
    ],
  ],
  [
    "size: a Maybeboard the reader switched on",
    () => [
      spell("Bolt", 1, { quantity: 4 }),
      spell("Ghost", 5, { categoryKind: "maybe", categoryActive: true, quantity: 9 }),
    ],
  ],
  [
    "size: a sideboard counts toward the copies",
    () => [
      spell("Bolt", 1, { quantity: 4 }),
      spell("Pyroblast", 1, { categoryKind: "side", quantity: 2 }),
    ],
  ],

  // deckBuckets.test.ts — the three card filters.
  [
    "piles: active, sized and library over every kind",
    () => [
      card({ categoryKind: "main", quantity: 40 }),
      card({ name: "Island", categoryKind: "main", quantity: 20 }),
      card({ name: "Pithing Needle", categoryKind: "side", quantity: 15 }),
      card({ name: "Kenrith, the Returned King", categoryKind: "commander", quantity: 1 }),
      card({ name: "Lurrus of the Dream-Den", categoryKind: "companion", quantity: 1 }),
      card({ name: "Shark Typhoon", categoryKind: "maybe", quantity: 7 }),
      card({
        name: "Cultivate",
        categoryKind: "main",
        categoryId: 11,
        categoryName: "Ramp",
        categoryActive: false,
        quantity: 5,
      }),
      card({
        name: "Ponder",
        categoryKind: "maybe",
        categoryId: 12,
        categoryName: "Shortlist",
        categoryActive: true,
        quantity: 3,
      }),
    ],
  ],
  [
    "piles: a Commander deck with partners",
    () => [
      card({
        name: "Thrasios, Triton Hero",
        categoryKind: "commander",
        typeLine: "Legendary Creature — Merfolk Wizard",
        manaCost: "{G}{U}",
        cmc: 2,
        colors: "GU",
        producedMana: "",
      }),
      card({
        name: "Tymna the Weaver",
        categoryKind: "commander",
        typeLine: "Legendary Creature — Human Cleric",
        manaCost: "{1}{W}{B}",
        cmc: 3,
        colors: "WB",
      }),
      { ...islands(98), producedMana: "U", unitPrice: 0.25, ownedQuantity: 60 },
    ],
  ],
  [
    "piles: two piles under one name, and a pile whose rows disagree",
    () => [
      card({ categoryId: 7, categoryName: "Ramp", quantity: 4 }),
      card({ categoryId: 9, categoryName: "Ramp", name: "Sol Ring", quantity: 2 }),
      card({ categoryId: 3, categoryName: "Removal", name: "Swords", quantity: 1 }),
      // One category id, two kinds and two switches — a read never answers this, and the
      // TypeScript files the pile under its first row's.
      card({ categoryId: 20, categoryName: "Mixed", name: "First", quantity: 2 }),
      card({
        categoryId: 20,
        categoryName: "Mixed",
        name: "Second",
        categoryActive: false,
        quantity: 3,
      }),
      card({
        categoryId: 21,
        categoryName: "Mixed side",
        categoryKind: "side",
        name: "Third",
        quantity: 1,
      }),
      card({
        categoryId: 21,
        categoryName: "Mixed side",
        categoryKind: "main",
        name: "Fourth",
        quantity: 4,
      }),
      card({
        categoryId: 22,
        categoryName: "Parked first",
        categoryActive: false,
        name: "Fifth",
        quantity: 5,
      }),
      card({ categoryId: 22, categoryName: "Parked first", name: "Sixth", quantity: 6 }),
    ],
  ],

  // deckBuckets.test.ts — typeCounts.
  [
    "types: in printed order whatever order the rows arrive in",
    () => [
      card({ name: "Swamp", typeLine: "Basic Land — Swamp" }),
      card({ name: "Grizzly Bears", typeLine: "Creature — Bear" }),
      card({ name: "Lightning Bolt", typeLine: "Instant" }),
      card({ name: "Nothing At All", typeLine: null }),
    ],
  ],
  [
    "types: copies and never rows, every bucket",
    () => [
      card({ name: "Scheme", typeLine: "Scheme", quantity: 2 }),
      card({ name: "Battle", typeLine: "Battle — Siege" }),
      card({ name: "Grizzly Bears", typeLine: "Creature — Bear", quantity: 4 }),
      card({ name: "Llanowar Elves", typeLine: "Creature — Elf Druid", quantity: 3 }),
      card({ name: "Lightning Bolt", typeLine: "Instant", quantity: 2 }),
      card({ name: "Ajani", typeLine: "Legendary Planeswalker — Ajani" }),
      card({ name: "Divination", typeLine: "Sorcery", quantity: 3 }),
      card({ name: "Ornithopter", typeLine: "Artifact Creature — Thopter" }),
      card({ name: "Bauble", typeLine: "Artifact", quantity: 4 }),
      card({ name: "Pacifism", typeLine: "Enchantment — Aura" }),
      card({ name: "Token", typeLine: "Token Creature — Goblin" }),
      card({ name: "Lowercase", typeLine: "creature — elf" }),
      off(card({ name: "Parked Bolt", typeLine: "Instant", quantity: 5 })),
    ],
  ],
  [
    "types: lands at the head of spell bars",
    () => [
      card({ name: "Urza's Saga", typeLine: "Legendary Enchantment Land — Urza's" }),
      card({ name: "Tree of Tales", typeLine: "Artifact Land" }),
      card({ name: "Dryad Arbor", typeLine: "Land Creature — Forest Dryad" }),
      card({ name: "Swamp", typeLine: "Basic Land — Swamp" }),
    ],
  ],

  // typeBreakdownCounts.test.ts — creatures.
  [
    "breakdown: every subtype of every copy, count then name",
    () => [
      creature("Snapcaster Mage", "Creature — Human Wizard", 4),
      creature("Thraben Inspector", "Creature — Human Soldier", 3),
      creature("Delver", "Creature — Human Wizard", 2),
      creature("Ornithopter", "Artifact Creature — Thopter", 2),
    ],
  ],
  [
    "breakdown: the front face of a double-faced card",
    () => [
      creature("Bala Ged Recovery", "Sorcery // Land", 1, 3),
      creature("Delver of Secrets", "Creature — Human Wizard // Creature — Human Insect", 2),
      creature("Agadeem's Awakening", "Sorcery // Creature — Zombie Horror", 1),
    ],
  ],
  [
    "breakdown: a land creature is the Land panel's",
    () => [
      land("Dryad Arbor", "Land Creature — Forest Dryad", 1),
      creature("Llanowar Elves", "Creature — Elf Druid", 4),
    ],
  ],
  [
    "breakdown: a kindred spell is no creature",
    () => [card({ name: "Elvish Promenade", typeLine: "Kindred Sorcery — Elf" })],
  ],
  [
    "breakdown: lands by their basic land types",
    () => [
      land("Island", "Basic Land — Island", 8),
      land("Mountain", "Basic Land — Mountain", 6),
      land("Steam Vents", "Land — Island Mountain", 4),
      land("Snow-Covered Island", "Basic Snow Land — Island", 1),
      land("Spirebluff Canal", "Land", 2),
      land("Urza's Saga", "Legendary Enchantment Land — Urza's", 1),
    ],
  ],
  [
    "breakdown: multi-type slices in WUBRG order",
    () => [
      land("Backwards dual", "Land — Mountain Island", 1),
      land("Steam Vents", "Land — Island Mountain", 1),
      land("Triome", "Land — Forest Plains Island", 1),
    ],
  ],
  [
    "breakdown: hyphen-separated type lines",
    () => [
      land("Hand-typed", "Basic Land - Forest", 3),
      creature("Hand-typed wizard", "Creature - Human Wizard", 2),
    ],
  ],
  [
    "breakdown: modal DFC lands kept out of the pie",
    () => [
      card({
        name: "Turntimber Symbiosis",
        typeLine: "Sorcery // Land",
        layout: MODAL_DFC,
        cmc: 7,
        quantity: 2,
      }),
      land("Barkchannel Pathway", "Land // Land", 1),
      land("Forest", "Basic Land — Forest", 10),
    ],
  ],
  [
    "breakdown: slice ties by type count, WUBRG, then none",
    () => [
      land("Wastes", "Basic Land", 2),
      land("Forest", "Basic Land — Forest", 2),
      land("Plains", "Basic Land — Plains", 2),
      land("Hallowed Fountain", "Land — Plains Island", 2),
      land("Island", "Basic Land — Island", 5),
      land("Breeding Pool", "Land — Forest Island", 2),
      land("Triome", "Land — Plains Island Swamp", 2),
      land("Swamp", "Basic Land — Swamp", 2),
    ],
  ],
  [
    "breakdown: active piles only",
    () =>
      [
        creature("Goblin Guide", "Creature — Goblin Scout", 4),
        creature("Maybe Goblin", "Creature — Goblin", 3, 1),
        land("Mountain", "Basic Land — Mountain", 20),
        land("Off Mountain", "Basic Land — Mountain", 5),
      ].map((row) =>
        row.name.startsWith("Maybe") || row.name.startsWith("Off") ? off(row) : row,
      ),
  ],
  [
    "breakdown: a sideboard counts",
    () => [{ ...creature("Side Elf", "Creature — Elf", 2), categoryKind: "side" }],
  ],
  [
    "breakdown: the creature split off the curve",
    () =>
      [
        creature("Bear", "Creature — Bear", 4, 2),
        creature("Hydra", "Creature — Hydra", 2, 0),
        card({ name: "Bolt", typeLine: "Instant", quantity: 4 }),
        land("Dryad Arbor", "Land Creature — Forest Dryad", 1),
        land("Forest", "Basic Land — Forest", 10),
      ].map((row) => (row.name === "Hydra" ? { ...row, manaCost: "{X}{G}{G}" } : row)),
  ],
  [
    "breakdown: Time Lords and odd subtype spellings",
    () => [
      creature("Doctor", "Legendary Creature — Time Lord Doctor"),
      creature("Lordling", "Creature — Time Lordling Time Lord"),
      creature("Backwards", "Creature — Doctor Time Lord"),
      creature("Two spaces", "Creature — Time  Lord"),
      creature("Worker", "Artifact Creature — Assembly-Worker", 3),
      creature("Tight left", "Creature —Elf"),
      creature("Tight both", "Creature—Elf Warrior"),
      creature("En dash", "Creature – Elf Shaman"),
      creature("Double space", "Creature - Human  Wizard"),
      creature("No separator", "Creature-Goblin"),
      creature("Twice", "Creature — Human Human"),
      creature("Dash, nothing after", "Creature — "),
      creature("Second line", "Creature — Elf\nWarrior — Druid"),
      creature("Line separator", "Creature — Elf Warrior"),
      creature("Second dash", "Creature — Elf — Druid"),
      creature("No-break space", "Creature — Human Monk"),
    ],
  ],
  [
    "breakdown: subtype ties in collation order",
    () => [
      creature(
        "Collation",
        "Creature — Elves elf Elf Assembly-Worker Assembly AssemblyA Ab aB a_b a'b a-b a.b 10 2 Kor Kithkin",
      ),
    ],
  ],
  [
    "breakdown: changelings and odd type lines",
    () => [
      creature("Universal", "Creature — Shapeshifter", 2, 3),
      creature("Token", "Token Creature — Goblin"),
      creature("God", "Legendary Enchantment Creature — God", 1, 4),
      creature("Summon", "Summon — Elf"),
      creature("Pig latin", "Eaturecray — Igpay"),
      creature("Bare", "Creature"),
      creature("Lowercase", "creature — elf"),
    ],
  ],
  [
    "breakdown: land subtypes, odd spellings",
    () => [
      land("Two spaces", "Land — Island  Mountain", 2),
      land("Tight", "Land —Forest", 1),
      land("No-break", "Basic Land — Island Mountain", 1),
      land("Twice", "Land — Plains Plains", 3),
      land("Power plant", "Land — Urza's Power-Plant", 1),
      land("Gate", "Land — Gate", 1),
      land("Snow dual", "Snow Land — Forest Island", 2),
      land("Arbor", "Land Creature — Forest Dryad", 1),
      land("Lowercase", "Land — island", 1),
      land("En dash", "Land – Swamp", 1),
    ],
  ],
];

/** One `stats.json` case: the cards and every answer the stats modules give about them. */
function statsCase(name: string, build: () => DeckCard[]): GoldenCase {
  resetRowIds();
  const cards = build();
  const stats = deckStats(cards, false);
  const statsX = deckStats(cards, true);
  const ids = (rows: readonly DeckCard[]) => rows.map((row) => row.id);
  return {
    name,
    cards,
    stats,
    statsX,
    split: creatureSplit(stats),
    splitX: creatureSplit(statsX),
    typeCounts: typeCounts(cards),
    typeBreakdown: typeBreakdown(cards),
    activeIds: ids(activeCards(cards)),
    sizedIds: ids(sizedCards(cards)),
    libraryIds: ids(libraryCards(cards)),
    rows: cards.map((row) => ({
      id: row.id,
      manaValue: cardManaValue(row),
      mdfcLand: isMdfcLand(row),
      short: isShort(row),
    })),
  };
}

// ---------------------------------------------------------------------------------------------
// odds.json
// ---------------------------------------------------------------------------------------------

const MODES: readonly OddsMode[] = ["atLeast", "exactly", "atMost"];

interface OddsInput {
  deck: number;
  successes: number;
  hand: number;
  want: number;
  mode: OddsMode;
}

/** A seeded generator (mulberry32), so the scattered half of the grid is the same every run. */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function oddsInputs(): OddsInput[] {
  const out: OddsInput[] = [];
  // The questions a deckbuilder asks: a land, a two-of, a four-of, a playset of lands.
  for (const deck of [40, 60, 99, 100]) {
    for (const successes of [1, 4, 17, 24]) {
      for (const want of [1, 2]) {
        for (const mode of MODES) out.push({ deck, successes, hand: 7, want, mode });
      }
    }
  }
  // Scattered across the whole input space: deck 0–100, successes 0–deck, hand 0–12, want 0–5.
  const next = seeded(20261125);
  const pick = (top: number) => Math.floor(next() * (top + 1));
  for (let i = 0; i < 120; i++) {
    const deck = pick(100);
    out.push({
      deck,
      successes: pick(deck),
      hand: pick(12),
      want: pick(5),
      mode: MODES[pick(2)],
    });
  }
  // The edges `handOdds`' doc names, each in all three modes.
  const edges: Omit<OddsInput, "mode">[] = [
    { deck: 0, successes: 0, hand: 0, want: 0 },
    { deck: 0, successes: 0, hand: 7, want: 1 },
    { deck: 60, successes: 4, hand: 0, want: 0 },
    { deck: 1, successes: 1, hand: 1, want: 1 },
    { deck: 1, successes: 0, hand: 1, want: 0 },
    { deck: 7, successes: 3, hand: 9, want: 3 },
    { deck: 7, successes: 7, hand: 12, want: 5 },
    { deck: 60, successes: 0, hand: 7, want: 0 },
    { deck: 60, successes: 60, hand: 7, want: 5 },
    { deck: 60, successes: 4, hand: 7, want: 5 },
    { deck: 60, successes: 4, hand: 2, want: 4 },
    { deck: 60, successes: 4, hand: 7, want: -1 },
    { deck: 60, successes: 70, hand: 7, want: 2 },
    { deck: 60, successes: -2, hand: 7, want: 0 },
    { deck: 60, successes: 24, hand: -3, want: 1 },
    { deck: -5, successes: 2, hand: 7, want: 1 },
    { deck: 100, successes: 50, hand: 12, want: 5 },
    { deck: 100, successes: 99, hand: 12, want: 12 },
    { deck: 99, successes: 36, hand: 7, want: 3 },
    { deck: 40, successes: 17, hand: 12, want: 0 },
  ];
  for (const edge of edges) for (const mode of MODES) out.push({ ...edge, mode });
  return out;
}

/** `choose` over the whole range a deck reaches, the out-of-range `k` included. */
function chooseInputs(): [number, number][] {
  const out: [number, number][] = [];
  for (const n of [-1, 0, 1, 2, 7, 33, 40, 53, 60, 61, 99, 100]) {
    for (const k of [-1, 0, 1, 2, 3, 7, 12, Math.floor(n / 2), n - 1, n, n + 1]) {
      if (!out.some(([m, j]) => m === n && j === k)) out.push([n, k]);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// mana.json
// ---------------------------------------------------------------------------------------------

/** The strings no stats case carries, which a hand-written matcher is most likely to misread. */
const EDGE_STRINGS: readonly (string | null)[] = [
  null,
  "",
  " ",
  "{X}{X}",
  "{2/W}",
  "{W/U/P}",
  "{B/G/P}",
  "{x}{r}{w/u}",
  "{1}{W/B}{W/B}",
  "{100}{1000000}",
  "{HW}",
  "{∞}",
  "{½}",
  "{}",
  "{",
  "}{",
  "{{W}}",
  "{W",
  "W}",
  "{W}{",
  "{W}text{U}",
  "{T}: Add {G}.",
  "{c}",
  "{P}",
  "{W/}",
  "{/W}",
  "{//}",
  "W",
  "C",
  "2",
  "WUBRGC",
  "GRBUW",
  "CC",
  "c",
  "WUBRG2C",
  "éW",
  "Land // Land",
  "Creature — Elf // Sorcery",
  "Sorcery // Creature — Elf",
  "Land // Creature — Elemental",
  "A // B // C",
  "//",
  "// Land",
  "Land //",
  "Land/Land",
  "Creature — Elf",
  "Creature – Elf",
  "Creature - Elf",
  "Creature -Elf",
  "Creature- Elf",
  "Creature-Elf",
  "Creature —Elf",
  "Creature— Elf",
  "Creature—Elf",
  "  Creature  —  Elf  Warrior  ",
  "Creature \t—\t Elf\tWarrior",
  "Creature —\nElf",
  "Creature -\nElf",
  "Creature — Elf\nWarrior",
  "Creature — Elf\rWarrior — Druid",
  "Creature — Elf Warrior",
  "Creature — Elf — Druid",
  "Creature - Elf - Druid",
  "— Elf",
  "- Elf",
  " - Elf",
  "Creature —",
  "Creature — ",
  "Creature — Time Lord",
  "Creature — Time Lord Doctor",
  "Creature — Doctor Time Lord",
  "Creature — Time Lordling Time Lord",
  "Creature — Time Lordling",
  "Creature — TimeLord",
  "Creature — Time Lord Time Lord",
  "Creature — Time Lord",
  "Creature — Human Monk",
  "Creature — ﻿Elf",
  "LAND",
  "land",
  "Lands",
  "Landfall Instant",
  "Planeswalker Creature",
  "Instant Creature",
  "Enchantment Artifact",
  "Battle Land",
  "Plane — Dominaria",
  "Vanguard",
  "Conspiracy",
  "Dungeon",
  "Emblem — Elspeth",
];

/** One `mana.json` case: every string reader's answer about one string. */
function manaCase(input: string | null): GoldenCase {
  return {
    name: JSON.stringify(input),
    cards: [],
    input,
    countPips: countPips(input),
    hasVariableCost: hasVariableCost(input),
    producedKeys: producedKeys(input),
    front: front(input),
    back: back(input),
    isLand: isLand(input),
    isCreature: isCreature(input),
    typeBucket: typeBucket(input),
    isMdfcLand: isMdfcLand({ typeLine: input, layout: MODAL_DFC }),
    subtypes: input === null ? null : subtypes(input),
  };
}

// ---------------------------------------------------------------------------------------------

describe("the deck stats goldens", () => {
  it("writes stats.json", async () => {
    const cases = STATS.map(([name, build]) => statsCase(name, build));
    const text = goldenText(
      "Written by packages/ui/features/decks/golden/stats.golden.test.ts from deckStats, " +
        "typeCounts, typeBreakdown and the card filters; read by crates/grimoire-core/src/" +
        "deck_stats/. Never edited by hand.",
      cases,
    );
    await expect(text).toMatchFileSnapshot("../__golden__/stats.json");
  });

  it("writes odds.json", async () => {
    const odds: GoldenCase[] = oddsInputs().map((input, i) => ({
      name: `odds ${i}: ${input.mode} ${input.want} of ${input.successes} in ${input.hand} from ${input.deck}`,
      cards: [],
      ...input,
      odds: handOdds(input),
    }));
    const chooses: GoldenCase[] = chooseInputs().map(([n, k]) => ({
      name: `choose ${n} ${k}`,
      cards: [],
      n,
      k,
      choose: choose(n, k),
    }));
    const text = goldenText(
      "Written by packages/ui/features/decks/golden/stats.golden.test.ts from openingHand.ts' " +
        "handOdds and choose; read by crates/grimoire-core/src/deck_stats/odds.rs. Never edited " +
        "by hand.",
      [...odds, ...chooses],
    );
    await expect(text).toMatchFileSnapshot("../__golden__/odds.json");
  });

  it("writes mana.json", async () => {
    const strings: (string | null)[] = [];
    const seen = new Set<string | null>();
    const add = (value: string | null) => {
      if (seen.has(value)) return;
      seen.add(value);
      strings.push(value);
    };
    for (const [, build] of STATS) {
      resetRowIds();
      for (const row of build()) {
        add(row.manaCost);
        add(row.typeLine);
        add(row.producedMana);
      }
    }
    for (const edge of EDGE_STRINGS) add(edge);
    const text = goldenText(
      "Written by packages/ui/features/decks/golden/stats.golden.test.ts from the string " +
        "readers of mana.ts, deckBuckets.ts and typeBreakdownCounts.ts; read by " +
        "crates/grimoire-core/src/deck_stats/. Never edited by hand.",
      strings.map(manaCase),
    );
    await expect(text).toMatchFileSnapshot("../__golden__/mana.json");
  });
});
