import { beforeEach, describe, expect, it } from "vitest";
import type { DeckCombo } from "@/lib/ipc";
import { card, gameChanger, islands, resetRowIds } from "./fixtures";
import { bracketWarning, describeReason, estimateBracket } from "./bracket";
import type { CardFacts } from "./types";

/**
 * The bracket estimate is an **advisory**, and these tests are written to say so: they assert
 * the *shape* of the reading — which rule fired, which cards are behind it, that the floor
 * moves in the right direction — as well as the digit, because since the October 2025 rewrite
 * the digit is a **floor** with a rule behind every rung and is therefore worth pinning.
 *
 * Every card fixture is a real printing, probed read-only out of the local card database on
 * 2026-08-05, and the `gameChanger: true` rows come from `fixtures.ts`'s `GAME_CHANGERS`.
 *
 * **The `bracketTag` on every combo below is the test's input and not a claim about
 * Spellbook's classification of that particular combo.** The card pairs are real so a failure
 * message reads like Magic; the letter beside them is whichever rung the test is about. What
 * this app promises is that a letter maps to a floor, never that a given combo carries a given
 * letter — that is Commander Spellbook's editors' call and arrives in the bulk file.
 */

beforeEach(() => {
  resetRowIds();
  nextCombo = 1;
});

let nextCombo = 1;

/**
 * One row of `combos_for_cards`, as Task B's read answers it.
 *
 * Local rather than in `fixtures.ts` because a combo is not a card fact: nothing else in
 * `validation/` takes one, and the shared fixture file is the mirror of `DeckCard` and the
 * `format_specs` seed. A second builder there would be a second thing to keep in step with an
 * IPC shape that only this module reads.
 */
function combo(overrides: Partial<DeckCombo> = {}): DeckCombo {
  return {
    id: `v-${nextCombo++}`,
    bracketTag: "C",
    cards: ["Basalt Monolith", "Rings of Brighthearth"],
    templateCount: 0,
    produces: "Infinite colorless mana",
    popularity: 4200,
    ...overrides,
  };
}

/** Mass land denial, as printed. `Destroy all lands.` is the phrase; the other three are why
 *  the check reads a sentence rather than that phrase. */
const ARMAGEDDON = card({
  name: "Armageddon",
  manaCost: "{3}{W}",
  cmc: 4,
  typeLine: "Sorcery",
  oracleText: "Destroy all lands.",
  colors: "W",
  colorIdentity: "W",
});

const JOKULHAUPS = card({
  name: "Jokulhaups",
  manaCost: "{4}{R}{R}",
  cmc: 6,
  typeLine: "Sorcery",
  oracleText: "Destroy all artifacts, creatures, and lands. They can't be regenerated.",
  colors: "R",
  colorIdentity: "R",
});

const RUINATION = card({
  name: "Ruination",
  manaCost: "{3}{R}",
  cmc: 4,
  typeLine: "Sorcery",
  oracleText: "Destroy all nonbasic lands.",
  colors: "R",
  colorIdentity: "R",
});

const WILDFIRE = card({
  name: "Wildfire",
  manaCost: "{4}{R}{R}",
  cmc: 6,
  typeLine: "Sorcery",
  oracleText:
    "Each player sacrifices four lands of their choice. Wildfire deals 4 damage to each creature.",
  colors: "R",
  colorIdentity: "R",
});

const TIME_WARP = card({
  name: "Time Warp",
  manaCost: "{3}{U}{U}",
  cmc: 5,
  typeLine: "Sorcery",
  oracleText: "Target player takes an extra turn after this one.",
  colors: "U",
  colorIdentity: "U",
});

const NEXUS_OF_FATE = card({
  name: "Nexus of Fate",
  manaCost: "{5}{U}{U}",
  cmc: 7,
  typeLine: "Instant",
  oracleText:
    "Take an extra turn after this one.\nIf Nexus of Fate would be put into a graveyard from " +
    "anywhere, reveal Nexus of Fate and shuffle it into its owner's library instead.",
  colors: "U",
  colorIdentity: "U",
});

/** The third one, which is where this app draws chaining. */
const TEMPORAL_MANIPULATION = card({
  name: "Temporal Manipulation",
  manaCost: "{3}{U}{U}",
  cmc: 5,
  typeLine: "Sorcery",
  oracleText: "Take an extra turn after this one.",
  colors: "U",
  colorIdentity: "U",
});

/** Ramp, not a tutor — and since October 2025 neither one is a signal at all. */
const RAMPANT_GROWTH = card({
  name: "Rampant Growth",
  manaCost: "{1}{G}",
  cmc: 2,
  typeLine: "Sorcery",
  oracleText:
    "Search your library for a basic land card, put that card onto the battlefield tapped, " +
    "then shuffle.",
  colors: "G",
  colorIdentity: "G",
});

