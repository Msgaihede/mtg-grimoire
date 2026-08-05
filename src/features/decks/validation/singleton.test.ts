import { describe, expect, it } from "vitest";
import { ANY_NUMBER_PHRASE, UP_TO_PHRASE, copyException, isBasicLand } from "./singleton";

/**
 * The oracle text of the cards this module exists for, copied from Scryfall rather than
 * paraphrased. Paraphrasing would defeat the test: what is being pinned is that a *whole
 * printed sentence* is the anchor, so a fixture that only carries the fragment proves
 * nothing.
 */
const ORACLE = {
  relentlessRats:
    "Relentless Rats gets +1/+1 for each other creature you control named Relentless Rats.\n" +
    "A deck can have any number of cards named Relentless Rats.",
  dragonsApproach:
    "Dragon's Approach deals 3 damage to any target. Then if you have five or more cards " +
    "named Dragon's Approach in your graveyard, you may exile them and search your library " +
    "for a Dragon creature card, put it onto the battlefield, then shuffle.\n" +
    "A deck can have any number of cards named Dragon's Approach.",
  shadowbornApostle:
    "A deck can have any number of cards named Shadowborn Apostle.\n" +
    "Sacrifice six Shadowborn Apostles: Search your library for a Demon creature card, put " +
    "it onto the battlefield, then shuffle.",
  sevenDwarves:
    "Seven Dwarves gets +1/+1 for each other creature you control named Seven Dwarves.\n" +
    "A deck can have up to seven cards named Seven Dwarves.",
  nazgul:
    "Whenever a Ring-bearer you control causes a player to lose life, put a +1/+1 counter " +
    "on Nazgûl.\nA deck can have up to nine cards named Nazgûl.",
  /**
   * THE TRAP. This is a *library search*, not a deckbuilding permission — and it contains
   * "any number of cards named" verbatim. The research doc counted three cards like it, so
   * a `includes("any number of cards named")` engine would silently let a Commander deck
   * run five of them.
   */
  battalionFootSoldier:
    "When Battalion Foot Soldier enters the battlefield, you may search your library for " +
    "any number of cards named Battalion Foot Soldier, reveal them, put them into your " +
    "hand, then shuffle.",
  lightningBolt: "Lightning Bolt deals 3 damage to any target.",
};

describe("the exact anchors", () => {
  /** The two phrases are the rule. Pinned as literals because a "tidy-up" that trims either
   *  one to its distinctive-looking tail is exactly the regression this module is about. */
  it("are whole printed sentences, not fragments", () => {
    expect(ANY_NUMBER_PHRASE).toBe("A deck can have any number of cards named");
    expect(UP_TO_PHRASE).toBe("A deck can have up to");
  });
});

describe("copyException", () => {
  it("reads the unlimited cards as unlimited", () => {
    expect(copyException(ORACLE.relentlessRats)).toBe(Infinity);
    expect(copyException(ORACLE.dragonsApproach)).toBe(Infinity);
    // The phrase is not always the last line — Shadowborn Apostle prints it first.
    expect(copyException(ORACLE.shadowbornApostle)).toBe(Infinity);
  });

  /** The two "up to" cards spell their number as a **word**, which is why a digit-only
   *  parse reads them as no exception at all. */
  it("reads the capped cards, whose numbers are printed as words", () => {
    expect(copyException(ORACLE.sevenDwarves)).toBe(7);
    expect(copyException(ORACLE.nazgul)).toBe(9);
  });

  /** No card prints a digit here today. The fallback is for the day one does — a new card
   *  is a data change, and this module must not need a release for it. */
  it("reads a digit if a future card prints one", () => {
    expect(copyException("A deck can have up to 12 cards named Goblin Trapfinder.")).toBe(12);
  });

  it("is silent for a card that searches for copies of itself — THE TRAP", () => {
    expect(ORACLE.battalionFootSoldier).toContain("any number of cards named");
    expect(copyException(ORACLE.battalionFootSoldier)).toBeNull();
  });

  it("is silent for ordinary cards and for a card that is not in the database", () => {
    expect(copyException(ORACLE.lightningBolt)).toBeNull();
    expect(copyException(null)).toBeNull();
    expect(copyException("")).toBeNull();
    // A sentence shaped like the anchor but naming no count is not a permission.
    expect(copyException("A deck can have up to as many cards as you like.")).toBeNull();
  });
});

describe("isBasicLand", () => {
  it("knows the supertype, snow included", () => {
    expect(isBasicLand("Basic Land — Island")).toBe(true);
    expect(isBasicLand("Basic Snow Land — Forest")).toBe(true);
    // Wastes: a basic land with no basic land type at all.
    expect(isBasicLand("Basic Land")).toBe(true);
  });

  it("is not fooled by a nonbasic land or a missing type line", () => {
    expect(isBasicLand("Land — Island")).toBe(false);
    expect(isBasicLand("Legendary Land")).toBe(false);
    expect(isBasicLand("Snow Land — Forest")).toBe(false);
    expect(isBasicLand(null)).toBe(false);
  });

  /** The front face decides. A two-faced card whose *back* is a basic land is one card in a
   *  deck, not an unlimited one. */
  it("reads the front face of a two-faced type line", () => {
    expect(isBasicLand("Creature — Human // Basic Land — Island")).toBe(false);
    expect(isBasicLand("Basic Land — Island // Creature — Human")).toBe(true);
  });
});
