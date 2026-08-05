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
 *
 * There is a third phrase family — "A deck can have only one card named …" — and it is
 * deliberately not parsed. It would *tighten* a limit rather than loosen one, and it is
 * printed on Un-set cards that are `not_legal` in all 23 seeded formats: the legality pass
 * refuses them before any copy count could matter, and in `casual` (which checks no pool at
 * all) nothing is enforced anyway. If a black-bordered card ever prints it, it belongs here
 * as a *minimum* alongside the two maxima below.
 */

/** The unlimited cards' clause, whole. Trimming this to its tail is the false-positive bug. */
export const ANY_NUMBER_PHRASE = "A deck can have any number of cards named";

/** The capped cards' clause: Seven Dwarves (seven) and Nazgûl (nine) are the two in print. */
export const UP_TO_PHRASE = "A deck can have up to";

/**
 * The counts are printed as **words**, not digits — "up to seven cards named Seven Dwarves".
 * A digit-only parse reads Seven Dwarves as a singleton card, which is the kind of wrong
 * that looks right in a passing test suite. Nine is as far as any card has gone; the table
 * runs to twenty, and {@link copyException} falls back to digits, so the unreadable case is
 * a word no card has printed yet rather than the next Dwarf.
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
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
  seventeen: 17,
  eighteen: 18,
  nineteen: 19,
  twenty: 20,
};

/** Built from the anchor itself so the constant stays the single source of the phrase. */
const UP_TO_COUNT = new RegExp(`${UP_TO_PHRASE} (\\w+) cards named`);

/**
 * How many copies of this card a deck may have by the card's **own** text: `Infinity`, a
 * printed count, or `null` when the card says nothing about it (which is nearly every card
 * — the caller then falls back to the format's limit).
 *
 * A card that prints the clause with a count this module cannot read answers `Infinity`, not
 * `null`. The card is *known* to permit more than one copy, so falling back to the format's
 * limit would report an error that the printed text contradicts — a false error the user
 * cannot act on. Passing is the safer wrong answer, and it is not a silent one:
 * {@link unreadableCopyCount} lets the caller say so.
 */
export function copyException(oracleText: string | null): number | null {
  if (!oracleText) return null;
  if (oracleText.includes(ANY_NUMBER_PHRASE)) return Infinity;
  const upTo = oracleText.match(UP_TO_COUNT);
  if (!upTo) return null;
  return countOf(upTo[1]) ?? Infinity;
}

/**
 * The count a card printed after {@link UP_TO_PHRASE} when this module could not turn it
 * into a number, and `null` in every other case — no clause, or a clause that parsed.
 *
 * The caller warns on it, because {@link copyException} has just let the card past every
 * copy limit on the strength of a word it does not know.
 */
export function unreadableCopyCount(oracleText: string | null): string | null {
  if (!oracleText) return null;
  if (oracleText.includes(ANY_NUMBER_PHRASE)) return null;
  const upTo = oracleText.match(UP_TO_COUNT);
  if (!upTo) return null;
  return countOf(upTo[1]) === null ? upTo[1] : null;
}

/** A printed count as a number: a word from the table, then digits, then nothing. */
function countOf(printed: string): number | null {
  const word = WORD_NUMBERS[printed.toLowerCase()];
  if (word !== undefined) return word;
  const digits = Number.parseInt(printed, 10);
  return Number.isNaN(digits) ? null : digits;
}

/**
 * CR 100.2a: a deck may have any number of basic lands.
 *
 * **Basic *and* Land**, both. The supertype is what makes a land basic — `"Basic Land —
 * Island"`, and `"Basic Snow Land — Forest"` for the snow ones — never the name and never
 * the land type (`"Land — Island"` is a dual). And `Basic` alone is not enough: the printed
 * corpus really does contain `"Basic Creature — Shapeshifter"`, which a supertype-only test
 * hands an unlimited copy count. The front face decides: a two-faced card whose back is a
 * basic land is one card in a deck.
 */
export function isBasicLand(typeLine: string | null): boolean {
  const front = typeLine?.split("//")[0];
  return front === undefined ? false : front.includes("Basic") && front.includes("Land");
}
