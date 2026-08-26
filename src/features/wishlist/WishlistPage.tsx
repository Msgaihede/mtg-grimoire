import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { useMutation, useQueryClient, type InfiniteData } from "@tanstack/react-query";
import { FolderInput, Pencil, Trash2 } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import type { MenuItem } from "@/components/menu/types";
import { useContextMenu } from "@/components/menu/useContextMenu";
import { Figure, FigureRow } from "@/components/Figure";
import { buildCardMenu, type CardMenuTarget } from "@/features/card/cardMenu";
import { CardMenuRefusal } from "@/features/card/CardMenuRefusal";
import { listWalkStops, usePublishCardWalk } from "@/features/card/cardWalk";
import { useCardMenuDeps } from "@/features/card/useCardMenuDeps";
import { MoveToFolder } from "@/features/decks/MoveToFolder";
import { ExportDialog } from "@/features/transfer/export/ExportDialog";
import { everythingLabel, scopeLabel, useExportScope } from "@/features/transfer/export/scope";
import { wishlistDestination } from "@/features/transfer/import/destinations/WishlistPreview";
import { ImportExportPair } from "@/features/transfer/ImportExportPair";
import { ImportDialog } from "@/features/transfer/import/ImportDialog";
import { FilterBar, type FilterLabels, type TrayCell } from "@/features/search/FilterBar";
import { NewFolderCard } from "@/components/NewFolderCard";
import { count } from "@/lib/counts";
import { DROP_MARK_ROOM } from "@/lib/dropMarks";
import type { FolderDrag, FolderEdge } from "@/lib/folderDrag";
import { reorderedLevel } from "@/lib/folderOrder";
import { isFinish } from "@/lib/finish";
import { FOCUS } from "@/lib/focus";
import { buildFolderTree, folderDescendants, type FolderNode } from "@/lib/folderTree";
import {
  ipc,
  ipcError,
  type WishlistFolder,
  type WishlistPage as Page,
  type WishRow,
} from "@/lib/ipc";
import { statusLine } from "@/lib/motion";
import { formatPrice, pricesAsOf } from "@/lib/prices";
import { useAppStore } from "@/lib/store";
import { useDismissOnEscape } from "@/lib/useDismissOnEscape";
import { cn } from "@/lib/utils";
import { writeFailure } from "@/lib/writes";
import { WishFolderCard } from "./WishFolderCard";
import { WishlistBreadcrumb } from "./WishlistBreadcrumb";
import { WishlistGrid } from "./WishlistGrid";
import { WishlistTable } from "./WishlistTable";
import { useWishlist, type Wishlist } from "./useWishlist";
import { useWishlistFolders } from "./useWishlistFolders";
import { missingOf } from "./wish";
import type { WishDrag } from "./wishDrag";

/**
 * What the top of the cabinet is called, here and in the two lists this page hands it to.
 *
 * `WishlistBreadcrumb` spells its own copy of this word, because a breadcrumb that had to be
 * told what its own first segment is called would be a component that does not know what it is
 * drawing. This one is the *page's* copy, for the two places the page has to say it: the caption
 * under a flattened tile filed nowhere, and `MoveToFolder`'s top row — whose default is the deck
 * gallery's "All decks", which is the wrong sentence to show a reader filing a card they are
 * buying.
 */
const ROOT_LABEL = "Wishlist";

/**
 * The one dismissible layer this page can have open — the union, and never four flags.
 *
 * `DecksPage`'s `Panel` states the argument in full and it holds here for a smaller cabinet: a
 * half-typed folder name beside a half-answered delete question is not a state this view draws,
 * and separate booleans can express it. One value is also one Escape rung, which is the whole
 * of what {@link useDismissOnEscape} has to order.
 *
 * **No id lives in here that is not read.** `deleteFolder` carries its folder because — unlike
 * the gallery's, which asks about the folder the reader is *standing in* — this question is
 * always asked about a folder **card**, one level down from where the reader is, and there is
 * nothing else on the page holding which one.
 */
type Panel =
  | { kind: "newFolder"; parentId: number | null }
  | { kind: "renameFolder"; folderId: number }
  | { kind: "moveFolder"; folderId: number }
  | { kind: "deleteFolder"; folderId: number }
  | null;

/** What a folder card draws — the recursive total, summed by {@link subtotalsOf}. */
interface FolderTotals {
  wishes: number;
  missing: number;
  cost: number;
  unpriced: number;
}

/**
 * A folder the summary has no row for.
 *
 * **Not a defensive default — the ordinary answer for an empty folder.**
 * `wishlist_folder_summary` is a `GROUP BY` over `wishlist_entries`, so a folder holding no
 * wishes emits no row at all, and a card fed a raw `Map.get` would render `undefined` figures
 * over exactly the folder whose whole job on this screen is to be empty.
 *
 * **It is the answer for a folder the summary skipped, and never for a summary that has not
 * answered yet.** The two are one `Map.get` miss apart and mean opposite things — see the
 * `summaryQuery.isPending` branch at the wall below, which is what keeps them apart.
 */
const NO_WISHES: FolderTotals = { wishes: 0, missing: 0, cost: 0, unpriced: 0 };

/**
 * The printing a right-click on a **pinned** wish is about.
 *
 * `cardId` is the caller's rather than the row's, and that is the whole of how this list's one
 * peculiarity is enforced: a wish with no `card_id` is for the *card*, so there is no printing
 * to copy a name from, link to, or record a copy of — and the menu is not offered at all. The
 * same rule decides whether the row opens the card and whether it can be dragged.
 *
 * **The preferred finish travels, where there is one.** A wish *for the foil* is a different
 * wish and is not filled by the nonfoil, so "Add to → Collection" records the finish the wish
 * asked for rather than asking again. `isFinish` guards it because
 * `wishlist_entries.preferred_finish` is TEXT with a CHECK rather than an enum this side knows.
 *
 * `finishes` is `null` — a wish carries no printing's finish list — so a wish with no
 * preference falls to the menu's own rule for an unknown list, which is nonfoil.
 */
function wishTarget(row: WishRow, cardId: string): CardMenuTarget {
  const preferred = row.preferredFinish;
  return {
    cardId,
    // Never null: a wish carries its own name, because it outlives the printing it was made
    // from and may never have had one.
    name: row.name,
    // An *orphaned* pinned wish has neither — the join found no card — and the row already
    // draws that as "— · —". The Scryfall link is a dead one for those, which is the same
    // thing the row itself says about them.
    setCode: row.setCode ?? "",
    collectorNumber: row.collectorNumber ?? "",
    oracleId: row.oracleId,
    finishes: null,
    finish: preferred !== null && isFinish(preferred) ? preferred : undefined,
    // The one thing `WishRow` carries that this list never draws, carried for exactly this and
    // for the drag beside it: a menu add is filed by what the card does.
    typeLine: row.typeLine,
  };
}

/**
 * The trail from the root down to the folder the reader is standing in — **without the root**,
 * which the breadcrumb prepends itself because `null` is a destination rather than a folder.
 *
 * Walked up through `parentId` and then reversed, because that is the only direction the flat
 * rows can be read in. Two shapes of broken input are resolved rather than trusted, and both
 * resolve **towards the root**: a `parentId` naming a folder this list does not carry — one
 * another surface deleted between the two reads — ends the walk there, so the folder draws as
 * though it sat at the top level; and a cycle, which the backend refuses outright and which only
 * corruption could produce, terminates on the visited set. That is `buildFolderTree`'s own rule
 * applied to the other half of the tree, and it is the rule because the alternative strands the
 * reader: a trail that gave up would leave them inside a folder with no way back out but the
 * flatten switch.
 *
 * A `folderId` naming nothing at all answers the empty trail, which is the same rule seen from
 * the bottom — the reader reads as standing at the root, which is where the wishes of a deleted
 * folder have just gone.
 */
function trailOf(
  folders: readonly WishlistFolder[],
  folderId: number | null,
): readonly WishlistFolder[] {
  const byId = new Map(folders.map((folder) => [folder.id, folder]));
  const trail: WishlistFolder[] = [];
  const seen = new Set<number>();
  let at = folderId;
  while (at !== null && !seen.has(at)) {
    seen.add(at);
    const folder = byId.get(at);
    if (folder === undefined) break;
    trail.unshift(folder);
    at = folder.parentId;
  }
  return trail;
}

/**
 * Every folder's numbers **with its sub-folders' added in**, indexed by folder id.
 *
 * `wishlist_folder_summary` answers *direct* counts — this folder's own wishes, never the ones
 * nested under it — and says so at its own type, because SQL that walked the tree would be a
 * second implementation of the arithmetic `buildFolderTree` already does for `FolderNode.count`.
 * This is that arithmetic, over four fields instead of one: a folder card handed a raw lookup
 * would draw `0 wishes` over a drawer holding twelve in two sub-folders, and the reader would
 * only catch it by opening the drawer.
 *
 * The whole tree in one pass rather than a sum per card, because a node's total is its children's
 * totals and a per-card recursion would recompute every level of the cabinet once per level.
 */
