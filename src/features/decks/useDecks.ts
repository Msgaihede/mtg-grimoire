import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ipc, type DeckInput, type DeckPatch, type DeckRow } from "@/lib/ipc";

/** Stable identity for "no decks yet" — the gallery's `useMemo`s key off this array. */
const NONE: readonly DeckRow[] = [];

/**
 * The deck gallery, and the four writes that are about a deck rather than about a card in
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
  };
}

/** The whole of what the gallery consumes, named so the view and the hook agree. */
export type Decks = ReturnType<typeof useDecks>;