/**
 * A tutor for **any** card, and deliberately not flagged as a Game Changer, so a test using it
 * is about the tutor grep that used to exist and nothing else.
 */
const DEMONIC_TUTOR = card({
  name: "Demonic Tutor",
  manaCost: "{1}{B}",
  cmc: 2,
  typeLine: "Sorcery",
  oracleText: "Search your library for a card, put that card into your hand, then shuffle.",
  colors: "B",
  colorIdentity: "B",
  gameChanger: false,
});

/** A vanilla creature, so a deck can be built that flags nothing at all. */
const GRIZZLY_BEARS = card({
  name: "Grizzly Bears",
  manaCost: "{1}{G}",
  cmc: 2,
  typeLine: "Creature — Bear",
  oracleText: "",
  colors: "G",
  colorIdentity: "G",
});

/** The whole reading of a deck that flags nothing, so the base-floor tests assert the shape and
 *  not just the digit — a new field that silently defaults wrong is exactly what a `toEqual`
 *  against this catches. **`floor: 2` since 2026-09-01, and `reasons: []` beside it is the
 *  half that says why**: no rule fired, so the number is the base rather than a reading, and
 *  those two fields have to move together or the estimate is claiming a reason it has not got. */
const NOTHING_FOUND = {
  floor: 2,
  gameChangers: 0,
  gameChangerNames: [],
  massLandDenial: [],
  extraTurns: [],
  combos: [],
  possibleCombos: [],
  reasons: [],
};

describe("the floor", () => {
  it("reads a deck that flags nothing as 2", () => {
    expect(estimateBracket([GRIZZLY_BEARS, RAMPANT_GROWTH, islands(60)])).toEqual(NOTHING_FOUND);
  });

  it("reads an empty deck rather than throwing on one", () => {
    expect(estimateBracket([])).toEqual(NOTHING_FOUND);
  });

  /**
   * **1 is a number this estimator cannot produce, and that is the rule rather than a property
   * of these fixtures** — bracket 1 Exhibition is described by what its builder is *for*
   * ("prioritize a goal, theme, or idea over power"), which no card list shows, exactly as
   * bracket 5 is. So the whole corpus of decks this file builds is swept for the two numbers
   * that may only ever be set by hand.
   */
  it("never answers 1 or 5, whatever it is handed", () => {
    const decks: CardFacts[][] = [
      [],
      [GRIZZLY_BEARS, RAMPANT_GROWTH, islands(60)],
      [DEMONIC_TUTOR, islands(60)],
      [TIME_WARP, islands(60)],
      [ARMAGEDDON, JOKULHAUPS, RUINATION, WILDFIRE],
      [gameChanger("Rhystic Study"), islands(60)],
    ];
    const combos: DeckCombo[][] = [[], [combo({ bracketTag: "E" })], [combo({ bracketTag: "R" })]];

    for (const deck of decks) {
      for (const list of combos) {
        const { floor } = estimateBracket(deck, list);
        expect(floor).toBeGreaterThanOrEqual(2);
        expect(floor).toBeLessThanOrEqual(4);
      }
    }
  });

  /** The document's own numbered cell: bracket 3 allows "up to 3", so one to three of them
   *  bars a deck from 2 and no further. */
  it("reads one to three Game Changers as 3", () => {
    const one = estimateBracket([gameChanger("Rhystic Study"), islands(60)]);
    const three = estimateBracket([
      gameChanger("Rhystic Study"),
      gameChanger("Cyclonic Rift"),
      gameChanger("The One Ring"),
      islands(60),
    ]);

    expect(one.floor).toBe(3);
    expect(three.gameChangers).toBe(3);
    expect(three.floor).toBe(3);
  });

  it("reads a fourth Game Changer as 4", () => {
    const estimate = estimateBracket([
      gameChanger("Rhystic Study"),
      gameChanger("Cyclonic Rift"),
      gameChanger("The One Ring"),
      gameChanger("Ancient Tomb"),
      islands(60),
    ]);

    expect(estimate.gameChangers).toBe(4);
    expect(estimate.floor).toBe(4);
  });

  /**
   * **4 and not 5.** This module mapped any mass land denial to bracket 5 until the October
   * 2025 rewrite, on the argument that a deck playing it had decided something about the
   * table. The current document simply says bracket 4 allows it and bracket 3 does not, and
   * one Armageddon does not make a cEDH deck.
   */
  it("reads mass land denial as 4, not 5", () => {
    const estimate = estimateBracket([ARMAGEDDON, GRIZZLY_BEARS, islands(60)]);

    expect(estimate.gameChangers).toBe(0);
    expect(estimate.floor).toBe(4);
  });

  /** One is what separates bracket 1 from bracket 2 now that tutors do not: bracket 1 forbids
   *  extra turns outright, bracket 2 allows them in low quantities. */
  it("reads a single extra-turn card as 2", () => {
    expect(estimateBracket([TIME_WARP, GRIZZLY_BEARS, islands(60)]).floor).toBe(2);
  });

  it("still reads two extra-turn cards as 2", () => {
    const estimate = estimateBracket([TIME_WARP, NEXUS_OF_FATE, islands(60)]);

    expect(estimate.extraTurns).toEqual(["Time Warp", "Nexus of Fate"]);
    expect(estimate.floor).toBe(2);
  });

  /** **This app's judgement, not the document's.** "Low quantities … not intended to be
   *  chained" is as precise as the real text gets; three is where this app draws chaining. */
  it("reads three extra-turn cards as 4", () => {
    const estimate = estimateBracket([
      TIME_WARP,
      NEXUS_OF_FATE,
      TEMPORAL_MANIPULATION,
      islands(60),
    ]);

    expect(estimate.extraTurns).toHaveLength(3);
    expect(estimate.floor).toBe(4);
  });

  it("takes the highest rung when several fire", () => {
    // 1 Game Changer says 3, one Armageddon says 4.
    const estimate = estimateBracket([gameChanger("Rhystic Study"), ARMAGEDDON, islands(60)]);

    expect(estimate.floor).toBe(4);
  });

  it("takes the highest rung whichever order the rules are in", () => {
    // An extra turn says 2, two Game Changers say 3.
    const estimate = estimateBracket([
      TIME_WARP,
      gameChanger("Rhystic Study"),
      gameChanger("Cyclonic Rift"),
      islands(60),
    ]);

    expect(estimate.floor).toBe(3);
  });

  /**
   * **Never 5, however much is in the deck.** Brackets 4 and 5 have identical deck
   * restrictions; what separates them is whether the deck was built for the cEDH metagame,
   * which is an intent no card list shows. A reader who is playing cEDH sets the bracket by
   * hand.
   */
  it("never reads 5, whatever the deck holds", () => {
    const everything = estimateBracket(
      [
        gameChanger("Rhystic Study"),
        gameChanger("Cyclonic Rift"),
        gameChanger("The One Ring"),
        gameChanger("Ancient Tomb"),
        gameChanger("Demonic Tutor"),
        gameChanger("Smothering Tithe"),
        gameChanger("Mox Diamond"),
        ARMAGEDDON,
        JOKULHAUPS,
        TIME_WARP,
        NEXUS_OF_FATE,
        TEMPORAL_MANIPULATION,
      ],
      [combo({ bracketTag: "R" }), combo({ bracketTag: "R" })],
    );

    expect(everything.floor).toBe(4);
  });
});

