/**
 * The validation goldens: `../__golden__/validation.json` (`validateDeck` and `validateForMarks`
 * per case) and `../__golden__/rules-text.json` (the per-string rules `singleton.ts` and
 * `manaValueOf` answer), which `crates/grimoire-core/src/deck_rules/engine.rs` and `singleton.rs`
 * must reproduce. See `golden.ts` for the file shape and why a golden is never edited by hand.
 *
 * Every card below is built per case after `resetRowIds()`, so a case's row ids depend on nothing
 * but the case. The fixtures are the validation suites' own (`../validation/fixtures.ts`), and the
 * printed texts are the real ones `engine.test.ts`, `commanders.test.ts` and `singleton.test.ts`
 * pin. **No `companion`-kind card appears here**: companions have a golden of their own, and the
 * whole-deck cases with one are added beside these when the companions port lands.
 */
import { describe, expect, it } from "vitest";
import type { CategoryKind, DeckCard, FormatSpec } from "@/lib/ipc";
import { goldenText, type GoldenCase } from "./golden";
import {
  CATEGORIES,
  LEGAL,
  SPECS,
  card,
  commander,
  islands,
  padTo,
  resetRowIds,
  tinyCommander,
} from "../validation/fixtures";
import { SIZE_KINDS } from "../validation/kinds";
import { manaValueOf, validateDeck, validateForMarks } from "../validation/engine";
import { copyException, isBasicLand, unreadableCopyCount } from "../validation/singleton";

type Facts = Partial<DeckCard>;

/**
 * `fixtures.SPECS`, plus two rows no seed holds: a deck maximum that is not the minimum (the
 * "at most" sentence, which no seeded row can reach) and a judged row with `validates` off (the
 * cell, not the key). Both keep `key: "modern"`, so the legality blobs read the same key.
 */
const GOLDEN_SPECS: Record<string, FormatSpec> = {
  ...SPECS,
  "modern-max-80": { ...SPECS.modern, deckMax: 80 },
  "modern-unvalidated": { ...SPECS.modern, validates: false },
};

// --- builders --------------------------------------------------------------------------------

function inZone(overrides: Facts): DeckCard {
  return card({ categoryKind: "commander", ...overrides });
}

function inKind(kind: CategoryKind, overrides: Facts, active?: boolean): DeckCard {
  return card({
    ...overrides,
    categoryKind: kind,
    categoryId: CATEGORIES[kind].id,
    categoryName: CATEGORIES[kind].name,
    ...(active === undefined ? {} : { categoryActive: active }),
  });
}

/** A card filed in a second category of the same kind — two rows, one printing. */
function inOtherPile(kind: CategoryKind, overrides: Facts): DeckCard {
  return card({ ...overrides, categoryKind: kind, categoryId: 90, categoryName: "Other pile" });
}

function parked(kind: CategoryKind, overrides: Facts): DeckCard {
  return inKind(kind, overrides, false);
}

function legalExcept(key: string, status: string): string {
  return JSON.stringify({
    commander: "legal",
    oathbreaker: "legal",
    brawl: "legal",
    paupercommander: "legal",
    duel: "legal",
    tlr: "legal",
    [key]: status,
  });
}

/** A colourless basic, for filling a deck whose commander is not blue. */
function wastes(quantity: number, kind: CategoryKind = "main"): DeckCard {
  return card({
    name: "Wastes",
    typeLine: "Basic Land",
    manaCost: null,
    cmc: 0,
    oracleText: "({T}: Add {C}.)",
    colors: null,
    colorIdentity: "",
    quantity,
    categoryKind: kind,
  });
}

function plains(quantity: number): DeckCard {
  return card({
    name: "Plains",
    typeLine: "Basic Land — Plains",
    manaCost: null,
    cmc: 0,
    oracleText: "({T}: Add {W}.)",
    colors: null,
    colorIdentity: "W",
    quantity,
  });
}

function forests(quantity: number): DeckCard {
  return card({
    name: "Forest",
    typeLine: "Basic Land — Forest",
    manaCost: null,
    cmc: 0,
    oracleText: "({T}: Add {G}.)",
    colors: null,
    colorIdentity: "G",
    quantity,
  });
}

/** `padTo` with Wastes, so the filler is inside every colour identity. */
function wastesTo(size: number, cards: DeckCard[]): DeckCard[] {
  const counted = cards
    .filter((c) => c.categoryActive && SIZE_KINDS.includes(c.categoryKind))
    .reduce((n, c) => n + c.quantity, 0);
  return counted < size ? [...cards, wastes(size - counted)] : cards;
}

// --- the cards (real printings; see commanders.test.ts) --------------------------------------

const ORPHAN: Facts = {
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
};

const ORPHANED_ISLAND: Facts = {
  name: "Island",
  quantity: 20,
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
};

const GRIZZLY_BEARS: Facts = {
  name: "Grizzly Bears",
  typeLine: "Creature — Bear",
  manaCost: "{1}{G}",
  cmc: 2,
  power: "2",
  toughness: "2",
  colors: "G",
  colorIdentity: "G",
};

const SHORIKAI: Facts = {
  name: "Shorikai, Genesis Engine",
  typeLine: "Legendary Artifact — Vehicle",
  manaCost: "{2}{W}{U}",
  cmc: 4,
  power: "8",
  toughness: "8",
  colors: "UW",
  colorIdentity: "UW",
};

const ETERNITY_ELEVATOR: Facts = {
  name: "The Eternity Elevator",
  typeLine: "Legendary Artifact — Spacecraft",
  manaCost: "{5}",
  cmc: 5,
  power: null,
  toughness: null,
  colors: "",
  colorIdentity: "",
};

const ENTERPRISE_D: Facts = {
  name: "U.S.S. Enterprise-D, Galaxy-Class",
  typeLine: "Legendary Artifact — Spacecraft",
  manaCost: "{3}",
  cmc: 3,
  power: "4",
  toughness: "5",
  colors: "",
  colorIdentity: "",
};

const THE_SERIEMA: Facts = {
  name: "The Seriema",
  typeLine: "Legendary Artifact — Spacecraft",
  manaCost: "{1}{W}{W}",
  cmc: 3,
  power: "5",
  toughness: "5",
  colors: "W",
  colorIdentity: "W",
};

const TEFERI_TEMPORAL_ARCHMAGE: Facts = {
  name: "Teferi, Temporal Archmage",
  typeLine: "Legendary Planeswalker — Teferi",
  manaCost: "{4}{U}{U}",
  cmc: 6,
  colors: "U",
  colorIdentity: "U",
  oracleText:
    "+1: Look at the top two cards of your library. Put one of them into your hand and the " +
    "other on the bottom of your library.\n" +
    "−1: Untap up to four target permanents.\n" +
    '−10: You get an emblem with "You may activate loyalty abilities of planeswalkers ' +
    "you control on any player's turn any time you could cast an instant.\"\n" +
    "Teferi, Temporal Archmage can be your commander.",
};

const TEFERI_HERO_OF_DOMINARIA: Facts = {
  name: "Teferi, Hero of Dominaria",
  typeLine: "Legendary Planeswalker — Teferi",
  manaCost: "{3}{W}{U}",
  cmc: 5,
  colors: "UW",
  colorIdentity: "UW",
  oracleText:
    "+1: Draw a card. At the beginning of the next end step, untap up to two lands.\n" +
    "−3: Put target nonland permanent into its owner's library third from the top.",
};

const GRIST: Facts = {
  name: "Grist, the Hunger Tide",
  typeLine: "Legendary Planeswalker — Grist",
  manaCost: "{1}{B}{G}",
  cmc: 3,
  colors: "BG",
  colorIdentity: "BG",
  rarity: "mythic",
  oracleText:
    "As long as Grist, the Hunger Tide isn't on the battlefield, it's a 1/1 Insect creature " +
    "in addition to its other types.\n" +
    "+1: Create a 1/1 black and green Insect creature token, then mill a card. If an Insect " +
    "card was milled this way, put a loyalty counter on Grist and repeat this process.\n" +
    "−2: You may sacrifice a creature. When you do, destroy target creature or planeswalker.\n" +
    "−5: Each opponent loses life equal to the number of creature cards in your graveyard.",
};

/** Grist's shape with the text varied — the matcher's edges, on a legendary planeswalker. */
function offTheBattlefield(name: string, oracleText: string): Facts {
  return { ...TEFERI_HERO_OF_DOMINARIA, name, oracleText };
}

const JACE_VRYNS_PRODIGY: Facts = {
  name: "Jace, Vryn's Prodigy // Jace, Telepath Unbound",
  typeLine: "Legendary Creature — Human Wizard // Legendary Planeswalker — Jace",
  manaCost: "{1}{U}",
  cmc: 2,
  layout: "transform",
  oracleText: null,
  power: "0",
  toughness: "2",
  colors: "",
  colorIdentity: "U",
  faces: JSON.stringify([
    {
      name: "Jace, Vryn's Prodigy",
      type_line: "Legendary Creature — Human Wizard",
      mana_cost: "{1}{U}",
      power: "0",
      toughness: "2",
      oracle_text: "{T}: Draw a card, then discard a card.",
    },
    {
      name: "Jace, Telepath Unbound",
      type_line: "Legendary Planeswalker — Jace",
      mana_cost: "",
      oracle_text: "+1: Up to one target creature gets -2/-0 until your next turn.",
    },
  ]),
};

const PARADISE_DRUID: Facts = {
  name: "Paradise Druid",
  typeLine: "Creature — Elf Druid",
  manaCost: "{1}{G}",
  cmc: 2,
  power: "2",
  toughness: "1",
  colors: "G",
  colorIdentity: "G",
  rarity: "uncommon",
  everUncommon: true,
  legalities: legalExcept("paupercommander", "not_legal"),
};

const EDRIC: Facts = {
  name: "Edric, Spymaster of Trest",
  typeLine: "Legendary Creature — Elf Rogue",
  manaCost: "{1}{G}{U}",
  cmc: 3,
  power: "2",
  toughness: "2",
  colors: "GU",
  colorIdentity: "GU",
  legalities: legalExcept("duel", "restricted"),
};

const ROFELLOS: Facts = {
  name: "Rofellos, Llanowar Emissary",
  typeLine: "Legendary Creature — Elf Druid",
  manaCost: "{G}{G}",
  cmc: 2,
  power: "2",
  toughness: "1",
  colors: "G",
  colorIdentity: "G",
  legalities: legalExcept("tlr", "restricted"),
};

const PARTNER_REMINDER = " (You can have two commanders if both have partner.)";

const ISHAI: Facts = {
  name: "Ishai, Ojutai Dragonspeaker",
  typeLine: "Legendary Creature — Bird Monk",
  manaCost: "{2}{W}{U}",
  cmc: 4,
  power: "1",
  toughness: "1",
  colors: "UW",
  colorIdentity: "UW",
  oracleText:
    "Flying\nWhenever an opponent casts a spell, put a +1/+1 counter on Ishai.\nPartner" +
    PARTNER_REMINDER,
};

const VIAL_SMASHER: Facts = {
  name: "Vial Smasher the Fierce",
  typeLine: "Legendary Creature — Goblin Berserker",
  manaCost: "{1}{B}{R}",
  cmc: 3,
  power: "2",
  toughness: "3",
  colors: "BR",
  colorIdentity: "BR",
  oracleText:
    "Whenever you cast your first spell each turn, choose an opponent at random.\nPartner" +
    PARTNER_REMINDER,
};

