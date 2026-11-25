/**
 * The companions golden: `../__golden__/companions.json`, which holds the Rust port
 * (`crates/grimoire-core/src/deck_rules/companions.rs`) to `../validation/companions.ts`.
 *
 * Each case is a whole deck — any piles, some switched off — and `issues` is exactly what
 * `validateDeck` hands back from `companionIssues`: the active rows, and the companion kind's
 * rows among them as the zone. The fixtures are `companions.test.ts`' real printings; a few
 * cases add a synthetic text where a hand-written matcher (the `Companion —` line, `Changeling`,
 * the bare activated keywords) has an edge no printed card shows.
 *
 * `pnpm exec vitest run --project ui packages/ui/features/decks/golden/companions.golden.test.ts -u`
 * rewrites the file; never edit it by hand.
 */
import { describe, expect, it } from "vitest";
import type { CategoryKind } from "@/lib/ipc";
import type { CardFacts, ValidationIssue } from "../validation/types";
import { companionIssues } from "../validation/companions";
import {
  card,
  commander,
  islands,
  padTo,
  resetRowIds,
  spec,
  SPECS,
  tinyCommander,
} from "../validation/fixtures";
import { goldenText, type GoldenCase } from "./golden";

const ABOUT =
  "Written by packages/ui/features/decks/golden/companions.golden.test.ts from " +
  "validation/companions.ts' companionIssues (the zone is the active companion rows, the deck " +
  "the active rows); read by crates/grimoire-core/src/deck_rules/companions.rs. Never by hand.";

// ------------------------------------------------------------------------------------------
// Fixtures — `companions.test.ts`' real printings, and a few more of the same kind.
// ------------------------------------------------------------------------------------------

const REMINDER =
  " (If this card is your chosen companion, you may put it into your hand from outside the " +
  "game for {3} as a sorcery.)";

const COMPANION_FIXTURES = {
  "Gyruda, Doom of Depths": {
    manaCost: "{4}{U/B}{U/B}",
    cmc: 6,
    typeLine: "Legendary Creature — Demon Kraken",
    oracleText:
      "Companion — Your starting deck contains only cards with even mana values." + REMINDER,
    colors: "BU",
    colorIdentity: "BU",
  },
  "Jegantha, the Wellspring": {
    manaCost: "{4}{R/G}",
    cmc: 5,
    typeLine: "Legendary Creature — Elemental Elk",
    oracleText:
      "Companion — No card in your starting deck has more than one of the same mana " +
      "symbol in its mana cost." +
      REMINDER +
      "\n{T}: Add {W}{U}{B}{R}{G}. This mana can't be spent to pay generic mana costs.",
    colors: "GR",
    colorIdentity: "BGRUW",
  },
  "Kaheera, the Orphanguard": {
    manaCost: "{1}{G/W}{G/W}",
    cmc: 3,
    typeLine: "Legendary Creature — Cat Beast",
    oracleText:
      "Companion — Each creature card in your starting deck is a Cat, Elemental, " +
      "Nightmare, Dinosaur, or Beast card." +
      REMINDER,
    colors: "GW",
    colorIdentity: "GW",
  },
  "Keruga, the Macrosage": {
    manaCost: "{3}{G/U}{G/U}",
    cmc: 5,
    typeLine: "Legendary Creature — Dinosaur Hippo",
    oracleText:
      "Companion — Your starting deck contains only cards with mana value 3 or greater " +
      "and land cards." +
      REMINDER,
    colors: "GU",
    colorIdentity: "GU",
  },
  "Lurrus of the Dream-Den": {
    manaCost: "{1}{W/B}{W/B}",
    cmc: 3,
    typeLine: "Legendary Creature — Cat Nightmare",
    oracleText:
      "Companion — Each permanent card in your starting deck has mana value 2 or less." + REMINDER,
    colors: "BW",
    colorIdentity: "BW",
  },
  "Lutri, the Spellchaser": {
    manaCost: "{1}{U/R}{U/R}",
    cmc: 3,
    typeLine: "Legendary Creature — Elemental Otter",
    oracleText:
      "Companion — Each nonland card in your starting deck has a different name." + REMINDER,
    colors: "RU",
    colorIdentity: "RU",
  },
  "Obosh, the Preypiercer": {
    manaCost: "{3}{B/R}{B/R}",
    cmc: 5,
    typeLine: "Legendary Creature — Hellion Horror",
    oracleText:
      "Companion — Your starting deck contains only cards with odd mana values and land " +
      "cards." +
      REMINDER,
    colors: "BR",
    colorIdentity: "BR",
  },
  "Umori, the Collector": {
    manaCost: "{2}{B/G}{B/G}",
    cmc: 4,
    typeLine: "Legendary Creature — Ooze",
    oracleText:
      "Companion — Each nonland card in your starting deck shares a card type." + REMINDER,
    colors: "BG",
    colorIdentity: "BG",
  },
  "Yorion, Sky Nomad": {
    manaCost: "{3}{W/U}{W/U}",
    cmc: 5,
    typeLine: "Legendary Creature — Bird Serpent",
    oracleText:
      "Companion — Your starting deck contains at least twenty cards more than the " +
      "minimum deck size." +
      REMINDER,
    colors: "UW",
    colorIdentity: "UW",
  },
  "Zirda, the Dawnwaker": {
    manaCost: "{1}{R/W}{R/W}",
    cmc: 3,
    typeLine: "Legendary Creature — Elemental Fox",
    oracleText:
      "Companion — Each permanent card in your starting deck has an activated ability." +
      REMINDER +
      "\nAbilities you activate that aren't mana abilities cost {2} less to activate.\n" +
      "{1}, {T}: Target creature can't block this turn.",
    colors: "RW",
    colorIdentity: "RW",
  },
} satisfies Record<string, Partial<CardFacts>>;

type CompanionName = keyof typeof COMPANION_FIXTURES;

