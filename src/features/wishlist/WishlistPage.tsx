import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import { useMutation, useQuery, useQueryClient, type InfiniteData } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, Eraser, FolderInput, TrendingDown, Trash2 } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import type { MenuItem } from "@/components/menu/types";
import { useContextMenu } from "@/components/menu/useContextMenu";
import { Figure, FigureRow } from "@/components/Figure";
import { buildCardMenu, type CardMenuTarget } from "@/features/card/cardMenu";
import { CardMenuRefusal } from "@/features/card/CardMenuRefusal";
import { listWalkStops, usePublishCardWalk } from "@/features/card/cardWalk";
import { useCardMenuDeps } from "@/features/card/useCardMenuDeps";
import { MoveToFolder } from "@/features/decks/MoveToFolder";
import { deckListKey } from "@/features/home/keys";
import { ShelfLabel } from "@/features/shelves/ShelfLabel";
import { FOLD_PAUSED_REASON, ShelfToolbar } from "@/features/shelves/ShelfToolbar";
import { useFoldAnchor } from "@/features/shelves/useFoldAnchor";
import { useFoldOnFolderDrag } from "@/features/shelves/useFoldOnFolderDrag";
import {
  caretIsNowhere,
  pathRowAddFolder,
  sameIds,
  useHeadingCaret,
} from "@/features/shelves/useHeadingCaret";
import { ExportDialog } from "@/features/transfer/export/ExportDialog";
import { everythingLabel, scopeLabel, useExportScope } from "@/features/transfer/export/scope";
import { wishlistDestination } from "@/features/transfer/import/destinations/WishlistPreview";
import { ImportExportPair } from "@/features/transfer/ImportExportPair";
import { ImportDialog } from "@/features/transfer/import/ImportDialog";
import type { SearchCardDrag } from "@/features/search/searchCardDrag";
import { FilterBar, StatedFiltersLine, type FilterLabels, type TrayCell } from "@/features/search/FilterBar";
import { count, plural, verb } from "@/lib/counts";
import { useDragRecord } from "@/lib/dndTarget";
import { readFolderDrag, type FolderDrag, type FolderEdge } from "@/lib/folderDrag";
import { reorderedLevel } from "@/lib/folderOrder";
import { isFinish } from "@/lib/finish";
import { FOCUS } from "@/lib/focus";
import {
  buildFolderTree,
  flattenFolders,
  folderDescendants,
  folderLevel,
  type FolderNode,
} from "@/lib/folderTree";
import {
  ipc,
  ipcError,
  type WishlistFolder,
  type WishlistPage as Page,
  type WishRow,
} from "@/lib/ipc";
import { LAYER } from "@/lib/layers";
import { statusLine } from "@/lib/motion";
import { formatPrice, pricesAsOf } from "@/lib/prices";
import { layoutShelves } from "@/lib/shelfLayout";
import { buildShelves, visibleShelves, type Shelf } from "@/lib/shelves";
import { useAppStore } from "@/lib/store";
import { useDeskWidth } from "@/lib/useDeskWidth";
import { useDismissOnEscape } from "@/lib/useDismissOnEscape";
import { useDockHeight } from "@/lib/useDockHeight";
import { useReviewHandoff } from "@/lib/useReviewHandoff";
import { cn } from "@/lib/utils";
import { writeFailure } from "@/lib/writes";
import { refreshCardSearches } from "@/lib/searchMarks";
import { ManagedFolderNote } from "./ManagedFolderNote";
import { managedEmptySentence, managedIds, userWishFolders } from "./managed";
import { WishlistBreadcrumb } from "./WishlistBreadcrumb";
import { WishlistSearchPanel } from "./WishlistSearchPanel";
import { WishlistGrid, type WishShelves } from "./WishlistGrid";
import { WishlistTable, type WishTableBands } from "./WishlistTable";
import { OptimizeWishlistDialog } from "./OptimizeWishlistDialog";
import { useWishlist, type Wishlist } from "./useWishlist";
import { useWishlistFolders } from "./useWishlistFolders";
import { useWishlistOptimize } from "./useWishlistOptimize";
import { wholeWishlistQuery } from "./wholeWishlistQuery";
import type { WishDrop } from "./wishDrag";
import {
  WishEmptyShelf,
  WishManagedEmpty,
  WishShelfHeading,
  WishShelfSticky,
  type CardDrops,
} from "./WishShelfHeading";
import {
  countTotals,
  effectiveCounts,
  fileTarget,
  foldChanges,
  foldFor,
  foldedForDrag,
  isBand,
  keepNewFolder,
  newFolderShelf,
  NEW_FOLDER_SHELF,
  rowsByShelf,
  sectionsOf,
  shelfOfWish,
  shelfStat,
  shelfTable,
  type ShelfFigures,
} from "./wishShelfPlan";

/**
 * What the top of the cabinet is called, here and in the two lists this page hands it to.
 *
 * `WishlistBreadcrumb` spells its own copy of this word, because a breadcrumb that had to be
 * told what its own first segment is called would be a component that does not know what it is
 * drawing. This one is the *page's* copy, for the two places the page has to say it: the optimise
 * dialog's scope, and `MoveToFolder`'s top row — whose default is the deck
 * gallery's "All decks", which is the wrong sentence to show a reader filing a card they are
 * buying.
 */
const ROOT_LABEL = "Wishlist";

/**
 * The root as {@link reorderedLevel} has to address it — an id no folder has, because
 * `wishlist_folders.id` is an `INTEGER PRIMARY KEY` and therefore always positive.
 *
 * Only a folder dropped on the breadcrumb's root segment needs it, and only to satisfy an argument
 * it does not use: an `inside`
 * landing reads `target` for one thing, the "dropped on itself" refusal, and a folder can never
 * be dropped on the root. The alternative is widening `reorderedLevel`'s `target` to
 * `number | null`, which would put a case in the shared arithmetic that only one caller has.
 * `DecksPage` spells the same constant for the same reason.
 */
const ROOT_TARGET = 0;

/**
 * The width the wishlist's own list must keep, in px — **`DeckEditor`'s `DECK_FLOOR` read across to
 * a page that draws two things rather than one**, and the number the docked search column is railed
 * by.
 *
 * The deck's floor is 192 because that is one stack column. This page's list is one wall of
 * shelves since the folder band went (2026-09-26), and 192 holds a column of its tiles: a wall too
 * narrow for a whole 170px tile draws it at the wall's own width instead (`CardGrid`'s
 * `tileWidthFor`), so the column narrows rather than overflowing. `CollectionPage` spells the same
 * number for the same arithmetic; the
 * two pages have the identical work column, which is the whole reason this sidebar was one change
 * rather than two.
 *
 * **Measured in the shipped window on 2026-09-07** (`npm run tauri dev`, a debug build, against a
 * real 89-wish list), and the measurement split it in two the way `CollectionPage`'s was split:
 * **the floor is the *view's*, not the page's.** The card wall holds at 192 — driven down to a
 * 192px list it never overflowed its own box. The table does not.
 *
 * **This page's table fails later than the collection's, and the difference is one column.**
 * `WishlistTable` draws Name, Printing · finish, Wanted, Cost and Actions where
 * `CollectionTable` draws six of its own including Folder, so the name column here reads 335px at
 * a 936px list, **122 at 616** and 25 at 470 — against the collection's 371 / 51 / gone. 616 is
 * this page's list at the app's own 1280×800 reference window, so the shipped default was
 * survivable here and plainly broken one page over. A floor is still owed: 25px of card name at
 * 1118 is not a list.
 *
 * {@link TABLE_FLOOR} is 610 — the ~495 this table's other five columns and its gaps take at that
 * rung, plus a name column worth having. **Deliberately not the collection's 680**, which would be
 * the two pages agreeing on a number neither measured; they draw different columns and the
 * arithmetic says so.
 */
const CARD_FLOOR = 192;
const TABLE_FLOOR = 610;

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
 * always asked about a **heading**, anywhere below the level the reader is standing on, and there
 * is nothing else on the page holding which one. `clearFolder` carries its own for the same
 * reason: it is asked from the same heading's `⋯`.
 */
type Panel =
  | { kind: "newFolder"; parentId: number | null }
  | { kind: "renameFolder"; folderId: number }
  | { kind: "moveFolder"; folderId: number }
  | { kind: "deleteFolder"; folderId: number }
  | { kind: "clearFolder"; folderId: number }
  | null;

/** What a folder's heading reads — the recursive total, summed by {@link subtotalsOf}. */
interface FolderTotals {
  wishes: number;
  copies: number;
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
const NO_WISHES: FolderTotals = { wishes: 0, copies: 0, cost: 0, unpriced: 0 };

/** No rows on a shelf — one identity, so `rowsOf` hands `WishlistGrid` a stable array. */
const NO_ROWS: readonly WishRow[] = [];
/** No thumbnails — a shelf the counts have not reached yet. */
const NO_PEEK: readonly { cardId: string; name: string }[] = [];

/**
 * The button that was just pressed, for a control whose callback carries no event — a heading's
 * Add folder and Rename, the path row's Add folder. A pressed button holds the caret in Chromium,
 * so it is what `dismiss` hands the caret back to.
 */
function pressedElement(): HTMLElement | null {
  const active = document.activeElement;
  return active instanceof HTMLElement && active !== document.body ? active : null;
}

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
 * reader: a trail that gave up would leave them inside a folder with no way back out.
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
      total.copies += under.copies;
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
 * **Since the shelves (2026-09-26) the wall is the whole cabinet**: every wish at and below the
 * level the reader stands on, one shelf per folder, nested, in tree order — with the breadcrumb and
 * the shelf controls on a path row above it. Both layouts draw the same shelves, so the wall and the
 * table navigate identically. The filing is the backend's: `wishlist_list` takes the shelves to
 * return, so the rows below are already the rows of the wall and nothing here filters.
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
 * The card search's printing cells, `border` among them (issue #573 — a wish is for a printing,
 * and the printing has a frame), then `needsReview`, which only a list the reconciler walks can
 * ask. **No `finish` cell**, although the collection's tray has one: a wish carries the finish
 * the reader *prefers*, which is neither the card search's question (what the printing was
 * published in) nor the collection's (what a copy is), and a cell drawn here would be read as one
 * of those two while filtering by the third. **No `price` cell**, and
 * that is the one absence here that is a fact about the wire rather than about the screen:
 * `WishlistQuery` carries no `priceMin`/`priceMax`, so the band would be a control whose numbers
 * reach nothing — which is why those three fields are the optional half of `FilterSurface`.
 *
 * **`needsReview` is drawn unconditionally**, where the chip it replaces appeared only once the
 * reconciler had flagged something. That rule was about a *row*, where a control spending its
 * whole life saying nothing is a control the reader learns to stop reading; in a shut tray it
 * costs nothing, and a cell that came and went would be the one thing in this list that moved.
 */
// `fulfilled` sat between `rarity` and `needsReview` until 2026-09-08 — the Fulfilled / Still
// missing pair, which asked the backend which wishes the collection already covered. It went with
// every other comparison this list made against the binder.
const WISHLIST_TRAY: readonly TrayCell[] = [
  "set",
  "format",
  "rarity",
  "type",
  "border",
  "needsReview",
];