const NIKARA: Facts = {
  name: "Nikara, Lair Scavenger",
  typeLine: "Legendary Creature — Human Cleric",
  manaCost: "{2}{B}",
  cmc: 3,
  power: "2",
  toughness: "2",
  colors: "B",
  colorIdentity: "B",
  oracleText:
    "Partner with Yannik, Scavenging Sentinel (When this creature enters, target player may " +
    "put Yannik into their hand from their library, then shuffle.)\nMenace",
};

const YANNIK: Facts = {
  name: "Yannik, Scavenging Sentinel",
  typeLine: "Legendary Creature — Hyena Beast",
  manaCost: "{2}{G}{W}",
  cmc: 4,
  power: "3",
  toughness: "3",
  colors: "GW",
  colorIdentity: "GW",
  oracleText: "Partner with Nikara, Lair Scavenger\nVigilance",
};

const OKAUN: Facts = {
  name: "Okaun, Eye of Chaos // Okaun, Eye of Chaos",
  typeLine: "Legendary Creature — Cyclops Berserker",
  manaCost: "{4}{R}",
  cmc: 5,
  power: "3",
  toughness: "3",
  colors: "R",
  colorIdentity: "R",
  layout: "reversible_card",
  oracleText: null,
  faces: JSON.stringify([
    {
      name: "Okaun, Eye of Chaos",
      type_line: "Legendary Creature — Cyclops Berserker",
      mana_cost: "{4}{R}",
      power: "3",
      toughness: "3",
      oracle_text:
        "Partner with Zndrsplt, Eye of Wisdom (When this creature enters, target player may " +
        "put Zndrsplt into their hand from their library, then shuffle.)\n" +
        "At the beginning of combat on your turn, flip a coin until you lose a flip.",
    },
    {
      name: "Okaun, Eye of Chaos",
      type_line: "Legendary Creature — Cyclops Berserker",
      mana_cost: "{4}{R}",
      power: "3",
      toughness: "3",
    },
  ]),
};

const ZNDRSPLT: Facts = {
  name: "Zndrsplt, Eye of Wisdom // Zndrsplt, Eye of Wisdom",
  typeLine: "Legendary Creature — Homunculus",
  manaCost: "{4}{U}",
  cmc: 5,
  power: "1",
  toughness: "4",
  colors: "U",
  colorIdentity: "U",
  layout: "reversible_card",
  oracleText: null,
  faces: JSON.stringify([
    {
      name: "Zndrsplt, Eye of Wisdom",
      type_line: "Legendary Creature — Homunculus",
      mana_cost: "{4}{U}",
      power: "1",
      toughness: "4",
      oracle_text:
        "Partner with Okaun, Eye of Chaos (When this creature enters, target player may put " +
        "Okaun into their hand from their library, then shuffle.)\n" +
        "Whenever a player wins a coin flip, draw a card.",
    },
    {
      name: "Zndrsplt, Eye of Wisdom",
      type_line: "Legendary Creature — Homunculus",
      mana_cost: "{4}{U}",
      power: "1",
      toughness: "4",
    },
  ]),
};

const KRAV: Facts = {
  name: "Krav, the Unredeemed",
  typeLine: "Legendary Creature — Demon",
  manaCost: "{4}{B}",
  cmc: 5,
  power: "3",
  toughness: "3",
  colors: "B",
  colorIdentity: "B",
  oracleText:
    "Partner with Regna, the Redeemer (When this creature enters, target player may put " +
    "Regna into their hand from their library, then shuffle.)",
};

const VARIANT_REMINDER = " (You can have two commanders if both have this ability.)";

const WERNOG: Facts = {
  name: "Wernog, Rider's Chaplain",
  typeLine: "Legendary Creature — Human",
  manaCost: "{W}{B}",
  cmc: 2,
  power: "1",
  toughness: "2",
  colors: "BW",
  colorIdentity: "BW",
  oracleText:
    "When Wernog enters or leaves the battlefield, each opponent may investigate.\n" +
    "Partner—Friends forever" +
    VARIANT_REMINDER,
};

const ELMAR: Facts = {
  name: "Elmar, Ulvenwald Informant",
  typeLine: "Legendary Creature — Human",
  manaCost: "{1}{R}{G}",
  cmc: 3,
  power: "3",
  toughness: "2",
  colors: "GR",
  colorIdentity: "GR",
  oracleText: "Haste\nPartner—Friends forever" + VARIANT_REMINDER,
};

const SPLINTER: Facts = {
  name: "Splinter, the Mentor",
  typeLine: "Legendary Creature — Mutant Ninja Rat",
  manaCost: "{1}{B}",
  cmc: 2,
  power: "2",
  toughness: "2",
  colors: "B",
  colorIdentity: "B",
  oracleText: "Menace\nPartner—Character select" + VARIANT_REMINDER,
};

const LULU: Facts = {
  name: "Lulu, Loyal Hollyphant",
  typeLine: "Legendary Creature — Elephant Angel",
  manaCost: "{3}{W}",
  cmc: 4,
  power: "3",
  toughness: "2",
  colors: "W",
  colorIdentity: "W",
  oracleText: "Flying\nChoose a Background (You can have a Background as a second commander.)",
};

const FAR_TRAVELER: Facts = {
  name: "Far Traveler",
  typeLine: "Legendary Enchantment — Background",
  manaCost: "{2}{W}",
  cmc: 3,
  power: null,
  toughness: null,
  colors: "W",
  colorIdentity: "W",
  rarity: "uncommon",
  everUncommon: true,
  oracleText: 'Commander creatures you own have "At the beginning of your end step, exile."',
};

const HAUNTED_ONE: Facts = {
  name: "Haunted One",
  typeLine: "Legendary Enchantment — Background",
  manaCost: "{2}{B}",
  cmc: 3,
  power: null,
  toughness: null,
  colors: "B",
  colorIdentity: "B",
  oracleText: 'Commander creatures you own have "Menace."',
};

const DOCTORS_COMPANION_REMINDER = " (You can have two commanders if the other is the Doctor.)";

const ROSE_TYLER: Facts = {
  name: "Rose Tyler",
  typeLine: "Legendary Creature — Human",
  manaCost: "{1}{W}",
  cmc: 2,
  power: "2",
  toughness: "2",
  colors: "W",
  colorIdentity: "W",
  oracleText:
    "Rose Tyler gets +1/+1 for each time counter on it.\nDoctor's companion" +
    DOCTORS_COMPANION_REMINDER,
};

const TENTH_DOCTOR: Facts = {
  name: "The Tenth Doctor",
  typeLine: "Legendary Creature — Time Lord Doctor",
  manaCost: "{3}{U}{R}",
  cmc: 5,
  power: "3",
  toughness: "5",
  colors: "RU",
  colorIdentity: "RU",
  oracleText: "Allons-y! — Whenever you attack, exile cards from the top of your library.",
};

const SUSAN_FOREMAN: Facts = {
  name: "Susan Foreman",
  typeLine: "Legendary Creature — Time Lord",
  manaCost: "{1}{G}",
  cmc: 2,
  power: "1",
  toughness: "1",
  colors: "G",
  colorIdentity: "G",
  oracleText: "{T}: Add {G}.\nDoctor's companion" + DOCTORS_COMPANION_REMINDER,
};

const NAHIRI: Facts = {
  name: "Nahiri, the Lithomancer",
  typeLine: "Legendary Planeswalker — Nahiri",
  manaCost: "{3}{W}{W}",
  cmc: 5,
  colors: "W",
  colorIdentity: "W",
  oracleText:
    "+2: Create a 1/1 white Kor Soldier creature token.\n" +
    "Nahiri, the Lithomancer can be your commander.",
};

const TEVESH_SZAT: Facts = {
  name: "Tevesh Szat, Doom of Fools",
  typeLine: "Legendary Planeswalker — Szat",
  manaCost: "{4}{B}",
  cmc: 5,
  colors: "B",
  colorIdentity: "B",
  oracleText:
    "+2: Create two 0/1 black Thrull creature tokens.\n" +
    "Tevesh Szat, Doom of Fools can be your commander.\n" +
    "Partner",
};

const JESKA_THRICE_REBORN: Facts = {
  name: "Jeska, Thrice Reborn",
  typeLine: "Legendary Planeswalker — Jeska",
  manaCost: "{2}{R}",
  cmc: 3,
  colors: "R",
  colorIdentity: "R",
  oracleText:
    "−X: Jeska deals X damage to each of up to three targets.\n" +
    "Jeska, Thrice Reborn can be your commander.\n" +
    "Partner",
};

const DARK_RITUAL: Facts = {
  name: "Dark Ritual",
  typeLine: "Instant",
  manaCost: "{B}",
  cmc: 1,
  colors: "B",
  colorIdentity: "B",
  oracleText: "Add {B}{B}{B}.",
};

const DEMONIC_TUTOR: Facts = {
  name: "Demonic Tutor",
  typeLine: "Sorcery",
  manaCost: "{1}{B}",
  cmc: 2,
  colors: "B",
  colorIdentity: "B",
  oracleText: "Search your library for a card, put that card into your hand, then shuffle.",
};

const PATH_TO_EXILE: Facts = {
  name: "Path to Exile",
  typeLine: "Instant",
  manaCost: "{W}",
  cmc: 1,
  colors: "W",
  colorIdentity: "W",
  oracleText: "Exile target creature. Its controller may search their library for a basic land.",
};

const SWORDS_TO_PLOWSHARES: Facts = {
  name: "Swords to Plowshares",
  typeLine: "Instant",
  manaCost: "{W}",
  cmc: 1,
  colors: "W",
  colorIdentity: "W",
  rarity: "uncommon",
  everUncommon: true,
  oracleText: "Exile target creature. Its controller gains life equal to its power.",
};

const AZORIUS_CHARM: Facts = {
  name: "Azorius Charm",
  typeLine: "Instant",
  manaCost: "{W}{U}",
  cmc: 2,
  colors: "UW",
  colorIdentity: "UW",
};

const TAIGA: Facts = {
  name: "Taiga",
  typeLine: "Land — Mountain Forest",
  manaCost: null,
  cmc: 0,
  colors: "",
  colorIdentity: "GR",
  oracleText: "({T}: Add {R} or {G}.)",
};

const SOL_RING: Facts = {
  name: "Sol Ring",
  typeLine: "Artifact",
  manaCost: "{1}",
  cmc: 1,
  colors: "",
  colorIdentity: "",
};

const KOZILEK: Facts = {
  name: "Kozilek, Butcher of Truth",
  typeLine: "Legendary Creature — Eldrazi",
  manaCost: "{10}",
  cmc: 10,
  power: "12",
  toughness: "12",
  colors: "",
  colorIdentity: "",
};

const SRAM: Facts = {
  name: "Sram, Senior Edificer",
  typeLine: "Legendary Creature — Dwarf Advisor",
  manaCost: "{2}{W}",
  cmc: 3,
  colors: "W",
  colorIdentity: "W",
};

const MEREN: Facts = {
  name: "Meren of Clan Nel Toth",
  typeLine: "Legendary Creature — Human Shaman",
  manaCost: "{2}{B}{G}",
  cmc: 4,
  colors: "BG",
  colorIdentity: "BG",
};

const DEADLY_ROLLICK: Facts = {
  name: "Deadly Rollick",
  manaCost: "{3}{B}",
  cmc: 4,
  colors: "B",
  colorIdentity: "BG",
};

const DREADMAW: Facts = {
  name: "Colossal Dreadmaw",
  manaCost: "{4}{G}{G}",
  cmc: 6,
  typeLine: "Creature — Dinosaur",
};