const DECK_FIXTURES = {
  solRing: {
    name: "Sol Ring",
    manaCost: "{1}",
    cmc: 1,
    typeLine: "Artifact",
    oracleText: "{T}: Add {C}{C}.",
    colors: null,
    colorIdentity: "",
  },
  counterspell: {
    name: "Counterspell",
    manaCost: "{U}{U}",
    cmc: 2,
    typeLine: "Instant",
    oracleText: "Counter target spell.",
    colors: "U",
    colorIdentity: "U",
  },
  wrathOfGod: {
    name: "Wrath of God",
    manaCost: "{2}{W}{W}",
    cmc: 4,
    typeLine: "Sorcery",
    oracleText: "Destroy all creatures. They can't be regenerated.",
    colors: "W",
    colorIdentity: "W",
  },
  fiendHunter: {
    name: "Fiend Hunter",
    manaCost: "{1}{W}{W}",
    cmc: 3,
    typeLine: "Creature — Human Cleric",
    oracleText:
      "When this creature enters, you may exile another target creature.\nWhen this creature " +
      "leaves the battlefield, return the exiled card to the battlefield under its owner's " +
      "control.",
    colors: "W",
    colorIdentity: "W",
  },
  childOfAlara: {
    name: "Child of Alara",
    manaCost: "{W}{U}{B}{R}{G}",
    cmc: 5,
    typeLine: "Legendary Creature — Avatar",
    oracleText:
      "Trample\nWhen Child of Alara dies, destroy all nonland permanents. They can't be " +
      "regenerated.",
    colors: "BGRUW",
    colorIdentity: "BGRUW",
  },
  grizzlyBears: {
    name: "Grizzly Bears",
    manaCost: "{1}{G}",
    cmc: 2,
    typeLine: "Creature — Bear",
    oracleText: "",
    colors: "G",
    colorIdentity: "G",
  },
  savannahLions: {
    name: "Savannah Lions",
    manaCost: "{W}",
    cmc: 1,
    typeLine: "Creature — Cat",
    oracleText: "",
    colors: "W",
    colorIdentity: "W",
  },
  mothdustChangeling: {
    name: "Mothdust Changeling",
    manaCost: "{U}",
    cmc: 1,
    typeLine: "Creature — Shapeshifter",
    oracleText:
      "Changeling (This card is every creature type.)\nTap an untapped creature you control: " +
      "This creature gains flying until end of turn.",
    colors: "U",
    colorIdentity: "U",
  },
  skullclamp: {
    name: "Skullclamp",
    manaCost: "{1}",
    cmc: 1,
    typeLine: "Artifact — Equipment",
    oracleText:
      "Equipped creature gets +1/-1.\nWhenever equipped creature dies, draw two cards.\nEquip {1}",
    colors: null,
    colorIdentity: "",
  },
  dryadArbor: {
    name: "Dryad Arbor",
    manaCost: null,
    cmc: 0,
    typeLine: "Land Creature — Forest Dryad",
    oracleText:
      "(This land isn't a spell, it's affected by summoning sickness, and it has \"{T}: Add " +
      '{G}.")',
    colors: "G",
    colorIdentity: "G",
  },
  fireIce: {
    name: "Fire // Ice",
    manaCost: "{1}{R} // {1}{U}",
    cmc: 4,
    typeLine: "Instant // Instant",
    oracleText: null,
    colors: "RU",
    colorIdentity: "RU",
    layout: "split",
    faces: JSON.stringify([
      {
        mana_cost: "{1}{R}",
        name: "Fire",
        oracle_text: "Fire deals 2 damage divided as you choose among one or two targets.",
        type_line: "Instant",
      },
      {
        mana_cost: "{1}{U}",
        name: "Ice",
        oracle_text: "Tap target permanent.\nDraw a card.",
        type_line: "Instant",
      },
    ]),
  },
  brazenBorrower: {
    name: "Brazen Borrower // Petty Theft",
    manaCost: "{1}{U}{U} // {1}{U}",
    cmc: 3,
    typeLine: "Creature — Faerie Rogue // Instant — Adventure",
    oracleText: null,
    colors: "U",
    colorIdentity: "U",
    layout: "adventure",
    faces: JSON.stringify([
      {
        mana_cost: "{1}{U}{U}",
        name: "Brazen Borrower",
        oracle_text: "Flash\nFlying\nThis creature can block only creatures with flying.",
        power: "3",
        toughness: "1",
        type_line: "Creature — Faerie Rogue",
      },
      {
        mana_cost: "{1}{U}",
        name: "Petty Theft",
        oracle_text: "Return target nonland permanent an opponent controls to its owner's hand.",
        type_line: "Instant — Adventure",
      },
    ]),
  },
  rhysticStudy: {
    name: "Rhystic Study",
    manaCost: "{2}{U}",
    cmc: 3,
    typeLine: "Enchantment",
    oracleText:
      "Whenever an opponent casts a spell, you may draw a card unless that player pays {1}.",
    colors: "U",
    colorIdentity: "U",
  },
  serraAngel: {
    name: "Serra Angel",
    manaCost: "{3}{W}{W}",
    cmc: 5,
    typeLine: "Creature — Angel",
    oracleText: "Flying\nVigilance",
    colors: "W",
    colorIdentity: "W",
  },
  memnite: {
    name: "Memnite",
    manaCost: "{0}",
    cmc: 0,
    typeLine: "Artifact Creature — Construct",
    oracleText: "",
    colors: null,
    colorIdentity: "",
  },
  opt: {
    name: "Opt",
    manaCost: "{U}",
    cmc: 1,
    typeLine: "Instant",
    oracleText: "Scry 1.\nDraw a card.",
    colors: "U",
    colorIdentity: "U",
  },
  fireball: {
    name: "Fireball",
    manaCost: "{X}{R}",
    cmc: 1,
    typeLine: "Sorcery",
    oracleText:
      "This spell costs {1} more to cast for each target beyond the first.\nFireball deals X " +
      "damage divided evenly, rounded down, among any number of targets.",
    colors: "R",
    colorIdentity: "R",
  },
  wurmcoilEngine: {
    name: "Wurmcoil Engine",
    manaCost: "{6}",
    cmc: 6,
    typeLine: "Artifact Creature — Phyrexian Wurm",
    oracleText:
      "Deathtouch, lifelink\nWhen this creature dies, create two 3/3 colorless Phyrexian Wurm " +
      "artifact creature tokens. One of them has deathtouch and the other has lifelink.",
    colors: null,
    colorIdentity: "",
  },
  manamorphose: {
    name: "Manamorphose",
    manaCost: "{1}{R/G}",
    cmc: 2,
    typeLine: "Instant",
    oracleText: "Add two mana in any combination of colors.\nDraw a card.",
    colors: "GR",
    colorIdentity: "GR",
  },
  burningTreeEmissary: {
    name: "Burning-Tree Emissary",
    manaCost: "{R/G}{R/G}",
    cmc: 2,
    typeLine: "Creature — Elemental",
    oracleText: "When this creature enters, add {R}{G}.",
    colors: "GR",
    colorIdentity: "GR",
  },
  cribSwap: {
    name: "Crib Swap",
    manaCost: "{2}{W}",
    cmc: 3,
    typeLine: "Kindred Instant — Shapeshifter",
    oracleText:
      "Changeling (This card is every creature type.)\nExile target creature. Its controller " +
      "creates a 1/1 colorless Shapeshifter creature token with changeling.",
    colors: "W",
    colorIdentity: "W",
  },
  invasionOfZendikar: {
    name: "Invasion of Zendikar // Awakened Skyclave",
    manaCost: "{3}{G}",
    cmc: 4,
    typeLine: "Battle — Siege // Creature — Elemental",
    oracleText: null,
    colors: "G",
    colorIdentity: "G",
    layout: "transform",
    faces: JSON.stringify([
      {
        mana_cost: "{3}{G}",
        name: "Invasion of Zendikar",
        oracle_text:
          "(As a Siege enters, choose an opponent to protect it. You and others can attack it. " +
          "When it's defeated, exile it, then cast it transformed.)\nWhen this Siege enters, " +
          "search your library for up to two basic land cards, put them onto the battlefield " +
          "tapped, then shuffle.",
        type_line: "Battle — Siege",
      },
      {
        mana_cost: "",
        name: "Awakened Skyclave",
        oracle_text:
          "Vigilance, haste\nAwakened Skyclave can't be blocked by creatures with power 2 or " +
          "less.\n{T}: Add one mana of any color.",
        type_line: "Creature — Elemental",
      },
    ]),
  },
  invasionOfTarkir: {
    name: "Invasion of Tarkir // Defiant Thundermaw",
    manaCost: "{1}{R}",
    cmc: 2,
    typeLine: "Battle — Siege // Creature — Dragon",
    oracleText: null,
    colors: "R",
    colorIdentity: "R",
    layout: "transform",
  },
  jace: {
    name: "Jace, the Mind Sculptor",
    manaCost: "{2}{U}{U}",
    cmc: 4,
    typeLine: "Legendary Planeswalker — Jace",
    oracleText:
      "+2: Look at the top card of target player's library. You may put that card on the " +
      "bottom of that player's library.\n0: Draw three cards, then put two cards from your " +
      "hand on top of your library in any order.\n−1: Return target creature to its owner's " +
      "hand.\n−12: Exile all cards from target player's library, then that player shuffles " +
      "their hand into their library.",
    colors: "U",
    colorIdentity: "U",
  },
  urzasRuinousBlast: {
    name: "Urza's Ruinous Blast",
    manaCost: "{4}{W}",
    cmc: 5,
    typeLine: "Legendary Sorcery",
    oracleText:
      "(You may cast a legendary sorcery only if you control a legendary creature or " +
      "planeswalker.)\nExile all nonland permanents that aren't legendary.",
    colors: "W",
    colorIdentity: "W",
  },
  mistformUltimus: {
    name: "Mistform Ultimus",
    manaCost: "{3}{U}",
    cmc: 4,
    typeLine: "Legendary Creature — Illusion",
    oracleText:
      "Mistform Ultimus is every creature type (even if this card isn't on the battlefield).",
    colors: "U",
    colorIdentity: "U",
  },
  thragtusk: {
    name: "Thragtusk",
    manaCost: "{4}{G}",
    cmc: 5,
    typeLine: "Creature — Beast",
    oracleText:
      "When this creature enters, you gain 5 life.\nWhen this creature leaves the " +
      "battlefield, create a 3/3 green Beast creature token.",
    colors: "G",
    colorIdentity: "G",
  },
  ghalta: {
    name: "Ghalta, Primal Hunger",
    manaCost: "{10}{G}{G}",
    cmc: 12,
    typeLine: "Legendary Creature — Elder Dinosaur",
    oracleText:
      "This spell costs {X} less to cast, where X is the total power of creatures you " +
      "control.\nTrample",
    colors: "G",
    colorIdentity: "G",
  },
  nightmare: {
    name: "Nightmare",
    manaCost: "{5}{B}",
    cmc: 6,
    typeLine: "Creature — Nightmare Horse",
    oracleText:
      "Flying\nNightmare's power and toughness are each equal to the number of Swamps you " +
      "control.",
    colors: "B",
    colorIdentity: "B",
  },
  airElemental: {
    name: "Air Elemental",
    manaCost: "{3}{U}{U}",
    cmc: 5,
    typeLine: "Creature — Elemental",
    oracleText: "Flying",
    colors: "U",
    colorIdentity: "U",
  },
  littleGirl: {
    name: "Little Girl",
    manaCost: "{HW}",
    cmc: 0.5,
    typeLine: "Creature — Human Child",
    oracleText: "",
    colors: "W",
    colorIdentity: "W",
  },
  bloodlineKeeper: {
    name: "Bloodline Keeper // Lord of Lineage",
    manaCost: null,
    cmc: 4,
    typeLine: "Creature — Vampire // Creature — Vampire",
    oracleText: null,
    colors: "B",
    colorIdentity: "B",
    layout: "transform",
    faces: JSON.stringify([
      {
        mana_cost: "{2}{B}{B}",
        name: "Bloodline Keeper",
        oracle_text:
          "Flying\n{T}: Create a 2/2 black Vampire creature token with flying.\n{B}: Transform " +
          "this creature. Activate only if you control five or more Vampires.",
        power: "3",
        toughness: "3",
        type_line: "Creature — Vampire",
      },
      {
        mana_cost: "",
        name: "Lord of Lineage",
        oracle_text:
          "Flying\nOther Vampire creatures you control get +2/+2.\n{T}: Create a 2/2 black " +
          "Vampire creature token with flying.",
        power: "5",
        toughness: "5",
        type_line: "Creature — Vampire",
      },
    ]),
  },
  delver: {
    name: "Delver of Secrets // Insectile Aberration",
    manaCost: null,
    cmc: 1,
    typeLine: "Creature — Human Wizard // Creature — Human Insect",
    oracleText: null,
    colors: "U",
    colorIdentity: "U",
    layout: "transform",
    faces: JSON.stringify([
      {
        mana_cost: "{U}",
        name: "Delver of Secrets",
        oracle_text:
          "At the beginning of your upkeep, look at the top card of your library. You may " +
          "reveal that card. If an instant or sorcery card is revealed this way, transform " +
          "this creature.",
        power: "1",
        toughness: "1",
        type_line: "Creature — Human Wizard",
      },
      {
        mana_cost: "",
        name: "Insectile Aberration",
        oracle_text: "Flying",
        power: "3",
        toughness: "2",
        type_line: "Creature — Human Insect",
      },
    ]),
  },
  spikefieldHazard: {
    name: "Spikefield Hazard // Spikefield Cave",
    manaCost: null,
    cmc: 1,
    typeLine: "Instant // Land",
    oracleText: null,
    colors: "R",
    colorIdentity: "R",
    layout: "modal_dfc",
    faces: JSON.stringify([
      {
        mana_cost: "{R}",
        name: "Spikefield Hazard",
        oracle_text:
          "Spikefield Hazard deals 1 damage to any target. If a permanent dealt damage this " +
          "way would die this turn, exile it instead.",
        type_line: "Instant",
      },
      {
        mana_cost: "",
        name: "Spikefield Cave",
        oracle_text:
          "As this land enters, you may pay 3 life. If you don't, it enters tapped.\n{T}: Add {R}.",
        type_line: "Land",
      },
    ]),
  },
  emeriasCall: {
    name: "Emeria's Call // Emeria, Shattered Skyland",
    manaCost: null,
    cmc: 7,
    typeLine: "Sorcery // Land",
    oracleText: null,
    colors: "W",
    colorIdentity: "W",
    layout: "modal_dfc",
    faces: JSON.stringify([
      {
        mana_cost: "{4}{W}{W}{W}",
        name: "Emeria's Call",
        oracle_text:
          "Create two 4/4 white Angel Warrior creature tokens with flying. Non-Angel creatures " +
          "you control gain indestructible until your next turn.",
        type_line: "Sorcery",
      },
      {
        mana_cost: "",
        name: "Emeria, Shattered Skyland",
        oracle_text:
          "As this land enters, you may pay 3 life. If you don't, it enters tapped.\n{T}: Add {W}.",
        type_line: "Land",
      },
    ]),
  },
  valakutAwakening: {
    name: "Valakut Awakening // Valakut Stoneforge",
    manaCost: null,
    cmc: 3,
    typeLine: "Instant // Land",
    oracleText: null,
    colors: "R",
    colorIdentity: "R",
    layout: "modal_dfc",
    faces: JSON.stringify([
      {
        mana_cost: "{2}{R}",
        name: "Valakut Awakening",
        oracle_text:
          "Put any number of cards from your hand on the bottom of your library, then draw " +
          "that many cards plus one.",
        type_line: "Instant",
      },
      {
        mana_cost: "",
        name: "Valakut Stoneforge",
        oracle_text:
          "As this land enters, you may pay 3 life. If you don't, it enters tapped.\n{T}: Add {R}.",
        type_line: "Land",
      },
    ]),
  },
  branchloftPathway: {
    name: "Branchloft Pathway // Boulderloft Pathway",
    manaCost: null,
    cmc: 0,
    typeLine: "Land // Land",
    oracleText: null,
    colors: null,
    colorIdentity: "GW",
    layout: "modal_dfc",
    faces: JSON.stringify([
      {
        mana_cost: "",
        name: "Branchloft Pathway",
        oracle_text: "{T}: Add {G}.",
        type_line: "Land",
      },
      {
        mana_cost: "",
        name: "Boulderloft Pathway",
        oracle_text: "{T}: Add {W}.",
        type_line: "Land",
      },
    ]),
  },
  katana: {
    name: "Samurai's Katana",
    manaCost: "{2}",
    cmc: 2,
    typeLine: "Artifact — Equipment",
    oracleText:
      "When this Equipment enters, attach it to target creature you control.\nEquipped " +
      "creature gets +2/+0 and has first strike.\nMurasame — Equip {5}",
    colors: null,
    colorIdentity: "",
  },
  fortuneSteed: {
    name: "Fortune, Loyal Steed",
    manaCost: "{2}{W}",
    cmc: 3,
    typeLine: "Legendary Creature — Horse",
    oracleText:
      "Whenever this creature attacks while saddled, target creature you control gains " +
      "protection from a color of your choice until end of turn.\nSaddle 1",
    colors: "W",
    colorIdentity: "W",
  },
  ainokSurvivalist: {
    name: "Ainok Survivalist",
    manaCost: "{1}{G}",
    cmc: 2,
    typeLine: "Creature — Hound Scout",
    oracleText:
      "Megamorph {2}{G} (You may cast this card face down as a 2/2 creature for {3}. Turn " +
      "it face up any time for its megamorph cost and put a +1/+1 counter on it.)",
    colors: "G",
    colorIdentity: "G",
  },
} satisfies Record<string, Partial<CardFacts>>;

