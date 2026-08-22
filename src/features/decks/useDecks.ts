import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ipc, type DeckInput, type DeckPatch, type DeckRow } from "@/lib/ipc";
import { useDeckWriteRoots } from "@/lib/useDeckDrivenCollection";

/** Stable identity for "no decks yet" — the gallery's `useMemo`s key off this array. */
const NONE: readonly DeckRow[] = [];

/**
 * The deck gallery, and the five writes that are about a deck rather than about a card in
 * one.
 *
 * The list is `["decks", "list"]` under the `["decks"]` root every write in the app
 * invalidates — the same arrangement `useCollection` describes, for the same reason: the
 * gallery and an open editor are two queries over one set of facts, and a rename that
 * refreshed only the tile would leave the editor's header saying the old name.
 *
 * No filters, no pager and no debounce, unlike the other two list hooks. A gallery is tens
 * of decks; `deck_list` answers all of them in one read, sorted (archived last, most
 * recently touched first), and a filter row over forty tiles is chrome that will never be
 * pressed.
 */
export function useDecks() {
  const queryClient = useQueryClient();

  const query = useQuery({ queryKey: ["decks", "list"], queryFn: () => ipc.deckList() });

  /**
   * The whole root, from every write.
   *
   * Not `["decks", "list"]`: a rename changes the tile *and* the header of the editor that
   * deck is open in, and a build toggle rewrites the deck's claims — which is what every
   * `DeckCard.ownedQuantity` in the open detail is attributed from. Only the queries actually
   * mounted pay for a refetch, and at most two of these are ever on screen.
   *
   * **In the hand-kept mode the collection and the wishlist are deliberately left alone**:
   * `allocate_deck` writes `deck_allocations` and never once touches `collection_entries` —
   * spec §6's non-destructive model is exactly that sentence — so neither list can have moved.
   *
   * **While the collection is derived that sentence is still true and no longer sufficient**,
   * which is the whole shape of this setting. Nothing here writes `collection_entries` either;
   * it is that `collection_entries` has stopped being where the collection comes from. Deleting
   * a deck deletes every `deck_cards` row in it, and in that mode those rows *were* the
   * collection — so `remove` empties the collection page of everything that deck held, and
   * `duplicate` doubles it. {@link useDeckWriteRoots} is the list and the gate, and it is
   * additive: `["decks"]` is in both arms, because the five writes here move the gallery in
   * either mode.
   */
  const writeRoots = useDeckWriteRoots();
  const invalidate = () => {
    for (const queryKey of writeRoots) void queryClient.invalidateQueries({ queryKey });
  };

  /**
   * **On error as well as on success, on all five, and kept on the single definition rather
   * than on a call site** — `useDeck`'s rule, and `useDeckMeta`'s and `useDeckFolders`'.
   *
   * Every refusal in this file is either a busy database or a deck another surface has already
   * deleted, and the second must not leave a tile painted in a gallery that has lost it. Four
   * of these five carried `onSuccess` alone while the fifth documented the rule six lines
   * below, which is exactly the shape "two definitions are two places to keep one rule" warns
   * about: a `GONE` from deleting a deck the editor had already deleted left the tile on
   * screen and the gallery never learned.
   */
  const writes = { onSuccess: invalidate, onError: invalidate };

  const create = useMutation({
    mutationFn: (deck: DeckInput) => ipc.deckCreate(deck),
    ...writes,
  });

  const update = useMutation({
    mutationFn: ({ id, patch }: { id: number; patch: DeckPatch }) => ipc.deckUpdate(id, patch),
    ...writes,
  });

  /**
   * The real delete: the deck, its cards and its claims, by cascade.
   *
   * Named `remove` rather than `delete` because `delete` is a reserved word, and offered
   * beside `update`'s `archived` on purpose — archiving is what a gallery's "Remove" should
   * reach for, and this is the one behind a confirmation.
   */
  const remove = useMutation({
    mutationFn: (id: number) => ipc.deckDelete(id),
    ...writes,
  });

  const duplicate = useMutation({
    mutationFn: (id: number) => ipc.deckDuplicate(id),
    ...writes,
  });

  /**
   * File the deck under a folder — or, with `folderId: null`, back at the **root** of the tree.
   *
   * **A command of its own, and not a {@link DeckPatch} field.** `update` above writes every
   * column with `coalesce(?n, column)`, so a bound NULL there reads as "leave it alone": there
   * is no patch that can un-file a deck, and a drag out of a folder written as one is a write
   * that silently does nothing. Here `null` is an argument with a meaning.
   *
   * Invalidates on **error** as well as on success, like every other write here: a refusal is a
   * busy database or a deck (or a folder) another surface has already deleted, and the second
   * must not leave a tile painted in a drawer it is not in.
   */
  const setFolder = useMutation({
    mutationFn: ({ id, folderId }: { id: number; folderId: number | null }) =>
      ipc.deckSetFolder(id, folderId),
    ...writes,
  });

  return {
    query,
    /** Every deck, archived last and most recently touched first. Empty until the first
     *  answer — a gallery with nothing in it and a gallery that has not loaded are told
     *  apart by `query.isPending`, not by this. */
    decks: query.data ?? NONE,
    create,
    update,
    remove,
    duplicate,
    setFolder,
  };
}

/** The whole of what the gallery consumes, named so the view and the hook agree. */
export type Decks = ReturnType<typeof useDecks>;
