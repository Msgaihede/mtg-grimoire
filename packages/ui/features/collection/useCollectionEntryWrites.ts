/**
 * The collection's **entry writes** — a row's count stepped, a row removed, several rows removed in
 * one write — and the cache arithmetic all three share: rewrite the row wherever it is cached, put
 * the cache back after a refusal, and the two settle sets.
 *
 * **Out of `CollectionPage` on 2026-10-03**, verbatim, so the light app's phone face presses the
 * same mutations with the same optimistic patches and the same invalidations rather than a second
 * copy of them (`docs/reference/light-app.md` §7.5b). The page calls this hook and nothing else
 * about it changed. It reaches no app store: the undo ticket for a bulk removal is `@/lib/bulkUndo`,
 * which is its own.
 */
import { useCallback } from "react";
import { useMutation, useQueryClient, type InfiniteData } from "@tanstack/react-query";
import { offerUndo } from "@/lib/bulkUndo";
import { plural } from "@/lib/counts";
import { ipc, type CollectionPage as Page, type CollectionRow } from "@/lib/ipc";
import { refreshCardSearches } from "@/lib/searchMarks";

export function useCollectionEntryWrites() {
  const queryClient = useQueryClient();

  /**
   * Rewrite one entry wherever the collection is cached.
   *
   * Every cached filter combination, not just the one on screen: the same row is in the
   * "everything" list and in the "foils only" list, and a stepper press that fixed one and
   * left the other would show two different numbers for one card one filter click apart.
   */
  const patchEntry = useCallback(
    (id: number, next: ((row: CollectionRow) => CollectionRow) | null) => {
      queryClient.setQueriesData<InfiniteData<Page>>(
        { queryKey: ["collection", "list"] },
        (data) => {
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
        },
      );
    },
    [queryClient],
  );

  /** Undo, for a write the backend refused. */
  const snapshot = useCallback(
    () => queryClient.getQueriesData<InfiniteData<Page>>({ queryKey: ["collection", "list"] }),
    [queryClient],
  );
  const restore = useCallback(
    (saved: ReturnType<typeof snapshot>) => {
      for (const [key, data] of saved) queryClient.setQueryData(key, data);
    },
    [queryClient],
  );

  /**
   * What every write here has in common: the header re-fetches, the search is marked stale,
   * and the list is *not* re-fetched — the row's own number has already been rewritten from
   * the answer, and re-reading a hundred rows because one of them changed by one is a round
   * trip nobody is waiting for. A wrong total, though, is a worse lie than a slow one.
   */
  const settle = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ["collection", "summary"] });
    // And the folder subtotals, for the header's own reason one level down: `cards` is
    // `sum(quantity)` and `value` is `sum(quantity * unit_price)`, so a stepper press on a filed
    // row moves the card above it by exactly the amount it moved the header. This is the wishlist's
    // 2026-08-22 lesson stated in the collection's terms — a folder card went on saying
    // `2 wishes · $20.00` over a drawer holding one, because the argument that "the row's own
    // number is already the answer" is true about the *row* and false about everything counted
    // from it. **Neither repairs itself at the app's own `staleTime`** (`lib/query.ts`, 30s): this
    // query's observer is mounted for the life of the page, so marking it stale without a refetch
    // changes nothing.
    //
    // Named rather than folded into `["collection"]`, which would take the list with it — the
    // paragraph above is why the list is deliberately left alone here.
    void queryClient.invalidateQueries({ queryKey: ["collection", "folderSummary"] });
    // And the headings, for the same reason one level further down: a heading's figures are
    // `collection_shelf_counts` rolled up the tree, so a stepper press on a filed row moves the
    // heading over it by exactly what it moved the header — and the counts query is mounted for the
    // life of the page, so a stale mark alone would change nothing.
    void queryClient.invalidateQueries({ queryKey: ["collection", "shelfCounts"] });
    // The wishlist counts this list: a wish's `ownedQuantity` is computed from
    // `collection_entries`, so a stepper press has just made every cached wish for that card
    // wrong. The same pair `AddToCollection` invalidates, for the same reason — a write here
    // is the same write it makes.
    void queryClient.invalidateQueries({ queryKey: ["wishlist"] });
    // And the search results, which draw `ownedQuantity` on every row now. Brought up to date
    // rather than merely marked — an active search is patched in place (`@/lib/searchMarks`),
    // and one that is not on screen is only marked stale.
    void refreshCardSearches(queryClient);
    // And every deck. Since schema v25 a deck owns what its own group physically holds, summed
    // per oracle id, so the row this stepper just changed *is* a deck's arithmetic if it is
    // filed in a deck group — and is spare for every theory list if it is not. Either way what
    // that deck says it owns, and the shortfall its "missing to wishlist" button would buy,
    // moved without the deck being touched at all. There is nothing left to recompute: the
    // number is read off the folder at read time rather than kept in a claim table.
    void queryClient.invalidateQueries({ queryKey: ["decks"] });
  }, [queryClient]);

  /**
   * What a refused write leaves behind, on either path.
   *
   * The whole view, not just the list: a refused write is usually a row something else
   * already removed (`GONE`), and a collection that has lost a row has also lost the copies,
   * the value and the unique count that row was part of — measured live, the header went on
   * counting a deleted entry until this reached past the table. The wishlist and the search
   * go with it for the same reason a success takes them: the copies that deletion took are
   * copies some wish counted as owned and some result row is badged with.
   */
  const settleFailure = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ["collection"] });
    void queryClient.invalidateQueries({ queryKey: ["wishlist"] });
    void refreshCardSearches(queryClient);
    void queryClient.invalidateQueries({ queryKey: ["decks"] });
  }, [queryClient]);

  const setQuantity = useMutation({
    // The row by its id alone (`Pick`), so a caller holding only an `EntryChange` — the phone's
    // undo of an add — can step it back through this same write.
    mutationFn: ({ row, quantity }: { row: Pick<CollectionRow, "id">; quantity: number }) =>
      ipc.collectionSetQuantity(row.id, quantity),
    // Optimistic on the row's own number and nothing else. Without it, holding `+` sends
    // the same number three times — the box is controlled by the cache, so a second press
    // before the first answer would be computed from a stale value.
    onMutate: ({ row, quantity }) => {
      const saved = snapshot();
      patchEntry(row.id, (r) => ({ ...r, quantity }));
      return saved;
    },
    onError: (_error, _variables, saved) => {
      if (saved) restore(saved);
      settleFailure();
    },
    onSuccess: (change) => {
      // The answer, not the guess: the backend clamps and canonicalises, and this is the
      // number it actually stored — **or says the row is not there any more**.
      //
      // `removed` is not decoration. Since schema v24 `collection::set_quantity(id, 0)`
      // *deletes* the entry, and the stepper is `min={0}`, so one press on a single copy is a
      // delete. Read as "quantity 0" it left a ghost: the row stayed in the list, dimmed,
      // while `settle()` — which deliberately does not re-read the list — had already sent the
      // header off to count a collection the row is no longer in, so the two disagreed on
      // screen instantly, and the next `+` on the ghost answered GONE. `remove.onSuccess`
      // below is these same two lines, and this is the same write with a different gesture.
      patchEntry(change.id, change.removed ? null : (r) => ({ ...r, quantity: change.quantity }));
      settle();
    },
  });

  const remove = useMutation({
    mutationFn: (row: Pick<CollectionRow, "id">) => ipc.collectionRemove(row.id),
    // No optimistic half, so nothing to roll back: the row is dropped from the answer rather
    // than from the press, because a removal is one click and does not have to survive being
    // held down. The failure path is the stepper's, though — a refusal here means the same
    // thing it means there, and used to mean nothing at all.
    onError: settleFailure,
    onSuccess: (change) => {
      patchEntry(change.id, null);
      settle();
    },
  });

  /**
   * The card menu's `Remove from collection` — issue #506's press, and since issue #555 **one
   * write**: `collection_remove_many`, every entry the press reaches in one transaction with one
   * activity row.
   *
   * **It was a loop of {@link remove}'s command**, one transaction per entry, and that was the
   * gap the issue named: N feed lines for one press, and a refusal part-way left it half applied —
   * the rows before it gone, the rest still there, and one sentence in the banner about the one
   * that stopped it. `cardMenu.test.tsx` asserted "one call" of the menu's dep and passed while
   * this looped, because the loop was here. Now a refusal takes nothing, and
   * {@link settleFailure} re-reads the list so the wall shows exactly that.
   *
   * **The answer is offered back** — the ticket goes to `@/lib/bulkUndo` with a sentence counted
   * in entries, the menu row's unit, so the notice under the header says what the row said. One
   * entry names the card instead, because `Removed 1 card` says less than the name the reader
   * pointed at. `name` rides the variables because by `onSuccess` the row is already on its way
   * out of the cache.
   *
   * Which targets may reach this at all is the menu deps' decision ({@link countEditable}, asked of
   * every row behind the target), not this write's — `collection_remove_many` is the
   * unconditional delete. Whether it asks first is {@link removeCopies}'.
   */
  const removeMany = useMutation({
    mutationFn: ({ entryIds }: { entryIds: readonly number[]; name: string | null }) =>
      ipc.collectionRemoveMany(entryIds),
    onError: settleFailure,
    onSuccess: (outcome, { entryIds, name }) => {
      for (const id of entryIds) patchEntry(id, null);
      settle();
      offerUndo(
        "collection",
        outcome.undoId,
        outcome.removed === 1 && name !== null
          ? `Removed ${name} from your collection.`
          : `Removed ${plural(outcome.removed, "card")} from your collection.`,
      );
    },
  });

  return { patchEntry, settle, settleFailure, setQuantity, remove, removeMany };
}

export type CollectionEntryWrites = ReturnType<typeof useCollectionEntryWrites>;