type DeckKey = keyof typeof DECK_FIXTURES;

/** One of the ten in the companion category. */
function companion(name: CompanionName, overrides: Partial<CardFacts> = {}): CardFacts {
  return card({ ...COMPANION_FIXTURES[name], name, categoryKind: "companion", ...overrides });
}

/** One of the ten as an ordinary card of the deck. */
function asDeckCard(name: CompanionName, overrides: Partial<CardFacts> = {}): CardFacts {
  return card({ ...COMPANION_FIXTURES[name], name, ...overrides });
}

function deckCard(key: DeckKey, overrides: Partial<CardFacts> = {}): CardFacts {
  return card({ ...DECK_FIXTURES[key], ...overrides });
}

/** A row whose printing left the card database: every card fact null. */
function orphan(name: string, kind: CategoryKind, overrides: Partial<CardFacts> = {}): CardFacts {
  return card({
    name,
    categoryKind: kind,
    oracleId: null,
    layout: null,
    rarity: null,
    legalities: null,
    typeLine: null,
    oracleText: null,
    cmc: null,
    manaCost: null,
    ...overrides,
  });
}

/** A pile of the user's own, switched off. */
function parked(row: CardFacts): CardFacts {
  return { ...row, categoryActive: false, categoryId: 9, categoryName: "Parked" };
}