describe("tutors, which are no longer a signal", () => {
  /**
   * The [21 October 2025 update](https://magic.wizards.com/en/news/announcements/commander-brackets-beta-update-october-21-2025)
   * removed the tutor limits from every bracket — the column reads "unrestricted" in all five
   * rows. `isTutor` used to lift this deck to 2 and is gone.
   */
  it("leaves a deck that can find any card it likes on the floor", () => {
    expect(estimateBracket([DEMONIC_TUTOR, islands(60)])).toEqual(NOTHING_FOUND);
  });

  it("reads a pile of nothing but tutors and ramp as 2", () => {
    const vampiricTutor = card({
      name: "Vampiric Tutor",
      manaCost: "{B}",
      cmc: 1,
      typeLine: "Instant",
      oracleText:
        "Search your library for a card, then shuffle and put that card on top. You lose 2 life.",
      colors: "B",
      colorIdentity: "B",
      gameChanger: false,
    });

    expect(estimateBracket([DEMONIC_TUTOR, vampiricTutor, RAMPANT_GROWTH]).floor).toBe(2);
  });

  /** …and a tutor cannot lift a floor that combos and text already set, either: the estimate
   *  of a deck with one is the estimate of the same deck without it. */
  it("changes nothing about a deck that already reads higher", () => {
    const without = estimateBracket([TIME_WARP, islands(60)]);
    const with_ = estimateBracket([TIME_WARP, DEMONIC_TUTOR, islands(60)]);

    expect(with_.floor).toBe(without.floor);
    expect(with_.reasons).toEqual(without.reasons);
  });
});

