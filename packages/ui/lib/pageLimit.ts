/**
 * **How many rows the page at `offset` asks for** — the ordinary page, or more of them at once
 * when a wall has said it is owed more (a Ctrl+A walk, issue #910) — for the paged lists behind
 * the card walls: `useCardSearch`, the collection's and the wishlist's (2026-11).
 *
 * ## Why a select-all asks for bigger pages
 *
 * A Ctrl+A on a wall is "every card these filters match", and the wall fetches what it has not got
 * page by page until the list is whole or `SELECT_ALL_LIMIT` is reached. At the card search's 50
 * rows that was **twenty sequential round trips for a thousand cards** — 1.2 s over the fake in
 * Storybook, each page landing as its own render of the wall, the busy column beside it and every
 * derived list. The backend answers far larger pages than the wall's first screenful needs
 * (`search.rs`' `MAX_LIMIT` is 200, the collection's and the wishlist's 500), so a page asked for
 * on the walk's behalf asks for what it is owed, up to that ceiling: the same thousand cards are a
 * 50-row first page and five of 200.
 *
 * ## Why the limit is not simply carried in the page param
 *
 * An infinite query **refetches every page it holds** — on a window refocus past the 30 s stale
 * time, on an invalidation — and TanStack recomputes each page's param from the pages refetched so
 * far, not from the ones it held. A limit chosen at the press (the walk's) is gone by then, so a
 * refetch at the ordinary page size would bring back a quarter of the rows: the wall shrinks under
 * the reader, the scroll jumps, and a picked set that is no longer "all of" the list loses every
 * card past the new end to pruning. So the limit is decided **at the fetch, against the pages the
 * cache already holds** (`held`): a page that starts inside a held page is a refetch, and asks for
 * the rest of that page, so the refetched pages end exactly where the held ones did. Only a page
 * past everything held is new, and only a new page takes the caller's `want`.
 *
 * Nothing is asked of a caller that never says `want`: its pages are `size` rows, refetched at
 * `size` rows, exactly as before.
 */
export function pageLimit(
  offset: number,
  held: readonly { items: readonly unknown[] }[] | undefined,
  size: number,
  max: number,
  want: number | undefined,
): number {
  let start = 0;
  for (const page of held ?? []) {
    const end = start + page.items.length;
    // A refetch of a page this list already holds: the rest of it, so the next page starts where
    // the held one after it did. Never under the ordinary size — a short last page is the end of
    // the data and asking for a full one costs nothing.
    if (offset < end) return clamp(end - offset, size, max);
    start = end;
  }
  return want === undefined ? size : clamp(want, size, max);
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, Math.ceil(value)));
}