/** A switched-on Maybeboard. */
function activeMaybe(row: CardFacts): CardFacts {
  return {
    ...row,
    categoryKind: "maybe",
    categoryActive: true,
    categoryId: 5,
    categoryName: "Maybeboard",
  };
}

/** A card of the companion zone that is none of the ten, by its printed text. */
function stranger(
  name: string,
  oracleText: string | null,
  overrides: Partial<CardFacts> = {},
): CardFacts {
  return card({
    name,
    categoryKind: "companion",
    typeLine: "Legendary Creature — Human Knight",
    manaCost: "{2}{R}",
    cmc: 3,
    oracleText,
    ...overrides,
  });
}

/** A permanent that is about one line of text — the Zirda and Kaheera matcher edges. */
function textCard(name: string, oracleText: string, typeLine = "Creature — Human"): CardFacts {
  return card({
    name,
    manaCost: "{2}",
    cmc: 2,
    typeLine,
    oracleText,
    colors: null,
    colorIdentity: "",
  });
}

/** `n` creatures named A, B, C… (plus `suffix`) — the offenders a name list counts past. */
function lettered(n: number, overrides: Partial<CardFacts> = {}, suffix = ""): CardFacts[] {
  return "ABCDEFG"
    .slice(0, n)
    .split("")
    .map((letter) =>
      card({
        name: `${letter}${suffix}`,
        typeLine: "Creature — Bear",
        cmc: 2,
        manaCost: "{1}{G}",
        ...overrides,
      }),
    );
}

const TALRAND: Partial<CardFacts> = {
  name: "Talrand, Sky Summoner",
  categoryKind: "commander",
  typeLine: "Legendary Creature — Merfolk Wizard",
  manaCost: "{2}{U}",
  cmc: 3,
  oracleText:
    "Whenever you cast an instant or sorcery spell, create a 2/2 blue Drake creature token " +
    "with flying.",
  colors: "U",
  colorIdentity: "U",
};

const KOZILEK: Partial<CardFacts> = {
  name: "Kozilek, Butcher of Truth",
  categoryKind: "commander",
  typeLine: "Legendary Creature — Eldrazi",
  manaCost: "{10}",
  cmc: 10,
  oracleText:
    "When you cast this spell, draw four cards.\nAnnihilator 4 (Whenever this creature " +
    "attacks, defending player sacrifices four permanents.)\nWhen Kozilek is put into a " +
    "graveyard from anywhere, its owner shuffles their graveyard into their library.",
  colors: null,
  colorIdentity: "",
};

const NEW_COMPANION_LINE = "Companion — Your starting deck contains only Birds.";

// ------------------------------------------------------------------------------------------
// The cases.
// ------------------------------------------------------------------------------------------

interface CompanionCase extends GoldenCase {
  spec: string;
  issues: ValidationIssue[];
}

const cases: CompanionCase[] = [];

/** One case: its cards built from fresh row ids, and `validateDeck`'s own call over them. */
function add(name: string, specKey: keyof typeof SPECS, build: () => CardFacts[]): void {
  resetRowIds();
  const cards = build();
  const active = cards.filter((c) => c.categoryActive);
  const issues = companionIssues(
    active.filter((c) => c.categoryKind === "companion"),
    active,
    spec(specKey),
  );
  cases.push({ name, spec: specKey, cards, issues });
}

// --- The zone, its count, eligibility and the unknown. ------------------------------------

add("zone: an empty companion zone says nothing", "modern", () => [islands(60)]);
add("zone: Gladiator has no companions", "gladiator", () => [
  islands(100),
  companion("Lurrus of the Dream-Den"),
]);
add("zone: Gladiator names every companion printing once", "gladiator", () => [
  islands(100),
  companion("Lurrus of the Dream-Den"),
  companion("Zirda, the Dawnwaker"),
  companion("Lurrus of the Dream-Den", { finish: "foil" }),
]);
add("zone: Gladiator refuses even an orphaned companion", "gladiator", () => [
  islands(100),
  orphan("Gone Card", "companion"),
]);
add("zone: a switched-off companion pile is no zone at all", "gladiator", () => [
  islands(100),
  parked(companion("Lurrus of the Dream-Den")),
]);
add("count: two companions", "modern", () => [
  islands(60),
  companion("Lurrus of the Dream-Den"),
  companion("Zirda, the Dawnwaker"),
]);
add("count: one row of two copies", "modern", () => [
  islands(60),
  companion("Lurrus of the Dream-Den", { quantity: 2 }),
]);
add("count: two rows of one companion are judged twice", "modern", () => [
  islands(59),
  deckCard("rhysticStudy"),
  companion("Lurrus of the Dream-Den"),
  companion("Lurrus of the Dream-Den", { finish: "foil" }),
]);
add("count: a switched-off second companion is not counted", "modern", () => [
  islands(60),
  companion("Lurrus of the Dream-Den"),
  parked(companion("Zirda, the Dawnwaker")),
]);
add("count: an orphaned companion still counts", "modern", () => [
  islands(60),
  companion("Lurrus of the Dream-Den"),
  orphan("Gone Card", "companion"),
]);
add("count: three companions in Commander", "commander", () => [
  commander(),
  islands(99),
  companion("Umori, the Collector"),
  companion("Lurrus of the Dream-Den"),
  companion("Zirda, the Dawnwaker"),
]);
add("eligibility: Lightning Bolt is not a companion", "modern", () => [
  islands(60),
  card({ name: "Lightning Bolt", categoryKind: "companion" }),
]);
add("unknown: Treizeci's companion line warns", "modern", () => [
  islands(60),
  stranger(
    "Treizeci, Sun of Serra",
    "Companion — Your starting deck contains only nostalgic cards. (Retro frames, " +
      "legends, and artifacts are nostalgic.)",
  ),
]);
add("eligibility: an Old Companion line is refused", "modern", () => [
  islands(60),
  stranger(
    "The Companion of the Wilds",
    "Old Companion — Your starting deck contains only cards from WOE, WOC, and " +
      "playtest cards. (You may cast this from outside the game if this is companion " +
      "without paying {3} first.)",
    { typeLine: "Legendary Creature — Beast Noble" },
  ),
]);
add("unknown: the line may open the second line", "modern", () => [
  islands(60),
  stranger("Second-Line Companion", `Flying\n${NEW_COMPANION_LINE}`),
]);
add("unknown: a carriage return opens a line", "modern", () => [
  islands(60),
  stranger("Return Companion", `Flying\r${NEW_COMPANION_LINE}`),
]);
add("unknown: a line separator opens a line", "modern", () => [
  islands(60),
  stranger("Separator Companion", `Flying\u2028${NEW_COMPANION_LINE}`),
]);
add("unknown: a paragraph separator opens a line", "modern", () => [
  islands(60),
  stranger("Paragraph Companion", `Flying\u2029${NEW_COMPANION_LINE}`),
]);
add("unknown: spaces and tabs before the dash", "modern", () => [
  islands(60),
  stranger("Spaced Companion", "Companion \t — Your starting deck contains only Birds."),
]);
add("unknown: no space before the dash, nothing after it", "modern", () => [
  islands(60),
  stranger("Tight Companion", "Companion—"),
]);
add("eligibility: an en dash is not the companion line", "modern", () => [
  islands(60),
  stranger("En Dash Companion", "Companion – Your starting deck contains only Birds."),
]);
add("eligibility: a no-break space is not a space the line allows", "modern", () => [
  islands(60),
  stranger("No-Break Companion", "Companion — Your starting deck contains only Birds."),
]);
add("eligibility: a lower-case companion line is refused", "modern", () => [
  islands(60),
  stranger("Quiet Companion", "companion — Your starting deck contains only Birds."),
]);
add("eligibility: a companion line mid-line is refused", "modern", () => [
  islands(60),
  stranger("Midline Companion", `Flying. ${NEW_COMPANION_LINE}`),
]);
add("eligibility: a leading space is refused", "modern", () => [
  islands(60),
  stranger("Indented Companion", ` ${NEW_COMPANION_LINE}`),
]);
add("unknown: the front face's text is the one read", "modern", () => [
  islands(60),
  stranger("Faced Companion", null, {
    faces: JSON.stringify([
      {
        name: "Faced Companion",
        oracle_text: NEW_COMPANION_LINE,
        type_line: "Legendary Creature — Bird",
      },
      { name: "Back Face", oracle_text: "Flying", type_line: "Legendary Creature — Bird" },
    ]),
  }),
]);
add("eligibility: the front face's text overrides the card's own", "modern", () => [
  islands(60),
  stranger("Overridden Companion", NEW_COMPANION_LINE, {
    faces: JSON.stringify([{ name: "Overridden Companion", oracle_text: "Flying" }, {}]),
  }),
]);
add("eligibility: a back face's companion line is not read", "modern", () => [
  islands(60),
  stranger("Backed Companion", null, {
    faces: JSON.stringify([
      { name: "Backed Companion", oracle_text: "Flying" },
      { name: "Back Face", oracle_text: NEW_COMPANION_LINE },
    ]),
  }),
]);
add("unknown: an unreadable faces blob leaves the card's own text", "modern", () => [
  islands(60),
  stranger("Blobbed Companion", NEW_COMPANION_LINE, { faces: "not json" }),
]);
add("unknown: one of the ten in the wrong case is not one of the ten", "modern", () => [
  islands(60),
  companion("Lurrus of the Dream-Den", { name: "lurrus of the dream-den" }),
]);
add("orphan: an orphaned companion is left to the reconciler", "modern", () => [
  islands(60),
  orphan("Gone Card", "companion"),
]);