describe("Game Changers", () => {
  /** `game_changer` is a column, not a list this app keeps — the panel updates the list and a
   *  sync brings it in. The names are what the panel discloses behind the number. */
  it("counts the flagged cards and names them", () => {
    const estimate = estimateBracket([
      gameChanger("Rhystic Study"),
      gameChanger("Cyclonic Rift"),
      gameChanger("The One Ring"),
      gameChanger("Ancient Tomb"),
      GRIZZLY_BEARS,
      islands(60),
    ]);

    expect(estimate.gameChangers).toBe(4);
    expect(estimate.gameChangerNames).toEqual([
      "Rhystic Study",
      "Cyclonic Rift",
      "The One Ring",
      "Ancient Tomb",
    ]);
  });

  /** The flag is `boolean | null`: an orphaned row knows nothing about itself and must not be
   *  counted either way. */
  it("does not count a row whose flag is unknown", () => {
    const orphan = card({ name: "Gone Card", gameChanger: null });

    expect(estimateBracket([orphan]).gameChangers).toBe(0);
  });

  /** The same card in two categories is one card. */
  it("names a card once however many rows hold it", () => {
    const deck = [gameChanger("Rhystic Study"), gameChanger("Rhystic Study", "side")];

    expect(estimateBracket(deck).gameChangerNames).toEqual(["Rhystic Study"]);
  });

  /** A pile the user switched off is not the deck — the engine drops it before every rule and
   *  so does this. The Maybeboard is the commonest of those and is inactive because
   *  `schema::PREDEFINED_CATEGORIES` seeds it so, not because this file knows the word. */
  it("ignores an inactive category", () => {
    const deck = [gameChanger("Rhystic Study", "maybe"), islands(60)];

    expect(estimateBracket(deck).gameChangers).toBe(0);
    expect(estimateBracket(deck).floor).toBe(2);
  });
});

describe("mass land denial", () => {
  it("finds the four shapes it is printed in", () => {
    const found = estimateBracket([ARMAGEDDON, JOKULHAUPS, RUINATION, WILDFIRE]);

    expect(found.massLandDenial).toEqual(["Armageddon", "Jokulhaups", "Ruination", "Wildfire"]);
  });

  /**
   * `Islands` contains `lands`, and a substring test made sixteen cards named after a land
   * type into mass land denial — one hit of which pins the whole estimate at bracket 4.
   */
  it("does not read a land type as the word lands", () => {
    const walkTheAeons = card({
      name: "Walk the Aeons",
      manaCost: "{3}{U}{U}",
      cmc: 5,
      typeLine: "Sorcery",
      oracleText:
        "Take an extra turn after this one.\nBuyback—Sacrifice three Islands. (You may " +
        "sacrifice three Islands in addition to any other costs as you cast this spell. If " +
        "you do, put this card into your hand as it resolves.)",
      colors: "U",
      colorIdentity: "U",
    });

    const estimate = estimateBracket([walkTheAeons]);
    expect(estimate.massLandDenial).toEqual([]);
    // It is still an extra-turn card, which is the only thing it should have been read as.
    expect(estimate.extraTurns).toEqual(["Walk the Aeons"]);
    expect(estimate.floor).toBe(2);
  });

  /**
   * **`Homelands` contains `lands`**, and the sentence it is in says `destroy all` — so without
   * the word boundary this artifact, which does nothing to a land, is mass land denial and pins
   * the whole estimate at 4.
   *
   * Re-measured against the live corpus on 2026-08-27, as the shipped `isMassLandDenial` reads
   * it: **four** cards are kept out by the boundary and nothing else — this one, and Boil,
   * Boiling Seas and Tsunami, whose `Destroy all Islands.` is a colour hoser the app has decided
   * not to read as denial. Apocalypse Chime is the one of the four that is not arguable, which
   * is why the test is written on it.
   */
  it("does not read a set name that ends in lands as the word", () => {
    const apocalypseChime = card({
      name: "Apocalypse Chime",
      manaCost: "{2}",
      cmc: 2,
      typeLine: "Artifact",
      oracleText:
        "{2}, {T}, Sacrifice this artifact: Destroy all nontoken permanents with a name " +
        "originally printed in the Homelands expansion. They can't be regenerated.",
      colors: null,
      colorIdentity: "",
    });

    const estimate = estimateBracket([apocalypseChime, islands(60)]);
    expect(estimate.massLandDenial).toEqual([]);
    expect(estimate.floor).toBe(2);
  });

  /**
   * **The two clauses have to be in the _same_ sentence**, which is why the whole text is never
   * tested at once. Bontu's Last Reckoning says `destroy all` about creatures and `lands` about
   * untapping, in two sentences that have nothing to do with each other; read as one string it
   * is mass land denial and reads as bracket 4.
   *
   * Measured against the live corpus on 2026-08-27: **nine** cards are kept out by the split
   * and let in by a whole-text reading — this one, Bolas's Citadel, Cold Snap, Mana Vortex,
   * Mistbind Clique, Rite of Ruin, Solar Tide, Urza's Sylex and Wrath of Leknif — and **none**
   * goes the other way, so the split costs no true positive.
   */
  it("does not join a destroy-all in one sentence to lands in another", () => {
    const bontusLastReckoning = card({
      name: "Bontu's Last Reckoning",
      manaCost: "{1}{B}{B}",
      cmc: 3,
      typeLine: "Sorcery",
      oracleText:
        "Destroy all creatures. Lands you control don't untap during your next untap step.",
      colors: "B",
      colorIdentity: "B",
    });

    const estimate = estimateBracket([bontusLastReckoning, islands(60)]);
    expect(estimate.massLandDenial).toEqual([]);
    expect(estimate.floor).toBe(2);
  });

  /** Sacrificing your own lands is a cost you pay, not denial aimed at the table — so the
   *  sacrifice branch asks who the sentence is addressed to. */
  it("leaves a card that pays with its own lands alone", () => {
    const lotusField = card({
      name: "Lotus Field",
      manaCost: null,
      cmc: 0,
      typeLine: "Land",
      oracleText:
        "Hexproof\nThis land enters tapped.\nWhen this land enters, sacrifice two lands.\n" +
        "{T}: Add three mana of any one color.",
      colors: null,
      colorIdentity: "",
    });

    expect(estimateBracket([lotusField]).massLandDenial).toEqual([]);
  });

  /** A sweeper that names lands only among the things it *spares* is a board wipe. */
  it("leaves a sweeper that spares lands alone", () => {
    const scourglass = card({
      name: "Scourglass",
      manaCost: "{3}{W}{W}",
      cmc: 5,
      typeLine: "Artifact",
      oracleText:
        "{T}, Sacrifice this artifact: Destroy all permanents except for artifacts and lands. " +
        "Activate only during your turn, before attackers are declared.",
      colors: "W",
      colorIdentity: "W",
    });

    expect(estimateBracket([scourglass]).massLandDenial).toEqual([]);
  });

  /** …and denial *with a remainder* still counts, because there the lands come first. */
  it("still reads a sacrifice that leaves a few lands behind", () => {
    const keldonFirebombers = card({
      name: "Keldon Firebombers",
      manaCost: "{3}{R}",
      cmc: 4,
      typeLine: "Creature — Human Rebel",
      oracleText:
        "When this creature enters, each player sacrifices all lands they control except for " +
        "three.",
      colors: "R",
      colorIdentity: "R",
    });

    expect(estimateBracket([keldonFirebombers]).massLandDenial).toEqual(["Keldon Firebombers"]);
  });

  /** "Sacrifice a land" is a cost one card pays, not denial aimed at the table. */
  it("leaves a card that sacrifices one of your own lands alone", () => {
    const zuranOrb = card({
      name: "Zuran Orb",
      manaCost: "{0}",
      cmc: 0,
      typeLine: "Artifact",
      oracleText: "Sacrifice a land: You gain 2 life.",
      colors: null,
      colorIdentity: "",
    });

    expect(estimateBracket([zuranOrb]).massLandDenial).toEqual([]);
  });

  /** A board wipe that spares lands is a board wipe. */
  it("leaves a creature sweeper alone", () => {
    const wrath = card({
      name: "Wrath of God",
      manaCost: "{2}{W}{W}",
      cmc: 4,
      typeLine: "Sorcery",
      oracleText: "Destroy all creatures. They can't be regenerated.",
      colors: "W",
      colorIdentity: "W",
    });

    expect(estimateBracket([wrath]).massLandDenial).toEqual([]);
  });
});