const FAE_OF_WISHES: Facts = {
  name: "Fae of Wishes",
  manaCost: "{1}{U}",
  cmc: 2,
  typeLine: "Creature — Faerie // Sorcery — Adventure",
  faces: JSON.stringify([
    { name: "Fae of Wishes", mana_cost: "{1}{U}", type_line: "Creature — Faerie" },
    { name: "Granted", mana_cost: "{3}{U}", type_line: "Sorcery — Adventure" },
  ]),
};

const LOTUS_PETAL: Facts = {
  name: "Lotus Petal",
  typeLine: "Artifact",
  colors: "",
  colorIdentity: "",
};

// --- printed copy-count exceptions (singleton.test.ts) ---------------------------------------

const RELENTLESS_RATS =
  "Relentless Rats gets +1/+1 for each other creature you control named Relentless Rats.\n" +
  "A deck can have any number of cards named Relentless Rats.";
const DRAGONS_APPROACH =
  "Dragon's Approach deals 3 damage to any target. Then if you have five or more cards " +
  "named Dragon's Approach in your graveyard, you may exile them and search your library " +
  "for a Dragon creature card, put it onto the battlefield, then shuffle.\n" +
  "A deck can have any number of cards named Dragon's Approach.";
const SHADOWBORN_APOSTLE =
  "A deck can have any number of cards named Shadowborn Apostle.\n" +
  "Sacrifice six Shadowborn Apostles: Search your library for a Demon creature card, put " +
  "it onto the battlefield, then shuffle.";
const SEVEN_DWARVES =
  "Seven Dwarves gets +1/+1 for each other creature you control named Seven Dwarves.\n" +
  "A deck can have up to seven cards named Seven Dwarves.";
const NAZGUL =
  "Whenever a Ring-bearer you control causes a player to lose life, put a +1/+1 counter " +
  "on Nazgûl.\nA deck can have up to nine cards named Nazgûl.";
const BATTALION_FOOT_SOLDIER =
  "When Battalion Foot Soldier enters the battlefield, you may search your library for " +
  "any number of cards named Battalion Foot Soldier, reveal them, put them into your " +
  "hand, then shuffle.";
const THIRTY_TRAPFINDERS = "A deck can have up to thirty cards named Goblin Trapfinder.";
const TWELVE_TRAPFINDERS = "A deck can have up to 12 cards named Goblin Trapfinder.";

function copies(name: string, oracleText: string, quantity: number, more: Facts = {}): DeckCard {
  return card({ name, oracleText, quantity, ...more });
}

function everyRuleBroken(): DeckCard[] {
  const banned = JSON.stringify({ modern: "banned", commander: "banned", vintage: "banned" });
  return [
    commander(),
    card({ name: "Sol Ring", categoryKind: "commander", legalities: banned }),
    card({ name: "Black Lotus", categoryKind: "commander", legalities: "not json" }),
    card({ name: "Lightning Bolt", quantity: 9, legalities: banned, cmc: 12 }),
    card({ name: "Grizzly Bears", categoryKind: "side" }),
    card({
      name: "Ancient Tomb",
      needsReview: "This printing is not in the card database.",
      oracleId: null,
      typeLine: null,
      oracleText: null,
      legalities: null,
      cmc: null,
    }),
    parked("maybe", { name: "Deadly Rollick", colorIdentity: "BG", legalities: "not json" }),
    islands(3),
  ];
}

// --- the cases -------------------------------------------------------------------------------

interface Built {
  name: string;
  spec: keyof typeof GOLDEN_SPECS;
  cards: () => DeckCard[];
}

const z = inZone;

const SIZE: Built[] = [
  { name: "size: modern 59 is short", spec: "modern", cards: () => [islands(59)] },
  { name: "size: modern 60 is enough", spec: "modern", cards: () => [islands(60)] },
  { name: "size: modern has no maximum", spec: "modern", cards: () => [islands(247)] },
  {
    name: "size: commander 99 is short of exactly 100",
    spec: "commander",
    cards: () => [commander(), islands(98)],
  },
  {
    name: "size: commander 101 is over exactly 100",
    spec: "commander",
    cards: () => [commander(), islands(100)],
  },
  {
    name: "size: commander exactly 100",
    spec: "commander",
    cards: () => [commander(), islands(99)],
  },
  { name: "size: at most 80, over", spec: "modern-max-80", cards: () => [islands(81)] },
  { name: "size: at most 80, at it", spec: "modern-max-80", cards: () => [islands(80)] },
  { name: "size: at most 80, short", spec: "modern-max-80", cards: () => [islands(59)] },
  { name: "size: limited 40", spec: "limited", cards: () => [islands(40)] },
  { name: "size: limited 39", spec: "limited", cards: () => [islands(39)] },
  { name: "size: casual empty deck", spec: "casual", cards: () => [] },
  { name: "size: modern empty deck", spec: "modern", cards: () => [] },
  { name: "size: a row of quantity zero", spec: "modern", cards: () => [islands(0)] },
  {
    name: "size: oathbreaker counts the command zone toward exactly 60, short",
    spec: "oathbreaker",
    cards: () => [z(NAHIRI), z(SWORDS_TO_PLOWSHARES), wastes(57)],
  },
  {
    name: "size: oathbreaker exactly 60",
    spec: "oathbreaker",
    cards: () => [z(NAHIRI), z(SWORDS_TO_PLOWSHARES), wastes(58)],
  },
  {
    name: "size: tiny leaders exactly 50, short",
    spec: "tlr",
    cards: () => [tinyCommander(), islands(40)],
  },
  { name: "size: gladiator needs at least 100", spec: "gladiator", cards: () => [islands(99)] },
  { name: "size: gladiator 100", spec: "gladiator", cards: () => [islands(100)] },
  { name: "size: brawl short", spec: "brawl", cards: () => [commander(), islands(50)] },
  {
    name: "size: pauper commander long",
    spec: "paupercommander",
    cards: () => [z(PARADISE_DRUID), forests(100)],
  },
  { name: "size: duel exactly 100", spec: "duel", cards: () => [commander(), islands(99)] },
  { name: "size: vintage short", spec: "vintage", cards: () => [islands(10)] },
  { name: "size: old school short", spec: "oldschool", cards: () => [islands(59)] },
  {
    name: "size: the sideboard is not counted",
    spec: "modern",
    cards: () => [islands(59), islands(15, "side")],
  },
  { name: "size: commander empty deck", spec: "commander", cards: () => [] },
];

const SIDEBOARD: Built[] = [
  {
    name: "sideboard: modern 16 is over 15",
    spec: "modern",
    cards: () => [islands(60), islands(16, "side")],
  },
  {
    name: "sideboard: modern 15 fits",
    spec: "modern",
    cards: () => [islands(60), islands(15, "side")],
  },
  {
    name: "sideboard: commander has none",
    spec: "commander",
    cards: () => [commander(), islands(99), islands(1, "side")],
  },
  {
    name: "sideboard: limited is uncapped",
    spec: "limited",
    cards: () => [islands(40), islands(40, "side")],
  },
  {
    name: "sideboard: casual is uncapped",
    spec: "casual",
    cards: () => [islands(1), islands(100, "side")],
  },
  {
    name: "sideboard: tiny leaders 11 is over 10",
    spec: "tlr",
    cards: () => [tinyCommander(), islands(49), islands(11, "side")],
  },
  {
    name: "sideboard: tiny leaders 10 fits",
    spec: "tlr",
    cards: () => [tinyCommander(), islands(49), islands(10, "side")],
  },
  {
    name: "sideboard: gladiator has none",
    spec: "gladiator",
    cards: () => [islands(100), islands(1, "side")],
  },
  {
    name: "sideboard: a switched-off sideboard counts nothing",
    spec: "modern",
    cards: () => [islands(60), { ...islands(20, "side"), categoryActive: false }],
  },
];

const SWITCH: Built[] = [
  {
    name: "switch: an inactive Maybeboard counts toward nothing",
    spec: "commander",
    cards: () => [
      commander(),
      islands(99),
      card({
        name: "Sol Ring",
        categoryKind: "maybe",
        quantity: 4,
        legalities: '{"commander":"banned"}',
      }),
    ],
  },
  {
    name: "switch: a switched-off main pile counts nothing",
    spec: "modern",
    cards: () => [
      islands(60),
      parked("main", { name: "Sol Ring", quantity: 5, legalities: '{"modern":"banned"}' }),
    ],
  },
  {
    name: "switch: a switched-on Maybeboard counts copies and legality",
    spec: "modern",
    cards: () => [
      islands(60),
      inKind("maybe", { name: "Sol Ring", quantity: 5, legalities: '{"modern":"banned"}' }, true),
    ],
  },
  {
    name: "switch: a switched-on Maybeboard counts toward size",
    spec: "commander",
    cards: () => [commander(), islands(99), inKind("maybe", { name: "Sol Ring" }, true)],
  },
  {
    name: "switch: a parked Maybeboard card is not in the deck",
    spec: "commander",
    cards: () => [commander(), islands(99), parked("maybe", { name: "Sol Ring" })],
  },
  {
    name: "switch: a switched-on sideboard stays out of the size",
    spec: "commander",
    cards: () => [commander(), islands(99), inKind("side", { name: "Ancient Tomb" }, true)],
  },
];

const MARKS: Built[] = [
  {
    name: "marks: a parked card outside the commander's identity",
    spec: "commander",
    cards: () => [z(SRAM), plains(99), parked("maybe", DEADLY_ROLLICK)],
  },
  {
    name: "marks: a parked card the pool does not admit",
    spec: "modern",
    cards: () => [
      islands(60),
      parked("main", { name: "Sol Ring", legalities: '{"modern":"banned"}' }),
    ],
  },
  {
    name: "marks: a parked card counts toward no copy limit",
    spec: "commander",
    cards: () => [
      commander(),
      islands(98),
      card({ name: "Sol Ring", legalities: LEGAL }),
      parked("maybe", { name: "Sol Ring", quantity: 5, legalities: LEGAL }),
    ],
  },
  {
    name: "marks: a parked commander is not held to the active one",
    spec: "commander",
    cards: () => [
      z(SRAM),
      plains(99),
      parked("commander", MEREN),
      parked("maybe", { name: "Deadly Rollick", colorIdentity: "BG" }),
    ],
  },
  {
    name: "marks: a switched-on Maybeboard card is held to the identity",
    spec: "commander",
    cards: () => [z(SRAM), plains(98), inKind("maybe", DEADLY_ROLLICK, true)],
  },
  {
    name: "marks: casual judges neither pool nor identity",
    spec: "casual",
    cards: () => [
      islands(60),
      parked("maybe", {
        name: "Deadly Rollick",
        colorIdentity: "BG",
        legalities: '{"modern":"banned"}',
      }),
    ],
  },
  {
    name: "marks: one banned card active and parked keeps a finding each",
    spec: "modern",
    cards: () => [
      islands(59),
      card({ legalities: '{"modern":"banned"}' }),
      parked("maybe", { legalities: '{"modern":"banned"}' }),
    ],
  },
  {
    name: "marks: a parked orphan",
    spec: "modern",
    cards: () => [islands(60), parked("maybe", ORPHAN)],
  },
  {
    name: "marks: a parked card over the mana-value ceiling",
    spec: "tlr",
    cards: () => [tinyCommander(), islands(49), parked("maybe", DREADMAW)],
  },
  {
    name: "marks: a parked unreadable legality",
    spec: "modern",
    cards: () => [islands(60), parked("maybe", { legalities: "not json" })],
  },
  {
    name: "marks: parked cards with no active commander to hold them to",
    spec: "commander",
    cards: () => [islands(99), parked("maybe", DEADLY_ROLLICK), parked("commander", MEREN)],
  },
  {
    name: "marks: a parked commander-kind card is judged on legality",
    spec: "modern",
    cards: () => [
      islands(60),
      parked("commander", {
        name: "Kenrith, the Returned King",
        legalities: '{"modern":"banned"}',
      }),
    ],
  },
  {
    name: "marks: a parked pile under oathbreaker",
    spec: "oathbreaker",
    cards: () => [z(NAHIRI), z(SWORDS_TO_PLOWSHARES), wastes(58), parked("maybe", {})],
  },
  {
    name: "marks: a parked card under a colourless commander",
    spec: "commander",
    cards: () => [z(KOZILEK), wastes(99), parked("maybe", {})],
  },
  {
    name: "marks: two parked rows of one banned printing collapse",
    spec: "modern",
    cards: () => [
      islands(60),
      parked("maybe", { legalities: '{"modern":"banned"}' }),
      parked("main", { legalities: '{"modern":"banned"}' }),
    ],
  },
  {
    name: "marks: a deck finding is filed under the active rows only",
    spec: "commander",
    cards: () => [
      commander(),
      islands(97),
      card({ ...SOL_RING, quantity: 2 }),
      parked("maybe", SOL_RING),
    ],
  },
  {
    name: "marks: a parked card outside a partner pair's identity",
    spec: "commander",
    cards: () => [z(ISHAI), z(VIAL_SMASHER), islands(98), parked("maybe", forestsFacts())],
  },
];

