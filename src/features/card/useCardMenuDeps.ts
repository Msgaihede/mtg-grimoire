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
import { useWishlistFolders } from "@/features/wishlist/useWishlistFolders";
import type { Finish } from "@/lib/finish";
import { ipc, ipcError } from "@/lib/ipc";
import { useAppStore } from "@/lib/store";
import { useMarketplace } from "@/lib/useMarketplace";
import { DeckTargetSubmenu, type CardMenuDeps, type CardMenuTarget } from "./cardMenu";

/**
 * The condition a menu add records.
 *
 * Near Mint, always, and stated here rather than left to the backend's default so that the one
 * decision the menu makes on the reader's behalf is visible at the place it is made. A
 * collection row's identity includes its condition, so something has to choose; an unmarked
 * card is assumed NM everywhere else in this app (the quick-add popup opens on it), and the
 * menu is the fast path rather than the careful one — the popup is still there for a played
 * copy.
 */
const MENU_CONDITION = "NM" as const;

export interface CardMenuWiring {
  /** One object for the whole page. Hand it to `buildCardMenu` with each row's own target. */
  deps: CardMenuDeps;
  /**
   * What the last refused **collection or wishlist** add said, as a whole sentence, or `null`.
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
   * **One subscription per page mount, not one per right-click, and that is the whole reason
   * the row is a plain `submenu`.** The deck picker is `lazy` because `useDecks()` and
   * `useDeckFolders()` are two queries a right-click on a wall of forty tiles must not fire;
   * this is a hook the host already ran, cached under `["wishlist", "folders"]`, shared with
   * whatever else on the page wants it — so there is nothing for a right-click to reach.
   *
   * Only `folders` is read. The hook's four writes and its per-folder summary belong to the
   * wishlist page, and a menu that used them would be a second surface deciding what a folder
   * is.
   */
  const { folders: wishlistFolders } = useWishlistFolders();

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
    mutationFn: ({ cardId, finish }: { cardId: string; finish: Finish }) =>
      ipc.collectionAdd({ cardId, finish, condition: MENU_CONDITION, quantity: 1 }),
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
      void queryClient.invalidateQueries({ queryKey: ["cards", "search"] });
    },
    onError: (error) => setRefusal(`Could not add to your collection — ${ipcError(error)}`),
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
      void queryClient.invalidateQueries({ queryKey: ["cards", "search"] });
    },
    onError: (error) => setRefusal(`Could not add to your wishlist — ${ipcError(error)}`),
  });

  // `mutate` is stable for the life of the observer, which is what lets the two callbacks below
  // — and therefore `deps` — hold still across a render of a wall of forty tiles.
  const addCopy = collectionAdd.mutate;
  const addWish = wishlistAdd.mutate;

  const addToCollection = useCallback(
    (target: CardMenuTarget, finish: Finish) => addCopy({ cardId: target.cardId, finish }),
    [addCopy],
  );
  const addToWishlist = useCallback(
    (target: CardMenuTarget, folderId: number | null) => addWish({ target, folderId }),
    [addWish],
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
    [marketplace, addToCollection, addToWishlist, wishlistFolders, openAllPrintings],
  );

  return { deps, error: refusal };
}