describe("extra turns", () => {
  it("finds them and lists them", () => {
    const estimate = estimateBracket([TIME_WARP, NEXUS_OF_FATE, islands(60)]);

    expect(estimate.extraTurns).toEqual(["Time Warp", "Nexus of Fate"]);
  });

  /**
   * Shutting extra turns off is not taking one. Three cards in the corpus say "that player
   * skips that turn instead" and none of them grants a turn to anybody — a deck built to stop
   * extra turns is the opposite of the deck this signal is looking for.
   */
  it("does not read a card that stops extra turns as one that takes them", () => {
    const stranglehold = card({
      name: "Stranglehold",
      manaCost: "{2}{R}{R}",
      cmc: 4,
      typeLine: "Enchantment",
      oracleText:
        "Your opponents can't search libraries.\nIf an opponent would begin an extra turn, " +
        "that player skips that turn instead.",
      colors: "R",
      colorIdentity: "R",
    });

    const estimate = estimateBracket([stranglehold, islands(60)]);
    expect(estimate.extraTurns).toEqual([]);
    expect(estimate.floor).toBe(2);
  });

  /**
   * …and a card that does **both** still counts, which is why the denial is tested one
   * sentence at a time. Ugin's Nexus stops the table's extra turns in its first sentence and
   * hands its controller one in its second; it is a Commander-legal extra-turn engine, and it
   * is the only card in the corpus the whole-text and per-sentence readings disagree about.
   */
  it("still reads a card that denies extra turns and then takes one", () => {
    const uginsNexus = card({
      name: "Ugin's Nexus",
      manaCost: "{5}",
      cmc: 5,
      typeLine: "Legendary Artifact",
      oracleText:
        "If a player would begin an extra turn, that player skips that turn instead.\n" +
        "If Ugin's Nexus would be put into a graveyard from the battlefield, instead exile it " +
        "and take an extra turn after this one.",
      colors: null,
      colorIdentity: "",
    });

    expect(estimateBracket([uginsNexus, islands(60)]).extraTurns).toEqual(["Ugin's Nexus"]);
  });
});