// --- Gyruda: even mana values. -------------------------------------------------------------

add("Gyruda: even costs and lands pass", "modern", () => [
  deckCard("counterspell"),
  islands(58),
  companion("Gyruda, Doom of Depths"),
]);
add("Gyruda: one odd card", "modern", () => [
  deckCard("solRing"),
  deckCard("counterspell"),
  companion("Gyruda, Doom of Depths"),
]);
add("Gyruda: three odd cards", "modern", () => [
  deckCard("solRing"),
  deckCard("savannahLions"),
  deckCard("counterspell"),
  deckCard("fiendHunter"),
  islands(20),
  companion("Gyruda, Doom of Depths"),
]);
add("Gyruda: four odd cards, one of them counted", "modern", () => [
  deckCard("solRing"),
  deckCard("savannahLions"),
  deckCard("fiendHunter"),
  deckCard("mothdustChangeling"),
  islands(20),
  companion("Gyruda, Doom of Depths"),
]);
add("Gyruda: five odd cards", "modern", () => [
  ...lettered(5, { cmc: 3 }),
  companion("Gyruda, Doom of Depths"),
]);
add("Gyruda: rows of one card are named once", "modern", () => [
  deckCard("solRing"),
  activeMaybe(deckCard("solRing")),
  deckCard("solRing", { categoryKind: "commander" }),
  companion("Gyruda, Doom of Depths"),
]);
add("Gyruda: half a mana is odd", "modern", () => [
  deckCard("littleGirl"),
  card({ name: "Half-Cost Spell", cmc: null, manaCost: "{½}{½}{½}{½}" }),
  companion("Gyruda, Doom of Depths"),
]);
add("Gyruda: the cost is read when the column is missing", "modern", () => [
  card({ name: "Costed Three", cmc: null, manaCost: "{2}{U}" }),
  card({ name: "Costless", cmc: null, manaCost: null }),
  card({ name: "X Spell", cmc: null, manaCost: "{X}{X}{R}" }),
  card({ name: "Empty Cost", cmc: null, manaCost: "" }),
  card({ name: "Hybrid Two", cmc: null, manaCost: "{2/W}" }),
  companion("Gyruda, Doom of Depths"),
]);
add("Gyruda: orphaned rows are not judged", "modern", () => [
  orphan("Gone Card", "main", { cmc: 3, manaCost: "{2}{R}" }),
  deckCard("counterspell"),
  islands(58),
  companion("Gyruda, Doom of Depths"),
]);
add("Gyruda: the sideboard is not the starting deck", "modern", () => [
  deckCard("counterspell"),
  islands(58),
  deckCard("solRing", { categoryKind: "side" }),
  companion("Gyruda, Doom of Depths"),
]);
add("Gyruda: a switched-on Maybeboard is", "modern", () => [
  deckCard("counterspell"),
  islands(58),
  activeMaybe(deckCard("solRing")),
  companion("Gyruda, Doom of Depths"),
]);
add("Gyruda: switched-off piles are not", "modern", () => [
  deckCard("counterspell"),
  islands(58),
  parked(deckCard("solRing")),
  deckCard("savannahLions", { categoryKind: "maybe" }),
  companion("Gyruda, Doom of Depths"),
]);
add("Gyruda: the column decides for split and modal cards", "modern", () => [
  deckCard("fireIce"),
  deckCard("valakutAwakening"),
  deckCard("emeriasCall"),
  companion("Gyruda, Doom of Depths"),
]);

// --- Jegantha: no repeated mana symbol. ----------------------------------------------------

add("Jegantha: five different symbols pass", "modern", () => [
  deckCard("childOfAlara"),
  companion("Jegantha, the Wellspring"),
]);
add("Jegantha: a repeated symbol fails", "modern", () => [
  deckCard("fiendHunter"),
  companion("Jegantha, the Wellspring"),
]);
add("Jegantha: a generic symbol counts once, a coloured one does not", "modern", () => [
  deckCard("wurmcoilEngine"),
  deckCard("ghalta"),
  companion("Jegantha, the Wellspring"),
]);
add("Jegantha: a split card's halves are read apart", "modern", () => [
  deckCard("fireIce"),
  companion("Jegantha, the Wellspring"),
]);
add("Jegantha: an adventure's front face repeats", "modern", () => [
  deckCard("brazenBorrower"),
  companion("Jegantha, the Wellspring"),
]);
add("Jegantha: hybrid symbols are compared as printed", "modern", () => [
  deckCard("manamorphose"),
  deckCard("burningTreeEmissary"),
  asDeckCard("Gyruda, Doom of Depths"),
  companion("Jegantha, the Wellspring"),
]);
add("Jegantha: a transform card's cost is on its face", "modern", () => [
  deckCard("bloodlineKeeper"),
  deckCard("delver"),
  companion("Jegantha, the Wellspring"),
]);
add("Jegantha: three offenders", "modern", () => [
  deckCard("fiendHunter"),
  deckCard("counterspell"),
  deckCard("wrathOfGod"),
  deckCard("solRing"),
  islands(30),
  companion("Jegantha, the Wellspring"),
]);
add("Jegantha: empty and unclosed braces", "modern", () => [
  card({ name: "Empty Braces", manaCost: "{}{}" }),
  card({ name: "Unclosed Brace", manaCost: "{1}{1" }),
  card({ name: "Nested Brace", manaCost: "{{1}{1}" }),
  companion("Jegantha, the Wellspring"),
]);
add("Jegantha: five colours outside a mono-blue commander", "commander", () => [
  card(TALRAND),
  islands(99),
  companion("Jegantha, the Wellspring"),
]);
add("Jegantha: Modern has no commander to fit", "modern", () => [
  islands(60),
  companion("Jegantha, the Wellspring"),
]);

