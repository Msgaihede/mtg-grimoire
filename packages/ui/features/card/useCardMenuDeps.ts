/**
 * Everything a card menu needs that is not the card, for every host that draws one — the search
 * views, the collection views, the wishlist, the card pane and the deck editor.
 *
 * **One definition, not one per page, and the reason is the invalidation rather than the
 * typing.** A menu's "Add to → Collection" changes what every wish counts as owned, what every
 * search row is badged with and what every deck reads as claimed; a wishlist add changes the
 * heart on a result row and nothing else. Those two sets are already written down once, in
 * `AddToCollection`'s popup, with a paragraph each saying why the collection add takes
 * `["decks"]` and the wish does not. Every page writing them out again is a place per page for
 * one rule to drift, and the drift would be silent — a stale badge is not a test failure.
 *
 * `buildCardMenu` stays a pure builder taking its dependencies as an argument; this is the one
 * argument all of those surfaces have in common. The deck editor spreads over it rather than
 * taking it plain, because its rows are rows of an open deck — it names the slot in
 * `printingsDeck` — and because it carries the deck extras.
 */
import { useCallback, useMemo, useState } from "react";
import {
  useCollectionFolderList,
  useSetCollectionFolder,
  useSetCollectionFolderMany,
} from "@/features/collection/useCollectionFolders";
import { useWishlistFolderList } from "@/features/wishlist/useWishlistFolders";
import { plural } from "@/lib/counts";
import type { Finish } from "@/lib/finish";
import { ipcError } from "@/lib/ipc";
import { notify } from "@/lib/notifications";
import { useAppStore } from "@/lib/store";
import { useMarketplace } from "@/lib/useMarketplace";
import { DEFAULT_VARIANT } from "@/features/decks/useDeck";
import {
  DeckTargetSubmenu,
  useOptionalAddCardToDeck,
  type CardMenuDeps,
  type CardMenuTarget,
} from "./cardMenu";
import { filingBatcher, type FilingWords } from "./menuReceipts";
import { useCollectionAdd, useWishlistAdd } from "./useCardAdds";

/** What the collection's root is called in a sentence — the breadcrumb's first segment
 *  (`CollectionBreadcrumb`'s `ROOT`) and the activity feed's `COLLECTION.root`. */
const COLLECTION_ROOT = "Collection";

/** The receipt words for an add and for a move, given where the cards went. */
const ADDED = (where: string): FilingWords => ({ done: "Added", verb: "add", where });
const MOVED = (where: string): FilingWords => ({ done: "Moved", verb: "move", where });
/** A folder by its name in curly quotes — or the generic word, unquoted, for a folder the cached
 *  cabinet does not carry (another window just made it). */
const quoted = (name: string | undefined): string =>
  name === undefined ? "a folder" : `“${name}”`;

export interface CardMenuWiring {
  /** One object for the whole page. Hand it to `buildCardMenu` with each row's own target. */
  deps: CardMenuDeps;
  // **No `error` any more (2026-10-12).** This used to carry the sentence a refused collection or
  // wishlist write left, which every page had to draw in a `CardMenuRefusal` because the menu that
  // started the write had already closed. Every write here now answers with a toast instead
  // (`@/lib/notifications`) — a receipt when it lands, the refusal when it does not — which is the
  // one place an answer to a closed menu can go, and it no longer depends on each page remembering
  // to draw a banner.
}

