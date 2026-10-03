/**
 * The two **one-press adds** every card surface makes — one copy into the collection, one wish onto
 * the wishlist — with the invalidations each takes and the reason for each.
 *
 * **Out of `useCardMenuDeps` on 2026-10-03**, verbatim, so the light app's phone face adds through
 * the same two mutations: the card menu's deps reach the app store (the All printings opener), and
 * the phone face may not (`mobile/CLAUDE.md`). The menu hook calls these and nothing else about it
 * changed. Each takes the caller's handlers rather than owning a refusal — the menu lifts its
 * sentence into the page, the phone draws a receipt — and the settle runs whatever the caller
 * passed.
 */
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { MENU_CONDITION } from "@/lib/conditions";
import type { Finish } from "@/lib/finish";
import { ipc, type EntryChange, type WishInput } from "@/lib/ipc";
import { refreshCardSearches } from "@/lib/searchMarks";

/** What a caller may hang on one of the adds. */
export interface CardAddHandlers<V> {
  onMutate?: (variables: V) => void;
  onSuccess?: (change: EntryChange, variables: V) => void;
  onError?: (error: unknown, variables: V) => void;
}

/** One copy of a printing, in a finish, into a folder (`null` is the root). */
export interface CollectionAddInput {
  cardId: string;
  finish: Finish;
  folderId: number | null;
}

/**
 * One copy of exactly the printing named.
 *
 * The four keys `AddToCollection` invalidates on a collection add, verbatim and for its reasons:
 * the list and its summary, every wish for that card (`ownedQuantity` is summed from
 * `collection_entries`), every deck (a claim is clamped to what the entry still holds), and the
 * search results, which draw `ownedQuantity` on every row and every tile.
 *
 * **`MENU_CONDITION`**: an add that names no grade records that nobody named one, which is a fact,
 * where `NM` would be a guess dressed as one.
 */
export function useCollectionAdd(handlers: CardAddHandlers<CollectionAddInput> = {}) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ cardId, finish, folderId }: CollectionAddInput) =>
      ipc.collectionAdd({
        cardId,
        finish,
        condition: MENU_CONDITION,
        quantity: 1,
        // Where the reader pointed, and `null` for the root — never omitted. `folder_id` is the
        // eleventh term of the storage grain, so a folder the caller failed to pass is not a
        // copy filed in the wrong drawer but a *second row* at the root for the same printing.
        folderId,
      }),
    onMutate: (variables) => handlers.onMutate?.(variables),
    onSuccess: (change, variables) => {
      void queryClient.invalidateQueries({ queryKey: ["collection"] });
      void queryClient.invalidateQueries({ queryKey: ["wishlist"] });
      void queryClient.invalidateQueries({ queryKey: ["decks"] });
      void refreshCardSearches(queryClient);
      handlers.onSuccess?.(change, variables);
    },
    onError: (error, variables) => handlers.onError?.(error, variables),
  });
}

/**
 * One wish, as the caller spells it — a printing (`cardId`) or a card in any printing (`oracleId`
 * and `name`), with the folder it is filed in.
 *
 * Two keys rather than four: a wish is a copy the reader does not have, so it moves no collection
 * figure and no deck's arithmetic. The search results are re-read because every row draws
 * `wishlisted`.
 */
export function useWishlistAdd(handlers: CardAddHandlers<WishInput> = {}) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (wish: WishInput) => ipc.wishlistAdd(wish),
    onMutate: (variables) => handlers.onMutate?.(variables),
    onSuccess: (change, variables) => {
      void queryClient.invalidateQueries({ queryKey: ["wishlist"] });
      void refreshCardSearches(queryClient);
      handlers.onSuccess?.(change, variables);
    },
    onError: (error, variables) => handlers.onError?.(error, variables),
  });
}