describe("combos", () => {
  /** The whole of what this app decides about a combo: Spellbook's editors chose the letter,
   *  this turns the letter into a rung. */
  it.each([
    ["R", 4],
    ["S", 3],
    ["P", 3],
    ["O", 2],
    ["C", 2],
  ] as const)("reads a combo tagged %s as %i", (bracketTag, floor) => {
    expect(estimateBracket([islands(60)], [combo({ bracketTag })]).floor).toBe(floor);
  });

  /** `E` is Spellbook's "for any deck", which is the floor already — it can only raise a
   *  reading by mistake. It is still shown, because the reader should see what their deck
   *  does. */
  it("raises nothing for a combo tagged E, and still reports it", () => {
    const exhibition = combo({ bracketTag: "E", cards: ["Squirrel Nest", "Earthcraft"] });
    const estimate = estimateBracket([islands(60)], [exhibition]);

    expect(estimate.floor).toBe(2);
    expect(estimate.reasons).toEqual([]);
    expect(estimate.combos).toEqual([exhibition]);
  });

  /** `B` is a **legality** finding, not a power one: `engine.ts` already reports the banned
   *  card from the banned list, and a bracket estimate must not re-report it as power level. */
  it("raises nothing for a combo tagged B, and still reports it", () => {
    const banned = combo({ bracketTag: "B", cards: ["Flash", "Protean Hulk"] });
    const estimate = estimateBracket([islands(60)], [banned]);

    expect(estimate.floor).toBe(2);
    expect(estimate.reasons).toEqual([]);
    expect(estimate.combos).toEqual([banned]);
  });

  /** A letter Spellbook adds later must raise nothing rather than reading as `undefined` and
   *  poisoning the arithmetic. */
  it("raises nothing for a tag it has never seen", () => {
    const future = combo({ bracketTag: "Z" as DeckCombo["bracketTag"] });

    expect(estimateBracket([islands(60)], [future]).floor).toBe(2);
  });

  /**
   * A combo that also needs "a creature with flying" is one this app cannot finish checking,
   * so it is shown and not counted. Counting it would raise a floor on a combo the deck may
   * not have; dropping it would hide a real interaction from the one person who can tell.
   */
  it("keeps a combo that needs a template out of the arithmetic and still shows it", () => {
    const templated = combo({
      bracketTag: "R",
      templateCount: 1,
      cards: ["Kiki-Jiki, Mirror Breaker"],
      produces: "Infinite creature tokens",
    });
    const estimate = estimateBracket([islands(60)], [templated]);

    expect(estimate.floor).toBe(2);
    expect(estimate.reasons).toEqual([]);
    expect(estimate.combos).toEqual([]);
    expect(estimate.possibleCombos).toEqual([templated]);
  });

  it("splits a mixed list down the middle", () => {
    const definite = combo({ bracketTag: "P", templateCount: 0 });
    const possible = combo({ bracketTag: "R", templateCount: 2 });
    const estimate = estimateBracket([islands(60)], [definite, possible]);

    expect(estimate.combos).toEqual([definite]);
    expect(estimate.possibleCombos).toEqual([possible]);
    // The R combo would have said 4 had it counted; the P one is what is left.
    expect(estimate.floor).toBe(3);
  });

  /**
   * **No combos is a supported state, not an empty answer.** A database that has never fetched
   * Commander Spellbook's bulk file hands over nothing, and the estimate reads three signals
   * instead of four rather than refusing.
   */
  it("reads a deck with the argument left off entirely", () => {
    const withArgument = estimateBracket([ARMAGEDDON, islands(60)], []);
    const without = estimateBracket([ARMAGEDDON, islands(60)]);

    expect(without).toEqual(withArgument);
    expect(without.floor).toBe(4);
    expect(without.combos).toEqual([]);
  });

  it("takes the highest of several combos", () => {
    const estimate = estimateBracket(
      [islands(60)],
      [combo({ bracketTag: "C" }), combo({ bracketTag: "R" }), combo({ bracketTag: "O" })],
    );

    expect(estimate.floor).toBe(4);
  });

  it("lets a combo outrank the cards, and the cards outrank a combo", () => {
    const comboWins = estimateBracket(
      [gameChanger("Rhystic Study"), islands(60)],
      [combo({ bracketTag: "R" })],
    );
    const cardsWin = estimateBracket([ARMAGEDDON, islands(60)], [combo({ bracketTag: "C" })]);

    expect(comboWins.floor).toBe(4);
    expect(cardsWin.floor).toBe(4);
    expect(cardsWin.reasons.map((r) => r.code)).toEqual(["mass-land-denial"]);
  });
});

