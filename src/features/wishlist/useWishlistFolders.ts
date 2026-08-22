import { useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ipc, type WishlistFolder } from "@/lib/ipc";
import { useMarketplace } from "@/lib/useMarketplace";

/** Stable identity for "no folders yet" — a wishlist that files nothing is the ordinary case,
 *  and the tree builder's `useMemo` does not see a new identity every render. */
const NONE: readonly WishlistFolder[] = [];

/**
 * The wishlist's filing cabinet: every folder there is, the four writes that shape them, and
 * the per-folder summary a folder card is drawn from.
 *
 * **Flat rows, and the tree is the reader's to build from `parentId`** — `wishlist_folders` has
 * no notion of depth and the command takes no wish id, because a folder belongs to no wish: it
 * files them. So there is one query here for the whole app rather than one per wish, and no
 * argument to this hook at all.
 *
 * **Both keys sit under `["wishlist"]`** — `["wishlist", "folders"]` and
 * `["wishlist", "folderSummary", marketplace.id]`. That is not tidiness. Every wish write in
 * this app already fires `invalidateQueries({ queryKey: ["wishlist"] })`, so a folder card's
 * count and price subtotal stay honest when a wish is added two views away. And a folder
 * **delete** un-files the wishes inside it — `wishlist_entries.folder_id` is `ON DELETE SET
 * NULL`, so the wishes surface at the root, filed nowhere and otherwise untouched — so a hook
 * that refreshed only its own folder list would leave the wall drawing wishes in a folder that
 * no longer exists.
 */
export function useWishlistFolders() {
  const queryClient = useQueryClient();
  const { marketplace } = useMarketplace();

  const query = useQuery({
    queryKey: ["wishlist", "folders"],
    queryFn: () => ipc.wishlistFolderList(),
  });

  /**
   * The counts and subtotal a folder card is drawn from, one row per folder that exists.
   *
   * **Keyed on the marketplace, not just on `["wishlist", "folderSummary"]`** — two
   * marketplaces are two answers to the same question, exactly as every other price-bearing
   * query in this app carries the marketplace in its key (`useMarketplace`'s own doc comment):
   * Card Kingdom's and Mana Pool's prices live in `marketplace_prices` rather than
   * `cards.prices`, so neither marketplace's folder cards may be served from the other's cached
   * page.
   */
  const summaryQuery = useQuery({
    queryKey: ["wishlist", "folderSummary", marketplace.id],
    queryFn: () => ipc.wishlistFolderSummary(marketplace.id),
  });

  /** `summaryQuery.data`, indexed by folder id — a caller draws the tree one node at a time and
   *  looks a folder's numbers up rather than scanning the whole list per node. Direct per
   *  folder, never recursive: see {@link WishlistFolderSummary} for why summing a node's
   *  children is the tree builder's job and not this query's. */
  const summary = useMemo(
    () => new Map((summaryQuery.data ?? []).map((s) => [s.folderId, s])),
    [summaryQuery.data],
  );

  /**
   * The whole `["wishlist"]` root, on success **and** on error — `useDeckFolders`' rule, on the
   * definition rather than on a call site.
   *
   * A refusal here is a busy database or a folder another surface has already deleted, and the
   * second must not leave a tree drawing a node that is gone.
   */
  const invalidate = () => void queryClient.invalidateQueries({ queryKey: ["wishlist"] });
  const writes = { onSuccess: invalidate, onError: invalidate };

  /** A new folder — at the root with `parentId: null`, or inside another one. */
  const create = useMutation({
    mutationFn: ({ parentId, name }: { parentId: number | null; name: string }) =>
      ipc.wishlistFolderCreate(parentId, name),
    ...writes,
  });

  const rename = useMutation({
    mutationFn: ({ id, name }: { id: number; name: string }) => ipc.wishlistFolderRename(id, name),
    ...writes,
  });

  /**
   * Re-parent a folder; `parentId: null` moves it back to the root.
   *
   * A move into itself or into one of its own descendants is refused by the backend, and that
   * guard is not cosmetic: `wishlist_folders.parent_id` is `ON DELETE CASCADE` **on itself**, so
   * a cycle is a graph SQLite's recursive cascade would walk forever the day the folder is
   * deleted. A drag-and-drop tree should still grey the illegal targets — the refusal is a
   * fence, not the affordance.
   */
  const move = useMutation({
    mutationFn: ({ id, parentId }: { id: number; parentId: number | null }) =>
      ipc.wishlistFolderMove(id, parentId),
    ...writes,
  });

  /**
   * Delete a folder. Named `remove` for `useDecks`' reason — `delete` is a reserved word.
   *
   * **Its wishes are not deleted**, and a confirmation must say so: they surface at the root,
   * filed nowhere and otherwise exactly as they were. Its **sub-folders are**, by cascade. An id
   * that resolves to nothing is a success: the caller wanted that folder gone.
   */
  const remove = useMutation({
    mutationFn: (id: number) => ipc.wishlistFolderDelete(id),
    ...writes,
  });

  return {
    query,
    /** Every folder, flat. Empty until the first answer — a wishlist that files nothing and one
     *  that has not loaded are told apart by `query.isPending`, not by this. */
    folders: query.data ?? NONE,
    summary,
    summaryQuery,
    create,
    rename,
    move,
    remove,
  };
}

/** The whole of what a folder tree consumes, named so the view and the hook agree. */
export type WishlistFolders = ReturnType<typeof useWishlistFolders>;
