import { beforeEach, describe, expect, it } from "vitest";
import type { CardFacts, ValidationIssue } from "./types";
import { card, commander, islands, padTo, resetRowIds, spec } from "./fixtures";
import { validateDeck } from "./engine";
import {
  colorIdentityIssues,
  commanderIdentity,
  commanderIneligibility,
  identityOf,
  validateCommanderZone,
} from "./commanders";

/**
 * Every fixture below is a **real printing**, its type line, oracle text, power/toughness
 * and colour identity copied out of the card database this app syncs (probed read-only on
 * 2026-08-05). A reviewer can check any of them against Scryfall, which is the point: the
 * commander rules are a pile of special cases, and a paraphrased fixture proves nothing
 * about the special case it is standing in for.
 */

beforeEach(resetRowIds);

/** A card in the command zone, so a test's subject is the first thing it says. */
function inZone(overrides: Partial<CardFacts>): CardFacts {
  return card({ zone: "commander", ...overrides });
}

/** A legality blob that answers one format one way and every other format `legal`. */
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

// --- the cards ---------------------------------------------------------------------------

/** `Creature — Bear`, common, never printed at uncommon. Not legendary, so not a commander
 *  anywhere except Pauper Commander — where its rarity refuses it instead. */
const GRIZZLY_BEARS = inZone({
  name: "Grizzly Bears",
  typeLine: "Creature — Bear",
  manaCost: "{1}{G}",
  cmc: 2,
  power: "2",
  toughness: "2",
  colors: "G",
  colorIdentity: "G",
});

/** CR 903.3's 2026 clause, the passing half: a legendary Vehicle **with** a P/T box. */
const SHORIKAI = inZone({
  name: "Shorikai, Genesis Engine",
  typeLine: "Legendary Artifact — Vehicle",
  manaCost: "{2}{W}{U}",
  cmc: 4,
  power: "8",
  toughness: "8",
  colors: "UW",
  colorIdentity: "UW",
});

/** The failing half, and it is a real card rather than a hypothetical: a legendary
 *  Spacecraft that never becomes a creature, so it has no printed power or toughness. */
const ETERNITY_ELEVATOR = inZone({
  name: "The Eternity Elevator",
  typeLine: "Legendary Artifact — Spacecraft",
  manaCost: "{5}",
  cmc: 5,
  power: null,
  toughness: null,
  colors: "",
  colorIdentity: "",
});

/**
 * A legendary Spacecraft that does have one — `Station` turns it into a creature at 7+.
 *
 * A pure **eligibility** fixture: live, this printing is `commander: not_legal`, so a real
 * deck would hear about it from the pool check instead. The blob here is the fixtures' own
 * all-legal one, because what is under test is CR 903.3 and not a card pool.
 */
const ENTERPRISE_D = inZone({
  name: "U.S.S. Enterprise-D, Galaxy-Class",
  typeLine: "Legendary Artifact — Spacecraft",
  manaCost: "{3}",
  cmc: 3,
  power: "4",
  toughness: "5",
  colors: "",
  colorIdentity: "",
});

/**
 * The card FINDING 2 turns on: a legendary Spacecraft that Tiny Leaders: Reborn's own list
 * admits (`tlr: legal`), mana value 3 so it clears the format's ceiling, 5/5 so it clears
 * CR 903.3. Refusing it would be an error about a card the format allows.
 */
const THE_SERIEMA = inZone({
  name: "The Seriema",
  typeLine: "Legendary Artifact — Spacecraft",
  manaCost: "{1}{W}{W}",
  cmc: 3,
  power: "5",
  toughness: "5",
  colors: "W",
  colorIdentity: "W",
});

/** One of the 32 cards that say so in their own rules text. */
const TEFERI_TEMPORAL_ARCHMAGE = inZone({
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
});

/** A legendary planeswalker that says nothing of the sort: CR 903.12c's whole point. */
const TEFERI_HERO_OF_DOMINARIA = inZone({
  name: "Teferi, Hero of Dominaria",
  typeLine: "Legendary Planeswalker — Teferi",
  manaCost: "{3}{W}{U}",
  cmc: 5,
  colors: "UW",
  colorIdentity: "UW",
  oracleText:
    "+1: Draw a card. At the beginning of the next end step, untap up to two lands.\n" +
    "−3: Put target nonland permanent into its owner's library third from the top.",
});

/**
 * A transform card, and the reason `frontFace` exists. Scryfall's top-level `type_line` is
 * both halves joined and its top-level `oracle_text` is absent entirely; only `card_faces[0]`
 * says what the front of the card is. The back is a planeswalker, which would be the wrong
 * answer in Commander.
 */
const JACE_VRYNS_PRODIGY = inZone({
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
});

/**
 * TRAP C, exactly as the research doc records it: printed at uncommon (so it is a legal
 * Pauper Commander commander) and `paupercommander: not_legal` (because that key answers
 * for the 99, which are commons). The contradiction is on one card, on purpose.
 */
