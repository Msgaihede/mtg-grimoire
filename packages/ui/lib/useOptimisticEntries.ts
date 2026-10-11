/**
 * The **optimistic cache arithmetic** both of the app's own lists share — rewrite one entry
 * wherever its list is cached, take a snapshot before a write, and put the snapshot back when the
 * backend refuses it.
 *
 * **One hook since issue #557, where it was two copies of the same three functions.**
 * `useCollectionEntryWrites` and `useWishEntryWrites` each carried `patchEntry` / `patchWish`,
 * `snapshot` and `restore` almost verbatim — the same `setQueriesData` walk over every cached
 * filter combination, the same `total` arithmetic on a removal, the same restore loop — differing
 * only in the query key and the row type. Two copies of one rule are two places for a fix to land
 * in one of them, so the rule lives here and both hooks are built on it.
 *
 * **What is not here is as deliberate as what is.** The two lists *settle* differently — the
 * collection re-reads its summaries and pointedly not its list, the wishlist re-reads its whole
 * root — and each of those decisions carries its own argument at its own site, so the settles stay
 * in their hooks. This is the part with no argument left in it: arithmetic over a cache.
 *
 * The list's pages must be the `{ items, total }` shape both lists answer
 * (`CollectionPage`/`WishlistPage` in `ipc.ts`), and `listKey` must be **held still** — a module
 * constant — because the three callbacks are keyed on it, and a fresh array every render would
 * hand every caller three new functions every render.
 */
import { useCallback } from "react";
import { useQueryClient, type InfiniteData, type QueryKey } from "@tanstack/react-query";

/** One page of an entry list — the shape `collection_list` and `wishlist_list` both answer. */
export interface EntryPage<Row> {
  items: Row[];
  /** The whole list's count, which every page carries a copy of. */
  total: number;
}

/** What {@link useOptimisticEntries}' `snapshot` takes, and its `restore` puts back. */
export type EntrySnapshot<Row> = [QueryKey, InfiniteData<EntryPage<Row>> | undefined][];

/**
 * The three optimistic primitives over one list's cache.
 *
 * @param listKey The prefix every cached copy of the list sits under — `["collection", "list"]`,
 *   `["wishlist", "list"]` — so a patch reaches every filter combination at once. Held still by the
 *   caller.
 */
export function useOptimisticEntries<Row extends { id: number }>(listKey: QueryKey) {
  const queryClient = useQueryClient();

  /**
   * Rewrite one entry wherever the list is cached — `next` maps the row to its new self, and
   * `null` takes it out.
   *
   * Every cached filter combination, not just the one on screen: the same row is in the
   * "everything" list and in every narrowed list the reader came from, and a press that fixed one
   * and left the other would show two different numbers for one card one filter click apart.
   *
   * A cache that does not hold the row is handed back **as itself**, not as a copy — so a patch
   * leaves every list the row is not in exactly as it was.
   */
  const patchEntry = useCallback(
    (id: number, next: ((row: Row) => Row) | null) => {
      queryClient.setQueriesData<InfiniteData<EntryPage<Row>>>({ queryKey: listKey }, (data) => {
        if (!data || !data.pages.some((p) => p.items.some((r) => r.id === id))) return data;
        return {
          ...data,
          pages: data.pages.map((page) =>
            next === null
              ? {
                  items: page.items.filter((r) => r.id !== id),
                  // Every page carries the same count of the whole list, so every page's
                  // copy of it moves — otherwise the header the *first* page feeds would go
                  // on counting a row that is gone.
                  total: Math.max(0, page.total - 1),
                }
              : { ...page, items: page.items.map((r) => (r.id === id ? next(r) : r)) },
          ),
        };
      });
    },
    [queryClient, listKey],
  );

  /** Undo, for a write the backend refused — every cached copy of the list, as it is now. */
  const snapshot = useCallback(
    (): EntrySnapshot<Row> =>
      queryClient.getQueriesData<InfiniteData<EntryPage<Row>>>({ queryKey: listKey }),
    [queryClient, listKey],
  );
  /** And the undo itself: each copy {@link snapshot} took, put back under its own key. */
  const restore = useCallback(
    (saved: EntrySnapshot<Row>) => {
      for (const [key, data] of saved) queryClient.setQueryData(key, data);
    },
    [queryClient],
  );

  return { patchEntry, snapshot, restore };
}