// --- Kaheera: five creature types. ---------------------------------------------------------

add("Kaheera: a Cat passes", "modern", () => [
  deckCard("savannahLions"),
  islands(20),
  companion("Kaheera, the Orphanguard"),
]);
add("Kaheera: a Bear fails", "modern", () => [
  deckCard("grizzlyBears"),
  companion("Kaheera, the Orphanguard"),
]);
add("Kaheera: noncreatures are ignored", "modern", () => [
  deckCard("wrathOfGod"),
  companion("Kaheera, the Orphanguard"),
]);
add("Kaheera: all five types pass", "modern", () => [
  deckCard("savannahLions"),
  deckCard("airElemental"),
  deckCard("nightmare"),
  deckCard("ghalta"),
  deckCard("thragtusk"),
  companion("Kaheera, the Orphanguard"),
]);
add("Kaheera: a changeling passes on its keyword", "modern", () => [
  deckCard("mothdustChangeling"),
  companion("Kaheera, the Orphanguard"),
]);
add("Kaheera: three offenders", "modern", () => [
  deckCard("grizzlyBears"),
  deckCard("fiendHunter"),
  deckCard("serraAngel"),
  companion("Kaheera, the Orphanguard"),
]);
add("Kaheera: five offenders", "modern", () => [
  ...lettered(5),
  companion("Kaheera, the Orphanguard"),
]);
add("Kaheera: a creature that only mentions changeling fails", "modern", () => [
  textCard(
    "Changeling Breeder",
    "When this creature enters, create a 1/1 colorless Shapeshifter creature token with " +
      "changeling.",
  ),
  companion("Kaheera, the Orphanguard"),
]);
add("Kaheera: the keyword is a whole word with its capital", "modern", () => [
  textCard("Plural Lord", "Changelings you control get +1/+1."),
  textCard("Quiet Changeling", "changeling (This card is every creature type.)"),
  textCard("Digit Changeling", "Changeling2"),
  textCard("Accented Changeling", "Changelingé"),
  textCard("Dashed Changeling", "Changeling—every type"),
  companion("Kaheera, the Orphanguard"),
]);
add("Kaheera: changeling on a later line or a face", "modern", () => [
  textCard("Later Changeling", "Flying\nChangeling"),
  textCard("Returned Changeling", "Flying\r\nChangeling"),
  card({
    name: "Faced Changeling // Its Back",
    typeLine: "Creature — Human // Creature — Horror",
    oracleText: null,
    faces: JSON.stringify([
      { name: "Faced Changeling", type_line: "Creature — Human", oracle_text: "" },
      { name: "Its Back", type_line: "Creature — Horror", oracle_text: "Changeling" },
    ]),
  }),
  companion("Kaheera, the Orphanguard"),
]);
add("Kaheera: every creature type without the keyword fails", "modern", () => [
  deckCard("mistformUltimus"),
  companion("Kaheera, the Orphanguard"),
]);
add("Kaheera: the front face's subtypes decide", "modern", () => [
  card({ name: "Joined Line", typeLine: "Creature — Human // Creature — Cat" }),
  card({
    name: "Faced Cat // Its Back",
    typeLine: "Creature — Human // Creature — Human",
    faces: JSON.stringify([{ type_line: "Creature — Cat" }, { type_line: "Creature — Human" }]),
  }),
  companion("Kaheera, the Orphanguard"),
]);
add("Kaheera: a creature land and an artifact creature are creatures", "modern", () => [
  deckCard("dryadArbor"),
  deckCard("memnite"),
  deckCard("cribSwap"),
  companion("Kaheera, the Orphanguard"),
]);

// --- Keruga: mana value 3 or greater, and lands. -------------------------------------------

add("Keruga: big spells and lands pass", "modern", () => [
  deckCard("wrathOfGod"),
  islands(30),
  companion("Keruga, the Macrosage"),
]);
add("Keruga: a cheap spell fails", "modern", () => [
  deckCard("counterspell"),
  companion("Keruga, the Macrosage"),
]);
add("Keruga: an X spell's column is its value", "modern", () => [
  deckCard("fireball"),
  companion("Keruga, the Macrosage"),
]);
add("Keruga: the cost is read when the column is missing", "modern", () => [
  card({ name: "Costed Three", cmc: null, manaCost: "{2}{U}" }),
  card({ name: "Costless", cmc: null, manaCost: null }),
  card({ name: "X Spell", cmc: null, manaCost: "{X}{U}" }),
  card({ name: "Hybrid Four", cmc: null, manaCost: "{2/W}{2/U}" }),
  companion("Keruga, the Macrosage"),
]);
add("Keruga: a modal card's front face decides land or not", "modern", () => [
  deckCard("spikefieldHazard"),
  deckCard("emeriasCall"),
  deckCard("branchloftPathway"),
  companion("Keruga, the Macrosage"),
]);
add("Keruga: three offenders", "modern", () => [
  deckCard("counterspell"),
  deckCard("solRing"),
  deckCard("savannahLions"),
  deckCard("wrathOfGod"),
  companion("Keruga, the Macrosage"),
]);
add("Keruga: five offenders", "modern", () => [
  deckCard("counterspell"),
  deckCard("solRing"),
  deckCard("savannahLions"),
  deckCard("memnite"),
  deckCard("grizzlyBears"),
  companion("Keruga, the Macrosage"),
]);

// --- Lurrus: permanents at mana value 2 or less. -------------------------------------------

add("Lurrus: nonpermanents are ignored", "modern", () => [
  deckCard("wrathOfGod"),
  deckCard("solRing"),
  companion("Lurrus of the Dream-Den"),
]);
add("Lurrus: an expensive permanent fails", "modern", () => [
  deckCard("rhysticStudy"),
  companion("Lurrus of the Dream-Den"),
]);
add("Lurrus: a switched-on Maybeboard's permanent fails", "modern", () => [
  islands(59),
  activeMaybe(deckCard("rhysticStudy")),
  companion("Lurrus of the Dream-Den"),
]);
add("Lurrus: a switched-off Maybeboard is ignored", "modern", () => [
  islands(60),
  deckCard("rhysticStudy", { categoryKind: "maybe" }),
  companion("Lurrus of the Dream-Den"),
]);
add("Lurrus: the sideboard is ignored", "modern", () => [
  islands(60),
  deckCard("rhysticStudy", { categoryKind: "side" }),
  companion("Lurrus of the Dream-Den"),
]);
add("Lurrus: a Kindred instant is not a permanent", "modern", () => [
  deckCard("cribSwap"),
  deckCard("dryadArbor"),
  companion("Lurrus of the Dream-Den"),
]);
add("Lurrus: battles and planeswalkers are permanents", "modern", () => [
  deckCard("invasionOfZendikar"),
  deckCard("invasionOfTarkir"),
  deckCard("jace"),
  companion("Lurrus of the Dream-Den"),
]);
add("Lurrus: the commander is in the starting deck", "commander", () => [
  commander(),
  islands(99),
  companion("Lurrus of the Dream-Den"),
]);
add("Lurrus: six offenders", "modern", () => [
  deckCard("rhysticStudy"),
  deckCard("fiendHunter"),
  deckCard("serraAngel"),
  deckCard("wurmcoilEngine"),
  deckCard("jace"),
  deckCard("thragtusk"),
  companion("Lurrus of the Dream-Den"),
]);

// --- Lutri: different names. ---------------------------------------------------------------