const PARADISE_DRUID = inZone({
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
});

/** TRAP A's second meaning: `duel: restricted` is *banned as a commander*. */
const EDRIC = inZone({
  name: "Edric, Spymaster of Trest",
  typeLine: "Legendary Creature — Elf Rogue",
  manaCost: "{1}{G}{U}",
  cmc: 3,
  power: "2",
  toughness: "2",
  colors: "GU",
  colorIdentity: "GU",
  legalities: legalExcept("duel", "restricted"),
});

/** The same semantic under Tiny Leaders: Reborn, which is the other format that uses it. */
const ROFELLOS = inZone({
  name: "Rofellos, Llanowar Emissary",
  typeLine: "Legendary Creature — Elf Druid",
  manaCost: "{G}{G}",
  cmc: 2,
  power: "2",
  toughness: "1",
  colors: "G",
  colorIdentity: "G",
  legalities: legalExcept("tlr", "restricted"),
});

const PARTNER_REMINDER = " (You can have two commanders if both have partner.)";

const ISHAI = inZone({
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
});

const VIAL_SMASHER = inZone({
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
});

/** Mutual "Partner with", and the pair prints it **both ways**: Nikara carries the reminder
 *  text, Yannik does not. One regex has to read both. */
const NIKARA = inZone({
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
});

const YANNIK = inZone({
  name: "Yannik, Scavenging Sentinel",
  typeLine: "Legendary Creature — Hyena Beast",
  manaCost: "{2}{G}{W}",
  cmc: 4,
  power: "3",
  toughness: "3",
  colors: "GW",
  colorIdentity: "GW",
  oracleText: "Partner with Nikara, Lair Scavenger\nVigilance",
});

/**
 * The pair that proves the front-face merge is load-bearing rather than tidy.
 *
 * These are the Secret Lair **reversible** printings: `card_row` hoists `type_line` and P/T
 * from `card_faces[0]`, but it does **not** hoist `oracle_text`, so the partner ability
 * exists only inside `faces`. Their printed names are joined (`"Okaun // Okaun"`) while the
 * partner line names the front half, so this fixture also pins the name split.
 */
const OKAUN = inZone({
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
});

const ZNDRSPLT = inZone({
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
});

const KRAV = inZone({
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
});

const VARIANT_REMINDER = " (You can have two commanders if both have this ability.)";

const WERNOG = inZone({
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
});

const ELMAR = inZone({
  name: "Elmar, Ulvenwald Informant",
  typeLine: "Legendary Creature — Human",
  manaCost: "{1}{R}{G}",
  cmc: 3,
  power: "3",
  toughness: "2",
  colors: "GR",
  colorIdentity: "GR",
  oracleText: "Haste\nPartner—Friends forever" + VARIANT_REMINDER,
});

/** A different variant text, printed the same way — 702.124f says these never mix. */
const SPLINTER = inZone({
  name: "Splinter, the Mentor",
  typeLine: "Legendary Creature — Mutant Ninja Rat",
  manaCost: "{1}{B}",
  cmc: 2,
  power: "2",
  toughness: "2",
  colors: "B",
  colorIdentity: "B",
  oracleText: "Menace\nPartner—Character select" + VARIANT_REMINDER,
});

const LULU = inZone({
  name: "Lulu, Loyal Hollyphant",
  typeLine: "Legendary Creature — Elephant Angel",
  manaCost: "{3}{W}",
  cmc: 4,
  power: "3",
  toughness: "2",
  colors: "W",
  colorIdentity: "W",
  oracleText: "Flying\nChoose a Background (You can have a Background as a second commander.)",
});

const FAR_TRAVELER = inZone({
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
});

const HAUNTED_ONE = inZone({
  name: "Haunted One",
  typeLine: "Legendary Enchantment — Background",
  manaCost: "{2}{B}",
  cmc: 3,
  power: null,
  toughness: null,
  colors: "B",
  colorIdentity: "B",
  oracleText: 'Commander creatures you own have "Menace."',
});

const DOCTORS_COMPANION_REMINDER = " (You can have two commanders if the other is the Doctor.)";

const ROSE_TYLER = inZone({
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
});

const TENTH_DOCTOR = inZone({
  name: "The Tenth Doctor",
  typeLine: "Legendary Creature — Time Lord Doctor",
  manaCost: "{3}{U}{R}",
  cmc: 5,
  power: "3",
  toughness: "5",
  colors: "RU",
  colorIdentity: "RU",
  oracleText: "Allons-y! — Whenever you attack, exile cards from the top of your library.",
});

/** A Time Lord who is **not** the Doctor, and who carries Doctor's companion herself. The
 *  research doc's "and no other creature types" is what tells these two apart. */