describe("reasons", () => {
  it("is empty on a deck that flags nothing", () => {
    expect(estimateBracket([GRIZZLY_BEARS, islands(60)]).reasons).toEqual([]);
  });

  it("names the rule, the bracket it forces and the cards it read", () => {
    const estimate = estimateBracket([
      gameChanger("Rhystic Study"),
      gameChanger("Cyclonic Rift"),
      islands(60),
    ]);

    expect(estimate.reasons).toEqual([
      {
        code: "game-changers",
        floor: 3,
        cards: ["Rhystic Study", "Cyclonic Rift"],
      },
    ]);
  });

  it("names the denial behind a mass-land-denial reason", () => {
    const estimate = estimateBracket([ARMAGEDDON, WILDFIRE, islands(60)]);

    expect(estimate.reasons).toEqual([
      { code: "mass-land-denial", floor: 4, cards: ["Armageddon", "Wildfire"] },
    ]);
  });

  it("carries the combo itself on a combo reason", () => {
    const ruthless = combo({
      bracketTag: "R",
      cards: ["Thassa's Oracle", "Demonic Consultation"],
      produces: "Win the game",
    });
    const estimate = estimateBracket([islands(60)], [ruthless]);

    expect(estimate.reasons).toEqual([
      {
        code: "combo",
        floor: 4,
        cards: ["Thassa's Oracle", "Demonic Consultation"],
        combo: ruthless,
      },
    ]);
  });

  /** **Only the rules that reached the floor.** A rule that fired lower is a signal the panel
   *  still lists by name and is not a reason for the number. */
  it("drops a rule that fired below the floor", () => {
    // Two Game Changers say 3; one Armageddon says 4 and is the only reason for the 4.
    const estimate = estimateBracket([
      gameChanger("Rhystic Study"),
      gameChanger("Cyclonic Rift"),
      ARMAGEDDON,
      islands(60),
    ]);

    expect(estimate.floor).toBe(4);
    expect(estimate.reasons.map((r) => r.code)).toEqual(["mass-land-denial"]);
    // …and the dropped signal is still visible where the panel reads it.
    expect(estimate.gameChangerNames).toEqual(["Rhystic Study", "Cyclonic Rift"]);
  });

  /** Everything that reached the floor, in the order the module reads its signals: the three
   *  it always has first, the combos it may not have at all last. */
  it("lists every rule that reached the floor", () => {
    const estimate = estimateBracket(
      [
        gameChanger("Rhystic Study"),
        gameChanger("Cyclonic Rift"),
        gameChanger("The One Ring"),
        gameChanger("Ancient Tomb"),
        ARMAGEDDON,
        TIME_WARP,
        NEXUS_OF_FATE,
        TEMPORAL_MANIPULATION,
        islands(60),
      ],
      [combo({ bracketTag: "R" })],
    );

    expect(estimate.reasons.map((r) => r.code)).toEqual([
      "game-changers",
      "mass-land-denial",
      "extra-turns",
      "combo",
    ]);
    expect(estimate.reasons.every((r) => r.floor === 4)).toBe(true);
  });

  /** The names on a reason are a copy: a caller sorting or splicing one must not reach back
   *  into the estimate's own disclosure lists. */
  it("hands out its own array of names", () => {
    const estimate = estimateBracket([ARMAGEDDON, islands(60)]);

    estimate.reasons[0].cards.push("Ravages of War");

    expect(estimate.massLandDenial).toEqual(["Armageddon"]);
  });
});