function subtotalsOf(
  nodes: readonly FolderNode<WishlistFolder>[],
  direct: ReadonlyMap<number, FolderTotals>,
): ReadonlyMap<number, FolderTotals> {
  const out = new Map<number, FolderTotals>();
  const visit = (node: FolderNode<WishlistFolder>): FolderTotals => {
    const own = direct.get(node.folder.id) ?? NO_WISHES;
    const total = { ...own };
    for (const child of node.children) {
      const under = visit(child);
      total.wishes += under.wishes;
      total.missing += under.missing;
      total.cost += under.cost;
      total.unpriced += under.unpriced;
    }
    out.set(node.folder.id, total);
    return total;
  };
  for (const node of nodes) visit(node);
  return out;
}

/**
 * The wishlist: what is still needed, what it will cost, where it is filed, and the quantities
 * editable in place.
 *
 * The thin mirror of the collection, deliberately — a wishlist is a shopping list, not an
 * inventory — and, like the other two lists, it is drawn either as a wall of art or as a
 * table. **It opens on the wall**, which is where it differs from the collection and agrees
 * with the search: these are cards the reader does not have yet and may never have held, so
 * the picture is how you recognise the thing you are about to buy. The table is a press away
 * for the trip where the question is what it all costs.
 *
 * Both layouts draw one list and answer alike: the same wishes, the same writes, the same
 * menu on the same rows. What differs is only what there is room to say — see
 * {@link WishlistGrid} for what a 170px tile keeps and what it moves into a panel.
 *
 * **Since the folders (spec §4) the page draws a second thing above whichever view is on: the
 * cabinet.** A breadcrumb saying where the reader is standing, and the folders filed directly
 * at that level as dashed cards. Both are drawn once for both layouts rather than inside each,
 * so the wall and the table navigate identically — the alternative is two drill-downs that agree
 * today. The filing itself is the backend's: `wishlist_list` takes the folder and the flatten
 * flag, so the rows below are already the rows of the level on screen and nothing here filters.
 */
/**
 * What this surface calls its search box, and the `id` stem its labels bind through — see
 * `FilterLabels`, and `CollectionPage`'s twin, which is the same argument: one name over two lists
 * is the control lying about which one it narrows.
 */
const WISHLIST_LABELS: FilterLabels = { idStem: "wishlist", search: "Search your wishlist" };

/**
 * Which of `FilterBar`'s tray cells this page offers, in the order it draws them.
 *
 * Three of the card search's, then the two only a shopping list can ask. **No `price` cell**, and
 * that is the one absence here that is a fact about the wire rather than about the screen:
 * `WishlistQuery` carries no `priceMin`/`priceMax`, so the band would be a control whose numbers
 * reach nothing — which is why those three fields are the optional half of `FilterSurface`.
 *
 * **`needsReview` is drawn unconditionally**, where the chip it replaces appeared only once the
 * reconciler had flagged something. That rule was about a *row*, where a control spending its
 * whole life saying nothing is a control the reader learns to stop reading; in a shut tray it
 * costs nothing, and a cell that came and went would be the one thing in this list that moved.
 */
const WISHLIST_TRAY: readonly TrayCell[] = ["set", "format", "rarity", "fulfilled", "needsReview"];