add("Lutri: any number of lands", "modern", () => [
  islands(60),
  companion("Lutri, the Spellchaser"),
]);
add("Lutri: a row of two copies fails", "modern", () => [
  deckCard("counterspell", { quantity: 2 }),
  companion("Lutri, the Spellchaser"),
]);
add("Lutri: rows in two piles add up", "modern", () => [
  deckCard("solRing"),
  deckCard("solRing", { categoryKind: "commander" }),
  companion("Lutri, the Spellchaser"),
]);
add("Lutri: a sideboard copy does not count", "modern", () => [
  deckCard("solRing"),
  deckCard("solRing", { categoryKind: "side" }),
  companion("Lutri, the Spellchaser"),
]);
add("Lutri: a switched-on Maybeboard copy counts", "modern", () => [
  deckCard("solRing"),
  activeMaybe(deckCard("solRing")),
  companion("Lutri, the Spellchaser"),
]);
add("Lutri: two printings of one name", "modern", () => [
  deckCard("solRing", { cardId: "c-Sol Ring-lea", setCode: "lea" }),
  deckCard("solRing", { cardId: "c-Sol Ring-c21", setCode: "c21" }),
  companion("Lutri, the Spellchaser"),
]);
add("Lutri: three repeated names", "modern", () => [
  deckCard("counterspell", { quantity: 2 }),
  deckCard("solRing", { quantity: 2 }),
  deckCard("wrathOfGod", { quantity: 3 }),
  deckCard("opt"),
  companion("Lutri, the Spellchaser"),
]);
add("Lutri: orphaned rows are not counted", "modern", () => [
  deckCard("solRing"),
  orphan("Sol Ring", "main"),
  companion("Lutri, the Spellchaser"),
]);

// --- Obosh: odd mana values, and lands. ----------------------------------------------------

add("Obosh: odd spells and lands pass", "modern", () => [
  deckCard("solRing"),
  islands(30),
  companion("Obosh, the Preypiercer"),
]);
add("Obosh: an even spell fails", "modern", () => [
  deckCard("counterspell"),
  companion("Obosh, the Preypiercer"),
]);
add("Obosh: mana value zero is even", "modern", () => [
  deckCard("memnite"),
  companion("Obosh, the Preypiercer"),
]);
add("Obosh: a split card's value is both halves", "modern", () => [
  deckCard("fireIce"),
  companion("Obosh, the Preypiercer"),
]);
add("Obosh: half a mana is not even", "modern", () => [
  deckCard("littleGirl"),
  card({ name: "Costless", cmc: null, manaCost: null }),
  companion("Obosh, the Preypiercer"),
]);
add("Obosh: three offenders", "modern", () => [
  deckCard("counterspell"),
  deckCard("wrathOfGod"),
  deckCard("grizzlyBears"),
  deckCard("solRing"),
  companion("Obosh, the Preypiercer"),
]);

// --- Umori: one shared card type. ----------------------------------------------------------

add("Umori: all creatures pass", "modern", () => [
  deckCard("savannahLions"),
  deckCard("grizzlyBears"),
  islands(30),
  companion("Umori, the Collector"),
]);
add("Umori: an artifact creature shares Creature", "modern", () => [
  deckCard("grizzlyBears"),
  deckCard("memnite"),
  companion("Umori, the Collector"),
]);
add("Umori: the odd one out", "modern", () => [
  deckCard("savannahLions"),
  deckCard("grizzlyBears"),
  deckCard("wrathOfGod"),
  companion("Umori, the Collector"),
]);
add("Umori: a tie goes to the type counted first", "modern", () => [
  deckCard("wrathOfGod"),
  deckCard("grizzlyBears"),
  companion("Umori, the Collector"),
]);
add("Umori: three offenders", "modern", () => [
  deckCard("savannahLions"),
  deckCard("grizzlyBears"),
  deckCard("memnite"),
  deckCard("wrathOfGod"),
  deckCard("counterspell"),
  deckCard("rhysticStudy"),
  companion("Umori, the Collector"),
]);
add("Umori: five offenders", "modern", () => [
  ...lettered(6),
  ...lettered(5, { typeLine: "Sorcery" }, " Spell"),
  companion("Umori, the Collector"),
]);
add("Umori: supertypes are not card types", "modern", () => [
  deckCard("childOfAlara"),
  deckCard("urzasRuinousBlast"),
  companion("Umori, the Collector"),
]);
add("Umori: a planeswalker is not also a Plane", "modern", () => [
  deckCard("grizzlyBears"),
  deckCard("savannahLions"),
  deckCard("jace"),
  companion("Umori, the Collector"),
]);
add("Umori: a card with no card type is left out", "modern", () => [
  deckCard("grizzlyBears"),
  card({ name: "Untyped Row", typeLine: null }),
  card({ name: "Backup Plan", typeLine: "Conspiracy" }),
  companion("Umori, the Collector"),
]);
add("Umori: a deck of lands", "modern", () => [islands(60), companion("Umori, the Collector")]);
add("Umori: a Kindred instant shares Instant", "modern", () => [
  deckCard("cribSwap"),
  deckCard("counterspell"),
  companion("Umori, the Collector"),
]);
add("Umori: a modal card is its front face's type", "modern", () => [
  deckCard("valakutAwakening"),
  deckCard("counterspell"),
  companion("Umori, the Collector"),
]);
add("Umori: a legal Commander deck", "commander", () => [
  commander(),
  islands(99),
  companion("Umori, the Collector"),
]);
add("Umori: a colourless commander admits no colours", "commander", () => [
  card(KOZILEK),
  islands(99),
  companion("Umori, the Collector"),
]);

// --- Yorion: twenty over the minimum. ------------------------------------------------------

add("Yorion: eighty cards in Modern", "modern", () => [
  islands(80),
  companion("Yorion, Sky Nomad"),
]);
add("Yorion: seventy-nine in Modern", "modern", () => [
  islands(79),
  companion("Yorion, Sky Nomad"),
]);
add("Yorion: Commander's minimum is its maximum", "commander", () => [
  commander(),
  islands(99),
  companion("Yorion, Sky Nomad"),
]);
add("Yorion: a switched-on Maybeboard counts", "modern", () => [
  islands(79),
  activeMaybe(deckCard("opt")),
  companion("Yorion, Sky Nomad"),
]);
add("Yorion: a switched-off Maybeboard does not", "modern", () => [
  islands(79),
  deckCard("opt", { categoryKind: "maybe" }),
  companion("Yorion, Sky Nomad"),
]);
add("Yorion: a switched-off main pile does not", "modern", () => [
  islands(79),
  parked(deckCard("opt")),
  companion("Yorion, Sky Nomad"),
]);
add("Yorion: the sideboard does not", "modern", () => [
  islands(79),
  deckCard("counterspell", { categoryKind: "side", quantity: 15 }),
  companion("Yorion, Sky Nomad"),
]);
add("Yorion: orphaned rows count toward the size", "modern", () => [
  islands(79),
  orphan("Gone Card", "main"),
  companion("Yorion, Sky Nomad"),
]);
add("Yorion: Vintage", "vintage", () => [islands(100), companion("Yorion, Sky Nomad")]);
add("Yorion: Old School", "oldschool", () => [
  ...padTo(60, [deckCard("counterspell", { quantity: 4 })]),
  companion("Yorion, Sky Nomad"),
]);
add("Yorion: Limited's forty", "limited", () => [islands(59), companion("Yorion, Sky Nomad")]);
add("Yorion: Casual's zero", "casual", () => [islands(19), companion("Yorion, Sky Nomad")]);
add("Yorion: Casual with nothing but the companion", "casual", () => [
  companion("Yorion, Sky Nomad"),
]);
add("Yorion: Brawl", "brawl", () => [commander(), islands(99), companion("Yorion, Sky Nomad")]);
add("Yorion: Pauper Commander", "paupercommander", () => [
  commander(),
  islands(99),
  companion("Yorion, Sky Nomad"),
]);
add("Yorion: Duel Commander", "duel", () => [
  commander(),
  islands(99),
  companion("Yorion, Sky Nomad"),
]);
add("Yorion: Tiny Leaders: Reborn", "tlr", () => [
  tinyCommander(),
  islands(49),
  companion("Yorion, Sky Nomad"),
]);
add("Yorion: Oathbreaker with no planeswalker sets no identity", "oathbreaker", () => [
  commander(),
  islands(59),
  companion("Yorion, Sky Nomad"),
]);
add("Yorion: Oathbreaker's planeswalker sets the identity", "oathbreaker", () => [
  deckCard("jace", { categoryKind: "commander" }),
  islands(59),
  companion("Yorion, Sky Nomad"),
]);

// --- Zirda: activated abilities. -----------------------------------------------------------

