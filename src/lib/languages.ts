/**
 * Scryfall's language codes, in words.
 *
 * A printing's language is drawn as the code the database stores — `JA`, `PT`, `PH` — because
 * two or three characters is all the room a card corner or a facts line has. That is a fine
 * label for the eight codes a reader can guess and a riddle for the rest: issue #161 is a
 * reader asking what the `PH` on Elesh Norn means, and the honest answer, *the card is printed
 * in Phyrexian*, is nowhere on the screen. This module is that answer, in one place, so the
 * three surfaces that abbreviate a language say the same words about it.
 *
 * **The table is the corpus's, not a guess at Scryfall's.** 19 codes appear across the
 * 116 712 rows of the 2026-08-18 bulk — 2 644 of them non-English — and every one is named
 * here. Scryfall's `docs/api/languages` publishes 17 of them; the two it does not are the ones
 * a card game invented rather than a country: `qya` is Quenya, from *Tales of Middle-earth*,
 * and `dw` is Dwarvish, which arrived with *The Hobbit* on 2026-08-14 and has 5 printings.
 * Both were read off the cards themselves (`ltr`/`ltc` and `hoc` in the shipped database)
 * rather than off a page that had not caught up.
 */

/**
 * A `Map`, not a `Record` — the same fence `rarity.ts` puts around a value that arrives from
 * the database. An object lookup answers for every key on `Object.prototype`, so a row whose
 * `lang` read `constructor` would come back holding a function and {@link languageName} would
 * hand a component something to render that is not a string.
 */
const LANGUAGE_NAME = new Map<string, string>([
  ["en", "English"],
  ["es", "Spanish"],
  ["fr", "French"],
  ["de", "German"],
  ["it", "Italian"],
  ["pt", "Portuguese"],
  ["ja", "Japanese"],
  ["ko", "Korean"],
  ["ru", "Russian"],
  ["zhs", "Simplified Chinese"],
  ["zht", "Traditional Chinese"],
  ["he", "Hebrew"],
  ["la", "Latin"],
  ["grc", "Ancient Greek"],
  ["ar", "Arabic"],
  ["sa", "Sanskrit"],
  ["ph", "Phyrexian"],
  ["qya", "Quenya"],
  ["dw", "Dwarvish"],
]);

/**
 * What this code is called, or the code itself in capitals.
 *
 * The fallback is `finishLabel`'s rule one column over: an unrecognised value is still what the
 * reader's own data says, so a language Scryfall adds next set is drawn as `XX` rather than as
 * "Unknown" — which would be this app claiming the card has no language when what it has is a
 * language this table has not been taught. Capitals because that is how every surface draws a
 * code already; the fallback lands in the same shape as a name and never as raw column data.
 */
export function languageName(code: string): string {
  return LANGUAGE_NAME.get(code.toLowerCase()) ?? code.toUpperCase();
}

/**
 * The sentence a language mark says on hover — what the abbreviation is short for.
 *
 * A bare "Phyrexian" would answer half the question: the corner mark is two letters on a
 * photograph with no caption near it, and a reader who does not know what the letters are for
 * cannot tell a language from a set, a treatment or a rarity. Naming the fact and the value in
 * one line is what makes the mark self-explaining, and it is the same shape `FinishMark` and
 * `GameChangerMark` already use — a short accessible name, a full sentence on the pointer.
 */
export function languageHint(code: string): string {
  return `Printed in ${languageName(code)}`;
}