export function useCardMenuDeps(): CardMenuWiring {
  const { marketplace } = useMarketplace();
  const openAllPrintings = useAppStore((s) => s.openAllPrintings);

  /**
   * The wishlist's folders, so "Add to → Wishlist" can offer them.
   *
   * **One query per page mount, not one per right-click, and that is the whole reason the row
   * is a plain `submenu`.** The deck picker is `lazy` because `useDecks()` and
   * `useDeckFolders()` are two queries a right-click on a wall of forty tiles must not fire;
   * this is one command the host already ran, cached under `["wishlist", "folders"]` and shared
   * with whatever else on the page wants it — so there is nothing for a right-click to reach.
   *
   * **`useWishlistFolderList` and not `useWishlistFolders`, which is the difference between one
   * command and two.** The full hook also runs `wishlist_folder_summary` — a `GROUP BY` over
   * every wish, with the owned-copies subquery and a marketplace price expression in it — for
   * the counts and subtotals a folder *card* draws. This object is built on five surfaces that
   * draw no folder cards at all (the search views, the collection, the tags page, the deck
   * editor, the card pane), so taking the whole hook would compute that on every one of their
   * mounts and throw it away. The four folder writes are left behind for the same reason: a
   * menu that could rename a folder would be a second surface deciding what a folder is.
   */
  const { folders: wishlistFolders } = useWishlistFolderList();

  /**
   * The collection's own folders, so "Add to → Collection" and "Move to" can offer them.
   *
   * One query per page mount for `wishlistFolders`' reason, and it is what keeps both of those
   * rows plain `submenu`s rather than `lazy` ones: the list is in hand before the menu is built,
   * so a right-click reaches nothing.
   *
   * **`useCollectionFolderList` and not `useCollectionFolders`**, the same split as the wishlist's
   * one cabinet over and for the identical reason: the full hook also runs
   * `collection_folder_summary`, a `GROUP BY` over every entry carrying a marketplace price
   * expression, for the counts and subtotals a folder *card* draws — and not one of the surfaces
   * that build this object draws a folder card. Its four folder writes are left behind too: a menu
   * that could rename a folder would be a second surface deciding what a folder is.
   *
   * **This file kept a private copy of that hook until the folder branches merged**, because the
   * bucket that wrote the menu could not write into `features/collection/`. The two were always
   * one cache entry — same `["collection", "folders"]` key, so TanStack served both from one round
   * trip — which is exactly why the duplication was worth removing rather than tolerating: what a
   * second `useQuery` on one key costs is not a fetch, it is a second place for the key to drift.
   */
  const { folders: collectionFolders } = useCollectionFolderList();

  /**
   * The deck add, for the `Decks` rows inside "Add to → Collection" — or `null` where nothing has
   * mounted it, in which case those rows are simply not offered.
   *
   * **The app's own drawers are part of the collection's cabinet, and a deck group is the one
   * that is not a folder write.** `collection_folders::set_entry_folder` refuses a `deck`
   * destination in words, because filing into one by hand would claim the deck holds these copies
   * without writing the `deck_cards` row that makes it true. So the row routes to the deck's own
   * add instead — which makes it exactly the write "Add to → Deck" makes, reached from the
   * cabinet the reader was already looking at.
   *
   * **What that write actually does, correcting the sentence that stood here.** This paragraph
   * claimed the deck's add "does both halves in one transaction", and it does not: `deck_add_card`
   * writes a `deck_cards` row and files no copies at all — `useDeck.ts`'s `addCard` says so at its
   * own site (*"this write touches `deck_cards` and nothing else"*), and the command that moves
   * custody is `collection_alloc::collection_to_deck`, which the Collection Search tab presses and
   * this row does not. So the press records an **intention** — the deck now lists one more of this
   * card — and every `collection_entries` row stays filed exactly where the reader put it. The
   * deck group in the cabinet does not gain a copy, and the deck reads the card as *missing* until
   * something moves one.
   *
   * **Which is why the row is fenced as of issue #358.** A card the deck's live list does not
   * already play is greyed in that picker (`cardMenu.tsx`'s `appSection`), so the only press this
   * row can make is one more copy of a card the deck demonstrably plays — never a card walked into
   * a deck by pointing at its drawer. The fence is a read and lives inside a `lazy` row; nothing
   * here fetches anything.
   *
   * **{@link useOptionalAddCardToDeck} and not `useAddCardToDeck`**, whose throw would fire on
   * every surface that mounts this hook — and their suites render those pages under
   * `ContextMenuProvider` and `TooltipProvider` alone. The optional reader carries the whole
   * argument for why that is not a hole.
   */
  const addToDeck = useOptionalAddCardToDeck();

  /**
   * **One toast per press, whatever the press filed** — see `./menuReceipts`. A picked set's
   * `Add 4 cards to → Collection` is four calls of {@link addToCollection} in one tick, and this is
   * what folds them back into the one sentence the reader's one press is owed (the owner's rule,
   * 2026-10-12: every add, remove or move of cards toasts, and one action is one toast).
   *
   * In state rather than a module constant so two mounted pages cannot fold each other's presses
   * together; `useState`'s initialiser runs once per mount.
   */
  const [file] = useState(filingBatcher);
  /** Where a cabinet's root is called in a receipt, and a folder by its own name. */
  const collectionWhere = useCallback(
    (folderId: number | null) =>
      folderId === null
        ? "your collection"
        : quoted(collectionFolders.find((folder) => folder.id === folderId)?.name),
    [collectionFolders],
  );
  const wishlistWhere = useCallback(
    (folderId: number | null) =>
      folderId === null
        ? "your wishlist"
        : quoted(wishlistFolders.find((folder) => folder.id === folderId)?.name),
    [wishlistFolders],
  );

  /**
   * One copy of exactly the printing that was right-clicked — `useCollectionAdd`, whose doc carries
   * the four keys it settles and why (out of this file on 2026-10-03, for the light app's phone
   * face).
   *
   * **No handlers, and the answer is read off `mutateAsync` at the call below instead.** The
   * receipt needs the card's name and the press's batch, neither of which the mutation's own
   * variables carry; and a promise held by the batch outlives the observer, where a
   * `mutate`-scoped callback is dropped with it — the card modal's `Add to collection` can be
   * pressed and closed inside one round trip.
   */
  const collectionAdd = useCollectionAdd();

  /**
   * A wish for **this exact printing** — the menu is opened on one, and "any printing" is a
   * choice the quick-add popup exists to offer. `useWishlistAdd`, with its two keys.
   */
  const wishlistAdd = useWishlistAdd();

  /**
   * One row the reader already owns, filed somewhere else — the menu's half of the collection
   * page's drag, and **the same mutation that page makes**.
   *
   * `useSetCollectionFolder` owns the command, the two keys it settles (`["collection"]` for the
   * lists and everything counted from them, `["decks"]` because a merge deletes a row whose
   * `collection_entry_id` a cached claim still names) and the argument for not being optimistic.
   * This file kept its own copy of all three until they were collapsed; the copies had already
   * drifted on the deck key, so one gesture left a built deck's claims stale or fresh depending
   * on whether the reader dragged the row or used its menu.
   *
   * **What stays here is the answer**, as a toast off `mutateAsync` at {@link moveToFolder}: a
   * menu's panel is already closing when it arrives, so there is no observer left on screen to
   * report to. The collection page's own drag folds its copy of this write into its banner.
   */
  const setFolder = useSetCollectionFolder();

  /**
   * `Move N cards to` in **one** write (issue #555) — the same filing at a coarser grain, with the
   * undo offer made inside the hook and the receipt made at {@link moveCopies}. A refusal rolls the
   * whole press back, so the sentence says none of them moved.
   */
  const setFolderMany = useSetCollectionFolderMany();

  // `mutateAsync` is stable for the life of the observer, which is what lets the callbacks below —
  // and therefore `deps` — hold still across a render of a wall of forty tiles.
  const addCopy = collectionAdd.mutateAsync;
  const addWish = wishlistAdd.mutateAsync;
  const moveCopy = setFolder.mutateAsync;
  const moveMany = setFolderMany.mutateAsync;

  /**
   * **Each write hands its promise to the press's batch**, keyed by the destination, so a picked
   * set filed in one press is one toast — `Added 4 cards to “Binder”`, or `Added 3 of 4 cards …`
   * with the first refusal under it. The card modal's `Add to collection` button reaches this same
   * callback, and it toasts too even though the modal stays open: the owner's rule names the add,
   * not the surface, and the rail's count ticking over is not a sentence about it.
   */
  const addToCollection = useCallback(
    (target: CardMenuTarget, finish: Finish, folderId: number | null) =>
      file(
        `collection:${folderId}`,
        target.name,
        addCopy({ cardId: target.cardId, finish, folderId }),
        ADDED(collectionWhere(folderId)),
      ),
    [addCopy, file, collectionWhere],
  );
  const addToWishlist = useCallback(
    (target: CardMenuTarget, folderId: number | null) =>
      file(
        `wishlist:${folderId}`,
        target.name,
        addWish({
          cardId: target.cardId,
          quantity: 1,
          // The surface's own where it names one — a wish for the foil is a different wish, and
          // is not filled by the nonfoil. Absent is no preference, which is not nonfoil.
          preferredFinish: target.finish,
          // Where the reader pointed, and `null` for the root — never omitted. The field is part
          // of the row's storage grain, so a folder the caller failed to pass is not a wish filed
          // in the wrong drawer but a *second* wish for the same card.
          folderId,
        }),
        ADDED(wishlistWhere(folderId)),
      ),
    [addWish, file, wishlistWhere],
  );
  /** The **entry** id rather than a target, because this is the one write here that is about a
   *  row the reader owns instead of a piece of cardboard — see `CardMenuTarget.entryId`. */
  //
  // Batched like the adds, for the one surface that loops it — a menu with no `moveCopies` wired.
  const moveToFolder = useCallback(
    (entryId: number, folderId: number | null, name?: string) =>
      file(
        `move:${folderId}`,
        name,
        moveCopy({ entryId, folderId }),
        MOVED(collectionWhere(folderId)),
      ),
    [moveCopy, file, collectionWhere],
  );
  /**
   * The several — one write, and the destination's name for the undo notice's sentence, read out
   * of the cabinet this object already holds. `null` is the root, named by the breadcrumb's own
   * first segment. A folder the list does not carry (a cabinet another window just changed) is
   * still named, as the generic word, rather than as an empty `to`.
   */
  //
  // **One write, so one answer** — a toast as well as the undo bar the hook raises, because the
  // owner's rule names every move of cards and the undo bar is drawn on the collection page alone.
  // All or nothing: the backend rolls the whole press back on a refusal.
  const moveCopies = useCallback(
    (entryIds: readonly number[], folderId: number | null) => {
      const where = collectionWhere(folderId);
      void moveMany({
        entryIds,
        folderId,
        destination:
          folderId === null
            ? COLLECTION_ROOT
            : (collectionFolders.find((folder) => folder.id === folderId)?.name ?? "a folder"),
      }).then(
        () => notify.success(`Moved ${plural(entryIds.length, "card")} to ${where}`),
        (e: unknown) =>
          notify.error(`Couldn't move ${plural(entryIds.length, "card")} to ${where}`, {
            body: ipcError(e),
          }),
      );
    },
    [moveMany, collectionFolders, collectionWhere],
  );
  /**
   * **`DEFAULT_VARIANT`, and the row does not ask.** "Add to → Deck" offers Theory then Live for a
   * deck that keeps a plan, because that row is deck-building and the plan is the likelier
   * target. This row is *filing*: the reader is pointing at a drawer in their collection and
   * saying the copies live there, and a theory list is a plan rather than a place cardboard sits.
   * A reader who means the plan has the deck picker one row up, which still asks.
   */
  const toDeck = useMemo(
    () =>
      addToDeck === null
        ? undefined
        : (targets: readonly CardMenuTarget[], deckId: number) =>
            addToDeck(targets, deckId, DEFAULT_VARIANT),
    [addToDeck],
  );

  const deps = useMemo<CardMenuDeps>(
    () => ({
      marketplace,
      addToCollection,
      addToWishlist,
      // Straight through, and the array's *identity* is what matters here: `useWishlistFolders`
      // answers one stable empty array while nothing is filed and React Query's own cached array
      // once something is, so this memo holds still across a render of a wall of forty tiles for
      // the same reason the two callbacks above do.
      wishlistFolders,
      // The collection's cabinet, on the same terms and with one difference worth naming: this
      // list carries the folders the **app** owns as well as the reader's, and the menu filters
      // them out of its destination lists. Handing over the whole list is what keeps that one
      // decision in one place.
      collectionFolders,
      // The deck add behind the cabinet's `Decks` rows — `undefined` where nothing mounted the
      // provider, which leaves those rows out rather than drawing ones that cannot write.
      toDeck,
      // The write behind "Move to". Given on every surface, and the *item* is what is fenced —
      // a target with no `entryId` cannot name a row, so the row is never built.
      moveToFolder,
      // Its plural, as one write — what "Move N cards to" makes on a surface that wires no
      // `pickCopies` of its own (issue #555). The collection page spreads its dialog over this.
      moveCopies,
      // **No `printingsDeck` and no `printingsOracleId`, and both absences are the point.** This
      // is the object every *plain* card surface takes — the search walls, the collection, the
      // wishlist, the card pane — and not one of them is a row of an open deck or a list of one
      // card's printings. The deck editor spreads its own slot over this per card; the modal
      // spreads the oracle id it is open for. Nothing here has to answer "where should this land",
      // because the modal opens over whatever is already on screen.
      openAllPrintings,
      // **Passed as itself, with no glue at all.** The picker reaches the app's single
      // `useCardToDeck` through `CardToDeckProvider` rather than through a callback threaded
      // from here, so there is nothing for a surface to mis-wire and no second observer of the
      // same write. Wiring it without that mount throws on the first render of the picker,
      // which is the fence: a deck add that quietly never lands is the failure this shape
      // exists to prevent.
      DeckTargetSubmenu,
    }),
    [
      marketplace,
      addToCollection,
      addToWishlist,
      moveToFolder,
      moveCopies,
      wishlistFolders,
      collectionFolders,
      toDeck,
      openAllPrintings,
    ],
  );

  return { deps };
}