function forestsFacts(): Facts {
  return {
    name: "Forest",
    typeLine: "Basic Land — Forest",
    manaCost: null,
    cmc: 0,
    colors: null,
    colorIdentity: "G",
  };
}

const UNSPECIFIED: Built[] = [
  {
    name: "unspecified: every rule broken, nothing judged",
    spec: "unspecified",
    cards: everyRuleBroken,
  },
  { name: "unspecified: casual judges the same rows", spec: "casual", cards: everyRuleBroken },
  {
    name: "unspecified: the cell, not the key",
    spec: "modern-unvalidated",
    cards: everyRuleBroken,
  },
  {
    name: "unspecified: commander judges the same rows",
    spec: "commander",
    cards: everyRuleBroken,
  },
  { name: "unspecified: modern judges the same rows", spec: "modern", cards: everyRuleBroken },
  { name: "unspecified: vintage judges the same rows", spec: "vintage", cards: everyRuleBroken },
];

const COPIES: Built[] = [
  {
    name: "copies: main and side together",
    spec: "modern",
    cards: () => padTo(60, [card({ quantity: 3 }), card({ quantity: 2, categoryKind: "side" })]),
  },
  {
    name: "copies: basics are exempt",
    spec: "modern",
    cards: () => [
      islands(30),
      card({ name: "Mountain", typeLine: "Basic Land — Mountain", cmc: 0, quantity: 30 }),
    ],
  },
  {
    name: "copies: no limit where the spec has none",
    spec: "limited",
    cards: () => padTo(40, [card({ quantity: 12 })]),
  },
  {
    name: "copies: singleton format",
    spec: "commander",
    cards: () => padTo(100, [commander(), card({ name: "Sol Ring", quantity: 2 })]),
  },
  {
    name: "copies: a foil and a regular copy are one card",
    spec: "commander",
    cards: () =>
      padTo(100, [
        commander(),
        card({ name: "Sol Ring", finish: "foil", quantity: 1 }),
        card({ name: "Sol Ring", quantity: 1 }),
      ]),
  },
  {
    name: "copies: the command zone counts",
    spec: "commander",
    cards: () => padTo(100, [commander(), card({ ...commander(), categoryKind: "main" })]),
  },
  {
    name: "copies: gladiator is singleton without a commander",
    spec: "gladiator",
    cards: () => padTo(100, [card({ quantity: 2 })]),
  },
  {
    name: "copies: any number of relentless rats",
    spec: "commander",
    cards: () => padTo(100, [commander(), copies("Relentless Rats", RELENTLESS_RATS, 12)]),
  },
  {
    name: "copies: any number of dragon's approach",
    spec: "commander",
    cards: () => padTo(100, [commander(), copies("Dragon's Approach", DRAGONS_APPROACH, 30)]),
  },
  {
    name: "copies: shadowborn apostle prints it first",
    spec: "modern",
    cards: () => padTo(60, [copies("Shadowborn Apostle", SHADOWBORN_APOSTLE, 20)]),
  },
  {
    name: "copies: seven dwarves at seven",
    spec: "commander",
    cards: () => padTo(100, [commander(), copies("Seven Dwarves", SEVEN_DWARVES, 7)]),
  },
  {
    name: "copies: seven dwarves at eight",
    spec: "commander",
    cards: () => padTo(100, [commander(), copies("Seven Dwarves", SEVEN_DWARVES, 8)]),
  },
  {
    name: "copies: nazgûl at nine",
    spec: "commander",
    cards: () => padTo(100, [commander(), copies("Nazgûl", NAZGUL, 9)]),
  },
  {
    name: "copies: nazgûl at ten",
    spec: "commander",
    cards: () => padTo(100, [commander(), copies("Nazgûl", NAZGUL, 10)]),
  },
  {
    name: "copies: seven dwarves above modern's four",
    spec: "modern",
    cards: () => padTo(60, [copies("Seven Dwarves", SEVEN_DWARVES, 5)]),
  },
  {
    name: "copies: seven dwarves past seven in modern",
    spec: "modern",
    cards: () => padTo(60, [copies("Seven Dwarves", SEVEN_DWARVES, 8)]),
  },
  {
    name: "copies: an unreadable count past singleton warns",
    spec: "commander",
    cards: () => padTo(100, [commander(), copies("Goblin Trapfinder", THIRTY_TRAPFINDERS, 8)]),
  },
  {
    name: "copies: an unreadable count within the format's limit is silent",
    spec: "commander",
    cards: () => padTo(100, [commander(), copies("Goblin Trapfinder", THIRTY_TRAPFINDERS, 1)]),
  },
  {
    name: "copies: an unreadable count past modern's four warns",
    spec: "modern",
    cards: () => padTo(60, [copies("Goblin Trapfinder", THIRTY_TRAPFINDERS, 5)]),
  },
  {
    name: "copies: an unreadable count at modern's four is silent",
    spec: "modern",
    cards: () => padTo(60, [copies("Goblin Trapfinder", THIRTY_TRAPFINDERS, 4)]),
  },
  {
    name: "copies: an unreadable count where nothing is limited is silent",
    spec: "limited",
    cards: () => padTo(40, [copies("Goblin Trapfinder", THIRTY_TRAPFINDERS, 8)]),
  },
  {
    name: "copies: a printed digit count",
    spec: "commander",
    cards: () => padTo(100, [commander(), copies("Goblin Trapfinder", TWELVE_TRAPFINDERS, 13)]),
  },
  {
    name: "copies: a printed zero",
    spec: "modern",
    cards: () =>
      padTo(60, [
        copies("Nothing At All", "A deck can have up to 0 cards named Nothing At All.", 1),
      ]),
  },
  {
    name: "copies: a printed count below the format's limit",
    spec: "modern",
    cards: () =>
      padTo(60, [copies("Twin Copy", "A deck can have up to two cards named Twin Copy.", 3)]),
  },
  {
    name: "copies: a printed count below the format's limit, beside an orphan",
    spec: "modern",
    cards: () =>
      padTo(60, [
        copies("Twin Copy", "A deck can have up to two cards named Twin Copy.", 3, {
          oracleId: null,
        }),
        card({ ...ORPHAN, name: "Twin Copy", needsReview: null, quantity: 2 }),
      ]),
  },
  {
    name: "copies: a live row speaks for an orphan beside it",
    spec: "commander",
    cards: () =>
      padTo(100, [
        commander(),
        copies("Seven Dwarves", SEVEN_DWARVES, 4, { oracleId: null }),
        card({ ...ORPHAN, name: "Seven Dwarves", quantity: 4 }),
      ]),
  },
  {
    name: "copies: the battalion foot soldier trap",
    spec: "commander",
    cards: () =>
      padTo(100, [commander(), copies("Battalion Foot Soldier", BATTALION_FOOT_SOLDIER, 5)]),
  },
  {
    name: "copies: restricted in vintage at one",
    spec: "vintage",
    cards: () => padTo(60, [card({ legalities: '{"vintage":"restricted"}' })]),
  },
  {
    name: "copies: restricted in vintage at three",
    spec: "vintage",
    cards: () => padTo(60, [card({ quantity: 3, legalities: '{"vintage":"restricted"}' })]),
  },
  {
    name: "copies: restricted in modern is one copy too",
    spec: "modern",
    cards: () => padTo(60, [card({ quantity: 2, legalities: '{"modern":"restricted"}' })]),
  },
  {
    name: "copies: restricted outranks an unreadable count",
    spec: "vintage",
    cards: () =>
      padTo(60, [
        copies("Goblin Trapfinder", THIRTY_TRAPFINDERS, 2, {
          legalities: '{"vintage":"restricted"}',
        }),
      ]),
  },
  {
    name: "copies: restricted silences an unreadable count's warning",
    spec: "vintage",
    cards: () =>
      padTo(60, [
        copies("Goblin Trapfinder", THIRTY_TRAPFINDERS, 1, {
          legalities: '{"vintage":"restricted"}',
        }),
      ]),
  },
  {
    name: "copies: any printing restricted speaks for the card",
    spec: "vintage",
    cards: () =>
      padTo(60, [
        card({ cardId: "bolt-lea", legalities: '{"vintage":"legal"}' }),
        card({ cardId: "bolt-m10", setCode: "m10", legalities: '{"vintage":"restricted"}' }),
      ]),
  },
  {
    name: "copies: duel restricted is silent in the main deck",
    spec: "duel",
    cards: () =>
      padTo(100, [
        commander(),
        card({ name: "Sol Ring", quantity: 4, legalities: '{"duel":"restricted"}' }),
      ]),
  },
  {
    name: "copies: restricted means nothing without legality data",
    spec: "casual",
    cards: () => [card({ quantity: 5, legalities: '{"casual":"restricted"}' })],
  },
  {
    name: "copies: a group of orphans is not counted",
    spec: "modern",
    cards: () => padTo(60, [card(ORPHANED_ISLAND)]),
  },
  {
    name: "copies: orphans of two printings group by name",
    spec: "modern",
    cards: () =>
      padTo(60, [
        card({ ...ORPHAN, quantity: 3 }),
        card({ ...ORPHAN, cardId: "tomb-2", quantity: 3 }),
      ]),
  },
  {
    name: "copies: one oracle id groups two names",
    spec: "modern",
    cards: () =>
      padTo(60, [
        card({ name: "Bolt A", oracleId: "o-bolt", quantity: 3 }),
        card({ name: "Bolt B", oracleId: "o-bolt", quantity: 2 }),
      ]),
  },
  {
    name: "copies: snow basics are exempt",
    spec: "commander",
    cards: () =>
      padTo(100, [
        commander(),
        card({
          name: "Snow-Covered Forest",
          typeLine: "Basic Snow Land — Forest",
          colorIdentity: "G",
          quantity: 10,
        }),
      ]),
  },
  {
    name: "copies: Basic Creature is not a basic land",
    spec: "commander",
    cards: () =>
      padTo(100, [
        commander(),
        card({ name: "Shapeshifter", typeLine: "Basic Creature — Shapeshifter", quantity: 2 }),
      ]),
  },
  {
    name: "copies: a basic back face is not exempt",
    spec: "commander",
    cards: () =>
      padTo(100, [
        commander(),
        card({
          name: "Backfaced",
          typeLine: "Creature — Human // Basic Land — Island",
          quantity: 2,
        }),
      ]),
  },
  {
    name: "copies: a basic front face is exempt",
    spec: "commander",
    cards: () =>
      padTo(100, [
        commander(),
        card({
          name: "Frontfaced",
          typeLine: "Basic Land — Island // Creature — Human",
          quantity: 2,
        }),
      ]),
  },
  {
    name: "copies: wastes under a colourless commander",
    spec: "commander",
    cards: () => [z(KOZILEK), wastes(99)],
  },
];

