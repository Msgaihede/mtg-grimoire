import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ipc, type DeckFolder } from "@/lib/ipc";

/** Stable identity for "no folders yet" — a gallery that files nothing is the ordinary case,
 *  and the tree builder's `useMemo` keys off this array. */
const NONE: readonly DeckFolder[] = [];

/**
 * The gallery's filing cabinet: every folder there is, and the four writes that shape it.
 *
 * **Flat rows, and the tree is the reader's to build from `parentId`** — `deck_folders` has no
 * notion of depth and the command takes no deck id, because a folder belongs to no deck: it
 * files them. So there is one query here for the whole app rather than one per deck, and no
 * argument to this hook at all.
 *
 * `["decks", "folders"]`, under the same `["decks"]` root every deck write invalidates. That
 * is not tidiness — it is the only thing that keeps the gallery honest through a **folder
 * delete**, which changes decks this hook never mentions: `decks.folder_id` is
 * `ON DELETE SET NULL`, so the decks inside surface at the root, and a gallery that refreshed
 * only its folder list would keep drawing them in a folder that no longer exists.
 */
export function useDeckFolders() {
  const queryClient = useQueryClient();

  const query = useQuery({ queryKey: ["decks", "folders"], queryFn: () => ipc.deckFolderList() });

  /**
   * The whole root, on success **and** on error — `useDeck`'s rule, on the definition rather
   * than on a call site.
   *
   * A refusal here is a busy database or a folder another surface has already deleted, and the
   * second must not leave a tree drawing a node that is gone. It reaches the deck list as well
   * as this one, which is what a delete needs (see above) and what a move needs too: a deck's
   * `folderId` is on its gallery row, not on any folder.
   */
  const invalidate = () => void queryClient.invalidateQueries({ queryKey: ["decks"] });
  const writes = { onSuccess: invalidate, onError: invalidate };

  /** A new folder — at the root with `parentId: null`, or inside another one. */
  const create = useMutation({
    mutationFn: ({ parentId, name }: { parentId: number | null; name: string }) =>
      ipc.deckFolderCreate(parentId, name),
    ...writes,
  });

  const rename = useMutation({
    mutationFn: ({ id, name }: { id: number; name: string }) => ipc.deckFolderRename(id, name),
    ...writes,
  });

  /**
   * Re-parent a folder; `parentId: null` moves it back to the root.
   *
   * A move into itself or into one of its own descendants is refused by the backend, and that
   * guard is not cosmetic: `deck_folders.parent_id` is `ON DELETE CASCADE` **on itself**, so a
   * cycle is a graph SQLite's recursive cascade would walk forever the day the folder is
   * deleted. A drag-and-drop tree should still grey the illegal targets — the refusal is a
   * fence, not the affordance.
   */
  const move = useMutation({
    mutationFn: ({ id, parentId }: { id: number; parentId: number | null }) =>
      ipc.deckFolderMove(id, parentId),
    ...writes,
  });

  /**
   * **`["decks", "folders"]` alone — the one write in this hook that does not take the whole
   * root**, and the narrowing is the point rather than an oversight.
   *
   * The four writes above each reach *decks* this hook never mentions: a delete `SET NULL`s
   * `decks.folder_id`, and every one of them can be the refusal that means a node on screen is
   * gone. A reorder reaches none. It writes `deck_folders.sort_order` and `deck_folders.parent_id`
   * and nothing else — **no deck's `folder_id` moves**, because the folder a deck is filed in is
   * the same folder afterwards; it is merely sitting somewhere else. So `["decks", "list"]`,
   * `["decks", "categories", …]`, the audit, the undo cursor and the rest are all still true, and
   * invalidating them would refetch the gallery and every open deck to redraw a row of folder
   * cards.
   *
   * **The re-parent half does not widen it either.** What a re-parent changes is the *tree*, and
   * the tree is built in TypeScript from these flat rows — so re-reading the list is exactly what
   * makes a caller's derived shape true again. It is `["decks"]`'s prefix, so this is the same
   * `invalidateQueries` call one rung down rather than a different mechanism.
   *
   * On error as well as on success, `writes`' rule: a refusal here is a busy database or an id in
   * `ids` another surface has already deleted, and the second must not leave a tree drawing a node
   * that is gone.
   */
  const settleOrder = () => void queryClient.invalidateQueries({ queryKey: ["decks", "folders"] });

  /**
   * Place a whole level: `ids` is **every** child of `parentId`, in the order they are to sit in.
   *
   * `sortOrder` is written from position and `parentId` from the argument, in one transaction — so
   * one gesture both re-parents and places, and a reader never sees half of it. Sending only the
   * folder that moved is the mistake the name invites; see `ipc.deckFolderReorder`.
   */
  const reorder = useMutation({
    mutationFn: ({ parentId, ids }: { parentId: number | null; ids: number[] }) =>
      ipc.deckFolderReorder(parentId, ids),
    onSuccess: settleOrder,
    onError: settleOrder,
  });

  /**
   * Delete a folder. Named `remove` for `useDecks`' reason — `delete` is a reserved word.
   *
   * **Its decks are not deleted**, and a confirmation must say so: they surface at the root,
   * filed nowhere and otherwise exactly as they were. Its **sub-folders are**, by cascade. An
   * id that resolves to nothing is a success: the caller wanted that folder gone.
   */
  const remove = useMutation({
    mutationFn: (id: number) => ipc.deckFolderDelete(id),
    ...writes,
  });

  return {
    query,
    /** Every folder, flat. Empty until the first answer — a gallery that files nothing and one
     *  that has not loaded are told apart by `query.isPending`, not by this. */
    folders: query.data ?? NONE,
    create,
    rename,
    move,
    reorder,
    remove,
  };
}

/** The whole of what a folder tree consumes, named so the view and the hook agree. */
export type DeckFolders = ReturnType<typeof useDeckFolders>;
