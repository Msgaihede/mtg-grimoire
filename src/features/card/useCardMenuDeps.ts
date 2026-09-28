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
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  useCollectionFolderList,
  useSetCollectionFolder,
  useSetCollectionFolderMany,
} from "@/features/collection/useCollectionFolders";
import { useWishlistFolderList } from "@/features/wishlist/useWishlistFolders";
import { MENU_CONDITION } from "@/lib/conditions";
import type { Finish } from "@/lib/finish";
import { ipc, ipcError } from "@/lib/ipc";
import { useAppStore } from "@/lib/store";
import { useMarketplace } from "@/lib/useMarketplace";
import { refreshCardSearches } from "@/lib/searchMarks";
import { DEFAULT_VARIANT } from "@/features/decks/useDeck";
import {
  DeckTargetSubmenu,
  useOptionalAddCardToDeck,
  type CardMenuDeps,
  type CardMenuTarget,
} from "./cardMenu";

/** What the collection's root is called in a sentence — the breadcrumb's first segment
 *  (`CollectionBreadcrumb`'s `ROOT`) and the activity feed's `COLLECTION.root`. */
const COLLECTION_ROOT = "Collection";

export interface CardMenuWiring {
  /** One object for the whole page. Hand it to `buildCardMenu` with each row's own target. */
  deps: CardMenuDeps;
  /**
   * What the last refused **collection or wishlist** write said, as a whole sentence, or `null` —
   * either add, and the folder move.
   *
   * **The page must draw this.** Every write a card menu starts is begun by a panel that is
   * already closing, so there is nothing left on screen for a refusal to be reported to and no
   * observer left to report it — a page that ignores this string is a page where a card
   * silently fails to be added.
   *
   * The deck add is **not** here and needs nothing from the page: it reaches the app's single
   * `useCardToDeck` through `CardToDeckProvider`, and that one mount draws its own sentence.
   */
  error: string | null;
}

export function useCardMenuDeps(): CardMenuWiring {
  const queryClient = useQueryClient();
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

  /** The sentence a refused collection or wishlist add left behind. */
  const [refusal, setRefusal] = useState<string | null>(null);

  /**
   * One copy of exactly the printing that was right-clicked.
   *
   * The four keys `AddToCollection` invalidates on a collection add, verbatim and for its
   * reasons: the list and its summary, every wish for that card (`ownedQuantity` is summed from
   * `collection_entries`), every deck (a claim is clamped to what the entry still holds), and
   * the search results, which draw `ownedQuantity` on every row and every tile.
   */
  const collectionAdd = useMutation({
    mutationFn: ({
      cardId,
      finish,
      folderId,
    }: {
      cardId: string;
      finish: Finish;
      folderId: number | null;
    }) =>
      ipc.collectionAdd({
        cardId,
        finish,
        condition: MENU_CONDITION,
        quantity: 1,
        // Where the reader pointed, and `null` for the root — never omitted. `folder_id` is the
        // eleventh term of the storage grain, so a folder the caller failed to pass is not a
        // copy filed in the wrong drawer but a *second row* at the root for the same printing.
        folderId,
      }),
    // **Cleared when the next add starts, not when one succeeds**, which is what every other
    // banner on these pages does — each is derived from the *latest* mutation's state, so
    // a new write supersedes the last one's complaint. Cleared only on success, a refusal would
    // stand on screen while the reader dealt with it some other way: `CollectionPage` carries a
    // comment about exactly that bug being found live and fixed for the stepper and the removal.
    // Both writes here clear the same one, so the sentence on screen always belongs to the last
    // thing the reader asked for.
    onMutate: () => setRefusal(null),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["collection"] });
      void queryClient.invalidateQueries({ queryKey: ["wishlist"] });
      void queryClient.invalidateQueries({ queryKey: ["decks"] });
      void refreshCardSearches(queryClient);
    },
    onError: (error) => setRefusal(`Couldn't add to your collection — ${ipcError(error)}`),
  });

  /**
   * A wish for **this exact printing** — the menu is opened on one, and "any printing" is a
   * choice the quick-add popup exists to offer.
   *
   * Two keys rather than four: a wish is a copy the reader does not have, so it moves no
   * collection figure and no deck's arithmetic. The search results are re-read because every
   * row draws `wishlisted`.
   */
  const wishlistAdd = useMutation({
    mutationFn: ({ target, folderId }: { target: CardMenuTarget; folderId: number | null }) =>
      ipc.wishlistAdd({
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
    // Superseded on the next add, exactly as the collection's is, and clearing the same one.
    onMutate: () => setRefusal(null),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["wishlist"] });
      void refreshCardSearches(queryClient);
    },
    onError: (error) => setRefusal(`Couldn't add to your wishlist — ${ipcError(error)}`),
  });

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
   * **What stays here is the refusal, and it is why the hook takes handlers at all.** A menu's
   * panel is already closing when the answer arrives, so there is no observer left on screen to
   * report to — the sentence has to be lifted into the page through {@link CardMenuWiring.error},
   * where the collection page instead folds its own copy of this write into its banner.
   */
  const setFolder = useSetCollectionFolder({
    // Superseded on the next write, exactly as the two adds are, and clearing the same sentence.
    onMutate: () => setRefusal(null),
    onError: (error) => setRefusal(`Couldn't move that card — ${ipcError(error)}`),
  });

  /**
   * `Move N cards to` in **one** write (issue #555) — the same filing at a coarser grain, with the
   * same refusal surface as {@link setFolder} beside it and the undo offer made inside the hook.
   * A refusal rolls the whole press back, so the sentence says none of them moved.
   */
  const setFolderMany = useSetCollectionFolderMany({
    onMutate: () => setRefusal(null),
    onError: (error) => setRefusal(`Couldn't move those cards — ${ipcError(error)}`),
  });

  // `mutate` is stable for the life of the observer, which is what lets the callbacks below — and
  // therefore `deps` — hold still across a render of a wall of forty tiles.
  const addCopy = collectionAdd.mutate;
  const addWish = wishlistAdd.mutate;
  const moveCopy = setFolder.mutate;
  const moveMany = setFolderMany.mutate;

  const addToCollection = useCallback(
    (target: CardMenuTarget, finish: Finish, folderId: number | null) =>
      addCopy({ cardId: target.cardId, finish, folderId }),
    [addCopy],
  );
  const addToWishlist = useCallback(
    (target: CardMenuTarget, folderId: number | null) => addWish({ target, folderId }),
    [addWish],
  );
  /** The **entry** id rather than a target, because this is the one write here that is about a
   *  row the reader owns instead of a piece of cardboard — see `CardMenuTarget.entryId`. */
  const moveToFolder = useCallback(
    (entryId: number, folderId: number | null) => moveCopy({ entryId, folderId }),
    [moveCopy],
  );
  /**
   * The several — one write, and the destination's name for the undo notice's sentence, read out
   * of the cabinet this object already holds. `null` is the root, named by the breadcrumb's own
   * first segment. A folder the list does not carry (a cabinet another window just changed) is
   * still named, as the generic word, rather than as an empty `to`.
   */
  const moveCopies = useCallback(
    (entryIds: readonly number[], folderId: number | null) =>
      moveMany({
        entryIds,
        folderId,
        destination:
          folderId === null
            ? COLLECTION_ROOT
            : (collectionFolders.find((folder) => folder.id === folderId)?.name ?? "a folder"),
      }),
    [moveMany, collectionFolders],
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
        : (target: CardMenuTarget, deckId: number) => addToDeck(target, deckId, DEFAULT_VARIANT),
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

  return { deps, error: refusal };
}
