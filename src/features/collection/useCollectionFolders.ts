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
 * The collection's filing cabinet: every folder there is, the five writes that shape them, and the
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
   * the cabinet's **five** refusals in words; the middle one must not leave a tree drawing a node
   * that is gone. Four are `FOLDER_GONE`, `FOLDER_CYCLE`, `FOLDER_NOT_YOURS` and
   * `FOLDER_IS_LOCKED` — which are the ones these five writes can raise — plus `ENTRY_IN_A_DECK`,
   * which belongs to `set_entry_folder` and reaches {@link useSetCollectionFolder} below rather
   * than this hook. That last one is the odd one out: the other four are about a **folder**, and
   * it is about the **row** being filed, refusing to let a copy walk out of a deck's group by
   * hand.
   *
   * Nothing outside `["collection"]` moves — **except the card search, which joined on
   * 2026-09-03 with issue #349.** No quantity changes, so no wish's `ownedQuantity` moves and no
   * *unscoped* search row's owned badge can be different afterwards. Nor any deck's owned count,
   * which since schema v25 is the sum over that deck's *own* group: all five writes are fenced to
   * `user` folders, so none can reach a deck's group or put one inside a folder about to be
   * deleted. What did change is that the deck builder's card search now counts *what a deck can
   * use* (`SearchRequest.availableForDeck`), and that answer reads the **effective lock** — so
   * `setLocked`, and a `move` that carries a subtree under a locked parent, do move a badge.
   *
   * **All five fire it rather than the two that need it**, deliberately: splitting the helper
   * would put the decision at five call sites where four of them are "no", and a rename that
   * invalidates a root nothing is observing costs nothing at all — the reader is on the
   * collection page, where no card search is mounted.
   */
  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ["collection"] });
    void queryClient.invalidateQueries({ queryKey: ["cards", "search"] });
  };
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
   * **`["collection", "folders"]` alone — the one write on this page that does not take a root** —
   * and the narrowing is the point rather than an oversight, because the comments either side of
   * it are arguments for the two biggest settle sets in the app.
   *
   * `invalidate` above takes the whole `["collection"]` root because the other five writes reach
   * **entries**: a delete re-files the sub-tree by hand, so copies surface at the root and the
   * table, both folder subtotals and the header are all suddenly wrong; a lock changes which rows
   * the list itself answers with. And
   * {@link useSetCollectionFolder} adds `["decks"]` on top of that, because since schema v25 a deck
   * owns exactly the copies filed in its own group and filing a copy is how one enters or leaves.
   *
   * **A reorder is neither of those.** It writes `collection_folders.sort_order` and
   * `collection_folders.parent_id`; it moves no `collection_entries.folder_id`, so no quantity, no
   * membership and no folder's contents change. Every number counted from entries is therefore
   * still true — `["collection", "list", …]`, `["collection", "summary", …]`, and
   * `["collection", "folderSummary", marketplace]`, which is a `GROUP BY` over every entry
   * carrying a price expression and is the most expensive query on the page to throw away for
   * nothing. Nor can any deck's owned count have moved, which is the whole reason `["decks"]` is
   * in the set below and is absent here.
   *
   * **The re-parent half is what tempts a wider set, and it is answered by the same key.** A
   * folder card's recursive total is summed by the *tree builder*, in TypeScript, over these flat
   * rows — so a folder that moved to a different branch changes which subtree its (unchanged)
   * numbers roll up into, and re-reading the list is precisely what recomputes that. The summary
   * map is keyed by folder id and is untouched by where the folder sits.
   *
   * On error as well as on success, `writes`' rule: a refusal is a busy database, a cycle, or an
   * id in `ids` another surface has already deleted — and the last must not leave a tree drawing a
   * node that is gone.
   */
  const settleOrder = () =>
    void queryClient.invalidateQueries({ queryKey: ["collection", "folders"] });

  /**
   * Place a whole level: `ids` is **every** child of `parentId`, in the order they are to sit in.
   *
   * `sortOrder` is written from position and `parentId` from the argument, in one transaction — so
   * one gesture both re-parents and places, and a reader never sees half of it. Sending only the
   * folder that moved is the mistake the name invites; see `ipc.collectionFolderReorder`.
   */
  const reorder = useMutation({
    mutationFn: ({ parentId, ids }: { parentId: number | null; ids: number[] }) =>
      ipc.collectionFolderReorder(parentId, ids),
    onSuccess: settleOrder,
    onError: settleOrder,
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

  /**
   * Set a folder aside, or bring it back — `collection_folder_set_locked`, writing the folder's
   * **own** flag. The lock inherits down the tree, so what the reader sees afterwards is
   * `lockedFolderIds` over the re-read list and never this one row.
   *
   * **On `writes`, not on {@link settleOrder}, and the difference is the whole reason this is
   * commented at all.** A reorder settles narrowly because it moves no
   * `collection_entries.folder_id` and therefore changes no number counted from entries. A lock
   * is the opposite kind of write: nothing moves, but the collection page asks its list with
   * `excludeLocked`, so locking a drawer changes **which rows the list answers with** — and with
   * it the header's totals and the page's count. Every one of those lives under
   * `["collection"]`, including `["collection", "folderSummary", marketplace]`, and a settle
   * that named only `["collection", "folders"]` would leave the table drawing copies the reader
   * has just set aside until something else happened to invalidate it. `lib/query.ts` sets
   * `staleTime: 30_000`, so a mounted observer that is merely stale never refetches on its own.
   *
   * `["decks"]` stays out, `reorder`'s reason: a deck owns exactly the copies filed in its **own
   * group** since schema v25, a lock is fenced to the reader's own folders, and §1 of the design
   * is explicit that locking cannot move a deck's owned or missing figures in either direction.
   * `["cards", "search"]` is the root that does **not** stay out, and this is the write it is
   * there for: the deck builder's card search counts what a deck can use and reads the effective
   * lock, so setting a drawer aside changes an `×N` a reader may be one navigation away from.
   *
   * On error as well as on success: a refusal is a busy database, a folder another surface has
   * already deleted, or one of the app's own that this write refuses in words — and the middle
   * one must not leave a tree drawing a node that is gone.
   */
  const setLocked = useMutation({
    mutationFn: ({ id, locked }: { id: number; locked: boolean }) =>
      ipc.collectionFolderSetLocked(id, locked),
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
    reorder,
    remove,
    setLocked,
  };
}

/** The whole of what a folder tree consumes, named so the view and the hook agree. */
export type CollectionFolders = ReturnType<typeof useCollectionFolders>;

/**
 * What a caller does about a refusal, which is the only thing the two callers of
 * {@link useSetCollectionFolder} do differently.
 */
export interface SetCollectionFolderHandlers {
  /** Before the write. Both callers use it to clear whatever the last refusal left on screen. */
  onMutate?: () => void;
  /** The refusal, for a surface to draw. The invalidation is not this hook's caller's business
   *  and happens either way. */
  onError?: (error: unknown) => void;
}

/**
 * Filing one copy — `collection_set_folder` — and **the only mutation in the app that does it**.
 *
 * There were two for a while, the drag's and the card menu's, with different settle sets and a
 * comment on the page claiming there was one. Two implementations of one write disagree the first
 * time either changes, and these already had: the menu's took `["decks"]` and the drag's did not,
 * so the same gesture left a deck's owned count stale or fresh depending on which hand made it.
 * Since schema v25 that half is not optional — filing a copy is *how* a card enters or leaves a
 * deck, so a settle set without `["decks"]` is an editor still drawing cards it no longer holds.
 * The hook is the settle set plus the two hooks a surface needs to draw its own refusal, and
 * nothing else.
 *
 * **Not optimistic, deliberately, and the wishlist is why this is written down rather than merely
 * done.** That page shipped a `setFolder` that removed the row optimistically from every cached
 * list page and then invalidated only the summary and the card search — so **nothing ever put it
 * back where it went**. The folder card read `1 wish` while the folder's own contents read
 * `Nothing filed here yet`, with the row in the database the whole time; it reproduced on all
 * three routes and cleared only on reload.
 *
 * Every optimistic answer to "which list does this row belong to now" is a guess a surface is not
 * entitled to make:
 *
 * * Taking the row off the level is the guess that shipped, and it is wrong in both directions —
 *   out to the root as well as in.
 * * Putting the row in is the other guess, and it is worse: the destination list is sorted and
 *   paged by the backend, so an insert has to invent both the position and the page and then be
 *   undone whenever the answer disagrees.
 * * And **a merge answers a different id than the one asked about** — filing a copy into a drawer
 *   that already holds the same eleven-column grain sums the quantities into the *destination* row
 *   and deletes the source (`collection_folders::refile_entry`) — so there is not always a row
 *   left to patch at all.
 *
 * So the answer is a re-read, both ways. A folder move is one deliberate press rather than a
 * held-down stepper, so there is no second press racing the first — which is the whole reason the
 * collection table's quantity stepper *is* optimistic.
 */
export function useSetCollectionFolder({ onMutate, onError }: SetCollectionFolderHandlers = {}) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ entryId, folderId }: { entryId: number; folderId: number | null }) =>
      ipc.collectionSetFolder(entryId, folderId),
    onMutate: () => {
      onMutate?.();
    },
    onError: (error) => onError?.(error),
    // **On success and on failure both**, and one handler because there is one behaviour: a
    // refusal leaves the list exactly as unknown as a success does, since a refused move is
    // almost always a row another surface has already moved or deleted.
    onSettled: () => {
      // **The whole `["collection"]` root, which is the list as well as everything counted from
      // it** — the level being left, the level being joined, both folder subtotals and the
      // header. `invalidateQueries` matches by key *prefix*, so this reaches
      // `["collection", "list", …]` itself and refetches it because it is mounted; a settle that
      // named only the summary and the folder keys is precisely the wishlist bug above. And
      // marking it stale would not be enough on its own: `lib/query.ts` sets `staleTime: 30_000`,
      // so a mounted observer that is merely stale never refetches.
      void queryClient.invalidateQueries({ queryKey: ["collection"] });
      // **And every deck, which is the half the drag's own mutation was missing.** A move changes
      // no quantity, so no wish's `ownedQuantity` and no *unscoped* search row's owned badge can
      // be different afterwards — but since schema v25 a deck owns exactly the copies filed in its
      // own group, and this is the write that files copies.
      //
      // **Both ends are fenced now, which is newer than the sentence that stood here** (it read
      // *"only the destination of this write is fenced … The source is not"*).
      // `set_entry_folder` refuses a `deck` or `removed` **destination** (`FOLDER_NOT_YOURS`) and,
      // since fan-in, a row whose **source** is a `deck` folder (`ENTRY_IN_A_DECK` — a sibling
      // sentence rather than a reuse: that one is about the folder, this one about the row). So
      // the case this key was added for — a copy dragged out of a group, leaving the deck listing
      // a card whose copies have walked off — is a refusal rather than a silent loss of custody.
      // **The key stays, and deliberately**: a refusal settles here too, and what the fences
      // protect is an invariant rather than this callback, so the day one of them is relaxed the
      // editor must not be the last thing to hear about it. `refile_entry` underneath carries no
      // fence at all, which is exactly what lets `collection_alloc`'s two writes and
      // `delete_deck` file into those folders.
      void queryClient.invalidateQueries({ queryKey: ["decks"] });
      // **And the card search, since 2026-09-03** (issue #349). The deck builder's card search
      // counts *what a deck can use*, which is a fact about where each copy is filed — so this
      // write, whose whole job is to change that, moves an `×N` even though it moves no quantity.
      // A copy dragged into a locked drawer is the plainest case: nothing was gained or lost and
      // every deck's badge for that card is one lower.
      void queryClient.invalidateQueries({ queryKey: ["cards", "search"] });
    },
  });
}