export function WishlistPage() {
  // The To review widget's needs-review hand-off — `useReviewHandoff` has the whole rule.
  const review = useReviewHandoff("wishlist");
  const wishlist = useWishlist({ initialNeedsReview: review.initialNeedsReview });
  review.settle(wishlist.needsReview, wishlist.setNeedsReview);
  const {
    query,
    rows,
    marketplace,
    folderId,
    shelves,
    shelfFolders,
    folds,
    filtering,
    setFold,
    setMany,
    openFolder,
    // The level asked for, which `folderId` — the level drawn — lags while a walk answers. The
    // render-phase hand-offs below compare against this one, or they would ask again every render
    // of the hold; everything that draws reads `folderId`.
    requestedFolderId,
  } = wishlist;
  const view = useAppStore((s) => s.wishlistView);
  const openAllPrintings = useAppStore((s) => s.openAllPrintings);
  const queryClient = useQueryClient();
  const folders = useWishlistFolders();

  /**
   * **The folder another surface asked this page to open on its way in** — `store.ts`'s
   * `pendingFolder`, `CollectionPage`'s consume site on the other cabinet and argued in full
   * there. The short of it: a render-phase adjustment rather than a mount effect, because that is
   * React's own answer for state that has to follow something upstream and because a
   * `setFolderId` inside a `useEffect` body is a lint failure; it waits for the census, since
   * *is that drawer still there* cannot be asked of a list that has not answered; a hand-off
   * naming a folder this cabinet no longer carries is dropped in silence, the reader landing at
   * the root, which is where a deleted folder's wishes have just gone; and it is spent either
   * way, because a hand-off that survived its read would drop the reader back into that drawer
   * every later visit — the folder-restored-at-launch behaviour `useWishlist` refuses in words.
   *
   * **`scope` is what keeps the two pages from reading each other's post.** One field serves both
   * cabinets, so the check is not "is there a hand-off" but "is there one for me": a press on a
   * collection tile that somehow reached this page must fall through untouched rather than open
   * whichever wishlist folder happens to share that id.
   */
  const pendingFolder = useAppStore((s) => s.pendingFolder);
  const clearPendingFolder = useAppStore((s) => s.clearPendingFolder);
  const pendingHere =
    pendingFolder !== null && pendingFolder.scope === "wishlist" && !folders.query.isPending
      ? pendingFolder.id
      : null;
  if (pendingHere !== null && requestedFolderId !== pendingHere) {
    if (folders.folders.some((folder) => folder.id === pendingHere)) {
      wishlist.openFolder(pendingHere);
    }
  }
  useEffect(() => {
    if (pendingHere !== null) clearPendingFolder();
  }, [pendingHere, clearPendingFolder]);

  /**
   * **A review hand-off opens the root**, which is the whole wishlist on shelves — To review
   * counted the flagged wishes in every folder, and a folder's wall holds only its own subtree. A
   * page freshly mounted is at the root already (`folderId` is `useState`, never restored), so this
   * acts only when the hand-off lands on a page standing in a folder. `initialNeedsReview` is `true`
   * exactly while a hand-off naming this page is waiting, and `requestedFolderId !== null` is what
   * makes the render-phase write terminate — the folder hand-off's arrangement above, for its
   * reasons.
   *
   * **A folder hand-off waiting at the same time wins**, and the guard is not decoration: two
   * render-phase writes pulling `folderId` opposite ways would re-render each other until React
   * gives up, before either effect could spend its hand-off. `setActiveView` clears both, so the
   * pair cannot arrive together from a press today; the guard keeps a future writer from finding
   * that out in a crash.
   */
  if (
    review.initialNeedsReview &&
    requestedFolderId !== null &&
    pendingFolder?.scope !== "wishlist"
  ) {
    openFolder(null);
  }

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
   * The price sweep (issue #352), and the read behind it.
   *
   * **`optimizing` is the whole of what `enabled` means**, and the dialog below is mounted
   * unconditionally like the other two — so this hook runs every render and the flag is what stops
   * `wishlist_optimize_plan` sweeping the whole list on every filter keystroke nobody asked to
   * optimise. `useExportScope` above is the same arrangement for the same reason.
   *
   * It is handed `wishlist.filters` whole: the plan is taken over **the query the list is
   * currently drawn from**, so every shelf at and below the level (`filters.shelves`), every
   * active filter and the marketplace all scope the sweep, and `considered` comes back equal to
   * the `Wishes` figure in the header above.
   */
  const [optimizing, setOptimizing] = useState(false);
  /**
   * **Which list the sweep is taken over** — the one on screen, or the whole wishlist.
   *
   * `"page"` is the Optimise button's, and it is `wishlist.filters` exactly as it always was.
   * `"whole"` is the home page's Wishlist savings widget, arriving through `store.ts`'s
   * `pendingOptimize`: the widget counted what *every* pinned wish would save, so the dialog it
   * opens plans {@link wholeWishlistQuery} — the widget's own question, and therefore its own cache
   * entry. **A scope override and never a write**: the folder the reader stands in and the filters
   * are theirs, so the hand-off touches neither — it plans every wish whatever the wall is showing.
   *
   * **Left where it is when the dialog closes**, deliberately: the panel outlives the flag by the
   * length of its fade, and a scope put back on close would re-key the plan mid-fade and flash the
   * body to its loading sentence. The button writes `"page"` on its own press instead.
   */
  const [sweepOver, setSweepOver] = useState<"page" | "whole">("page");
  const optimize = useWishlistOptimize(
    sweepOver === "whole" ? wholeWishlistQuery(marketplace.id) : wishlist.filters,
    optimizing,
  );
  /**
   * **The sweep another page asked for** — `store.ts`'s `pendingOptimize`, read as this page
   * renders rather than in a mount effect, for the `pendingFolder` reasons above: the dialog is up
   * on the first commit, and `setOptimizing` inside an effect body is the lint failure that dies
   * only at `verify`. The guard is what makes the adjustment terminate — the hand-off stays in the
   * store until the effect below spends it.
   *
   * **No `apply.reset()` on the way in**, unlike the button's: `App.tsx` draws one view at a time,
   * so a hand-off always arrives on a freshly mounted page whose mutation has no receipt to clear.
   */
  const pendingOptimize = useAppStore((s) => s.pendingOptimize);
  const clearPendingOptimize = useAppStore((s) => s.clearPendingOptimize);
  if (pendingOptimize && !(optimizing && sweepOver === "whole")) {
    setSweepOver("whole");
    setOptimizing(true);
  }
  useEffect(() => {
    if (pendingOptimize) clearPendingOptimize();
  }, [pendingOptimize, clearPendingOptimize]);

  /**
   * Which folder layer is open, and what the caret goes back to when it closes.
   *
   * **The opener is a ref rather than a piece of `Panel`** for the reason `DecksPage` gives: the
   * triggers here are the path row's Add folder and, for the rest, whichever heading's Add folder,
   * Rename or `⋯` a reader happened to press, so capturing the element when the layer opens is the
   * only way one handler can serve a wall of them.
   */
  const [panel, setPanel] = useState<Panel>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  /**
   * The row the list and the docked search column share, and the box the column is pinned inside —
   * `DeckEditor`'s desk and dock, on a page that had neither because it was `flex-col` from its
   * root down.
   *
   * The desk is the only width the panel can honestly be judged against: the window's own is the
   * sidebar, the page padding and this page's own gutters away from it.
   */
  const deskRef = useRef<HTMLDivElement>(null);
  const dockRef = useRef<HTMLDivElement>(null);
  /**
   * What that row can spare for the column: the widest the panel may be drawn or dragged, whether
   * the list and the column fit **beside each other**, and — when they do not — how wide to draw
   * the panel **over** the list, which is the door out of the rail rather than a refusal to open.
   *
   * `useDeskWidth` carries the whole of it, including the observer, why the viewport is
   * `documentElement.clientWidth` rather than `window.innerWidth`, and why an unmeasured row reads
   * as roomy. **It was this file's own block and `CollectionPage`'s at once**, byte for byte,
   * which is two decisions that happen to agree rather than one.
   *
   * **The floor is handed in rather than assumed by the hook**, because it is a fact about this
   * page's list and not about docked columns — and since 2026-09-07 a fact about the *view* rather
   * than the page. The two pages agreed on 192 for a day and have stopped: {@link CARD_FLOOR} is
   * still shared arithmetic, while {@link TABLE_FLOOR} is 610 here against the collection's 680
   * because the two tables draw different columns.
   *
   * **Switching view re-clamps the panel and never overwrites the reader's width** —
   * `CardSearchPanel`'s standing rule, that the caps clamp what is *drawn* while a drag clamps what
   * is *stored*. What comes back likewise **decides what is drawn and never what is mounted**: a
   * width change must not be able to throw a typed query away.
   */
  const { maxPanelWidth, roomy, overWidth } = useDeskWidth(
    deskRef,
    view === "table" ? TABLE_FLOOR : CARD_FLOOR,
  );

  /**
   * The dock's height — **arithmetic rather than a length**, because CSS cannot say "the scroller's
   * visible height, less however much of the page sits above this row".
   *
   * `sticky top-0` on the dock does the pinning and this does only the height. The hook finds the
   * scroller itself, which is what lets one hook serve this page (scrolling in `AppShell`'s `main`)
   * and the deck editor (an `overflow-y-auto` section of its own) without either site knowing
   * which.
   */
  useDockHeight(dockRef, deskRef);

  /**
   * Rewrite one wish wherever the wishlist is cached.
   *
   * Every cached filter combination, not just the one on screen: the same wish is in the
   * "everything" list and in whatever narrowed list the reader came from, and a stepper press
   * that fixed one and left the other would show two different numbers for one card one filter
   * click apart.
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
   * the other wishlist writes in this app: `useWishlistFolders`' (whose two wish-deleting ones
   * take the card search too, for the reason below), the card menu's
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
    void refreshCardSearches(queryClient);
  }, [queryClient]);

  const setQuantity = useMutation({
    mutationFn: ({ row, quantity }: { row: WishRow; quantity: number }) =>
      ipc.wishlistSetQuantity(row.id, quantity),
    // Optimistic on the row's own number and nothing else. Without it, holding `+` sends the
    // same number three times — the box is controlled by the cache, so a second press before
    // the first answer would be computed from a stale value.
    //
    // **It writes a `0` into the row for one round trip now that the stepper's floor is zero
    // (issue #284), and that is accepted rather than special-cased** — the collection's twin
    // accepts the same one. Guessing the *removal* here instead is the guess this page is not
    // entitled to make: a refusal would then have to put a row back at a sort position and on a
    // page only the backend knows, which is the argument {@link setFolder} makes at length about
    // its own write. What a reader sees in the meantime is the number they pressed to, on a row
    // that leaves a few milliseconds later — a stepper that reported a different number from the
    // one under their finger would be worse than a row that lingers.
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
      // number it actually stored — **or says the row is not there any more**. Then the
      // re-read, for what the new number is counted into — the folder subtotal a copy count
      // multiplies straight through.
      //
      // `removed` is not decoration. `set_wish_quantity(id, 0)` returns `remove_wish(conn, id)`
      // — `wishlist_entries.quantity` carries `CHECK (quantity > 0)`, so it always has — and
      // since issue #284 the stepper is `min={0}`, which puts that delete one press away on a
      // single-copy wish.
      //
      // **What reading the answer as "quantity 0" costs here is a round trip, not a permanent
      // ghost**, and the distinction is worth getting right because the collection's twin
      // handler has the harsher version of it. {@link settleWhole} invalidates `["wishlist"]`
      // *whole* and this list's own key is `["wishlist", "list", …]` (`useWishlist.ts`), so the
      // refetch does take the row — eventually. Until it lands the wish sits in the list wanting
      // none of something, and the `+` beside it answers GONE. That is exactly what
      // `remove.onSuccess` below refuses to let a crossed-off wish do: "the row goes at once —
      // a crossed-off wish must not sit there for the length of a round trip". A
      // removal and a stepper taken to zero are **one write with two gestures**, so the two
      // handlers are the same two lines; anything else is one gesture behaving differently from
      // the other for a reason no reader could name.
      //
      // `CollectionPage`'s handler is these same two lines and its comment carries the live
      // sighting — but not its reason: `settle()` there re-reads the summaries and pointedly
      // **not** the list, so the same misreading leaves a row that outlives every round trip.
      // Do not port that sentence back here.
      patchWish(change.id, change.removed ? null : (r) => ({ ...r, quantity: change.quantity }));
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
   * A card **dropped** out of the search column onto a folder card or a breadcrumb segment.
   *
   * **An add and never a move**, which is the whole of what the second arm of {@link WishDrop}
   * means: the printing in the air is on nobody's list, so there is no row to re-file and
   * `wishlist_set_folder` has nothing to address. It is the *same write* `useCardMenuDeps` makes
   * for `Add to wishlist → this folder`, which is what keeps a drop and a right-click one
   * behaviour rather than two — `quantity: 1`, the printing's own finish as the preference, and
   * the folder the reader pointed at.
   *
   * **`preferredFinish` is the finish the printing actually exists in, carried on the drag.** A
   * wish for the foil is not filled by the nonfoil, so this is part of what is being asked for
   * rather than extra detail — and `searchCardDrag` refuses a record whose finish this build does
   * not know rather than guessing one, which is `useSidebarDrops.ts`'s standing objection answered
   * at the only place that can answer it. The `+` on the tile beside it is where a reader who
   * wants to say more says it.
   *
   * **`folderId` is never omitted, and `null` is the root.** The field is part of the row's
   * storage grain, so a folder the caller failed to pass is not a wish filed in the wrong drawer
   * but a *second* wish for the same card.
   *
   * Settled through {@link settleWhole} like every other write on this page: an add changes the
   * level being drawn, the folder subtotals above it, and every search row's `wishlisted` mark.
   */
  const addWish = useMutation({
    mutationFn: ({ card, folderId: to }: { card: SearchCardDrag; folderId: number | null }) =>
      ipc.wishlistAdd({
        cardId: card.cardId,
        quantity: 1,
        preferredFinish: card.finish,
        folderId: to,
      }),
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

  // Never while a walk is answering: the query is the new level's and the page is drawing the old
  // one, so a page asked for now would be a page of a list nobody can see yet.
  const { levelHeld } = wishlist;
  const onNeedNextPage = useCallback(() => {
    if (levelHeld) return;
    if (query.hasNextPage && !query.isFetchingNextPage && !query.isFetchNextPageError) {
      void query.fetchNextPage();
    }
  }, [query, levelHeld]);

  const currency = marketplace.currency;

  /**
   * The wishlist as a **walk**, so the printings modal's chevrons and arrow keys step along it.
   *
   * The rows arrive in wall order — `shelves` is the list's first `ORDER BY` term — so the walk
   * steps through the shelves in the order they are drawn.
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
   * this page holds the open shelves' rows rather than the whole list, so counting from them would
   * answer 0 for every folder whose shelf is shut. The counts come from
   * `wishlist_folder_summary` instead, summed up the tree by {@link subtotalsOf}. The tree is
   * still what says which folder is under which, and it is what applies the missing-parent rule
   * that {@link trailOf} applies from the other end.
   */
  const nodes = useMemo(() => buildFolderTree(folders.folders, []), [folders.folders]);
  const trail = useMemo(() => trailOf(folders.folders, folderId), [folders.folders, folderId]);
  const subtotals = useMemo(() => subtotalsOf(nodes, folders.summary), [nodes, folders.summary]);

  /**
   * **A level deleted from under the reader** (the final review's C-M4) — by another window, or a
   * synced device. The page stood on in a drawer that no longer exists: an empty wall, a breadcrumb
   * with nothing to name, and Escape the only way out. So once the folder list has **answered**
   * without the level asked for, the page opens its **nearest surviving ancestor** — the root if
   * none survives, which is where a deleted drawer's wishes have gone anyway.
   *
   * The ancestors are the last answer's that still held the level (`levelTrail`, root-most first),
   * because the answer that removed it cannot say where it was: a delete takes its sub-folders
   * with it, so the reader's own drawer can go with an ancestor, and the one to land in is the
   * deepest that is left. The trail is kept **with the level it belongs to**, so an answer about
   * one level is never read back for another. Both writes are React's adjustment during render and
   * each removes its own condition — the trail is written only when it changed, and the walk lands
   * on a level the list holds, or on the root.
   *
   * **A hand-off waiting for this page outranks it** (`pendingHere === null`), the collection's
   * ordering too: the hand-off above opens the folder another page named, and two render-phase
   * writes pulling the level different ways in one pass could chase each other. With the hand-off
   * first, the walk only ever acts on a level the reader is actually left standing in.
   */
  const [levelTrail, setLevelTrail] = useState<{ level: number; ids: readonly number[] } | null>(
    null,
  );
  const census = folders.query.data;
  if (census !== undefined && requestedFolderId !== null && pendingHere === null) {
    if (census.some((folder) => folder.id === requestedFolderId)) {
      const ids = trailOf(census, requestedFolderId).map((folder) => folder.id);
      if (levelTrail?.level !== requestedFolderId || !sameIds(ids, levelTrail.ids)) {
        setLevelTrail({ level: requestedFolderId, ids });
      }
    } else {
      const known = levelTrail?.level === requestedFolderId ? levelTrail.ids : [];
      // Deepest first — `findLast` is ES2023 and this program's lib stops at ES2020.
      const survivor = [...known]
        .reverse()
        .find((id) => id !== requestedFolderId && census.some((folder) => folder.id === id));
      openFolder(survivor ?? null);
    }
  }

  /**
   * **The cabinet split in two: the reader's drawers and the decks' managed ones** (issue #512).
   *
   * `nodes` above stays the *whole* tree, because the trail and the subtotals are read from it and a
   * managed folder is somewhere a wish really is. `userNodes` is the tree every **destination** is
   * drawn from — a heading's `Move to folder…`, a wish's, a before/after landing, the search
   * column's `+` — because a managed folder refuses every hand write in words, and a destination
   * whose only outcome is that sentence is a control that teaches nothing. The managed folders are
   * drawn as shelves under **Managed by decks** (spec §3.1), with nothing on their headings that
   * writes.
   *
   * `managed` is the per-row question — is this wish the deck's? — asked by the wall and the table
   * of every row, which is why it is a `Set` rather than a `find`.
   */
  const userNodes = useMemo(
    () => buildFolderTree(userWishFolders(folders.folders), []),
    [folders.folders],
  );
  const managed = useMemo(() => managedIds(folders.folders), [folders.folders]);
  /** The managed folder the reader is standing in, or `null`. */
  const managedHere =
    folderId !== null && managed.has(folderId)
      ? (folders.folders.find((folder) => folder.id === folderId) ?? null)
      : null;
  /**
   * The name of the deck {@link managedHere} follows — **its own name, except inside a deck's
   * Tokens subfolder** (user schema v55), which carries the deck's id but is named `Tokens` on every
   * deck: there the deck's name is its parent's, the deck's own managed folder, which Rust names
   * after the deck and renames with it. The same source the note has always read, one folder up.
   * A child whose parent is not in the list keeps its own name rather than inventing one.
   */
  const managedDeckName =
    managedHere === null
      ? null
      : managedHere.managedTokens
        ? (folders.folders.find((folder) => folder.id === managedHere.parentId)?.name ??
          managedHere.name)
        : managedHere.name;
  const isManagedWish = useCallback(
    (row: WishRow) => row.folderId !== null && managed.has(row.folderId),
    [managed],
  );
  /**
   * **Which Compare view each deck's folder follows** — `DeckRow.managedWishlist`, read off the deck
   * list, because an empty managed folder says a sentence about *its* view (`managedEmptySentence`,
   * live pass §13) and a wishlist folder row carries only the deck's id. The gallery's own key
   * (`deckListKey`, `["decks", "list"]`), so the read is shared with every other surface that lists
   * the decks and refreshed by every deck write; **asked only where a managed folder exists**, so a
   * wishlist no deck keeps a list in never reads the decks at all. Until it answers the sentence is
   * the one that names no view.
   */
  const deckList = useQuery({
    queryKey: deckListKey,
    queryFn: () => ipc.deckList(),
    enabled: managed.size > 0,
  });
  const managedSentenceOf = useCallback(
    (managedFolderId: number): string => {
      const folder = folders.folders.find((f) => f.id === managedFolderId);
      const deck = deckList.data?.find((d) => d.id === folder?.managedDeckId);
      // A deck's Tokens child carries the deck's id too, and says its own sentence (v55).
      return managedEmptySentence(deck?.managedWishlist, folder?.managedTokens === true);
    },
    [folders.folders, deckList.data],
  );
  const setActiveView = useAppStore((s) => s.setActiveView);
  const setOpenDeckId = useAppStore((s) => s.setOpenDeckId);
  /** The way from a deck's list to the deck — a view change *and* an id, in that order, because
   *  `setActiveView` clears `openDeckId` on the way in (`DecksWidget`'s `openDeck`). */
  const openDeck = useCallback(
    (deckId: number) => {
      setActiveView("decks");
      setOpenDeckId(deckId);
    },
    [setActiveView, setOpenDeckId],
  );

  /**
   * Every reader's folder by id, and the level the tree **draws** each one in.
   *
   * Not `parentId`, and the difference is `buildFolderTree`'s rule: a folder whose parent another
   * surface deleted is drawn at the root, so a before/after landing on its heading — and a Move up
   * on its `⋯` — reorders the level it is *drawn* in and sends that as the destination. What is on
   * screen is the honest answer, and `wishlist_folder_reorder` writing `parent_id` from it files the
   * orphan where the reader can already see it.
   */
  const nodeById = useMemo(
    () => new Map(flattenFolders(userNodes).map((node) => [node.folder.id, node])),
    [userNodes],
  );
  const treeParent = useMemo(() => {
    const out = new Map<number, number | null>();
    const walk = (level: readonly FolderNode<WishlistFolder>[], parentId: number | null) => {
      for (const node of level) {
        out.set(node.folder.id, parentId);
        walk(node.children, node.folder.id);
      }
    };
    walk(userNodes, null);
    return out;
  }, [userNodes]);

  /**
   * What to call the folder a wish is filed in — `ROOT_LABEL` for the root, `null` for a folder
   * id this page cannot name, which is the honest answer for one another window deleted between
   * the two reads.
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
   * The folder layer that is actually open — `panel`, less a naming field whose heading is not on
   * this wall.
   *
   * **Derived rather than written from an effect.** A naming field is drawn *in a heading* — the
   * new folder's own, or the one being renamed — so a panel left open while the reader walked to a
   * level that does not draw that heading would be a layer with no field on screen at all:
   * invisible, and still swallowing the Escape that should have walked them back out. A new
   * folder's heading is drawn wherever its parent is — this level, or any shelf below it — and a
   * renamed folder's wherever its own shelf is.
   */
  const shelfIds = useMemo(() => new Set(shelves.map((shelf) => shelf.id)), [shelves]);
  const panelGone =
    (panel?.kind === "newFolder" &&
      panel.parentId !== folderId &&
      (panel.parentId === null || !shelfIds.has(panel.parentId))) ||
    (panel?.kind === "renameFolder" && !shelfIds.has(panel.folderId));
  const openPanel = panelGone ? null : panel;

  /**
   * **The caret handed back to a heading that may no longer be drawn** (live pass §8) — after Add
   * folder in a heading, to its `Add folder`, and after Move up / Move down, to the moved heading's
   * `⋯`. `useHeadingCaret` is the whole machine, shared with the collection; the page asks for a
   * request at the press, records it when its moment comes, and hands the due one to its heading
   * (`caretFor`) and to both views' reveal (`caretDue`). Called here, where the folder tree a move is
   * decided against exists and before every callback that asks for one.
   */
  const {
    due: caretDue,
    caretFor,
    ask: askCaret,
    record: recordCaret,
    supersede: supersedeCaret,
    afterBlur,
    leave: leaveCaret,
  } = useHeadingCaret({
    level: folderId,
    asked: requestedFolderId,
    view,
    opener: openerRef,
    fetching: folders.query.isFetching,
    levelIds: (parentId) => folderLevel(userNodes, parentId).map((node) => node.folder.id),
  });

  /**
   * The Add folder a naming field was opened from, when that is a **heading's** — the one whose
   * caret has to be handed back by request (`useHeadingCaret`). The path row's makes a folder *at*
   * the level, its parent is the level itself, and its button is never scrolled away.
   */
  const headingAddedIn =
    panel?.kind === "newFolder" && panel.parentId !== null && panel.parentId !== folderId
      ? panel.parentId
      : null;

  // Focus first, then close: the opener is still mounted at this point, and an element that
  // unmounts with the caret on it drops focus to `<body>`. This is the **keyboard** way out —
  // Escape, and each panel's own Cancel. `close` below is the click-away way and is deliberately a
  // different function: an outside click does *not* hand the caret back.
  //
  // **Add folder in a heading also records a request** (`useHeadingCaret`), committed or cancelled:
  // the field is revealed at the end of the parent's subtree, so on a long wall the parent's heading
  // — and with it the opener — has been virtualised away by the time the field closes, and the focus
  // above is a no-op on a detached node. The heading takes the caret back as it is drawn.
  const dismiss = useCallback(() => {
    openerRef.current?.focus();
    if (headingAddedIn !== null) recordCaret(askCaret(headingAddedIn, "add"));
    setPanel(null);
  }, [headingAddedIn, recordCaret, askCaret]);
  const close = useCallback(() => setPanel(null), []);

  /**
   * **The new folder's field, given up by the field itself** — its ✕, or a blur (`FolderNameField`
   * discards a half-typed name when the caret leaves it, and calls this with no event). The two are
   * told apart by where the caret is: on the ✕ it is inside the field, and a blur is dispatched with
   * the caret already off the input and on `<body>`.
   *
   * - **The ✕ is the keyboard way out**, whether it was keyed or clicked — `dismiss`, as Escape is,
   *   so a heading's Add folder has its request recorded at once.
   * - **A heading's field, blurred, is the click-away way** — closed without handing anything back
   *   — and records the heading's request **only when the caret has nowhere else to be**. That is
   *   asked one task later (`afterBlur`), once the focus change has finished: a click on a
   *   tile below the draft has put the caret on the tile by then, and must neither scroll the wall
   *   back up to the heading nor have the caret taken away.
   * - **The path row's field decides the same way** (the final review's W-I1): a focus made from
   *   inside a `focusout` handler is one Blink refuses the click its own focus, so `dismiss` there
   *   took the caret off whatever was clicked and scrolled the page to the top. One task later, and
   *   only if the caret is still nowhere, it goes back to the path row's Add folder **without
   *   scrolling** — `CollectionPage`'s rule, word for word.
   */
  const cancelNewFolder = useCallback(() => {
    if (!caretIsNowhere()) {
      dismiss();
      return;
    }
    if (headingAddedIn !== null) {
      const request = askCaret(headingAddedIn, "add");
      afterBlur(() => recordCaret(request));
    } else {
      const opener = openerRef.current;
      afterBlur(() => opener?.focus({ preventScroll: true }));
    }
    setPanel(null);
  }, [dismiss, headingAddedIn, recordCaret, askCaret, afterBlur]);

  useDismissOnEscape({ layer: "inner", onDismiss: dismiss, enabled: openPanel !== null });

  /**
   * The floor: Escape walks the reader **up one level**, once nothing nearer has wanted the press.
   * The parent is read off {@link trail}, which is root-most first and without the root, so the
   * segment before the last one *is* the way out and its absence *is* the root — the breadcrumb's
   * own two facts, so the key and the pointer walk the same cabinet. `enabled` is what keeps the
   * root silent: there is no level above it, and the press must fall through untouched.
   *
   * **Walked from the level asked for, not the one drawn**: while a walk to an uncached level is
   * answering the page still draws the level before it, and a second press in that beat must climb
   * from where the first one went — reading the drawn trail, it would ask for the same level twice.
   */
  const askedTrail = useMemo(
    () => trailOf(folders.folders, requestedFolderId),
    [folders.folders, requestedFolderId],
  );
  useDismissOnEscape({
    layer: "navigation",
    onDismiss: () =>
      openFolder(askedTrail.length > 1 ? askedTrail[askedTrail.length - 2].id : null),
    enabled: requestedFolderId !== null,
  });

  const open = useCallback((next: NonNullable<Panel>, opener: HTMLElement | null) => {
    openerRef.current = opener;
    // A caret still owed to a heading is the last layer's business, not this one's — and a request
    // whose write has not answered yet is superseded, so it is never recorded at all.
    supersedeCaret();
    setPanel(next);
  }, [supersedeCaret]);

  /**
   * **Add folder** — on the path row for the level on screen, and on a heading for inside that
   * folder (spec §3.8). The new folder's heading appears where it will live, last among its
   * siblings, with the name field in it; ✓ is `wishlist_folder_create`.
   *
   * **A collapsed heading is opened first**, because the new folder is drawn inside it and a field
   * under a shut shelf is a field nobody can see — the one fold this page writes on the reader's
   * behalf, and the one they would write next anyway. Not while filtering: collapse is suspended
   * then, and the parent is already open.
   *
   * `folders.create.reset()` for `DecksPage`'s reason: a refusal from the last attempt is not news
   * about this one.
   */
  const startNewFolder = useCallback(
    (parentId: number | null, opener: HTMLElement | null) => {
      folders.create.reset();
      if (parentId !== null && parentId !== folderId && !filtering) {
        const parent = shelves.find((shelf) => shelf.id === parentId);
        if (parent !== undefined && parent.collapsed) setFold(parentId, foldFor(parent, false));
      }
      open({ kind: "newFolder", parentId }, opener);
    },
    [folders.create, folderId, filtering, shelves, setFold, open],
  );

  /**
   * The field, answered — whichever of its two jobs it is doing. One callback because there is one
   * field; which write a name becomes is a fact about the open `Panel`.
   *
   * A second Enter while ✓ is in flight is refused by the field itself — `renaming.pending` greys
   * its tick and `FolderNameField` submits nothing while pending.
   *
   * **A new folder does not become the folder the reader is standing in**: they are looking at the
   * wishes they are about to file, and walking them into an empty drawer would take exactly those
   * off screen. The new heading is right there to drag onto.
   *
   * **A made folder starts on its own kind's fold** (the final review's R-M2): `wishlist_folders.id`
   * is an `INTEGER PRIMARY KEY` without `AUTOINCREMENT`, so a new folder can take a deleted folder's
   * id — and with it whatever fold was stored under that id. The create clears it, and only where
   * something is stored, so an ordinary create writes nothing.
   *
   * **The path row's caret comes back without scrolling** (ledger 217): the new heading is drawn
   * last among its siblings, and an ordinary `focus()` on the path row's button took the page to
   * the top and off it. A heading's Add folder is `dismiss`'s request, which reveals the heading.
   */
  const nameFolder = useCallback(
    (name: string) => {
      if (panel?.kind === "newFolder") {
        const { parentId } = panel;
        const pathRow = headingAddedIn === null;
        folders.create.mutate(
          { parentId, name },
          {
            onSuccess: (made) => {
              if (folds[String(made.id)] !== undefined) setFold(made.id, null);
              // Opened from a heading, `dismiss` also hands the caret back to that heading's Add
              // folder, wherever the field took the wall (`useHeadingCaret`).
              if (!pathRow) {
                dismiss();
                return;
              }
              openerRef.current?.focus({ preventScroll: true });
              setPanel(null);
            },
          },
        );
      } else if (panel?.kind === "renameFolder") {
        folders.rename.mutate({ id: panel.folderId, name }, { onSuccess: dismiss });
      }
    },
    [panel, headingAddedIn, folders.create, folders.rename, folds, setFold, dismiss],
  );

  /**
   * Where what is in the air may be let go — asked per target, because the answer differs per
   * target: the folder a wish is already filed in refuses it and draws no ring at all, rather
   * than a ring that would write nothing and bump `updated_at`. `dropWrite`'s rule about a card
   * dropped back in its own column, one screen over.
   *
   * **A card off the search column has no such refusal to make, and that is a fact about it
   * rather than a gap here.** It is on nobody's list, so there is no `folderId` to compare a
   * destination against — every drawer is somewhere it is not already, so every drawer takes it.
   * **The ownership clause arrived with user schema v48's managed folders** (issue #512), which
   * are the decks' rather than the reader's — `CollectionPage`'s twin has had one all along for its
   * deck groups and `Recently removed`. Both ends of a drop are fenced, because the backend refuses
   * both in `MANAGED_REFUSAL`'s words (`./managed.ts`): a wish may not be filed *into* a deck's
   * list, and a wish in one may not be filed *out*. The second arm is belt and braces — a managed
   * wish is not a drag source on either view — so a stray payload cannot light a ring for a write
   * that is always refused.
   */
  const canFile = useCallback(
    (drop: WishDrop, to: number | null) => {
      if (to !== null && managed.has(to)) return false;
      if (drop.kind === "new") return true;
      if (drop.wish.folderId !== null && managed.has(drop.wish.folderId)) return false;
      return drop.wish.folderId !== to;
    },
    [managed],
  );
  /**
   * And what the drop writes — a **re-file** for a wish that exists, an **add** for a printing
   * that does not.
   *
   * One function for both arms rather than two props threaded to every target, because the target
   * asks one question and gets one answer: a heading lights up and takes what it is given.
   * Which command that turns into is the page's business, and it is the page that holds both.
   */
  const fileWish = useCallback(
    (drop: WishDrop, to: number | null) =>
      drop.kind === "wish"
        ? setFolder.mutate({ id: drop.wish.wishId, folderId: to })
        : addWish.mutate({ card: drop.card, folderId: to }),
    [setFolder, addWish],
  );

  /**
   * What a folder let go on a heading means as a write — the destination level and that level's
   * whole new order — or `null` for a drop this page will not make.
   *
   * **One function for both halves of the gesture**: `useFolderDropTarget` asks it per frame to
   * decide what to draw and again at the drop, and a mark that promised a write the drop refused
   * would be worse than none. The ownership fence is structural — a heading has a folder target only
   * where `nodeById` holds it, which is the reader's folders alone.
   *
   * **The level is the target's as the tree draws it** ({@link treeParent}), because on shelves a
   * heading can be at any depth — where the band drew one level, and the level on screen was the
   * answer.
   *
   * **A folder may not land inside itself or inside anything it holds** — asked of the destination
   * parent, which covers all three landings at once. **Shelves made this reachable**: a folder's own
   * sub-folder is a heading on the same wall now, so `Ordered` dragged onto `Backordered` is one
   * move. The backend refuses it in words and `parent_id` cascades on itself, so this is the fence.
   *
   * And a drop that would reproduce the order already on screen is not a write — `reorderedLevel`'s
   * `null`, for the gesture a reader makes by accident whenever they think better of one mid-drag.
   */
  const folderPlacement = useCallback(
    (
      drag: FolderDrag,
      target: FolderNode<WishlistFolder>,
      edge: FolderEdge,
    ): { parentId: number | null; ids: number[] } | null => {
      const parentId =
        edge === "inside" ? target.folder.id : (treeParent.get(target.folder.id) ?? null);
      if (parentId !== null && parentId === drag.folderId) return null;
      if (parentId !== null && folderDescendants(folders.folders, drag.folderId).has(parentId)) {
        return null;
      }
      const ids = reorderedLevel({
        // The target's own children for a nest — in the order the tree already draws them, so a
        // nest re-states the level it is joining rather than re-sorting it — and the target's own
        // level for the other two.
        siblings: (edge === "inside" ? target.children : folderLevel(userNodes, parentId)).map(
          (node) => node.folder.id,
        ),
        dragged: drag.folderId,
        target: target.folder.id,
        edge,
      });
      return ids === null ? null : { parentId, ids: [...ids] };
    },
    [treeParent, folders.folders, userNodes],
  );
  const placeFolder = useCallback(
    (drag: FolderDrag, target: FolderNode<WishlistFolder>, edge: FolderEdge) => {
      const plan = folderPlacement(drag, target, edge);
      // A `null` writes **nothing at all** — not a reorder of the level as it stands.
      if (plan !== null) folders.reorder.mutate(plan);
    },
    [folderPlacement, folders.reorder],
  );

  /**
   * **Move up / Move down** — the non-drag way to reorder (WCAG 2.5.7), written through
   * {@link folderPlacement} as the before/after drop on the neighbouring heading would be, so the
   * two routes cannot disagree about what a reorder writes.
   *
   * **And the caret follows the heading to its new place** (`useHeadingCaret`): the menu hands the
   * caret to the heading's `⋯` before it runs the row, and the move then carries that heading past
   * its neighbour's whole subtree — out of the virtual window on a deep shelf. The request is asked
   * at the press and **recorded only once the write has succeeded** (a refused move owes the caret
   * nothing), carrying the planned order, so the heading is revealed where it lands rather than
   * where it stood — and the folder list's first answer after the write decides whether it lands.
   */
  const stepFolder = useCallback(
    (folder: WishlistFolder, step: -1 | 1) => {
      const siblings = folderLevel(userNodes, treeParent.get(folder.id) ?? null);
      const at = siblings.findIndex((node) => node.folder.id === folder.id);
      const neighbour = at < 0 ? undefined : siblings[at + step];
      if (neighbour === undefined) return;
      const plan = folderPlacement(
        { folderId: folder.id, name: folder.name, parentId: folder.parentId, scope: "wishlist" },
        neighbour,
        step < 0 ? "before" : "after",
      );
      if (plan === null) return;
      const request = askCaret(folder.id, "manage", { order: plan });
      folders.reorder.mutate(plan, { onSuccess: () => recordCaret(request) });
    },
    [userNodes, treeParent, folderPlacement, folders.reorder, askCaret, recordCaret],
  );

  /**
   * One heading's three doors into one menu — a right-click, a `ContextMenu` keypress, and the
   * `⋯`'s own click. The folder card's menu minus Rename (a button on the heading now) plus the
   * keyboard's reorder (spec §3.2). The item list is a **thunk**, so a wall of forty headings builds
   * no menu until one is opened; the opener is captured here because a `MenuAction.onSelect` is a
   * bare callback with no element behind it, and `e.currentTarget` is read synchronously, which is
   * the only moment it is the element the handler is attached to.
   */
  const folderRowMenu = useCallback(
    (folder: WishlistFolder) => {
      const build = (): MenuItem[] => {
        const siblings = folderLevel(userNodes, treeParent.get(folder.id) ?? null);
        const at = siblings.findIndex((node) => node.folder.id === folder.id);
        return [
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
          {
            kind: "action",
            id: "move-up",
            label: "Move up",
            Icon: ArrowUp,
            ...(at <= 0 ? { disabled: true, reason: "Already first" } : {}),
            onSelect: () => stepFolder(folder, -1),
          },
          {
            kind: "action",
            id: "move-down",
            label: "Move down",
            Icon: ArrowDown,
            ...(at < 0 || at === siblings.length - 1
              ? { disabled: true, reason: "Already last" }
              : {}),
            onSelect: () => stepFolder(folder, 1),
          },
          { kind: "separator", id: "before-delete" },
          // `Eraser` beside `Trash2` for the deck category menu's reason: what a clear takes is the
          // writing and not the page, and two trash cans in one menu would read as one row drawn
          // twice.
          {
            kind: "action",
            id: "clear",
            label: "Clear…",
            Icon: Eraser,
            // **Greyed only on an answer, never on a silence.** `folders.summary` is direct per
            // folder and a folder with no direct wishes has no row in it at all, so a missing row
            // means "nothing filed directly here" — but only once the summary has answered. Before
            // that it means nothing and the row stays live: the backend answers a clear of an
            // empty level with `0`, which is harmless, where a row greyed on a guess refuses a
            // press that would have worked.
            ...(folders.summaryQuery.data !== undefined &&
            (folders.summary.get(folder.id)?.wishes ?? 0) === 0
              ? { disabled: true, reason: "Nothing filed directly here" }
              : {}),
            onSelect: () => {
              folders.clear.reset();
              open({ kind: "clearFolder", folderId: folder.id }, openerRef.current);
            },
          },
          {
            kind: "action",
            id: "delete",
            label: "Delete…",
            Icon: Trash2,
            onSelect: () => {
              // Both answers the confirmation offers: a refusal from either last time is not news
              // about this one.
              folders.remove.reset();
              folders.removeWithWishes.reset();
              open({ kind: "deleteFolder", folderId: folder.id }, openerRef.current);
            },
          },
        ];
      };
      const remember = (element: Element) => {
        if (element instanceof HTMLElement) openerRef.current = element;
      };
      return {
        onContextMenu: (e: ReactMouseEvent) => {
          remember(e.currentTarget);
          menu(build)(e);
        },
        onKeyDown: (e: ReactKeyboardEvent) => {
          remember(e.currentTarget);
          menuKey(build)(e);
        },
        onClick: (e: ReactMouseEvent) => {
          remember(e.currentTarget);
          menuClick(build)(e);
        },
      };
    },
    [
      menu,
      menuKey,
      menuClick,
      open,
      userNodes,
      treeParent,
      stepFolder,
      folders.move,
      folders.remove,
      folders.removeWithWishes,
      folders.clear,
      folders.summary,
      folders.summaryQuery.data,
    ],
  );

  /**
   * A folder let go on a **breadcrumb segment**: filed last inside that level — what the
   * `ParentFolderCard` "Up one level" tile did, on every segment rather than one tile (spec §6).
   *
   * Three refusals, each one {@link folderPlacement} makes too: **already there** (asked of the
   * level the tree *draws* it in, so an orphan drawn at the root may still be filed at the root
   * properly), **into itself or anything it holds**, and `reorderedLevel`'s own `null`.
   */
  const intoPlacement = useCallback(
    (drag: FolderDrag, parentId: number | null): { parentId: number | null; ids: number[] } | null => {
      if ((treeParent.get(drag.folderId) ?? null) === parentId) return null;
      if (
        parentId !== null &&
        (parentId === drag.folderId || folderDescendants(folders.folders, drag.folderId).has(parentId))
      ) {
        return null;
      }
      const ids = reorderedLevel({
        // The destination level as the tree draws it, which is what makes the arriving folder
        // *last*. `userNodes`: the root holds the decks' managed folders too, and a reorder naming
        // one of those is refused whole.
        siblings: folderLevel(userNodes, parentId).map((node) => node.folder.id),
        dragged: drag.folderId,
        target: parentId ?? ROOT_TARGET,
        edge: "inside",
      });
      return ids === null ? null : { parentId, ids: [...ids] };
    },
    [treeParent, folders.folders, userNodes],
  );
  const canMoveInto = useCallback(
    (drag: FolderDrag, parentId: number | null) => intoPlacement(drag, parentId) !== null,
    [intoPlacement],
  );
  const moveInto = useCallback(
    (drag: FolderDrag, parentId: number | null) => {
      const plan = intoPlacement(drag, parentId);
      if (plan !== null) folders.reorder.mutate(plan);
    },
    [intoPlacement, folders.reorder],
  );

  /**
   * **The wall** (spec §3.1): the shelves to draw, and what each shelf holds.
   *
   * - `drawnShelves` is `useWishlist`'s shelves, re-asked of `buildShelves` with the folder being
   *   added put in while a create is open — it never reaches the wire.
   * - `countMap` is the counts raised to the rows already loaded (`effectiveCounts`); `null` until
   *   the counts answer, and the wall waits for it rather than laying out a guess.
   * - `visible` hides what `visibleShelves` hides — and puts the new folder back (`keepNewFolder`).
   * - **During a folder drag the wall folds** (spec §3.9) — every heading shut, no cards, nothing
   *   written. **Grid only**: the table's rows are already 40px, so the tree is as compact there as
   *   folding would make it, and folding would re-key `VirtualTable`'s positionally keyed rows under
   *   the heading being dragged — which ends the drag.
   */
  const folding = useFoldOnFolderDrag();
  const foldsWall = folding && view === "grid";
  // Keeps the carried heading under the pointer while the wall folds and unfolds (spec §3.9) —
  // the grid's fold only, since the table never folds.
  useFoldAnchor(foldsWall);
  const byShelf = useMemo(() => rowsByShelf(rows), [rows]);
  const rowsOf = useCallback((shelfId: number) => byShelf.get(shelfId) ?? NO_ROWS, [byShelf]);
  const countMap = useMemo(
    () => effectiveCounts(wishlist.counts, byShelf),
    [wishlist.counts, byShelf],
  );
  const addingIn = openPanel?.kind === "newFolder" ? openPanel.parentId : undefined;
  const drawnShelves = useMemo(
    () =>
      addingIn === undefined
        ? shelves
        : buildShelves({
            folders: [...shelfFolders, newFolderShelf(addingIn)],
            levelId: folderId,
            folds,
            filtering,
          }),
    [addingIn, shelves, shelfFolders, folderId, folds, filtering],
  );
  const visible = useMemo(
    () =>
      countMap === null
        ? []
        : keepNewFolder(drawnShelves, visibleShelves(drawnShelves, countMap, filtering)),
    [countMap, drawnShelves, filtering],
  );
  const sections = useMemo(
    () =>
      countMap === null
        ? []
        : foldsWall
          ? foldedForDrag(drawnShelves, countMap, filtering)
          : sectionsOf(visible, countMap),
    [countMap, foldsWall, drawnShelves, filtering, visible],
  );

  /**
   * **Where the caret goes once a folder has left its heading** — Move to folder… and Delete…
   * (the final review's C-M5). `useHeadingCaret`'s `leave` is the rule, shared with the collection;
   * this is the wall it is asked about — which headings are drawn open, the tree's parents, and the
   * path row. The strip's three writes each land the caret through it.
   */
  const pathRowRef = useRef<HTMLDivElement>(null);
  const leaveHeading = useCallback(
    (id: number, write: (done: { onSuccess: () => void }) => void, into?: number | null) => {
      const land = leaveCaret({
        id,
        into,
        drawnOpen: (shelfId) =>
          visible.some((shelf) => shelf.id === shelfId && !shelf.headless && !shelf.collapsed),
        parentOf: (folder) => treeParent.get(folder) ?? null,
        pathRowAdd: () => pathRowAddFolder(pathRowRef.current),
      });
      write({
        onSuccess: () => {
          setPanel(null);
          land();
        },
      });
    },
    [leaveCaret, visible, treeParent],
  );

  /** A folder's unfiltered figures, recursive — `null` for Not sorted and before the summary. */
  const figuresOf = useCallback(
    (shelf: Shelf): ShelfFigures | null => {
      if (shelf.kind === "unfiled" || folders.summaryQuery.isPending) return null;
      const total = subtotals.get(shelf.id) ?? NO_WISHES;
      return {
        wishes: total.wishes,
        copies: total.copies,
        cost: total.cost > 0 ? total.cost : null,
        unpriced: total.unpriced,
      };
    },
    [folders.summaryQuery.isPending, subtotals],
  );

  /**
   * A collapsed heading's thumbnails (spec §3.2). They come from the **counts**, not the list: a
   * shut shelf's cards are never fetched (spec §4.1), so `ShelfCount.peek` carries up to four card
   * ids per shelf, unfiltered. Names are `""` because the thumbnails are `aria-hidden`, so the
   * shelf's heading and figures are what a screen reader reads. `ShelfHeading` draws them only
   * while the shelf is shut.
   */
  const peekOf = useCallback(
    (shelf: Shelf) =>
      countMap?.get(shelf.id)?.peek.map((cardId) => ({ cardId, name: "" })) ?? NO_PEEK,
    [countMap],
  );

  /**
   * A chevron press — the stored override, or `null` back to the kind's default (spec §5.7) — and
   * the path row's Expand all / Collapse all.
   *
   * **All three write nothing while a filter is on** (spec §3.4, decision 4; the final review's
   * C-I2 / W-M14): collapse is suspended then, so a press would store a state the reader cannot
   * see take effect until the box empties — and then the wall would re-fold on its own, by a press
   * made minutes earlier. One rule for the three: the chevron alone used to honour it, and Expand
   * all and Collapse all still wrote. Never on the folder being added.
   */
  const toggleShelf = useCallback(
    (shelf: Shelf) => {
      if (filtering || shelf.id === NEW_FOLDER_SHELF) return;
      setFold(shelf.id, foldFor(shelf, !shelf.collapsed));
    },
    [filtering, setFold],
  );
  const expandAll = useCallback(() => {
    if (!filtering) setMany(foldChanges(shelves, false));
  }, [filtering, setMany, shelves]);
  const collapseAll = useCallback(() => {
    if (!filtering) setMany(foldChanges(shelves, true));
  }, [filtering, setMany, shelves]);
  /**
   * **And all three say so** — `aria-disabled` with the reason as their description and their
   * tooltip, from the shared components (`ShelfToolbar`'s and `ShelfHeading`'s `foldPaused`), so a
   * reader is told why a press does nothing rather than left to guess. The guards above stay: they
   * are the page's own promise that nothing is written, whatever a component does with a press.
   */
  const foldPaused = filtering ? FOLD_PAUSED_REASON : undefined;

  /** A card let go on a shelf files into it — the root for Not sorted — through the page's own
   *  `canFile`, which refuses a managed destination, so a deck's heading never arms. */
  const cardDrops = useCallback(
    (shelf: Shelf): CardDrops | undefined => {
      if (shelf.id === NEW_FOLDER_SHELF) return undefined;
      const to = fileTarget(shelf);
      return { canDrop: (drop) => canFile(drop, to), onDrop: (drop) => fileWish(drop, to) };
    },
    [canFile, fileWish],
  );

  /**
   * A shelf's heading (spec §3.2). The reader's folders get Add folder, Rename, the `⋯`, a folder
   * drop target and a drag source; Not sorted, a deck's managed folder and the folder being added
   * get none of those — and every heading but the last takes a card.
   */
  const renderHeading = useCallback(
    (shelf: Shelf) => {
      if (shelf.headless) return null;
      const node = shelf.kind === "folder" ? nodeById.get(shelf.id) : undefined;
      // `pending` holds the field open, greys the tick and suspends the blur-discard while the
      // write is in flight — so a slow create is not cancelled by the browser blurring the tick it
      // just greyed, and a second Enter is not a second folder. `mode: "create"` is the new
      // folder's heading: no chevron, `Folder name` / `Create folder`.
      const renaming =
        shelf.id === NEW_FOLDER_SHELF
          ? {
              initial: "",
              mode: "create" as const,
              pending: folders.create.isPending,
              onCommit: nameFolder,
              // Its ✕ and its blur-discard, told apart there (Escape reaches `dismiss` directly).
              onCancel: cancelNewFolder,
            }
          : openPanel?.kind === "renameFolder" && openPanel.folderId === shelf.id
            ? {
                initial: shelf.name,
                mode: "rename" as const,
                pending: folders.rename.isPending,
                onCommit: nameFolder,
                onCancel: dismiss,
              }
            : undefined;
      return (
        <WishShelfHeading
          shelf={shelf}
          stat={
            countMap === null
              ? "—"
              : shelfStat({
                  shelf,
                  shelves: drawnShelves,
                  counts: countMap,
                  subtotal: figuresOf(shelf),
                  filtering,
                  currency,
                })
          }
          peek={peekOf(shelf)}
          onToggle={() => toggleShelf(shelf)}
          // Refused in the open while a filter is on — see `foldPaused`.
          foldPaused={foldPaused}
          onOpen={openFolder}
          onAddFolder={
            node === undefined ? undefined : () => startNewFolder(shelf.id, pressedElement())
          }
          onRename={
            node === undefined
              ? undefined
              : () => {
                  folders.rename.reset();
                  open({ kind: "renameFolder", folderId: shelf.id }, pressedElement());
                }
          }
          renaming={renaming}
          menu={node === undefined ? undefined : folderRowMenu(node.folder)}
          cards={cardDrops(shelf)}
          folders={
            node === undefined
              ? undefined
              : {
                  canDrop: (drag, edge) => folderPlacement(drag, node, edge) !== null,
                  onDrop: (drag, edge) => placeFolder(drag, node, edge),
                }
          }
          source={node?.folder ?? null}
          caret={caretFor(shelf.id)}
        />
      );
    },
    [
      caretFor,
      nodeById,
      nameFolder,
      dismiss,
      cancelNewFolder,
      openPanel,
      folders.create.isPending,
      folders.rename,
      countMap,
      drawnShelves,
      figuresOf,
      peekOf,
      filtering,
      currency,
      toggleShelf,
      foldPaused,
      openFolder,
      startNewFolder,
      open,
      folderRowMenu,
      cardDrops,
      folderPlacement,
      placeFolder,
    ],
  );

  /**
   * An empty folder's box, in whichever view draws it — `layoutShelves` decides *which* shelves get
   * one, for the wall and the table alike. A reader's folder is the dashed drawer and a card target;
   * a deck's managed folder is the sentence for the Compare view its deck follows, in words and
   * never a target, since the folder takes no hand write.
   */
  const renderEmpty = useCallback(
    (shelf: Shelf) =>
      shelf.kind === "managed" ? (
        <WishManagedEmpty sentence={managedSentenceOf(shelf.id)} />
      ) : (
        <WishEmptyShelf cards={cardDrops(shelf)} />
      ),
    [cardDrops, managedSentenceOf],
  );
  const renderLabel = useCallback(
    (group: "decks" | "managed") => <ShelfLabel group={group} />,
    [],
  );
  const renderSticky = useCallback(
    (shelf: Shelf | null, scrollToTop: () => void) => (
      <WishShelfSticky shelf={shelf} onOpen={openFolder} onTop={scrollToTop} cards={cardDrops} />
    ),
    [openFolder, cardDrops],
  );

  /**
   * **Reveal the folder being added** (spec §3.8). Its heading is drawn where the folder will live,
   * last among its siblings, which on a long wall can be far below the fold. A field nobody can see
   * would take the caret on mount and hand it to nothing visible, so the grid scrolls it into view
   * (`revealShelfId`, Task 4), and the table scrolls the new folder's band into view through
   * `VirtualTable`'s `revealIndex` (`tableRevealIndex` below). It relied on placement until the
   * table grew that prop, and a long table left the field below the fold.
   */
  // The folder being added first — its field is where the caret is — and otherwise the heading a
  // write has just owed the caret to (`caretDue`).
  const revealShelfId =
    addingIn !== undefined ? NEW_FOLDER_SHELF : (caretDue?.shelfId ?? null);
  /**
   * The wall's shelves, and below them the table's bands — **both plain objects, on purpose.**
   * `renderHeading` depends on a `useMutation` result, which is a new object on every render, so a
   * memo over either would recompute on every render and read as a promise it cannot keep. What
   * the two views hold still on is narrower and already stable: the wall keys its tiles on
   * `sections` and `rowsOf` (memos above), and the table hands `VirtualTable` a `band` of its own
   * that never changes. The render props are read at draw time by both.
   */
  const gridShelves: WishShelves = {
    sections,
    rowsOf,
    renderHeading,
    renderEmpty,
    renderLabel,
    renderSticky,
    revealShelfId,
  };
  /** Each drawn shelf's indent — the table's rails for a wish row are its shelf's (spec §3.3). */
  const indentByShelf = useMemo(
    () => new Map(sections.map(({ shelf }) => [shelf.id, shelf.indent])),
    [sections],
  );
  const indentOf = useCallback(
    (row: WishRow) => indentByShelf.get(shelfOfWish(row)) ?? 0,
    [indentByShelf],
  );

  /** The table's rows, interleaved (spec §3.10) — complete once no page remains to load. */
  const complete = !wishlist.hasMore;
  const table = useMemo(
    () => shelfTable(sections, rowsOf, complete),
    [sections, rowsOf, complete],
  );
  /**
   * The table's **Top**. While its sticky band is live `VirtualTable` scrolls a plain box around
   * the `role="table"` element rather than the table itself — the bar may not live inside a table —
   * so the scroller is the table's parent there, and the table only without one. `scrollTop` rather
   * than `scrollTo`, so what moved is the scroller's own offset.
   */
  const scrollTableTop = useCallback(() => {
    const grid = deskRef.current?.querySelector<HTMLElement>('[role="table"]');
    if (!grid) return;
    const banded = grid.parentElement?.querySelector(":scope > [data-sticky-band]") != null;
    const scroller = banded ? grid.parentElement : grid;
    if (scroller) scroller.scrollTop = 0;
  }, []);
  /**
   * **The table's half of the reveal** — the wall's is `revealShelfId`: the row index of the heading
   * band for the same shelf, handed to `VirtualTable`'s `revealIndex`, which scrolls it clear of the
   * sticky header and bar. Two callers of one id: the folder being added (its draft heading has a
   * band, so the field is never below the fold in the table either) and the heading a write owes
   * the caret to (`caretDue`). `null` where there is none, or where the rows draw no band for it —
   * which is also the `null` between two asks that lets the table answer the same index twice. The
   * table never moves focus: the heading takes the caret itself once its row mounts.
   */
  const revealBand =
    revealShelfId === null
      ? -1
      : table.rows.findIndex(
          (row) => isBand(row) && row.band === "heading" && row.shelf.id === revealShelfId,
        );
  const tableRevealIndex = revealBand < 0 ? null : revealBand;

  /**
   * **Page until the band a reveal waits for is drawn** (the final review's W-I2, ledger 146 and
   * 223). The table's rows stop at the first shelf whose cards are still loading (`shelfTable`), and
   * a folder being added is drawn **last** among its siblings — so on any list past one page, Add
   * folder in the table drew no field at all, while the invisible layer still held the Escape rung,
   * and a later page, arriving as the reader scrolled, mounted the field and yanked the caret and
   * the scroll to it. A Move whose heading landed past the edge sat unrevealed the same way.
   *
   * So while a naming field is open, or a caret request is waiting for its band (both are
   * `revealShelfId`), and the band is not among the rows, the table asks for the next page — once
   * per page landed (`onNeedNextPage` holds while one is in flight), until the band is drawn or no
   * page is left. Only for a shelf the wall lays out, so an id nothing will ever draw (a shelf a
   * filter hid) pages nothing. The grid needs none of it: `CardGrid` lays out every shelf, with
   * empty slots for the cards not loaded yet.
   */
  const bandPastEdge =
    view === "table" &&
    revealShelfId !== null &&
    revealBand < 0 &&
    !complete &&
    sections.some(({ shelf }) => shelf.id === revealShelfId);
  useEffect(() => {
    if (bandPastEdge) onNeedNextPage();
  }, [bandPastEdge, onNeedNextPage]);

  /**
   * **The heading band being dragged stays drawn wherever the table scrolls** (the final review's
   * S-I3) — `VirtualTable`'s `keepRow`. The table does not fold during a folder drag, so a heading
   * carried past the overscan used to scroll out of the window and unmount its own drag source,
   * which ended the drag or lost its floating copy. The folder in flight is read off the drag's own
   * record, and only in the table.
   */
  const inFlight = useDragRecord(view === "table");
  const carried = inFlight === null ? null : readFolderDrag(inFlight, "wishlist");
  const carriedBand =
    carried === null
      ? -1
      : table.rows.findIndex(
          (row) => isBand(row) && row.band === "heading" && row.shelf.id === carried.folderId,
        );
  const keepRow = carriedBand < 0 ? null : carriedBand;

  const tableBands: WishTableBands = {
    heading: renderHeading,
    empty: renderEmpty,
    label: renderLabel,
    // `VirtualTable`'s caller rule (4): nothing over a band, which would cover its own controls.
    // Always a function, returning `null` where there is nothing to pin: toggling the prop
    // between a function and `undefined` switches `VirtualTable` between two root shapes, which
    // remounts the table and drops the caret to `<body>`.
    sticky: (index: number) => {
      const row = table.rows[index];
      if (row === undefined || isBand(row)) return null;
      return renderSticky(table.owners[index] ?? null, scrollTableTop);
    },
    indentOf,
  };

  const failure = query.isError
    ? ipcError(query.error)
    : wishlist.countsQuery.isError
      ? ipcError(wishlist.countsQuery.error)
      : null;
  // The *latest* write on the screen, not whichever is still holding an error: a refused stepper
  // press would otherwise leave "Could not change your wishlist" up while the reader went on to
  // remove the row successfully — an alert about something already dealt with. The folder writes
  // are in the list because they are writes this screen makes, and they share the banner because
  // they share the sentence: everything here is a change to the reader's wishlist.
  const bannerFailure = writeFailure([
    setQuantity,
    remove,
    setFolder,
    // A card dropped out of the search column, refused. It shares the sentence for the reason
    // every other write in this list does: it is a change to the reader's wishlist, made from
    // this screen. The **panel's own** add — the `+` on a tile — does not, because that popup
    // reports at its own site and its failure belongs beside the button that was pressed.
    addWish,
    anyPrinting,
    folders.create,
    folders.rename,
    folders.move,
    folders.reorder,
    folders.remove,
    folders.removeWithWishes,
    folders.clear,
  ]);

  /**
   * **The header's two figures, from the counts** (spec §3.6): everything the wall covers — this
   * level and every shelf below it, shut ones included — or, under a filter, everything that
   * matches. Summed from the server's counts rather than from the loaded rows, which is what turned
   * **Wishes 0** into the reader's real count and took the "N of M counted" note away with it.
   *
   * The unpriced counter is summed at the same marketplace as the figure beside it and is never
   * carried across a switch, because no two marketplaces have the same holes: an unpriced wish is
   * left out of the sum and counted, never quoted at another marketplace's rate.
   */
  const totals = useMemo(() => countTotals(wishlist.counts), [wishlist.counts]);
  /** Nothing at and below this level — or not known yet, which the status line says as reading. */
  const empty = totals === null || totals.wishes === 0;
  // **The breadcrumb is drawn only where there is a cabinet to walk.** At the root of a wishlist
  // nobody has filed, a lone inert "Wishlist" under a ribbon that already says Wishlist is the
  // subheading this page's own `sr-only` heading exists to avoid, and there is nowhere for it to
  // lead. The path row itself is drawn always — Add folder lives in it.
  const hasFolders = folders.folders.length > 0;
  /**
   * **Whether the wall draws anything at all** — a heading, a label or an empty folder's box — which
   * is `CollectionPage`'s `wallDrawn`, asked the same way: `layoutShelves` at one column, the rows
   * the table draws and the ones the wall draws above its tiles. A drawn wall is the content, and an
   * empty-list sentence over it is the page contradicting itself — or, standing in an empty folder,
   * saying the dashed box's own fact a second time (live pass §13: `Nothing filed here yet.` over
   * `Empty — drag cards here…`).
   */
  const drawn = useMemo(() => layoutShelves(sections, 1).rows.length > 0, [sections]);

  /**
   * What the export dialog's two sentences say about where the reader is standing. **At the root
   * nothing narrows the sweep any more** — `filters.shelves` is every shelf — so only a folder is
   * named, and only there does the checkbox offer to widen past the folders.
   */
  const exportFiling = {
    folder: folderId !== null ? folderNameOf(folderId) : null,
    narrows: folderId !== null,
  };
  const status = statusOf(wishlist, failure, {
    empty,
    pending: totals === null || query.isPending,
    drawn,
    inFolder: folderId !== null,
  });

  /** Everything both layouts are handed about the cabinet, in one object because it is one set
   *  of facts and the wall and the table must not be given different halves of it. */
  //
  // `nodes` is `userNodes` — the tree `EditWish`'s `Move to folder…` offers as destinations, so a
  // deck's managed folder is never one — while `folders` stays the whole list, because it is
  // what names the folder a wish is already in. `readOnly` is the per-row fence: a wish in a
  // managed folder draws no stepper, no pencil, no removal and no drag, since every one of those
  // writes is refused for it.
  const filing = {
    folders: folders.folders,
    nodes: userNodes,
    readOnly: isManagedWish,
    onSetFolder,
    onChangePrinting,
    onAnyPrinting,
  };

  return (
    <section
      className={cn(
        "flex flex-col gap-3",
        // **`h-full` is the table's, not the page's** — `SearchPage`'s branch, one tab over.
        // `VirtualTable` is `min-h-0 flex-1 overflow-auto`, so it has a height only while every
        // box above it has one, and this section pinned to `main`'s height is the top of that
        // chain: without it the table collapses to nothing.
        //
        // The wall wants the opposite. Under `WishlistGrid`'s `grow` it is as tall as its rows and
        // `main` is what scrolls them, and a section clamped to one screen would be a containing
        // block one screen tall — which is as far as the dock's `sticky top-0` could then travel,
        // so the search column would unstick and scroll away after the first viewport of wishes.
        view === "table" && "h-full",
      )}
    >
      {/* Not drawn: the ribbon's `h1` already names the view, and a second Cinzel "Wishlist"
          under it would be a subheading repeating its own heading. */}
      <h2 className="sr-only">Wishlist</h2>

      <FigureRow
        // The band's far end, where they used to sit beside the filter row — see `FigureRow`,
        // which is where the placement is argued, and `CollectionPage`, whose twin this is.
        //
        // **The price sweep rides here too**, because this band is where the controls that act on
        // *the whole list* live and that is exactly what it does — it is scoped by the same query
        // the figures beside it are counted from. It is not a filter and must not join the row
        // below: nothing about it narrows what is on screen, so it is one more thing Reset all
        // could not undo.
        actions={
          <div className="flex items-center gap-2">
            <button
              type="button"
              // **The write is reset on the way *in*, and that is not tidiness.** `Dialog` unmounts
              // its body on close, so the dialog's own state starts clean — but the mutation lives
              // out here and keeps its last answer, and the body draws the outcome *instead of*
              // the preview whenever there is one. Without this, a reader who optimised once and
              // pressed the button again would be shown the receipt from last time and no list at
              // all. On open rather than on close, because that is the moment a new question is
              // being asked; the sentence is meant to survive for as long as the dialog it
              // answered is up.
              onClick={() => {
                optimize.apply.reset();
                // The page's own list, whatever a home-page hand-off last asked about.
                setSweepOver("page");
                setOptimizing(true);
              }}
              aria-haspopup="dialog"
              // The visible word is shorter than the accessible name, `ImportExportPair`'s rule
              // and legally the same trade: `Optimise` is contained in the name beside it (WCAG
              // 2.5.3), and the name says *what* is being optimised — the dialog it opens carries
              // a control of its own, and two things called `Optimise` on one screen is a pair a
              // screen reader can only tell apart by position.
              aria-label="Optimise wishlist prices"
              // `ImportExportPair`'s button shape, spelled out rather than shared: that component
              // is a joined *pair* whose hairline is its second button's own border, and this is
              // one control standing beside it. What is shared is the geometry a reader
              // recognises — 36px tall, 12px type, dim until hovered.
              className={cn(
                "inline-flex h-9 shrink-0 items-center justify-center gap-1.5 whitespace-nowrap",
                "rounded-md border border-border bg-surface px-2.5 text-xs text-dim",
                "transition-colors duration-150 hover:text-text motion-reduce:transition-none",
                FOCUS,
              )}
            >
              {/* A falling price line. **Not `Sparkles`, `Gem` or anything tag-shaped** — the
                  first two are finishes in this app (`FinishMark`) and a *tag* is one of
                  Scryfall's two taxonomies, so any of the three would spend a word this app has
                  already given away. */}
              <TrendingDown className="size-4 shrink-0" aria-hidden="true" />
              Optimise
            </button>

            <ImportExportPair
              onImport={() => setImporting(true)}
              onExport={() => setExporting(true)}
              importLabel="Import wishes"
              exportLabel="Export wishlist"
            />
          </div>
        }
      >
        {/* **Both figures count the whole wall** (spec §3.6) — this level and every shelf below it,
            shut ones included — summed from the per-shelf counts, never from the rows loaded. */}
        <Figure label="Wishes" value={totals === null ? "—" : count(totals.wishes)} />
        {/* The one number this view exists for, in the currency the reader picked, with how old
            the prices are and whose. An unpriced wish is left out of the sum and counted in the
            note — never quoted at another marketplace's rate.

            **It read `Still to buy` until 2026-09-08 and was summed over the copies each wish was
            still short of.** Both went with the owned count: this list compares itself to the
            collection nowhere, so what it can honestly total is what it *asks for* rather than
            what is left to get.

            Etched printings have no EUR price in Scryfall's data at all — `eur_etched` is
            documented and absent — so on Cardmarket a wish for one is left out of this sum
            and counted in the note rather than quoted at the nonfoil rate. */}
        <Figure
          label={`Total cost (${currency.toUpperCase()})`}
          value={totals === null || totals.wishes === 0 ? "—" : formatPrice(totals.value, currency)}
          note={totals !== null && totals.unpriced > 0 ? `${totals.unpriced} unpriced` : undefined}
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
        // The chips are stated in the path row instead — see `StatedFiltersLine` there.
        statesFilters={false}
      />

      {/* **The row the sidebar made necessary.** This page was `flex-col` from its root down, so
          there was nothing to hang a column off — and the figures band and the page's own
          `FilterBar` deliberately stay full width *above* it: `FilterBar` lays itself out in four
          `@container/fb` bands at 640/900/1500, so taking width off it rearranges the bar rather
          than merely shortening it.

          `min-w-0` on the content side is not optional. A flex item cannot shrink below its own
          min-content, and an overhang inside `AppShell`'s `overflow-auto` `main` becomes a
          horizontal scrollbar across the whole page — the 1024px-floor failure `ManaValueChips`
          already shipped once. */}
      <div
        ref={deskRef}
        className={cn(
          "flex gap-4",
          // The section's `h-full` reasoning, one level in: `min-h-0 flex-1` is what hands the
          // table a definite height to scroll inside, and is exactly what a growing wall must not
          // be given — a flex item told to fill a bounded column cannot also be as tall as its own
          // content. Off it, this row is as tall as the wall, the page is as tall as the row, and
          // `AppShell`'s `main` is the one thing that scrolls.
          //
          // **The dock beside it needs nothing for either state**, which is what makes the branch
          // safe: `useDockHeight` measures the scrollport and subtracts however much of this row is
          // still below its top, clamped at zero — so a row that has scrolled past the top gives
          // the panel the full scrollport, and a row at rest gives it the scrollport under the
          // header. `sticky top-0` does the pinning in both.
          view === "table" && "min-h-0 flex-1",
        )}
      >
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          {/* **The path row** (spec §3.5): where the reader is standing on the left, and the three
              controls that act on the shelves below it on the right. **Drawn always** — Add folder
              is how a reader who has never filed anything makes their first folder, so a row gated
              on having folders would be the trap door the band's `New folder` tile once closed.
              The breadcrumb inside it is still drawn only where there is a cabinet to walk.

              **Not among the filters**, the fence this page has always kept: `resetAll` leaves
              `folderId` and every fold alone, so none of these could sit in the filter row without
              being the one control there Reset all cannot undo. */}
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            {hasFolders && (
              <div className="min-w-0">
                <WishlistBreadcrumb
                  // Root-most first and **without the root**, which the breadcrumb prepends itself:
                  // `null` is a destination rather than a folder, and only that component knows
                  // what it calls it.
                  trail={trail}
                  onOpen={openFolder}
                  canDrop={canFile}
                  onDropWish={fileWish}
                  canDropFolder={canMoveInto}
                  onDropFolder={moveInto}
                />
              </div>
            )}
            {/* **The page's one live region, and it lives in this row rather than on a line of its
                own under it** (2026-09-27, the header redesign; the collection's twin). A region
                that appears together with its text announces nothing, so it is mounted for the
                life of the view.

                It had a `min-h-4` line of its own until then, reserved whether or not it said
                anything, because a write's re-read put `Updating…` in it for 40–80 ms — which
                pushed the wall down 16px for exactly the frames the grid's reveal and the drop
                anchor measured it in, and then Chromium's scroll anchoring took the 16 back, so a
                revealed heading landed 16px short (the live re-check's new 2). That guarantee is
                kept and the 24px it cost are not: this row is the toolbar's height whatever the
                region says, `truncate` keeps a long sentence on its one line, and `flex-1` with a
                zero basis both pushes the toolbar to the right end and never asks the row to wrap.

                **The empty list's sentence is this same element**, never a second copy: it takes
                `order-last basis-full`, which wraps it onto a whole line of its own under the
                toolbar, and draws it large and centred where the wall would be. One element, so
                the region is never remounted with its text and the sentence is never in the page
                twice. */}
            {/* The filters that are on, as chips, on this row's empty left side rather than on a
                line of their own under the bar — so filtering costs the wall no height and the
                first filter no longer moves it (2026-09-27). `basis-0` so the line never makes
                the row wrap; it scrolls sideways instead. `grow-[3]` against the status line's 1,
                so the chips get most of the room and the status sits by the toolbar. */}
            <StatedFiltersLine search={wishlist} className="grow-[3] basis-0" />
            <p
              role="status"
              className={cn(
                empty && status
                  ? "order-last basis-full py-16 text-center text-sm"
                  : "min-w-0 flex-1 basis-0 truncate text-right text-xs",
                empty && failure ? "text-destructive" : "text-dim",
              )}
            >
              {status}
            </p>
            {/* The ref the caret's path-row answer searches (`pathRowAddFolder`) is the toolbar's
                alone — the collection's arrangement. Around the breadcrumb too, it found a trail
                segment first for a folder a reader had named "Add folder". `ml-auto`, so the
                toolbar holds the row's right end even on the empty list, where the status line
                beside it has wrapped onto a line of its own and no longer pushes it there. */}
            <div ref={pathRowRef} className="ml-auto">
              <ShelfToolbar
                // The `canMakeFolder` gate, unchanged (spec §3.8): nothing is made inside a deck's
                // managed folder, so the button is absent there rather than greyed.
                onAddFolder={
                  managedHere === null
                    ? () => startNewFolder(folderId, pressedElement())
                    : undefined
                }
                onExpandAll={expandAll}
                onCollapseAll={collapseAll}
                foldPaused={foldPaused}
              />
            </div>
          </div>

          {/* Standing inside a deck's managed folder: whose list this is and that it keeps
              itself — the sentence that makes the controls missing from every wish below read as
              a rule rather than as a broken wall. */}
          {managedHere !== null && managedHere.managedDeckId !== null && (
            <ManagedFolderNote
              deckName={managedDeckName ?? managedHere.name}
              onOpenDeck={() => openDeck(managedHere.managedDeckId!)}
            />
          )}

          {/* **One strip for the folder layers that are still layers, and it is not a placement
              decision so much as the only place there is.** Every other anchored layer in this app
              hangs off a `relative` wrapper around its own trigger; the trigger here is a heading's
              `⋯`, and a heading has nowhere to hang a panel — one that hosted one would also clip it
              against the scroller below. So the strip sits directly beneath the path row (spec
              §3.5).

              **Naming a folder and renaming one are drawn *in the wall*** — on the new folder's own
              heading, or on the heading being renamed — because in both cases the thing being named
              has a heading of its own on screen, and a second bordered box above the wall could only
              repeat what that heading already says. Moving and deleting have no such place: the
              answer to "into which folder" is a list of the *other* folders, and the answer to
              "delete this?" is a sentence about what happens to the wishes inside. Neither fits on a
              40px heading, and neither is a name typed on a line. Clearing joined them on the second
              argument: "clear this?" is a sentence about which wishes go. */}
          {(openPanel?.kind === "moveFolder" ||
            openPanel?.kind === "deleteFolder" ||
            openPanel?.kind === "clearFolder") && (
            <div className="w-full max-w-sm shrink-0 rounded-lg border border-border bg-surface p-2 text-xs">
              {openPanel.kind === "moveFolder" && (
                <MoveToFolder
                  label={`Move ${folderNameOf(openPanel.folderId) ?? "folder"} into a folder`}
                  // The reader's drawers only: a deck's managed folder takes no sub-folder.
                  nodes={userNodes}
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
                    leaveHeading(
                      openPanel.folderId,
                      (done) => folders.move.mutate({ id: openPanel.folderId, parentId }, done),
                      parentId,
                    )
                  }
                  onClose={close}
                />
              )}

              {openPanel.kind === "deleteFolder" && (
                <DeleteFolderConfirm
                  name={folderNameOf(openPanel.folderId) ?? "this folder"}
                  // Either answer in flight holds both buttons: a second press while the first is
                  // on its way would be a different write racing it to the same folder.
                  pending={folders.remove.isPending || folders.removeWithWishes.isPending}
                  onConfirm={() =>
                    leaveHeading(openPanel.folderId, (done) =>
                      folders.remove.mutate(openPanel.folderId, done),
                    )
                  }
                  onConfirmWithWishes={() =>
                    leaveHeading(openPanel.folderId, (done) =>
                      folders.removeWithWishes.mutate(openPanel.folderId, done),
                    )
                  }
                  onCancel={dismiss}
                  onClose={close}
                />
              )}

              {openPanel.kind === "clearFolder" && (
                <ClearFolderConfirm
                  name={folderNameOf(openPanel.folderId) ?? "this folder"}
                  // Direct, the summary's own grain and exactly what a clear takes — and `null`
                  // until the summary has answered, rather than a `0` it has not said.
                  wishes={
                    folders.summaryQuery.data === undefined
                      ? null
                      : (folders.summary.get(openPanel.folderId)?.wishes ?? 0)
                  }
                  hasChildren={folders.folders.some((f) => f.parentId === openPanel.folderId)}
                  pending={folders.clear.isPending}
                  onConfirm={() => folders.clear.mutate(openPanel.folderId, { onSuccess: dismiss })}
                  onCancel={dismiss}
                  onClose={close}
                />
              )}
            </div>
          )}

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

          {/* **The shelves** — drawn whenever there is a shelf to draw, which on a filed wishlist
              holding no wishes is still a wall of headings: they are the content. */}
          {sections.length > 0 &&
            (view === "grid" ? (
              <WishlistGrid
                rows={rows}
                shelves={gridShelves}
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
                rows={table.rows}
                total={table.total}
                bands={tableBands}
                revealIndex={tableRevealIndex}
                keepRow={keepRow}
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
              attached to what the whole wish costs — `unit × copies wanted` — where the chin's figure
              is what *one* copy costs.

              **Said once, under the wall, rather than on every tile** — the argument the search
              page, the Tags page, the printings modal and the deck's docked panel all make, and the
              reason the chin's money slot is a plain string rather than a tooltip binding.

              **Grid only.** The table states it in the Cost column's own header (`WishlistTable`'s
              `columnsFor`), so drawing it here as well would say it twice in one view. */}
          {!empty && view === "grid" && (
            <p className="shrink-0 text-[0.7rem] text-dim">{pricesAsOf(marketplace)}</p>
          )}
        </div>

        {/* The dock: a 36px column of the row whatever the panel is doing inside it, so nothing
            reflows on a collapse. `sticky top-0` pins it to the top of `AppShell`'s scroller and
            {@link useDockHeight} gives it the height, because CSS cannot say "the scroller's
            visible height, less however much of the page sits above this row".

            **`LAYER.popup` only while the panel is drawn over the list, and it has to be _here_.**
            `position: sticky` always creates a stacking context, so a z-index asked for inside
            this box competes only with its own siblings — which is why the overlay itself carries
            no number. What it is covering is the shelves' wall, which draws raised rungs of its
            own; this is the one element that can out-rank them. It is not
            applied at every width, because a rung nothing overlaps is a claim about an overlap
            that does not occur. */}
        <div
          ref={dockRef}
          className={cn(
            "sticky top-0 flex shrink-0 self-start",
            overWidth !== undefined && LAYER.popup,
          )}
        >
          <WishlistSearchPanel
            // **The root inside a deck's managed folder**, which refuses an add by hand: the
            // column's `+` still files somewhere the reader can see, rather than being a press
            // that can only end in a refusal. Its override picker offers the reader's drawers
            // alone.
            folderId={managedHere !== null ? null : folderId}
            folderNodes={userNodes}
            folderName={folderNameOf}
            roomy={roomy}
            overWidth={overWidth}
            maxWidth={maxPanelWidth}
          />
        </div>
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

      {/* Mounted unconditionally for the two dialogs above's reason, and at the section's own top
          level for a third: `@container` makes a box the containing block for every `fixed`
          descendant under it, so a modal mounted inside `FilterBar`'s container box would have a
          scrim stretched to the filter row rather than to the window — and jsdom applies no
          container query, so nothing in the suite can see it (`src/CLAUDE.md`).

          Everything about the sweep arrives as a prop: the dialog holds no query and no mutation,
          so it renders in a test with no query client. */}
      <OptimizeWishlistDialog
        open={optimizing}
        // The scope the plan was taken over, in three facts. At the root the sweep is every shelf,
        // so the subtitle names every folder rather than the root's word; inside a folder it names
        // the folder, whose sweep takes its sub-folders with it. A folder id this page cannot name
        // resolves to the root's word, the same "resolve towards the root" rule `trailOf` applies
        // to a broken trail.
        scope={
          // The hand-off's override says what it planned — every folder, nothing filtered — rather
          // than naming the drawer and the filters the page happens to be standing in.
          sweepOver === "whole"
            ? { folder: ROOT_LABEL, everyFolder: true, filtered: false }
            : {
                folder: folderNameOf(folderId) ?? ROOT_LABEL,
                everyFolder: folderId === null,
                filtered: wishlist.activeCount > 0,
              }
        }
        plan={optimize.plan.data ?? null}
        loading={optimize.plan.isLoading}
        readError={optimize.plan.isError ? ipcError(optimize.plan.error) : null}
        marketplace={marketplace}
        apply={optimize.apply}
        // Only read while the sweep covers every folder, where a row can have come from any of them.
        folderNameOf={folderNameOf}
        // One callback for both rungs, `ExportDialog`'s and `ImportDialog`'s arrangement above:
        // every way out of this one is the reader saying "put me back", and the caret's
        // destination is the button in the figures band they pressed to open it.
        onClose={() => setOptimizing(false)}
      />
    </section>
  );
}

/** A destructive answer in a folder question — outlined in the destructive colour, filled on
 *  hover, and dimmed while a write is in flight. */
const DESTRUCTIVE_ANSWER = cn(
  "rounded-md border border-destructive px-2 py-1 text-destructive",
  "transition-colors duration-150 hover:bg-destructive hover:text-bg",
  "disabled:opacity-50 motion-reduce:transition-none",
  FOCUS,
);

/** The way out of a folder question, which is never disabled — backing out is always possible. */
const CANCEL_ANSWER = cn(
  "rounded-md border border-border px-2 py-1 text-dim",
  "transition-colors duration-150 hover:text-text motion-reduce:transition-none",
  FOCUS,
);

/**
 * What every destructive question about a folder shares: the layer, the question, the
 * sentence under it, and `Cancel` after whatever answers the caller draws.
 *
 * **One shell because the two questions are one layer**, and a focus or blur rule that reached one
 * of them and not the other would be the strip behaving two ways for one reason no reader could
 * name. The caret moves into the layer as it does for every other one in the app, so Escape has
 * something to hand back and Tab reaches the answers next; a click away closes it without taking
 * the caret back (`close`, not `dismiss` — the reader is already somewhere else), **except while
 * a write is in flight**, so the press that is on its way is not stranded with nothing on screen
 * saying so.
 *
 * The answer row wraps: the strip is `max-w-sm` and never wider, and three buttons are a row of
 * fixed-width controls that has to survive the narrowest box it is drawn in.
 */
function FolderQuestion({
  label,
  question,
  explanation,
  pending,
  onCancel,
  onClose,
  children,
}: {
  label: string;
  question: string;
  explanation: string;
  pending: boolean;
  onCancel: () => void;
  onClose: () => void;
  /** The destructive answers, in the order they are offered. */
  children: ReactNode;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    panelRef.current?.focus();
  }, []);

  return (
    <div
      ref={panelRef}
      tabIndex={-1}
      role="group"
      aria-label={label}
      className={cn("rounded-md", FOCUS)}
      onBlur={(e) => {
        if (pending) return;
        if (!panelRef.current?.contains(e.relatedTarget)) onClose();
      }}
    >
      <p>{question}</p>
      <p className="mt-1 leading-relaxed text-dim">{explanation}</p>
      <div className="mt-2 flex flex-wrap gap-2">
        {children}
        <button type="button" onClick={onCancel} className={CANCEL_ANSWER}>
          Cancel
        </button>
      </div>
    </div>
  );
}

/**
 * The question a reader will guess wrong, and the sentence that answers it — which now has two
 * answers.
 *
 * **Deleting a folder does not have to delete the wishes in it.** `Delete folder` sets
 * `wishlist_entries.folder_id` to `NULL`, so they surface at the root — filed nowhere and otherwise
 * exactly as they were, still on the shopping list, still counted. `Delete folder and wishes`
 * takes them too, every wish anywhere in the sub-tree (issue #471). `wishlist_folders.parent_id`
 * is `ON DELETE CASCADE` **on itself**, so the folders inside go on either press. The sentence
 * says all of it in one breath, the reassuring half first, because the fear is what stops the
 * press — and the second button sits *after* the first so the answer that loses nothing is still
 * the one a reader meets first.
 *
 * One sentence rather than the deck gallery's counted pair, because the two lists are counted
 * differently: a folder's own heading already says how many wishes are in the drawer, in the
 * recursive number this page summed for it, so a confirmation repeating it would be the same
 * figure twice with two chances to disagree. That recursive number is also exactly what the
 * second button takes, so it needs no restating either.
 */
function DeleteFolderConfirm({
  name,
  pending,
  onConfirm,
  onConfirmWithWishes,
  onCancel,
  onClose,
}: {
  name: string;
  /** Either delete in flight — both buttons are held while one is on its way. */
  pending: boolean;
  onConfirm: () => void;
  onConfirmWithWishes: () => void;
  onCancel: () => void;
  onClose: () => void;
}) {
  return (
    <FolderQuestion
      label={`Delete ${name}`}
      question={`Delete “${name}”?`}
      explanation={
        "Its wishes can move back to your wishlist or be deleted with it; " +
        "folders inside it are deleted either way."
      }
      pending={pending}
      onCancel={onCancel}
      onClose={onClose}
    >
      <button type="button" onClick={onConfirm} disabled={pending} className={DESTRUCTIVE_ANSWER}>
        Delete folder
      </button>
      <button
        type="button"
        onClick={onConfirmWithWishes}
        disabled={pending}
        className={DESTRUCTIVE_ANSWER}
      >
        Delete folder and wishes
      </button>
    </FolderQuestion>
  );
}

/**
 * Emptying a folder, and keeping it — the wishes filed **directly** in it go, and nothing else.
 *
 * **Unlike {@link DeleteFolderConfirm}, this one states its number**, and the argument there is
 * the reason here, read the other way. The heading carries the *recursive* total, and this
 * press takes only the direct wishes — so on a drawer with sub-folders the two numbers differ,
 * and the number this press will actually take is new information a reader cannot get from the
 * heading. `wishes` is `null` while the summary has not answered, and the sentence then says which
 * wishes without guessing how many.
 *
 * **The sub-folders are named only where there are some.** They keep their wishes — a clear is
 * the level on screen, not the tree under it — and saying so over a drawer that holds no drawers
 * would be answering a question nobody could have asked.
 */
function ClearFolderConfirm({
  name,
  wishes,
  hasChildren,
  pending,
  onConfirm,
  onCancel,
  onClose,
}: {
  name: string;
  /** The wishes filed directly in the folder, or `null` before the summary has answered. */
  wishes: number | null;
  hasChildren: boolean;
  pending: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  onClose: () => void;
}) {
  const direct =
    wishes === null
      ? "The wishes filed directly in it are removed from your wishlist."
      : wishes === 0
        ? // Reachable only when the summary answered after the question opened, since the menu
          // row greys at zero — but an honest sentence costs one line and "Its 0 wishes … are
          // removed" is not one.
          "Nothing is filed directly in it."
        : `Its ${plural(wishes, "wish", "wishes")} filed directly in it ` +
          `${verb(wishes, "is", "are")} removed from your wishlist.`;

  return (
    <FolderQuestion
      label={`Clear ${name}`}
      question={`Clear “${name}”?`}
      explanation={hasChildren ? `${direct} Folders inside it keep theirs.` : direct}
      pending={pending}
      onCancel={onCancel}
      onClose={onClose}
    >
      <button type="button" onClick={onConfirm} disabled={pending} className={DESTRUCTIVE_ANSWER}>
        Clear folder
      </button>
    </FolderQuestion>
  );
}

/**
 * The one line that says what the list area is currently showing, or nothing at all.
 *
 * **"Empty" is the counts' answer, not the loaded rows'** — nothing at and below the level — and
 * `pending` is the counts or the list not having answered, which says it is reading rather than
 * that nothing is there. **Where the reader is standing changes what an empty wall means**: an
 * empty root is a wishlist nobody has written on, an empty folder is a drawer they made, and a wall
 * of headings is not empty at all — the headings are the content.
 */
function statusOf(
  wishlist: Wishlist,
  failure: string | null,
  {
    empty,
    pending,
    drawn,
    inFolder,
  }: {
    empty: boolean;
    pending: boolean;
    drawn: boolean;
    inFolder: boolean;
  },
): string {
  const { query, activeCount } = wishlist;

  if (empty) {
    if (failure) return failure;
    if (pending) return "Reading your wishlist…";
    // A wall with anything on it — headings, or the empty folder's own box — is the answer to
    // "what is here", and the box already says the folder is empty. `CollectionPage`'s order. That
    // includes a deck's managed folder: `layoutShelves` draws its box too, holding the sentence for
    // the view the deck follows, so the status line never has to say it.
    if (drawn) return "";
    // Something was filtered out rather than never there: a statement about the filters.
    if (activeCount > 0) return "No wishes match these filters.";
    // Nothing filtered and nothing there. Two statements, and which one is honest depends on
    // where the reader is: "No wishes match" would blame the reader for a list nobody has put
    // anything on yet, and the root's instruction would answer the wrong question inside a
    // folder they have just made.
    return inFolder
      ? "Nothing filed here yet."
      : "Nothing on your wishlist yet. Add cards from search with the + on any row or tile.";
  }

  // With wishes on the wall the shelves caption themselves and the header counts them, so the
  // only thing left to say is that something is still on its way.
  if (query.isFetchingNextPage) return "Loading more…";
  if (query.isFetching) return "Updating…";
  return failure ?? "";
}