const LEGALITY: Built[] = [
  {
    name: "legality: banned in modern",
    spec: "modern",
    cards: () => padTo(60, [card({ quantity: 4, legalities: '{"modern":"banned"}' })]),
  },
  {
    name: "legality: not legal in modern",
    spec: "modern",
    cards: () => padTo(60, [card({ quantity: 4, legalities: '{"modern":"not_legal"}' })]),
  },
  {
    name: "legality: old school per printing",
    spec: "oldschool",
    cards: () =>
      padTo(60, [
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
      ]),
  },
  {
    name: "legality: old school keeps differing sentences apart",
    spec: "oldschool",
    cards: () =>
      padTo(60, [
        card({ name: "Serra Angel", cardId: "serra-lea", legalities: '{"oldschool":"legal"}' }),
        card({ name: "Serra Angel", cardId: "serra-8ed", legalities: '{"oldschool":"not_legal"}' }),
        card({ name: "Chaos Orb", cardId: "orb-lea", legalities: '{"oldschool":"banned"}' }),
      ]),
  },
  {
    name: "legality: casual checks no pool",
    spec: "casual",
    cards: () =>
      padTo(40, [
        card({
          quantity: 4,
          legalities: JSON.stringify({ modern: "banned", commander: "banned", vintage: "banned" }),
        }),
      ]),
  },
  {
    name: "legality: limited checks no pool",
    spec: "limited",
    cards: () =>
      padTo(40, [
        card({
          quantity: 4,
          legalities: JSON.stringify({ modern: "banned", commander: "banned", vintage: "banned" }),
        }),
      ]),
  },
  {
    name: "legality: a missing key is not legal",
    spec: "modern",
    cards: () => padTo(60, [card({ legalities: "{}" })]),
  },
  {
    name: "legality: a null blob is not legal",
    spec: "modern",
    cards: () => padTo(60, [card({ legalities: null })]),
  },
  {
    name: "legality: an unreadable blob warns",
    spec: "modern",
    cards: () => padTo(60, [card({ legalities: "not json" })]),
  },
  {
    name: "legality: an array blob is unreadable",
    spec: "modern",
    cards: () => padTo(60, [card({ legalities: '["modern"]' })]),
  },
  {
    name: "legality: a JSON null blob is unreadable",
    spec: "modern",
    cards: () => padTo(60, [card({ legalities: "null" })]),
  },
  {
    name: "legality: a JSON string blob is unreadable",
    spec: "modern",
    cards: () => padTo(60, [card({ legalities: '"legal"' })]),
  },
  {
    name: "legality: a JSON number blob is unreadable",
    spec: "modern",
    cards: () => padTo(60, [card({ legalities: "42" })]),
  },
  {
    name: "legality: an empty blob is unreadable",
    spec: "modern",
    cards: () => padTo(60, [card({ legalities: "" })]),
  },
  {
    name: "legality: an unknown status warns",
    spec: "modern",
    cards: () => padTo(60, [card({ legalities: '{"modern":"probationary"}' })]),
  },
  {
    name: "legality: a status that is not a string is missing",
    spec: "modern",
    cards: () =>
      padTo(60, [
        card({ legalities: '{"modern":1}' }),
        card({ name: "Shock", legalities: '{"modern":null}' }),
      ]),
  },
  {
    name: "legality: restricted says nothing in the per-card pass",
    spec: "modern",
    cards: () => padTo(60, [card({ legalities: '{"modern":"restricted"}' })]),
  },
  {
    name: "legality: pauper commander exempts its commander",
    spec: "paupercommander",
    cards: () => [z(PARADISE_DRUID), card(LOTUS_PETAL), forests(98)],
  },
  {
    name: "legality: pauper commander holds the 99 to its key",
    spec: "paupercommander",
    cards: () => [
      z(PARADISE_DRUID),
      card({
        name: "Elvish Visionary",
        colorIdentity: "G",
        legalities: legalExcept("paupercommander", "not_legal"),
      }),
      forests(98),
    ],
  },
  {
    name: "legality: a banned pauper commander still speaks",
    spec: "paupercommander",
    cards: () => [
      z({ ...PARADISE_DRUID, legalities: legalExcept("paupercommander", "banned") }),
      card(LOTUS_PETAL),
      forests(98),
    ],
  },
  {
    name: "legality: a pauper commander with no key is exempt",
    spec: "paupercommander",
    cards: () => [z({ ...PARADISE_DRUID, legalities: "{}" }), card(LOTUS_PETAL), forests(98)],
  },
  {
    name: "legality: a commander not legal in commander",
    spec: "commander",
    cards: () => [
      z({
        name: "Kenrith, the Returned King",
        ...commanderFacts(),
        legalities: legalExcept("commander", "not_legal"),
      }),
      islands(99),
    ],
  },
  {
    name: "legality: a row missing some facts is not an orphan",
    spec: "modern",
    cards: () => padTo(60, [card({ legalities: null, layout: null, rarity: null })]),
  },
];

function commanderFacts(): Facts {
  return {
    typeLine: "Legendary Creature — Human Noble",
    manaCost: "{4}{W}",
    cmc: 5,
    power: "5",
    toughness: "5",
    colors: "W",
    colorIdentity: "BGRUW",
  };
}

const COLLAPSE: Built[] = [
  {
    name: "collapse: one printing in two piles",
    spec: "modern",
    cards: () =>
      padTo(60, [
        card({ quantity: 2, legalities: '{"modern":"banned"}' }),
        card({ quantity: 2, categoryKind: "side", legalities: '{"modern":"banned"}' }),
      ]),
  },
  {
    name: "collapse: two printings of one banned card",
    spec: "modern",
    cards: () =>
      padTo(60, [
        card({ cardId: "bolt-lea", legalities: '{"modern":"banned"}' }),
        card({ cardId: "bolt-m10", setCode: "m10", legalities: '{"modern":"banned"}' }),
      ]),
  },
  {
    name: "collapse: an orphan in two piles",
    spec: "modern",
    cards: () =>
      padTo(60, [
        card({ ...ORPHAN, needsReview: "This printing is not in the card database." }),
        card({
          ...ORPHAN,
          needsReview: "This printing is not in the card database.",
          categoryKind: "side",
        }),
      ]),
  },
  {
    name: "collapse: a mana-value break in two piles",
    spec: "tlr",
    cards: () =>
      padTo(50, [tinyCommander(), card(DREADMAW), card({ ...DREADMAW, categoryKind: "side" })]),
  },
  {
    name: "collapse: a colour-identity break in two piles",
    spec: "commander",
    cards: () => padTo(100, [z(ISHAI), card(TAIGA), card({ ...TAIGA, categoryKind: "side" })]),
  },
  {
    name: "collapse: a commander in the wrong format, in two piles",
    spec: "modern",
    cards: () =>
      padTo(60, [
        commander(),
        inOtherPile("commander", { name: "Kenrith, the Returned King", ...commanderFacts() }),
      ]),
  },
  {
    name: "collapse: three printings, two banned, one sentence",
    spec: "modern",
    cards: () =>
      padTo(60, [
        card({ cardId: "bolt-a", legalities: '{"modern":"banned"}' }),
        card({ cardId: "bolt-b", legalities: '{"modern":"legal"}' }),
        card({ cardId: "bolt-c", legalities: '{"modern":"banned"}' }),
        card({ cardId: "bolt-a", categoryKind: "side", legalities: '{"modern":"banned"}' }),
      ]),
  },
];

const ORPHANS: Built[] = [
  {
    name: "orphan: with the reconciler's sentence",
    spec: "modern",
    cards: () => padTo(60, [card(ORPHAN)]),
  },
  {
    name: "orphan: before the reconciler's sentence",
    spec: "modern",
    cards: () => padTo(60, [card({ ...ORPHAN, needsReview: null })]),
  },
  {
    name: "orphan: an empty sentence reads as none",
    spec: "modern",
    cards: () => padTo(60, [card({ ...ORPHAN, needsReview: "" })]),
  },
  {
    name: "orphan: in the command zone",
    spec: "commander",
    cards: () => [z(ORPHAN), islands(99)],
  },
  {
    name: "orphan: under tiny leaders' ceiling",
    spec: "tlr",
    cards: () => [tinyCommander(), card({ ...ORPHAN, cmc: 9 }), islands(48)],
  },
  {
    name: "orphan: in a format with no legality data",
    spec: "casual",
    cards: () => [card(ORPHAN)],
  },
];

function tlr(...cards: DeckCard[]): DeckCard[] {
  return padTo(50, [tinyCommander(), ...cards]);
}

const MANA_VALUE: Built[] = [
  { name: "mana value: over the ceiling", spec: "tlr", cards: () => tlr(card(DREADMAW)) },
  {
    name: "mana value: no ceiling in modern",
    spec: "modern",
    cards: () => padTo(60, [card(DREADMAW)]),
  },
  {
    name: "mana value: a face over the ceiling",
    spec: "tlr",
    cards: () => tlr(card(FAE_OF_WISHES)),
  },
  {
    name: "mana value: computed from the cost when cmc is null",
    spec: "tlr",
    cards: () => tlr(card({ name: "Costed", cmc: null, manaCost: "{4}{G}" })),
  },
  {
    name: "mana value: nothing to read",
    spec: "tlr",
    cards: () => tlr(card({ name: "Unknown Cost", cmc: null, manaCost: null })),
  },
  {
    name: "mana value: a reversible face's own cmc",
    spec: "tlr",
    cards: () =>
      tlr(
        card({
          name: "Reversible",
          cmc: 1,
          faces: JSON.stringify([
            { cmc: 5, mana_cost: "{1}" },
            { cmc: 1, mana_cost: "{1}" },
          ]),
        }),
      ),
  },
  {
    name: "mana value: a face equal to the card's own",
    spec: "tlr",
    cards: () =>
      tlr(card({ name: "Even Faces", cmc: 4, faces: JSON.stringify([{ mana_cost: "{3}{G}" }]) })),
  },
  {
    name: "mana value: the card's own above its faces",
    spec: "tlr",
    cards: () =>
      tlr(card({ name: "Heavy Front", cmc: 5, faces: JSON.stringify([{ mana_cost: "{1}{G}" }]) })),
  },
  {
    name: "mana value: a half over the ceiling",
    spec: "tlr",
    cards: () => tlr(card({ name: "Half Past Three", cmc: null, manaCost: "{3}{½}" })),
  },
  {
    name: "mana value: a half under the ceiling",
    spec: "tlr",
    cards: () => tlr(card({ name: "Two and a Half", cmc: 2.5 })),
  },
  {
    name: "mana value: a half on a face",
    spec: "tlr",
    cards: () =>
      tlr(
        card({ name: "Half Face", cmc: 1, faces: JSON.stringify([{ mana_cost: "{2}{½}{½}{½}" }]) }),
      ),
  },
  {
    name: "mana value: unreadable faces",
    spec: "tlr",
    cards: () => tlr(card({ name: "Broken Faces", cmc: 2, faces: "not json" })),
  },
  {
    name: "mana value: faces that are not an array",
    spec: "tlr",
    cards: () => tlr(card({ name: "Object Faces", cmc: 2, faces: '{"mana_cost":"{9}"}' })),
  },
  {
    name: "mana value: odd face entries",
    spec: "tlr",
    cards: () =>
      tlr(
        card({
          name: "Odd Faces",
          cmc: 1,
          faces: '[null, 3, "x", [], {"mana_cost":"{5}"}, {"cmc":"7"}, {"cmc":4}]',
        }),
      ),
  },
  {
    name: "mana value: an empty face cost is zero",
    spec: "tlr",
    cards: () =>
      tlr(card({ name: "Free Face", cmc: null, manaCost: null, faces: '[{"mana_cost":""}]' })),
  },
  {
    name: "mana value: a double-faced commander",
    spec: "tlr",
    cards: () => padTo(50, [z(JACE_VRYNS_PRODIGY)]),
  },
  {
    name: "mana value: the commander itself",
    spec: "tlr",
    cards: () => [commander(), islands(49)],
  },
  {
    name: "mana value: a hybrid and an X cost",
    spec: "tlr",
    cards: () =>
      tlr(
        card({ name: "Twobrid", cmc: null, manaCost: "{2/W}{2/W}" }),
        card({ name: "X Spell", cmc: null, manaCost: "{X}{X}{R}" }),
      ),
  },
];

