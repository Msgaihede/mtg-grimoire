/**
 * The wishlist's **entry writes** — a wish's count stepped, a wish crossed off, a wish filed in
 * another folder, a wish taken back to any printing — and the cache arithmetic they share.
 *
 * **Out of `WishlistPage` on 2026-10-03**, verbatim, so the light app's phone face presses the
 * same mutations with the same optimistic patches and the same `settleWhole` rather than a second
 * copy of them (`docs/reference/light-app.md` §7.5b). The page calls this hook and nothing else
 * about it changed; its drop-to-add stays on the page, because it is about a drag.
 *
 * **None of these knows about a managed folder**, and none needs to: the backend refuses every
 * hand write into or out of one in `MANAGED_REFUSAL`'s words (`./managed.ts`), and a surface that
 * draws no control over a managed wish is the first fence, not this hook.
 */
import { useCallback } from "react";
import { useMutation, useQueryClient, type InfiniteData } from "@tanstack/react-query";
import { ipc, type WishlistPage as Page, type WishRow } from "@/lib/ipc";
import { refreshCardSearches } from "@/lib/searchMarks";

export function useWishEntryWrites() {
  const queryClient = useQueryClient();

  /**
   * Rewrite one wish wherever the wishlist is cached.
   *
   * Every cached filter combination, not just the one on screen: the same wish is in the
   * "everything" list and in whatever narrowed list the reader came from, and a stepper press
   * that fixed one and left the other would show two different numbers for one card one filter
   * click apart.
   */
  const patchWish = useCallback(
    (id: number, next: ((row: WishRow) => WishRow) | null) => {
      queryClient.setQueriesData<InfiniteData<Page>>({ queryKey: ["wishlist", "list"] }, (data) => {
        if (!data || !data.pages.some((p) => p.items.some((r) => r.id === id))) return data;
        return {
          ...data,
          pages: data.pages.map((page) =>
            next === null
              ? {
                  items: page.items.filter((r) => r.id !== id),
                  // Every page carries the same count of the whole list, so every page's copy
                  // of it moves — otherwise the header the *first* page feeds would go on
                  // counting a wish that is gone.
                  total: Math.max(0, page.total - 1),
                }
              : { ...page, items: page.items.map((r) => (r.id === id ? next(r) : r)) },
          ),
        };
      });
    },
    [queryClient],
  );

  /** Undo, for a write the backend refused. */
  const snapshot = useCallback(
    () => queryClient.getQueriesData<InfiniteData<Page>>({ queryKey: ["wishlist", "list"] }),
    [queryClient],
  );
  const restore = useCallback(
    (saved: ReturnType<typeof snapshot>) => {
      for (const [key, data] of saved) queryClient.setQueryData(key, data);
    },
    [queryClient],
  );

  /**
   * How **every** write on this page finishes: the whole `["wishlist"]` root re-read, and the
   * card search with it.
   *
   * The search, because a result row draws `wishlisted`: adding or clearing a wish changes the
   * heart on every printing of that card, and a wall that goes on showing one for a wish the
   * reader just crossed off is wrong on screen rather than stale in a cache. Nothing further out
   * moves — a wish write moves no copies, so the collection and its header are untouched.
   *
   * **`["wishlist"]` rather than the three keys under it**, because it covers the list, the
   * folder list and the summary at every marketplace at once, and because that is the shape of
   * the other wishlist writes in this app: `useWishlistFolders`' (whose two wish-deleting ones
   * take the card search too, for the reason below), the card menu's
   * add, the deck sweeps'. One page inventing a narrower settle is how the three fell out of step
   * in the first place.
   *
   * **One function for every caller here, because the reason is the same shape in all of them:
   * the answer is not something this page can compute.**
   *
   * * A *refusal* is almost always a row something else already deleted, and a list that has lost
   *   a row has lost the total and the cost it was part of.
   * * A *filing* is the same problem wearing the other hat: the wish is now in a list this page is
   *   not drawing, at a sort position and on a page only the backend knows, and two folder
   *   subtotals have moved with it.
   * * And the **stepper and the removal** are the same problem again, which is what this function
   *   did not cover until 2026-08-22. Those two shipped patching the list and re-reading the
   *   search alone, on the argument that the row's own number was already the answer. That
   *   argument is true about the *row* and false about everything counted from it, in two ways a
   *   reader acts on. `wishlist_folder_summary` is a `GROUP BY` carrying an owned-copies subquery
   *   and a price expression — arithmetic this page cannot redo — so a folder card went on saying
   *   `Ordered folder, 2 wishes, $20.00` over a drawer holding one, which on a shopping list is
   *   the subtotal somebody buys against. And `elsewhere` is a correlated count over the whole
   *   table, so crossing off one of two duplicates left the survivor still marked
   *   "Also on your wishlist…" — the one mark whose entire job is honesty about duplicates,
   *   pointing at a wish that no longer exists. **Neither repairs itself at the app's own
   *   `staleTime`** (`lib/query.ts`, 30s): the summary's observer is mounted for the life of this
   *   page, so marking it stale without a refetch changes nothing, and the suite's default of 0
   *   hides the whole class.
   *
   * {@link patchWish} is not replaced by any of this and stays where it was. It is what the
   * reader sees at the moment of the press — a stepper the cache controls must not be computed
   * from a value a round trip is still on its way to confirm — and the re-read behind it is for
   * the figures the press moved that this page was never holding.
   */
  const settleWhole = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ["wishlist"] });
    void refreshCardSearches(queryClient);
  }, [queryClient]);

  const setQuantity = useMutation({
    // The wish by its id alone (`Pick`), so a caller holding only an `EntryChange` — the phone's
    // undo of an add — can step it back through this same write.
    mutationFn: ({ row, quantity }: { row: Pick<WishRow, "id">; quantity: number }) =>
      ipc.wishlistSetQuantity(row.id, quantity),
    // Optimistic on the row's own number and nothing else. Without it, holding `+` sends the
    // same number three times — the box is controlled by the cache, so a second press before
    // the first answer would be computed from a stale value.
    //
    // **It writes a `0` into the row for one round trip now that the stepper's floor is zero
    // (issue #284), and that is accepted rather than special-cased** — the collection's twin
    // accepts the same one. Guessing the *removal* here instead is the guess this page is not
    // entitled to make: a refusal would then have to put a row back at a sort position and on a
    // page only the backend knows, which is the argument {@link setFolder} makes at length about
    // its own write. What a reader sees in the meantime is the number they pressed to, on a row
    // that leaves a few milliseconds later — a stepper that reported a different number from the
    // one under their finger would be worse than a row that lingers.
    onMutate: ({ row, quantity }) => {
      const saved = snapshot();
      patchWish(row.id, (r) => ({ ...r, quantity }));
      return saved;
    },
    onError: (_error, _variables, saved) => {
      if (saved) restore(saved);
      settleWhole();
    },
    onSuccess: (change) => {
      // The answer, not the guess: the backend clamps and canonicalises, and this is the
      // number it actually stored — **or says the row is not there any more**. Then the
      // re-read, for what the new number is counted into — the folder subtotal a copy count
      // multiplies straight through.
      //
      // `removed` is not decoration. `set_wish_quantity(id, 0)` returns `remove_wish(conn, id)`
      // — `wishlist_entries.quantity` carries `CHECK (quantity > 0)`, so it always has — and
      // since issue #284 the stepper is `min={0}`, which puts that delete one press away on a
      // single-copy wish.
      //
      // **What reading the answer as "quantity 0" costs here is a round trip, not a permanent
      // ghost**, and the distinction is worth getting right because the collection's twin
      // handler has the harsher version of it. {@link settleWhole} invalidates `["wishlist"]`
      // *whole* and this list's own key is `["wishlist", "list", …]` (`useWishlist.ts`), so the
      // refetch does take the row — eventually. Until it lands the wish sits in the list wanting
      // none of something, and the `+` beside it answers GONE. That is exactly what
      // `remove.onSuccess` below refuses to let a crossed-off wish do: "the row goes at once —
      // a crossed-off wish must not sit there for the length of a round trip". A
      // removal and a stepper taken to zero are **one write with two gestures**, so the two
      // handlers are the same two lines; anything else is one gesture behaving differently from
      // the other for a reason no reader could name.
      //
      // `CollectionPage`'s handler is these same two lines and its comment carries the live
      // sighting — but not its reason: `settle()` there re-reads the summaries and pointedly
      // **not** the list, so the same misreading leaves a row that outlives every round trip.
      // Do not port that sentence back here.
      patchWish(change.id, change.removed ? null : (r) => ({ ...r, quantity: change.quantity }));
      settleWhole();
    },
  });

  const remove = useMutation({
    mutationFn: (row: Pick<WishRow, "id">) => ipc.wishlistRemove(row.id),
    onError: settleWhole,
    onSuccess: (change) => {
      // The row goes at once — a crossed-off wish must not sit there for the length of a round
      // trip — and then everything the row was part of is re-read: the folder it was filed in,
      // and the `elsewhere` mark on whatever duplicate it left behind.
      patchWish(change.id, null);
      settleWhole();
    },
  });

  /**
   * Filing a wish — the drag's write and the panel's, which are one command and deliberately one
   * mutation: spec §9 says both routes reach `wishlist_set_folder`, so a merge behaves the same
   * whichever hand made the gesture.
   *
   * **This is the one write on the page that is deliberately not optimistic**, and the reason is
   * what a move actually changes: not a number the reader is holding down, but *which list the
   * row belongs to*. Every optimistic answer to that is a guess this page is not entitled to
   * make.
   *
   * * Taking the row off the level is the guess it shipped with, and the live pass found it wrong
   *   three ways at once (2026-08-22): the row left the list and **nothing ever put it back**, so
   *   a filed wish was gone from the app until a reload; the destination folder went on saying
   *   "Nothing filed here yet." under a card already counting the wish; and the header
   *   under-counted by one on the way *out* to the root as well as on the way in. Only the merge
   *   path re-read, so a plain move — the common one — was the case nothing covered.
   * * Putting the row in is the other guess, and it is worse: the destination list is sorted and
   *   paged by the backend, so an insert has to invent both the position and the page, then be
   *   undone whenever the answer disagrees.
   * * And **a merge answers a different id than the one asked about** — moving a wish into a
   *   folder that already holds the same `(oracleId, cardId, preferredFinish)` sums the two
   *   quantities into the *destination* row and deletes the source — so there is not always a row
   *   left to patch at all.
   *
   * So the answer is a re-read, both ways: {@link settleWhole}. It costs one query over a list of
   * tens of rows, and it is the only thing that is right for the level being left, the level being
   * joined, both folder subtotals and a merge at once. A folder move is one deliberate press
   * rather than a held-down stepper, so there is no second press racing the first — which is the
   * whole reason the stepper beside it *is* optimistic.
   */
  const setFolder = useMutation({
    mutationFn: ({ id, folderId: to }: { id: number; folderId: number | null }) =>
      ipc.wishlistSetFolder(id, to),
    // Either way, and one handler because there is one behaviour: a refusal leaves the list
    // exactly as unknown as a success does, since a refused move is almost always a row another
    // surface has already moved or deleted.
    onSettled: settleWhole,
  });

  /**
   * Back to **any printing** — the second of spec §5's two printing writes, and the only one
   * this page makes itself: pinning a wish to a printing is a press in the All printings modal,
   * which owns that half (spec §6).
   *
   * Optimistic on the four columns this page can honestly guess — the printing, its set, its
   * number and its language all clear together, and `needs_review` clears with them, because
   * choosing the printing by hand *is* the review a flagged wish was waiting for. The caption
   * flips to "Any printing" on the press, which is the feedback the reader asked for.
   *
   * **The answer is a re-read rather than a patch, and that is where this parts company with the
   * stepper above — which re-reads too, but holds its own row's number.** Every write on this
   * page settles the same way now; the difference is how much of the row survives the settle.
   * Un-pinning does not merely clear columns: the backend re-resolves the wish
   * against the newest printing of its oracle card, so the art the tile is drawn as, its rarity,
   * its mana cost and its unit price are all different afterwards and none of them is derivable
   * here. And this write **merges** on the same rule `wishlist_set_folder` does — un-pinning a
   * wish for the Alpha Bolt when an any-printing Bolt already sits in the same folder is the
   * reader saying they are one wish — so the `EntryChange` may not even name the row that was
   * asked about.
   */
  const anyPrinting = useMutation({
    mutationFn: (row: Pick<WishRow, "id">) => ipc.wishlistSetPrinting(row.id, null),
    onMutate: (row) => {
      const saved = snapshot();
      patchWish(row.id, (r) => ({
        ...r,
        cardId: null,
        setCode: null,
        collectorNumber: null,
        lang: null,
        needsReview: null,
      }));
      return saved;
    },
    onError: (_error, _variables, saved) => {
      if (saved) restore(saved);
      settleWhole();
    },
    onSuccess: settleWhole,
  });

  /**
   * **Pinned to one printing** — the other half of {@link anyPrinting}, and the write the desktop's
   * All printings modal makes when it is opened about a wish (`AllPrintingsDialog`'s `repoint`):
   * `wishlist_set_printing` with the printing pressed, settled by `["wishlist"]` and the search's
   * hearts, which is {@link settleWhole}. Not optimistic, for the modal's reason: the write merges
   * onto a wish already in the folder for that printing, so the answer may name a different row.
   *
   * **Here for the light app's phone face**, which lists the printings in its own sheet rather than
   * opening the modal; the modal keeps its own copy of the mutation because it closes itself on
   * the answer, and both are the one command with the one settle.
   */
  const setPrinting = useMutation({
    mutationFn: ({ row, cardId }: { row: Pick<WishRow, "id">; cardId: string }) =>
      ipc.wishlistSetPrinting(row.id, cardId),
    onSettled: settleWhole,
  });

  return { patchWish, settleWhole, setQuantity, remove, setFolder, anyPrinting, setPrinting };
}

export type WishEntryWrites = ReturnType<typeof useWishEntryWrites>;