const SUSAN_FOREMAN = inZone({
  name: "Susan Foreman",
  typeLine: "Legendary Creature — Time Lord",
  manaCost: "{1}{G}",
  cmc: 2,
  power: "1",
  toughness: "1",
  colors: "G",
  colorIdentity: "G",
  oracleText: "{T}: Add {G}.\nDoctor's companion" + DOCTORS_COMPANION_REMINDER,
});

const NAHIRI = inZone({
  name: "Nahiri, the Lithomancer",
  typeLine: "Legendary Planeswalker — Nahiri",
  manaCost: "{3}{W}{W}",
  cmc: 5,
  colors: "W",
  colorIdentity: "W",
  oracleText:
    "+2: Create a 1/1 white Kor Soldier creature token.\n" +
    "Nahiri, the Lithomancer can be your commander.",
});

/**
 * The staple partner pair of the Oathbreaker format, and the reason its zone is not capped at
 * one planeswalker. Both print plain `Partner` as the **last line, with no reminder text and
 * no trailing newline** — which is also the tightest case the line-anchored regex has to read.
 * Combined identity BR.
 */
const TEVESH_SZAT = inZone({
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
});

const JESKA_THRICE_REBORN = inZone({
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
});

const DARK_RITUAL = inZone({
  name: "Dark Ritual",
  typeLine: "Instant",
  manaCost: "{B}",
  cmc: 1,
  colors: "B",
  colorIdentity: "B",
  oracleText: "Add {B}{B}{B}.",
});

const PATH_TO_EXILE = inZone({
  name: "Path to Exile",
  typeLine: "Instant",
  manaCost: "{W}",
  cmc: 1,
  colors: "W",
  colorIdentity: "W",
  oracleText: "Exile target creature. Its controller may search their library for a basic land.",
});

const SWORDS_TO_PLOWSHARES = inZone({
  name: "Swords to Plowshares",
  typeLine: "Instant",
  manaCost: "{W}",
  cmc: 1,
  colors: "W",
  colorIdentity: "W",
  rarity: "uncommon",
  everUncommon: true,
  oracleText: "Exile target creature. Its controller gains life equal to its power.",
});

/** `card()`'s default is Lightning Bolt: an `Instant`, mono-red, colour identity R. */
const BOLT_IN_ZONE = inZone({});

const AZORIUS_CHARM = card({
  name: "Azorius Charm",
  typeLine: "Instant",
  manaCost: "{W}{U}",
  cmc: 2,
  colors: "UW",
  colorIdentity: "UW",
});

/** 903.5d in one fixture: no mana symbol appears anywhere on Taiga, and its colour identity
 *  is RG all the same — from its basic land **types**. Scryfall already folded that in, so
 *  the subset test needs no land-specific code. */
const TAIGA = card({
  name: "Taiga",
  typeLine: "Land — Mountain Forest",
  manaCost: null,
  cmc: 0,
  colors: "",
  colorIdentity: "GR",
  oracleText: "({T}: Add {R} or {G}.)",
});

const SOL_RING = card({
  name: "Sol Ring",
  typeLine: "Artifact",
  manaCost: "{1}",
  cmc: 1,
  colors: "",
  colorIdentity: "",
});

const KOZILEK = inZone({
  name: "Kozilek, Butcher of Truth",
  typeLine: "Legendary Creature — Eldrazi",
  manaCost: "{10}",
  cmc: 10,
  power: "12",
  toughness: "12",
  colors: "",
  colorIdentity: "",
});

// -----------------------------------------------------------------------------------------

const EDH_REQUIREMENT =
  "a commander must be a legendary creature, a legendary Vehicle or Spacecraft with a power " +
  "and toughness, or a card that says it can be your commander";

/** A failed pairing often arrives beside an eligibility complaint about one of the cards, so
 *  the pairing sentence is read by code rather than by index. */
function pairingMessage(issues: ValidationIssue[]): string | undefined {
  return issues.find((i) => i.code === "commander-partner")?.message;
}

