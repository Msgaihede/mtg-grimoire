/**
 * The order the cards inside a group are drawn in.
 *
 * Four orders and one function, because all four views read it: the stack, the table, the
 * text columns and the grid all take the same `CardGroup[]` and the cards inside a group
 * were sorted once, by `grouping.ts`, before any of them saw it.
 *
 * **Stable and total.** Stable, so two rows the sort cannot tell apart keep the order the
 * read returned them in and a redraw never shuffles a list under the reader's eyes. Total,
 * because every field a sort could read is nullable — an orphaned row has no type line, no
 * mana value and no price at all, and a comparator that threw there would take the editor
 * down over a card the last sync could not keep.
 */
import type { DeckCard } from "@/lib/ipc";
import { autoCategoryDisplayOrder, autoCategoryFor } from "./autoCategory";

export type SortBy = "alphabetical" | "manaCost" | "price" | "type";

/** The toolbar's Sort select, so the four are named in one place. **The order here is not the
 *  order they are offered in** — a picker sorts by label (`src/lib/options.ts`), so this array
 *  is free to read in whatever order explains the sorts and a fifth entry may be appended
 *  without deciding where it appears. */
export const SORT_OPTIONS: readonly { value: SortBy; label: string }[] = [
  { value: "alphabetical", label: "Alphabetical" },
  { value: "manaCost", label: "Mana cost" },
  { value: "price", label: "Price" },
  { value: "type", label: "Type" },
];

/** What a group's cards are ordered by until somebody says otherwise — the editor's initial
 *  state, and what a stored order this build cannot draw falls back to. */
export const DEFAULT_SORT_BY: SortBy = "alphabetical";

/** Derived from {@link SORT_OPTIONS} rather than written out a second time: a fifth order
 *  added to that array is offered *and* accepted from storage in one edit. */
const SORT_VALUES: ReadonlySet<string> = new Set(SORT_OPTIONS.map((o) => o.value));

/**
 * A stored `Sort` as an order this build actually has, or {@link DEFAULT_SORT_BY}.
 *
 * `DeckRow.lastSortBy` arrives as a `string` for the reason `asGroupBy`'s twin in
 * `grouping.ts` spells out: the vocabulary is this module's, a database outlives the app, and a
 * word neither side recognises has to become a mode the reader can leave rather than one the
 * toolbar cannot draw.
 */
export function asSortBy(value: string): SortBy {
  return SORT_VALUES.has(value) ? (value as SortBy) : DEFAULT_SORT_BY;
}

/**
 * Names, compared the way a person reads a decklist.
 *
 * Pinned to `"en"` rather than left to the host locale for the reason every `Intl` call in
 * this app is: the collation is part of what the app *does*, and a list that reorders itself
 * on a different machine is a list two readers cannot compare.
 */
const byName = (a: DeckCard, b: DeckCard) => a.name.localeCompare(b.name, "en");

/**
 * A nullable number, ascending, with `null` last **whichever way the comparison runs**.
 *
 * `null` is *unknown* and never zero: an orphan has no mana value, and an unpriced card is
 * one nobody quoted rather than one that is free. Sorting either to the head would put it
 * exactly where a reader counts their cheapest cards.
 */
function nullsLast(a: number | null, b: number | null, descending = false): number {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return descending ? b - a : a - b;
}

/**
 * One group's cards in the order asked for — a **new** array; the input is `readonly` and
 * stays untouched, because a group's cards come straight off a React Query cache.
 *
 * `Array.prototype.sort` is stable (ES2019 and every engine this ships in), which is what
 * carries the read's own order through every tie.
 *
 * **It used to take a `Currency` and no longer does.** Every row carried two prices then, so
 * a `price` sort had to be told which of them to rank by — and a list ranked in one currency
 * while its cells printed the other was the mistake that argument existed to prevent. Rust now
 * answers one `unitPrice` per row, already at the marketplace the query named, so there is
 * nothing left to choose: the order and the cell read the same number by construction.
 */
export function sortCards(cards: readonly DeckCard[], sortBy: SortBy): DeckCard[] {
  const copy = [...cards];
  switch (sortBy) {
    case "alphabetical":
      return copy.sort(byName);
    case "manaCost":
      return copy.sort((a, b) => nullsLast(a.cmc, b.cmc) || byName(a, b));
    // Dearest first, which is what pressing a money column means everywhere else in this app
    // (`VirtualTable`'s `firstDir` is descending on money) — and the direction does not reach
    // the unpriced rows, which stay at the foot either way. A card the selected marketplace
    // has never quoted is unpriced there, which is a fact about that marketplace rather than
    // a reason to rank it by another one's number.
    case "price":
      return copy.sort((a, b) => nullsLast(a.unitPrice, b.unitPrice, true) || byName(a, b));
    // One vocabulary with the add path and the type grouping, and the **reading** order of
    // it: Land last, as in every decklist. `autoCategoryFor` decides what a card is;
    // `autoCategoryDisplayOrder` decides where that answer sits — the two lists differ only
    // about Land, and `autoCategory.ts` says why.
    case "type":
      return copy.sort(
        (a, b) =>
          autoCategoryDisplayOrder(autoCategoryFor(a)) -
            autoCategoryDisplayOrder(autoCategoryFor(b)) || byName(a, b),
      );
  }
}