export function WishlistPage() {
  const wishlist = useWishlist();
  const { query, rows, total, marketplace, folderId, flatten } = wishlist;
  const view = useAppStore((s) => s.wishlistView);
  const openAllPrintings = useAppStore((s) => s.openAllPrintings);
  const queryClient = useQueryClient();
  const folders = useWishlistFolders();

  /**
   * The export dialog, and the sweep that fills it — `CollectionPage`'s twin, for the same
   * reason: `ExportDialog` is mounted unconditionally below so its close can fade rather than
   * vanish, so this hook runs every render and `enabled: exporting` is what stops it sweeping
   * the whole wishlist on every filter keystroke nobody asked to export.
   */
  const [exporting, setExporting] = useState(false);
  const exportScope = useExportScope("wishlist", wishlist.filters, exporting);

  /** The import dialog. One destination, so no radio group is drawn — a choice between one
   *  thing is not a choice. */
  const [importing, setImporting] = useState(false);

  /**
   * Which folder layer is open, and what the caret goes back to when it closes.
   *
   * **The opener is a ref rather than a piece of `Panel`** for the reason `DecksPage` gives: the
   * three triggers here are the filter bar's `+ New folder` and, for the other two, whichever
   * folder card's `⋯` a reader happened to press, so capturing the element when the layer opens
   * is the only way one handler can serve a wall of them.
   */
  const [panel, setPanel] = useState<Panel>(null);
  const openerRef = useRef<HTMLElement | null>(null);

  /**
   * Rewrite one wish wherever the wishlist is cached.
   *
   * Every cached filter combination, not just the one on screen: the same wish is in the
   * "everything" list and in the "still missing" list, and a stepper press that fixed one and
   * left the other would show two different numbers for one card one filter click apart.
   */
  const patchWish = useCallback(
    (id: number, next: ((row: WishRow) => WishRow) | null) => {
      queryClient.setQueriesData<InfiniteData<Page>>({ queryKey: ["wishlist", "list"] }, (data) => {
        if (!data || !data.pages.some((p) => p.items.some((r) => r.id === id))) return data;
        return {
          ...data,
          pages: data.pages.map((page) =>
            next === null
              ? {
                  items: page.items.filter((r) => r.id !== id),
                  // Every page carries the same count of the whole list, so every page's copy
                  // of it moves — otherwise the header the *first* page feeds would go on
                  // counting a wish that is gone.
                  total: Math.max(0, page.total - 1),
                }
              : { ...page, items: page.items.map((r) => (r.id === id ? next(r) : r)) },
          ),
        };
      });
    },
    [queryClient],
  );

  /** Undo, for a write the backend refused. */
  const snapshot = useCallback(
    () => queryClient.getQueriesData<InfiniteData<Page>>({ queryKey: ["wishlist", "list"] }),
    [queryClient],
  );
  const restore = useCallback(
    (saved: ReturnType<typeof snapshot>) => {
      for (const [key, data] of saved) queryClient.setQueryData(key, data);
    },
    [queryClient],
  );

  /**
   * How **every** write on this page finishes: the whole `["wishlist"]` root re-read, and the
   * card search with it.
   *
   * The search, because a result row draws `wishlisted`: adding or clearing a wish changes the
   * heart on every printing of that card, and a wall that goes on showing one for a wish the
   * reader just crossed off is wrong on screen rather than stale in a cache. Nothing further out
   * moves — a wish write moves no copies, so the collection and its header are untouched.
   *
   * **`["wishlist"]` rather than the three keys under it**, because it covers the list, the
   * folder list and the summary at every marketplace at once, and because that is the shape of
   * the eleven other wishlist writes in this app: `useWishlistFolders`' four, the card menu's
   * add, the deck sweeps'. One page inventing a narrower settle is how the three fell out of step
   * in the first place.
   *
   * **One function for every caller here, because the reason is the same shape in all of them:
   * the answer is not something this page can compute.**
   *
   * * A *refusal* is almost always a row something else already deleted, and a list that has lost
   *   a row has lost the total and the cost it was part of.
   * * A *filing* is the same problem wearing the other hat: the wish is now in a list this page is
   *   not drawing, at a sort position and on a page only the backend knows, and two folder
   *   subtotals have moved with it.
   * * And the **stepper and the removal** are the same problem again, which is what this function
   *   did not cover until 2026-08-22. Those two shipped patching the list and re-reading the
   *   search alone, on the argument that the row's own number was already the answer. That
   *   argument is true about the *row* and false about everything counted from it, in two ways a
   *   reader acts on. `wishlist_folder_summary` is a `GROUP BY` carrying an owned-copies subquery
   *   and a price expression — arithmetic this page cannot redo — so a folder card went on saying
   *   `Ordered folder, 2 wishes, $20.00` over a drawer holding one, which on a shopping list is
   *   the subtotal somebody buys against. And `elsewhere` is a correlated count over the whole
   *   table, so crossing off one of two duplicates left the survivor still marked
   *   "Also on your wishlist…" — the one mark whose entire job is honesty about duplicates,
   *   pointing at a wish that no longer exists. **Neither repairs itself at the app's own
   *   `staleTime`** (`lib/query.ts`, 30s): the summary's observer is mounted for the life of this
   *   page, so marking it stale without a refetch changes nothing, and the suite's default of 0
   *   hides the whole class.
   *
   * {@link patchWish} is not replaced by any of this and stays where it was. It is what the
   * reader sees at the moment of the press — a stepper the cache controls must not be computed
   * from a value a round trip is still on its way to confirm — and the re-read behind it is for
   * the figures the press moved that this page was never holding.
   */
  const settleWhole = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ["wishlist"] });
    void queryClient.invalidateQueries({ queryKey: ["cards", "search"] });
  }, [queryClient]);

  const setQuantity = useMutation({
    mutationFn: ({ row, quantity }: { row: WishRow; quantity: number }) =>
      ipc.wishlistSetQuantity(row.id, quantity),
    // Optimistic on the row's own number and nothing else. Without it, holding `+` sends the
    // same number three times — the box is controlled by the cache, so a second press before
    // the first answer would be computed from a stale value.
    onMutate: ({ row, quantity }) => {
      const saved = snapshot();
      patchWish(row.id, (r) => ({ ...r, quantity }));
      return saved;
    },
    onError: (_error, _variables, saved) => {
      if (saved) restore(saved);
      settleWhole();
    },
    onSuccess: (change) => {
      // The answer, not the guess: the backend clamps and canonicalises, and this is the
      // number it actually stored. Then the re-read, for what the new number is counted into —
      // the folder subtotal a copy count multiplies straight through.
      patchWish(change.id, (r) => ({ ...r, quantity: change.quantity }));
      settleWhole();
    },
  });

  const remove = useMutation({
    mutationFn: (row: WishRow) => ipc.wishlistRemove(row.id),
    onError: settleWhole,
    onSuccess: (change) => {
      // The row goes at once — a crossed-off wish must not sit there for the length of a round
      // trip — and then everything the row was part of is re-read: the folder it was filed in,
      // and the `elsewhere` mark on whatever duplicate it left behind.
      patchWish(change.id, null);
      settleWhole();
    },
  });

  /**
   * Filing a wish — the drag's write and the panel's, which are one command and deliberately one
   * mutation: spec §9 says both routes reach `wishlist_set_folder`, so a merge behaves the same
   * whichever hand made the gesture.
   *
   * **This is the one write on the page that is deliberately not optimistic**, and the reason is
   * what a move actually changes: not a number the reader is holding down, but *which list the
   * row belongs to*. Every optimistic answer to that is a guess this page is not entitled to
   * make.
   *
   * * Taking the row off the level is the guess it shipped with, and the live pass found it wrong
   *   three ways at once (2026-08-22): the row left the list and **nothing ever put it back**, so
   *   a filed wish was gone from the app until a reload; the destination folder went on saying
   *   "Nothing filed here yet." under a card already counting the wish; and the header
   *   under-counted by one on the way *out* to the root as well as on the way in. Only the merge
   *   path re-read, so a plain move — the common one — was the case nothing covered.
   * * Putting the row in is the other guess, and it is worse: the destination list is sorted and
   *   paged by the backend, so an insert has to invent both the position and the page, then be
   *   undone whenever the answer disagrees.
   * * And **a merge answers a different id than the one asked about** — moving a wish into a
   *   folder that already holds the same `(oracleId, cardId, preferredFinish)` sums the two
   *   quantities into the *destination* row and deletes the source — so there is not always a row
   *   left to patch at all.
   *
   * So the answer is a re-read, both ways: {@link settleWhole}. It costs one query over a list of
   * tens of rows, and it is the only thing that is right for the level being left, the level being
   * joined, both folder subtotals and a merge at once. A folder move is one deliberate press
   * rather than a held-down stepper, so there is no second press racing the first — which is the
   * whole reason the stepper beside it *is* optimistic.
   *
   * **Flatten is where the difference shows on screen.** With the filing ignored the list is not a
   * level, so a moved wish must stay listed and *change its caption* rather than leave — which the
   * re-read gets right by construction, and which the optimistic remove got wrong in that view
   * even before the missing invalidation.
   */
  const setFolder = useMutation({
    mutationFn: ({ id, folderId: to }: { id: number; folderId: number | null }) =>
      ipc.wishlistSetFolder(id, to),
    // Either way, and one handler because there is one behaviour: a refusal leaves the list
    // exactly as unknown as a success does, since a refused move is almost always a row another
    // surface has already moved or deleted.
    onSettled: settleWhole,
  });

  /**
   * Back to **any printing** — the second of spec §5's two printing writes, and the only one
   * this page makes itself: pinning a wish to a printing is a press in the All printings modal,
   * which owns that half (spec §6).
   *
   * Optimistic on the four columns this page can honestly guess — the printing, its set, its
   * number and its language all clear together, and `needs_review` clears with them, because
   * choosing the printing by hand *is* the review a flagged wish was waiting for. The caption
   * flips to "Any printing" on the press, which is the feedback the reader asked for.
   *
   * **The answer is a re-read rather than a patch, and that is where this parts company with the
   * stepper above — which re-reads too, but holds its own row's number.** Every write on this
   * page settles the same way now; the difference is how much of the row survives the settle.
   * Un-pinning does not merely clear columns: the backend re-resolves the wish
   * against the newest printing of its oracle card, so the art the tile is drawn as, its rarity,
   * its mana cost and its unit price are all different afterwards and none of them is derivable
   * here. And this write **merges** on the same rule `wishlist_set_folder` does — un-pinning a
   * wish for the Alpha Bolt when an any-printing Bolt already sits in the same folder is the
   * reader saying they are one wish — so the `EntryChange` may not even name the row that was
   * asked about.
   */
  const anyPrinting = useMutation({
    mutationFn: (row: WishRow) => ipc.wishlistSetPrinting(row.id, null),
    onMutate: (row) => {
      const saved = snapshot();
      patchWish(row.id, (r) => ({
        ...r,
        cardId: null,
        setCode: null,
        collectorNumber: null,
        lang: null,
        needsReview: null,
      }));
      return saved;
    },
    onError: (_error, _variables, saved) => {
      if (saved) restore(saved);
      settleWhole();
    },
    onSuccess: settleWhole,
  });

  const onSetQuantity = useCallback(
    (row: WishRow, quantity: number) => setQuantity.mutate({ row, quantity }),
    [setQuantity],
  );
  const onRemove = useCallback((row: WishRow) => remove.mutate(row), [remove]);
  const onSetFolder = useCallback(
    (row: WishRow, to: number | null) => setFolder.mutate({ id: row.id, folderId: to }),
    [setFolder],
  );
  const onAnyPrinting = useCallback((row: WishRow) => anyPrinting.mutate(row), [anyPrinting]);

  /**
   * The other way into a printing: the All printings modal, opened *about this wish*, so a press
   * on a printing there repoints the wish rather than opening the card (spec §6).
   *
   * `artCardId` and not `cardId`, for {@link walk}'s reason one field along: the modal's "you are
   * here" ring is drawn on the printing the tile *shows*, which for an unpinned wish is the newest
   * printing of its oracle card rather than the nothing it is pinned to. `""` is a genuine orphan
   * — `WishlistGrid`'s own value for a tile with no art — and rings nothing, which is the honest
   * answer for a wish whose printing has left the card database.
   *
   * A wish with no oracle card has no list of printings to open at all; `EditWish` greys the
   * control and says why, and this refuses it a second time because a disabled control is an
   * affordance rather than a fence.
   */
  const onChangePrinting = useCallback(
    (row: WishRow) => {
      if (row.oracleId === null) return;
      openAllPrintings({
        cardId: row.artCardId ?? "",
        oracleId: row.oracleId,
        name: row.name,
        deck: null,
        wish: { id: row.id },
      });
    },
    [openAllPrintings],
  );

  const onNeedNextPage = useCallback(() => {
    if (query.hasNextPage && !query.isFetchingNextPage && !query.isFetchNextPageError) {
      void query.fetchNextPage();
    }
  }, [query]);

  /**
   * What is left to buy in the selected marketplace's currency, and how many wishes that
   * figure could not price.
   *
   * Counted over what is *missing* rather than over what is wanted: a total that charged the
   * reader for cards already in the binder is a number nobody can act on. Computed here
   * rather than asked of the backend because a wishlist fits in one page — this is arithmetic
   * over the rows already on screen, not a second round trip.
   *
   * **One figure, not the pair this used to draw.** Two totals over one shopping list was two
   * answers to the question the header exists to answer, and the setting is now the way to
   * say which one is wanted. The unpriced counter is summed from the same rows and is never
   * carried across a switch, because no two marketplaces have the same holes: `eur_etched`
   * does not exist in Scryfall's data at all, so a wish for the etched printing is priced on
   * TCGplayer and unpriced on Cardmarket at once, and a card a bulk feed has never listed is
   * unpriced on that feed alone. Nothing falls back: an unpriced wish is left out of the sum
   * and counted, never quoted at another marketplace's rate.
   */
  const currency = marketplace.currency;
  const cost = useMemo(() => {
    let total = 0;
    let unpriced = 0;
    for (const row of rows) {
      const missing = missingOf(row);
      if (missing === 0) continue;
      if (row.unitPrice === null) unpriced += 1;
      else total += row.unitPrice * missing;
    }
    return { total, unpriced };
  }, [rows]);

  /**
   * The wishlist as a **walk**, so the printings modal's chevrons and arrow keys step along it.
   *
   * **`artCardId`, not `cardId`, and the difference is this list's own.** A stop is the printing
   * the modal rings and the card pane opens, which on this wall is what the tile is *drawn as* —
   * a pinned wish's own printing, and for an any-printing wish the newest printing of its oracle
   * card. `cardId` is what the wish is *for* and is `null` on half of them, so a walk built from
   * it would skip every unpinned wish and leave holes in a list the reader can see. The two agree
   * wherever a walk can be *started* from here anyway: the card menu is offered only on a pinned
   * wish, and a pinned wish is drawn as the printing it names.
   *
   * Memoised because the hook requires it — a fresh array republishes an identical walk under a
   * new identity and re-renders the modal for nothing.
   */
  const walk = useMemo(
    () =>
      listWalkStops(rows, (row) => ({
        cardId: row.artCardId,
        oracleId: row.oracleId,
        name: row.name,
      })),
    [rows],
  );
  usePublishCardWalk("your wishlist", walk);

  /**
   * The right-click menu, as one object for the whole page — `CardMenuDeps` is built per
   * surface, never per row.
   *
   * `rowMenu` answers `undefined` for a wish with no printing, which is what leaves those rows
   * without a menu: an absent `onContextMenu` is the same thing to the list as a row that never
   * asked for one, and the reader gets the app's plain suppression instead of a panel about a
   * card this row cannot name.
   */
  const { menu, menuKey, menuClick } = useContextMenu();
  const { deps: menuDeps, error: menuFailure } = useCardMenuDeps();
  const rowMenu = useCallback(
    (row: WishRow) =>
      row.cardId === null
        ? undefined
        : menu(() => buildCardMenu(wishTarget(row, row.cardId!), menuDeps)),
    [menu, menuDeps],
  );
  /** The same menu on Shift+F10 and the ContextMenu key, gated on the same `cardId`: a menu only
   *  a mouse can open is a menu half this app's readers do not have. */
  const rowMenuKey = useCallback(
    (row: WishRow) =>
      row.cardId === null
        ? undefined
        : menuKey(() => buildCardMenu(wishTarget(row, row.cardId!), menuDeps)),
    [menuKey, menuDeps],
  );

  /**
   * The cabinet, as a tree, and where the reader is standing in it.
   *
   * `buildFolderTree(folders, [])` with **no members**, which is the one thing about this call
   * that is not obvious: `FolderNode.count` would be the number of wishes filed under a node, and
   * this page holds one level's rows rather than the whole list, so counting from them would
   * answer 0 for every folder that is not the one on screen. The counts come from
   * `wishlist_folder_summary` instead, summed up the tree by {@link subtotalsOf}. The tree is
   * still what says which folder is under which, and it is what applies the missing-parent rule
   * that {@link trailOf} applies from the other end.
   */
  const nodes = useMemo(() => buildFolderTree(folders.folders, []), [folders.folders]);
  const trail = useMemo(() => trailOf(folders.folders, folderId), [folders.folders, folderId]);
  const subtotals = useMemo(() => subtotalsOf(nodes, folders.summary), [nodes, folders.summary]);

  /**
   * The folders filed directly at the level being drawn — nothing deeper, because a card is a
   * door into one drawer rather than a picture of the cabinet.
   *
   * Read off the *tree* rather than filtered out of the flat rows, so a folder whose parent
   * another surface deleted surfaces here at the root instead of disappearing with the parent
   * that is gone — `buildFolderTree`'s rule, and the reason this is not a one-line `filter`.
   */
  const childFolders = useMemo(() => {
    if (folderId === null) return nodes;
    const find = (list: readonly FolderNode<WishlistFolder>[]): FolderNode<WishlistFolder> | null => {
      for (const node of list) {
        if (node.folder.id === folderId) return node;
        const inside = find(node.children);
        if (inside !== null) return inside;
      }
      return null;
    };
    return find(nodes)?.children ?? [];
  }, [nodes, folderId]);

  /**
   * What to call the folder a wish is filed in — the join the two lists ask for, done once here
   * because this is the component holding both halves of it.
   *
   * A `Map` and not a `find` per row: a flattened wall captions every tile with this, and a
   * linear scan per tile is a lookup table rebuilt on every scroll. `null` — a folder id this
   * page cannot name — draws nothing rather than a blank chip, which is the honest answer for a
   * folder another window deleted between the two reads.
   */
  const folderNames = useMemo(
    () => new Map(folders.folders.map((folder) => [folder.id, folder.name])),
    [folders.folders],
  );
  const folderNameOf = useCallback(
    (id: number | null) => (id === null ? ROOT_LABEL : (folderNames.get(id) ?? null)),
    [folderNames],
  );

  /**
   * Flatten closes whatever folder layer is open, and it does it by *deriving* rather than by
   * writing state from an effect.
   *
   * With the filing ignored the whole wall goes — `+ New folder`'s tile and every folder card's
   * `⋯` with it, since all of them are drawn *inside* it — so every trigger that could have
   * opened one of these is off screen. A rename field left standing over a flattened list would
   * be a layer with nothing on screen explaining what it is about. The derived value is what the
   * whole page reads, `panel` itself only what the setters write, so pressing Flatten and
   * pressing it back does not resurrect the layer.
   */
  const openPanel = flatten ? null : panel;

  // Focus first, then close: the opener is still mounted at this point, and an element that
  // unmounts with the caret on it drops focus to `<body>` — after which the next Tab restarts
  // from the top of the app. This is the **keyboard** way out — Escape, and each panel's own
  // Cancel. `close` below is the click-away way and is deliberately a different function:
  // CLAUDE.md's rule is that an outside click does *not* hand the caret back, because the reader
  // is already somewhere else.
  const dismiss = useCallback(() => {
    openerRef.current?.focus();
    setPanel(null);
  }, []);
  const close = useCallback(() => setPanel(null), []);

  useDismissOnEscape({ layer: "inner", onDismiss: dismiss, enabled: openPanel !== null });

  /**
   * The floor: Escape walks the reader **up one drawer**, once nothing nearer has wanted the
   * press. A folder panel takes it first (the `"inner"` rung above, capture phase), an open card
   * pane takes it next (`"outer"`), and what is left arrives here.
   *
   * **The parent is read off {@link trail}, not walked out of `folders.folders` again.** That
   * memo is already root-most-first and already without the root, so the segment before the last
   * one *is* the way out and its absence *is* the root — the same two facts the breadcrumb draws
   * from, which is what keeps the key and the pointer walking the same cabinet. A second walk
   * here would be `trailOf` written twice, and the two would disagree the day one of them learns
   * something new about a missing parent (which it already has: a broken `parentId` ends the
   * trail early, so Escape climbs to wherever the breadcrumb says the reader is, and a
   * `folderId` naming nothing at all answers the empty trail and therefore the root).
   *
   * `enabled` is what keeps the root silent. At the top of the cabinet there is no level above,
   * so the press is not this page's and must fall through untouched rather than be consumed into
   * a no-op.
   *
   * **Flatten is deliberately not a rung of this, and that is a decision rather than an
   * oversight** — do not "fix" it by toggling the chip off here. Flatten is not a place the
   * reader walked into; it is the cabinet's filing being ignored, which is why the breadcrumb
   * draws `Wishlist · all folders` in inert words and no level is on screen to leave. With it on
   * Escape does nothing at all — including when a `folderId` is still set underneath, because
   * walking a level the reader cannot see would silently move where un-flattening puts them back.
   * The chip is one press away and says which state it is in.
   */
  useDismissOnEscape({
    layer: "navigation",
    onDismiss: () => wishlist.openFolder(trail.length > 1 ? trail[trail.length - 2].id : null),
    enabled: !flatten && folderId !== null,
  });

  const open = useCallback((next: NonNullable<Panel>, opener: HTMLElement | null) => {
    openerRef.current = opener;
    setPanel(next);
  }, []);

  /**
   * `+ New folder`, the wall's own first tile — **inside the folder the reader is standing in**,
   * which is the whole of what it promises by going away with the wall while the list is
   * flattened.
   *
   * **`HTMLElement` rather than the `HTMLButtonElement` this took while it was wired to a
   * `<button>` here.** {@link NewFolderCard} owns the element now and hands it over as an
   * `HTMLElement`; under `strictFunctionTypes` a callback asking for the narrower type is not
   * assignable to that prop at all, and it never needed the narrower one — {@link open} takes an
   * `HTMLElement | null`, because all it does with the element is `focus()` it.
   *
   * `folders.create.reset()` for `DecksPage`'s reason: a refusal from the last attempt is not
   * news about this one.
   */
  const openNewFolder = useCallback(
    (opener: HTMLElement) => {
      folders.create.reset();
      open({ kind: "newFolder", parentId: folderId }, opener);
    },
    [folders.create, folderId, open],
  );

  /**
   * The field, answered — whichever of its two jobs it is doing.
   *
   * One callback because there is one field: which write a name becomes is a fact about the open
   * `Panel`, which this component owns, rather than something the field has to be told and then
   * hand back. `DecksPage.nameFolder`'s arrangement exactly.
   *
   * **A new folder does not become the folder the reader is standing in**, which is the one place
   * this parts company with the deck gallery. There, making a folder is making somewhere to file
   * decks *from elsewhere*, so the wall follows you into it. Here the reader is looking at the
   * wishes they are about to file, and walking them into the new empty drawer would take exactly
   * those wishes off screen and replace them with "Nothing filed here yet." The card they just
   * made is right there to drag onto.
   */
  const nameFolder = useCallback(
    (name: string) => {
      if (panel?.kind === "newFolder") {
        folders.create.mutate({ parentId: panel.parentId, name }, { onSuccess: dismiss });
      } else if (panel?.kind === "renameFolder") {
        folders.rename.mutate({ id: panel.folderId, name }, { onSuccess: dismiss });
      }
    },
    [panel, folders.create, folders.rename, dismiss],
  );

  /**
   * One folder card's three doors into one menu — a right-click, a `ContextMenu` keypress, and
   * the `⋯` trigger's own plain click, which is what {@link useContextMenu.menuClick} exists for.
   *
   * The item list is a **thunk** inside each handle, so a level holding twelve drawers builds no
   * menu until a reader opens one of them.
   *
   * **The opener is captured here rather than by the card**, because the panel a row raises has
   * to hand the caret back to the control it was raised from and a `MenuAction.onSelect` is a bare
   * callback with no element behind it. `e.currentTarget` is read synchronously, which is the only
   * moment it is the element the handler is attached to.
   */
  const folderRowMenu = useCallback(
    (folder: WishlistFolder) => {
      const build = (): MenuItem[] => [
        {
          kind: "action",
          id: "rename",
          label: "Rename…",
          Icon: Pencil,
          onSelect: () => {
            folders.rename.reset();
            open({ kind: "renameFolder", folderId: folder.id }, openerRef.current);
          },
        },
        {
          kind: "action",
          id: "move",
          label: "Move to folder…",
          Icon: FolderInput,
          onSelect: () => {
            folders.move.reset();
            open({ kind: "moveFolder", folderId: folder.id }, openerRef.current);
          },
        },
        { kind: "separator", id: "before-delete" },
        {
          kind: "action",
          id: "delete",
          label: "Delete…",
          Icon: Trash2,
          onSelect: () => {
            folders.remove.reset();
            open({ kind: "deleteFolder", folderId: folder.id }, openerRef.current);
          },
        },
      ];
      const remember = (element: HTMLElement) => {
        openerRef.current = element;
      };
      return {
        onContextMenu: (e: ReactMouseEvent<HTMLButtonElement>) => {
          remember(e.currentTarget);
          menu(build)(e);
        },
        onKeyDown: (e: ReactKeyboardEvent<HTMLButtonElement>) => {
          remember(e.currentTarget);
          menuKey(build)(e);
        },
        onClick: (e: ReactMouseEvent<HTMLButtonElement>) => {
          remember(e.currentTarget);
          menuClick(build)(e);
        },
      };
    },
    [menu, menuKey, menuClick, open, folders.rename, folders.move, folders.remove],
  );

  /**
   * Where a wish in the air may be let go — asked per target, because the answer differs per
   * target: the folder a wish is already filed in refuses it and draws no ring at all, rather
   * than a ring that would write nothing and bump `updated_at`. `dropWrite`'s rule about a card
   * dropped back in its own column, one screen over.
   */
  const canFile = useCallback(
    (drag: WishDrag, to: number | null) => drag.folderId !== to,
    [],
  );
  const fileWish = useCallback(
    (drag: WishDrag, to: number | null) => setFolder.mutate({ id: drag.wishId, folderId: to }),
    [setFolder],
  );

  /**
   * What a folder let go on another folder means as a write — the destination level and that
   * level's whole new order — or `null` for a drop this page will not make.
   *
   * **One function for both halves of the gesture**, because a mark that promised a write the
   * drop then refused would be worse than no mark: `useFolderDropTarget` asks the question once
   * per target per frame to decide what to draw, and again at the drop because the two can be a
   * second apart and only the second one writes.
   *
   * **No ownership clause, and its absence is a fact about this cabinet rather than an omission.**
   * `CollectionPage`'s twin of this function opens by fencing both ends to folders the reader
   * made, because `collection_folders.kind` makes some of that table the app's — one row per deck
   * plus the single `Recently removed` — and `collection_folders::reorder_folders` answers
   * `FOLDER_NOT_YOURS` for either at either end. `wishlist_folders` carries **no `kind` column**:
   * every row in it was made by the reader with `+ New folder`, `wishlist_folder_reorder` has
   * nothing to refuse, and a clause here would be a check with no false case. If that table ever
   * grows a row the app owns, this is the second place that has to learn it.
   *
   * **A folder may not land inside itself or inside anything it holds.** The backend refuses that
   * one, and the guard is not cosmetic: `wishlist_folders.parent_id` is `ON DELETE CASCADE` **on
   * itself**, so a cycle is a graph SQLite's recursive cascade would walk forever the day the
   * folder is deleted. It is asked of the **destination parent** rather than of the card under
   * the pointer, which is what covers all three landings at once — `inside` a descendant and
   * `before` one are the same cycle, since a descendant's own parent is the dragged folder or
   * something already under it. **No gesture on this page reaches it today**: the wall draws
   * exactly one level, so every card on it is a sibling of every other and a descendant is never
   * on screen beside its ancestor. It is the fence rather than the affordance, and the
   * arrangement that would put the two together is a cabinet that already holds a cycle — which
   * `buildFolderTree` draws at the root as leaves and which only corruption produces.
   *
   * **And a drop that would reproduce the order already on screen is not a write.**
   * `reorderedLevel` is what says so; its `null` is a refusal rather than an error, because
   * dropping a folder back where it already sits is a gesture a reader makes by accident every
   * time they think better of one mid-drag, and a write for it would bump `updated_at` and
   * re-read the list to arrive at what is already drawn.
   *
   * **Flatten is not a case this has to answer**, for the reason `filed` already encodes: with
   * the filing ignored there are no folder cards at all, so there is nothing to pick up and
   * nothing to point at.
   */
  const folderPlacement = useCallback(
    (
      drag: FolderDrag,
      target: FolderNode<WishlistFolder>,
      edge: FolderEdge,
    ): { parentId: number | null; ids: number[] } | null => {
      // `inside` says which drawer and the target *is* it; `before`/`after` say where in the
      // level the target sits in, which is the level being drawn — `folderId`, never the target
      // row's own `parentId`. `buildFolderTree` draws a folder whose parent this list does not
      // carry at the root rather than dropping it, so an orphan's row names a folder that is
      // gone, and sending that as the destination would be a reorder into nothing. What is on
      // screen is the honest answer, and `wishlist_folder_reorder` writing `parent_id` from it
      // files the orphan where the reader can already see it.
      const parentId = edge === "inside" ? target.folder.id : folderId;
      if (parentId !== null && parentId === drag.folderId) return null;
      if (parentId !== null && folderDescendants(folders.folders, drag.folderId).has(parentId)) {
        return null;
      }
      const ids = reorderedLevel({
        // The target's own children for a nest — in the order the tree already draws them, so a
        // nest re-states the level it is joining rather than re-sorting it — and the level on
        // screen for the other two.
        siblings:
          edge === "inside"
            ? target.children.map((child) => child.folder.id)
            : childFolders.map((one) => one.folder.id),
        dragged: drag.folderId,
        target: target.folder.id,
        edge,
      });
      return ids === null ? null : { parentId, ids: [...ids] };
    },
    [folderId, folders.folders, childFolders],
  );

  /**
   * The two halves of {@link folderPlacement}, bound per card by the wall below.
   *
   * **A folder is deliberately not droppable on the breadcrumb, where a wish is**, and the two
   * are not the same gesture wearing different payloads. `wishlist_set_folder` takes one
   * destination and that is the whole of the write, so a trail segment names a complete answer —
   * which is why `WishlistBreadcrumb` takes wish drops at all: without somewhere to drop a wish
   * that moves it *up*, that gesture would only ever push wishes deeper.
   * `wishlist_folder_reorder` takes a destination **and that level's whole order**, and the order
   * is what this gesture is for — a quarter of every folder card means "beside this one, here"
   * (`EDGE_ZONE`). A segment is one word with no order to point into, so the only thing a drop on
   * it could say is "last, in a level that is not on screen", and the folder would leave the wall
   * with nothing drawn saying where it went. The way back out is `Move to folder…`, on the card's
   * own `⋯`, which names every destination including the root — so unlike a wish, a folder is not
   * one gesture short of a route home. If this is revisited, the thing to change is the *mark*,
   * not the target: a segment would need to say "last" before it could honestly take one.
   */
  const canPlaceFolder = useCallback(
    (drag: FolderDrag, target: FolderNode<WishlistFolder>, edge: FolderEdge) =>
      folderPlacement(drag, target, edge) !== null,
    [folderPlacement],
  );
  const placeFolder = useCallback(
    (drag: FolderDrag, target: FolderNode<WishlistFolder>, edge: FolderEdge) => {
      const plan = folderPlacement(drag, target, edge);
      // A `null` writes **nothing at all** — not a reorder of the level as it stands, which would
      // be a transaction to arrive at the list already on screen.
      if (plan !== null) folders.reorder.mutate(plan);
    },
    [folderPlacement, folders.reorder],
  );

  const failure = query.isError ? ipcError(query.error) : null;
  // The *latest* write on the screen, not whichever is still holding an error: a refused stepper
  // press would otherwise leave "Could not change your wishlist" up while the reader went on to
  // remove the row successfully — an alert about something already dealt with. The folder writes
  // are in the list because they are writes this screen makes, and they share the banner because
  // they share the sentence: everything here is a change to the reader's wishlist.
  const bannerFailure = writeFailure([
    setQuantity,
    remove,
    setFolder,
    anyPrinting,
    folders.create,
    folders.rename,
    folders.move,
    folders.reorder,
    folders.remove,
  ]);
  const empty = rows.length === 0;
  // **The trail is drawn only where there is a cabinet to walk.** At the root of a wishlist
  // nobody has filed, a lone inert "Wishlist" under a ribbon that already says Wishlist is the
  // subheading this page's own `sr-only` heading exists to avoid, and there is nowhere for it to
  // lead. It is also what the export dialog's extra clause is gated on, below.
  //
  // **Not the wall's gate** — see {@link cabinet}. The wall is drawn over an empty cabinet
  // because the tile that makes the first folder lives in it.
  const hasFolders = folders.folders.length > 0;
  /**
   * **Does this level hold drawers of its own** — the question {@link statusOf} asks, and the
   * only one this value answers.
   *
   * A level whose content is folder cards is not an empty level, so the status line stays out of
   * their way. `+ New folder` is not content: a wall holding nothing but the tile that makes the
   * first folder is still a level with nothing in it, and it still has to say so.
   */
  const filed = !flatten && childFolders.length > 0;
  /**
   * **Whether the cabinet is drawn at all — and it is drawn over an empty one on purpose.**
   *
   * Deliberately *not* {@link filed}. Gating the wall on “there is at least one folder” was free
   * while `+ New folder` sat in a row of its own; with the tile living **inside** the wall it
   * would be a trap door — a reader whose wishlist has never been filed would have no folder
   * card to draw, therefore no wall, therefore no way to make their first folder, and the cabinet
   * could never be opened by anyone who did not already have one.
   *
   * Flatten is the whole of what closes it, which is where the `+ New folder` note went: a
   * flattened list has no current folder to create one inside, so the control that promises
   * “here” goes with the level it was promising about — one gate now instead of that condition
   * written twice.
   */
  const cabinet = !flatten;

  /**
   * What the export dialog's two sentences have to say about where the reader is standing.
   *
   * `folderId` and `flatten` are already in `wishlist.filters` and already in the sweep's key, so
   * the export has always been *correct* — it is the words that were not. Standing in `Ordered`
   * with nothing typed, the dialog said `3 cards matching your filters` and offered
   * "Export everything, ignoring the filters", when the only thing narrowing anything was the
   * drawer neither sentence mentioned.
   *
   * **`narrows` is not simply "am I in a folder"**, because the top level narrows too: an absent
   * `folderId` asks the backend for the wishes filed *nowhere* rather than for all of them
   * (`WishlistQuery.folderId`), so a reader at the root of a cabinet is looking at a sweep that
   * leaves every drawer out. It is off while the list is flattened, where the level on screen
   * already is every folder, and off for a wishlist nobody has filed, where there is no cabinet
   * to speak of and the extra clause would be about nothing.
   */
  const exportFiling = {
    folder: !flatten && folderId !== null ? folderNameOf(folderId) : null,
    narrows: hasFolders && !flatten,
  };
  const status = statusOf(wishlist, failure, { filed, inFolder: !flatten && folderId !== null });

  // The notes a total needs to stay honest, in one string because they are one qualification
  // of one figure. The second is the rare one: the backend pages at 100 and a shopping list
  // is tens of rows, so a sum taken over part of the list is a case that has to be *said*
  // rather than a case that has to be common. The first is about the currency on screen —
  // the unpriced rows are not the same rows in dollars and in euros.
  const counted = rows.length < total ? `${rows.length} of ${total} counted` : null;
  const note =
    [cost.unpriced > 0 ? `${cost.unpriced} unpriced` : null, counted].filter(Boolean).join(" · ") ||
    undefined;

  /** Everything both layouts are handed about the cabinet, in one object because it is one set
   *  of facts and the wall and the table must not be given different halves of it. */
  const filing = {
    folders: folders.folders,
    nodes,
    folderNameOf,
    flattened: flatten,
    onSetFolder,
    onChangePrinting,
    onAnyPrinting,
  };

  return (
    <section className="flex h-full flex-col gap-4">
      {/* Not drawn: the ribbon's `h1` already names the view, and a second Cinzel "Wishlist"
          under it would be a subheading repeating its own heading. */}
      <h2 className="sr-only">Wishlist</h2>

      <FigureRow
        // The band's far end, where they used to sit beside the filter row — see `FigureRow`,
        // which is where the placement is argued, and `CollectionPage`, whose twin this is.
        actions={
          <ImportExportPair
            onImport={() => setImporting(true)}
            onExport={() => setExporting(true)}
            importLabel="Import wishes"
            exportLabel="Export wishlist"
          />
        }
      >
        {/* **Both figures describe what is on screen**, which is the folder the reader is
            standing in — or the whole list, one press of Flatten away from anywhere. Neither is
            arithmetic this page does to make that true: `wishlist_list` takes the folder and the
            flatten flag, so `total` is already the count of the level being drawn and `cost` is
            already summed over its rows. A header that always totalled the whole wishlist would
            contradict the folder cards underneath it, each of which speaks for its own drawer. */}
        <Figure label="Wishes" value={query.isPending ? "—" : count(total)} />
        {/* The one number this view exists for, in the currency the reader picked — spec §7
            says this header mirrors the collection's, and that one now prices in one
            currency too. Spec §5: it says how old the prices are, and whose they are.

            Etched printings have no EUR price in Scryfall's data at all — `eur_etched` is
            documented and absent — so on Cardmarket a wish for one is left out of this sum
            and counted in the note rather than quoted at the nonfoil rate. */}
        <Figure
          label={`Still to buy (${currency.toUpperCase()})`}
          value={query.isPending || empty ? "—" : formatPrice(cost.total, currency)}
          note={note}
          title={pricesAsOf(marketplace)}
        />
      </FigureRow>

      {/* The same row the search, the Tags page and the collection draw, over this page's own
          hook — see `FilterBar`, whose prop is a structural `FilterSurface` that `useWishlist`
          satisfies. It is also where this list stopped being the app's odd page out: every card
          filter on that row was already a field `wishlist_list` read (`WishlistQuery extends
          CardFilters`) and this hook simply never sent one. */}
      <FilterBar
        search={wishlist}
        labels={WISHLIST_LABELS}
        sortRows={wishlist.sortRows}
        tray={WISHLIST_TRAY}
        layoutFor="wishlist"
        // On, it ignores the filing entirely: no folder cards, no drill-down, and every wish in
        // the list at once, each captioned with the folder it is filed in instead — the only way
        // a reader sees a card's folder without opening it. One press either way, since there is
        // no third state to walk.
        flatten={{ pressed: wishlist.flatten, onToggle: wishlist.toggleFlatten }}
      />

      <div className="flex min-h-0 flex-1 flex-col gap-2">
        {/* **The fence is “not among the filters”, and it was never “not on the bar” — which is
            the half of this note that changed when Flatten moved.** `resetAll` leaves both
            `folderId` and `flatten` alone (`useWishlist` says so of each), so either one drawn as
            a *filter* would be the one control in that row Reset all could not undo. But the bar
            already has a home for controls that are not filters: past the second hairline, beside
            the sort and the grid-or-table pair, where every control says how the list is **drawn**
            rather than which rows are in it — and `FilterBar`'s own comment above `ViewToggle`
            says in as many words that nothing there is counted or cleared by Reset all. Flatten
            is exactly that kind of statement, so it rides the bar on the far side of the hairline
            and satisfies the fence rather than breaking it.

            **The breadcrumb does not follow it, and that is the surviving half.** Where the reader
            is standing is not a way of drawing the list — it is a *place*, one the folder cards
            below are the doors into — so the drill-down and the trail back out stay down here with
            the cabinet they are about. This row is the whole of what is left of the old one, so it
            is drawn only where there is a trail to draw: an empty flex row is chrome with nothing
            in it. */}
        {hasFolders && (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <div className="min-w-0 flex-1">
              <WishlistBreadcrumb
                // Root-most first and **without the root**, which the breadcrumb prepends itself:
                // `null` is a destination rather than a folder, and only that component knows what
                // it calls it.
                trail={trail}
                flattened={flatten}
                onOpen={wishlist.openFolder}
                canDrop={canFile}
                onDropWish={fileWish}
              />
            </div>
          </div>
        )}

        {/* **One strip for all four folder layers, and it is not a placement decision so much as
            the only place there is.** Every other anchored layer in this app hangs off a
            `relative` wrapper around its own trigger; the two triggers here are the filter bar's
            `+ New folder` and a folder card's `⋯`, and neither component has anywhere to hang a
            panel — a card that hosted one would also clip it against the scroller below. So the
            strip sits where the thing being named or moved is: directly above the row of cards,
            under the breadcrumb that says which level they are. */}
        {openPanel !== null && (
          <div className="w-full max-w-sm shrink-0 rounded-lg border border-border bg-surface p-2 text-xs">
            {(openPanel.kind === "newFolder" || openPanel.kind === "renameFolder") && (
              <FolderNameField
                // Remounted between two openings, so a half-typed name never survives into the
                // next question — the field holds its own draft, and `AnchoredPopup`'s trick of
                // unmounting the body is not available to a strip that stays.
                key={
                  openPanel.kind === "renameFolder"
                    ? `rename-${openPanel.folderId}`
                    : `new-${openPanel.parentId ?? "root"}`
                }
                initial={
                  openPanel.kind === "renameFolder"
                    ? (folderNameOf(openPanel.folderId) ?? "")
                    : ""
                }
                label={
                  openPanel.kind === "renameFolder"
                    ? `Rename ${folderNameOf(openPanel.folderId) ?? "folder"}`
                    : "New folder name"
                }
                where={
                  openPanel.kind === "newFolder"
                    ? `in ${folderNameOf(openPanel.parentId) ?? ROOT_LABEL}`
                    : undefined
                }
                submitLabel={openPanel.kind === "renameFolder" ? "Rename folder" : "Create folder"}
                pending={folders.create.isPending || folders.rename.isPending}
                onCancel={dismiss}
                onSubmit={nameFolder}
              />
            )}

            {openPanel.kind === "moveFolder" && (
              <MoveToFolder
                label={`Move ${folderNameOf(openPanel.folderId) ?? "folder"} into a folder`}
                nodes={nodes}
                currentId={
                  folders.folders.find((f) => f.id === openPanel.folderId)?.parentId ?? null
                }
                // The wishlist's own word for the top level. `MoveToFolder` defaults to the deck
                // gallery's, which is the surface it was written for.
                rootLabel={ROOT_LABEL}
                // A folder may not go inside itself or inside anything it holds. The backend
                // refuses it in words — `wishlist_folders.parent_id` cascades onto itself, so a
                // cycle is a graph SQLite would walk forever the day the folder is deleted — and
                // that refusal is a fence rather than the affordance.
                forbidden={
                  new Set([
                    openPanel.folderId,
                    ...folderDescendants(folders.folders, openPanel.folderId),
                  ])
                }
                forbiddenReason="A folder cannot go inside itself, or inside anything it holds."
                // Drawn **into** the strip rather than as a popup of its own: the strip is the
                // layer, and a second box with its own shadow and its own z-index over it would
                // be a second Escape rung for one decision.
                inline
                pending={folders.move.isPending}
                onPick={(parentId) =>
                  folders.move.mutate({ id: openPanel.folderId, parentId }, { onSuccess: dismiss })
                }
                onClose={close}
              />
            )}

            {openPanel.kind === "deleteFolder" && (
              <DeleteFolderConfirm
                name={folderNameOf(openPanel.folderId) ?? "this folder"}
                pending={folders.remove.isPending}
                onConfirm={() =>
                  folders.remove.mutate(openPanel.folderId, { onSuccess: dismiss })
                }
                onCancel={dismiss}
                onClose={close}
              />
            )}
          </div>
        )}

        {cabinet && (
          // **The scroller is what makes the cabinet a band rather than the page.** A reader with
          // twenty drawers must not lose the wall to them, so the row of cards is bounded and
          // scrolls inside itself.
          //
          // `DROP_MARK_ROOM` is what that costs: `overflow` clips at the padding box, a
          // `DROP_RING` is a box shadow painted *outside* the border box, so a folder card flush
          // against the content edge would lose the outer 2px of its ring for the whole length of
          // a drag — and the `FOCUS` outline 4px proud of it, which is a WCAG 2.4.7 failure rather
          // than a cosmetic one. It goes on the box carrying the `overflow`; one level in is not
          // the same fix. `relative` for the rule beside it: a scroll container has to be the
          // containing block for its own absolutely positioned content, or an `sr-only` label
          // inside stretches the document. jsdom has no layout engine and can see none of this.
          //
          // **`max-h-44` is a ceiling and not a height, which is what makes a wall holding only
          // the `New folder` tile look right** — measured 2026-08-26 in headless Edge over the
          // built stylesheet, at the story decorator's 1032px content column. The tile alone
          // draws this box **74px** tall (62 for the tile, `p-1.5` either side) rather than
          // standing 176px of empty band under one card; the tile and a folder card measure the
          // same 62, so the first row is never ragged; and thirteen cards still want 214 and are
          // clamped to 176 with a scrollbar, which is the case this `max-h` was written for.
          <div
            className={cn("relative max-h-44 shrink-0 overflow-y-auto", DROP_MARK_ROOM)}
          >
            <ul
              aria-label="Folders"
              className="grid grid-cols-[repeat(auto-fill,minmax(180px,1fr))] gap-2"
            >
              {/* **First, and shaped like the cards it makes.** A wall of drawers is where a
                  reader looks for the drawer they want, so it is also where they look for the one
                  that is not there yet — and the tile is the only thing in this `<ul>` on a
                  wishlist nobody has filed, which is what {@link cabinet} exists to allow.

                  It is handed {@link openNewFolder} directly rather than through an arrow: the
                  panel this raises has to give the caret back to the control it was raised from,
                  and `NewFolderCard` hands over its own button for exactly that. */}
              <NewFolderCard onClick={openNewFolder} />
              {childFolders.map((node) => (
                <WishFolderCard
                  key={node.folder.id}
                  node={node}
                  // The recursive total, never the summary row: that one is direct per folder,
                  // and a folder holding two sub-folders of six wishes each has none of its own.
                  //
                  // **`null` while the summary is still reading, and that is not the same
                  // fallback as `NO_WISHES`.** This wall is gated on the folder *list*, which is
                  // one flat `SELECT`; the figures come from a `GROUP BY` with the owned-copies
                  // subquery and a price expression behind it, and it answers later. Across that
                  // window a `Map.get` miss is indistinguishable from an empty drawer, so a
                  // folder holding six wishes worth $312 drew `0 wishes` and then jumped — a
                  // wrong number rather than a spinner. `isPending` is exactly the read that has
                  // never answered *for this marketplace*, which is the right span: switching
                  // marketplace is a new key, and the old currency's subtotals are not this
                  // one's to draw either.
                  summary={
                    folders.summaryQuery.isPending
                      ? null
                      : (subtotals.get(node.folder.id) ?? NO_WISHES)
                  }
                  currency={currency}
                  onOpen={() => wishlist.openFolder(node.folder.id)}
                  rowMenu={folderRowMenu(node.folder)}
                  canDrop={(drag) => canFile(drag, node.folder.id)}
                  onDropWish={(drag) => fileWish(drag, node.folder.id)}
                  // The card asks about the folder in the air and where on itself it is; the
                  // page adds which card that is, because only the page holds the level and the
                  // tree the answer is worked out from.
                  canDropFolder={(drag, edge) => canPlaceFolder(drag, node, edge)}
                  onDropFolder={(drag, edge) => placeFolder(drag, node, edge)}
                />
              ))}
            </ul>
          </div>
        )}

        {/* One live region, mounted for the life of the view: a region that appears together
            with its text announces nothing, because there was no change for a screen reader
            to notice. Empty — and therefore no taller than nothing — while the list below is
            answering for itself. */}
        <p
          role="status"
          className={cn(
            empty && status ? "py-16 text-center text-sm" : "text-xs",
            empty && failure ? "text-destructive" : "text-dim",
          )}
        >
          {status}
        </p>

        {/* A write that was refused, said where the writing happened. Not folded into the
            line above: that one describes the list, and this one describes something the
            reader just did to it.

            It grows into place instead of shoving the table down by its whole height. The
            animated element is the wrapper and carries only `overflow-hidden`, because
            `statusLine` takes `height` to 0 and a box with its own padding and border can
            never — under `box-sizing: border-box` — be shorter than the two of them. */}
        <AnimatePresence initial={false}>
          {bannerFailure && (
            <motion.div {...statusLine} className="overflow-hidden">
              <p
                role="alert"
                className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive"
              >
                Could not change your wishlist — {bannerFailure}
              </p>
            </motion.div>
          )}
        </AnimatePresence>

        {/* A write the right-click menu started and the backend refused, beside the banner
            above rather than folded into it: that one is about this list's own controls — a
            stepper press, a removal — and this one is about a card the reader filed somewhere
            from a menu that has already closed. */}
        <CardMenuRefusal error={menuFailure} />

        {!empty &&
          (view === "grid" ? (
            <WishlistGrid
              rows={rows}
              listKey={wishlist.queryKeyString}
              onNeedNextPage={onNeedNextPage}
              onSetQuantity={onSetQuantity}
              onRemove={onRemove}
              rowMenu={rowMenu}
              rowMenuKey={rowMenuKey}
              marketplace={marketplace}
              {...filing}
            />
          ) : (
            <WishlistTable
              rows={rows}
              total={total}
              listKey={wishlist.queryKeyString}
              sort={wishlist.sort}
              onSort={wishlist.toggleSort}
              onNeedNextPage={onNeedNextPage}
              onSetQuantity={onSetQuantity}
              onRemove={onRemove}
              rowMenu={rowMenu}
              rowMenuKey={rowMenuKey}
              marketplace={marketplace}
              {...filing}
            />
          ))}

        {/* **Spec §5: a price is never shown without saying how old it is** — and, with five
            marketplaces in the picker, whose it is. `pricesAsOf` answers both, and names which of
            the two clocks this marketplace runs on: the card-data sync for the blob-backed pair,
            the last price-feed refresh for the two this app downloads itself.

            **The rule reaches this wall as of 2026-08-26**, when the tiles' chins started quoting
            what one copy costs. `WishlistGrid` already binds the same sentence as a tooltip on the
            corner mark, and that is **not** this line and does not stand in for it: that one is
            attached to the cost still to buy — `unit × copies missing` — and is drawn on no wish
            the reader has finished, while the chin's figure is on every tile.

            **Said once, under the wall, rather than on every tile** — the argument the search
            page, the Tags page, the printings modal and the deck's docked panel all make, and the
            reason the chin's money slot is a plain string rather than a tooltip binding.

            **Grid only.** The table states it in the Cost column's own header (`WishlistTable`'s
            `columnsFor`), so drawing it here as well would say it twice in one view. */}
        {!empty && view === "grid" && (
          <p className="shrink-0 text-[0.7rem] text-dim">{pricesAsOf(marketplace)}</p>
        )}
      </div>

      {/* Mounted unconditionally — `CollectionPage`'s reason: `Dialog` renders nothing while
          closed, and staying in the tree is what lets its scrim fade out on close instead of
          the whole thing vanishing the instant `exporting` flips back. */}
      <ExportDialog
        open={exporting}
        subject="your wishlist"
        surface="wishlist"
        cards={exportScope.cards}
        suggestedFileName="wishlist"
        onDismiss={() => setExporting(false)}
        onClose={() => setExporting(false)}
        scope={{
          label: scopeLabel(exportScope.total, exportScope.everything, exportFiling),
          everythingLabel: everythingLabel(exportFiling),
          loading: exportScope.loading,
          everything: exportScope.everything,
          onEverything: exportScope.setEverything,
        }}
      />

      {/* One destination — the wishlist itself — so no destination radios are drawn, and
          `onDone`'s message is discarded, `CollectionPage`'s precedent. */}
      <ImportDialog
        destinations={[wishlistDestination]}
        open={importing}
        onDismiss={() => setImporting(false)}
        onClose={() => setImporting(false)}
        onDone={() => setImporting(false)}
      />
    </section>
  );
}