describe("eligibility by rule", () => {
  it("takes a legendary creature and refuses one that is not legendary (edh)", () => {
    expect(commanderIneligibility(commander(), "edh", spec("commander"))).toBeNull();
    expect(commanderIneligibility(GRIZZLY_BEARS, "edh", spec("commander"))).toBe(
      `Grizzly Bears is not a legal commander in Commander: ${EDH_REQUIREMENT}.`,
    );
  });

  /** CR 903.3, 2026: a legendary Vehicle or Spacecraft is a commander **if it has a power
   *  and toughness**. Both halves are real cards; the P/T columns exist for this line. */
  it("reads the 2026 Vehicle and Spacecraft clause off the printed power and toughness", () => {
    expect(commanderIneligibility(SHORIKAI, "edh", spec("commander"))).toBeNull();
    expect(commanderIneligibility(ENTERPRISE_D, "edh", spec("commander"))).toBeNull();
    expect(commanderIneligibility(ETERNITY_ELEVATOR, "edh", spec("commander"))).toBe(
      "The Eternity Elevator has no power and toughness, so it cannot be your commander in " +
        "Commander; a legendary Spacecraft needs one.",
    );
  });

  it("takes a card that says it can be your commander, whatever else it is", () => {
    expect(commanderIneligibility(TEFERI_TEMPORAL_ARCHMAGE, "edh", spec("commander"))).toBeNull();
    // The same card type without the sentence is not a commander in EDH.
    expect(commanderIneligibility(TEFERI_HERO_OF_DOMINARIA, "edh", spec("commander"))).toBe(
      `Teferi, Hero of Dominaria is not a legal commander in Commander: ${EDH_REQUIREMENT}.`,
    );
  });

  /** The front face decides. Read the joined `type_line` instead and this card is half a
   *  planeswalker; read `card_faces[0]` and it is the legendary creature it is. */
  it("judges a double-faced card by its front face", () => {
    expect(commanderIneligibility(JACE_VRYNS_PRODIGY, "edh", spec("commander"))).toBeNull();
  });

  /** CR 903.12c is broader than EDH: any legendary planeswalker will do. */
  it("adds legendary planeswalkers in brawl", () => {
    expect(commanderIneligibility(TEFERI_HERO_OF_DOMINARIA, "brawl", spec("brawl"))).toBeNull();
    expect(commanderIneligibility(commander(), "brawl", spec("brawl"))).toBeNull();
    expect(commanderIneligibility(GRIZZLY_BEARS, "brawl", spec("brawl"))).toContain(
      "is not a legal commander in Brawl",
    );
  });

  it("takes only a planeswalker in oathbreaker", () => {
    expect(commanderIneligibility(NAHIRI, "oathbreaker", spec("oathbreaker"))).toBeNull();
    expect(commanderIneligibility(commander(), "oathbreaker", spec("oathbreaker"))).toBe(
      "Kenrith, the Returned King is not a legal oathbreaker in Oathbreaker: an oathbreaker " +
        "must be a planeswalker.",
    );
  });

  /**
   * TRAP C. Pauper Commander's commander is judged by **rarity**, not by the
   * `paupercommander` legality key — that key answers for the 99, so every uncommon reads
   * `not_legal` there. Paradise Druid carries exactly that contradiction, and it is a legal
   * commander. Legendary is not required either.
   */
  it("judges a pauper commander by rarity, not by the paupercommander key", () => {
    expect(PARADISE_DRUID.legalities).toContain('"paupercommander":"not_legal"');
    expect(commanderIneligibility(PARADISE_DRUID, "pdh", spec("paupercommander"))).toBeNull();

    expect(commanderIneligibility(GRIZZLY_BEARS, "pdh", spec("paupercommander"))).toBe(
      "Grizzly Bears has never been printed at uncommon, so it cannot be your commander in " +
        "Pauper Commander.",
    );
    // Uncommon, but not a creature: the type rule still applies.
    expect(commanderIneligibility(SWORDS_TO_PLOWSHARES, "pdh", spec("paupercommander"))).toBe(
      "Swords to Plowshares is not a legal commander in Pauper Commander: a commander must be " +
        "a creature, Vehicle or Spacecraft that has been printed at uncommon.",
    );
    // The P/T clause reaches Pauper Commander too — **without** the word "legendary", which
    // this format has never asked for and which the sentence would otherwise invent.
    expect(commanderIneligibility(ETERNITY_ELEVATOR, "pdh", spec("paupercommander"))).toBe(
      "The Eternity Elevator has no power and toughness, so it cannot be your commander in " +
        "Pauper Commander; a Spacecraft needs one.",
    );
  });

  /**
   * Tiny Leaders: Reborn takes planeswalkers like Brawl and Vehicles like EDH — **and
   * Spacecraft**, even though the research doc's cell stops at "Vehicle". The pool settles it:
   * The Seriema is `tlr: legal`, mana value 3 and 5/5, so the strict reading would refuse a
   * card the format's own list admits. The doc's omission is terseness, not a rule.
   */
  it("takes creatures, planeswalkers, Vehicles and Spacecraft in tiny leaders", () => {
    expect(commanderIneligibility(TEFERI_HERO_OF_DOMINARIA, "tlr", spec("tlr"))).toBeNull();
    expect(commanderIneligibility(SHORIKAI, "tlr", spec("tlr"))).toBeNull();
    expect(commanderIneligibility(THE_SERIEMA, "tlr", spec("tlr"))).toBeNull();
    // The P/T clause still applies, and so does the legendary one.
    expect(commanderIneligibility(ETERNITY_ELEVATOR, "tlr", spec("tlr"))).toContain(
      "has no power and toughness",
    );
    expect(commanderIneligibility(GRIZZLY_BEARS, "tlr", spec("tlr"))).toContain(
      "is not a legal commander in Tiny Leaders: Reborn",
    );
  });

  /** A row whose printing left the card database has no type line to judge. It already has
   *  the reconciler's warning; a guess on top of it would be a second, wrong sentence. */
  it("says nothing about an orphaned row", () => {
    const orphan = inZone({
      name: "Ancient Tomb",
      oracleId: null,
      typeLine: null,
      oracleText: null,
      cmc: null,
      manaCost: null,
      colorIdentity: null,
      legalities: null,
      layout: null,
      rarity: null,
    });

    expect(commanderIneligibility(orphan, "edh", spec("commander"))).toBeNull();
  });
});

