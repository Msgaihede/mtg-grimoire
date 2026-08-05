import { beforeEach, describe, expect, it } from "vitest";
import { card, gameChanger, islands, resetRowIds } from "./fixtures";
import { estimateBracket } from "./bracket";

/**
 * The bracket estimate is an **advisory**, and these tests are written to say so: they assert
 * the *shape* of the reading — how many Game Changers were found, which cards are behind the
 * number, that the number moves in the right direction — and never a rules-lawyer table of
 * deck to bracket. A heuristic pinned to the digit is a heuristic that cannot be improved.
 *
 * Every fixture is a real printing, probed read-only out of the local card database on
 * 2026-08-05, and the `gameChanger: true` rows are the first fixtures anywhere in this app to
 * carry that flag.
 */

beforeEach(resetRowIds);

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

/** Ramp, not a tutor: it searches for a land, and a deck full of it is still bracket 1. */
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

describe("Game Changers", () => {
  /** `game_changer` is a column, not a list this app keeps — the panel updates the list and a
   *  sync brings it in. Four of them is the count the estimate reports and the four names are
   *  what the panel discloses behind it. */
  it("counts the flagged cards and names them", () => {
    const deck = [
      gameChanger("Rhystic Study"),
      gameChanger("Cyclonic Rift"),
      gameChanger("The One Ring"),
      gameChanger("Ancient Tomb"),
      GRIZZLY_BEARS,
      islands(60),
    ];

    const estimate = estimateBracket(deck);

    expect(estimate.gameChangers).toBe(4);
    expect(estimate.gameChangerNames).toEqual([
      "Rhystic Study",
      "Cyclonic Rift",
      "The One Ring",
      "Ancient Tomb",
    ]);
    expect(estimate.bracket).toBeGreaterThanOrEqual(4);
  });

  it("reads one to three of them as a lower bracket than four", () => {
    const few = estimateBracket([gameChanger("Rhystic Study"), islands(60)]);
    const many = estimateBracket([
      gameChanger("Rhystic Study"),
      gameChanger("Cyclonic Rift"),
      gameChanger("The One Ring"),
      gameChanger("Ancient Tomb"),
      islands(60),
    ]);

    expect(few.gameChangers).toBe(1);
    expect(many.gameChangers).toBe(4);
    expect(few.bracket).toBeLessThan(many.bracket);
  });

  /** Seven of them is past every bracket that names a limit. */
  it("reads more than six as the top bracket", () => {
    const deck = [
      gameChanger("Rhystic Study"),
      gameChanger("Cyclonic Rift"),
      gameChanger("The One Ring"),
      gameChanger("Ancient Tomb"),
      gameChanger("Demonic Tutor"),
      gameChanger("Smothering Tithe"),
      gameChanger("Mox Diamond"),
    ];

    expect(estimateBracket(deck).bracket).toBe(5);
  });

  /** The flag is `boolean | null`: an orphaned row knows nothing about itself and must not be
   *  counted either way. */
  it("does not count a row whose flag is unknown", () => {
    const orphan = card({ name: "Gone Card", gameChanger: null });

    expect(estimateBracket([orphan]).gameChangers).toBe(0);
  });

  /** The same card in two zones is one card. */
  it("names a card once however many rows hold it", () => {
    const deck = [gameChanger("Rhystic Study"), gameChanger("Rhystic Study", "side")];

    expect(estimateBracket(deck).gameChangerNames).toEqual(["Rhystic Study"]);
  });

  /** The scratchpad is not the deck — the engine drops it before every rule and so does this. */
  it("ignores the maybe pile", () => {
    const deck = [gameChanger("Rhystic Study", "maybe"), islands(60)];

    expect(estimateBracket(deck).gameChangers).toBe(0);
  });
});

describe("mass land denial", () => {
  it("finds the four shapes it is printed in", () => {
    const found = estimateBracket([ARMAGEDDON, JOKULHAUPS, RUINATION, WILDFIRE]);

    expect(found.massLandDenial).toEqual(["Armageddon", "Jokulhaups", "Ruination", "Wildfire"]);
  });

  /** Any of it puts the deck at the top, whatever else is in there. That is **this app's
   *  judgement and not the brackets document's** — the real text makes mass land denial a
   *  bracket-4-and-up signal, and `bracketFor`'s table says which rows are whose. */
  it("takes a deck with no Game Changers at all to the top bracket", () => {
    const estimate = estimateBracket([ARMAGEDDON, GRIZZLY_BEARS, islands(60)]);

    expect(estimate.gameChangers).toBe(0);
    expect(estimate.bracket).toBe(5);
  });

  /**
   * `Islands` contains `lands`, and a substring test made sixteen cards named after a land
   * type into mass land denial — one hit of which pins the whole estimate at bracket 5.
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
   * Shutting extra turns off is not taking one. Four cards in the corpus say "that player
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
    expect(estimate.bracket).toBe(1);
  });

  /** On their own they lift the reading off the casual floor without making the deck
   *  optimized — the mapping's own judgement, and it is a judgement. */
  it("lifts a deck that flags nothing else", () => {
    const withThem = estimateBracket([TIME_WARP, GRIZZLY_BEARS, islands(60)]);
    const without = estimateBracket([GRIZZLY_BEARS, islands(60)]);

    expect(withThem.bracket).toBeGreaterThan(without.bracket);
    expect(withThem.gameChangers).toBe(0);
  });
});

describe("the empty-handed end of the scale", () => {
  /** Nothing flagged and nothing to search for: the one reading that is allowed to be a 1. */
  it("reads a deck with no flags and no tutors as the bottom bracket", () => {
    const estimate = estimateBracket([GRIZZLY_BEARS, RAMPANT_GROWTH, islands(60)]);

    expect(estimate).toEqual({
      bracket: 1,
      gameChangers: 0,
      gameChangerNames: [],
      massLandDenial: [],
      extraTurns: [],
    });
  });

  /** A tutor is a card that finds any card. Rampant Growth finds a land, and is why the test
   *  above is a 1 rather than a 2. */
  it("lifts a deck that can find any card it likes", () => {
    const tutor = card({
      name: "Demonic Tutor",
      manaCost: "{1}{B}",
      cmc: 2,
      typeLine: "Sorcery",
      oracleText: "Search your library for a card, put that card into your hand, then shuffle.",
      colors: "B",
      colorIdentity: "B",
      // Deliberately *not* flagged, so this is about the tutor and not about the list.
      gameChanger: false,
    });

    expect(estimateBracket([tutor, islands(60)]).bracket).toBe(2);
  });

  it("reads an empty deck rather than throwing on one", () => {
    expect(estimateBracket([])).toEqual({
      bracket: 1,
      gameChangers: 0,
      gameChangerNames: [],
      massLandDenial: [],
      extraTurns: [],
    });
  });
});
