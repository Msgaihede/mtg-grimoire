/**
 * The cards that are allowed to break a copy limit, read off the cards themselves.
 *
 * There is no list here on purpose. The set of "any number" cards was twelve on 2026-08-04
 * and grows with every set that prints another Rat; a hardcoded list is a release every
 * time, and a wrong deck until then. The **printed sentence is the rule**, so this module
 * re-derives the exception from oracle text on every call and a new card needs a data sync
 * and nothing else.
 *
 * What it costs is precision about the sentence. The naive substring
 * `"any number of cards named"` matches three cards that say no such thing — Battalion Foot
 * Soldier and its two cousins *search a library* for any number of copies, which is a
 * board-state ability, not a deckbuilding permission (research doc). So the anchor is the
 * whole clause, from "A deck".
 */

/** The unlimited cards' clause, whole. Trimming this to its tail is the false-positive bug. */
export const ANY_NUMBER_PHRASE = "A deck can have any number of cards named";

/** The capped cards' clause: Seven Dwarves (seven) and Nazgûl (nine) are the two in print. */
export const UP_TO_PHRASE = "A deck can have up to";

/**
 * The counts are printed as **words**, not digits — "up to seven cards named Seven Dwarves".
 * A digit-only parse reads Seven Dwarves as a singleton card, which is the kind of wrong
 * that looks right in a passing test suite. Ten is as far as any card has gone; the digit
 * fallback in {@link copyException} covers whatever comes next.
 */
const WORD_NUMBERS: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
};

/** Built from the anchor itself so the constant stays the single source of the phrase. */
const UP_TO_COUNT = new RegExp(`${UP_TO_PHRASE} (\\w+) cards named`);

/**
 * How many copies of this card a deck may have by the card's **own** text: `Infinity`, a
 * printed count, or `null` when the card says nothing about it (which is nearly every card
 * — the caller then falls back to the format's limit).
 */
export function copyException(oracleText: string | null): number | null {
  if (!oracleText) return null;
  if (oracleText.includes(ANY_NUMBER_PHRASE)) return Infinity;
  const upTo = oracleText.match(UP_TO_COUNT);
  if (!upTo) return null;
  const word = WORD_NUMBERS[upTo[1].toLowerCase()];
  if (word !== undefined) return word;
  const digits = Number.parseInt(upTo[1], 10);
  return Number.isNaN(digits) ? null : digits;
}

/**
 * CR 100.2a: a deck may have any number of basic lands.
 *
 * The supertype is what makes a land basic — `"Basic Land — Island"`, and
 * `"Basic Snow Land — Forest"` for the snow ones — never the name and never the land type
 * (`"Land — Island"` is a dual). The front face decides: a two-faced card whose back is a
 * basic land is one card in a deck.
 */
export function isBasicLand(typeLine: string | null): boolean {
  return typeLine?.split("//")[0].includes("Basic") ?? false;
}