describe("partners and pairing (702.124)", () => {
  const zone = (a: CardFacts, b: CardFacts) => validateCommanderZone([a, b], spec("commander"));

  it("takes two commanders that both have partner, and refuses one that does not", () => {
    expect(zone(ISHAI, VIAL_SMASHER)).toEqual([]);

    expect(zone(ISHAI, commander())).toEqual([
      {
        severity: "error",
        code: "commander-partner",
        message:
          "Ishai, Ojutai Dragonspeaker has partner, but Kenrith, the Returned King has no " +
          "partner ability; a second commander needs one.",
        cardIds: ["c-Ishai, Ojutai Dragonspeaker", "c-Kenrith, the Returned King"],
      },
    ]);
  });

  /** 702.124g: two is the ceiling, whatever abilities they have. */
  it("refuses a third commander", () => {
    const issues = validateCommanderZone([ISHAI, VIAL_SMASHER, KOZILEK], spec("commander"));

    expect(issues).toEqual([
      {
        severity: "error",
        code: "commander-count",
        message:
          "Commander decks have at most two commanders, and only with a partner ability; you " +
          "have 3.",
      },
    ]);
  });

  /** "Partner with" names a card, and the naming is mutual — one printing carries the
   *  reminder text and the other does not, which is why the name is parsed rather than
   *  the whole line matched. */
  it("requires the card that Partner with names, both ways", () => {
    expect(zone(NIKARA, YANNIK)).toEqual([]);

    expect(zone(NIKARA, KRAV)).toEqual([
      {
        severity: "error",
        code: "commander-partner",
        message:
          "Nikara, Lair Scavenger partners only with Yannik, Scavenging Sentinel; Krav, the " +
          "Unredeemed is not that card.",
        cardIds: ["c-Nikara, Lair Scavenger", "c-Krav, the Unredeemed"],
      },
    ]);
  });

  /**
   * The whole ability can live inside `card_faces`. `card_row` hoists a reversible card's
   * type line and P/T from face 0 but **not** its oracle text, so a partner keyword read off
   * the row itself is not there at all — and the printed name it points at is the front
   * half of a joined `"X // X"` name.
   */
  it("reads a partner ability that lives only on the front face", () => {
    expect(OKAUN.oracleText).toBeNull();
    expect(ZNDRSPLT.name).toBe("Zndrsplt, Eye of Wisdom // Zndrsplt, Eye of Wisdom");

    expect(zone(OKAUN, ZNDRSPLT)).toEqual([]);
  });

  /**
   * 702.124e's naming is mutual and no printed card is one-sided, so this row is **built**
   * rather than copied: Yannik's name carrying Krav's partner line. A one-way check pairs it
   * because Nikara names Yannik; the rule does not, because Yannik names Regna.
   */
  it("refuses a Partner with that only one of the two names", () => {
    const impostor = inZone({
      ...YANNIK,
      cardId: "c-impostor",
      oracleText: "Partner with Regna, the Redeemer\nVigilance",
    });

    expect(pairingMessage(zone(NIKARA, impostor))).toBe(
      "Yannik, Scavenging Sentinel partners only with Regna, the Redeemer; Nikara, Lair " +
        "Scavenger is not that card.",
    );
  });

  /** 702.124f: a partner variant pairs with its own text and with nothing else — not with
   *  another variant, and not with plain partner. */
  it("pairs a partner variant only with the same variant", () => {
    expect(zone(WERNOG, ELMAR)).toEqual([]);

    expect(pairingMessage(zone(WERNOG, SPLINTER))).toBe(
      "Wernog, Rider's Chaplain has partner—Friends forever and Splinter, the Mentor has " +
        "partner—Character select; two commanders must share one partner ability.",
    );
    expect(pairingMessage(zone(WERNOG, ISHAI))).toBe(
      "Wernog, Rider's Chaplain has partner—Friends forever and Ishai, Ojutai " +
        "Dragonspeaker has partner; two commanders must share one partner ability.",
    );
  });

  it("pairs Choose a Background with a legendary Background and nothing else", () => {
    expect(zone(LULU, FAR_TRAVELER)).toEqual([]);

    // **One** finding, not three: each Background's own "is a Background" refusal says exactly
    // what the pairing sentence already said, so the pairing covers them.
    expect(zone(FAR_TRAVELER, HAUNTED_ONE)).toEqual([
      {
        severity: "error",
        code: "commander-partner",
        message:
          "Far Traveler and Haunted One are both Backgrounds; a Background is a second " +
          'commander beside a card that says "Choose a Background".',
        cardIds: ["c-Far Traveler", "c-Haunted One"],
      },
    ]);
    expect(pairingMessage(zone(LULU, commander()))).toBe(
      'Lulu, Loyal Hollyphant says "Choose a Background", so the other commander must be a ' +
        "legendary Background; Kenrith, the Returned King is not one.",
    );
  });

  /** The covering is narrow on purpose. A pairing failure beside an *unrelated* eligibility
   *  problem is two true sentences, and the reader needs both. */
  it("still reports an eligibility problem the pairing sentence does not cover", () => {
    expect(zone(GRIZZLY_BEARS, KOZILEK).map((i) => i.code)).toEqual([
      "commander-eligibility",
      "commander-partner",
    ]);
  });

  /** A Background is not a creature, so CR 903.3 refuses it — the pairing is what makes it
   *  legal, and a Background on its own is told exactly that. */
  it("lets a Background be a second commander and never a lone one", () => {
    expect(validateCommanderZone([FAR_TRAVELER], spec("commander"))).toEqual([
      {
        severity: "error",
        code: "commander-eligibility",
        message:
          "Far Traveler is a Background, so it can only be a second commander beside a card " +
          'that says "Choose a Background".',
        cardIds: ["c-Far Traveler"],
      },
    ]);
  });

  /** The Doctor is a legendary creature whose only creature types are Time Lord and Doctor.
   *  Susan Foreman is a Time Lord and not the Doctor, and she carries the companion ability
   *  herself — two companions are not a pair. */
  it("pairs Doctor's companion with a legendary Time Lord Doctor", () => {
    expect(zone(ROSE_TYLER, TENTH_DOCTOR)).toEqual([]);

    expect(pairingMessage(zone(ROSE_TYLER, SUSAN_FOREMAN))).toBe(
      "Rose Tyler has Doctor's companion, so the other commander must be a legendary Time Lord " +
        "Doctor; Susan Foreman is not one.",
    );
  });

  it("says so when neither commander has any partner ability", () => {
    expect(pairingMessage(zone(commander(), KOZILEK))).toBe(
      "Kenrith, the Returned King and Kozilek, Butcher of Truth cannot both be commanders; a " +
        "second commander needs a partner ability.",
    );
  });

  /** 702.124c: the deck's colour identity is the **union** of both commanders'. */
  it("combines both commanders' colour identities", () => {
    expect(commanderIdentity([ISHAI, VIAL_SMASHER], spec("commander"))).toEqual(
      new Set(["W", "U", "B", "R"]),
    );
    expect(commanderIdentity([], spec("commander"))).toBeNull();
  });
});