const EDH: Built[] = [
  { name: "edh: a legendary creature", spec: "commander", cards: () => [commander()] },
  {
    name: "edh: a creature that is not legendary",
    spec: "commander",
    cards: () => [z(GRIZZLY_BEARS)],
  },
  {
    name: "edh: a legendary Vehicle with a power and toughness",
    spec: "commander",
    cards: () => [z(SHORIKAI)],
  },
  {
    name: "edh: a legendary Spacecraft with a power and toughness",
    spec: "commander",
    cards: () => [z(ENTERPRISE_D)],
  },
  {
    name: "edh: a legendary Spacecraft with none",
    spec: "commander",
    cards: () => [z(ETERNITY_ELEVATOR)],
  },
  {
    name: "edh: a legendary Vehicle with none",
    spec: "commander",
    cards: () => [z({ ...SHORIKAI, name: "Parked Vehicle", power: null, toughness: null })],
  },
  {
    name: "edh: a Vehicle that is not legendary",
    spec: "commander",
    cards: () => [z({ ...SHORIKAI, name: "Plain Vehicle", typeLine: "Artifact — Vehicle" })],
  },
  {
    name: "edh: a Vehicle that is not legendary, with no power and toughness",
    spec: "commander",
    cards: () => [
      z({
        ...SHORIKAI,
        name: "Plain Wreck",
        typeLine: "Artifact — Vehicle",
        power: null,
        toughness: null,
      }),
    ],
  },
  {
    name: "edh: a Vehicle with only a power",
    spec: "commander",
    cards: () => [z({ ...SHORIKAI, name: "Half Vehicle", toughness: null })],
  },
  {
    name: "edh: a card that says it can be your commander",
    spec: "commander",
    cards: () => [z(TEFERI_TEMPORAL_ARCHMAGE)],
  },
  {
    name: "edh: a planeswalker that does not",
    spec: "commander",
    cards: () => [z(TEFERI_HERO_OF_DOMINARIA)],
  },
  {
    name: "edh: a creature everywhere but the battlefield",
    spec: "commander",
    cards: () => [z(GRIST)],
  },
  {
    name: "edh: off the battlefield, curly apostrophes and an",
    spec: "commander",
    cards: () => [
      z(
        offTheBattlefield(
          "Curly Walker",
          "As long as Curly Walker isn’t on the battlefield, it’s an Elemental creature in addition to its other types.",
        ),
      ),
    ],
  },
  {
    name: "edh: off the battlefield, shouted",
    spec: "commander",
    cards: () => [
      z(
        offTheBattlefield(
          "Loud Walker",
          "AS LONG AS LOUD WALKER ISN'T ON THE BATTLEFIELD, IT'S A 1/1 INSECT CREATURE IN ADDITION TO ITS OTHER TYPES.",
        ),
      ),
    ],
  },
  {
    name: "edh: off the battlefield, the list stops at a sentence end",
    spec: "commander",
    cards: () => [
      z(
        offTheBattlefield(
          "Stopped Walker",
          "As long as Stopped Walker isn't on the battlefield, it's a 1/1 Insect. It's a creature in addition to its other types.",
        ),
      ),
    ],
  },
  {
    name: "edh: off the battlefield, the list stops at a line end",
    spec: "commander",
    cards: () => [
      z(
        offTheBattlefield(
          "Broken Walker",
          "As long as Broken Walker isn't on the battlefield, it's a 1/1 Insect\ncreature in addition to its other types.",
        ),
      ),
    ],
  },
  {
    name: "edh: off the battlefield, no word boundary",
    spec: "commander",
    cards: () => [
      z(
        offTheBattlefield(
          "Glued Walker",
          "As long as Glued Walker isn't on the battlefield, it's a 1/1 Insectcreature in addition to its other types.",
        ),
      ),
    ],
  },
  {
    name: "edh: off the battlefield, creature right after the article",
    spec: "commander",
    cards: () => [
      z(
        offTheBattlefield(
          "Bare Walker",
          "Unless Bare Walker isn't on the battlefield, it's a creature in addition to its other types",
        ),
      ),
    ],
  },
  {
    name: "edh: off the battlefield, a second try further on",
    spec: "commander",
    cards: () => [
      z(
        offTheBattlefield(
          "Twice Walker",
          "isn't on the battlefield, it's a thing. Then: isn't on the battlefield, it's a big creature in addition to its other types",
        ),
      ),
    ],
  },
  {
    name: "edh: off the battlefield, a missing space after the article",
    spec: "commander",
    cards: () => [
      z(
        offTheBattlefield(
          "Tight Walker",
          "Tight Walker isn't on the battlefield, it's ancreature in addition to its other types",
        ),
      ),
    ],
  },
  {
    name: "edh: a double-faced card by its front",
    spec: "commander",
    cards: () => [z(JACE_VRYNS_PRODIGY)],
  },
  { name: "edh: a lone Background", spec: "commander", cards: () => [z(FAR_TRAVELER)] },
  { name: "edh: an orphan in the zone is not judged", spec: "commander", cards: () => [z(ORPHAN)] },
  {
    name: "edh: an instant in the zone",
    spec: "commander",
    cards: () => [z(SWORDS_TO_PLOWSHARES)],
  },
  {
    name: "edh: restricted means max one, not banned as commander",
    spec: "commander",
    cards: () => [
      z({
        name: "Kenrith, the Returned King",
        ...commanderFacts(),
        legalities: legalExcept("commander", "restricted"),
      }),
    ],
  },
  {
    name: "edh: two copies in one row",
    spec: "commander",
    cards: () => [z({ name: "Kenrith, the Returned King", ...commanderFacts(), quantity: 2 })],
  },
  {
    name: "edh: three copies in one row",
    spec: "commander",
    cards: () => [z({ name: "Kenrith, the Returned King", ...commanderFacts(), quantity: 3 })],
  },
  {
    name: "edh: a zone of quantity zero",
    spec: "commander",
    cards: () => [z({ name: "Kenrith, the Returned King", ...commanderFacts(), quantity: 0 })],
  },
  {
    name: "edh: an empty type line is judged",
    spec: "commander",
    cards: () => [z({ typeLine: "" })],
  },
  {
    name: "edh: a face's type line overrides the row's",
    spec: "commander",
    cards: () => [
      z({
        name: "Face Lord",
        typeLine: "Instant",
        faces: JSON.stringify([
          { type_line: "Legendary Creature — Elf", power: "1", toughness: "1" },
        ]),
      }),
    ],
  },
  {
    name: "edh: unreadable faces fall back to the row",
    spec: "commander",
    cards: () => [
      z({ name: "Kenrith, the Returned King", ...commanderFacts(), faces: "{not json" }),
    ],
  },
];

const BRAWL: Built[] = [
  {
    name: "brawl: a legendary planeswalker",
    spec: "brawl",
    cards: () => [z(TEFERI_HERO_OF_DOMINARIA)],
  },
  { name: "brawl: a legendary creature", spec: "brawl", cards: () => [commander()] },
  {
    name: "brawl: a creature that is not legendary",
    spec: "brawl",
    cards: () => [z(GRIZZLY_BEARS)],
  },
  {
    name: "brawl: a planeswalker that is not legendary",
    spec: "brawl",
    cards: () => [
      z({ ...TEFERI_HERO_OF_DOMINARIA, name: "Plain Walker", typeLine: "Planeswalker — Bob" }),
    ],
  },
  { name: "brawl: a lone Background", spec: "brawl", cards: () => [z(FAR_TRAVELER)] },
];

const OATHBREAKER: Built[] = [
  {
    name: "oathbreaker: a planeswalker and one signature spell",
    spec: "oathbreaker",
    cards: () => [z(NAHIRI), z(SWORDS_TO_PLOWSHARES)],
  },
  { name: "oathbreaker: no signature spell", spec: "oathbreaker", cards: () => [z(NAHIRI)] },
  {
    name: "oathbreaker: no oathbreaker",
    spec: "oathbreaker",
    cards: () => [z(SWORDS_TO_PLOWSHARES)],
  },
  { name: "oathbreaker: an empty zone", spec: "oathbreaker", cards: () => [] },
  {
    name: "oathbreaker: a signature spell outside the identity",
    spec: "oathbreaker",
    cards: () => [z(NAHIRI), z({})],
  },
  {
    name: "oathbreaker: two signature spells",
    spec: "oathbreaker",
    cards: () => [z(NAHIRI), z(SWORDS_TO_PLOWSHARES), z({})],
  },
  {
    name: "oathbreaker: a creature in the zone",
    spec: "oathbreaker",
    cards: () => [z(NAHIRI), z(SWORDS_TO_PLOWSHARES), commander()],
  },
  {
    name: "oathbreaker: a partner pair with a spell each",
    spec: "oathbreaker",
    cards: () => [z(TEVESH_SZAT), z(JESKA_THRICE_REBORN), z(DARK_RITUAL), z({})],
  },
  {
    name: "oathbreaker: a partner pair with three spells",
    spec: "oathbreaker",
    cards: () => [
      z(TEVESH_SZAT),
      z(JESKA_THRICE_REBORN),
      z(DARK_RITUAL),
      z({}),
      z({ ...DARK_RITUAL, cardId: "c-Dark Ritual 2" }),
    ],
  },
  {
    name: "oathbreaker: three oathbreakers",
    spec: "oathbreaker",
    cards: () => [
      z(TEVESH_SZAT),
      z(JESKA_THRICE_REBORN),
      z(NAHIRI),
      z(DARK_RITUAL),
      z({}),
      z({ ...DARK_RITUAL, cardId: "c-Dark Ritual 2" }),
    ],
  },
  {
    name: "oathbreaker: three oathbreakers and one spell",
    spec: "oathbreaker",
    cards: () => [z(TEVESH_SZAT), z(JESKA_THRICE_REBORN), z(NAHIRI), z(DARK_RITUAL)],
  },
  {
    name: "oathbreaker: two oathbreakers that do not partner",
    spec: "oathbreaker",
    cards: () => [z(TEVESH_SZAT), z(NAHIRI), z(DARK_RITUAL)],
  },
  {
    name: "oathbreaker: a partner pair's combined identity",
    spec: "oathbreaker",
    cards: () => [z(TEVESH_SZAT), z(JESKA_THRICE_REBORN), z(PATH_TO_EXILE)],
  },
  {
    name: "oathbreaker: grist and a sorcery",
    spec: "oathbreaker",
    cards: () => [z(GRIST), z(DEMONIC_TUTOR)],
  },
  { name: "oathbreaker: only a creature", spec: "oathbreaker", cards: () => [commander()] },
  {
    name: "oathbreaker: the deck held to the oathbreaker",
    spec: "oathbreaker",
    cards: () => [z(NAHIRI), z(SWORDS_TO_PLOWSHARES), card({}), card(AZORIUS_CHARM), wastes(56)],
  },
  {
    name: "oathbreaker: the deck with no oathbreaker to hold it to",
    spec: "oathbreaker",
    cards: () => [z(SWORDS_TO_PLOWSHARES), card({}), wastes(58)],
  },
  {
    name: "oathbreaker: two copies of the spell in one row",
    spec: "oathbreaker",
    cards: () => [z(NAHIRI), z({ ...SWORDS_TO_PLOWSHARES, quantity: 2 })],
  },
  {
    name: "oathbreaker: a signature spell for a colourless walker",
    spec: "oathbreaker",
    cards: () => [
      z({ ...NAHIRI, name: "Karn, the Great Creator", colorIdentity: "" }),
      z(SWORDS_TO_PLOWSHARES),
    ],
  },
  {
    name: "oathbreaker: a walker without its sentence",
    spec: "oathbreaker",
    cards: () => [z(TEFERI_HERO_OF_DOMINARIA), z(AZORIUS_CHARM)],
  },
];

