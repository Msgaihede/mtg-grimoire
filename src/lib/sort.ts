/**
 * What "sorted by" means everywhere in this app: an ordered list of columns, each with a
 * direction, the first one deciding and the rest breaking its ties.
 *
 * A list rather than one key, because comparing printings is what these tables are for and
 * the question is usually two-part — cheapest *within* each rarity, newest *within* each
 * set. One key answers half of it and leaves the other half to whatever order the database
 * happened to produce.
 *
 * The empty spec is a real state and is not the same as "unsorted": it means the view's own
 * default, which for the search is relevance when there is a query and name when there is
 * not, and for the two lists is name. Nothing in this app is ever unsorted.
 */
export type SortDir = "asc" | "desc";

export interface SortTerm<K extends string = string> {
  readonly key: K;
  readonly dir: SortDir;
}

export type SortSpec<K extends string = string> = readonly SortTerm<K>[];

/** The term for one column, or nothing when the sort does not mention it. */
export function sortTermOf<K extends string>(spec: SortSpec<K>, key: K): SortTerm<K> | undefined {
  return spec.find((t) => t.key === key);
}

/**
 * Where a column sits in the sort, counting from 1 — the number drawn beside its arrow
 * once there is more than one. `null` when the sort does not mention it.
 */
export function sortRankOf<K extends string>(spec: SortSpec<K>, key: K): number | null {
  const at = spec.findIndex((t) => t.key === key);
  return at < 0 ? null : at + 1;
}

/** A term as `aria-sort` spells it. */
export function ariaSortOf(term: SortTerm | undefined): "ascending" | "descending" | "none" {
  if (!term) return "none";
  return term.dir === "asc" ? "ascending" : "descending";
}

/** The direction after this one, in the cycle below. */
const flip = (dir: SortDir): SortDir => (dir === "asc" ? "desc" : "asc");

/**
 * One press on a column header, answered.
 *
 * Every column cycles the same way — `firstDir`, then the opposite, then gone — and the
 * modifier decides only what happens to the *other* columns: a plain press replaces the
 * sort, a shifted one edits this column and leaves the rest alone. So a reader who has
 * never held Shift can still reach every single-column order, and one who has can build a
 * two- or three-key sort without learning a second gesture.
 *
 * A plain press on a column that is already part of a multi-key sort **narrows to it**
 * rather than cycling it: the reader who did not hold Shift asked for one column, and
 * flipping this one in place would leave the other keys silently deciding the order.
 *
 * A cycled-out column is *removed* rather than reset, which is what makes the third press
 * mean "never mind" — without it, a reader who sorted by accident has no way back to the
 * view's own order.
 *
 * No cap on the number of terms. The sortable columns are the cap, and they number five.
 *
 * @param firstDir which direction one press asks for first — ascending on names and text,
 *        descending on money and counts, because "highest first" is what clicking a price
 *        column means.
 */
export function applySort<K extends string>(
  spec: SortSpec<K>,
  key: K,
  { additive, firstDir }: { additive: boolean; firstDir: SortDir },
): SortSpec<K> {
  const current = sortTermOf(spec, key);

  if (!additive) {
    // Not in the sort, or in it alongside others: this press is the whole new sort.
    if (!current || spec.length > 1) return [{ key, dir: firstDir }];
    return current.dir === firstDir ? [{ key, dir: flip(firstDir) }] : [];
  }

  if (!current) return [...spec, { key, dir: firstDir }];
  // Rewritten in place rather than removed and re-appended: a column that jumped to the end
  // of the sort when its direction changed would silently re-order the other keys.
  if (current.dir === firstDir) {
    return spec.map((t) => (t.key === key ? { key, dir: flip(firstDir) } : t));
  }
  return spec.filter((t) => t.key !== key);
}
