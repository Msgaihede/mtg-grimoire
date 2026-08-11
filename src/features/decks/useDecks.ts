import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ipc, type DeckInput, type DeckPatch, type DeckRow } from "@/lib/ipc";

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
   * The collection and the wishlist are deliberately left alone: `allocate_deck` writes
   * `deck_allocations` and never once touches `collection_entries` — spec §6's
   * non-destructive model is exactly that sentence — so neither list can have moved.
   */
  const invalidate = () => void queryClient.invalidateQueries({ queryKey: ["decks"] });

  const create = useMutation({
    mutationFn: (deck: DeckInput) => ipc.deckCreate(deck),
    onSuccess: invalidate,
  });

  const update = useMutation({
    mutationFn: ({ id, patch }: { id: number; patch: DeckPatch }) => ipc.deckUpdate(id, patch),
    onSuccess: invalidate,
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
    onSuccess: invalidate,
  });

  const duplicate = useMutation({
    mutationFn: (id: number) => ipc.deckDuplicate(id),
    onSuccess: invalidate,
  });

  /**
   * File the deck under a folder — or, with `folderId: null`, back at the **root** of the tree.
   *
   * **A command of its own, and not a {@link DeckPatch} field.** `update` above writes every
   * column with `coalesce(?n, column)`, so a bound NULL there reads as "leave it alone": there
   * is no patch that can un-file a deck, and a drag out of a folder written as one is a write
   * that silently does nothing. Here `null` is an argument with a meaning.
   *
   * Invalidates on **error** as well as on success — `useDeck`'s rule, kept on the single
   * definition rather than on a call site, because two definitions are two places to keep one
   * rule. A refusal here is a busy database or a deck (or a folder) another surface has already
   * deleted, and the second must not leave a tile painted in a drawer it is not in.
   */
  const setFolder = useMutation({
    mutationFn: ({ id, folderId }: { id: number; folderId: number | null }) =>
      ipc.deckSetFolder(id, folderId),
    onSuccess: invalidate,
    onError: invalidate,
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