const PDH: Built[] = [
  { name: "pdh: an uncommon creature", spec: "paupercommander", cards: () => [z(PARADISE_DRUID)] },
  { name: "pdh: a common creature", spec: "paupercommander", cards: () => [z(GRIZZLY_BEARS)] },
  {
    name: "pdh: an uncommon instant",
    spec: "paupercommander",
    cards: () => [z(SWORDS_TO_PLOWSHARES)],
  },
  {
    name: "pdh: a spacecraft with no power and toughness",
    spec: "paupercommander",
    cards: () => [z(ETERNITY_ELEVATOR)],
  },
  { name: "pdh: grist has never been uncommon", spec: "paupercommander", cards: () => [z(GRIST)] },
  {
    name: "pdh: an uncommon Vehicle that is not legendary",
    spec: "paupercommander",
    cards: () => [
      z({ ...SHORIKAI, name: "Uncommon Cart", typeLine: "Artifact — Vehicle", everUncommon: true }),
    ],
  },
  { name: "pdh: a Background", spec: "paupercommander", cards: () => [z(FAR_TRAVELER)] },
  {
    name: "pdh: a card that says it can be your commander",
    spec: "paupercommander",
    cards: () => [z(TEFERI_TEMPORAL_ARCHMAGE)],
  },
  {
    name: "pdh: a legendary creature never uncommon",
    spec: "paupercommander",
    cards: () => [commander()],
  },
];

const DUEL: Built[] = [
  { name: "duel: banned as a commander", spec: "duel", cards: () => [z(EDRIC)] },
  {
    name: "duel: restricted in the main deck is silent",
    spec: "duel",
    cards: () => padTo(100, [commander(), card({ ...EDRIC, categoryKind: "main" })]),
  },
  { name: "duel: grist", spec: "duel", cards: () => [z(GRIST)] },
  {
    name: "duel: a banned partner",
    spec: "duel",
    cards: () => [z({ ...ISHAI, legalities: legalExcept("duel", "restricted") }), z(VIAL_SMASHER)],
  },
  {
    name: "duel: restricted in an unreadable blob says nothing",
    spec: "duel",
    cards: () => [z({ ...EDRIC, legalities: "not json" })],
  },
];

const TLR: Built[] = [
  {
    name: "tlr: a legendary planeswalker",
    spec: "tlr",
    cards: () => [z(TEFERI_HERO_OF_DOMINARIA)],
  },
  { name: "tlr: a Vehicle", spec: "tlr", cards: () => [z(SHORIKAI)] },
  { name: "tlr: the seriema", spec: "tlr", cards: () => [z(THE_SERIEMA)] },
  {
    name: "tlr: a spacecraft with no power and toughness",
    spec: "tlr",
    cards: () => [z(ETERNITY_ELEVATOR)],
  },
  { name: "tlr: a creature that is not legendary", spec: "tlr", cards: () => [z(GRIZZLY_BEARS)] },
  { name: "tlr: banned as a commander", spec: "tlr", cards: () => [z(ROFELLOS)] },
];

const PARTNERS: Built[] = [
  { name: "partner: both plain", spec: "commander", cards: () => [z(ISHAI), z(VIAL_SMASHER)] },
  {
    name: "partner: one has no partner ability",
    spec: "commander",
    cards: () => [z(ISHAI), commander()],
  },
  {
    name: "partner: three commanders",
    spec: "commander",
    cards: () => [z(ISHAI), z(VIAL_SMASHER), z(KOZILEK)],
  },
  { name: "partner: partner with, mutual", spec: "commander", cards: () => [z(NIKARA), z(YANNIK)] },
  {
    name: "partner: partner with the wrong card",
    spec: "commander",
    cards: () => [z(NIKARA), z(KRAV)],
  },
  {
    name: "partner: partner with on the front face only",
    spec: "commander",
    cards: () => [z(OKAUN), z(ZNDRSPLT)],
  },
  {
    name: "partner: a partner with only one side names",
    spec: "commander",
    cards: () => [
      z(NIKARA),
      z({
        ...YANNIK,
        cardId: "c-impostor",
        oracleText: "Partner with Regna, the Redeemer\nVigilance",
      }),
    ],
  },
  { name: "partner: the same variant", spec: "commander", cards: () => [z(WERNOG), z(ELMAR)] },
  { name: "partner: two variants", spec: "commander", cards: () => [z(WERNOG), z(SPLINTER)] },
  {
    name: "partner: a variant and plain partner",
    spec: "commander",
    cards: () => [z(WERNOG), z(ISHAI)],
  },
  {
    name: "partner: a variant's tag ignores case",
    spec: "commander",
    cards: () => [
      z(WERNOG),
      z({ ...ELMAR, oracleText: "Haste\nPartner—friends FOREVER  (reminder)" }),
    ],
  },
  {
    name: "partner: choose a background",
    spec: "commander",
    cards: () => [z(LULU), z(FAR_TRAVELER)],
  },
  {
    name: "partner: a background, then its chooser",
    spec: "commander",
    cards: () => [z(FAR_TRAVELER), z(LULU)],
  },
  {
    name: "partner: two backgrounds",
    spec: "commander",
    cards: () => [z(FAR_TRAVELER), z(HAUNTED_ONE)],
  },
  {
    name: "partner: choose a background beside a creature",
    spec: "commander",
    cards: () => [z(LULU), commander()],
  },
  {
    name: "partner: a background beside a creature",
    spec: "commander",
    cards: () => [z(FAR_TRAVELER), commander()],
  },
  {
    name: "partner: an ineligible creature beside a legend",
    spec: "commander",
    cards: () => [z(GRIZZLY_BEARS), z(KOZILEK)],
  },
  {
    name: "partner: doctor's companion and the doctor",
    spec: "commander",
    cards: () => [z(ROSE_TYLER), z(TENTH_DOCTOR)],
  },
  {
    name: "partner: doctor's companion and a time lord",
    spec: "commander",
    cards: () => [z(ROSE_TYLER), z(SUSAN_FOREMAN)],
  },
  {
    name: "partner: a time lord companion and the doctor",
    spec: "commander",
    cards: () => [z(SUSAN_FOREMAN), z(TENTH_DOCTOR)],
  },
  {
    name: "partner: the doctor with stray spacing",
    spec: "commander",
    cards: () => [
      z(ROSE_TYLER),
      z({ ...TENTH_DOCTOR, typeLine: "Legendary Creature —  Time Lord  \tDoctor " }),
    ],
  },
  {
    name: "partner: a doctor who is not legendary",
    spec: "commander",
    cards: () => [z(ROSE_TYLER), z({ ...TENTH_DOCTOR, typeLine: "Creature — Time Lord Doctor" })],
  },
  {
    name: "partner: neither has partner",
    spec: "commander",
    cards: () => [commander(), z(KOZILEK)],
  },
  {
    name: "partner: partner with beside plain partner",
    spec: "commander",
    cards: () => [z(NIKARA), z(ISHAI)],
  },
  {
    name: "partner: plain partner beside partner with",
    spec: "commander",
    cards: () => [z(ISHAI), z(NIKARA)],
  },
  {
    name: "partner: choose a background beside the doctor",
    spec: "commander",
    cards: () => [z(LULU), z(TENTH_DOCTOR)],
  },
  {
    name: "partner: doctor's companion beside partner",
    spec: "commander",
    cards: () => [z(ROSE_TYLER), z(ISHAI)],
  },
  {
    name: "partner: partner before a CRLF",
    spec: "commander",
    cards: () => [z({ ...ISHAI, oracleText: "Flying\r\nPartner\r\nVigilance" }), z(VIAL_SMASHER)],
  },
  {
    name: "partner: partner after a line separator",
    spec: "commander",
    cards: () => [z({ ...ISHAI, oracleText: "Flying Partner" }), z(VIAL_SMASHER)],
  },
  {
    name: "partner: partner mid-line is not partner",
    spec: "commander",
    cards: () => [z({ ...ISHAI, oracleText: "Flying, Partner" }), z(VIAL_SMASHER)],
  },
  {
    name: "partner: partners is not partner",
    spec: "commander",
    cards: () => [z({ ...ISHAI, oracleText: "Partners in crime" }), z(VIAL_SMASHER)],
  },
  {
    name: "partner: partner and a tab before the reminder",
    spec: "commander",
    cards: () => [z({ ...ISHAI, oracleText: "Partner \t(reminder)" }), z(VIAL_SMASHER)],
  },
  {
    name: "partner: partner with an empty name",
    spec: "commander",
    cards: () => [z({ ...NIKARA, oracleText: "Partner with  (no one)" }), z(YANNIK)],
  },
  {
    name: "partner: partner with a name and trailing spaces",
    spec: "commander",
    cards: () => [
      z({
        ...NIKARA,
        oracleText: "Menace\nPartner with Yannik, Scavenging Sentinel \t \nVigilance",
      }),
      z(YANNIK),
    ],
  },
  {
    name: "partner: partner with a name before a carriage return",
    spec: "commander",
    cards: () => [
      z({ ...NIKARA, oracleText: "Partner with Yannik, Scavenging Sentinel\r\n" }),
      z(YANNIK),
    ],
  },
  {
    name: "partner: a variant with no tag",
    spec: "commander",
    cards: () => [z({ ...WERNOG, oracleText: "Partner—(reminder)" }), z(ELMAR)],
  },
  {
    name: "partner: two rows of one commander",
    spec: "commander",
    cards: () =>
      padTo(100, [
        commander(),
        inOtherPile("commander", { name: "Kenrith, the Returned King", ...commanderFacts() }),
      ]),
  },
  {
    name: "partner: a pair whose identity holds the deck",
    spec: "commander",
    cards: () => padTo(100, [z(ISHAI), z(VIAL_SMASHER), card(TAIGA)]),
  },
  {
    name: "partner: a pair in brawl",
    spec: "brawl",
    cards: () => [z(WERNOG), z(SPLINTER)],
  },
  {
    name: "partner: a background pair in pauper commander",
    spec: "paupercommander",
    cards: () => [z({ ...LULU, everUncommon: true }), z(FAR_TRAVELER)],
  },
];

