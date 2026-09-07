/**
 * Narrowing the deck wall — a name box and a row of format chips, and nothing that outlives the
 * session.
 *
 * The sort is remembered in `app_meta`; a filter is not, and the split is deliberate. An order
 * is how a reader likes to read their gallery, and it is visible in the toolbar the moment they
 * open it. A filter is a thing they are doing *right now*, and a gallery that opened already
 * narrowed — with no memory of having asked for it — is a gallery that looks like it has lost
 * decks. So this module holds no state and reads no storage: it is two pure functions over the
 * list `deck_list` answered and a third that says what chips to offer.
 */
import { sortOptions } from "@/lib/options";
import type { DeckRow } from "@/lib/ipc";

/** What the filter row is asking for. Both halves empty is the gallery unfiltered. */
export interface DeckFilter {
  /** Typed into the name box, matched against the deck's name. Untrimmed, as the field holds it. */
  query: string;
  /**
   * The `formatKey`s the reader has ticked.
   *
   * **Empty means _no format filter_, not _no formats_**, and that is the one thing about a chip
   * row that has to be got right: a reader who has ticked nothing is asking to see everything,
   * not nothing. The bug shape is a `formats.includes(deck.formatKey)` with no empty check in
   * front of it, which empties the wall the moment the row appears and reads as the gallery
   * having lost every deck at once.
   */
  formats: readonly string[];
}

/** The gallery as it opens: everything. */
export const NO_DECK_FILTER: DeckFilter = { query: "", formats: [] };

/**
 * Unicode's Combining Diacritical Marks block, U+0300–U+036F — what `normalize("NFD")` splits an
 * accented letter *into*, so stripping this range is what turns `"Jötun"` into `"Jotun"`.
 *
 * **Spelled as escapes and never as the characters themselves.** Written literally they are
 * invisible in an editor, in a diff and in a review, and a regex nobody can read is a regex
 * nobody can check — which is the same failure a stray control character in a source file causes,
 * one grep at a time.
 */
const COMBINING_MARKS = /[\u0300-\u036f]/g;

/**
 * A name reduced to what a reader means by it — lower case, and with the accents taken off.
 *
 * **Why not the app collator.** `compareLabels` is the app's one string comparison and it
 * already folds case and accents (`sensitivity: "base"`), which is exactly the fold this needs —
 * but `Intl.Collator` compares whole strings and has no substring API at all. Asking it this
 * question means sliding a window across the name and comparing every slice of the needle's
 * length, which is a second, slower spelling of "are these the same letter" invented in a file
 * that has no business owning one. So the fold is done directly.
 *
 * **`toLocaleLowerCase("en")`, pinned, for the reason every `Intl` call in this app is pinned**
 * (`options.ts` states it): the fold is part of what the app *does*, and a search that matched
 * on one machine and not on another is not a search two readers can compare. The pin is not
 * theoretical — under `tr`, `"I".toLocaleLowerCase()` is `"ı"` and not `"i"`, so a deck named
 * *Izzet Storm* would stop answering to a typed `izzet` on a Turkish desktop, silently and only
 * there.
 *
 * The accent half is NFD plus a strip of the combining marks: `"Æther"` typed as `"aether"` will
 * not match and is not meant to, but `"Ætherdrift"` typed as `"æther"` will, and *Jötun* answers
 * to `jotun`. Decomposition is what makes that one line rather than a table of substitutions.
 */
function fold(value: string): string {
  return value
    .normalize("NFD")
    .replace(COMBINING_MARKS, "")
    .toLocaleLowerCase("en");
}

/**
 * The decks a filter leaves on the wall — a **new** array, in the order they came in.
 *
 * **It copies, it never sorts and it never mutates.** The array reaching this is React Query's
 * own cached `deck_list` answer, and `Array.prototype.filter` already builds a new one, which is
 * `sortOptions`' rule in `options.ts` arrived at for free. Ordering happens afterwards, in
 * `deckSort.ts`, and keeping the two apart is what lets the wall be re-sorted without being
 * re-filtered and narrowed without being re-ordered.
 *
 * The two terms are an **and**: a reader who typed a name and ticked a format wants the decks
 * that are both. Each term that is empty is simply not asked.
 */
export function filterDecks(decks: readonly DeckRow[], filter: DeckFilter): DeckRow[] {
  const needle = fold(filter.query.trim());
  const formats = filter.formats;
  return decks.filter((deck) => {
    if (needle !== "" && !fold(deck.name).includes(needle)) return false;
    // The empty check in front, and see {@link DeckFilter.formats} for what it is worth.
    if (formats.length > 0 && !formats.includes(deck.formatKey)) return false;
    return true;
  });
}

/**
 * The chips the row offers: the formats these decks are actually in, with a count each.
 *
 * **Only the formats present**, which is faceting rather than a picker — a chip for Pauper in a
 * gallery holding no Pauper deck is a control whose only possible outcome is an empty wall. A
 * one-format gallery therefore offers one chip, and that is information rather than clutter: it
 * says the reader has decks in one format, which is a thing the wall itself does not tell them.
 *
 * The label is `formatName ?? formatKey`, {@link DeckRow.formatName}'s own contract — the seeded
 * display name, falling back to the raw key on a format the table no longer carries, which is a
 * deck that still lists and still deserves a chip. Two keys never collapse into one chip even if
 * some future seed gave them the same words, because the grouping is by key and only the label
 * is drawn.
 *
 * Ordered by `sortOptions`, so the chips read alphabetically by the words on them — the app's
 * one rule for an option list, and the reason a reader looks for *Modern* under M rather than
 * wherever a `sort_order` column happened to put it.
 */
export function deckFormats(
  decks: readonly DeckRow[],
): { key: string; label: string; count: number }[] {
  const byKey = new Map<string, { key: string; label: string; count: number }>();
  for (const deck of decks) {
    const found = byKey.get(deck.formatKey);
    if (found === undefined) {
      byKey.set(deck.formatKey, {
        key: deck.formatKey,
        label: deck.formatName ?? deck.formatKey,
        count: 1,
      });
    } else {
      found.count += 1;
    }
  }
  return sortOptions([...byKey.values()], (format) => format.label);
}