describe("the oathbreaker zone", () => {
  const zone = (...cards: CardFacts[]) => validateCommanderZone(cards, spec("oathbreaker"));

  it("takes a planeswalker and one instant or sorcery", () => {
    expect(zone(NAHIRI, SWORDS_TO_PLOWSHARES)).toEqual([]);
  });

  it("asks for whichever half is missing", () => {
    expect(zone(NAHIRI)).toEqual([
      {
        severity: "error",
        code: "commander-missing",
        message:
          "Oathbreaker decks need a signature spell: one instant or sorcery in the command zone.",
      },
    ]);
    expect(zone(SWORDS_TO_PLOWSHARES)).toEqual([
      {
        severity: "error",
        code: "commander-missing",
        message: "Oathbreaker decks need an oathbreaker: one planeswalker in the command zone.",
      },
    ]);
    expect(zone()).toEqual([
      {
        severity: "error",
        code: "commander-missing",
        message:
          "Oathbreaker decks need an oathbreaker and a signature spell; the commander zone is " +
          "empty.",
      },
    ]);
  });

  /** The signature spell must fit inside the oathbreaker's identity, and it never widens
   *  it — which is the one place a command-zone card is judged against another. */
  it("holds the signature spell to the oathbreaker's colour identity", () => {
    expect(zone(NAHIRI, BOLT_IN_ZONE)).toEqual([
      {
        severity: "error",
        code: "color-identity",
        message:
          "Lightning Bolt's color identity (R) is outside your oathbreaker's (W); a signature " +
          "spell must fit inside it.",
        cardIds: ["c-Lightning Bolt"],
      },
    ]);
    expect(commanderIdentity([NAHIRI, BOLT_IN_ZONE], spec("oathbreaker"))).toEqual(new Set(["W"]));
  });

  it("refuses a second signature spell and a card that is neither", () => {
    expect(zone(NAHIRI, SWORDS_TO_PLOWSHARES, BOLT_IN_ZONE)).toContainEqual({
      severity: "error",
      code: "commander-count",
      message: "Oathbreaker decks have one signature spell; you have 2.",
    });
    expect(zone(NAHIRI, SWORDS_TO_PLOWSHARES, commander())[0]).toMatchObject({
      code: "commander-eligibility",
      message:
        "Kenrith, the Returned King is not a legal oathbreaker in Oathbreaker: an oathbreaker " +
        "must be a planeswalker.",
    });
  });

  /**
   * The format allows **two** oathbreakers when the planeswalkers partner, and then two
   * signature spells — one each. Tevesh Szat + Jeska, Thrice Reborn is the staple pairing, and
   * refusing it was two confident wrong sentences about a real deck.
   */
  it("takes a partner pair of oathbreakers with one signature spell each", () => {
    expect(zone(TEVESH_SZAT, JESKA_THRICE_REBORN, DARK_RITUAL, BOLT_IN_ZONE)).toEqual([]);

    // One each, and no more: the cap is per oathbreaker, not a flat two.
    expect(
      zone(TEVESH_SZAT, JESKA_THRICE_REBORN, DARK_RITUAL, BOLT_IN_ZONE, {
        ...DARK_RITUAL,
        cardId: "c-Dark Ritual 2",
      }),
    ).toContainEqual({
      severity: "error",
      code: "commander-count",
      message:
        "Oathbreaker decks have one signature spell for each oathbreaker and at most two " +
        "oathbreakers, so at most two; you have 3.",
    });
  });

  /**
   * Above two oathbreakers the per-walker denominator and the cap come apart, and a sentence
   * that quoted the walker count would read "you have 3 for 3 oathbreakers" — a rule stated in
   * numbers that keep it. The zone gets *both* errors, and each has to be true on its own: one
   * says there are too many oathbreakers, the other says how many signature spells the zone can
   * hold at all.
   */
  it("says something true about the spells when there are more oathbreakers than the format allows", () => {
    const issues = zone(TEVESH_SZAT, JESKA_THRICE_REBORN, NAHIRI, DARK_RITUAL, BOLT_IN_ZONE, {
      ...DARK_RITUAL,
      cardId: "c-Dark Ritual 2",
    }).filter((i) => i.code === "commander-count");

    expect(issues.map((i) => i.message)).toEqual([
      "Oathbreaker decks have at most two oathbreakers, and only with a partner ability; you have 3.",
      "Oathbreaker decks have one signature spell for each oathbreaker and at most two " +
        "oathbreakers, so at most two; you have 3.",
    ]);
  });

  /** The same CR 702.124 machinery as the commander zone, so an unpartnered second
   *  oathbreaker gets the sentence it would get anywhere else. */
  it("refuses two oathbreakers that do not partner, and a third whatever they have", () => {
    expect(pairingMessage(zone(TEVESH_SZAT, NAHIRI, DARK_RITUAL))).toBe(
      "Tevesh Szat, Doom of Fools has partner, but Nahiri, the Lithomancer has no partner " +
        "ability; a second commander needs one.",
    );

    expect(
      zone(TEVESH_SZAT, JESKA_THRICE_REBORN, NAHIRI, DARK_RITUAL).map((i) => i.code),
    ).toContain("commander-count");
  });

  /**
   * The identity check is **outside** the walker-count branches on purpose: with two
   * oathbreakers it is the combined identity that each signature spell has to fit inside, and
   * switching the rule off for partner decks is the failure that hides.
   *
   * The combining is this app's permissive reading, not the format's rule — Oathbreaker pairs
   * each spell with its own oathbreaker and a zone-level check has no such assignment to read
   * (`unionIdentity`). What is pinned here is that the check still *runs* for a pair.
   */
  it("holds each signature spell to the combined identity of a partner pair", () => {
    expect(zone(TEVESH_SZAT, JESKA_THRICE_REBORN, PATH_TO_EXILE)).toContainEqual({
      severity: "error",
      code: "color-identity",
      message:
        "Path to Exile's color identity (W) is outside your oathbreakers' (BR); a signature " +
        "spell must fit inside it.",
      cardIds: ["c-Path to Exile"],
    });
    expect(commanderIdentity([TEVESH_SZAT, JESKA_THRICE_REBORN], spec("oathbreaker"))).toEqual(
      new Set(["B", "R"]),
    );
  });
});