const IDENTITY: Built[] = [
  {
    name: "identity: the whole deck held to the commander",
    spec: "commander",
    cards: () => padTo(100, [z(ISHAI), card(TAIGA)]),
  },
  {
    name: "identity: a colourless commander admits only colourless cards",
    spec: "commander",
    cards: () => [z(KOZILEK), card(SOL_RING), card({}), wastes(97)],
  },
  {
    name: "identity: colourless islands under a colourless commander",
    spec: "commander",
    cards: () => [z(KOZILEK), islands(99)],
  },
  {
    name: "identity: no commander, no identity",
    spec: "commander",
    cards: () => padTo(100, [card({})]),
  },
  {
    name: "identity: lower-case and stray letters",
    spec: "commander",
    cards: () => [
      z({ ...SRAM, colorIdentity: "wC" }),
      card({}),
      card({ name: "Simic Thing", colorIdentity: "u2g" }),
      plains(97),
    ],
  },
  {
    name: "identity: the sideboard is held to it",
    spec: "commander",
    cards: () => [z(SRAM), plains(99), card({ ...DEADLY_ROLLICK, categoryKind: "side" })],
  },
  {
    name: "identity: a null identity is colourless",
    spec: "commander",
    cards: () => [z(SRAM), card({ colorIdentity: null }), plains(98)],
  },
  {
    name: "identity: taiga under a green commander",
    spec: "commander",
    cards: () => [z({ ...ROFELLOS, legalities: LEGAL }), card(TAIGA), forests(98)],
  },
  {
    name: "identity: modern has no commander identity",
    spec: "modern",
    cards: () => padTo(60, [commander(), card(DEADLY_ROLLICK)]),
  },
  {
    name: "identity: the command zone judges itself",
    spec: "commander",
    cards: () => [z(SRAM), z({ ...ISHAI, cardId: "c-off-colour" }), plains(98)],
  },
  {
    name: "identity: every colour of the deck at once",
    spec: "commander",
    cards: () =>
      wastesTo(100, [
        z(SRAM),
        card(AZORIUS_CHARM),
        card(TAIGA),
        card({ ...DARK_RITUAL }),
        card(SOL_RING),
        card({ name: "Five Colour", colorIdentity: "GRBUW" }),
      ]),
  },
  {
    name: "identity: under tiny leaders",
    spec: "tlr",
    cards: () =>
      padTo(50, [z(ROFELLOS), card({}), card({ ...DEADLY_ROLLICK, categoryKind: "side", cmc: 4 })]),
  },
  {
    name: "identity: under duel commander",
    spec: "duel",
    cards: () => padTo(100, [z(SRAM), card(AZORIUS_CHARM)]),
  },
  {
    name: "identity: under brawl",
    spec: "brawl",
    cards: () => [z(TEFERI_HERO_OF_DOMINARIA), card({}), plains(98)],
  },
];

const ZONE: Built[] = [
  {
    name: "zone: a commander in a format with none",
    spec: "modern",
    cards: () => padTo(60, [commander()]),
  },
  { name: "zone: needs a commander", spec: "commander", cards: () => padTo(100, []) },
  {
    name: "zone: two commanders in modern",
    spec: "modern",
    cards: () => padTo(60, [commander(), z(ISHAI)]),
  },
  {
    name: "zone: a commander in gladiator",
    spec: "gladiator",
    cards: () => padTo(100, [commander()]),
  },
  { name: "zone: a commander in casual", spec: "casual", cards: () => [commander()] },
  { name: "zone: a commander in limited", spec: "limited", cards: () => padTo(40, [commander()]) },
  {
    name: "zone: a commander in old school",
    spec: "oldschool",
    cards: () => padTo(60, [commander()]),
  },
  {
    name: "zone: a whole commander deck",
    spec: "commander",
    cards: () => [
      z(ISHAI),
      z(VIAL_SMASHER),
      card(SOL_RING),
      card(AZORIUS_CHARM),
      card({}),
      card({ ...DARK_RITUAL }),
      card({ name: "Counterspell", typeLine: "Instant", colorIdentity: "U" }),
      islands(93),
    ],
  },
];

const BUILT: Built[] = [
  ...SIZE,
  ...SIDEBOARD,
  ...SWITCH,
  ...MARKS,
  ...UNSPECIFIED,
  ...COPIES,
  ...LEGALITY,
  ...COLLAPSE,
  ...ORPHANS,
  ...MANA_VALUE,
  ...EDH,
  ...BRAWL,
  ...OATHBREAKER,
  ...PDH,
  ...DUEL,
  ...TLR,
  ...PARTNERS,
  ...IDENTITY,
  ...ZONE,
];

function validationCases(): GoldenCase[] {
  return BUILT.map(({ name, spec, cards: build }) => {
    resetRowIds();
    const cards = build();
    const format = GOLDEN_SPECS[spec];
    return {
      name,
      spec,
      cards,
      deck: validateDeck(cards, format),
      marks: validateForMarks(cards, format),
    };
  });
}

// --- rules-text.json -------------------------------------------------------------------------

/** Strings no fixture prints, each standing at one edge of a rule. */
const EDGE_STRINGS: (string | null)[] = [
  null,
  "",
  TWELVE_TRAPFINDERS,
  THIRTY_TRAPFINDERS,
  "A deck can have up to as many cards as you like.",
  "A deck can have up to SEVEN cards named Loud Dwarves.",
  "A deck can have up to 07 cards named Padded Dwarves.",
  "A deck can have up to 3rd cards named Ordinal.",
  "A deck can have up to seven_ cards named Underscored.",
  "A deck can have up to  seven cards named Spaced.",
  "a deck can have up to seven cards named Lower.",
  "A deck can have up to seven cards named",
  "A deck can have up to sevencards named Joined.",
  "A deck can have up to thirty cards named X.\nA deck can have up to seven cards named X.",
  "A deck can have up to as many. A deck can have up to nine cards named Second.",
  "A deck can have any number of cards named X. A deck can have up to thirty cards named X.",
  "A deck can have up to twenty cards named Twenty.",
  "A deck can have up to twentyone cards named Run Together.",
  "A deck can have up to ninety-nine cards named Hyphen.",
  "A deck can have up to 1e3 cards named Exponent.",
  "A deck can have up to 0 cards named Nothing.",
  "A deck can have up to 99999999999999999999999 cards named Huge.",
  "A deck can have up to sevén cards named Accented.",
  "A deck can have up to ⅶ cards named Roman.",
  "A deck can have any number of cards named",
  "A deck can have any number of cards nam",
  "Basic Land — Island",
  "Basic Snow Land — Forest",
  "Basic Land",
  "Land — Island",
  "Legendary Land",
  "Snow Land — Forest",
  "Basic Creature — Shapeshifter",
  "Creature — Human // Basic Land — Island",
  "Basic Land — Island // Creature — Human",
  "basic land",
  "Land Basic",
  "Basic // Land",
  "BasicLand",
  "{2}{U}",
  "{0}",
  "{W}{U}{B}{R}{G}",
  "{X}",
  "{x}",
  "{X}{R}{R}",
  "{Y}{Z}",
  "{W/U}",
  "{2/W}{2/W}",
  "{W/P}",
  "{2/W/P}",
  "{X/2}",
  "{C}{S}",
  "{½}",
  "{½/W}",
  "{10}",
  "{}",
  "{ }",
  "{2",
  "{{2}",
  "{2}}",
  "{ 2}",
  "{ 2 }",
  "{0x10}",
  "{0X1F}",
  "{0b101}",
  "{0o17}",
  "{0x}",
  "{1e2}",
  "{1E+2}",
  "{1e}",
  "{e1}",
  "{.5}",
  "{5.}",
  "{+.5}",
  "{.}",
  "{+}",
  "{-}",
  "{-1}",
  "{+3}",
  "{00}",
  "{1.5}",
  "{1_000}",
  "{1,000}",
  "{Infinity}",
  "{-Infinity}",
  "{NaN}",
  "{inf}",
  "{∞}",
  "{H}",
  "{HW}",
  "{//}",
  "{W/}",
  "{2}{U} // {1}{G}",
  "no symbols at all",
  "{T}: Add {C}{C}.",
];

function rulesTextStrings(cases: readonly GoldenCase[]): (string | null)[] {
  const seen = new Set<string | null>();
  const out: (string | null)[] = [];
  const add = (value: unknown) => {
    if (value !== null && typeof value !== "string") return;
    if (seen.has(value)) return;
    seen.add(value);
    out.push(value);
  };
  for (const text of EDGE_STRINGS) add(text);
  for (const { cards } of cases) {
    for (const row of cards) {
      add(row.oracleText);
      add(row.typeLine);
      add(row.manaCost);
      let faces: unknown;
      try {
        faces = row.faces === null ? null : JSON.parse(row.faces);
      } catch {
        faces = null;
      }
      if (!Array.isArray(faces)) continue;
      for (const face of faces as unknown[]) {
        if (face === null || typeof face !== "object") continue;
        const fields = face as Record<string, unknown>;
        add(fields.oracle_text);
        add(fields.type_line);
        add(fields.mana_cost);
      }
    }
  }
  return out;
}

/** JSON has no `Infinity`; the golden spells it, so it is not read back as `null`. */
function spelled(value: number | null): number | string | null {
  return value === Infinity ? "Infinity" : value;
}

function rulesTextCases(strings: readonly (string | null)[]): GoldenCase[] {
  return strings.map((text, i) => ({
    name: `${String(i).padStart(3, "0")} ${JSON.stringify(text).slice(0, 60)}`,
    cards: [],
    text,
    copyException: spelled(copyException(text)),
    unreadableCopyCount: unreadableCopyCount(text),
    isBasicLand: isBasicLand(text),
    manaValueOf: manaValueOf(text),
  }));
}

describe("the validation goldens", () => {
  const cases = validationCases();

  it("hold no companion-kind card", () => {
    expect(cases.flatMap((c) => c.cards).filter((c) => c.categoryKind === "companion")).toEqual([]);
  });

  it("cover every spec in the fixtures", () => {
    const named = new Set(cases.map((c) => c.spec));
    expect(Object.keys(SPECS).filter((key) => !named.has(key))).toEqual([]);
  });

  it("cover every code engine.ts and commanders.ts emit", () => {
    const codes = new Set(
      cases.flatMap((c) => [
        ...(c.deck as { code: string }[]).map((i) => i.code),
        ...(c.marks as { code: string }[]).map((i) => i.code),
      ]),
    );
    const vocabulary = [
      "deck-size",
      "sideboard-size",
      "copy-limit",
      "singleton",
      "restricted",
      "banned",
      "not-legal",
      "unknown-legality",
      "unknown-copy-limit",
      "orphan",
      "mana-value",
      "commander-zone",
      "commander-missing",
      "commander-count",
      "commander-eligibility",
      "commander-partner",
      "commander-banned",
      "color-identity",
    ];
    expect(vocabulary.filter((code) => !codes.has(code))).toEqual([]);
  });

  it("write validation.json", async () => {
    const text = goldenText(
      "Written by packages/ui/features/decks/golden/validation.golden.test.ts from validateDeck " +
        "and validateForMarks; read by crates/grimoire-core/src/deck_rules/engine.rs. Never edit by hand.",
      cases,
      GOLDEN_SPECS,
    );
    await expect(text).toMatchFileSnapshot("../__golden__/validation.json");
  });

  it("write rules-text.json", async () => {
    const text = goldenText(
      "Written by packages/ui/features/decks/golden/validation.golden.test.ts from copyException, " +
        "unreadableCopyCount, isBasicLand and manaValueOf (Infinity spelled as a string); read by " +
        "crates/grimoire-core/src/deck_rules/singleton.rs. Never edit by hand.",
      rulesTextCases(rulesTextStrings(cases)),
    );
    await expect(text).toMatchFileSnapshot("../__golden__/rules-text.json");
  });
});