add("Zirda: activated abilities and basic lands pass", "modern", () => [
  deckCard("solRing"),
  islands(30),
  companion("Zirda, the Dawnwaker"),
]);
add("Zirda: a vanilla permanent fails", "modern", () => [
  deckCard("grizzlyBears"),
  companion("Zirda, the Dawnwaker"),
]);
add("Zirda: instants and sorceries are ignored", "modern", () => [
  deckCard("counterspell"),
  deckCard("wrathOfGod"),
  companion("Zirda, the Dawnwaker"),
]);
add("Zirda: Equip prints without a colon", "modern", () => [
  deckCard("skullclamp"),
  companion("Zirda, the Dawnwaker"),
]);
add("Zirda: Equip behind a flavour name", "modern", () => [
  deckCard("katana"),
  companion("Zirda, the Dawnwaker"),
]);
add("Zirda: Saddle", "modern", () => [deckCard("fortuneSteed"), companion("Zirda, the Dawnwaker")]);
add("Zirda: a special action is not an activated ability", "modern", () => [
  deckCard("ainokSurvivalist"),
  companion("Zirda, the Dawnwaker"),
]);
add("Zirda: reminder text's colon counts", "modern", () => [
  deckCard("dryadArbor"),
  companion("Zirda, the Dawnwaker"),
]);
add("Zirda: every bare keyword on the list", "modern", () => [
  textCard("Bare Crew", "Crew 3", "Artifact — Vehicle"),
  textCard("Bare Cycling", "Flying\nCycling {2}"),
  textCard("Bare Unearth", "Unearth {B}"),
  textCard("Bare Ninjutsu", "Ninjutsu {1}{U}"),
  textCard("Bare Scavenge", "Scavenge {4}{G}{G}"),
  textCard("Bare Embalm", "Embalm {3}{W}"),
  textCard("Bare Fortify", "Fortify {3}", "Artifact — Fortification"),
  textCard("Bare Reconfigure", "Reconfigure {2}", "Artifact Creature — Equipment Fox"),
  textCard("Bare Aura Swap", "Aura swap {2}{U}", "Enchantment — Aura"),
  companion("Zirda, the Dawnwaker"),
]);
add("Zirda: keywords are read in any case", "modern", () => [
  textCard("Lower Equip", "equip {1}", "Artifact — Equipment"),
  textCard("Upper Crew", "CREW 2", "Artifact — Vehicle"),
  textCard("Mixed Aura Swap", "aURA SWAP {1}", "Enchantment — Aura"),
  companion("Zirda, the Dawnwaker"),
]);
add("Zirda: Equipped is not Equip", "modern", () => [
  textCard("Bonded Blade", "Equipped creature gets +2/+0.", "Artifact — Equipment"),
  companion("Zirda, the Dawnwaker"),
]);
add("Zirda: a keyword mid-line is not read", "modern", () => [
  textCard(
    "Midline Crew",
    "This Vehicle has crew 2 while you control a Pilot.",
    "Artifact — Vehicle",
  ),
  textCard("Comma Cycling", "Flying, cycling {2}"),
  companion("Zirda, the Dawnwaker"),
]);
add("Zirda: a keyword after a dash and any spaces", "modern", () => [
  textCard("Spaced Katana", "Masamune —   Equip {2}", "Artifact — Equipment"),
  textCard("No-Break Katana", "Masamune — Equip {2}", "Artifact — Equipment"),
  textCard("Tight Katana", "Masamune—Equip {2}", "Artifact — Equipment"),
  textCard("Broken Katana", "Masamune —\nEquip {2}", "Artifact — Equipment"),
  companion("Zirda, the Dawnwaker"),
]);
add("Zirda: an en dash is not the flavour dash", "modern", () => [
  textCard("En Dash Katana", "Masamune – Equip {2}", "Artifact — Equipment"),
  companion("Zirda, the Dawnwaker"),
]);
add("Zirda: every JavaScript line terminator opens a line", "modern", () => [
  textCard("Return Equip", "Flying\rEquip {2}", "Artifact Creature — Equipment"),
  textCard("Separator Crew", "Flying\u2028Crew 1", "Artifact — Vehicle"),
  textCard("Paragraph Cycling", "Flying\u2029Cycling {2}"),
  companion("Zirda, the Dawnwaker"),
]);
add("Zirda: a word character after the keyword", "modern", () => [
  textCard("Glued Crew", "Crew1", "Artifact — Vehicle"),
  textCard("Underscored Equip", "Equip_", "Artifact — Equipment"),
  textCard("Accented Equip", "Equipé {1}", "Artifact — Equipment"),
  textCard("Hyphenated Cycling", "Cycling-{2}"),
  textCard("Ended Unearth", "Flying\nUnearth"),
  companion("Zirda, the Dawnwaker"),
]);
add("Zirda: no letter outside ASCII folds to an ASCII one", "modern", () => [
  textCard("Dotless Equip", "EQUıP {1}", "Artifact — Equipment"),
  textCard("Dotted Equip", "EQUİP {1}", "Artifact — Equipment"),
  textCard("Long S Scavenge", "ſcavenge {2}"),
  companion("Zirda, the Dawnwaker"),
]);
add("Zirda: a colon on a back face", "modern", () => [
  card({
    name: "Faced Mana // Its Back",
    typeLine: "Creature — Human // Creature — Elf",
    oracleText: null,
    faces: JSON.stringify([
      { name: "Faced Mana", type_line: "Creature — Human", oracle_text: "Flying" },
      { name: "Its Back", type_line: "Creature — Elf", oracle_text: "{T}: Add {G}." },
    ]),
  }),
  companion("Zirda, the Dawnwaker"),
]);
add("Zirda: three offenders", "modern", () => [
  deckCard("grizzlyBears"),
  deckCard("savannahLions"),
  deckCard("ainokSurvivalist"),
  deckCard("solRing"),
  companion("Zirda, the Dawnwaker"),
]);
add("Zirda: five offenders", "modern", () => [
  ...lettered(5, { oracleText: "" }),
  companion("Zirda, the Dawnwaker"),
]);

// --- Colour identity against a commander. --------------------------------------------------

add("identity: a switched-off commander pile sets no identity", "commander", () => [
  parked(card(TALRAND)),
  islands(99),
  companion("Jegantha, the Wellspring"),
]);
add("identity: an empty command zone sets no identity", "commander", () => [
  islands(100),
  companion("Jegantha, the Wellspring"),
]);
add("identity: two commanders' identities are one", "commander", () => [
  card(TALRAND),
  card({
    name: "Rograkh, Son of Rohgahh",
    categoryKind: "commander",
    typeLine: "Legendary Creature — Kobold Warrior",
    manaCost: "{0}",
    cmc: 0,
    oracleText:
      "First strike, menace, trample\nPartner (You can have two commanders if both have partner.)",
    colors: "R",
    colorIdentity: "R",
  }),
  islands(98),
  companion("Lutri, the Spellchaser"),
]);
add("identity: a colourless commander admits a colourless card", "commander", () => [
  card(KOZILEK),
  islands(99),
  card({ name: "Lightning Bolt", categoryKind: "companion", colorIdentity: "" }),
]);
add("identity: an unknown companion is held to it after its warning", "commander", () => [
  card(TALRAND),
  islands(99),
  stranger(
    "Treizeci, Sun of Serra",
    "Companion — Your starting deck contains only nostalgic cards. (Retro frames, " +
      "legends, and artifacts are nostalgic.)",
    { colorIdentity: "W" },
  ),
]);
add("identity: an orphaned companion is not held to it", "commander", () => [
  card(TALRAND),
  islands(99),
  orphan("Gone Card", "companion", { colorIdentity: "BR" }),
]);
add("identity: Duel Commander holds Lurrus to the commander twice over", "duel", () => [
  card(TALRAND),
  islands(99),
  companion("Lurrus of the Dream-Den"),
]);

describe("the companions golden", () => {
  it("holds companionIssues' answers to the committed file", async () => {
    const text = goldenText(ABOUT, cases, SPECS);
    await expect(text).toMatchFileSnapshot("../__golden__/companions.json");
  });
});
