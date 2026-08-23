import { useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ipc, type CollectionFolder } from "@/lib/ipc";
import { useMarketplace } from "@/lib/useMarketplace";

/** Stable identity for "no folders yet" — a collection nobody has filed is the ordinary case, and
 *  the tree builder's `useMemo` does not see a new identity every render. */
const NONE: readonly CollectionFolder[] = [];

/**
 * Every folder there is, and nothing else — one query, no summary, no writes.
 *
 * **The card menu is why this is a hook of its own**, exactly as `useWishlistFolderList` is.
 * `Add to → Collection` offers the binder as a submenu, so `useCardMenuDeps` wants this list on
 * every surface that draws a card menu: the two search views, the collection, the tags page, the
 * deck editor and the card pane. Not one of them draws a folder card or a price subtotal, and
 * `collection_folder_summary` is a `GROUP BY` over `collection_entries` carrying a marketplace
 * price expression — real work, computed on each of those mounts and thrown away. The summary is
 * **opt-in** because the list has several times as many readers as it does.
 *
 * **A split rather than a second `useQuery`, and that is the whole point of the shape.** The key
 * and its `queryFn` are written once, here; two hooks want the same rows and TanStack serves both
 * from one cache entry, so the collection page — which mounts both, through its folder cards and
 * through the card menu on its own rows — still asks the backend for the list exactly once.
 */
export function useCollectionFolderList() {
  const query = useQuery({
    queryKey: ["collection", "folders"],
    queryFn: () => ipc.collectionFolderList(),
  });

  return {
    query,
    /** Every folder, flat. Empty until the first answer — a collection that files nothing and one
     *  that has not loaded are told apart by `query.isPending`, not by this. */
    folders: query.data ?? NONE,
  };
}

/**
 * The collection's filing cabinet: every folder there is, the four writes that shape them, and the
 * per-folder summary a folder card is drawn from.
 *
 * **The folder list itself comes from {@link useCollectionFolderList}**, which this composes
 * rather than repeats — see there for why the summary below is something a caller opts into.
 *
 * **Flat rows, and the tree is the reader's to build from `parentId`** — `collection_folders` has
 * no notion of depth and the command takes no entry id, because a folder belongs to no entry: it
 * files them. So there is one query here for the whole app rather than one per row, and no
 * argument to this hook at all.
 *
 * **Both keys sit under `["collection"]`** — `["collection", "folders"]` and
 * `["collection", "folderSummary", marketplace.id]`. That is not tidiness. Every collection write
 * in this app already fires `invalidateQueries({ queryKey: ["collection"] })`, so a folder card's
 * copy count and subtotal stay honest when a stepper two views away moves a quantity. And a folder
 * **delete** re-files the cards inside it — `collection_folders.delete_folder` walks the sub-tree
 * by hand and the `ON DELETE SET NULL` behind it is only the backstop — so the rows surface at the
 * root, and a hook that refreshed only its own folder list would leave the table drawing cards in
 * a folder that no longer exists.
 */
export function useCollectionFolders() {
  const queryClient = useQueryClient();
  const { marketplace } = useMarketplace();

  const { query, folders } = useCollectionFolderList();

  /**
   * The numbers a folder card is drawn from, one row per folder that has anything in it.
   *
   * **Keyed on the marketplace, not just on `["collection", "folderSummary"]`** — two
   * marketplaces are two answers to the same question, exactly as every other price-bearing query
   * in this app carries the marketplace in its key (`useMarketplace`'s own doc comment): Card
   * Kingdom's and Mana Pool's prices live in `marketplace_prices` rather than `cards.prices`, so
   * neither marketplace's folder cards may be served from the other's cached page.
   */
  const summaryQuery = useQuery({
    queryKey: ["collection", "folderSummary", marketplace.id],
    queryFn: () => ipc.collectionFolderSummary(marketplace.id),
  });

  /**
   * `summaryQuery.data`, indexed by folder id — a caller draws the tree one node at a time and
   * looks a folder's numbers up rather than scanning the whole list per node.
   *
   * **Direct per folder, never recursive, and an empty folder is not in here at all.**
   * `collection_folder_summary` is a `GROUP BY` over `collection_entries`, so a folder holding
   * nothing emits no row — which is why the *list* is the census and this is a lookup layered onto
   * it. A page that built its tree from this map would have no node for exactly the drawer whose
   * whole job on screen is to be empty.
   */
  const summary = useMemo(
    () => new Map((summaryQuery.data ?? []).map((s) => [s.folderId, s])),
    [summaryQuery.data],
  );

  /**
   * The whole `["collection"]` root, on success **and** on error — `useWishlistFolders`' rule, on
   * the definition rather than on a call site.
   *
   * A refusal here is a busy database, a folder another surface has already deleted, or one of
   * this cabinet's own three refusals in words; the middle one must not leave a tree drawing a
   * node that is gone.
   *
   * Nothing outside `["collection"]` moves. A folder write files copies rather than counting
   * them: no quantity changes, so no wish's `ownedQuantity`, no search row's owned badge and no
   * deck's claims are any different afterwards.
   */
  const invalidate = () => void queryClient.invalidateQueries({ queryKey: ["collection"] });
  const writes = { onSuccess: invalidate, onError: invalidate };

  /** A new folder — at the root with `parentId: null`, or inside another one. */
  const create = useMutation({
    mutationFn: ({ parentId, name }: { parentId: number | null; name: string }) =>
      ipc.collectionFolderCreate(parentId, name),
    ...writes,
  });

  const rename = useMutation({
    mutationFn: ({ id, name }: { id: number; name: string }) => ipc.collectionFolderRename(id, name),
    ...writes,
  });

  /**
   * Re-parent a folder; `parentId: null` moves it back to the root.
   *
   * A move into itself or into one of its own descendants is refused by the backend, and that
   * guard is not cosmetic: `collection_folders.parent_id` is `ON DELETE CASCADE` **on itself**, so
   * a cycle is a graph SQLite's recursive cascade would walk forever the day the folder is
   * deleted. The picker still greys the illegal destinations — the refusal is a fence, not the
   * affordance.
   */
  const move = useMutation({
    mutationFn: ({ id, parentId }: { id: number; parentId: number | null }) =>
      ipc.collectionFolderMove(id, parentId),
    ...writes,
  });

  /**
   * Delete a folder. Named `remove` for `useDecks`' reason — `delete` is a reserved word.
   *
   * **Its cards are not deleted**, and a confirmation must say so: they surface at the root, filed
   * nowhere and otherwise exactly as they were — with their condition, their purchase price and
   * their acquisition story. Its **sub-folders are**, by cascade. An id that resolves to nothing is
   * a success: the caller wanted that folder gone.
   */
  const remove = useMutation({
    mutationFn: (id: number) => ipc.collectionFolderDelete(id),
    ...writes,
  });

  return {
    // Both passed straight through, so this hook's public surface is exactly what it would have
    // been without the split: the page reads `query` and `folders` off this object and must not
    // have to know that the card menu shares the list with it.
    query,
    folders,
    summary,
    summaryQuery,
    create,
    rename,
    move,
    remove,
  };
}

/** The whole of what a folder tree consumes, named so the view and the hook agree. */
export type CollectionFolders = ReturnType<typeof useCollectionFolders>;
