/**
 * The one order every option list in the app is drawn in.
 *
 * > **Alphabetical by the words on screen, with the unpickable rows pushed to the bottom.**
 *
 * Two rules, and the second only bites where a control greys. A reader looking for "Modern"
 * in a format picker looks for it under M — not in the position somebody decided the formats
 * rank in, which is knowledge the list itself never shows and which no two players would
 * write down the same way. And a row that would return nothing is a row worth offering (it
 * says the search has nothing there) but not worth putting first, so it sinks rather than
 * disappearing: dropping it would make the list jump under the cursor on every keystroke,
 * which is the same reason `SetCombobox` greys instead of filtering.
 *
 * Ordering is a *display* decision, so it lives here and not in SQL. Rust answers with the
 * facts in whatever order the query happened to produce — `list_sets` is newest-first,
 * `format_specs_list` is a seeded `sort_order`, the deck's categories are the order the
 * reader dragged them into — and every one of those is still the right thing for the backend
 * to say. What a `<select>` does with it is this file's business. The exceptions are listed
 * in `src/CLAUDE.md`; they are lists whose order *is* the information (a condition grade
 * runs Near Mint to Damaged) or which the reader arranged themselves.
 */

/**
 * Pinned to `"en"` rather than left to the host locale, for the reason every `Intl` call in
 * this app is (`features/decks/sorting.ts` says it first): the collation is part of what the
 * app *does*, and a list that reorders itself on a different machine is a list two readers
 * cannot compare.
 *
 * `sensitivity: "base"` so case and accents do not split a list — a locale-blind
 * `localeCompare` sorts `"a"` after `"B"`, which is how "The List" ends up above "the
 * list". `numeric: true` because set names are full of numerals and `"Arena League 1999"`
 * belongs before `"Arena League 2001"` rather than wherever a code-unit comparison of
 * `"1"` against `"2"` lands it — the same reason `"Set 2"` must precede `"Set 10"`.
 */
const collator = new Intl.Collator("en", { sensitivity: "base", numeric: true });

/** Two display labels, alphabetically. The only string comparison an option list may use. */
export function compareLabels(a: string, b: string): number {
  return collator.compare(a, b);
}

/**
 * One option list, ordered.
 *
 * `label` is what the reader sees — the **display value**, never the underlying key. `modern`
 * and `Modern` sort the same here, but `standard` and `Standard Brawl` do not, and it is the
 * words on screen that decide.
 *
 * `groups` is optional and is how a faceted control pushes its dead rows down: return one
 * number per grouping level, lowest first, and rows are settled level by level before the
 * alphabet is consulted at all. A control with no greying passes nothing and gets one
 * alphabetical list. `SetCombobox` passes three levels — picked, then available, then the
 * code-match rank a typed query produces — which is the whole of its ordering in one call.
 *
 * **Copies rather than sorts in place.** The arrays reaching this are often React Query's own
 * cached ones (`ipc.listSets()`, `ipc.formatSpecs()`), and sorting one of those mutates the
 * cache every other reader shares.
 */
export function sortOptions<T>(
  items: readonly T[],
  label: (item: T) => string,
  groups?: (item: T) => readonly number[],
): T[] {
  return [...items].sort((a, b) => {
    if (groups) {
      const ga = groups(a);
      const gb = groups(b);
      const depth = Math.max(ga.length, gb.length);
      for (let i = 0; i < depth; i += 1) {
        // A short tuple reads as zeroes past its end, so a caller may return fewer levels for
        // some rows than others without the missing ones sorting last by accident.
        const step = (ga[i] ?? 0) - (gb[i] ?? 0);
        if (step !== 0) return step;
      }
    }
    return compareLabels(label(a), label(b));
  });
}
