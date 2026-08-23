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
   * deck is open in, and every `DeckCard.ownedQuantity` in the open detail is a sum over the
   * deck's collection group. Only the queries actually mounted pay for a refetch, and at most
   * two of these are ever on screen.
   *
   * **The wishlist is deliberately left alone** by all five: no quantity changes and no
   * printing is added or dropped, so no wish's `ownedQuantity` can be different afterwards.
   */
  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ["decks"] });
  };

  /**
   * **And the collection's root too, for the four writes that move a `collection_folders` row.**
   *
   * This is the sentence that used to read *"`allocate_deck` writes `deck_allocations` and never
   * once touches `collection_entries`"*, and schema v25 made it false: a deck's group **is** a
   * collection folder, so `deck_create` and `deck_duplicate` insert one, a rename renames one,
   * and `deck_delete` files every copy the group was holding into `Recently removed` and drops
   * the folder. After any of those the collection page's tree, its list, its summary and both
   * folder cards are describing a world that is gone, and `["decks"]` reaches none of them —
   * which is the ghost-row class PR 2 shipped. Marking is not enough on its own either:
   * `lib/query.ts` sets `staleTime: 30_000`, so a mounted observer that is merely stale never
   * refetches.
   *
   * **Two of the five do not take it**, and the absence is as deliberate as the presence.
   * `setFolder` files the deck into a `deck_folders` row — the gallery's own tree, which the
   * collection page has never drawn. And a patch is only a group write when it carries a
   * `name`: archiving a deck, choosing a cover or changing a format leaves every folder exactly
   * where it was, so firing the root for one would be a refetch that can only answer what is
   * already on screen.
   */
  const invalidateCollection = () => {
    void queryClient.invalidateQueries({ queryKey: ["collection"] });
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

  /**
   * The same rule plus {@link invalidateCollection}, for the three writes that always move a
   * folder. **On error as well**, for `writes`' reason read one table over: a refused create
   * that had already inserted the group is not a shape the backend can produce — both halves
   * are one transaction — but a refusal the *webview* saw and the database did not is, and that
   * is the one a re-read exists for.
   */
  const groupWrites = {
    onSuccess: () => {
      invalidate();
      invalidateCollection();
    },
    onError: () => {
      invalidate();
      invalidateCollection();
    },
  };

  const create = useMutation({
    mutationFn: (deck: DeckInput) => ipc.deckCreate(deck),
    ...groupWrites,
  });

  const update = useMutation({
    mutationFn: ({ id, patch }: { id: number; patch: DeckPatch }) => ipc.deckUpdate(id, patch),
    onSuccess: (_row, { patch }) => {
      invalidate();
      // The rename arm of {@link invalidateCollection}: `deck_update` renames the deck's group
      // when — and only when — the patch names a name, so this is the one patch key that can
      // reach a collection folder.
      if (patch.name !== undefined) invalidateCollection();
    },
    onError: (_error, { patch }) => {
      invalidate();
      if (patch.name !== undefined) invalidateCollection();
    },
  });

  /**
   * The real delete: the deck, its cards, its categories and its history, by cascade.
   *
   * **And its copies, which is the half that is not a cascade.** `delete_deck` walks the
   * group's sub-tree and files every `collection_entries` row in it into `Recently removed`,
   * one at a time and before the `DELETE`, because a `deck_cards` row is an intention and a row
   * in the group is a card the reader physically owns. So this takes the collection's root as
   * well — see {@link invalidateCollection}.
   *
   * Named `remove` rather than `delete` because `delete` is a reserved word, and offered
   * beside `update`'s `archived` on purpose — archiving is what a gallery's "Remove" should
   * reach for, and this is the one behind a confirmation.
   */
  const remove = useMutation({
    mutationFn: (id: number) => ipc.deckDelete(id),
    ...groupWrites,
  });

  /** A copy of the deck, its piles and its cards — and a **group of its own**, made by
   *  `create_deck_group` in the same transaction, which is why this takes the collection's
   *  root. The copy's group starts empty: copies are custody, and duplicating a list does not
   *  duplicate cards. */
  const duplicate = useMutation({
    mutationFn: (id: number) => ipc.deckDuplicate(id),
    ...groupWrites,
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