/**
 * The one field the cabinet has, doing whichever of its two jobs the open `Panel` says.
 *
 * `FolderTree`'s `FolderNameField` in this page's room, and it keeps that field's two decided
 * details: the current name arrives **selected**, because the commonest rename replaces the word
 * rather than edits inside it; and both `focus()` and `select()` are called, in that order,
 * because the spec says `select()` only sets the selection and jsdom implements the spec — a
 * browser that focuses on select is what makes the missing call look sufficient.
 *
 * What it does *not* keep is that field's icon-only submit: a 208px tree column had no room for
 * two text buttons and this strip has, so the two controls say what they do. Escape's job stays
 * the page's — this field is one arm of its `Panel`, so the page's single rung already closes it
 * and a rung of its own would be a second registration for one layer.
 */
function FolderNameField({
  initial = "",
  label,
  where,
  submitLabel,
  pending,
  onCancel,
  onSubmit,
}: {
  initial?: string;
  /** The input's accessible name — "New folder name", or "Rename Ordered". */
  label: string;
  /** "in Ordered" / "in Wishlist" — where the folder will land, in words, for a reader who
   *  cannot see which level the strip is drawn over. Absent for a rename: the folder is not
   *  going anywhere. */
  where?: string;
  /** The submit control's words, which is the only place the two jobs read differently. */
  submitLabel: string;
  pending: boolean;
  onCancel: () => void;
  onSubmit: (name: string) => void;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [name, setName] = useState(initial);

  useEffect(() => {
    const input = inputRef.current;
    if (input === null) return;
    input.focus();
    input.select();
  }, []);

  const trimmed = name.trim();

  return (
    <div
      ref={rootRef}
      // Clicking or tabbing away discards a half-typed name, exactly as every other layer in
      // this app discards its half-made decision — and not while the write is in flight, because
      // a control that disables itself on the press is blurred by the browser with no
      // `relatedTarget` at all, which would read as the reader looking away.
      onBlur={(e) => {
        if (pending) return;
        if (!rootRef.current?.contains(e.relatedTarget)) onCancel();
      }}
    >
      <form
        className="flex items-center gap-1.5"
        onSubmit={(e) => {
          e.preventDefault();
          if (!trimmed) return;
          onSubmit(trimmed);
        }}
      >
        <input
          ref={inputRef}
          aria-label={label}
          value={name}
          onChange={(e) => setName(e.target.value)}
          className={cn(
            "h-7 min-w-0 flex-1 rounded-md border border-border bg-bg px-2 text-xs",
            "focus:border-accent focus:outline-none",
          )}
        />
        <button
          type="submit"
          // A real `disabled`, not `aria-disabled`: the house rule is about controls that grey
          // as the reader types *and still have something to say*, and this one is a submit whose
          // whole meaning is the field beside it. `FolderTree`'s field makes the same call.
          disabled={!trimmed || pending}
          className={cn(
            "h-7 flex-none rounded-md border border-accent px-2 text-accent",
            "transition-colors duration-150 hover:bg-accent hover:text-accent-foreground",
            "disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-accent",
            "motion-reduce:transition-none",
            FOCUS,
          )}
        >
          {submitLabel}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className={cn(
            "h-7 flex-none rounded-md border border-border px-2 text-dim",
            "transition-colors duration-150 hover:text-text motion-reduce:transition-none",
            FOCUS,
          )}
        >
          Cancel
        </button>
      </form>
      {where && <p className="mt-1 text-[0.7rem] text-dim">{where}</p>}
    </div>
  );
}

/**
 * The question a reader will guess wrong, and the sentence that answers it.
 *
 * **Deleting a folder does not delete the wishes in it.** `wishlist_entries.folder_id` is
 * `ON DELETE SET NULL`, so they surface at the root — filed nowhere and otherwise exactly as they
 * were, still on the shopping list, still counted. `wishlist_folders.parent_id` is
 * `ON DELETE CASCADE` **on itself**, so the folders inside *do* go. The two cascades point
 * opposite ways and the confirmation says both, in that order: the reassuring half first, because
 * the fear is what stops the press.
 *
 * One sentence rather than the deck gallery's counted pair, because the two lists are counted
 * differently: a folder card's own face already says how many wishes are in the drawer, in the
 * recursive number this page summed for it, so a confirmation repeating it would be the same
 * figure twice with two chances to disagree.
 */
function DeleteFolderConfirm({
  name,
  pending,
  onConfirm,
  onCancel,
  onClose,
}: {
  name: string;
  pending: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  onClose: () => void;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  // The caret moves into the layer, as it does for every other one in the app, so Escape has
  // something to hand back and Tab reaches the two answers next.
  useEffect(() => {
    panelRef.current?.focus();
  }, []);

  return (
    <div
      ref={panelRef}
      tabIndex={-1}
      role="group"
      aria-label={`Delete ${name}`}
      className={cn("rounded-md", FOCUS)}
      onBlur={(e) => {
        if (pending) return;
        if (!panelRef.current?.contains(e.relatedTarget)) onClose();
      }}
    >
      <p>Delete “{name}”?</p>
      <p className="mt-1 leading-relaxed text-dim">
        Its wishes move back to your wishlist; folders inside it are deleted.
      </p>
      <div className="mt-2 flex gap-2">
        <button
          type="button"
          onClick={onConfirm}
          disabled={pending}
          className={cn(
            "rounded-md border border-destructive px-2 py-1 text-destructive",
            "transition-colors duration-150 hover:bg-destructive hover:text-bg",
            "disabled:opacity-50 motion-reduce:transition-none",
            FOCUS,
          )}
        >
          Delete folder
        </button>
        <button
          type="button"
          onClick={onCancel}
          className={cn(
            "rounded-md border border-border px-2 py-1 text-dim",
            "transition-colors duration-150 hover:text-text motion-reduce:transition-none",
            FOCUS,
          )}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

/**
 * The one line that says what the list area is currently showing, or nothing at all.
 *
 * **Where the reader is standing changes what an empty list means**, which is the whole of what
 * the second argument is for. An empty root is a wishlist nobody has written on and the sentence
 * names the control that fills it; an empty *folder* is a drawer the reader made and has not
 * filed anything in yet, and telling them how to add a card to a wishlist they already have is
 * answering a question they did not ask. And a level whose content is folder cards is not empty
 * at all — the cards are the content, so the line stays out of their way.
 */
function statusOf(
  wishlist: Wishlist,
  failure: string | null,
  { filed, inFolder }: { filed: boolean; inFolder: boolean },
): string {
  const { query, rows, activeCount } = wishlist;

  if (rows.length === 0) {
    if (failure) return failure;
    if (query.isPending) return "Reading your wishlist…";
    // Something was filtered out rather than never there: a statement about the filters.
    if (activeCount > 0) return "No wishes match these filters.";
    // Drawers, and nothing loose beside them. The cards below are the answer to "what is here",
    // and a sentence over them would be the page contradicting itself.
    if (filed) return "";
    // Nothing filtered and nothing there. Two statements, and which one is honest depends on
    // where the reader is: "No wishes match" would blame the reader for a list nobody has put
    // anything on yet, and the root's instruction would answer the wrong question inside a
    // folder they have just made.
    return inFolder
      ? "Nothing filed here yet."
      : "Nothing on your wishlist yet. Add cards from search with the + on any row or tile.";
  }

  // With rows on screen the list captions itself and the header above counts it, so the only
  // thing left to say is that something is still on its way.
  if (query.isFetchingNextPage) return "Loading more…";
  if (query.isFetching) return "Updating…";
  return failure ?? "";
}