describe("banned as a commander (TRAP A's second meaning)", () => {
  it("refuses a duel-restricted card in the commander zone and nowhere else", () => {
    expect(validateCommanderZone([EDRIC], spec("duel"))).toEqual([
      {
        severity: "error",
        code: "commander-banned",
        message: "Edric, Spymaster of Trest is banned as a commander in Duel Commander.",
        cardIds: ["c-Edric, Spymaster of Trest"],
      },
    ]);

    // The same card in the main deck of the same format is silent — Task 8 proved the
    // legality pass stays quiet, and the commander pass never sees it.
    const inMain = padTo(100, [commander(), { ...EDRIC, zone: "main" as const }]);
    expect(validateDeck(inMain, spec("duel"))).toEqual([]);
  });

  it("reads the same semantic in tiny leaders", () => {
    expect(validateCommanderZone([ROFELLOS], spec("tlr"))[0]).toMatchObject({
      code: "commander-banned",
      message: "Rofellos, Llanowar Emissary is banned as a commander in Tiny Leaders: Reborn.",
    });
  });

  /** Vintage's `restricted` is a copy limit, so a restricted card in a Vintage-style
   *  commander zone is not a commander complaint at all. */
  it("says nothing where restricted means max one copy", () => {
    const restrictedInEdh = inZone({
      ...commander(),
      legalities: legalExcept("commander", "restricted"),
    });

    expect(validateCommanderZone([restrictedInEdh], spec("commander"))).toEqual([]);
  });
});

