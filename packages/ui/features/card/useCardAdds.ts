/**
 * The two **one-press adds** every card surface makes — one copy into the collection, one wish onto
 * the wishlist — with the invalidations each takes and the reason for each, and their **batch
 * twins** for a press over a picked set.
 *
 * **Out of `useCardMenuDeps` on 2026-10-03**, verbatim, so the light app's phone face adds through
 * the same two mutations: the card menu's deps reach the app store (the All printings opener), and
 * the phone face may not (`apps/light/CLAUDE.md`). The menu hook calls these and nothing else about it
 * changed. Each takes the caller's handlers rather than owning a refusal — the menu lifts its
 * sentence into the page, the phone draws a receipt — and the settle runs whatever the caller
 * passed.
 */
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { offerUndo } from "@/lib/bulkUndo";
import { MENU_CONDITION } from "@/lib/conditions";
import { plural } from "@/lib/counts";
import type { Finish } from "@/lib/finish";
import { ipc, type EntryChange, type EntryInput, type WishInput } from "@/lib/ipc";
import { invalidateOwnedWrite, refreshCardSearches } from "@/lib/searchMarks";

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
 * What the collection add sends for one {@link CollectionAddInput} — **one definition for the
 * single add and the batch**, so an item of a batch is exactly the write the single add makes.
 *
 * **`MENU_CONDITION`**: an add that names no grade records that nobody named one, which is a fact,
 * where `NM` would be a guess dressed as one.
 */
function entryInput({ cardId, finish, folderId }: CollectionAddInput): EntryInput {
  return {
    cardId,
    finish,
    condition: MENU_CONDITION,
    quantity: 1,
    // Where the reader pointed, and `null` for the root — never omitted. `folder_id` is the
    // eleventh term of the storage grain, so a folder the caller failed to pass is not a
    // copy filed in the wrong drawer but a *second row* at the root for the same printing.
    folderId,
  };
}

/**
 * One copy of exactly the printing named.
 *
 * The four keys `AddToCollection` invalidates on a collection add, verbatim and for its reasons:
 * the list and its summary, every wish for that card (`ownedQuantity` is summed from
 * `collection_entries`), every deck (a claim is clamped to what the entry still holds), and the
 * search results, which draw `ownedQuantity` on every row and every tile.
 *
 * The item itself is {@link entryInput}'s, shared with {@link useCollectionAddMany}.
 */
export function useCollectionAdd(handlers: CardAddHandlers<CollectionAddInput> = {}) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CollectionAddInput) => ipc.collectionAdd(entryInput(input)),
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

/** What a batch add files, and what its destination is called in the undo offer's sentence. */
export interface AddManyInput<T> {
  items: readonly T[];
  /**
   * The destination, for `Added 300 cards to Binder.` — the caller's word, because the caller
   * already holds the folder list and says the root its own way (`your collection`), exactly as
   * `useSetCollectionFolderMany`'s `destination` is.
   */
  destination: string;
}

/** `Added 300 cards to Binder.` — the undo offer's sentence for a batch add, counted in the items
 *  that landed. */
export function addedLabel(items: number, destination: string): string {
  return `Added ${plural(items, "card")} to ${destination}.`;
}

/**
 * {@link useCollectionAdd} over a picked set — `collection_add_many`: **one** transaction, one
 * activity row and one undo ticket for the whole press, each item under the single add's rules (an
 * item it would refuse is skipped and named in `refused` by its index, while the rest land).
 *
 * The press used to be one `collection_add` per card, and each one settled the four keys below on
 * its own: three hundred cards were three hundred rounds of `["collection"]`, `["wishlist"]`,
 * `["decks"]` and a re-read of every loaded search row's marks — seconds of a frozen window, and
 * past a few hundred, parallel writes told `database is busy`. **The same keys, for the same
 * reasons, fired once** — `invalidateOwnedWrite` is exactly that set (`OWNED_WRITE_KEYS`, with the
 * search's member patched by `refreshCardSearches`).
 *
 * **The undo offer is made here**, `useSetCollectionFolderMany`'s rule: every caller of a bulk
 * write offers it back, so the hook does, and `offerUndo` is a no-op for the `null` ticket a press
 * that landed nothing answers. The receipt toast stays at the caller (the owner's rule: at the
 * deliberate call site, never in a shared hook).
 */
export function useCollectionAddMany() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ items }: AddManyInput<CollectionAddInput>) =>
      ipc.collectionAddMany(items.map(entryInput)),
    onSuccess: (outcome, { destination }) => {
      invalidateOwnedWrite(queryClient);
      offerUndo("collection", outcome.undoId, addedLabel(outcome.added, destination));
    },
  });
}

/**
 * {@link useWishlistAdd} over a picked set — `wishlist_add_many`, one transaction, one activity row
 * and one undo ticket, each wish filed in its own `folderId` and refused alone. Its single twin's
 * two keys, fired once for the press rather than once per wish; the undo offer as
 * {@link useCollectionAddMany} makes it, under the wishlist's scope (`WishlistPage` draws it).
 */
export function useWishlistAddMany() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ items }: AddManyInput<WishInput>) => ipc.wishlistAddMany(items),
    onSuccess: (outcome, { destination }) => {
      void queryClient.invalidateQueries({ queryKey: ["wishlist"] });
      void refreshCardSearches(queryClient);
      offerUndo("wishlist", outcome.undoId, addedLabel(outcome.added, destination));
    },
  });
}