describe("describeReason", () => {
  it("counts and names the Game Changers", () => {
    const estimate = estimateBracket([gameChanger("Rhystic Study"), islands(60)]);

    expect(describeReason(estimate.reasons[0])).toBe("1 Game Changer: Rhystic Study");
  });

  it("pluralises and lists", () => {
    const estimate = estimateBracket([ARMAGEDDON, WILDFIRE, islands(60)]);

    expect(describeReason(estimate.reasons[0])).toBe("mass land denial: Armageddon, Wildfire");
  });

  it("counts the extra-turn cards", () => {
    const estimate = estimateBracket([TIME_WARP, NEXUS_OF_FATE, TEMPORAL_MANIPULATION]);

    expect(describeReason(estimate.reasons[0])).toBe(
      "3 extra-turn cards: Time Warp, Nexus of Fate, Temporal Manipulation",
    );
  });

  /** A combo names **all** its cards rather than the first three: a combo is the set. */
  it("joins a combo's cards with plus signs", () => {
    const estimate = estimateBracket(
      [islands(60)],
      [
        combo({
          bracketTag: "R",
          cards: ["Thassa's Oracle", "Demonic Consultation", "Lotus Petal", "Brainstorm"],
        }),
      ],
    );

    expect(describeReason(estimate.reasons[0])).toBe(
      "the combo Thassa's Oracle + Demonic Consultation + Lotus Petal + Brainstorm",
    );
  });

  /** A sentence nobody finishes reading says nothing, so past three it counts instead. */
  it("stops listing card names after three", () => {
    const estimate = estimateBracket([
      gameChanger("Rhystic Study"),
      gameChanger("Cyclonic Rift"),
      gameChanger("The One Ring"),
      gameChanger("Ancient Tomb"),
      gameChanger("Demonic Tutor"),
    ]);

    expect(describeReason(estimate.reasons[0])).toBe(
      "5 Game Changers: Rhystic Study, Cyclonic Rift, The One Ring and 2 more",
    );
  });
});

describe("bracketWarning", () => {
  const armageddonDeck = () => estimateBracket([ARMAGEDDON, GRIZZLY_BEARS, islands(60)]);

  /** `0` is `AUTO_BRACKET`: a deck that has not been told what it is cannot be told it is
   *  wrong. */
  it("says nothing on Auto", () => {
    expect(bracketWarning(0, armageddonDeck())).toBeNull();
  });

  it("says nothing when the set bracket is exactly the floor", () => {
    expect(bracketWarning(4, armageddonDeck())).toBeNull();
  });

  /** A deck set above its floor is an ordinary thing — a bracket is a ceiling the table agreed
   *  on, and playing under it is not a mistake. */
  it("says nothing when the set bracket is above the floor", () => {
    expect(bracketWarning(5, armageddonDeck())).toBeNull();
  });

  /**
   * **The empty-`reasons` guard, which became reachable on 2026-09-01 and is the whole of what
   * keeps bracket 1 settable.** This deck's floor is `2` and the reader has set `1`, so the
   * first two guards let it through; what stops the sentence is that no rule fired, and there
   * is therefore nothing to tell them. Exhibition is a claim about what a deck is *for* and no
   * card in this one contradicts it.
   */
  it("says nothing to a deck set to bracket 1 that flags nothing at all", () => {
    expect(bracketWarning(1, estimateBracket([GRIZZLY_BEARS, islands(60)]))).toBeNull();
  });

  /**
   * …and the other half of the same rule: bracket 1 is the one bracket that forbids extra turns
   * outright, so the rule that fires at 2 is what a reader who set 1 hears about. This is the
   * whole job the extra-turn rung kept when it stopped being what lifted a deck off the floor.
   */
  it("names the extra turn to a deck set to bracket 1 that plays one", () => {
    const message = bracketWarning(1, estimateBracket([TIME_WARP, GRIZZLY_BEARS, islands(60)]));

    expect(message).toBe(
      "Set to bracket 1, but this deck reads as bracket 2 or higher " +
        "(1 extra-turn card: Time Warp) — worth a word with the table before the game.",
    );
  });

  it("names both numbers and the reason when the set bracket is below the floor", () => {
    const message = bracketWarning(2, armageddonDeck());

    expect(message).toBe(
      "Set to bracket 2, but this deck reads as bracket 4 or higher " +
        "(mass land denial: Armageddon) — worth a word with the table before the game.",
    );
  });

  it("fires on every rung below the floor", () => {
    const estimate = estimateBracket([gameChanger("Rhystic Study"), islands(60)]);

    expect(bracketWarning(1, estimate)).toContain("bracket 3 or higher");
    expect(bracketWarning(2, estimate)).toContain("bracket 3 or higher");
    expect(bracketWarning(3, estimate)).toBeNull();
  });

  it("names a combo when a combo is what set the floor", () => {
    const estimate = estimateBracket(
      [islands(60)],
      [combo({ bracketTag: "R", cards: ["Thassa's Oracle", "Demonic Consultation"] })],
    );

    expect(bracketWarning(2, estimate)).toContain(
      "the combo Thassa's Oracle + Demonic Consultation",
    );
  });

  /**
   * **Advisory in the words, not only in the code.** The floor is two oracle-text greps and a
   * third party's classification, and the reader is the one who knows whether their playgroup
   * cares — so the sentence must never read like a rule the deck has failed.
   */
  it("keeps the voice advisory", () => {
    const message = bracketWarning(2, armageddonDeck()) ?? "";

    expect(message).not.toMatch(/illegal|invalid|error|must not|not allowed|violat/i);
    expect(message).toContain("worth a word with the table");
  });
});
