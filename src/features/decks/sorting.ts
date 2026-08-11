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

/** The toolbar's Sort select, so the four are named in one place. */
export const SORT_OPTIONS: readonly { value: SortBy; label: string }[] = [
  { value: "alphabetical", label: "Alphabetical" },
  { value: "manaCost", label: "Mana cost" },
  { value: "price", label: "Price" },
  { value: "type", label: "Type" },
];

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
    // the unpriced rows, which stay at the foot either way.
    case "price":
      return copy.sort((a, b) => nullsLast(a.unitPriceUsd, b.unitPriceUsd, true) || byName(a, b));
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