describe("colour identity (903.5c/d via Scryfall's field)", () => {
  it("reads the concatenated letters, never JSON", () => {
    expect(identityOf(AZORIUS_CHARM)).toEqual(new Set(["U", "W"]));
    expect(identityOf(SOL_RING)).toEqual(new Set());
    expect(identityOf(card({ colorIdentity: null }))).toEqual(new Set());
  });

  it("refuses a card whose identity is not inside the commander's", () => {
    expect(colorIdentityIssues([AZORIUS_CHARM], new Set(["W"]))).toEqual([
      {
        severity: "error",
        code: "color-identity",
        message: "Azorius Charm's color identity (WU) is outside your commander's (W).",
        cardIds: ["c-Azorius Charm"],
      },
    ]);
    expect(colorIdentityIssues([AZORIUS_CHARM], new Set(["W", "U", "B"]))).toEqual([]);
  });

  /** 903.5d rides the same field: Taiga prints no mana symbol anywhere and its identity is
   *  RG from its land types. No land-specific code is involved, and none should be. */
  it("catches a dual land under a mono-coloured commander with no land rule of its own", () => {
    expect(colorIdentityIssues([TAIGA], new Set(["G"]))[0].message).toBe(
      "Taiga's color identity (RG) is outside your commander's (G).",
    );
    expect(colorIdentityIssues([TAIGA], new Set(["R", "G"]))).toEqual([]);
  });

  it("lets colourless cards into any deck and only colourless cards under a colourless commander", () => {
    expect(colorIdentityIssues([SOL_RING], new Set(["W"]))).toEqual([]);
    expect(colorIdentityIssues([SOL_RING], new Set())).toEqual([]);
    expect(colorIdentityIssues([card()], new Set())[0].message).toBe(
      "Lightning Bolt's color identity (R) is outside your commander's (colorless).",
    );
  });
});

describe("in the engine", () => {
  it("needs a commander in a format that requires one", () => {
    expect(validateDeck(padTo(100, []), spec("commander"))).toEqual([
      {
        severity: "error",
        code: "commander-missing",
        message: "Commander decks need a commander; the commander zone is empty.",
      },
    ]);
  });

  it("holds the whole deck to the commander's colour identity", () => {
    const deck = padTo(100, [ISHAI, TAIGA]);

    expect(validateDeck(deck, spec("commander"))).toEqual([
      {
        severity: "error",
        code: "color-identity",
        message: "Taiga's color identity (RG) is outside your commander's (WU).",
        cardIds: ["c-Taiga"],
      },
    ]);
  });

  /** TRAP C end to end: the `paupercommander` key says `not_legal` about the commander, and
   *  the deck is clean — the key answers for the 99, and the commander is judged by rarity. */
  it("does not report a pauper commander as illegal in its own format", () => {
    const forests = card({
      name: "Forest",
      typeLine: "Basic Land — Forest",
      manaCost: null,
      cmc: 0,
      colors: null,
      colorIdentity: "G",
      quantity: 98,
    });
    const petal = card({
      name: "Lotus Petal",
      typeLine: "Artifact",
      colors: "",
      colorIdentity: "",
    });

    expect(validateDeck([PARADISE_DRUID, petal, forests], spec("paupercommander"))).toEqual([]);
  });

  /** A commander in a format that has no commander zone is a card in the wrong pile. */
  it("says so when a format has no commander at all", () => {
    expect(validateDeck(padTo(60, [commander()]), spec("modern"))).toEqual([
      {
        severity: "error",
        code: "commander-zone",
        message:
          "Modern decks have no commander; move Kenrith, the Returned King to the main deck.",
        cardIds: ["c-Kenrith, the Returned King"],
      },
    ]);
  });

  it("leaves a deck with no commander zone and no commander rule alone", () => {
    expect(validateDeck([islands(60)], spec("modern"))).toEqual([]);
    expect(validateDeck([], spec("casual"))).toEqual([]);
  });
});
